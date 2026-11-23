import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type SessionStopEvent, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Box, Text } from "@oh-my-pi/pi-tui";
import { Type, type TUnsafe } from "@oh-my-pi/omptype/typebox";

import { type AgentHost, type AgentIdentity, type ParkedRuntime, parkedRuntimes } from "../fork-features/agent-park.ts";
import { type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { approvalCommand, approveBoundCommand, type CommandApprovalHost } from "../fork-features/command-approval.ts";
import {
	execCommandTopicPointers,
	monitorTopicPointers,
	registerExecCommandTopics,
	writeStdinTopicPointers,
} from "../fork-features/exec-command-docs.ts";
import { createCompactNoticeSender, registerActualTerminalCompactHandoff } from "../fork-features/compact-handoff-wiring.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "../fork-features/session-binding.ts";
import { MonitorError, type MonitorWatchStatus } from "../fork-features/monitor-subscription.ts";
import { loadInitFile, shellScript } from "../fork-features/exec-init.ts";
import { noShellHost, type ShellHost } from "../fork-features/shell-host.ts";
import { parseGraceReclaim, type PluginSettingsReader } from "../fork-features/plugin-settings.ts";
import { DEFAULT_STOP_CONFIG, loadStopConfig, type StopConfig } from "../fork-features/stop-config.ts";
import { detectStop, type StopHost } from "../fork-features/stop-gate.ts";
import { screenJudge, type ScreenJudge } from "../fork-features/screen-judge.ts";
import { renderStopConfigReason, renderStopReason } from "../fork-features/stop-reasons.ts";
import { type LifecycleClock, type ReclaimResult, TerminalLifecycle } from "../fork-features/terminal-lifecycle.ts";
import { buildNoticeDisplayMessage, MAX_TITLE_CHARS, NoticeDispatcher, type NoticeGate, type NoticeMessage, outcomeText, parseTerminalTitle } from "../fork-features/terminal-notice.ts";
import { getTerminalUrlRuntime, initializeTerminalUrls, setTerminalUrlRuntime, type TerminalUrlRuntime } from "../fork-features/terminal-url.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed, formatElapsedUi, nowUtcIso } from "./format-time.ts";
import { language, tr } from "../fork-features/omomp-shared/i18n.ts";
import { readTodos } from "../fork-features/omomp-shared/todo-read.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { DEFAULT_PTY_ROWS } from "./pty.ts";
import type { MonitorScriptResult } from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { IS_WINDOWS, resolveBinary, resolveDefaultShell, resolveWindowsShell, shellArgv, type LaunchShell, type ShellSource } from "./shell.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	terminalViewDetails,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "./tool-result.ts";


const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const SHUTDOWN_TERM_GRACE_MS = 1000;
const SHUTDOWN_KILL_GRACE_MS = 500;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input streaming updates
const INPUT_WAIT_QUIET_MS = 5_000;
const GROUP_PROBE_MS = 50;
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;
const SESSION_UI_KEY = "unified-exec.sessions";

/** A TypeBox literal union (anyOf/const) breaks Google models. */
function StringEnum<T extends readonly string[]>(values: T, description: string): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ type: "string", enum: values as unknown as string[], description });
}


function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && ms > 0 ? ms : defaultMs;
	return clamp(Math.floor(v), MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS);
}

function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

const textEncoder = new TextEncoder();

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type FinalizeInput = Omit<FinalizeProcessInput, "operation">;

function encode(str: string): Uint8Array {
	return textEncoder.encode(str);
}


type RuntimeHost =
	| {
		readonly kind: "attached";
		readonly send: (message: NoticeMessage) => void;
		readonly gate: NoticeGate | undefined;
		readonly judge: ScreenJudge | undefined;
		readonly graceReclaimNotice: () => Promise<boolean>;
	}
	| { readonly kind: "parked" }
	| { readonly kind: "ended" };

interface ExtensionCtx extends ParkedRuntime {
	store: SessionStore;
	coordinator: CompletionCoordinator;
	notices: NoticeDispatcher;
	lifecycle: TerminalLifecycle;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	/**
	 * Membership is ownership: session_shutdown
	 * terminates these and removes them, so an exec_command whose session is
	 * no longer here after the grace must not insert it into the store.
	 */
	pendingSessions: Set<ExecSession>;
	shuttingDown: boolean;
	appearance: () => TerminalAppearance;
	shellPath?: () => string | undefined;
	shellHost: ShellHost;
	invalidateGithubCache?: (command: string) => void;
	pluginSettings: PluginSettingsReader | undefined;
	host: RuntimeHost;
	agent: AgentIdentity | undefined;
}

type ExecCommandArgs = {
	cmd: string;
	title: string;
	workdir?: string;
	shell?: string;
	cols?: number;
	rows?: number;
	yield_time_ms?: number;
	on_exit?: OnExitPolicy;
};

const SPECIAL_KEYS = [
	"ctrl-c",
	"ctrl-d",
	"ctrl-z",
	"esc",
	"tab",
	"up",
	"down",
	"left",
	"right",
	"backspace",
	"delete",
] as const;

type SpecialKey = (typeof SPECIAL_KEYS)[number];

const SPECIAL_KEY_BYTES: Readonly<Record<SpecialKey, string>> = {
	"ctrl-c": "\x03",
	"ctrl-d": "\x04",
	"ctrl-z": "\x1a",
	esc: "\x1b",
	tab: "\t",
	up: "\x1b[A",
	down: "\x1b[B",
	left: "\x1b[D",
	right: "\x1b[C",
	backspace: "\x7f",
	delete: "\x1b[3~",
};

type WriteStdinArgs = {
	session_id: number;
	text?: string;
	enter?: boolean;
	special_key?: SpecialKey;
	raw_base64?: string;
	yield_time_ms?: number;
};

function watchLabel(watch: MonitorWatchStatus): string {
	switch (watch.kind) {
		case "end": return "completion";
		case "regex": return `condition=${JSON.stringify(watch.condition)}`;
		case "judge": return `judge=${JSON.stringify(watch.intent)} every=${formatElapsed(watch.interval_ms)}`;
	}
}

export class EmptyPollRemovedError extends Error {
	readonly code = "empty_poll_removed";

	constructor(terminalUrl: string | undefined) {
		super(`empty_poll_removed: write_stdin requires input bytes. Read state and content with read ${terminalUrl ?? "term://<key>"}; wait for output events or completion with monitor.`);
		this.name = "EmptyPollRemovedError";
	}
}

function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasText = typeof args.text === "string" && args.text.length > 0;
	const hasEnter = args.enter === true;
	const hasSpecialKey = args.special_key !== undefined;
	const hasB64 = typeof args.raw_base64 === "string" && args.raw_base64.length > 0;
	if (hasB64 && (hasText || hasEnter || hasSpecialKey)) {
		throw new Error("write_stdin: `raw_base64` cannot be combined with `text`, `enter`, or `special_key`.");
	}
	if (hasB64) {
		const b64 = args.raw_base64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `raw_base64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	const combined =
		(args.text ?? "") +
		(args.special_key !== undefined ? SPECIAL_KEY_BYTES[args.special_key] : "") +
		(hasEnter ? "\r" : "");
	return combined.length > 0 ? encode(combined) : undefined;
}

const HELD_OPEN_NOTE = IS_WINDOWS
	? "shell has exited, but background process(es) still hold the terminal " +
		"(a job started from this shell that kept its console as stdin/stdout/stderr), " +
		"so this session stays open until they exit, or end the session with write term://<id>/kill."
	: "shell has exited, but background process(es) still hold the terminal " +
		"(e.g. a nohup'd or SIGHUP-ignoring job that kept the PTY as stdin/stdout/stderr), " +
		"so this session stays open until they exit. To detach: redirect inside the job — " +
		"`setsid cmd >log 2>&1 </dev/null &` — or end the session with write term://<id>/kill.";

function heldOpenNote(session: ExecSession): string | undefined {
	return session.shellExited && !session.hasExited ? HELD_OPEN_NOTE : undefined;
}

function workdirProblem(dir: string): string | undefined {
	try {
		return statSync(dir).isDirectory() ? undefined : `Working directory is not a directory: ${dir}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return `Working directory does not exist: ${dir}`;
		throw error;
	}
}

function refuseOrigin(source: ShellSource): { readonly en: string; readonly zh: string } {
	switch (source) {
		case "call":
			return { en: "the shell argument", zh: "shell 参数" };
		case "shellPath":
			return { en: "shellPath", zh: "shellPath" };
		case "SHELL":
			return { en: "SHELL", zh: "SHELL" };
	}
}

async function runExecCommand(
	ctx: ExtensionCtx,
	args: ExecCommandArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	cwd: string,
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "exec_command" });
	if (ctx.shuttingDown) {
		throw new Error("unified-exec: session is shutting down; not starting new commands.");
	}
	const title = parseTerminalTitle(args.title);
	if (title === undefined) {
		throw new Error(`exec_command: title is required — a short nonblank name for this terminal (at most ${MAX_TITLE_CHARS} characters shown); notices and term:// identify the terminal by it.`);
	}

	const requestedShell = args.shell?.trim() ? args.shell : ctx.shellPath?.();
	const chosen = resolveDefaultShell(undefined, requestedShell, {
		isCmdShell: ctx.shellHost.isCmdShell,
		requestedSource: args.shell?.trim() ? "call" : "shellPath",
	});
	const effectiveCwd = args.workdir && args.workdir.length > 0 ? resolve(cwd, args.workdir) : cwd;
	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_EXEC_YIELD_MS);
	const wantsWake = args.on_exit === "wake";
	const setupFailure = (shell: string, failure: string): ResponseShape => finalizeResponse({
		wallTimeSec: 0,
		collected: NO_OUTPUT,
		sessionId: undefined,
		exitCode: -1,
		signal: null,
		failure,
		logPath: undefined,
		cwd: effectiveCwd,
		shell,
		command: args.cmd,
		yieldTimeMs,
	});
	if (chosen.kind === "refused") {
		const origin = refuseOrigin(chosen.source);
		ctx.ui?.notify(
			tr(
				`unified-exec: not launching cmd (from ${origin.en}); omit shell to run in omp's pi-shell (omp bash), or pass a bash executable path.`,
				`unified-exec：不启动 cmd（来自 ${origin.zh}）；省略 shell 以使用 omp 的 pi-shell（omp bash），或传入 bash 可执行文件路径。`,
			),
			"warning",
		);
		return setupFailure(
			chosen.shell,
			`shell "${chosen.shell}" is not supported: omp-unified-exec never launches cmd. Omit shell to run in omp's pi-shell (omp bash), or pass a bash executable path.`,
		);
	}
	const shell: LaunchShell = chosen.kind === "pi-shell"
		? chosen
		: {
			kind: "shell",
			shell: /[\\/]/.test(chosen.shell)
				? resolve(effectiveCwd, chosen.shell)
				: IS_WINDOWS ? resolveWindowsShell(chosen.shell) : resolveBinary(chosen.shell),
		};
	const shellBin = shell.shell;

	const workdirFailure = workdirProblem(effectiveCwd);
	if (workdirFailure) return setupFailure(shellBin, workdirFailure);

	const script = shellScript(await loadInitFile(ctx.pluginSettings, cwd), shell, args.cmd);
	if (script.kind === "unusable") return setupFailure(shellBin, script.reason);
	const command = shellArgv(shell, script.cmd);

	ctx.invalidateGithubCache?.(args.cmd);

	const id = ctx.store.allocateId();
	const session = ExecSession.spawn(id, {
		command,
		cwd: effectiveCwd,
		env: process.env,
		cols: args.cols !== undefined ? clamp(Math.floor(args.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: args.rows !== undefined ? clamp(Math.floor(args.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: args.cmd,
		title,
		appearance: ctx.appearance,
		inputWait: { quietMs: INPUT_WAIT_QUIET_MS, onAlert: (alert) => ctx.coordinator.alertInputWait(alert) },
	});

	if (session.failureMessage) {
		return finalizeResponse({
			wallTimeSec: 0,
			collected: NO_OUTPUT,
			sessionId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			logPath: undefined, // spawn failed — no log file
			cwd: effectiveCwd,
			shell: session.shell,
			command: args.cmd,
			yieldTimeMs,
		});
	}

	ctx.pendingSessions.add(session);
	try {
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		await Promise.race([
			new Promise<void>((resolve) => {
				if (session.hasExited) return resolve();
				session.exited.addEventListener("abort", () => resolve(), { once: true });
			}),
			sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal),
		]);

		if (session.hasExited && Date.now() <= earlyDeadline + 20) {
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			const wallSec = (Date.now() - start) / 1000;
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				},
			});
		}
		if (!ctx.pendingSessions.has(session)) {
			await waitForExitOrDeadline({ exited: session.exited, durationMs: SHUTDOWN_TERM_GRACE_MS + SHUTDOWN_KILL_GRACE_MS });
			const exited = session.hasExited;
			const collected = exited ? await session.collect({ deadlineMs: Date.now() + 500 }) : NO_OUTPUT;
			return finalizeResponse({
				wallTimeSec: (Date.now() - start) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: exited ? session.failureMessage : "terminated by session_shutdown; exit not confirmed",
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				extra: { on_exit: args.on_exit, ...(exited ? {} : { status: "running" as const, running: true }) },
			});
		}

		// Live session: register it BEFORE we keep polling, so an early abort
		// doesn't let the session be GC'd / lose its place.
		const { pruned, count } = ctx.store.insert(session);
		watchSessionExit(ctx, session);
		if (pruned) {
			unwatchSessionExit(ctx, pruned.id);
			ctx.coordinator.handleEviction(pruned);
			ctx.lifecycle.evicted(pruned, ctx.store.maxSessions);
			ctx.ui?.notify(
				tr(
					`unified-exec: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`,
					`unified-exec：已淘汰会话 ${pruned.id}（LRU，超过上限 ${ctx.store.maxSessions}）`,
				),
				"warning",
			);
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(
				tr(
					`unified-exec: ${count}/${ctx.store.maxSessions} sessions open`,
					`unified-exec：已打开 ${count}/${ctx.store.maxSessions} 个会话`,
				),
				"warning",
			);
		}

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();

		session.touch();
		const stillAlive = !session.hasExited;
		const wallSec = (Date.now() - start) / 1000;

		if (stillAlive) {
			if (wantsWake) ctx.coordinator.register(session);
			ctx.lifecycle.track(session);
			ctx.lifecycle.noteToolRead(toolCallId, session.id);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				logPath: session.logPath,
				cwd: effectiveCwd,
				shell: session.shell,
				command: args.cmd,
				yieldTimeMs,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: heldOpenNote(session),
				},
			});
		}
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			logPath: session.logPath,
			cwd: effectiveCwd,
			shell: session.shell,
			command: args.cmd,
			yieldTimeMs,
			extra: {
				on_exit: args.on_exit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
			},
		});
	} finally {
		ctx.pendingSessions.delete(session);
		if (ctx.store.get(session.id) !== session) void session.release();
	}
}

function missingSessionText(ctx: ExtensionCtx, sid: number, text: string): string {
	const gone = ctx.lifecycle.reclaimed(sid);
	if (!gone) return text;
	const returned = gone.outcome ? `returned ${outcomeText(gone.outcome)} and ` : "";
	const where = gone.identity.terminalUrl ? `read ${gone.identity.terminalUrl} or log_path ${gone.identity.logPath}` : `read log_path ${gone.identity.logPath}`;
	return `${text}; it ${returned}was reclaimed: ${where}`;
}

async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "write_stdin" });
	const writeBytes = resolveWriteInput(args);
	const session = ctx.store.get(args.session_id);
	if (!writeBytes?.length) throw new EmptyPollRemovedError(session?.terminalUrl);
	if (!session) throw new Error(missingSessionText(ctx, args.session_id, `unknown session_id: ${args.session_id}`));

	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);

	const start = Date.now();
	session.touch();

	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		let writeFailure: string | null = null;
		if (writeBytes) {
			const ok = session.write(writeBytes);
			if (ok) ctx.lifecycle.noteInput(session.id, writeBytes);
			if (!ok && !session.hasExited) {
				writeFailure = "PTY write failed: the terminal no longer accepts input; bytes were not delivered";
			}
			if (!ok && session.hasExited) {
				const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
				const armed = ctx.coordinator.isArmed(session.id);
				ctx.lifecycle.noteToolRead(toolCallId, session.id);
				ctx.coordinator.markPendingTerminal(session.id, toolCallId);
				const wallSec = (Date.now() - start) / 1000;
				return finalizeResponse({
					wallTimeSec: wallSec,
					collected,
					totalBytes: session.totalBytesSeen,
					sessionId: undefined,
					exitCode: session.exitCode,
					signal: session.signal,
					failure: session.failureMessage,
					logPath: session.logPath,
					cwd: session.cwd,
					shell: session.shell,
					command: session.displayCommand,
					yieldTimeMs,
					extra: terminalWriteExtra(armed),
				});
			}
			await sleep(100, signal);
		}

		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, onUpdate, deadlineMs, signal);
		const collected = await session.collect({ deadlineMs, externalAbort: signal });
		pollStream.stop();
		const wallSec = (Date.now() - start) / 1000;

		if (session.hasExited) {
			const armed = ctx.coordinator.isArmed(session.id);
			ctx.lifecycle.noteToolRead(toolCallId, session.id);
			ctx.coordinator.markPendingTerminal(session.id, toolCallId);
			return finalizeResponse({
				wallTimeSec: wallSec,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage ?? writeFailure,
				logPath: session.logPath,
				cwd: session.cwd,
				shell: session.shell,
				command: session.displayCommand,
				yieldTimeMs,
				extra: terminalWriteExtra(armed),
			});
		}
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		ctx.lifecycle.noteToolRead(toolCallId, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
			logPath: session.logPath,
			cwd: session.cwd,
			shell: session.shell,
			command: session.displayCommand,
			yieldTimeMs,
			extra: {
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, completion_notification: "armed" as const } : {}),
				note: heldOpenNote(session),
			},
		});
	} catch (err) {
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		throw err;
	}
}

function terminalWriteExtra(wakeWasArmed: boolean): Partial<ResponseShape> {
	return {
		completion_delivery: "direct",
		tool_time_utc: nowUtcIso(),
		...(wakeWasArmed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
	};
}


interface TerminateOutcome {
	session: ExecSession;
	escalated: boolean;
	collected: CollectResult;
	killed: boolean;
}

type TerminateOrigin =
	| { readonly kind: "model"; readonly toolCallId?: string }
	| { readonly kind: "human" }
	| { readonly kind: "reclaim" };

async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
	origin: TerminateOrigin,
): Promise<TerminateOutcome | undefined> {
	if (origin.kind !== "human") ctx.coordinator.cancelMonitor(sid);
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// Explicit kill: suppress the wake BEFORE signaling so the induced exit can
	// never race a wake enqueue, and mark the coming return as a normal ending.
	ctx.coordinator.suppress(sid);
	ctx.lifecycle.noteKill(sid);
	if (origin.kind === "human") ctx.coordinator.monitorEndReason(sid, "human_terminated");
	session.kill(initial);
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	let escalated = false;
	if (!session.hasExited && !IS_WINDOWS) {
		session.kill("SIGKILL");
		escalated = true;
		await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	}
	const collected = await session.collect({ deadlineMs: Date.now() + 100 });
	const killed = session.hasExited;
	if (killed) {
		ctx.coordinator.confirmKill(sid);
		if (origin.kind === "reclaim" || !ctx.lifecycle.isTracked(sid)) removeSession(ctx, sid);
		else if (origin.kind === "model" && origin.toolCallId) ctx.lifecycle.noteToolRead(origin.toolCallId, sid);
		else ctx.lifecycle.markRead(sid);
	} else {
		ctx.coordinator.restoreAfterFailedKill(sid);
		ctx.coordinator.monitorEndReason(sid, "natural");
		ctx.lifecycle.killFailed(sid);
	}
	return { session, escalated, collected, killed };
}

async function killLeftoverGroup(session: ExecSession): Promise<"none" | "killed" | "survived"> {
	if (!session.hasExited || !session.signalProcessGroup(0)) return "none";
	const goneWithin = async (ms: number): Promise<boolean> => {
		for (let waited = 0; waited < ms; waited += GROUP_PROBE_MS) {
			if (!session.signalProcessGroup(0)) return true;
			await sleep(GROUP_PROBE_MS);
		}
		return !session.signalProcessGroup(0);
	};
	session.signalProcessGroup("SIGTERM");
	if (await goneWithin(2000)) return "killed";
	session.signalProcessGroup("SIGKILL");
	return (await goneWithin(500)) ? "killed" : "survived";
}

function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

function sessionWord(count: number): string {
	return count === 1 ? tr("session", "会话") : tr("sessions", "会话");
}

function oneLineCommand(command: string, max = 120): string {
	// sanitizeMeta strips control chars (ESC included) — \s+ alone would let
	// terminal escape sequences through to widgets and pickers.
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		tr(
			`⚠ unified-exec: ${sessions.length} ${sessionWord(sessions.length)} still running`,
			`⚠ unified-exec：${sessions.length} 个会话仍在运行`,
		),
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? tr(" [wake]", " [已唤醒]") : "";
			const held = s.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
			const elapsed = formatElapsedUi(now - s.startedAt);
			return tr(
				`  #${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)} (${s.cwd})`,
				`  #${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}（${s.cwd}）`,
			);
		}),
	];
	if (sessions.length > shown.length) {
		lines.push(tr(
			`  … ${sessions.length - shown.length} more; use read term://`,
			`  … 还有 ${sessions.length - shown.length} 个；使用 read term://`,
		));
	}
	lines.push(tr(
		"  Use read term://, write_stdin, write term://<id>/on_exit (disarm wake), or write term://<id>/kill.",
		"  使用 read term://、write_stdin、write term://<id>/on_exit（取消唤醒）或 write term://<id>/kill。",
	));
	return lines;
}

function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
	const ui = ctx.ui;
	if (!ui) return;
	const sessions = runningSessions(ctx);
	const status = sessions.length
		? tr(
			`unified-exec: ${sessions.length} ${sessionWord(sessions.length)} running`,
			`unified-exec：${sessions.length} 个会话正在运行`,
		)
		: undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			tr(
				`unified-exec: ${sessions.length} ${sessionWord(sessions.length)} still running after /tree.`,
				`unified-exec：/tree 后仍有 ${sessions.length} 个会话在运行。`,
			),
			"warning",
		);
	}

	if (sessions.length === 0) {
		if (ctx.widgetVisible) {
			ui.setWidget(SESSION_UI_KEY, undefined);
			ctx.widgetVisible = false;
		}
		return;
	}

	if (opts.showWidget || ctx.widgetVisible) {
		ui.setWidget(SESSION_UI_KEY, formatRunningSessionsWidget(ctx, sessions), { placement: "aboveEditor" });
		ctx.widgetVisible = true;
	}
}

function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

function buildStreamUpdate(session: ExecSession): AgentToolResult<ProcessUpdateDetails> {
	const snapshot = session.liveSnapshot();
	const text = snapshot ? sanitizeOutputText(snapshot.text) : "";
	return {
		content: [{ type: "text", text }],
		details: {
			session_id: session.id,
			pid: session.pid,
			running: !session.hasExited,
			total_bytes: session.totalBytesSeen,
			command: session.displayCommand,
			cwd: session.cwd,
			shell: session.shell,
			log_path: session.logPath,
			output: text,
			...(snapshot ? { terminal: terminalViewDetails(snapshot.view, true) } : {}),
		},
	};
}

function startStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): { stop: () => void } {
	if (!onUpdate) return { stop: () => {} };
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let sent: { readonly revision: number | undefined; readonly running: boolean; readonly bytes: number } | undefined;
	const tick = () => {
		if (stopped) return;
		const revision = session.screenRevision();
		const running = !session.hasExited;
		const bytes = session.totalBytesSeen;
		if (sent === undefined || sent.revision !== revision || sent.running !== running || sent.bytes !== bytes) {
			sent = { revision, running, bytes };
			try {
				onUpdate(buildStreamUpdate(session));
			} catch {
			}
		}
		if (stopped) return;
		if (Date.now() >= deadlineMs) return;
		if (externalAbort?.aborted) return;
		timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	};
	timer = setTimeout(tick, OUTPUT_POLL_INTERVAL_MS);
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
}

function finalResponseText(event: SessionStopEvent): string | undefined {
	const message = event.last_assistant_message;
	if (message === undefined || !("content" in message)) return undefined;
	let text = "";
	if (typeof message.content === "string") text = message.content;
	else for (const block of message.content) if (block.type === "text") text += block.text;
	return text.trim() ? text : undefined;
}

interface RuntimeOptions {
	readonly attachment: RuntimeHost;
	readonly agentHost: AgentHost | undefined;
	readonly lifecycleClock: LifecycleClock;
	readonly appearance: () => TerminalAppearance;
	readonly shellPath: (() => string | undefined) | undefined;
	readonly shellHost: ShellHost;
	readonly invalidateGithubCache: ((command: string) => void) | undefined;
	readonly pluginSettings: PluginSettingsReader | undefined;
}

function createRuntime(opts: RuntimeOptions): ExtensionCtx {
	const { agentHost } = opts;
	const notices = new NoticeDispatcher({
		send: (message) => deliverNotice(ctx, agentHost, message),
		gate: () => (ctx.host.kind === "attached" ? ctx.host.gate : undefined),
		finished: () => agentHost !== undefined && ctx.agent !== undefined && agentHost.isAdopted(ctx.agent),
		onSendError: (err) => {
			ctx.ui?.notify(
				tr(
					`unified-exec: failed to deliver a terminal notice: ${err instanceof Error ? err.message : String(err)}`,
					`unified-exec：终端通知投递失败：${err instanceof Error ? err.message : String(err)}`,
				),
				"warning",
			);
		},
	});
	const coordinator = new CompletionCoordinator({ notices, judge: () => (ctx.host.kind === "attached" ? ctx.host.judge : undefined) });
	const lifecycle = new TerminalLifecycle({
		...opts.lifecycleClock,
		notices,
		graceReclaimNotice: () => (ctx.host.kind === "attached" ? ctx.host.graceReclaimNotice() : Promise.resolve(false)),
		reclaim: async (id): Promise<ReclaimResult> => {
			const session = ctx.store.get(id);
			if (!session) return { kind: "gone", killedProcesses: false };
			const terminalOpen = !session.hasExited;
			const leftover = await killLeftoverGroup(session);
			if (leftover === "survived") return { kind: "held" };
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "reclaim" });
			updateRunningSessionsUi(ctx);
			if (outcome && !outcome.killed) return { kind: "held" };
			return { kind: "gone", killedProcesses: terminalOpen || leftover === "killed" };
		},
	});
	const ctx: ExtensionCtx = {
		coordinator,
		notices,
		lifecycle,
		store: new SessionStore({
			maxSessions: MAX_SESSIONS, lruProtectedCount: LRU_PROTECTED_COUNT,
			onEvict: (session, reason) => {
				if (reason === "lru" && !session.hasExited) coordinator.monitorEndReason(session.id, "lru_terminated");
			},
		}),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		pendingSessions: new Set(),
		shuttingDown: false,
		appearance: opts.appearance,
		shellPath: opts.shellPath,
		shellHost: opts.shellHost,
		invalidateGithubCache: opts.invalidateGithubCache,
		pluginSettings: opts.pluginSettings,
		host: opts.attachment,
		agent: undefined,
		end: () => endRuntime(ctx),
	};
	return ctx;
}

async function deliverNotice(ctx: ExtensionCtx, agentHost: AgentHost | undefined, message: NoticeMessage): Promise<void> {
	const agent = ctx.agent;
	if (agentHost && agent && (ctx.host.kind === "parked" || agentHost.isParking(agent))) await agentHost.revive(agent.agentId);
	const host = ctx.host;
	if (host.kind !== "attached") throw new Error(`agent ${agent?.agentId ?? "(unknown)"} did not resume its terminals`);
	host.send(message);
}

async function endRuntime(ctx: ExtensionCtx): Promise<void> {
	ctx.host = { kind: "ended" };
	ctx.shuttingDown = true;
	// Cancel lifecycle sweeps, wake timers/listeners and pending notices
	// first: these kills create no notices, and no stale prompt may ever be
	// injected into a new or closed session.
	ctx.lifecycle.shutdown();
	ctx.coordinator.shutdown();
	ctx.notices.stop();
	const drained = ctx.store.terminateAll();
	for (const s of ctx.pendingSessions) {
		void s.releaseForShutdown();
		if (!s.hasExited) {
			s.terminate();
			drained.push(s);
		}
	}
	// The ending now owns these: their exec_command must not insert them into
	// the store once its grace ends (the store belongs to this ended period).
	ctx.pendingSessions.clear();
	clearSessionExitWatchers(ctx);
	updateRunningSessionsUi(ctx);
	// Children run detached (own process groups), so anything that ignores
	// SIGTERM would outlive pi as an orphan.
	await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_TERM_GRACE_MS })));
	if (!IS_WINDOWS) {
		const survivors = drained.filter((s) => !s.hasExited);
		for (const s of survivors) s.kill("SIGKILL");
		await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_KILL_GRACE_MS })));
	}
	if (drained.length && ctx.ui) {
		const leftover = drained.filter((s) => !s.hasExited).length;
		ctx.ui.notify(
			tr(
				`unified-exec: terminated ${drained.length - leftover} live session(s) on shutdown${leftover ? `; ${leftover} did not confirm exit` : ""}`,
				`unified-exec：关机时终止了 ${drained.length - leftover} 个活动会话${leftover ? `；${leftover} 个会话未确认退出` : ""}`,
			),
			leftover ? "warning" : "info",
		);
	}
}

export function activate(
	pi: ExtensionAPI,
	appearance: () => TerminalAppearance = () => "dark",
	shellPath?: () => string | undefined,
	approvalHost?: CommandApprovalHost,
	invalidateGithubCache?: (command: string) => void,
	lifecycleClock: LifecycleClock = {},
	stopHost?: StopHost,
	pluginSettings?: PluginSettingsReader,
	agentHost?: AgentHost,
	shellHost: ShellHost = noShellHost,
): ActivatedExtension {
	let binding: HostBindingState = { kind: "pending" };
	let hostCwd: string | undefined;
	let agentId: string | undefined;
	let activeSessionManager: object | undefined;
	let cachedStopConfig: StopConfig = DEFAULT_STOP_CONFIG;
	const reportedConfigProblems = new Set<string>();
	const warnConfigProblems = (load: Awaited<ReturnType<typeof loadStopConfig>>): void => {
		for (const problem of load.problems) {
			const key = `${problem.path}\n${JSON.stringify(problem.reason)}`;
			if (reportedConfigProblems.has(key)) continue;
			reportedConfigProblems.add(key);
			const reason = renderStopConfigReason(problem.reason, language());
			ctx.ui?.notify(
				tr(`unified-exec: ignoring ${problem.path}: ${reason}`, `unified-exec：忽略 ${problem.path}：${reason}`),
				"warning",
			);
		}
	};
	const refreshStopConfig = async (cwd: string | undefined): Promise<void> => {
		if (!stopHost || !pluginSettings) return;
		const load = await loadStopConfig(pluginSettings, cwd ?? "/");
		warnConfigProblems(load);
		cachedStopConfig = load.config;
	};
	const gate: NoticeGate | undefined = stopHost && {
		config: () => cachedStopConfig,
		detect: (config, input, signal) => detectStop({
			host: stopHost,
			session: () => (binding.kind === "bound" ? binding.session : undefined),
			readTodo: () => (agentId === undefined ? { kind: "no_reply" } : readTodos(pi.events, agentId)),
		}, config, input, signal),
		collect: async () => {
			await ctx.lifecycle.collectReturned();
			updateRunningSessionsUi(ctx);
		},
		tracked: (sessionId) => ctx.lifecycle.isTracked(sessionId),
		verdict: (verdict) => {
			switch (verdict.kind) {
				case "done":
					ctx.ui?.notify(
						tr(
							`unified-exec: the agent's work is done (${verdict.detector}); returned terminals reclaimed, their notices dropped`,
							`unified-exec：判定 agent 已完成（${verdict.detector}）；已回收返回的终端并丢弃其通知`,
						),
						"info",
					);
					return;
				case "not_done":
					return;
				case "undecided":
					if (verdict.cause === "failed") {
						const reason = renderStopReason(verdict.reason, language());
						ctx.ui?.notify(tr(`unified-exec: stop decision failed: ${reason}`, `unified-exec：完成判定失败：${reason}`), "warning");
					}
					return;
			}
		},
	};
	const compactNoticeSender = createCompactNoticeSender({
		sendImmediate: (message) => {
			pi.sendMessage(
				{ customType: "unified-exec-notice", content: message.content, display: true, details: message.details },
				{ deliverAs: "aside" },
			);
		},
		sessionManager: () => activeSessionManager,
	});
	const attachment: RuntimeHost = {
		kind: "attached",
		send: (message) => compactNoticeSender.send(message),
		gate,
		judge: stopHost && screenJudge(stopHost, () => (binding.kind === "bound" ? binding.session : undefined)),
		graceReclaimNotice: async () => {
			const warnOnce = (key: string, message: string): void => {
				if (reportedConfigProblems.has(key)) return;
				reportedConfigProblems.add(key);
				ctx.ui?.notify(message, "warning");
			};
			let stored: Readonly<Record<string, unknown>> = {};
			if (pluginSettings) {
				try {
					stored = await pluginSettings(hostCwd ?? "/");
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					warnOnce(`plugin-settings\n${reason}`, tr(
						`unified-exec: could not read plugin settings, using defaults: ${reason}`,
						`unified-exec：无法读取插件设置，改用默认值：${reason}`,
					));
				}
			}
			const read = parseGraceReclaim(stored);
			if (read.kind === "ok") return read.value;
			warnOnce(`plugin-setting\n${read.key}`, tr(
				`unified-exec: plugin setting ${read.key} must be true or false; using ${read.fallback}`,
				`unified-exec：插件设置 ${read.key} 必须为 true 或 false；改用 ${read.fallback}`,
			));
			return read.fallback;
		},
	};
	const parked = parkedRuntimes<ExtensionCtx>();
	let ctx = createRuntime({ attachment, agentHost, lifecycleClock, appearance, shellPath, shellHost, invalidateGithubCache, pluginSettings });
	registerActualTerminalCompactHandoff(pi, () => ctx.store);
	const resolveSessionTarget = (target: string): { readonly sid: number; readonly session: ExecSession | undefined } => {
		if (/^\d+$/.test(target)) {
			const sid = Number(target);
			return { sid, session: ctx.store.get(sid) };
		}
		const byKey = ctx.store.values().find((s) => s.terminalUrl === `term://${target}`);
		if (byKey) return { sid: byKey.id, session: byKey };
		const leadingId = /^(\d+)-/.exec(target);
		const sid = leadingId ? Number(leadingId[1]) : -1;
		return { sid, session: undefined };
	};
	const urlRuntime: TerminalUrlRuntime = {
		resolveSessionKey: (id) => ctx.store.get(id)?.terminalUrl?.slice("term://".length),
		listSessions: () => {
			for (const s of ctx.store.values()) if (s.hasExited) ctx.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const sessions = ctx.store.values()
				.sort((a, b) => a.id - b.id)
				.map((s) => {
					const life = ctx.lifecycle.status(s.id);
					const key = s.terminalUrl?.startsWith("term://") ? s.terminalUrl.slice("term://".length) : undefined;
					return {
						session_id: s.id,
						key,
						title: s.title,
						command: s.displayCommand,
						cwd: s.cwd,
						shell: s.shell,
						pid: s.pid,
						started_at_ms: s.startedAt,
						elapsed_ms: now - s.startedAt,
						running: !s.hasExited,
						wake_armed: ctx.coordinator.isArmed(s.id),
						monitor: ctx.coordinator.monitorStatus(s.id),
						lifecycle: life ? { returned: outcomeText(life.outcome), read: life.read, phase: life.phase } : undefined,
						exit_code: s.hasExited ? s.exitCode : undefined,
						signal: s.hasExited ? (s.signal ?? undefined) : undefined,
						failure_message: s.failureMessage ?? undefined,
						output_bytes_total: s.totalBytesSeen,
						log_path: s.logPath,
						url: `term://${s.id}`,
						terminal_url: s.terminalUrl,
					};
				});
			const runningCount = sessions.filter((s) => s.running).length;
			const returnedCount = sessions.filter((s) => s.lifecycle !== undefined).length;
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const state = s.running
							? "running"
							: `exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}`;
						const life = s.lifecycle ? `  [returned ${s.lifecycle.returned}; ${s.lifecycle.read ? "read" : "unread"}; ${s.lifecycle.phase}]` : "";
						const wake = s.wake_armed ? " [wake]" : "";
						const monitor = s.monitor ? ` [monitor ${s.monitor.returns}/${s.monitor.max_returns} ${watchLabel(s.monitor.watch)} remind_after=${formatElapsed(s.monitor.remind_after_ms)}]` : "";
						return `  session_id=${s.session_id}  ${JSON.stringify(s.title)}  [${state}]  url=${s.url}${s.key ? `  key=${s.key}` : ""}  pid=${s.pid ?? "?"}  ${(s.elapsed_ms / 1000).toFixed(1)}s${wake}${monitor}  ${oneLineCommand(s.command, 60)}${life}\n        shell: ${sanitizeMeta(s.shell ?? "")}\n        log: ${s.log_path}${s.terminal_url ? `\n        terminal_url: ${s.terminal_url}` : ""}`;
					})
				: ["  (no terminals)"];
			const header = `Active terminals (${runningCount} running, ${returnedCount} exited):`;
			return `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}`;
		},
		writeStdin: async (target, content, toolCallId, signal) => {
			const { sid, session: resolved } = resolveSessionTarget(target);
			if (!resolved) {
				throw new Error(sid >= 0 ? missingSessionText(ctx, sid, `No such session: ${target}`) : `No such session: ${target}`);
			}
			const data = /[\r\n]$/.test(content) ? content : `${content}\r`;
			const syntheticId = toolCallId === undefined ? `write-term-${sid}-${Date.now()}` : undefined;
			const callId = toolCallId ?? syntheticId!;
			const shape = await runWriteStdin(
				ctx,
				{ session_id: sid, text: data, yield_time_ms: DEFAULT_WRITE_STDIN_YIELD_MS },
				signal,
				undefined,
				callId,
			);
			const isErr = (shape.exit_code !== undefined && shape.exit_code !== 0) || shape.signal !== null || shape.failure_message !== null;
			if (syntheticId !== undefined) {
				ctx.lifecycle.commitToolReads(syntheticId, isErr);
				ctx.coordinator.handleToolExecutionEnd(syntheticId, isErr);
			}
			updateRunningSessionsUi(ctx);
			return { text: renderProcessResultText(shape), isError: isErr };
		},
		killSession: async (target, rawSignal, toolCallId) => {
			const { sid, session: resolved } = resolveSessionTarget(target);
			if (!resolved) {
				throw new Error(sid >= 0 ? missingSessionText(ctx, sid, `No such session: ${target}`) : `No such session: ${target}`);
			}
			const initial = normalizeSignal(rawSignal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, { kind: "model", toolCallId });
			if (!outcome) {
				throw new Error(missingSessionText(ctx, sid, `No such session: ${target}`));
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							`the session remains registered — retry write term://${sid}/kill or check permissions`,
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				sessionId: sid,
				pid: session.pid,
				requestedSignal: initial,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: killFailure || null,
				logPath: session.logPath,
				cwd: session.cwd,
				shell: session.shell,
				command: session.displayCommand,
				escalated,
				killed,
			});
			return { text: renderKillResultText(details), killed };
		},
		setOnExit: (target, policy) => {
			const { sid, session } = resolveSessionTarget(target);
			if (sid < 0 || (policy === "wake" && !session)) {
				throw new Error(sid >= 0 ? missingSessionText(ctx, sid, `No such session: ${target}`) : `No such session: ${target}`);
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			if (!session && status === "already_none") {
				throw new Error(missingSessionText(ctx, sid, `No such session: ${target}`));
			}
			updateRunningSessionsUi(ctx);
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			return (
				`on_exit session_id=${sid} policy=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed")
			);
		},
		cancelMonitor: (target) => {
			const { sid, session } = resolveSessionTarget(target);
			if (sid < 0 || (!session && !ctx.coordinator.monitorStatus(sid))) {
				throw new Error(sid >= 0 ? missingSessionText(ctx, sid, `No such session: ${target}`) : `No such session: ${target}`);
			}
			const cancelled = ctx.coordinator.cancelMonitor(sid);
			updateRunningSessionsUi(ctx);
			return JSON.stringify({ session_id: sid, status: cancelled ? "cancelled" : "not_monitored" });
		},
	};
	setTerminalUrlRuntime(urlRuntime);
	pi.registerMessageRenderer("unified-exec-notice", (message) => {
		const box = new Box(1, 1);
		box.addChild(new Text(buildNoticeDisplayMessage(message.details), 0, 0));
		return box;
	});

	pi.on("tool_execution_end", async (event) => {
		ctx.lifecycle.commitToolReads(event.toolCallId, event.isError === true);
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	pi.on("agent_start", async () => {
		await refreshStopConfig(hostCwd);
		ctx.notices.agentStarted();
	});
	pi.on("agent_end", async (event) => {
		const willContinue = event.willContinue === true;
		const awaitingAsyncWork = event.awaitingAsyncWork === true;
		if (willContinue && !awaitingAsyncWork) return;
		await refreshStopConfig(hostCwd);
		ctx.coordinator.flushPending();
		ctx.notices.agentStopped(awaitingAsyncWork ? "awaiting" : "final");
	});

	pi.on("session_start", async (_event, eventCtx) => {
		if (approvalHost && binding.kind === "pending") binding = bindSession(approvalHost, bindingContext(eventCtx));
		hostCwd = eventCtx.cwd;
		activeSessionManager = eventCtx.sessionManager;
		agentId = bindingContext(eventCtx).agentId;
		const agent = agentHost && agentId !== undefined ? agentHost.identify(agentId) : undefined;
		const resumed = agent && parked.take(agent.generation);
		if (resumed) {
			ctx = resumed;
		} else {
			ctx.shuttingDown = false; // reload/new/resume re-arms the extension
			// Never resurrect notices or wakes from a previous session.
			compactNoticeSender.clearQueued();
			ctx.notices.reset();
			ctx.coordinator.reset();
			ctx.lifecycle.restart();
			ctx.agent = agent;
		}
		setTerminalUrlRuntime(urlRuntime);
		ctx.host = attachment;
		ctx.ui = eventCtx.ui;
		await refreshStopConfig(hostCwd);
		updateRunningSessionsUi(ctx);
	});

	const rebind = async (eventCtx: ExtensionContext): Promise<void> => {
		hostCwd = eventCtx.cwd;
		activeSessionManager = eventCtx.sessionManager;
		compactNoticeSender.clearQueued();
		binding = recheckBinding(binding, bindingContext(eventCtx));
		ctx.notices.forgetResponse();
		await refreshStopConfig(hostCwd);
	};
	pi.on("session_switch", async (_event, eventCtx) => rebind(eventCtx));
	pi.on("session_branch", async (_event, eventCtx) => rebind(eventCtx));
	pi.on("session_stop", async (event) => {
		const text = finalResponseText(event);
		if (text !== undefined) ctx.notices.recordResponse(text);
	});

	pi.on("session_tree", async (_event, eventCtx) => {
		activeSessionManager = eventCtx.sessionManager;
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx, { showWidget: true, notifyTree: runningSessions(ctx).length > 0 });
	});

	pi.on("session_shutdown", async () => {
		const agent = ctx.agent;
		if (agentHost && agent && agentHost.isParking(agent)) {
			ctx.host = { kind: "parked" };
			ctx.ui = undefined;
			ctx.widgetVisible = false;
			parked.hold(agentHost, agent.generation, ctx);
			return;
		}
		activeSessionManager = undefined;
		compactNoticeSender.clearQueued();
		if (getTerminalUrlRuntime() === urlRuntime) setTerminalUrlRuntime(undefined);
		await ctx.end();
		await parked.settled();
	});

	pi.registerCommand("unified-exec-sessions", {
		description: tr(
			"List live unified-exec sessions and optionally kill one (or all)",
			"列出正在运行的 unified-exec 会话，并可结束其中一个（或全部）",
		),
		handler: async (_args, cmdCtx) => {
			ctx.ui = cmdCtx.ui;
			updateRunningSessionsUi(ctx);
			const sessions = runningSessions(ctx);
			if (sessions.length === 0) {
				cmdCtx.ui.notify(
					tr("unified-exec: no live sessions", "unified-exec：没有正在运行的会话"),
					"info",
				);
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => {
				const wake = ctx.coordinator.isArmed(s.id) ? tr(" [wake]", " [已唤醒]") : "";
				const held = s.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
				const elapsed = formatElapsedUi(now - s.startedAt);
				return tr(
					`#${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}`,
					`#${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}`,
				);
			});
			const KILL_ALL = tr(
				`Kill all ${sessions.length} ${sessionWord(sessions.length)}`,
				`结束全部 ${sessions.length} 个会话`,
			);
			const choice = await cmdCtx.ui.select(
				tr(
					`unified-exec: ${sessions.length} live ${sessionWord(sessions.length)} — select to kill (Esc to cancel)`,
					`unified-exec：${sessions.length} 个正在运行的会话——选择要结束的会话（Esc 取消）`,
				),
				[...labels, KILL_ALL],
			);
			if (!choice) return;
			const targets = choice === KILL_ALL ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(ctx, s.id, "SIGTERM", { kind: "human" });
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(ctx);
			cmdCtx.ui.notify(
				tr(
					`unified-exec: killed ${killed} ${sessionWord(killed)}${failed ? `; ${failed} did not confirm exit (still listed)` : ""}`,
					`unified-exec：已结束 ${killed} 个会话${failed ? `；${failed} 个会话未确认退出（仍在列表中）` : ""}`,
				),
				failed ? "warning" : "info",
			);
		},
	});


	const execCommandDocTopics = registerExecCommandTopics();

	const execCommandParameters = Type.Object({
		cmd: Type.String({ description: "Shell command to execute." }),
		title: Type.String({ description: `Terminal name in term://, the Terminals view and every notice: one nonblank line, at most ${MAX_TITLE_CHARS} characters kept.` }),
		workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
		shell: Type.Optional(Type.String({
			description: "Shell executable. Defaults to omp shellPath, then $SHELL, then the platform default: omp's pi-shell (omp bash, bash 5.3 syntax) on Windows, bash elsewhere. cmd is refused. Write cmd in that shell's syntax; results name it.",
		})),
		cols: Type.Optional(Type.Number({
			description: `PTY width in columns. Default 120, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].`,
		})),
		rows: Type.Optional(Type.Number({
			description: `PTY height in rows. Default ${DEFAULT_PTY_ROWS}, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].`,
		})),
		yield_time_ms: Type.Optional(Type.Number({
			description: `How long (ms) this call waits for output before returning. Default ${DEFAULT_EXEC_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
		})),
		on_exit: Type.Optional(StringEnum(
			["none", "wake"] as const,
			'"none" (default). "wake": resume you once when the process exits unobserved; only when the human explicitly asks, never for servers or watchers. A tool result observing the exit consumes it; write term://<id>/on_exit changes it.',
		)),
	});

	const execCommandTool: ToolDefinition<typeof execCommandParameters> & {
		readonly docTopics: () => Record<string, string>;
	} = {
		name: "exec_command",
		label: tr("Execute command", "执行命令"),
		...(approvalHost ? {
			approval: (args: unknown) => approveBoundCommand(approvalHost, binding, args),
			formatApprovalDetails: (args: unknown) => [
				tr(
					`Command: ${approvalHost.helpers.truncateForPrompt(approvalCommand(args, "(missing)"))}`,
					`命令：${approvalHost.helpers.truncateForPrompt(approvalCommand(args, "（缺失）"))}`,
				),
			],
		} : {}),
		description:
			"Run an interactive or long-lived command in a PTY terminal (complements non-interactive `bash` for REPLs, TUIs, SSH, sudo, or stateful shells). Returns session_id or exit_code; inspect or control via `term://`. " +
			execCommandTopicPointers,
		docTopics: execCommandDocTopics,
		parameters: execCommandParameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params, signal, onUpdate, eventCtx.cwd, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
	};
	pi.registerTool(execCommandTool);

	const writeStdinParameters = Type.Object({
		session_id: Type.Number({ description: "Session id from exec_command." }),
		text: Type.Optional(Type.String({
			description: "Verbatim UTF-8 text to write to stdin (no backslash escaping). Mutually exclusive with raw_base64.",
		})),
		enter: Type.Optional(Type.Boolean({
			description: "Append Enter (\\r) after text/special_key, or send Enter alone. Mutually exclusive with raw_base64.",
		})),
		special_key: Type.Optional(StringEnum(
			SPECIAL_KEYS,
			"Control or navigation key to send (ctrl-c, ctrl-d, ctrl-z, esc, tab, up, down, left, right, backspace, delete). Mutually exclusive with raw_base64.",
		)),
		raw_base64: Type.Optional(Type.String({
			description: "Raw bytes encoded as base64. Mutually exclusive with text, enter, and special_key.",
		})),
		yield_time_ms: Type.Optional(Type.Number({
			description: `Attachment window in ms, not a process timeout. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
		})),
	}, { additionalProperties: false });
	pi.registerTool({
		name: "write_stdin",
		label: tr("Send input", "发送输入"),
		description:
			"Send verbatim text, Enter, special keys (ctrl-c, arrow keys, etc.), or raw_base64 to an active PTY session (or write line input directly via `write term://<id>`). " +
			writeStdinTopicPointers,
		parameters: writeStdinParameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params, signal, onUpdate, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
	} satisfies ToolDefinition<typeof writeStdinParameters>);

	const monitorParameters = Type.Object({
		session_id: Type.Number({ description: "Existing running session id." }),
		condition: Type.Optional(Type.String({ description: "JavaScript regex source without / delimiters. Omit both condition and judge to await completion only." })),
		judge: Type.Optional(Type.String({ description: "Intent the judge checks each new screen against, e.g. \"the server is ready to accept requests\"; each screen judged met wakes you. Excludes condition." })),
		judge_interval_ms: Type.Optional(Type.Number({ description: "With judge: time between judgments; default 60000, integer 1–2147483647. An unchanged screen is not judged again." })),
		max_returns: Type.Optional(Type.Number({ description: "Positive safe integer; default 10 returns (matched batches or met screens). End does not count; the last return ends the monitor, not the process." })),
		remind_after_ms: Type.Optional(Type.Number({ description: "Silence before one reminder quoting the current screen; default 1200000 (20 minutes), integer 1–2147483647. A return restarts it; the reminder neither counts toward max_returns nor ends the monitor." })),
	});
	pi.registerTool({
		name: "monitor",
		label: tr("Monitor", "监视"),
		description:
			"Subscribe to future output or completion events from a running PTY session (regex condition, judge intent, or exit). Cancel via `write term://<id>/monitor` (`\"cancel\"`). " +
			monitorTopicPointers,
		parameters: monitorParameters,
		async execute(_toolCallId, params, signal) {
			let details: MonitorScriptResult;
			try {
				const session = ctx.store.get(params.session_id);
				if (!session) throw new MonitorError("unknown_session", missingSessionText(ctx, params.session_id, `No such session: ${params.session_id}`));
				const monitor = await ctx.coordinator.startMonitor(session, {
					condition: params.condition, judge: params.judge, judgeIntervalMs: params.judge_interval_ms,
					maxReturns: params.max_returns, remindAfterMs: params.remind_after_ms,
				}, signal);
				details = { session_id: params.session_id, status: "started", monitor };
			} catch (error) {
				if (!(error instanceof MonitorError)) throw error;
				details = { session_id: params.session_id, status: "error", code: error.code, message: error.message };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
				...(details.status === "error" ? { isError: true } : {}),
			};
		},
	} satisfies ToolDefinition<typeof monitorParameters>);

	return {
		store: () => ctx.store,
		kill: async (id) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "human" });
			updateRunningSessionsUi(ctx);
			return outcome?.killed === true;
		},
	};
}

export default withHostPresentation(activate, initializeTerminalUrls);
