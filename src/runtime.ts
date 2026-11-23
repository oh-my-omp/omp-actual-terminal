import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import type { AgentHost, AgentIdentity, ParkedRuntime } from "../fork-features/agent-park.ts";
import { tr } from "../fork-features/omomp-shared/i18n.ts";
import type { PluginSettingsReader } from "../fork-features/plugin-settings.ts";
import type { ScreenJudge } from "../fork-features/screen-judge.ts";
import type { ShellHost } from "../fork-features/shell-host.ts";
import { type LifecycleClock, type ReclaimResult, TerminalLifecycle } from "../fork-features/terminal-lifecycle.ts";
import { NoticeDispatcher, type NoticeGate, type NoticeMessage, outcomeText } from "../fork-features/terminal-notice.ts";
import type { CollectResult } from "./collect.ts";
import { CompletionCoordinator } from "./completion.ts";
import { waitForExitOrDeadline } from "./long-wait.ts";
import { sleep } from "./notify.ts";
import type { ExecSession } from "./session.ts";
import { SessionStore } from "./session-store.ts";
import { updateRunningSessionsUi } from "./sessions-ui.ts";
import { IS_WINDOWS } from "./shell.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";

export const SHUTDOWN_TERM_GRACE_MS = 1000;
export const SHUTDOWN_KILL_GRACE_MS = 500;
const MAX_SESSIONS = 64;
const LRU_PROTECTED_COUNT = 8;
const GROUP_PROBE_MS = 50;

export type RuntimeHost =
	| {
		readonly kind: "attached";
		readonly send: (message: NoticeMessage) => void;
		readonly gate: NoticeGate | undefined;
		readonly judge: ScreenJudge | undefined;
		readonly graceReclaimNotice: () => Promise<boolean>;
	}
	| { readonly kind: "parked" }
	| { readonly kind: "ended" };

export interface ExtensionCtx extends ParkedRuntime {
	store: SessionStore;
	coordinator: CompletionCoordinator;
	notices: NoticeDispatcher;
	lifecycle: TerminalLifecycle;
	ui: ExtensionContext["ui"] | undefined;
	widgetVisible: boolean;
	exitUnsubscribers: Map<number, () => void>;
	pendingSessions: Set<ExecSession>;
	appearance: () => TerminalAppearance;
	shellPath?: () => string | undefined;
	shellHost: ShellHost;
	invalidateGithubCache?: (command: string) => void;
	pluginSettings: PluginSettingsReader | undefined;
	host: RuntimeHost;
	agent: AgentIdentity | undefined;
}

export interface RuntimeOptions {
	readonly attachment: RuntimeHost;
	readonly agentHost: AgentHost | undefined;
	readonly lifecycleClock: LifecycleClock;
	readonly appearance: () => TerminalAppearance;
	readonly shellPath: (() => string | undefined) | undefined;
	readonly shellHost: ShellHost;
	readonly invalidateGithubCache: ((command: string) => void) | undefined;
	readonly pluginSettings: PluginSettingsReader | undefined;
}

export interface TerminateOutcome {
	readonly session: ExecSession;
	readonly escalated: boolean;
	readonly collected: CollectResult;
	readonly killed: boolean;
}

export type TerminateOrigin =
	| { readonly kind: "model"; readonly toolCallId?: string }
	| { readonly kind: "human" }
	| { readonly kind: "reclaim" };

export function missingSessionText(ctx: ExtensionCtx, sid: number, text: string): string {
	const gone = ctx.lifecycle.reclaimed(sid);
	if (!gone) return text;
	const returned = gone.outcome ? `returned ${outcomeText(gone.outcome)} and ` : "";
	const where = gone.identity.terminalUrl ? `read ${gone.identity.terminalUrl} or log_path ${gone.identity.logPath}` : `read log_path ${gone.identity.logPath}`;
	return `${text}; it ${returned}was reclaimed: ${where}`;
}

export function noSuchSession(ctx: ExtensionCtx, sid: number, target: string): Error {
	const text = `No such session: ${target}`;
	return new Error(sid >= 0 ? missingSessionText(ctx, sid, text) : text);
}

export function watchSessionExit(ctx: ExtensionCtx, session: ExecSession): void {
	ctx.exitUnsubscribers.get(session.id)?.();
	const unsubscribe = session.onExit(() => {
		updateRunningSessionsUi(ctx);
	});
	ctx.exitUnsubscribers.set(session.id, unsubscribe);
}

export function unwatchSessionExit(ctx: ExtensionCtx, id: number): void {
	ctx.exitUnsubscribers.get(id)?.();
	ctx.exitUnsubscribers.delete(id);
}

export function removeSession(ctx: ExtensionCtx, id: number): ExecSession | undefined {
	unwatchSessionExit(ctx, id);
	return ctx.store.remove(id);
}

function clearSessionExitWatchers(ctx: ExtensionCtx): void {
	for (const unsubscribe of ctx.exitUnsubscribers.values()) {
		unsubscribe();
	}
	ctx.exitUnsubscribers.clear();
}

export async function terminateSessionById(
	ctx: ExtensionCtx,
	sid: number,
	initial: NodeJS.Signals,
	origin: TerminateOrigin,
): Promise<TerminateOutcome | undefined> {
	if (origin.kind !== "human") ctx.coordinator.cancelMonitor(sid);
	const session = ctx.store.get(sid);
	if (!session) return undefined;
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

export function createRuntime(opts: RuntimeOptions): ExtensionCtx {
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
	ctx.pendingSessions.clear();
	clearSessionExitWatchers(ctx);
	updateRunningSessionsUi(ctx);
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
