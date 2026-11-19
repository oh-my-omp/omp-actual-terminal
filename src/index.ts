import { constants as osConstants } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import { Type, type TUnsafe } from "typebox";

import { type AgentHost, type AgentIdentity, type ParkedRuntime, parkedRuntimes } from "../fork-features/agent-park.ts";
import { type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { approvalCommand, approveBoundCommand, type CommandApprovalHost } from "../fork-features/command-approval.ts";
import {
	execCommandDocumentation, execCommandTopicPointers,
	writeStdinDocumentation, writeStdinTopicPointers,
	setOnExitDocumentation, setOnExitTopicPointers,
	monitorDocumentation, monitorTopicPointers,
	killSessionDocumentation, killSessionTopicPointers,
	listSessionsDocumentation, listSessionsTopicPointers,
} from "../fork-features/exec-command-docs.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "../fork-features/session-binding.ts";
import { MonitorError, type MonitorWatchStatus } from "../fork-features/monitor-subscription.ts";
import { loadInitFile, shellScript } from "../fork-features/exec-init.ts";
import { noShellHost, type ShellHost } from "../fork-features/shell-host.ts";
import { parseGraceReclaim, type PluginSettingsReader } from "../fork-features/plugin-settings.ts";
import { loadStopConfig } from "../fork-features/stop-config.ts";
import { detectStop, type StopHost } from "../fork-features/stop-gate.ts";
import { screenJudge, type ScreenJudge } from "../fork-features/screen-judge.ts";
import { renderStopConfigReason, renderStopReason } from "../fork-features/stop-reasons.ts";
import { type LifecycleClock, type ReclaimResult, TerminalLifecycle } from "../fork-features/terminal-lifecycle.ts";
import { buildNoticeDisplayMessage, MAX_TITLE_CHARS, NoticeDispatcher, type NoticeGate, type NoticeMessage, outcomeText, parseTerminalTitle } from "../fork-features/terminal-notice.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed, formatElapsedUi, nowUtcIso } from "./format-time.ts";
import { language, tr } from "../fork-features/omomp-shared/i18n.ts";
import { readTodos } from "../fork-features/omomp-shared/todo-read.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { DEFAULT_PTY_ROWS } from "./pty.ts";
import {
	killNotFoundScriptResult,
	killScriptResult,
	killScriptResultSchema,
	listSessionsScriptResult,
	listSessionsScriptResultSchema,
	monitorScriptResultSchema,
	type MonitorScriptResult,
	processScriptResult,
	processScriptResultSchema,
	setOnExitScriptResult,
	setOnExitScriptResultSchema,
} from "./script-result.ts";
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
import { unescapeChars } from "./unescape.ts";


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

type WriteStdinArgs = {
	session_id: number;
	chars?: string;
	chars_b64?: string;
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
	const hasChars = typeof args.chars === "string" && args.chars.length > 0;
	const hasB64 = typeof args.chars_b64 === "string" && args.chars_b64.length > 0;
	if (hasChars && hasB64) {
		throw new Error("write_stdin: pass either `chars` or `chars_b64`, not both.");
	}
	if (hasB64) {
		const b64 = args.chars_b64!.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `chars_b64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	if (hasChars) {
		return encode(unescapeChars(args.chars!));
	}
	return undefined;
}

const HELD_OPEN_NOTE = IS_WINDOWS
	? "shell has exited, but background process(es) still hold the terminal " +
		"(a job started from this shell that kept its console as stdin/stdout/stderr), " +
		"so this session stays open until they exit, or end the session with kill_session."
	: "shell has exited, but background process(es) still hold the terminal " +
		"(e.g. a nohup'd or SIGHUP-ignoring job that kept the PTY as stdin/stdout/stderr), " +
		"so this session stays open until they exit. To detach: redirect inside the job — " +
		"`setsid cmd >log 2>&1 </dev/null &` — or end the session with kill_session.";

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
		throw new Error(`exec_command: title is required — a short nonblank name for this terminal (at most ${MAX_TITLE_CHARS} characters shown); notices and list_sessions identify the terminal by it.`);
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
	| { readonly kind: "model"; readonly toolCallId: string }
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
		else if (origin.kind === "model") ctx.lifecycle.noteToolRead(origin.toolCallId, sid);
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
			`  … ${sessions.length - shown.length} more; use list_sessions`,
			`  … 还有 ${sessions.length - shown.length} 个；使用 list_sessions`,
		));
	}
	lines.push(tr(
		"  Use list_sessions, write_stdin, set_on_exit (disarm wake), or kill_session.",
		"  使用 list_sessions、write_stdin、set_on_exit（取消唤醒）或 kill_session。",
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

function finalResponseText(event: unknown): string | undefined {
	const message: unknown = typeof event === "object" && event !== null ? Reflect.get(event, "last_assistant_message") : undefined;
	const content: unknown = typeof message === "object" && message !== null ? Reflect.get(message, "content") : undefined;
	const text = typeof content === "string" ? content : Array.isArray(content)
		? content.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("")
		: "";
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
	const reportedConfigProblems = new Set<string>();
	const gate: NoticeGate | undefined = stopHost && {
		config: () => {
			const load = loadStopConfig(hostCwd, stopHost.getAgentDir());
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
			return load.config;
		},
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
	const sendOmpMessage = (pi as ExtensionAPI & {
		sendMessage(
			message: { customType: string; content: string; display: boolean; details: unknown },
			options: { deliverAs: "aside" },
		): void;
	}).sendMessage;
	const attachment: RuntimeHost = {
		kind: "attached",
		send: (message) => {
			sendOmpMessage.call(
				pi,
				{ customType: "unified-exec-notice", content: message.content, display: true, details: message.details },
				{ deliverAs: "aside" },
			);
		},
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
	const registerMessageRenderer = (pi as ExtensionAPI & {
		registerMessageRenderer?: (
			customType: string,
			renderer: (message: { readonly details?: unknown }, options: { readonly outputPad: number }, theme: unknown) => Component | undefined,
		) => void;
	}).registerMessageRenderer;
	registerMessageRenderer?.call(pi, "unified-exec-notice", (message, { outputPad }) => {
		const box = new Box(outputPad, 1);
		box.addChild(new Text(buildNoticeDisplayMessage(message.details), 0, 0));
		return box;
	});


	pi.on("tool_execution_end", async (event) => {
		ctx.lifecycle.commitToolReads(event.toolCallId, event.isError === true);
		ctx.coordinator.handleToolExecutionEnd(event.toolCallId, event.isError === true);
	});
	pi.on("agent_start", async () => {
		ctx.notices.agentStarted();
	});
	pi.on("agent_end", async (event) => {
		const willContinue = Reflect.get(event, "willContinue") === true;
		const awaitingAsyncWork = Reflect.get(event, "awaitingAsyncWork") === true;
		if (willContinue && !awaitingAsyncWork) return;
		ctx.coordinator.flushPending();
		ctx.notices.agentStopped(awaitingAsyncWork ? "awaiting" : "final");
	});

	pi.on("session_start", async (_event, eventCtx) => {
		if (approvalHost && binding.kind === "pending") binding = bindSession(approvalHost, bindingContext(eventCtx));
		hostCwd = eventCtx.cwd;
		agentId = bindingContext(eventCtx).agentId;
		const agent = agentHost && agentId !== undefined ? agentHost.identify(agentId) : undefined;
		const resumed = agent && parked.take(agent.generation);
		if (resumed) {
			ctx = resumed;
		} else {
			ctx.shuttingDown = false; // reload/new/resume re-arms the extension
			// Never resurrect notices or wakes from a previous session.
			ctx.notices.reset();
			ctx.coordinator.reset();
			ctx.lifecycle.restart();
			ctx.agent = agent;
		}
		ctx.host = attachment;
		ctx.ui = eventCtx.ui;
		updateRunningSessionsUi(ctx);
	});

	const onHostEvent = (pi as ExtensionAPI & {
		on(event: "session_switch" | "session_branch" | "session_stop",
			handler: (event: unknown, context: unknown) => Promise<void>): void;
	}).on;
	for (const event of ["session_switch", "session_branch"] as const) {
		onHostEvent.call(pi, event, async (_event, eventCtx) => {
			binding = recheckBinding(binding, bindingContext(eventCtx));
			ctx.notices.forgetResponse();
		});
	}
	onHostEvent.call(pi, "session_stop", async (event) => {
		const text = finalResponseText(event);
		if (text !== undefined) ctx.notices.recordResponse(text);
	});

	pi.on("session_tree", async (_event, eventCtx) => {
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


	const execCommandParameters = Type.Object({
		cmd: Type.String({ description: "Shell command to execute." }),
		title: Type.String({ description: `Terminal name in list_sessions, the Terminals view and every notice: one nonblank line, at most ${MAX_TITLE_CHARS} characters kept.` }),
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
			'"none" (default). "wake": resume you once when the process exits unobserved; only when the human explicitly asks, never for servers or watchers. A tool result observing the exit consumes it; set_on_exit changes it.',
		)),
	});

	pi.registerTool({
		name: "exec_command",
		...execCommandDocumentation,
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
			"Run a command in a PTY for long-running, interactive (REPL, TUI, ssh, sudo), concurrent or daemon work; bash for one-shot commands. No command deadline. Returns session_id if running, else exit_code. " +
			execCommandTopicPointers,
		outputSchema: processScriptResultSchema,
		parameters: execCommandParameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runExecCommand(ctx, params, signal, onUpdate, eventCtx.cwd, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
	} satisfies ToolDefinition<typeof execCommandParameters> & { docTopics(): Readonly<Record<string, string>> });

	const writeStdinParameters = Type.Object({
		session_id: Type.Number({ description: "Session id from exec_command." }),
		chars: Type.Optional(Type.String({
			description: "Text with C-style escapes: \\xHH, \\uHHHH, \\u{H\u2026}, \\n \\r \\t \\0 \\a \\e \\b \\f \\v \\\\ \\\". Unknown \\X preserved literally. Mutually exclusive with chars_b64.",
		})),
		chars_b64: Type.Optional(Type.String({
			description: "Raw bytes (base64) to write. Mutually exclusive with chars.",
		})),
		yield_time_ms: Type.Optional(Type.Number({
			description: `Attachment window in ms, not a process timeout. Default ${DEFAULT_WRITE_STDIN_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
		})),
	}, { additionalProperties: false });
	pi.registerTool({
		name: "write_stdin",
		...writeStdinDocumentation,
		label: tr("Send input", "发送输入"),
		description:
			"Send input to a running session's PTY; returns output like exec_command." +
			writeStdinTopicPointers,
		outputSchema: processScriptResultSchema,
		parameters: writeStdinParameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(ctx, params, signal, onUpdate, toolCallId);
			updateRunningSessionsUi(ctx);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
				structuredContent: processScriptResult(shape),
			};
		},
	} satisfies ToolDefinition<typeof writeStdinParameters> & { docTopics(): Readonly<Record<string, string>> });

	const setOnExitParameters = Type.Object({
		session_id: Type.Number({ description: "Session id from exec_command." }),
		on_exit: StringEnum(
			["none", "wake"] as const,
			'"none": disarm (also after eviction) as soon as auto-resume is unwanted. "wake": arm auto-resume while running, only when the human explicitly asked.',
		),
	});
	pi.registerTool({
		name: "set_on_exit",
		...setOnExitDocumentation,
		label: tr("Set exit wake", "设置退出唤醒"),
		description:
			"Change a session's on_exit policy without stopping the process." + setOnExitTopicPointers,
		outputSchema: setOnExitScriptResultSchema,
		parameters: setOnExitParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const { session_id: sid, on_exit: policy } = params as { session_id: number; on_exit: OnExitPolicy };
			const session = ctx.store.get(sid);
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: missingSessionText(ctx, sid, `No such session: ${sid}`) }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const status = ctx.coordinator.setOnExit(sid, policy, session);
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: missingSessionText(ctx, sid, `No such session: ${sid}`) }],
					details: { session_id: sid, found: false },
					structuredContent: setOnExitScriptResult({ session_id: sid, found: false }),
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(sid);
			const text =
				`set_on_exit session_id=${sid} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				structuredContent: setOnExitScriptResult({
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
				}),
				details: {
					session_id: sid,
					found: true,
					on_exit: policy,
					status,
					running,
					wake_armed: armed,
					command: session?.displayCommand,
					log_path: session?.logPath,
					tool_time_utc: nowUtcIso(),
				},
			};
		},
	} satisfies ToolDefinition<typeof setOnExitParameters> & { docTopics(): Readonly<Record<string, string>> });

	const monitorParameters = Type.Object({
		session_id: Type.Number({ description: "Existing running session id." }),
		action: Type.Optional(StringEnum(["start", "cancel"] as const, "start (default) establishes or replaces; cancel removes silently.")),
		condition: Type.Optional(Type.String({ description: "JavaScript regex source without / delimiters. Omit both condition and judge to await completion only." })),
		judge: Type.Optional(Type.String({ description: "Intent the judge checks each new screen against, e.g. \"the server is ready to accept requests\"; each screen judged met wakes you. Excludes condition." })),
		judge_interval_ms: Type.Optional(Type.Number({ description: "With judge: time between judgments; default 60000, integer 1–2147483647. An unchanged screen is not judged again." })),
		max_returns: Type.Optional(Type.Number({ description: "Positive safe integer; default 10 returns (matched batches or met screens). End does not count; the last return ends the monitor, not the process." })),
		remind_after_ms: Type.Optional(Type.Number({ description: "Silence before one reminder quoting the current screen; default 1200000 (20 minutes), integer 1–2147483647. A return restarts it; the reminder neither counts toward max_returns nor ends the monitor." })),
	});
	pi.registerTool({
		name: "monitor",
		...monitorDocumentation,
		label: tr("Monitor", "监视"),
		description:
			"Wait for a running session's future output: each batch matching condition or each new screen the judge finds meets your intent wakes you; with neither, its end wakes you once." +
			monitorTopicPointers,
		parameters: monitorParameters,
		outputSchema: monitorScriptResultSchema,
		async execute(_toolCallId, params, signal) {
			let details: MonitorScriptResult;
			try {
				if (params.action === "cancel") {
					details = { session_id: params.session_id, status: ctx.coordinator.cancelMonitor(params.session_id) ? "cancelled" : "not_monitored" };
				} else {
					const session = ctx.store.get(params.session_id);
					if (!session) throw new MonitorError("unknown_session", missingSessionText(ctx, params.session_id, `No such session: ${params.session_id}`));
					const monitor = await ctx.coordinator.startMonitor(session, {
						condition: params.condition, judge: params.judge, judgeIntervalMs: params.judge_interval_ms,
						maxReturns: params.max_returns, remindAfterMs: params.remind_after_ms,
					}, signal);
					details = { session_id: params.session_id, status: "started", monitor };
				}
			} catch (error) {
				if (!(error instanceof MonitorError)) throw error;
				details = { session_id: params.session_id, status: "error", code: error.code, message: error.message };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details, structuredContent: details,
				...(details.status === "error" ? { isError: true } : {}),
			};
		},
	} satisfies ToolDefinition<typeof monitorParameters> & { docTopics(): Readonly<Record<string, string>> });

	const killSessionParameters = Type.Object({
		session_id: Type.Number({ description: "Session to terminate." }),
		signal: Type.Optional(Type.String({
			description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.',
		})),
	});
	pi.registerTool({
		name: "kill_session",
		...killSessionDocumentation,
		label: tr("Terminate session", "结束会话"),
		description:
			"Terminate a session: SIGTERM, then SIGKILL after 2 s; on Windows any signal force-kills the process tree." +
			killSessionTopicPointers,
		outputSchema: killScriptResultSchema,
		parameters: killSessionParameters,
		async execute(toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = (params as { session_id: number; signal?: string }).session_id;
			const initial = normalizeSignal((params as { signal?: string }).signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, { kind: "model", toolCallId });
			if (!outcome) {
				return {
					content: [{ type: "text", text: missingSessionText(ctx, sid, `No such session: ${sid}`) }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						session_id: sid,
						found: false,
					} as const,
					structuredContent: killNotFoundScriptResult(sid),
				};
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the session remains registered — retry kill_session or check permissions",
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
			return {
				content: [{ type: "text", text: renderKillResultText(details) }],
				details,
				structuredContent: killScriptResult(details),
			};
		},
	} satisfies ToolDefinition<typeof killSessionParameters> & { docTopics(): Readonly<Record<string, string>> });

	const listSessionsParameters = Type.Object({});
	pi.registerTool({
		name: "list_sessions",
		...listSessionsDocumentation,
		label: tr("List sessions", "列出会话"),
		description: "List this omp run's unified-exec terminals: running ones, and returned ones not yet reclaimed, with their titles and lifecycle state." + listSessionsTopicPointers,
		outputSchema: listSessionsScriptResultSchema,
		parameters: listSessionsParameters,
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			for (const s of ctx.store.values()) if (s.hasExited) ctx.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const stored = ctx.store.values();
			const sessions = stored
				.sort((a, b) => a.id - b.id)
				.map((s) => {
					const life = ctx.lifecycle.status(s.id);
					return {
						session_id: s.id,
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
						terminal_url: s.terminalUrl,
					};
				});
			const runningCount = sessions.filter((s) => s.running).length;
			const returnedCount = sessions.filter((s) => s.lifecycle !== undefined).length;
			const toolTimeUtc = nowUtcIso();
			const lines = sessions.length
				? sessions.map((s) => {
						const exited = s.running
							? ""
							: `  [exited${s.exit_code !== undefined && s.exit_code !== null ? ` exit_code=${s.exit_code}` : ""}${s.signal ? ` signal=${s.signal}` : ""}]`;
						const life = s.lifecycle ? `  [returned ${s.lifecycle.returned}; ${s.lifecycle.read ? "read" : "unread"}; ${s.lifecycle.phase}]` : "";
						const wake = s.wake_armed ? " [wake]" : "";
						const monitor = s.monitor ? ` [monitor ${s.monitor.returns}/${s.monitor.max_returns} ${watchLabel(s.monitor.watch)} remind_after=${formatElapsed(s.monitor.remind_after_ms)}]` : "";
						return `  ${String(s.session_id).padStart(3)}  ${JSON.stringify(s.title)}  pid=${String(s.pid ?? "?").padStart(6)}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}${monitor}  ${oneLineCommand(s.command, 60)}${exited}${life}\n        shell: ${sanitizeMeta(s.shell ?? "")}\n        log: ${s.log_path}${s.terminal_url ? `\n        terminal_url: ${s.terminal_url}` : ""}`;
					})
				: ["  (no terminals)"];
			const header = `unified-exec terminals (${runningCount} running, ${returnedCount} returned):`;
			return {
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, running_count: runningCount, returned_count: returnedCount, tool_time_utc: toolTimeUtc },
				structuredContent: listSessionsScriptResult({
					sessions,
					running_count: runningCount,
					returned_count: returnedCount,
					tool_time_utc: toolTimeUtc,
				}),
			};
		},
	} satisfies ToolDefinition<typeof listSessionsParameters> & { docTopics(): Readonly<Record<string, string>> });

	return {
		store: () => ctx.store,
		kill: async (id) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "human" });
			updateRunningSessionsUi(ctx);
			return outcome?.killed === true;
		},
	};
}

export default withHostPresentation(activate);
