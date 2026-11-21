import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionLog, sessionLogName } from "./log-archive.ts";
import { detachTerminalReader, discardLiveTerminal, freezeTerminal, readTerminal, registerTerminal } from "./terminal-resource.ts";
import { detectInputPrompt, inputWaitNotice, type InputWaitAlert } from "./input-wait.ts";
import type { MonitorListener, MonitorSourceHandle, MonitorStart } from "./monitor-subscription.ts";
import { type CollectResult, type FinalScreenOutput, NO_OUTPUT, type NoOutput } from "./collect.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { Gate, Notify } from "./notify.ts";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, type ProcessExit, type SpawnedChild, spawnChild } from "./pty.ts";
import { type StyledScreen, type TerminalAppearance, TerminalScreen, type TerminalSnapshot } from "./terminal-screen.ts";

export interface SessionSpawnOptions {
	command: readonly string[];
	/** The shell the terminal runs, as results name it. */
	shell: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
	displayCommand?: string; // human-readable command for list_sessions/UI
	title: string;
	appearance?: () => TerminalAppearance;
	inputWait?: InputWaitOptions;
}

export interface InputWaitOptions {
	readonly quietMs: number;
	readonly onAlert: (alert: InputWaitAlert) => void;
}

export interface SessionState {
	hasExited: boolean;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failureMessage: string | null;
	exitedAt: number | null;
}

export class ExecSession {
	readonly id: number;
	readonly command: readonly string[];
	readonly shell: string;
	readonly displayCommand: string;
	readonly title: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly pid: number | undefined;
	readonly logPath: string;
	private log: SessionLog | undefined;

	private screen: TerminalScreen | undefined;
	private terminalKey: string | undefined;
	private terminalFinalized: Promise<void> | undefined;
	readonly outputNotify = new Notify();
	readonly outputClosed = new Gate();
	private readonly exitedAc = new AbortController();
	get exited(): AbortSignal {
		return this.exitedAc.signal;
	}

	private totalOutputBytes = 0;
	private lastOutputAtMs: number;
	private attachments = 0;

	private state: SessionState = {
		hasExited: false,
		exitCode: null,
		signal: null,
		failureMessage: null,
		exitedAt: null,
	};
	private readonly exitListeners = new Set<(session: ExecSession) => void>();
	private readonly readListeners = new Set<() => void>();
	private lastUsedAt: number;
	private child!: SpawnedChild;

	private constructor(id: number, opts: SessionSpawnOptions) {
		this.id = id;
		this.command = opts.command;
		this.shell = opts.shell;
		this.displayCommand = opts.displayCommand ?? opts.command.join(" ");
		this.title = opts.title;
		this.cwd = opts.cwd;
		this.startedAt = Date.now();
		this.lastUsedAt = this.startedAt;
		this.lastOutputAtMs = this.startedAt;
		this.pid = undefined; // set in `start`
		this.logPath = join(tmpdir(), sessionLogName(id));
	}

	static spawn(id: number, opts: SessionSpawnOptions): ExecSession {
		const self = new ExecSession(id, opts);

		try {
			self.log = SessionLog.open(self.logPath, (err) => {
				// The child is
				// still running: record the failure and stop mirroring writes, but
				// do NOT mark the session exited — that would make it unkillable
				// (kill() no-ops once hasExited) and orphan the process.
				self.recordFailure(`log stream error: ${err?.message ?? err}`);
				self.log = undefined;
			});
		} catch (err: any) {
			self.markFailure(`failed to open log file ${self.logPath}: ${err?.message ?? err}`);
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}

		const cols = opts.cols ?? DEFAULT_PTY_COLS;
		const rows = opts.rows ?? DEFAULT_PTY_ROWS;
		try {
			self.child = spawnChild({
				command: opts.command,
				cwd: opts.cwd,
				env: opts.env,
				cols,
				rows,
			});
		} catch (err: any) {
			self.markFailure(err?.message ?? String(err));
			void self.log?.end();
			self.log = undefined;
			self.exitedAc.abort();
			self.outputClosed.close();
			return self;
		}

		Object.defineProperty(self, "pid", { value: self.child.pid, enumerable: true });

		// A real terminal answers queries (cursor position, device attributes);
		// a child that waits for the answer would otherwise stall.
		const screen = new TerminalScreen(cols, rows, (reply) => void self.write(reply), opts.appearance);
		self.screen = screen;
		const key = registerTerminal(id, screen, () => {
			for (const listener of self.readListeners) listener();
		});
		self.terminalKey = key;
		self.terminalFinalized = self.outputClosed.closed().then(() => freezeTerminal(key));
		if (opts.inputWait) self.watchInputWait(screen, opts.inputWait);

		self.child.onData((chunk) => {
			self.totalOutputBytes += chunk.length;
			self.lastOutputAtMs = Date.now();
			self.log?.write(chunk);
			screen.write(chunk);
			self.outputNotify.notifyAll();
		});

		self.child.onExit((exitCode, signal, failureMessage) => {
			self.state = {
				hasExited: true,
				exitCode,
				signal,
				failureMessage: self.state.failureMessage ?? failureMessage ?? null,
				exitedAt: Date.now(),
			};
			self.exitedAc.abort();
			self.notifyExitListeners();
			self.outputNotify.notifyAll();
			setImmediate(() => {
				self.outputNotify.notifyAll();
				const log = self.log;
				self.log = undefined;
				const finalize = () => {
					self.outputClosed.close();
					self.outputNotify.notifyAll();
				};
				if (log) void log.end().then(finalize);
				else finalize();
			});
		});

		return self;
	}

	private watchInputWait(screen: TerminalScreen, { quietMs, onAlert }: InputWaitOptions): void {
		let quiet: NodeJS.Timeout | undefined;
		let alerted: string | undefined;
		const evaluate = () => {
			quiet = undefined;
			if (this.hasExited || this.screen !== screen || this.attachments > 0) return;
			const probe = screen.inputProbe();
			if (!probe || probe.presented) return;
			const prompt = detectInputPrompt(probe);
			if (!prompt) return;
			const fingerprint = JSON.stringify([probe.kind, probe.cursorRow, probe.cursorCol, probe.rows]);
			if (fingerprint === alerted) return;
			alerted = fingerprint;
			onAlert({
				notice: inputWaitNotice({
					sessionId: this.id, title: this.title, command: this.displayCommand, prompt, screen: probe.kind, quietMs,
					terminalUrl: this.terminalUrl, logPath: this.logPath,
				}),
				current: () => !this.hasExited && this.screen === screen && screen.unseen(probe.revision),
			});
		};
		let changedAt = 0;
		const settle = () => {
			const silent = performance.now() - changedAt;
			if (silent < quietMs) quiet = setTimeout(settle, quietMs - silent);
			else evaluate();
		};
		const unsubscribe = screen.onChange(() => {
			changedAt = performance.now();
			quiet ??= setTimeout(settle, quietMs);
		});
		this.onExit(() => {
			clearTimeout(quiet);
			unsubscribe();
		});
	}

	/** The call's `timeout` ran out; the caller ends the process. */
	recordDeadline(seconds: number): void {
		this.recordFailure(`timeout: ended after ${seconds}s`);
	}

	private recordFailure(message: string): void {
		this.state = {
			...this.state,
			failureMessage: this.state.failureMessage ?? message,
		};
	}

	private markFailure(message: string): void {
		this.state = {
			hasExited: true,
			exitCode: this.state.exitCode,
			signal: this.state.signal,
			failureMessage: message,
			exitedAt: Date.now(),
		};
		this.notifyExitListeners();
	}

	private notifyExitListeners(): void {
		for (const listener of this.exitListeners) {
			try {
				listener(this);
			} catch {
			}
		}
	}

	onExit(listener: (session: ExecSession) => void): () => void {
		this.exitListeners.add(listener);
		if (this.hasExited) {
			queueMicrotask(() => {
				if (this.exitListeners.has(listener)) listener(this);
			});
		}
		return () => this.exitListeners.delete(listener);
	}

	onTerminalRead(listener: () => void): () => void {
		this.readListeners.add(listener);
		return () => this.readListeners.delete(listener);
	}

	onShellExit(listener: (exit: ProcessExit) => void): () => void {
		return this.child?.onProcessExit(listener) ?? (() => {});
	}

	liveSnapshot(): TerminalSnapshot | undefined {
		return this.screen?.snapshot();
	}

	styledScreen(): StyledScreen | undefined {
		return this.screen?.styledScreen();
	}

	screenRevision(): number | undefined {
		return this.screen?.parsedRevision();
	}

	onScreenChange(listener: () => void): () => void {
		return this.screen?.onChange(listener) ?? (() => {});
	}

	async subscribeMonitor(
		listener: MonitorListener,
		accept: (handle: MonitorSourceHandle) => boolean,
		signal?: AbortSignal,
	): Promise<MonitorStart> {
		if (signal?.aborted) return "cancelled";
		const screen = this.screen;
		if (this.hasExited || !screen) return "not_running";
		if (listener.watchesLines) {
			return screen.subscribeLines(() => !this.hasExited, (lines) => listener.lines(lines), (handle) => {
				const unsubscribeClose = this.outputClosed.subscribe(async () => {
					if (await handle.finish()) listener.end();
				});
				const source: MonitorSourceHandle = {
					cancel: () => { unsubscribeClose(); handle.cancel(); },
				};
				try {
					if (!accept(source)) { source.cancel(); return false; }
					return true;
				} catch (error) {
					source.cancel();
					throw error;
				}
			}, signal);
		}
		let active = true;
		const handle: MonitorSourceHandle = {
			cancel: () => {
				active = false;
				unsubscribeClose();
			},
		};
		const unsubscribeClose = this.outputClosed.subscribe(async () => {
			await this.terminalFinalized;
			if (!active) return;
			handle.cancel();
			listener.end();
		});
		try {
			if (!accept(handle)) { handle.cancel(); return "cancelled"; }
		} catch (error) {
			handle.cancel();
			throw error;
		}
		return "accepted";
	}

	async collect(opts: { deadlineMs: number; externalAbort?: AbortSignal }): Promise<CollectResult> {
		this.attachments++;
		try {
			await waitForExitOrDeadline({
				exited: this.exited,
				externalAbort: opts.externalAbort,
				durationMs: opts.deadlineMs - Date.now(),
			});
			if (this.hasExited) return this.finalScreenOutput();
			const screen = this.screen;
			if (!screen) return NO_OUTPUT;
			const observation = await screen.observe();
			// Exit may land while the observation's parser barrier is pending.
			if (this.hasExited) return this.finalScreenOutput();
			return { kind: "screen", observation, terminalUrl: this.terminalUrl };
		} finally {
			this.attachments--;
		}
	}

	private async finalScreenOutput(): Promise<FinalScreenOutput | NoOutput> {
		await this.terminalFinalized;
		const key = this.terminalKey;
		if (key === undefined) return NO_OUTPUT;
		return { kind: "final-screen", projection: await readTerminal(key), terminalUrl: `term://${key}` };
	}

	get terminalUrl(): string | undefined {
		return this.terminalKey === undefined ? undefined : `term://${this.terminalKey}`;
	}

	async release(): Promise<void> {
		this.detachReader();
		await this.terminalFinalized;
		await this.detachScreen()?.release();
	}

	async releaseForShutdown(): Promise<void> {
		this.detachReader();
		if (this.terminalKey !== undefined && discardLiveTerminal(this.terminalKey)) this.terminalKey = undefined;
		await this.detachScreen()?.release();
	}

	/** The retained terminal outlives the session; it must not keep reporting reads to it (or keep it reachable). */
	private detachReader(): void {
		this.readListeners.clear();
		if (this.terminalKey !== undefined) detachTerminalReader(this.terminalKey);
	}

	private detachScreen(): TerminalScreen | undefined {
		const screen = this.screen;
		this.screen = undefined;
		return screen;
	}

	write(data: Uint8Array): boolean {
		if (this.state.hasExited) return false;
		return this.child.write(data);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.state.hasExited) return;
		this.child.kill(signal);
	}

	get hasExited(): boolean {
		return this.state.hasExited;
	}

	get shellExited(): boolean {
		return this.child.processExited;
	}

	signalProcessGroup(signal: NodeJS.Signals | 0): boolean {
		return this.child?.signalGroup(signal) ?? false;
	}

	processesRemain(): boolean {
		return !this.hasExited || this.signalProcessGroup(0);
	}

	get shellExit(): ProcessExit | undefined {
		return this.child?.processExit;
	}

	get exitCode(): number | null {
		return this.state.exitCode;
	}

	get signal(): NodeJS.Signals | null {
		return this.state.signal;
	}

	get failureMessage(): string | null {
		return this.state.failureMessage;
	}

	get exitedAt(): number | null {
		return this.state.exitedAt;
	}

	get totalBytesSeen(): number {
		return this.totalOutputBytes;
	}

	get lastOutputAt(): number {
		return this.lastOutputAtMs;
	}

	get lastUsed(): number {
		return this.lastUsedAt;
	}

	touch(): void {
		this.lastUsedAt = Date.now();
	}

	terminate(signal: NodeJS.Signals = "SIGTERM"): void {
		this.kill(signal);
	}
}
