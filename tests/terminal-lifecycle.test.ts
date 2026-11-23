import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { PluginSettingsReader } from "../fork-features/plugin-settings.ts";
import { noteTerminalRead, readTerminal } from "../fork-features/terminal-resource.ts";
import { initializeTerminalUrls } from "../fork-features/terminal-url.ts";
import { activate } from "../src/index.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

const MINUTE = 60_000;

interface ListedSession {
	session_id: number;
	title: string;
	running: boolean;
	lifecycle?: { returned: string; read: boolean; phase: string };
}

interface ToolDetails {
	session_id?: number;
	terminal_url?: string;
	output?: string;
	killed?: boolean;
	status?: string;
	sessions?: ListedSession[];
}

interface ToolResult { details: ToolDetails; content: ReadonlyArray<{ readonly text: string }> }

interface ToolDef {
	name: string;
	execute: (toolCallId: string, params: object, signal: AbortSignal | undefined, onUpdate: undefined, ctx: object) => Promise<ToolResult>;
}

interface Notice { session_id: number; title: string; kind: string; reason: string }

interface Sent {
	message: { customType: string; content: string; details: { notices: Notice[] } };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

type Handler = (event: object, ctx: object) => unknown;

interface Harness {
	readonly sent: Sent[];
	readonly warnings: string[];
	emit(event: string, evt?: object): Promise<void>;
	call(name: string, params: object): Promise<ToolResult>;
	advance(ms: number): void;
	notices(kind: string): Notice[];
	listed(id: number): Promise<ListedSession | undefined>;
}

const live = new Set<Harness>();

function makeHarness(pluginSettings?: PluginSettingsReader): Harness {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const sent: Sent[] = [];
	const warnings: string[] = [];
	let now = Date.now();
	let sweep: (() => void) | undefined;
	const ui = {
		notify(message: string, level: string) { if (level === "warning") warnings.push(message); },
		setStatus() {}, setWidget() {},
	};
	const stubCtx = { cwd: process.cwd(), ui, hasUI: false };
	const pi = {
		registerTool: (def: ToolDef) => { tools[def.name] = def; },
		on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		getFlag: () => false, getActiveTools: () => ["bash"], setActiveTools() {},
		sendMessage: (message: Sent["message"], options: Sent["options"]) => { sent.push({ message, options }); },
	};
	activate(pi as unknown as Parameters<typeof activate>[0], undefined, undefined, undefined, undefined, {
		nowFn: () => now,
		setIntervalFn: (cb) => { sweep = cb; return 1; },
		clearIntervalFn: () => { sweep = undefined; },
	}, undefined, pluginSettings, undefined, stubShellHost);
	let nextCallId = 1;
	const harness: Harness = {
		sent,
		warnings,
		async emit(event, evt = {}) {
			if (event === "session_start") await initializeTerminalUrls();
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
		async call(name, params) {
			const toolCallId = `call-${nextCallId++}`;
			const result = await tools[name]!.execute(toolCallId, params, undefined, undefined, stubCtx);
			await harness.emit("tool_execution_end", { toolCallId, isError: false });
			return result;
		},
		advance(ms) {
			now += ms;
			sweep?.();
		},
		notices(kind) {
			return sent.flatMap((s) => s.message.details.notices.filter((n) => n.kind === kind));
		},
		async listed(id) {
			await initializeTerminalUrls();
			const res = await InternalUrlRouter.instance().resolve("term://");
			const text = typeof res.content === "string" ? res.content : res.content.toString("utf8");
			const line = text.split("\n").find((l) => l.includes(`session_id=${id} `));
			if (!line) return undefined;
			const titleMatch = /session_id=\d+\s+("(?:\\.|[^"])*")/.exec(line);
			const lifeMatch = /\[returned ([^;]+); (read|unread); ([^\]]+)\]/.exec(line);
			return {
				session_id: id,
				title: titleMatch ? JSON.parse(titleMatch[1]!) : "",
				running: line.includes("[running]"),
				lifecycle: lifeMatch ? { returned: lifeMatch[1]!, read: lifeMatch[2] === "read", phase: lifeMatch[3]! } : undefined,
			};
		},
	};
	live.add(harness);
	return harness;
}

afterEach(async () => {
	for (const h of live) await h.emit("session_shutdown");
	live.clear();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

const settle = () => new Promise((r) => setTimeout(r, 400));

async function readTerm(url: string): Promise<readonly string[]> {
	const key = url.slice("term://".length);
	const projection = await readTerminal(key);
	noteTerminalRead(key);
	return projection.retainedLines;
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startBackground(h: Harness, cmd: string, title: string, yieldMs = 250): Promise<{ sid: number; url: string; output: string }> {
	const started = await h.call("exec_command", { cmd, title, shell: "/bin/sh", yield_time_ms: yieldMs });
	const { session_id: sid, terminal_url: url, output } = started.details;
	assert.ok(sid !== undefined && url !== undefined, JSON.stringify(started.details));
	return { sid, url, output: output ?? "" };
}

async function startHeld(h: Harness, title: string): Promise<{ sid: number; url: string; bg: number }> {
	const { sid, url } = await startBackground(h, "(trap '' HUP; exec sleep 300) & echo bg=$!; sleep 0.5", title);
	assert.ok(await waitFor(async () => (await h.listed(sid))?.lifecycle !== undefined), "the shell returned");
	const lines = await readTerm(url);
	const bg = Number(/bg=(\d+)/.exec(lines.join("\n"))?.[1]);
	assert.ok(bg > 0 && alive(bg), lines.join("\n"));
	assert.equal((await h.listed(sid))?.lifecycle?.read, true);
	return { sid, url, bg };
}

describe("exec_command title", { skip: process.platform === "win32" }, () => {
	it("is required and must not be blank; nothing is spawned without one", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(h.call("exec_command", { cmd: "echo no-title" }), /title is required/);
		await assert.rejects(h.call("exec_command", { cmd: "echo blank", title: " \n\t" }), /title is required/);
		const res = await InternalUrlRouter.instance().resolve("term://");
		assert.match(String(res.content), /\(no terminals\)/);
	});

	it("names the terminal in term:// as one line", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "sleep 30", "  long\nsleep  ");
		assert.equal((await h.listed(sid))?.title, "long sleep");
	});
});

describe("terminal lifecycle", { skip: process.platform === "win32" }, () => {
	it("reclaims a read terminal after the TTL and an unread grace, killing what still holds it, silently by default", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, bg, url } = await startHeld(h, "held job");
		h.advance(30 * MINUTE - 1);
		await settle();
		assert.equal(h.notices("reclaim_due").length, 0, "not before the TTL");
		h.advance(1);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 1));
		const [due] = h.notices("reclaim_due");
		assert.equal(due!.session_id, sid);
		assert.equal(due!.title, "held job");
		assert.match(h.sent.at(-1)!.message.content, new RegExp(`session_id=${sid} title="held job"`));
		assert.deepEqual(h.sent.at(-1)!.options, { deliverAs: "aside" });
		assert.equal((await h.listed(sid))?.lifecycle?.phase, "grace");

		const before = h.sent.length;
		h.advance(5 * MINUTE);
		assert.ok(await waitFor(async () => await h.listed(sid) === undefined), "reclaimed");
		assert.ok(await waitFor(() => !alive(bg)), "the job holding the terminal is killed");
		await settle();
		assert.equal(h.sent.length, before, "notice.graceReclaim defaults to off: the reclaim sends nothing");
		assert.ok((await readTerminal(url.slice(7))).retainedLines.some((line) => line.startsWith("bg=")));
	});

	it("a read during the grace period keeps the terminal for another TTL", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, bg, url } = await startHeld(h, "kept");
		h.advance(30 * MINUTE);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 1));
		h.advance(2 * MINUTE);
		await readTerm(url);
		h.advance(3 * MINUTE);
		h.advance(10 * MINUTE);
		await settle();
		assert.equal(h.notices("reclaimed").length, 0);
		assert.ok(alive(bg));
		assert.equal((await h.listed(sid))?.lifecycle?.phase, "ttl");
		h.advance(17 * MINUTE);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 2), "a new TTL counted from the read");
	});

	it("a normal return with no process left lingers 5 minutes, read or not, and goes silently", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, url } = await startBackground(h, "sleep 0.5; echo finished-line", "quiet job");
		assert.ok(await waitFor(async () => (await h.listed(sid))?.lifecycle?.phase === "linger"));
		assert.equal((await h.listed(sid))?.lifecycle?.read, false);
		h.advance(4 * MINUTE);
		await readTerm(url);
		h.advance(MINUTE - 1);
		await settle();
		assert.equal((await h.listed(sid))?.lifecycle?.phase, "linger", "not before the linger ends");
		h.advance(1);
		assert.ok(await waitFor(async () => await h.listed(sid) === undefined), "reclaimed");
		h.advance(40 * MINUTE);
		await settle();
		assert.deepEqual(h.sent, [], "no unread, reclaim-due or reclaimed notice");
		assert.ok((await readTerminal(url.slice(7))).retainedLines.includes("finished-line"), "the terminal stays readable");
		await assert.rejects(
			h.call("write_stdin", { session_id: sid, text: "x" }),
			(error: Error) => error.message.includes(`unknown session_id: ${sid}; it returned normally and was reclaimed: read ${url} or log_path `),
		);
		await assert.rejects(
			InternalUrlRouter.instance().write(`term://${sid}/kill`, ""),
			(error: Error) => error.message.startsWith(`No such session: ${sid}; it returned normally and was reclaimed: read ${url}`),
		);
	});

	it("a normal return lingers from the sweep that finds its last process gone", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, bg } = await startHeld(h, "job ends later");
		assert.notEqual((await h.listed(sid))?.lifecycle?.phase, "linger", "a process still remains");
		process.kill(bg, "SIGKILL");
		assert.ok(await waitFor(() => !alive(bg)));
		h.advance(MINUTE);
		assert.ok(await waitFor(async () => (await h.listed(sid))?.lifecycle?.phase === "linger"));
		h.advance(5 * MINUTE);
		assert.ok(await waitFor(async () => await h.listed(sid) === undefined));
		await settle();
		assert.deepEqual(h.sent, []);
	});

	it("a never-read abnormal terminal gets one read reminder and is kept until read", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, url } = await startBackground(h, "sleep 0.5; echo done; exit 4", "unread");
		assert.ok(await waitFor(async () => (await h.listed(sid))?.running === false));
		h.advance(30 * MINUTE);
		assert.ok(await waitFor(() => h.notices("unread").length === 1));
		assert.match(h.notices("unread")[0]!.reason, /returned abnormally \(exit_code=4\) .* has not been read/);
		h.advance(35 * MINUTE);
		h.advance(35 * MINUTE);
		await settle();
		assert.equal(h.notices("unread").length, 1, "not repeated");
		assert.equal(h.notices("reclaimed").length, 0);
		assert.equal((await h.listed(sid))?.lifecycle?.read, false);

		await readTerm(url);
		h.advance(30 * MINUTE - 1);
		await settle();
		assert.equal(h.notices("reclaim_due").length, 0, "the TTL counts from the read, not the return");
		h.advance(1);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 1));
		h.advance(5 * MINUTE);
		assert.ok(await waitFor(async () => await h.listed(sid) === undefined));
		await settle();
		assert.equal(h.notices("reclaimed").length, 0);
	});

	it("an abnormal return is reported at once, then follows the same reclaim regime", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid, url } = await startBackground(h, "sleep 0.5; exit 3", "failing build");
		assert.ok(await waitFor(() => h.notices("abnormal_return").length === 1), "no sweep needed");
		const [notice] = h.notices("abnormal_return");
		assert.equal(notice!.session_id, sid);
		assert.equal(notice!.title, "failing build");
		assert.match(notice!.reason, /exit_code=3/);
		await readTerm(url);
		h.advance(30 * MINUTE);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 1));
		assert.match(h.notices("reclaim_due")[0]!.reason, /abnormally \(exit_code=3\)/);
	});

	it("kills are normal endings; the killed terminal lingers and goes silently", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "sleep 300", "killed");
		const killed = await InternalUrlRouter.instance().write(`term://${sid}/kill`, "");
		assert.equal(killed?.isError, undefined);
		assert.match(killed!.content[0]!.type === "text" ? killed!.content[0]!.text : "", /killed: true/);
		await settle();
		assert.equal(h.notices("abnormal_return").length, 0);
		const entry = await h.listed(sid);
		assert.equal(entry?.running, false);
		assert.deepEqual(entry?.lifecycle, { returned: "normally", read: true, phase: "linger" });
		h.advance(5 * MINUTE);
		assert.ok(await waitFor(async () => await h.listed(sid) === undefined));
		await settle();
		assert.deepEqual(h.sent, []);
	});

	it("a return after the agent's own Ctrl-C is a normal ending, not an abnormal return", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "sleep 300", "interrupted");
		await h.call("write_stdin", { session_id: sid, special_key: "ctrl-c", yield_time_ms: 250 });
		assert.ok(await waitFor(async () => (await h.listed(sid))?.running === false), "Ctrl-C ended the command");
		await settle();
		assert.equal(h.notices("abnormal_return").length, 0);
		assert.equal((await h.listed(sid))?.lifecycle?.returned, "normally");
	});

	it("input after an interrupt the program survived lets a later failure count as abnormal", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "trap '' INT; read line; exit 3", "survives interrupt");
		await h.call("write_stdin", { session_id: sid, special_key: "ctrl-c", yield_time_ms: 250 });
		assert.equal((await h.listed(sid))?.running, true, "the program ignored the interrupt");
		await h.call("write_stdin", { session_id: sid, text: "go", enter: true, yield_time_ms: 250 });
		assert.ok(await waitFor(() => h.notices("abnormal_return").length === 1));
		assert.match(h.notices("abnormal_return")[0]!.reason, /exit_code=3/);
	});

	it("with notice.graceReclaim on, one sweep's reclaims share one reclaimed follow-up; the setting is read live", async () => {
		let value: unknown = false;
		const cwds: string[] = [];
		const h = makeHarness(async (cwd) => {
			cwds.push(cwd);
			return { "notice.graceReclaim": value };
		});
		await h.emit("session_start");
		const sweepReads = async (sweep: () => Promise<void>): Promise<number> => {
			const before = cwds.length;
			await sweep();
			return cwds.length - before;
		};
		const off = await startHeld(h, "off");
		h.advance(30 * MINUTE);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 1));
		assert.equal(await sweepReads(async () => {
			h.advance(5 * MINUTE);
			assert.ok(await waitFor(async () => await h.listed(off.sid) === undefined));
			await settle();
		}), 1, "read once per reclaiming sweep");
		assert.equal(h.notices("reclaimed").length, 0, "off: reclaimed without a notice");

		value = true;
		const a = await startHeld(h, "first");
		const b = await startHeld(h, "second");
		h.advance(30 * MINUTE);
		assert.ok(await waitFor(() => h.notices("reclaim_due").length === 3));
		const before = h.sent.length;
		assert.equal(await sweepReads(async () => {
			h.advance(5 * MINUTE);
			assert.ok(await waitFor(() => h.notices("reclaimed").length === 2));
		}), 1, "read once per reclaiming sweep");
		const reclaimedMessages = h.sent.slice(before).filter((s) => s.message.details.notices.some((n) => n.kind === "reclaimed"));
		assert.equal(reclaimedMessages.length, 1);
		assert.deepEqual(reclaimedMessages[0]!.message.details.notices.map((n) => n.title).sort(), ["first", "second"]);
		assert.match(reclaimedMessages[0]!.message.content, /reclaimed: returned normally; not read again during the grace period/);
		assert.ok(await waitFor(() => !alive(a.bg) && !alive(b.bg)));
		assert.ok(cwds.every((cwd) => cwd === process.cwd()), "every read uses the session's cwd");
	});

	it("an invalid or unreadable notice.graceReclaim falls back to no notice and warns once", async () => {
		let stored: () => Promise<Readonly<Record<string, unknown>>> = async () => ({ "notice.graceReclaim": "yes" });
		const h = makeHarness(() => stored());
		await h.emit("session_start");
		const reclaimOne = async (title: string, dueCount: number, afterStart?: () => void): Promise<void> => {
			const { sid } = await startHeld(h, title);
			afterStart?.();
			h.advance(30 * MINUTE);
			assert.ok(await waitFor(() => h.notices("reclaim_due").length === dueCount));
			h.advance(5 * MINUTE);
			assert.ok(await waitFor(async () => await h.listed(sid) === undefined), `${title} reclaimed`);
			await settle();
		};
		await reclaimOne("invalid one", 1);
		await reclaimOne("invalid two", 2);
		await reclaimOne("unreadable", 3, () => { stored = async () => { throw new Error("broken overrides"); }; });
		assert.equal(h.notices("reclaimed").length, 0);
		assert.equal(h.warnings.filter((w) => /notice\.graceReclaim must be true or false; using false/.test(w)).length, 1);
		assert.equal(h.warnings.filter((w) => /could not read plugin settings, using defaults: broken overrides/.test(w)).length, 1);
	});

	it("monitor notices go through the same notice abstraction", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "sleep 0.5; echo needle-line; sleep 30", "watched");
		const monitor = await h.call("monitor", { session_id: sid, condition: "needle" });
		assert.equal(monitor.details.status, "started");
		assert.ok(await waitFor(() => h.notices("monitor_match").length === 1));
		const message = h.sent.find((s) => s.message.details.notices.some((n) => n.kind === "monitor_match"))!;
		assert.equal(message.message.customType, "unified-exec-notice");
		assert.match(message.message.content, new RegExp(`session_id=${sid} title="watched"`));
		assert.match(message.message.content, /needle-line/);
	});

	it("a write_stdin result that shows the returned terminal counts as a read", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, "read line; echo got=$line", "answered");
		const answered = await h.call("write_stdin", { session_id: sid, text: "yes", enter: true, yield_time_ms: 2000 });
		assert.equal(answered.details.session_id, undefined, "the result reports the exit");
		assert.deepEqual((await h.listed(sid))?.lifecycle, { returned: "normally", read: true, phase: "linger" });
	});

	it("write term://<id> sends stdin like proc:// and returns updated screen output", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const { sid } = await startBackground(h, 'while IFS= read -r line; do echo "term_echo=$line"; done', "term stdin");
		const res = await InternalUrlRouter.instance().write(`term://${sid}`, "hello-from-url");
		const text = res?.content[0]?.type === "text" ? res.content[0].text : "";
		assert.match(text, /term_echo=hello-from-url/);
		await InternalUrlRouter.instance().write(`term://${sid}/kill`, "");
		assert.deepEqual((await h.listed(sid))?.lifecycle, { returned: "normally", read: true, phase: "linger" });
	});

	it("session shutdown ends the lifecycle without notices", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await startHeld(h, "shut down");
		await startBackground(h, "sleep 300", "still running");
		const before = h.sent.length;
		await h.emit("session_shutdown");
		h.advance(40 * MINUTE);
		await settle();
		assert.equal(h.sent.length, before, "shutdown's kills and later checks send nothing");
	});
});
