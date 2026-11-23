import { tr } from "../fork-features/omomp-shared/i18n.ts";
import { sanitizeMeta } from "./completion.ts";
import { formatElapsedUi } from "./format-time.ts";
import type { ExtensionCtx } from "./runtime.ts";
import type { ExecSession } from "./session.ts";

const SESSION_UI_KEY = "unified-exec.sessions";

export function runningSessions(ctx: ExtensionCtx): ExecSession[] {
	return ctx.store
		.values()
		.filter((s) => !s.hasExited)
		.sort((a, b) => a.id - b.id);
}

export function sessionWord(count: number): string {
	return count === 1 ? tr("session", "会话") : tr("sessions", "会话");
}

export function oneLineCommand(command: string, max = 120): string {
	const oneLine = sanitizeMeta(command).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function sessionLabel(ctx: ExtensionCtx, session: ExecSession, now: number): string {
	const wake = ctx.coordinator.isArmed(session.id) ? tr(" [wake]", " [已唤醒]") : "";
	const held = session.shellExited ? tr(" (shell exited, terminal held)", "（shell 已退出，终端仍被占用）") : "";
	const elapsed = formatElapsedUi(now - session.startedAt);
	return `#${session.id} ${elapsed}${wake}${held} ${oneLineCommand(session.title, 40)} — ${oneLineCommand(session.displayCommand, 60)}`;
}

function formatRunningSessionsWidget(ctx: ExtensionCtx, sessions: ExecSession[]): string[] {
	const now = Date.now();
	const shown = sessions.slice(0, 5);
	const lines = [
		tr(
			`⚠ unified-exec: ${sessions.length} ${sessionWord(sessions.length)} still running`,
			`⚠ unified-exec：${sessions.length} 个会话仍在运行`,
		),
		...shown.map((s) => `  ${sessionLabel(ctx, s, now)}${tr(` (${s.cwd})`, `（${s.cwd}）`)}`),
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

export function updateRunningSessionsUi(ctx: ExtensionCtx, opts: { showWidget?: boolean; notifyTree?: boolean } = {}): void {
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
