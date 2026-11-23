import type { ExtensionAPI, ExtensionContext, SessionStopEvent } from "@oh-my-pi/pi-coding-agent";
import { Box, Text } from "@oh-my-pi/pi-tui";

import { parkedRuntimes } from "../fork-features/agent-park.ts";
import { createCompactNoticeSender, registerActualTerminalCompactHandoff } from "../fork-features/compact-handoff-wiring.ts";
import { language, tr } from "../fork-features/omomp-shared/i18n.ts";
import { readTodos } from "../fork-features/omomp-shared/todo-read.ts";
import { type ActivateDeps, type ActivatedExtension, withHostPresentation } from "../fork-features/omp-presentation.ts";
import { parseGraceReclaim } from "../fork-features/plugin-settings.ts";
import { screenJudge } from "../fork-features/screen-judge.ts";
import { bindingContext, bindSession, type HostBindingState, recheckBinding } from "../fork-features/session-binding.ts";
import { noShellHost } from "../fork-features/shell-host.ts";
import { DEFAULT_STOP_CONFIG, loadStopConfig, type StopConfig } from "../fork-features/stop-config.ts";
import { detectStop } from "../fork-features/stop-gate.ts";
import { renderStopConfigReason, renderStopReason } from "../fork-features/stop-reasons.ts";
import { buildNoticeDisplayMessage, type NoticeGate } from "../fork-features/terminal-notice.ts";
import { getTerminalUrlRuntime, initializeTerminalUrls, setTerminalUrlRuntime } from "../fork-features/terminal-url.ts";
import { registerPtyTools } from "./pty-tools.ts";
import { createRuntime, type ExtensionCtx, type RuntimeHost, terminateSessionById } from "./runtime.ts";
import { registerSessionsCommand } from "./sessions-command.ts";
import { runningSessions, updateRunningSessionsUi } from "./sessions-ui.ts";
import { createTerminalUrlRuntime } from "./terminal-url-runtime.ts";

function finalResponseText(event: SessionStopEvent): string | undefined {
	const message = event.last_assistant_message;
	if (message === undefined || !("content" in message)) return undefined;
	let text = "";
	if (typeof message.content === "string") text = message.content;
	else for (const block of message.content) if (block.type === "text") text += block.text;
	return text.trim() ? text : undefined;
}

export function activate(pi: ExtensionAPI, deps: ActivateDeps = {}): ActivatedExtension {
	const {
		appearance = () => "dark",
		shellPath,
		approvalHost,
		invalidateGithubCache,
		lifecycleClock = {},
		stopHost,
		pluginSettings,
		agentHost,
		shellHost = noShellHost,
	} = deps;
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
				tr(`unified-exec: ignoring ${problem.path}: ${reason}`, `unified-exec：忽略 ${problem.path}：${reason}`),
			);
		}
		cachedStopConfig = load.config;
	};
	const boundSession = () => (binding.kind === "bound" ? binding.session : undefined);
	const gate: NoticeGate | undefined = stopHost && {
		config: () => cachedStopConfig,
		detect: (config, input, signal) => detectStop({
			host: stopHost,
			session: boundSession,
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
		judge: stopHost && screenJudge(stopHost, boundSession),
		graceReclaimNotice: async () => {
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
	const currentRuntime = (): ExtensionCtx => ctx;
	registerActualTerminalCompactHandoff(pi, () => ctx.store);
	const urlRuntime = createTerminalUrlRuntime(currentRuntime);
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

	registerSessionsCommand(pi, currentRuntime);
	registerPtyTools(pi, { ctx: currentRuntime, approvalHost, binding: () => binding });

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
