import { constants as osConstants } from "node:os";

import type { MonitorWatchStatus } from "../fork-features/monitor-subscription.ts";
import { outcomeText } from "../fork-features/terminal-notice.ts";
import type { TerminalUrlRuntime } from "../fork-features/terminal-url.ts";
import { sanitizeMeta } from "./completion.ts";
import { formatElapsed, nowUtcIso } from "./format-time.ts";
import { runWriteStdin } from "./pty-tools.ts";
import { type ExtensionCtx, noSuchSession, terminateSessionById } from "./runtime.ts";
import type { ExecSession } from "./session.ts";
import { oneLineCommand, updateRunningSessionsUi } from "./sessions-ui.ts";
import { finalizeKillResult, renderKillResultText, renderProcessResultText } from "./tool-result.ts";

const TERM_SCHEME = "term://";

function normalizeSignal(raw: string | undefined): NodeJS.Signals {
	if (!raw) return "SIGTERM";
	let name = raw.trim().toUpperCase();
	if (!name.startsWith("SIG")) name = `SIG${name}`;
	if (!(name in osConstants.signals)) {
		throw new Error(`unknown signal "${raw}" (use SIGTERM, SIGINT, SIGKILL, …)`);
	}
	return name as NodeJS.Signals;
}

function watchLabel(watch: MonitorWatchStatus): string {
	switch (watch.kind) {
		case "end": return "completion";
		case "regex": return `condition=${JSON.stringify(watch.condition)}`;
		case "judge": return `judge=${JSON.stringify(watch.intent)} every=${formatElapsed(watch.interval_ms)}`;
	}
}

interface SessionTarget {
	readonly sid: number;
	readonly session: ExecSession | undefined;
}

function resolveSessionTarget(ctx: ExtensionCtx, target: string): SessionTarget {
	if (/^\d+$/.test(target)) {
		const sid = Number(target);
		return { sid, session: ctx.store.get(sid) };
	}
	const byKey = ctx.store.values().find((s) => s.terminalUrl === `${TERM_SCHEME}${target}`);
	if (byKey) return { sid: byKey.id, session: byKey };
	const leadingId = /^(\d+)-/.exec(target);
	return { sid: leadingId ? Number(leadingId[1]) : -1, session: undefined };
}

function listingLine(ctx: ExtensionCtx, s: ExecSession, now: number): string {
	const life = ctx.lifecycle.status(s.id);
	const monitor = ctx.coordinator.monitorStatus(s.id);
	const key = s.terminalUrl?.startsWith(TERM_SCHEME) ? s.terminalUrl.slice(TERM_SCHEME.length) : undefined;
	const state = s.hasExited
		? `exited${s.exitCode !== null ? ` exit_code=${s.exitCode}` : ""}${s.signal ? ` signal=${s.signal}` : ""}`
		: "running";
	const lifeText = life ? `  [returned ${outcomeText(life.outcome)}; ${life.read ? "read" : "unread"}; ${life.phase}]` : "";
	const wakeText = ctx.coordinator.isArmed(s.id) ? " [wake]" : "";
	const monitorText = monitor
		? ` [monitor ${monitor.returns}/${monitor.max_returns} ${watchLabel(monitor.watch)} remind_after=${formatElapsed(monitor.remind_after_ms)}]`
		: "";
	return `  session_id=${s.id}  ${JSON.stringify(s.title)}  [${state}]  url=${TERM_SCHEME}${s.id}${key ? `  key=${key}` : ""}  pid=${s.pid ?? "?"}  ${((now - s.startedAt) / 1000).toFixed(1)}s${wakeText}${monitorText}  ${oneLineCommand(s.displayCommand, 60)}${lifeText}`
		+ `\n        shell: ${sanitizeMeta(s.shell ?? "")}`
		+ `\n        log: ${s.logPath}${s.terminalUrl ? `\n        terminal_url: ${s.terminalUrl}` : ""}`;
}

export function createTerminalUrlRuntime(ctx: () => ExtensionCtx): TerminalUrlRuntime {
	return {
		resolveSessionKey: (id) => ctx().store.get(id)?.terminalUrl?.slice(TERM_SCHEME.length),
		listSessions: () => {
			const runtime = ctx();
			for (const s of runtime.store.values()) if (s.hasExited) runtime.coordinator.observeViaListing(s.id);
			updateRunningSessionsUi(runtime);
			const now = Date.now();
			const sessions = runtime.store.values().sort((a, b) => a.id - b.id);
			const runningCount = sessions.filter((s) => !s.hasExited).length;
			const returnedCount = sessions.filter((s) => runtime.lifecycle.status(s.id) !== undefined).length;
			const lines = sessions.length ? sessions.map((s) => listingLine(runtime, s, now)) : ["  (no terminals)"];
			return `Active terminals (${runningCount} running, ${returnedCount} exited):\n${lines.join("\n")}\ntool_time_utc: ${nowUtcIso()}`;
		},
		writeStdin: async (target, content, toolCallId, signal) => {
			const runtime = ctx();
			const { sid, session } = resolveSessionTarget(runtime, target);
			if (!session) throw noSuchSession(runtime, sid, target);
			const data = /[\r\n]$/.test(content) ? content : `${content}\r`;
			const synthetic = toolCallId === undefined;
			const callId = toolCallId ?? `write-term-${sid}-${Date.now()}`;
			const shape = await runWriteStdin(runtime, { session_id: sid, text: data }, signal, undefined, callId);
			const isErr = (shape.exit_code != null && shape.exit_code !== 0) || shape.signal != null || shape.failure_message != null;
			if (synthetic) {
				runtime.lifecycle.commitToolReads(callId, isErr);
				runtime.coordinator.handleToolExecutionEnd(callId, isErr);
			}
			updateRunningSessionsUi(runtime);
			return { text: renderProcessResultText(shape), isError: isErr };
		},
		killSession: async (target, rawSignal, toolCallId) => {
			const runtime = ctx();
			const { sid, session: resolved } = resolveSessionTarget(runtime, target);
			if (!resolved) throw noSuchSession(runtime, sid, target);
			const initial = normalizeSignal(rawSignal);
			const startedAt = Date.now();
			const outcome = await terminateSessionById(runtime, sid, initial, { kind: "model", toolCallId });
			if (!outcome) throw noSuchSession(runtime, sid, target);
			const { session, escalated, collected, killed } = outcome;
			updateRunningSessionsUi(runtime);
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
			const runtime = ctx();
			const { sid, session } = resolveSessionTarget(runtime, target);
			if (sid < 0 || (policy === "wake" && !session)) throw noSuchSession(runtime, sid, target);
			const status = runtime.coordinator.setOnExit(sid, policy, session);
			if (!session && status === "already_none") throw noSuchSession(runtime, sid, target);
			updateRunningSessionsUi(runtime);
			const running = session ? !session.hasExited : false;
			const armed = runtime.coordinator.isArmed(sid);
			return (
				`on_exit session_id=${sid} policy=${policy} → ${status}` +
				(session ? (running ? " (process still running)" : " (process already exited)") : " (no store session; coordinator only)") +
				(armed ? "; wake armed" : "; wake not armed")
			);
		},
		cancelMonitor: (target) => {
			const runtime = ctx();
			const { sid, session } = resolveSessionTarget(runtime, target);
			if (sid < 0 || (!session && !runtime.coordinator.monitorStatus(sid))) throw noSuchSession(runtime, sid, target);
			const cancelled = runtime.coordinator.cancelMonitor(sid);
			updateRunningSessionsUi(runtime);
			return JSON.stringify({ session_id: sid, status: cancelled ? "cancelled" : "not_monitored" });
		},
	};
}
