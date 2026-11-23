import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { tr } from "../fork-features/omomp-shared/i18n.ts";
import { type ExtensionCtx, terminateSessionById } from "./runtime.ts";
import { runningSessions, sessionLabel, sessionWord, updateRunningSessionsUi } from "./sessions-ui.ts";

export function registerSessionsCommand(pi: ExtensionAPI, ctx: () => ExtensionCtx): void {
	pi.registerCommand("unified-exec-sessions", {
		description: tr(
			"List live unified-exec sessions and optionally kill one (or all)",
			"列出正在运行的 unified-exec 会话，并可结束其中一个（或全部）",
		),
		handler: async (_args, cmdCtx) => {
			const runtime = ctx();
			runtime.ui = cmdCtx.ui;
			updateRunningSessionsUi(runtime);
			const sessions = runningSessions(runtime);
			if (sessions.length === 0) {
				cmdCtx.ui.notify(
					tr("unified-exec: no live sessions", "unified-exec：没有正在运行的会话"),
					"info",
				);
				return;
			}
			const now = Date.now();
			const labels = sessions.map((s) => sessionLabel(runtime, s, now));
			const killAll = tr(
				`Kill all ${sessions.length} ${sessionWord(sessions.length)}`,
				`结束全部 ${sessions.length} 个会话`,
			);
			const choice = await cmdCtx.ui.select(
				tr(
					`unified-exec: ${sessions.length} live ${sessionWord(sessions.length)} — select to kill (Esc to cancel)`,
					`unified-exec：${sessions.length} 个正在运行的会话——选择要结束的会话（Esc 取消）`,
				),
				[...labels, killAll],
			);
			if (!choice) return;
			const targets = choice === killAll ? sessions : sessions.filter((s) => choice.startsWith(`#${s.id} `));
			let killed = 0;
			let failed = 0;
			for (const s of targets) {
				const outcome = await terminateSessionById(runtime, s.id, "SIGTERM", { kind: "human" });
				if (outcome?.killed) killed++;
				else if (outcome) failed++;
			}
			updateRunningSessionsUi(runtime);
			cmdCtx.ui.notify(
				tr(
					`unified-exec: killed ${killed} ${sessionWord(killed)}${failed ? `; ${failed} did not confirm exit (still listed)` : ""}`,
					`unified-exec：已结束 ${killed} 个会话${failed ? `；${failed} 个会话未确认退出（仍在列表中）` : ""}`,
				),
				failed ? "warning" : "info",
			);
		},
	});
}
