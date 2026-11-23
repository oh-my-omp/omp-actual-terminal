import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Type, type TUnsafe } from "@oh-my-pi/omptype/typebox";

import { approvalCommand, approveBoundCommand, type CommandApprovalHost } from "../fork-features/command-approval.ts";
import {
	execCommandTopicPointers,
	monitorTopicPointers,
	registerExecCommandTopics,
	writeStdinTopicPointers,
} from "../fork-features/exec-command-docs.ts";
import { loadInitFile, shellScript } from "../fork-features/exec-init.ts";
import { MonitorError } from "../fork-features/monitor-subscription.ts";
import { tr } from "../fork-features/omomp-shared/i18n.ts";
import type { HostBindingState } from "../fork-features/session-binding.ts";
import { MAX_TITLE_CHARS, parseTerminalTitle } from "../fork-features/terminal-notice.ts";
import { type CollectResult, NO_OUTPUT } from "./collect.ts";
import type { OnExitPolicy } from "./completion.ts";
import { nowUtcIso } from "./format-time.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { DEFAULT_PTY_ROWS } from "./pty.ts";
import {
	type ExtensionCtx,
	missingSessionText,
	removeSession,
	SHUTDOWN_KILL_GRACE_MS,
	SHUTDOWN_TERM_GRACE_MS,
	unwatchSessionExit,
	watchSessionExit,
} from "./runtime.ts";
import type { MonitorScriptResult } from "./script-result.ts";
import { ExecSession } from "./session.ts";
import { updateRunningSessionsUi } from "./sessions-ui.ts";
import { IS_WINDOWS, type LaunchShell, resolveBinary, resolveDefaultShell, resolveWindowsShell, type ShellSource, shellArgv } from "./shell.ts";
import {
	type FinalizeProcessInput,
	finalizeProcessResult,
	type ProcessResultDetails,
	renderProcessResultText,
	terminalViewDetails,
} from "./tool-result.ts";

const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_MS = 250;
const EARLY_EXIT_GRACE_PERIOD_MS = 150;
const EARLY_EXIT_CLOCK_SLACK_MS = 20;
const WARNING_SESSIONS = 60;
const OUTPUT_POLL_INTERVAL_MS = 250;
const INPUT_WAIT_QUIET_MS = 5_000;
const MIN_PTY_COLS = 20;
const MAX_PTY_COLS = 500;
const MIN_PTY_ROWS = 5;
const MAX_PTY_ROWS = 300;

type ResponseShape = ProcessResultDetails;
type ProcessUpdateDetails = Partial<ProcessResultDetails> & { pid?: number; total_bytes?: number };
type ResultScope = Pick<FinalizeProcessInput, "operation" | "cwd" | "command" | "yieldTimeMs">;
type ResultOutcome = Omit<FinalizeProcessInput, keyof ResultScope>;

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

function resultIn(scope: ResultScope): (outcome: ResultOutcome) => ResponseShape {
	return (outcome) => finalizeProcessResult({ ...outcome, ...scope });
}

function sessionOutcome(
	session: ExecSession,
	collected: CollectResult,
	startedAt: number,
): Omit<ResultOutcome, "sessionId" | "extra"> {
	return {
		wallTimeSec: (Date.now() - startedAt) / 1000,
		collected,
		totalBytes: session.totalBytesSeen,
		exitCode: session.exitCode,
		signal: session.signal,
		failure: session.failureMessage,
		logPath: session.logPath,
		shell: session.shell,
	};
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

export class EmptyPollRemovedError extends Error {
	readonly code = "empty_poll_removed";

	constructor(terminalUrl: string | undefined) {
		super(`empty_poll_removed: write_stdin requires input bytes. Read state and content with read ${terminalUrl ?? "term://<key>"}; wait for output events or completion with monitor.`);
		this.name = "EmptyPollRemovedError";
	}
}

const textEncoder = new TextEncoder();

function resolveWriteInput(args: WriteStdinArgs): Uint8Array | undefined {
	const hasText = typeof args.text === "string" && args.text.length > 0;
	const hasEnter = args.enter === true;
	const hasSpecialKey = args.special_key !== undefined;
	const rawBase64 = args.raw_base64 ?? "";
	const hasB64 = rawBase64.length > 0;
	if (hasB64 && (hasText || hasEnter || hasSpecialKey)) {
		throw new Error("write_stdin: `raw_base64` cannot be combined with `text`, `enter`, or `special_key`.");
	}
	if (hasB64) {
		const b64 = rawBase64.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
			throw new Error("write_stdin: `raw_base64` is not valid base64.");
		}
		return new Uint8Array(Buffer.from(b64, "base64"));
	}
	const combined =
		(args.text ?? "") +
		(args.special_key !== undefined ? SPECIAL_KEY_BYTES[args.special_key] : "") +
		(hasEnter ? "\r" : "");
	return combined.length > 0 ? textEncoder.encode(combined) : undefined;
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
	if (ctx.host.kind === "ended") {
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
	const result = resultIn({ operation: "exec_command", cwd: effectiveCwd, command: args.cmd, yieldTimeMs });
	const setupFailure = (shell: string | undefined, failure: string): ResponseShape => result({
		wallTimeSec: 0,
		collected: NO_OUTPUT,
		sessionId: undefined,
		exitCode: -1,
		signal: null,
		failure,
		logPath: undefined,
		shell,
	});
	const directDelivery = (): Partial<ResponseShape> =>
		wantsWake ? { completion_delivery: "direct", tool_time_utc: nowUtcIso() } : {};
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

	if (session.failureMessage) return setupFailure(session.shell, session.failureMessage);

	ctx.pendingSessions.add(session);
	try {
		const start = Date.now();
		const exitSeen = Promise.withResolvers<void>();
		if (session.hasExited) exitSeen.resolve();
		else session.exited.addEventListener("abort", () => exitSeen.resolve(), { once: true });
		await Promise.race([exitSeen.promise, sleep(EARLY_EXIT_GRACE_PERIOD_MS, signal)]);

		if (session.hasExited && Date.now() <= start + EARLY_EXIT_GRACE_PERIOD_MS + EARLY_EXIT_CLOCK_SLACK_MS) {
			const collected = await session.collect({ deadlineMs: Date.now() + 500, externalAbort: signal });
			return result({
				...sessionOutcome(session, collected, start),
				sessionId: undefined,
				extra: { on_exit: args.on_exit, ...directDelivery() },
			});
		}
		if (!ctx.pendingSessions.has(session)) {
			await waitForExitOrDeadline({ exited: session.exited, durationMs: SHUTDOWN_TERM_GRACE_MS + SHUTDOWN_KILL_GRACE_MS });
			const exited = session.hasExited;
			const collected = exited ? await session.collect({ deadlineMs: Date.now() + 500 }) : NO_OUTPUT;
			return result({
				...sessionOutcome(session, collected, start),
				sessionId: undefined,
				failure: exited ? session.failureMessage : "terminated by session_shutdown; exit not confirmed",
				extra: { on_exit: args.on_exit, ...(exited ? {} : { status: "running" as const, running: true }) },
			});
		}

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

		const collected = await collectStreaming(session, onUpdate, start + yieldTimeMs, signal);
		session.touch();

		if (!session.hasExited) {
			if (wantsWake) ctx.coordinator.register(session);
			ctx.lifecycle.track(session);
			ctx.lifecycle.noteToolRead(toolCallId, session.id);
			return result({
				...sessionOutcome(session, collected, start),
				sessionId: session.id,
				exitCode: undefined,
				signal: null,
				failure: null,
				extra: {
					on_exit: args.on_exit,
					...(wantsWake ? { completion_notification: "armed" as const } : {}),
					tool_time_utc: nowUtcIso(),
					note: heldOpenNote(session),
				},
			});
		}
		removeSession(ctx, session.id);
		return result({
			...sessionOutcome(session, collected, start),
			sessionId: undefined,
			extra: { on_exit: args.on_exit, ...directDelivery() },
		});
	} finally {
		ctx.pendingSessions.delete(session);
		if (ctx.store.get(session.id) !== session) void session.release();
	}
}

export async function runWriteStdin(
	ctx: ExtensionCtx,
	args: WriteStdinArgs,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	toolCallId: string,
): Promise<ResponseShape> {
	const writeBytes = resolveWriteInput(args);
	const session = ctx.store.get(args.session_id);
	if (!writeBytes?.length) throw new EmptyPollRemovedError(session?.terminalUrl);
	if (!session) throw new Error(missingSessionText(ctx, args.session_id, `unknown session_id: ${args.session_id}`));

	const yieldTimeMs = clampYield(args.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_MS);
	const result = resultIn({ operation: "write_stdin", cwd: session.cwd, command: session.displayCommand, yieldTimeMs });
	const start = Date.now();
	const exitedResult = (collected: CollectResult, failure: string | null): ResponseShape => {
		const armed = ctx.coordinator.isArmed(session.id);
		ctx.lifecycle.noteToolRead(toolCallId, session.id);
		ctx.coordinator.markPendingTerminal(session.id, toolCallId);
		return result({
			...sessionOutcome(session, collected, start),
			sessionId: undefined,
			failure,
			extra: {
				completion_delivery: "direct",
				tool_time_utc: nowUtcIso(),
				...(armed ? { on_exit: "wake" as const, on_exit_wake: "consumed" as const } : {}),
			},
		});
	};
	session.touch();

	ctx.coordinator.beginObservation(session.id, toolCallId);
	try {
		const written = session.write(writeBytes);
		if (written) ctx.lifecycle.noteInput(session.id, writeBytes);
		else if (session.hasExited) {
			const collected = await session.collect({ deadlineMs: Date.now() + 50, externalAbort: signal });
			return exitedResult(collected, session.failureMessage);
		}
		const writeFailure = written ? null : "PTY write failed: the terminal no longer accepts input; bytes were not delivered";
		await sleep(100, signal);

		const collected = await collectStreaming(session, onUpdate, start + yieldTimeMs, signal);
		if (session.hasExited) return exitedResult(collected, session.failureMessage ?? writeFailure);

		const armed = ctx.coordinator.isArmed(session.id);
		ctx.coordinator.releaseObservation(session.id, toolCallId);
		ctx.lifecycle.noteToolRead(toolCallId, session.id);
		return result({
			...sessionOutcome(session, collected, start),
			sessionId: session.id,
			exitCode: undefined,
			signal: null,
			failure: writeFailure,
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
				sent = undefined;
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
			clearTimeout(timer);
		},
	};
}

async function collectStreaming(
	session: ExecSession,
	onUpdate: AgentToolUpdateCallback<ProcessUpdateDetails> | undefined,
	deadlineMs: number,
	externalAbort: AbortSignal | undefined,
): Promise<CollectResult> {
	const stream = startStreaming(session, onUpdate, deadlineMs, externalAbort);
	try {
		return await session.collect({ deadlineMs, externalAbort });
	} finally {
		stream.stop();
	}
}

export interface PtyToolsHost {
	readonly ctx: () => ExtensionCtx;
	readonly approvalHost: CommandApprovalHost | undefined;
	readonly binding: () => HostBindingState;
}

export function registerPtyTools(pi: ExtensionAPI, host: PtyToolsHost): void {
	registerExecCommand(pi, host);
	registerWriteStdin(pi, host.ctx);
	registerMonitor(pi, host.ctx);
}

function registerExecCommand(pi: ExtensionAPI, { ctx, approvalHost, binding }: PtyToolsHost): void {
	const parameters = Type.Object({
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

	const tool: ToolDefinition<typeof parameters> & {
		readonly docTopics: () => Record<string, string>;
	} = {
		name: "exec_command",
		label: tr("Execute command", "执行命令"),
		...(approvalHost ? {
			approval: (args: unknown) => approveBoundCommand(approvalHost, binding(), args),
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
		docTopics: registerExecCommandTopics(),
		parameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			const runtime = ctx();
			runtime.ui ??= eventCtx.ui;
			const shape = await runExecCommand(runtime, params, signal, onUpdate, eventCtx.cwd, toolCallId);
			updateRunningSessionsUi(runtime);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
	};
	pi.registerTool(tool);
}

function registerWriteStdin(pi: ExtensionAPI, ctx: () => ExtensionCtx): void {
	const parameters = Type.Object({
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
		parameters,
		async execute(toolCallId, params, signal, onUpdate, eventCtx) {
			const runtime = ctx();
			runtime.ui ??= eventCtx.ui;
			const shape = await runWriteStdin(runtime, params, signal, onUpdate, toolCallId);
			updateRunningSessionsUi(runtime);
			return {
				content: [{ type: "text", text: renderProcessResultText(shape) }],
				details: shape,
			};
		},
	} satisfies ToolDefinition<typeof parameters>);
}

function registerMonitor(pi: ExtensionAPI, ctx: () => ExtensionCtx): void {
	const parameters = Type.Object({
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
		parameters,
		async execute(_toolCallId, params, signal) {
			const runtime = ctx();
			let details: MonitorScriptResult;
			try {
				const session = runtime.store.get(params.session_id);
				if (!session) throw new MonitorError("unknown_session", missingSessionText(runtime, params.session_id, `No such session: ${params.session_id}`));
				const monitor = await runtime.coordinator.startMonitor(session, {
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
	} satisfies ToolDefinition<typeof parameters>);
}
