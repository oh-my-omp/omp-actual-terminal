import { beforeEach, describe, expect, test } from "bun:test";
import type {
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	CompactionEntry,
	ExtensionContext,
	SessionCompactingEvent,
	SessionCompactingResult,
	SessionCompactEvent,
	SessionEntry,
} from "@oh-my-pi/pi-coding-agent";
import {
	COMPACT_HANDOFF_SOURCE,
	createCompactNoticeSender,
	formatPtySessionsSnapshot,
	registerActualTerminalCompactHandoff,
} from "../fork-features/compact-handoff-wiring.ts";
import {
	type CompactExtensionAPI,
	enterCompactionBarrier,
	getSharedCompactCoordinator,
	isCompacting,
	releaseCompactionBarrier,
} from "../fork-features/omomp-shared/compact-handoff.ts";
import type { NoticeMessage } from "../fork-features/terminal-notice.ts";
import type { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";

type AnyHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createMockHost() {
	const handlers = new Map<string, AnyHandler[]>();
	const eventsBus = {};
	const pi = {
		events: eventsBus,
		on(event: string, handler: AnyHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as CompactExtensionAPI;

	return {
		pi,
		async emitAutoStart(event: AutoCompactionStartEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("auto_compaction_start") ?? []) await h(event, ctx);
		},
		async emitCompacting(event: SessionCompactingEvent, ctx: ExtensionContext): Promise<SessionCompactingResult | undefined> {
			let result: SessionCompactingResult | undefined;
			for (const h of handlers.get("session.compacting") ?? []) {
				const r = (await h(event, ctx)) as SessionCompactingResult | undefined;
				if (r) result = r;
			}
			return result;
		},
		async emitCompact(event: SessionCompactEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("session_compact") ?? []) await h(event, ctx);
		},
		async emitAutoEnd(event: AutoCompactionEndEvent, ctx: ExtensionContext) {
			for (const h of handlers.get("auto_compaction_end") ?? []) await h(event, ctx);
		},
		async emitBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult[]> {
			const results: BeforeAgentStartEventResult[] = [];
			for (const h of handlers.get("before_agent_start") ?? []) {
				const r = (await h(event, ctx)) as BeforeAgentStartEventResult | undefined;
				if (r) results.push(r);
			}
			return results;
		},
	};
}

function makeCtx(entries: SessionEntry[] = [], cwd = "/repo"): ExtensionContext {
	const leaf = entries[entries.length - 1];
	const byId = new Map(entries.map((e) => [e.id, e]));
	const sessionManager = {
		getEntries: () => [...entries],
		getLeafId: () => (leaf ? leaf.id : null),
		getEntry: (id: string) => byId.get(id),
	};
	return { cwd, sessionManager, model: undefined } as unknown as ExtensionContext;
}

function fakeNotice(label: string): NoticeMessage {
	return {
		content: `notice:${label}`,
		details: { summary: label, items: [], wakesTurn: true },
	} as unknown as NoticeMessage;
}

function fakeSession(overrides: {
	id: number;
	title: string;
	displayCommand: string;
	cwd: string;
	hasExited: boolean;
	exitCode: number | null;
	pid?: number;
	terminalUrl?: string;
	logPath: string;
}): ExecSession {
	return {
		...overrides,
		lastUsed: Date.now(),
		terminate() {},
		release: async () => {},
		releaseForShutdown: async () => {},
	} as unknown as ExecSession;
}

beforeEach(() => {
	getSharedCompactCoordinator().resetForTest();
});

describe("omp-actual-terminal compact handoff", () => {
	test("Plane 1 notice barrier defers unified-exec-notice while compacting and drains in FIFO order after commit/abort", async () => {
		const sm = {};
		const sent: string[] = [];
		const sender = createCompactNoticeSender({
			sendImmediate: (m) => sent.push(m.content),
			sessionManager: () => sm,
		});

		// Idle: sends immediately
		sender.send(fakeNotice("idle-1"));
		expect(sent).toEqual(["notice:idle-1"]);
		expect(sender.queuedCount()).toBe(0);

		// Compacting: holds exit_wake + monitor_match without calling sendImmediate
		enterCompactionBarrier(sm);
		expect(isCompacting(sm)).toBe(true);
		sender.send(fakeNotice("exit_wake"));
		sender.send(fakeNotice("monitor_match"));
		expect(sent).toEqual(["notice:idle-1"]);
		expect(sender.queuedCount()).toBe(2);

		// Barrier released -> flushes both queued notices in FIFO order
		releaseCompactionBarrier(sm);
		expect(isCompacting(sm)).toBe(false);
		expect(sent).toEqual(["notice:idle-1", "notice:exit_wake", "notice:monitor_match"]);
		expect(sender.queuedCount()).toBe(0);

		// Session switch clears queued notices before barrier release
		enterCompactionBarrier(sm);
		sender.send(fakeNotice("stale-before-switch"));
		expect(sender.queuedCount()).toBe(1);
		sender.clearQueued();
		releaseCompactionBarrier(sm);
		expect(sent).toEqual(["notice:idle-1", "notice:exit_wake", "notice:monitor_match"]);
	});

	test("Plane 2B silently gates out when SessionStore is empty and emits claim + delta-stream PTY table when active", async () => {
		const store = new SessionStore({ maxSessions: 8, lruProtectedCount: 2 });
		const host = createMockHost();
		registerActualTerminalCompactHandoff(host.pi, () => store);

		// 1. Empty store -> silent gating (no claim, no post-compact injection)
		const emptyCtx = makeCtx();
		const emptyCompacting = await host.emitCompacting({ type: "session.compacting", sessionId: "s-empty", messages: [] }, emptyCtx);
		expect(emptyCompacting?.context?.join("\n") ?? "").not.toContain("[omp-actual-terminal]");

		store.insert(
			fakeSession({
				id: 1,
				title: "astro preview 4391",
				displayCommand: "node_modules/.bin/astro preview --port 4391",
				cwd: "/repo/site",
				hasExited: false,
				exitCode: null,
				pid: 4242,
				terminalUrl: "term://astro-preview-4391",
				logPath: "/tmp/pi-unified-exec-1.log",
			}),
		);
		store.insert(
			fakeSession({
				id: 2,
				title: "build check",
				displayCommand: "bun run build",
				cwd: "/repo",
				hasExited: true,
				exitCode: 0,
				pid: 4243,
				terminalUrl: "term://build-check",
				logPath: "/tmp/pi-unified-exec-2.log",
			}),
		);

		const keptUser: SessionEntry = {
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-11-23T00:00:00.000Z",
			message: { role: "user", content: "continue", timestamp: 1 },
		};
		const cmpEntry: CompactionEntry = {
			type: "compaction",
			id: "cmp_pty_1",
			parentId: "u1",
			timestamp: "2026-11-23T00:01:00.000Z",
			summary: "summary",
			firstKeptEntryId: "u1",
			tokensBefore: 450000,
		};
		const activeCtx = makeCtx([keptUser, cmpEntry]);

		await host.emitAutoStart({ type: "auto_compaction_start", reason: "threshold", action: "remote" }, activeCtx);
		expect(isCompacting(activeCtx.sessionManager)).toBe(true);

		const activeCompacting = await host.emitCompacting(
			{ type: "session.compacting", sessionId: "s-active", messages: [] },
			activeCtx,
		);
		const extra = activeCompacting?.context?.join("\n") ?? "";
		expect(extra).toContain("[omp-actual-terminal]");
		expect(extra).toContain(`source="${COMPACT_HANDOFF_SOURCE}"`);
		expect(extra).toContain("2 session(s): 1 running, 1 exited");

		await host.emitCompact({ type: "session_compact", compactionEntry: cmpEntry, fromExtension: false }, activeCtx);
		expect(isCompacting(activeCtx.sessionManager)).toBe(false);

		const startResults = await host.emitBeforeAgentStart(
			{ type: "before_agent_start", reason: "prompt", prompt: "continue", systemPrompt: [] },
			activeCtx,
		);
		expect(startResults.length).toBe(1);
		const content = typeof startResults[0]?.message === "object" ? String(startResults[0].message.content) : "";
		expect(content).toContain(`<system-reminder source="${COMPACT_HANDOFF_SOURCE}">`);
		expect(content).toContain("#1 [running] pid=4242 term://astro-preview-4391");
		expect(content).toContain("#2 [exited(0)] pid=4243 term://build-check");
		expect(content).toContain("/tmp/pi-unified-exec-1.log");

		const formatted = formatPtySessionsSnapshot({
			sessions: [
				{
					id: 1,
					title: "astro preview",
					command: "astro preview",
					cwd: "/repo",
					status: "running",
					exitCode: null,
					pid: 100,
					terminalUrl: "term://astro",
					logPath: "/tmp/a.log",
				},
			],
		});
		expect(formatted).toContain("[Authoritative PTY Session Table — omp-actual-terminal]");
	});
});
