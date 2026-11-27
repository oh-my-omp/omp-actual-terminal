import type { SessionStore } from "./session-store.ts";
import {
	type CompactExtensionAPI,
	deferDuringCompaction,
	defineStatefulHarnessHandoff,
	isCompacting,
	registerCompactHandoff,
} from "./omomp-shared/compact-handoff.ts";
import type { NoticeMessage } from "./terminal-notice.ts";

export const COMPACT_HANDOFF_PLUGIN_ID = "omp-actual-terminal";
export const COMPACT_HANDOFF_SOURCE = "omp-actual-terminal/sessions";
export const COMPACT_NOTICE_BARRIER_KEY = "omp-actual-terminal:notice";

export interface PtySessionSnapshotRow {
	readonly jobId: string;
	readonly title: string;
	readonly command: string;
	readonly cwd: string;
	readonly status: "running" | "exited";
	readonly exitCode: number | null;
	readonly pid: number | undefined;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
}

export interface PtySessionsSnapshot {
	readonly sessions: readonly PtySessionSnapshotRow[];
}

export interface CompactNoticeSender {
	send(message: NoticeMessage): void;
	clearQueued(): void;
	queuedCount(): number;
}

export function createCompactNoticeSender(opts: {
	readonly sendImmediate: (message: NoticeMessage) => void;
	readonly sessionManager: () => object | undefined;
}): CompactNoticeSender {
	const queued: NoticeMessage[] = [];

	const drain = (): void => {
		while (queued.length > 0) {
			const sm = opts.sessionManager();
			if (sm !== undefined && isCompacting(sm)) {
				deferDuringCompaction(sm, COMPACT_NOTICE_BARRIER_KEY, drain);
				return;
			}
			const next = queued.shift();
			if (next !== undefined) opts.sendImmediate(next);
		}
	};

	return {
		send(message) {
			const sm = opts.sessionManager();
			if (sm !== undefined && isCompacting(sm)) {
				queued.push(message);
				deferDuringCompaction(sm, COMPACT_NOTICE_BARRIER_KEY, drain);
				return;
			}
			opts.sendImmediate(message);
		},
		clearQueued() {
			queued.length = 0;
		},
		queuedCount() {
			return queued.length;
		},
	};
}

function oneLine(text: string, maxLen: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= maxLen ? compact : `${compact.slice(0, maxLen - 1)}…`;
}

export function formatPtySessionsSnapshot(state: PtySessionsSnapshot): string {
	const lines = ["[Authoritative PTY Terminal Table — omp-actual-terminal]"];
	for (const s of state.sessions) {
		const statusLabel = s.status === "running" ? "running" : `exited(${s.exitCode ?? "?"})`;
		const pidPart = s.pid !== undefined ? ` pid=${s.pid}` : "";
		const urlPart = s.terminalUrl ? ` ${s.terminalUrl}` : "";
		lines.push(
			`- ${s.jobId} [${statusLabel}]${pidPart}${urlPart} | ${oneLine(s.title, 48)} | cwd=${s.cwd} | cmd=\`${oneLine(s.command, 80)}\` | log=${s.logPath}`,
		);
	}
	return lines.join("\n");
}

export function capturePtySessionsSnapshot(store: SessionStore): PtySessionsSnapshot | null {
	const entries = store.values();
	if (entries.length === 0) return null;
	const sessions: PtySessionSnapshotRow[] = entries
		.map((s) => ({
			jobId: s.id,
			title: s.title,
			command: s.displayCommand,
			cwd: s.cwd,
			status: s.hasExited ? ("exited" as const) : ("running" as const),
			exitCode: s.exitCode,
			pid: s.pid,
			terminalUrl: s.terminalUrl,
			logPath: s.logPath,
		}))
		.sort((a, b) => a.jobId.localeCompare(b.jobId));
	return { sessions };
}

export function registerActualTerminalCompactHandoff(pi: CompactExtensionAPI, store: () => SessionStore): void {
	registerCompactHandoff(
		pi,
		defineStatefulHarnessHandoff<PtySessionsSnapshot>({
			pluginId: COMPACT_HANDOFF_PLUGIN_ID,
			inactiveClaim:
				`Zero live PTY terminals exist at compaction (\`omp-actual-terminal\`, \`source="${COMPACT_HANDOFF_SOURCE}"\`) — ` +
				`NEVER list historical prefix terminal \`job_id\`s, PIDs, \`term://\` URLs, or log paths as active state in the summary.`,
			captureState() {
				return capturePtySessionsSnapshot(store());
			},
			renderCompactPromptClaim(state) {
				const running = state.sessions.filter((s) => s.status === "running").length;
				const exited = state.sessions.length - running;
				return (
					`Live PTY terminal & \`term://\` table (${state.sessions.length} terminal(s): ${running} running, ${exited} exited) ` +
					`is owned by \`omp-actual-terminal\` (\`source="${COMPACT_HANDOFF_SOURCE}"\`) and programmatically re-injected post-compaction — ` +
					`NEVER list terminal job IDs, PIDs, \`term://\` URLs, or log paths in the summary.`
				);
			},
			renderPostCompactInjection(state) {
				return {
					source: COMPACT_HANDOFF_SOURCE,
					delivery: "delta-stream",
					content: formatPtySessionsSnapshot(state),
				};
			},
		}),
	);
}
