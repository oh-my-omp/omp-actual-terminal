import { randomUUID } from "node:crypto";
import { constants as osConstants, tmpdir } from "node:os";
import { statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type AgentToolResult, type AgentToolUpdateCallback, type CustomTool, type ExtensionAPI, type ExtensionContext, type ImageAttachmentEntry, type SessionStopEvent, type SessionSwitchEvent, type Settings, type Skill, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import { Type } from "@oh-my-pi/omptype/typebox";

import { type AgentHost, type AgentIdentity, type ParkedRuntime, parkedRuntimes } from "./agent-park.ts";
import { createCompactNoticeSender, registerActualTerminalCompactHandoff } from "./compact-handoff-wiring.ts";
import { type ActivatedExtension, withHostPresentation } from "./omp-presentation.ts";
import {
	bashParameters, type BashSchema, DEFAULT_TERMINAL_YIELD_MS, MAX_PTY_COLS, MAX_PTY_ROWS, MAX_YIELD_TIME_MS, MIN_PTY_COLS, MIN_PTY_ROWS, MIN_YIELD_TIME_MS,
	parseBashCall, type TerminalRequest,
} from "./bash-tool.ts";
import type { NativeBash, SessionSeed, TerminalHost } from "./terminal-host.ts";
import {
	bashDocumentation, bashTerminalSection, bashTopicPointers,
	writeStdinDocumentation, writeStdinTopicPointers,
	setOnExitDocumentation, setOnExitTopicPointers,
	monitorDocumentation, monitorTopicPointers,
	killSessionDocumentation, killSessionTopicPointers,
	listSessionsDocumentation, listSessionsTopicPointers,
} from "./tool-docs.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "./session-binding.ts";
import { MonitorError, type MonitorWatchStatus } from "./monitor-subscription.ts";
import { loadInitFile, shellScript } from "./exec-init.ts";
import { noShellHost, type ShellHost } from "./shell-host.ts";
import { parseGraceReclaim, type PluginSettingsReader } from "./plugin-settings.ts";
import { DEFAULT_STOP_CONFIG, loadStopConfig, type StopConfig } from "./stop-config.ts";
import { detectStop, type StopHost } from "./stop-gate.ts";
import { screenJudge, type ScreenJudge } from "./screen-judge.ts";
import { renderStopConfigReason, renderStopReason } from "./stop-reasons.ts";
import { type LifecycleClock, type ReclaimResult, type ShellExit, TerminalLifecycle } from "./terminal-lifecycle.ts";
import { buildNoticeDisplayMessage, NoticeDispatcher, type NoticeGate, type NoticeMessage, outcomeText } from "./terminal-notice.ts";
import { getTerminalUrlRuntime, setTerminalUrlRuntime, type TerminalUrlRuntime } from "./terminal-url.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import { CompletionCoordinator, type OnExitPolicy, sanitizeMeta } from "./completion.ts";
import { formatElapsed, formatElapsedUi, nowUtcIso } from "./format-time.ts";
import { language, tr } from "./omomp-shared/i18n.ts";
import { readTodos } from "./omomp-shared/todo-read.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import type { MonitorScriptResult } from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { type JobHost, TerminalJob } from "./terminal-job.ts";
import { buildShellCommand, chooseShell, IS_WINDOWS, resolveBinary, resolveWindowsShell, type TerminalShell } from "./shell.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	terminalViewDetails,
	type FinalizeProcessInput,
	type ProcessOperation,
	type ProcessResultDetails,
} from "./tool-result.ts";
import { unescapeChars } from "./unescape.ts";


const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const JOB_ID_DESCRIPTION = "Job id (`bg_N`) from a `bash` call with `pty: true`.";
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const SHUTDOWN_TERM_GRACE_MS = 1000;
const SHUTDOWN_KILL_GRACE_MS = 500;
const MAX_SESSIONS = 64;
const WARNING_SESSIONS = 60;
const LRU_PROTECTED_COUNT = 8;
const OUTPUT_POLL_INTERVAL_MS = 250; // exec/input streaming updates
const INPUT_WAIT_QUIET_MS = 5_000;
const GROUP_PROBE_MS = 50;
const DEADLINE_KILL_GRACE_MS = 2000;
const SESSION_UI_KEY = "omp-actual-terminal.sessions";
/** How results name the session's own shell (omp's shell process, bash 5.3 syntax). */
const SESSION_SHELL_LABEL = "pi-shell (session)";


function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

function clampYield(ms: number | undefined, defaultMs: number): number {
	const v = typeof ms === "number" && !Number.isNaN(ms) ? ms : defaultMs;
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
	exitUnsubscribers: Map<string, () => void>;
	/** The jobs of terminals that have not returned yet, by job id. */
	jobs: Map<string, TerminalJob>;
	/**
	 * Membership is ownership: session_shutdown
	 * terminates these and removes them, so a terminal call whose session is
	 * no longer here after the grace must not insert it into the store.
	 */
	pendingSessions: Set<ExecSession>;
	shuttingDown: boolean;
	appearance: () => TerminalAppearance;
	terminalHost: TerminalHost;
	shellHost: ShellHost;
	invalidateGithubCache?: (command: string) => void;
	pluginSettings: PluginSettingsReader | undefined;
	host: RuntimeHost;
	agent: AgentIdentity | undefined;
}

type WriteStdinArgs = {
	job_id: string;
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

/** The calling session as a terminal launch reads it, captured when its `bash` call starts. */
interface CallingSession {
	readonly cwd: string;
	readonly sessionId: string | undefined;
	readonly sessionFile: string | undefined;
	readonly settings: Settings;
	readonly localProtocolOptions: ExtensionContext["localProtocolOptions"];
	/** The session's skills; undefined when the registry does not resolve the session, and omp then mounts the process's. */
	readonly skills: readonly Skill[] | undefined;
	readonly attachments: readonly ImageAttachmentEntry[];
	readonly bash: NativeBash;
	/** Where the session's terminals become omp jobs; undefined when the session is unbound or omp gives it no job manager. */
	readonly jobs: JobHost | undefined;
}

/** A located working directory: a host directory, or a URL directory only the session's shell can enter. */
type TerminalCwd =
	| { readonly kind: "host"; readonly path: string }
	| { readonly kind: "url"; readonly url: string };

async function expireSession(ctx: ExtensionCtx, session: ExecSession, seconds: number): Promise<void> {
	if (session.hasExited) return;
	ctx.lifecycle.noteDeadline(session.id, seconds);
	session.recordDeadline(seconds);
	session.kill("SIGTERM");
	await waitForExitOrDeadline({ exited: session.exited, durationMs: DEADLINE_KILL_GRACE_MS });
	if (!session.hasExited && !IS_WINDOWS) session.kill("SIGKILL");
}

async function runTerminal(
	ctx: ExtensionCtx,
	request: TerminalRequest,
	caller: CallingSession,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const finalizeResponse = (input: FinalizeInput): ResponseShape =>
		finalizeProcessResult({ ...input, operation: "bash" });
	if (ctx.shuttingDown) {
		throw new Error("omp-actual-terminal: session is shutting down; not starting new commands.");
	}
	const host = ctx.terminalHost;
	const urlCwd = request.cwd === undefined ? undefined : host.urlPath(request.cwd);
	const cwd: TerminalCwd = urlCwd !== undefined
		? { kind: "url", url: urlCwd }
		: { kind: "host", path: request.cwd === undefined ? caller.cwd : resolve(caller.cwd, request.cwd) };
	// A URL directory has no host path: the process starts in the session cwd and enters it.
	const hostCwd = cwd.kind === "host" ? cwd.path : caller.cwd;
	const shownCwd = cwd.kind === "host" ? cwd.path : cwd.url;
	const yieldTimeMs = request.detached ? 0 : clampYield(request.yieldTimeMs, DEFAULT_TERMINAL_YIELD_MS);
	const wantsWake = request.onExit === "wake";
	const setupFailure = (shell: string, failure: string): ResponseShape => finalizeResponse({
		wallTimeSec: 0,
		collected: NO_OUTPUT,
		jobId: undefined,
		exitCode: -1,
		signal: null,
		failure,
		logPath: undefined,
		cwd: shownCwd,
		shell,
		command: request.command,
		yieldTimeMs,
	});

	const chosen = chooseShell(request.shell, ctx.shellHost.isCmdShell);
	if (chosen.kind === "refused") {
		ctx.ui?.notify(
			tr(
				"omp-actual-terminal: not launching cmd (from the shell argument); omit shell to run in the session's shell, or pass a bash executable path.",
				"omp-actual-terminal：不启动 cmd（来自 shell 参数）；省略 shell 以使用会话的 shell，或传入 bash 可执行文件路径。",
			),
			"warning",
		);
		return setupFailure(
			chosen.shell,
			`shell "${chosen.shell}" is not supported: omp-actual-terminal never launches cmd. Omit shell to run in the session's shell, or pass a bash executable path.`,
		);
	}
	const shell: TerminalShell = chosen.kind === "session"
		? chosen
		: {
			kind: "explicit",
			shell: /[\\/]/.test(chosen.shell)
				? resolve(hostCwd, chosen.shell)
				: IS_WINDOWS ? resolveWindowsShell(chosen.shell) : resolveBinary(chosen.shell),
		};
	const shellLabel = shell.kind === "session" ? SESSION_SHELL_LABEL : shell.shell;
	const jobHost = caller.jobs;
	if (jobHost === undefined) {
		return setupFailure(shellLabel, "every terminal is an omp job, and this session has no omp job manager (omp's agent registry does not resolve it, or omp gave it none); no terminal opened.");
	}

	const approval = caller.bash.approval({ command: request.command });
	const tier = typeof approval === "string" ? approval : approval.tier;
	const resolveContext: ResolveContext = {
		cwd: caller.cwd,
		settings: caller.settings,
		signal,
		sessionId: caller.sessionId,
		sessionFile: caller.sessionFile,
		localProtocolOptions: caller.localProtocolOptions,
		skills: caller.skills,
	};
	switch (cwd.kind) {
		case "host": {
			const problem = workdirProblem(cwd.path);
			if (problem) return setupFailure(shellLabel, problem);
			break;
		}
		case "url": {
			if (shell.kind === "explicit") {
				return setupFailure(shellLabel, `Working directory ${cwd.url} is a URL directory, which only the session's shell can enter. Omit shell, or pass a host directory.`);
			}
			const directory = await host.urlDirectory(cwd.url, resolveContext, tier);
			switch (directory.kind) {
				case "directory":
					break;
				case "missing":
					return setupFailure(shellLabel, `Working directory does not exist: ${cwd.url}`);
				case "not_directory":
					return setupFailure(shellLabel, `Working directory is not a directory: ${cwd.url}`);
				case "unavailable":
					return setupFailure(shellLabel, `Working directory ${cwd.url} is unavailable: ${directory.reason}`);
			}
			break;
		}
	}

	const script = shellScript(await loadInitFile(ctx.pluginSettings, caller.cwd), shell, request.command);
	if (script.kind === "unusable") return setupFailure(shellLabel, script.reason);

	let seed: SessionSeed;
	try {
		seed = await host.seed({ sessionId: caller.sessionId, cwd: hostCwd, settings: caller.settings, signal });
	} catch (error) {
		return setupFailure(shellLabel, `could not read the session shell's state: ${error instanceof Error ? error.message : String(error)}`);
	}
	const env = host.terminalEnv({
		...seed.env,
		PI_SESSION_ID: caller.sessionId ?? "",
		PI_SESSION_FILE: caller.sessionFile ?? "",
		PI_TOOL_CALL_ID: toolCallId,
	});
	let source: string | undefined;
	let command: readonly string[];
	if (shell.kind === "session") {
		const prelude = (await host.mounts(resolveContext, tier, caller.attachments)) + seed.script;
		if (prelude) {
			source = join(tmpdir(), `omp-actual-terminal-seed-${randomUUID()}.sh`);
			await writeFile(source, prelude, { mode: 0o600 });
		}
		command = host.shellProcess({ command: script.cmd, source, cwd: cwd.kind === "url" ? cwd.url : undefined });
	} else {
		command = buildShellCommand(shell.shell, script.cmd);
	}

	ctx.invalidateGithubCache?.(request.command);

	let spawned: ExecSession | undefined;
	let job: TerminalJob;
	try {
		job = TerminalJob.open(jobHost, {
			label: request.title,
			command: request.command,
			cwd: shownCwd,
			pids: () => spawned !== undefined && !spawned.hasExited && spawned.pid !== undefined ? [spawned.pid] : [],
			cancelled: () => {
				const target = spawned;
				if (target === undefined) return;
				if (ctx.store.get(target.id) !== target) {
					target.kill("SIGTERM");
					return;
				}
				void terminateSessionById(ctx, target.id, "SIGTERM", { kind: "human" }).then(() => updateRunningSessionsUi(ctx));
			},
			screen: () => spawned?.liveSnapshot(),
			settledScreen: () => spawned?.settledSnapshot() ?? Promise.resolve(undefined),
		});
	} catch (error) {
		if (source !== undefined) await rm(source, { force: true });
		return setupFailure(shellLabel, error instanceof Error ? error.message : String(error));
	}
	ctx.jobs.set(job.id, job);
	const session = ExecSession.spawn(job.id, {
		command,
		shell: shellLabel,
		cwd: hostCwd,
		env,
		cols: request.cols !== undefined ? clamp(Math.floor(request.cols), MIN_PTY_COLS, MAX_PTY_COLS) : undefined,
		rows: request.rows !== undefined ? clamp(Math.floor(request.rows), MIN_PTY_ROWS, MAX_PTY_ROWS) : undefined,
		displayCommand: request.command,
		title: request.title,
		appearance: ctx.appearance,
		inputWait: { quietMs: INPUT_WAIT_QUIET_MS, onAlert: (alert) => ctx.coordinator.alertInputWait(alert) },
	});
	spawned = session;
	session.onScreenChange(() => job.screenChanged());
	// The job ends when the terminal returns: its shell exits, or its terminal closes first.
	const settleJob = (exit: ShellExit): void => {
		if (ctx.jobs.get(job.id) === job) ctx.jobs.delete(job.id);
		job.returned(exit, session.failureMessage);
	};
	session.onShellExit(settleJob);
	session.onExit(() => settleJob(session.shellExit ?? { exitCode: session.exitCode, signal: session.signal }));
	// The shell process sources the prelude when it starts; the file goes with the terminal.
	if (source !== undefined) {
		const prelude = source;
		session.onExit(() => void rm(prelude, { force: true }));
	}

	if (session.failureMessage) {
		if (source !== undefined) await rm(source, { force: true });
		return finalizeResponse({
			wallTimeSec: 0,
			collected: NO_OUTPUT,
			jobId: undefined,
			exitCode: -1,
			signal: null,
			failure: session.failureMessage,
			logPath: undefined, // spawn failed — no log file
			cwd: shownCwd,
			shell: session.shell,
			command: request.command,
			yieldTimeMs,
		});
	}
	if (request.deadline.kind === "after") {
		const seconds = request.deadline.seconds;
		const timer = setTimeout(() => void expireSession(ctx, session, seconds), seconds * 1000);
		timer.unref?.();
		session.onExit(() => clearTimeout(timer));
	}

	ctx.pendingSessions.add(session);
	try {
		const start = Date.now();
		const earlyDeadline = start + EARLY_EXIT_GRACE_PERIOD_MS;
		if (!request.detached) await Promise.race([
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
				jobId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: session.failureMessage,
				logPath: session.logPath,
				cwd: shownCwd,
				shell: session.shell,
				command: request.command,
				yieldTimeMs,
				extra: {
					on_exit: request.onExit,
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
				jobId: undefined,
				exitCode: session.exitCode,
				signal: session.signal,
				failure: exited ? session.failureMessage : "terminated by session_shutdown; exit not confirmed",
				logPath: session.logPath,
				cwd: shownCwd,
				shell: session.shell,
				command: request.command,
				yieldTimeMs,
				extra: { on_exit: request.onExit, ...(exited ? {} : { status: "running" as const, running: true }) },
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
					`omp-actual-terminal: evicted session ${pruned.id} (LRU, over cap ${ctx.store.maxSessions})`,
					`omp-actual-terminal：已淘汰会话 ${pruned.id}（LRU，超过上限 ${ctx.store.maxSessions}）`,
				),
				"warning",
			);
		}
		if (count >= WARNING_SESSIONS) {
			ctx.ui?.notify(
				tr(
					`omp-actual-terminal: ${count}/${ctx.store.maxSessions} sessions open`,
					`omp-actual-terminal：已打开 ${count}/${ctx.store.maxSessions} 个会话`,
				),
				"warning",
			);
		}

		const monitor = request.notify === undefined ? undefined : await startNotifyMonitor(ctx, session, request.notify, signal);
		const deadlineMs = start + yieldTimeMs;
		const pollStream = startStreaming(session, "bash", onUpdate, deadlineMs, signal);
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
				jobId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				logPath: session.logPath,
				cwd: shownCwd,
				shell: session.shell,
				command: request.command,
				yieldTimeMs,
				extra: {
					on_exit: request.onExit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: heldOpenNote(session),
					monitor,
				},
			});
		}
		removeSession(ctx, session.id);
		return finalizeResponse({
			wallTimeSec: wallSec,
			collected,
			totalBytes: session.totalBytesSeen,
			jobId: undefined,
			exitCode: session.exitCode,
			signal: session.signal,
			failure: session.failureMessage,
			logPath: session.logPath,
			cwd: shownCwd,
			shell: session.shell,
			command: request.command,
			yieldTimeMs,
			extra: {
				on_exit: request.onExit,
				...(wantsWake ? { completion_delivery: "direct" as const, tool_time_utc: nowUtcIso() } : {}),
				monitor,
			},
		});
	} finally {
		ctx.pendingSessions.delete(session);
		if (ctx.store.get(session.id) !== session) void session.release();
	}
}

/** `notify` on a terminal call: a monitor with its regex as `condition` and every other option at its default. */
async function startNotifyMonitor(ctx: ExtensionCtx, session: ExecSession, condition: string, signal: AbortSignal | undefined): Promise<string> {
	try {
		const status = await ctx.coordinator.startMonitor(session, { condition }, signal);
		return `started ${watchLabel(status.watch)}`;
	} catch (error) {
		if (!(error instanceof MonitorError)) throw error;
		return `not started (${error.code}): ${error.message}`;
	}
}

function missingTerminalText(ctx: ExtensionCtx, jobId: string, text: string): string {
	const gone = ctx.lifecycle.reclaimed(jobId);
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
	const session = ctx.store.get(args.job_id);
	if (!writeBytes?.length) throw new EmptyPollRemovedError(session?.terminalUrl);
	if (!session) throw new Error(missingTerminalText(ctx, args.job_id, `unknown job_id: ${args.job_id}`));

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
					jobId: undefined,
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
		const pollStream = startStreaming(session, "write_stdin", onUpdate, deadlineMs, signal);
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
				jobId: undefined,
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
			jobId: session.id,
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
	sid: string,
	initial: NodeJS.Signals,
	origin: TerminateOrigin,
): Promise<TerminateOutcome | undefined> {
	if (origin.kind !== "human") ctx.coordinator.cancelMonitor(sid);
	const session = ctx.store.get(sid);
	if (!session) return undefined;
	// The model or a person ends it: once it returns, its job shows cancelled, not as a failure of the command.
	if (origin.kind !== "reclaim") ctx.jobs.get(sid)?.cancel();
	// Explicit kill: suppress the wake BEFORE signaling so the induced exit can
	// never race a wake enqueue, and mark the coming return as a normal ending.
	ctx.coordinator.suppress(sid);
	ctx.lifecycle.noteKill(sid);
	if (origin.kind === "human") ctx.coordinator.monitorEndReason(sid, "human_terminated");
	session.kill(initial);
	const escalated = await escalateUntilExit(session);
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
		ctx.jobs.get(sid)?.killFailed();
	}
	return { session, escalated, collected, killed };
}

/** After a terminal was signalled: wait for its exit, SIGKILL it if it does not exit, and report whether it took SIGKILL. */
async function escalateUntilExit(session: ExecSession): Promise<boolean> {
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 2000 });
	if (session.hasExited || IS_WINDOWS) return false;
	session.kill("SIGKILL");
	await waitForExitOrDeadline({ exited: session.exited, durationMs: 500 });
	return true;
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
		.sort((a, b) => a.startedAt - b.startedAt);
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
			`⚠ omp-actual-terminal: ${sessions.length} ${sessionWord(sessions.length)} still running`,
			`⚠ omp-actual-terminal：${sessions.length} 个会话仍在运行`,
		),
		...shown.map((s) => {
			const wake = ctx.coordinator.isArmed(s.id) ? tr(" [wake]", " [已唤醒]") : "";
			const held = s.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
			const elapsed = formatElapsedUi(now - s.startedAt);
			return tr(
				`  ${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)} (${s.cwd})`,
				`  ${s.id} ${elapsed}${wake}${held} ${oneLineCommand(s.title, 40)} — ${oneLineCommand(s.displayCommand, 60)}（${s.cwd}）`,
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
			`omp-actual-terminal: ${sessions.length} ${sessionWord(sessions.length)} running`,
			`omp-actual-terminal：${sessions.length} 个会话正在运行`,
		)
		: undefined;
	ui.setStatus(SESSION_UI_KEY, status);

	if (opts.notifyTree && sessions.length > 0) {
		ui.notify(
			tr(
				`omp-actual-terminal: ${sessions.length} ${sessionWord(sessions.length)} still running after /tree.`,
				`omp-actual-terminal：/tree 后仍有 ${sessions.length} 个会话在运行。`,
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

function unwatchSessionExit(ctx: ExtensionCtx, id: string): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

function removeSession(ctx: ExtensionCtx, id: string): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

function buildStreamUpdate(session: ExecSession, operation: ProcessOperation): AgentToolResult<ProcessUpdateDetails> {
	const snapshot = session.liveSnapshot();
	const text = snapshot ? sanitizeOutputText(snapshot.text) : "";
	return {
		content: [{ type: "text", text }],
		details: {
			operation,
			job_id: session.id,
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
	operation: ProcessOperation,
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
				onUpdate(buildStreamUpdate(session, operation));
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
	readonly terminalHost: TerminalHost;
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
					`omp-actual-terminal: failed to deliver a terminal notice: ${err instanceof Error ? err.message : String(err)}`,
					`omp-actual-terminal：终端通知投递失败：${err instanceof Error ? err.message : String(err)}`,
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
				if (reason !== "lru") return;
				const job = ctx.jobs.get(session.id);
				job?.cancel();
				if (session.hasExited) return;
				coordinator.monitorEndReason(session.id, "lru_terminated");
				// The store sends SIGTERM next; a terminal that outlives SIGKILL keeps its job running.
				void escalateUntilExit(session).then(() => {
					if (!session.hasExited) job?.killFailed();
				});
			},
		}),
		ui: undefined,
		widgetVisible: false,
		exitUnsubscribers: new Map(),
		jobs: new Map(),
		pendingSessions: new Set(),
		shuttingDown: false,
		appearance: opts.appearance,
		terminalHost: opts.terminalHost,
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

async function endRuntime(ctx: ExtensionCtx, opts: { notifyShutdown?: boolean } = {}): Promise<void> {
	const notifyShutdown = opts.notifyShutdown ?? true;
	ctx.host = { kind: "ended" };
	ctx.shuttingDown = true;
	// Cancel lifecycle sweeps, wake timers/listeners and pending notices
	// first: these kills create no notices, and no stale prompt may ever be
	// injected into a new or closed session.
	ctx.lifecycle.shutdown();
	ctx.coordinator.shutdown();
	ctx.notices.stop();
	// The plugin ends these terminals: their jobs show cancelled.
	for (const job of ctx.jobs.values()) job.cancel();
	ctx.jobs.clear();
	const drained = ctx.store.terminateAll();
	for (const s of ctx.pendingSessions) {
		void s.releaseForShutdown();
		if (!s.hasExited) {
			s.terminate();
			drained.push(s);
		}
	}
	// The ending now owns these: their bash call must not insert them into
	// the store once its grace ends (the store belongs to this ended period).
	ctx.pendingSessions.clear();
	clearSessionExitWatchers(ctx);
	if (notifyShutdown) updateRunningSessionsUi(ctx);
	// Children run detached (own process groups), so anything that ignores
	// SIGTERM would outlive pi as an orphan.
	await Promise.all(drained.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_TERM_GRACE_MS })));
	if (!IS_WINDOWS) {
		const survivors = drained.filter((s) => !s.hasExited);
		for (const s of survivors) s.kill("SIGKILL");
		await Promise.all(survivors.map((s) => waitForExitOrDeadline({ exited: s.exited, durationMs: SHUTDOWN_KILL_GRACE_MS })));
	}
	if (notifyShutdown && drained.length && ctx.ui) {
		const leftover = drained.filter((s) => !s.hasExited).length;
		ctx.ui.notify(
			tr(
				`omp-actual-terminal: terminated ${drained.length - leftover} live session(s) on shutdown${leftover ? `; ${leftover} did not confirm exit` : ""}`,
				`omp-actual-terminal：关机时终止了 ${drained.length - leftover} 个活动会话${leftover ? `；${leftover} 个会话未确认退出` : ""}`,
			),
			leftover ? "warning" : "info",
		);
	}
}

function isDifferentSession(event: SessionSwitchEvent, eventCtx: ExtensionContext): boolean {
	if (event.reason !== "resume") return true;
	const prev = event.previousSessionFile;
	const curr = eventCtx.sessionManager?.getSessionFile?.();
	if (prev && curr && resolve(prev) === resolve(curr)) return false;
	return true;
}

function resolveSessionTarget(runtime: ExtensionCtx, target: string): { jobId: string; session: ExecSession | undefined } {
	const direct = runtime.store.get(target);
	if (direct) return { jobId: direct.id, session: direct };
	const needle = `term://${target}`;
	for (const candidate of runtime.store.values()) {
		if (candidate.terminalUrl === needle) return { jobId: candidate.id, session: candidate };
	}
	return { jobId: target, session: undefined };
}

function noSuchTerminal(runtime: ExtensionCtx, jobId: string, target: string): Error {
	return new Error(missingTerminalText(runtime, jobId, `No such terminal: ${target}`));
}

function createTerminalUrlRuntime(getCtx: () => ExtensionCtx): TerminalUrlRuntime {
	return {
		listSessions: () => {
			const runtime = getCtx();
			for (const s of runtime.store.values()) if (s.hasExited) runtime.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(runtime);
			const now = Date.now();
			const stored = runtime.store.values().sort((a, b) => a.startedAt - b.startedAt);
			const runningCount = stored.filter((s) => !s.hasExited).length;
			const exitedCount = stored.length - runningCount;
			const header = `Active terminals (${runningCount} running, ${exitedCount} exited):`;
			if (stored.length === 0) return `${header}\n  (no terminals)`;
			const lines = stored.map((s) => {
				const life = runtime.lifecycle.status(s.id);
				const elapsed = `${((now - s.startedAt) / 1000).toFixed(1)}s`;
				const status = s.hasExited
					? `exited${s.exitCode !== null ? ` exit_code=${s.exitCode}` : ""}${s.signal ? ` signal=${s.signal}` : ""}`
					: "running";
				const lifeTag = life ? ` [returned ${outcomeText(life.outcome)}; ${life.read ? "read" : "unread"}; ${life.phase}]` : "";
				const wake = runtime.coordinator.isArmed(s.id) ? " [wake]" : "";
				const mon = runtime.coordinator.monitorStatus(s.id);
				const monitor = mon ? ` [monitor ${mon.returns}/${mon.max_returns} ${watchLabel(mon.watch)}]` : "";
				const urlPart = s.terminalUrl ? ` url=${s.terminalUrl}` : "";
				return `  job_id=${s.id} ${JSON.stringify(s.title)} [${status}] pid=${s.pid ?? "?"} ${elapsed}${wake}${monitor}${lifeTag}${urlPart} cmd=${JSON.stringify(oneLineCommand(s.displayCommand, 60))} log=${s.logPath}`;
			});
			return `${header}\n${lines.join("\n")}`;
		},
		resolveSessionKey: (jobId) => {
			const url = getCtx().store.get(jobId)?.terminalUrl;
			return url?.startsWith("term://") ? url.slice("term://".length) : undefined;
		},
		writeStdin: async (target, content, toolCallId, signal) => {
			const runtime = getCtx();
			const { jobId, session } = resolveSessionTarget(runtime, target);
			if (!session) throw noSuchTerminal(runtime, jobId, target);
			const data = content.endsWith("\n") || content.endsWith("\r") ? content : `${content}\r`;
			const synthetic = toolCallId === undefined;
			const callId = toolCallId ?? `write-term-${jobId}-${Date.now()}`;
			const shape = await runWriteStdin(
				runtime,
				{ job_id: jobId, chars_b64: Buffer.from(data, "utf8").toString("base64") },
				signal,
				undefined,
				callId,
			);
			const isErr = (shape.exit_code != null && shape.exit_code !== 0) || shape.signal != null || shape.failure_message != null;
			if (synthetic) {
				runtime.lifecycle.commitToolReads(callId, isErr);
				runtime.coordinator.handleToolExecutionEnd(callId, isErr);
			}
			updateRunningSessionsUi(runtime);
			return { text: renderProcessResultText(shape), isError: isErr };
		},
		killSession: async (target, rawSignal, toolCallId) => {
			const runtime = getCtx();
			const { jobId, session: resolved } = resolveSessionTarget(runtime, target);
			if (!resolved) throw noSuchTerminal(runtime, jobId, target);
			const initial = normalizeSignal(rawSignal);
			const startedAt = Date.now();
			const synthetic = toolCallId === undefined;
			const callId = toolCallId ?? `kill-term-${jobId}-${Date.now()}`;
			const outcome = await terminateSessionById(runtime, jobId, initial, { kind: "model", toolCallId: callId });
			if (!outcome) throw noSuchTerminal(runtime, jobId, target);
			const { session, escalated, collected, killed } = outcome;
			if (synthetic) {
				runtime.lifecycle.commitToolReads(callId, !killed);
				runtime.coordinator.handleToolExecutionEnd(callId, !killed);
			}
			updateRunningSessionsUi(runtime);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							`the terminal remains registered — retry write term://${jobId}/kill or check permissions`,
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				jobId,
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
			const runtime = getCtx();
			const { jobId, session } = resolveSessionTarget(runtime, target);
			if (policy === "wake" && !session) throw noSuchTerminal(runtime, jobId, target);
			const status = runtime.coordinator.setOnExit(jobId, policy, session);
			if (!session && status === "already_none") throw noSuchTerminal(runtime, jobId, target);
			updateRunningSessionsUi(runtime);
			const running = session ? !session.hasExited : false;
			const armed = runtime.coordinator.isArmed(jobId);
			return (
				`on_exit job_id=${jobId} policy=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no stored terminal; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed")
			);
		},
		cancelMonitor: (target) => {
			const runtime = getCtx();
			const { jobId, session } = resolveSessionTarget(runtime, target);
			if (!session && !runtime.coordinator.monitorStatus(jobId)) throw noSuchTerminal(runtime, jobId, target);
			const cancelled = runtime.coordinator.cancelMonitor(jobId);
			updateRunningSessionsUi(runtime);
			return JSON.stringify({ job_id: jobId, status: cancelled ? "cancelled" : "not_monitored" });
		},
	};
}

export function activate(
	pi: ExtensionAPI,
	appearance: () => TerminalAppearance = () => "dark",
	terminalHost: TerminalHost,
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
	let activeSessionManager: ExtensionContext["sessionManager"] | undefined;
	let cachedStopConfig: StopConfig = DEFAULT_STOP_CONFIG;
	const reportedConfigProblems = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (reportedConfigProblems.has(key)) return;
		reportedConfigProblems.add(key);
		ctx.ui?.notify(message, "warning");
	};
	const refreshStopConfig = async (cwd: string | undefined): Promise<void> => {
		if (!stopHost || !pluginSettings) return;
		const load = await loadStopConfig(pluginSettings, cwd ?? "/");
		for (const problem of load.problems) {
			const reason = renderStopConfigReason(problem.reason, language());
			warnOnce(
				`${problem.path}\n${JSON.stringify(problem.reason)}`,
				tr(`omp-actual-terminal: ignoring ${problem.path}: ${reason}`, `omp-actual-terminal：忽略 ${problem.path}：${reason}`),
			);
		}
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
		tracked: (jobId) => ctx.lifecycle.isTracked(jobId),
		verdict: (verdict) => {
			switch (verdict.kind) {
				case "done":
					ctx.ui?.notify(
						tr(
							`omp-actual-terminal: the agent's work is done (${verdict.detector}); returned terminals reclaimed, their notices dropped`,
							`omp-actual-terminal：判定 agent 已完成（${verdict.detector}）；已回收返回的终端并丢弃其通知`,
						),
						"info",
					);
					return;
				case "not_done":
					return;
				case "undecided":
					if (verdict.cause === "failed") {
						const reason = renderStopReason(verdict.reason, language());
						ctx.ui?.notify(tr(`omp-actual-terminal: stop decision failed: ${reason}`, `omp-actual-terminal：完成判定失败：${reason}`), "warning");
					}
					return;
			}
		},
	};
	const compactNoticeSender = createCompactNoticeSender({
		sendImmediate: (message) => {
			pi.sendMessage(
				{ customType: "omp-actual-terminal-notice", content: message.content, display: true, details: message.details },
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
			let stored: Readonly<Record<string, unknown>> = {};
			if (pluginSettings) {
				try {
					stored = await pluginSettings(hostCwd ?? "/");
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					warnOnce(`plugin-settings\n${reason}`, tr(
						`omp-actual-terminal: could not read plugin settings, using defaults: ${reason}`,
						`omp-actual-terminal：无法读取插件设置，改用默认值：${reason}`,
					));
				}
			}
			const read = parseGraceReclaim(stored);
			if (read.kind === "ok") return read.value;
			warnOnce(`plugin-setting\n${read.key}`, tr(
				`omp-actual-terminal: plugin setting ${read.key} must be true or false; using ${read.fallback}`,
				`omp-actual-terminal：插件设置 ${read.key} 必须为 true 或 false；改用 ${read.fallback}`,
			));
			return read.fallback;
		},
	};
	const parked = parkedRuntimes<ExtensionCtx>();
	const runtimeOptions: RuntimeOptions = {
		attachment, agentHost, lifecycleClock, appearance, terminalHost, shellHost, invalidateGithubCache, pluginSettings,
	};
	let ctx = createRuntime(runtimeOptions);
	const currentRuntime = (): ExtensionCtx => ctx;
	registerActualTerminalCompactHandoff(pi, () => ctx.store);
	const urlRuntime = createTerminalUrlRuntime(currentRuntime);
	setTerminalUrlRuntime(urlRuntime);
	pi.registerMessageRenderer("omp-actual-terminal-notice", (message) => buildNoticeDisplayMessage(message.details));

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

	const startSession = async (eventCtx: ExtensionContext, opts: { resumeParked: boolean }): Promise<void> => {
		hostCwd = eventCtx.cwd;
		activeSessionManager = eventCtx.sessionManager;
		agentId = bindingContext(eventCtx).agentId;
		const agent = agentHost && agentId !== undefined ? agentHost.identify(agentId) : undefined;
		const resumed = opts.resumeParked && agent ? parked.take(agent.generation) : undefined;
		let previous: ExtensionCtx | undefined;
		if (resumed) {
			ctx = resumed;
		} else {
			compactNoticeSender.clearQueued();
			previous = ctx;
			previous.ui = undefined;
			ctx = createRuntime(runtimeOptions);
			ctx.agent = agent;
		}
		setTerminalUrlRuntime(urlRuntime);
		ctx.host = attachment;
		ctx.ui = eventCtx.ui;
		await refreshStopConfig(hostCwd);
		updateRunningSessionsUi(ctx);
		if (previous && !previous.shuttingDown) {
			await endRuntime(previous, { notifyShutdown: false });
		}
	};

	pi.on("session_start", async (_event, eventCtx) => {
		if (binding.kind === "pending") binding = bindSession(terminalHost, bindingContext(eventCtx));
		await startSession(eventCtx, { resumeParked: true });
	});

	const rebind = async (eventCtx: ExtensionContext): Promise<void> => {
		hostCwd = eventCtx.cwd;
		activeSessionManager = eventCtx.sessionManager;
		compactNoticeSender.clearQueued();
		binding = recheckBinding(binding, bindingContext(eventCtx));
		ctx.notices.forgetResponse();
		await refreshStopConfig(hostCwd);
	};
	pi.on("session_switch", async (event, eventCtx) => {
		await rebind(eventCtx);
		if (isDifferentSession(event, eventCtx)) {
			await startSession(eventCtx, { resumeParked: false });
		}
	});
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

	// A session the registry resolves reads its own settings; one it does not, the process settings.
	const sessionSettings = (): Settings => (binding.kind === "bound" ? binding.session.settings : terminalHost.settings);
	// `formatApprovalDetails` is a member of the tool omp builds from this definition, not of
	// `ToolDefinition`; omp's tool proxy reads it from here.
	const bashTool = {
		name: "bash",
		...bashDocumentation,
		label: "Bash",
		get description(): string {
			return terminalHost.bash(sessionSettings()).description + bashTerminalSection + bashTopicPointers;
		},
		get parameters(): BashSchema {
			return bashParameters(terminalHost.servicesEnabled(sessionSettings()));
		},
		// omp's own bash judges every call, terminal or not: the same patterns, env allowlist and interceptor.
		approval: (args, context) => terminalHost.bash(sessionSettings()).approval(args, context),
		formatApprovalDetails: (args) => terminalHost.bash(sessionSettings()).formatApprovalDetails(args),
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const call = parseBashCall(params);
			switch (call.kind) {
				case "native": {
					const invoke = eventCtx.invokeTool;
					if (invoke === undefined) {
						throw new Error("omp-actual-terminal: omp passed the bash call no ctx.invokeTool; requalify src/index.ts for this omp version");
					}
					return invoke(call.params);
				}
				case "terminal": {
					const settings = sessionSettings();
					const bound = binding.kind === "bound" ? binding.session : undefined;
					const shape = await runTerminal(ctx, call.request, {
						cwd: eventCtx.cwd,
						sessionId: eventCtx.sessionManager.getSessionId(),
						sessionFile: eventCtx.sessionManager.getSessionFile(),
						settings,
						localProtocolOptions: eventCtx.localProtocolOptions,
						skills: bound?.skills,
						attachments: bound?.getImageAttachments() ?? [],
						bash: terminalHost.bash(settings),
						jobs: binding.kind === "bound" && binding.session.asyncJobManager !== undefined
							? { manager: binding.session.asyncJobManager, ownerId: binding.rootAgentId }
							: undefined,
					}, signal, onUpdate, toolCallId);
					updateRunningSessionsUi(ctx);
					return {
						content: [{ type: "text", text: renderProcessResultText(shape) }],
						details: shape,
					};
				}
			}
		},
	} satisfies ToolDefinition<BashSchema> & Pick<CustomTool, "formatApprovalDetails"> & { docTopics(): Readonly<Record<string, string>> };
	pi.registerTool(bashTool);

	const writeStdinParameters = Type.Object({
		job_id: Type.String({ description: JOB_ID_DESCRIPTION }),
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
			"Send input to a running terminal; returns output like a bash pty call." +
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
	} satisfies ToolDefinition<typeof writeStdinParameters> & { docTopics(): Readonly<Record<string, string>> });

	const setOnExitParameters = Type.Object({
		job_id: Type.String({ description: JOB_ID_DESCRIPTION }),
		on_exit: Type.Enum(["none", "wake"], {
			description: '"none": disarm (also after eviction) as soon as auto-resume is unwanted. "wake": arm auto-resume while running, only when the human explicitly asked.',
		}),
	});
	pi.registerTool({
		name: "set_on_exit",
		...setOnExitDocumentation,
		label: tr("Set exit wake", "设置退出唤醒"),
		description:
			"Change a terminal's on_exit policy without stopping the process." + setOnExitTopicPointers,
		parameters: setOnExitParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const { job_id: jobId, on_exit: policy } = params;
			const session = ctx.store.get(jobId);
			if (policy === "wake" && !session) {
				return {
					content: [{ type: "text", text: missingTerminalText(ctx, jobId, `No such terminal: ${jobId}`) }],
					details: { job_id: jobId, found: false },
				};
			}
			const status = ctx.coordinator.setOnExit(jobId, policy, session);
			if (!session && status === "already_none") {
				return {
					content: [{ type: "text", text: missingTerminalText(ctx, jobId, `No such terminal: ${jobId}`) }],
					details: { job_id: jobId, found: false },
				};
			}
			const running = session ? !session.hasExited : false;
			const armed = ctx.coordinator.isArmed(jobId);
			const text =
				`set_on_exit job_id=${jobId} on_exit=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no stored terminal; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed");
			return {
				content: [{ type: "text", text }],
				details: {
					job_id: jobId,
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
		job_id: Type.String({ description: JOB_ID_DESCRIPTION }),
		action: Type.Optional(Type.Enum(["start", "cancel"], { description: "start (default) establishes or replaces; cancel removes silently." })),
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
			"Wait for a running terminal's future output: each batch matching condition or each new screen the judge finds meets your intent wakes you; with neither, its end wakes you once." +
			monitorTopicPointers,
		parameters: monitorParameters,
		async execute(_toolCallId, params, signal) {
			let details: MonitorScriptResult;
			try {
				if (params.action === "cancel") {
					details = { job_id: params.job_id, status: ctx.coordinator.cancelMonitor(params.job_id) ? "cancelled" : "not_monitored" };
				} else {
					const session = ctx.store.get(params.job_id);
					if (!session) throw new MonitorError("unknown_job", missingTerminalText(ctx, params.job_id, `No such terminal: ${params.job_id}`));
					const monitor = await ctx.coordinator.startMonitor(session, {
						condition: params.condition, judge: params.judge, judgeIntervalMs: params.judge_interval_ms,
						maxReturns: params.max_returns, remindAfterMs: params.remind_after_ms,
					}, signal);
					details = { job_id: params.job_id, status: "started", monitor };
				}
			} catch (error) {
				if (!(error instanceof MonitorError)) throw error;
				details = { job_id: params.job_id, status: "error", code: error.code, message: error.message };
			}
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
				...(details.status === "error" ? { isError: true } : {}),
			};
		},
	} satisfies ToolDefinition<typeof monitorParameters> & { docTopics(): Readonly<Record<string, string>> });

	const killSessionParameters = Type.Object({
		job_id: Type.String({ description: JOB_ID_DESCRIPTION }),
		signal: Type.Optional(Type.String({
			description: 'Initial signal (default "SIGTERM"). Examples: SIGINT, SIGHUP, SIGKILL.',
		})),
	});
	pi.registerTool({
		name: "kill_session",
		...killSessionDocumentation,
		label: tr("Terminate session", "结束会话"),
		description:
			"Terminate a terminal: SIGTERM, then SIGKILL after 2 s; on Windows any signal force-kills the process tree." +
			killSessionTopicPointers,
		parameters: killSessionParameters,
		async execute(toolCallId, params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			const sid = params.job_id;
			const initial = normalizeSignal(params.signal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(ctx, sid, initial, { kind: "model", toolCallId });
			if (!outcome) {
				return {
					content: [{ type: "text", text: missingTerminalText(ctx, sid, `No such terminal: ${sid}`) }],
					details: {
						operation: "kill_session",
						status: "kill_failed",
						running: false,
						job_id: sid,
						found: false,
					} as const,
				};
			}
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(ctx);
			const killFailure = killed
				? session.failureMessage
				: [
						`process still running after ${initial}${escalated ? " and SIGKILL escalation" : ""}; ` +
							"the terminal remains registered — retry kill_session or check permissions",
						session.failureMessage,
					]
					.filter((value): value is string => Boolean(value))
					.join("; ");
			const details = finalizeKillResult({
				wallTimeSec: (Date.now() - startedAt) / 1000,
				collected,
				totalBytes: session.totalBytesSeen,
				jobId: sid,
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
			};
		},
	} satisfies ToolDefinition<typeof killSessionParameters> & { docTopics(): Readonly<Record<string, string>> });

	const listSessionsParameters = Type.Object({});
	pi.registerTool({
		name: "list_sessions",
		...listSessionsDocumentation,
		label: tr("List sessions", "列出会话"),
		description: "List this omp run's omp-actual-terminal terminals: running ones, and returned ones not yet reclaimed, with their titles and lifecycle state." + listSessionsTopicPointers,
		parameters: listSessionsParameters,
		async execute(_toolCallId, _params, _signal, _onUpdate, eventCtx) {
			ctx.ui ??= eventCtx.ui;
			for (const s of ctx.store.values()) if (s.hasExited) ctx.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(ctx);
			const now = Date.now();
			const stored = ctx.store.values();
			const sessions = stored
				.sort((a, b) => a.startedAt - b.startedAt)
				.map((s) => {
					const life = ctx.lifecycle.status(s.id);
					return {
						job_id: s.id,
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
						return `  ${s.job_id.padStart(6)}  ${JSON.stringify(s.title)}  pid=${String(s.pid ?? "?").padStart(6)}  ${((s.elapsed_ms / 1000).toFixed(1) + "s").padStart(8)}${wake}${monitor}  ${oneLineCommand(s.command, 60)}${exited}${life}\n        shell: ${sanitizeMeta(s.shell ?? "")}\n        log: ${s.log_path}${s.terminal_url ? `\n        terminal_url: ${s.terminal_url}` : ""}`;
					})
				: ["  (no terminals)"];
			const header = `omp-actual-terminal terminals (${runningCount} running, ${returnedCount} returned):`;
			return {
				content: [{ type: "text", text: `${header}\n${lines.join("\n")}\ntool_time_utc: ${toolTimeUtc}` }],
				details: { sessions, running_count: runningCount, returned_count: returnedCount, tool_time_utc: toolTimeUtc },
			};
		},
	} satisfies ToolDefinition<typeof listSessionsParameters> & { docTopics(): Readonly<Record<string, string>> });

	return {
		store: () => ctx.store,
		kill: async (id: string) => {
			const outcome = await terminateSessionById(ctx, id, "SIGTERM", { kind: "human" });
			updateRunningSessionsUi(ctx);
			return outcome?.killed === true;
		},
	};
}

export default withHostPresentation(activate);
