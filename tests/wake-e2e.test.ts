import { strict as assert } from "node:assert";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { readTerminal } from "../fork-features/terminal-resource.ts";
import { afterEach, describe, it } from "node:test";
import { activate, EmptyPollRemovedError } from "../src/index.ts";
import type { NoticeMessage } from "../fork-features/terminal-notice.ts";
import { initializeTerminalUrls } from "../fork-features/terminal-url.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";


interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

function makeHarness() {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const sentMessages: Array<{ message: any; options: any }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		selectResponses: [] as Array<(options: string[]) => string | undefined>,
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: () => {},
			select: (_title: string, options: string[]) => {
				const responder = uiEvents.selectResponses.shift();
				return Promise.resolve(responder ? responder(options) : undefined);
			},
		},
		hasUI: false,
	};

	const pi = {
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		on: (event: string, handler: (e: any, ctx: any) => any) => {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand: (name: string, options: any) => {
			commands[name] = options;
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
		},
	};

	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api, undefined, STUB_SHELL_PATH, undefined, undefined, {}, undefined, undefined, undefined, stubShellHost);

	let nextCallId = 1;
	let shutDown = false;
	const harness = {
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			const toolCallId = `call-${nextCallId++}`;
			const result = await def.execute(toolCallId, params, signal, onUpdate, stubCtx);
			return { ...result, toolCallId };
		},
		async invokeCommand(name: string, args = "") {
			return commands[name].handler(args, stubCtx);
		},
		async emit(event: string, evt: any = {}) {
			if (event === "session_start") await initializeTerminalUrls();
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
			if (event === "session_shutdown") shutDown = true;
		},
		async listTerm(): Promise<string> {
			await initializeTerminalUrls();
			const res = await InternalUrlRouter.instance().resolve("term://");
			return typeof res.content === "string" ? res.content : res.content.toString("utf8");
		},
		async writeTerm(url: string, content: string) {
			await initializeTerminalUrls();
			return InternalUrlRouter.instance().write(url, content);
		},
		async finalizeTool(toolCallId: string, isError = false) {
			await this.emit("tool_execution_end", { type: "tool_execution_end", toolCallId, toolName: "", result: {}, isError });
		},
		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			try {
				await this.emit("session_shutdown");
			} catch {
			}
		},
		sentMessages,
		uiEvents,
	};
	liveHarnesses.add(harness);
	return harness;
}

const liveHarnesses = new Set<{ shutdown: () => Promise<void> }>();

afterEach(async () => {
	const hs = [...liveHarnesses];
	liveHarnesses.clear();
	for (const h of hs) await h.shutdown();
});

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !!(await cond());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


describe("exec_command on_exit", () => {
	it("omitted or explicit 'none' preserves current behavior (no wake)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.3", yield_time_ms: 250 });
		const r2 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "none" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(typeof r2.details.session_id === "number");
		assert.equal(r2.details.completion_notification, undefined);
		await new Promise((r) => setTimeout(r, 1200)); // both exit + debounce window
		assert.equal(h.sentMessages.length, 0);
		await h.listTerm();
		await h.emit("session_shutdown");
	});

	it("wake process exiting inside the initial exec_command yield gives a direct result, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("exec_command", { title: "Test command", cmd: "echo quick", yield_time_ms: 5000, on_exit: "wake" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.session_id, undefined);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});

	it("backgrounded wake session exiting while idle sends exactly one follow-up prompt", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.4 && echo bye | tr a-z A-Z",
			yield_time_ms: 250,
			on_exit: "wake", });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number", JSON.stringify(r1.details));
		assert.equal(r1.details.completion_notification, "armed");
		assert.equal(r1.details.on_exit, "wake");
		assert.ok(r1.content[0].text.includes("completion_notification: armed"), r1.content[0].text);

		assert.ok(await waitFor(() => h.sentMessages.length === 1), "expected one wake");
		const { message, options } = h.sentMessages[0];
		assert.equal(message.customType, "unified-exec-notice");
		assert.deepEqual((message as NoticeMessage).details.notices.map((notice) => ({ session_id: notice.session_id, title: notice.title, kind: notice.kind })), [
			{ session_id: sid, title: "Test command", kind: "exit_wake" },
		]);
		assert.equal(message.display, true);
		assert.deepEqual(options, { deliverAs: "aside" });
		assert.match(message.content, new RegExp(`session_id=${sid}`));
		assert.match(message.content, /exit_code=0/);
		assert.ok(!message.content.includes("BYE"), "wake must not contain raw stdout");
		assert.ok(message.content.includes(`read ${r1.details.terminal_url}`));
		assert.doesNotMatch(message.content, /write_stdin/);

		const projection = await readTerminal(r1.details.terminal_url.slice(7));
		assert.ok(projection.screenLines.some((line) => line.includes("BYE")));
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.emit("session_shutdown");
	});

	it("exit during an input-bearing observer is delivered directly, no wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.5", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, text: "x", yield_time_ms: 5000 });
		assert.equal(r2.details.exit_code, 0);
		assert.equal(r2.details.completion_delivery, "direct");
		assert.equal(r2.details.on_exit_wake, "consumed");
		await h.finalizeTool(r2.toolCallId, false);
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 0);
		await h.emit("session_shutdown");
	});


	it("input attachment window first, then exit: wake remains armed exactly once", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, text: "x", yield_time_ms: 250 });
		assert.equal(r2.details.session_id, sid);
		assert.equal(r2.details.completion_notification, "armed");
		await h.finalizeTool(r2.toolCallId, false);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1, "exactly one");
		const listing = await h.listTerm();
		assert.match(listing, new RegExp(`session_id=${sid}\\b[^\\n]*\\[exited exit_code=0\\]`));
		await h.emit("session_shutdown");
	});

	it("rejected zero-byte input keeps the wake armed; later exit sends exactly one wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 1.2", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await assert.rejects(h.call("write_stdin", { session_id: sid }), EmptyPollRemovedError);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake after later exit");
		await new Promise((res) => setTimeout(res, 600));
		assert.equal(h.sentMessages.length, 1);
		await h.listTerm();
		await h.emit("session_shutdown");
	});

	it("a terminal result finalized as error keeps the completion wake-eligible", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.4", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const r2 = await h.call("write_stdin", { session_id: sid, text: "x", yield_time_ms: 10_000 });
		assert.equal(r2.details.exit_code, 0);
		await h.finalizeTool(r2.toolCallId, true);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "wake despite constructed result");
		await h.emit("session_shutdown");
	});

	it("write term://<id>/on_exit none disarms the wake but an abnormal return still resumes the agent", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.8; exit 1",
			yield_time_ms: 250,
			on_exit: "wake", });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.writeTerm(`term://${sid}/on_exit`, "none");
		assert.match(r2!.content[0]!.type === "text" ? r2!.content[0]!.text : "", /disarmed.*wake not armed/);
		assert.ok(
			await waitFor(async () => {
				const l = await h.listTerm();
				return l.includes("(0 running,");
			}),
			"process should exit",
		);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "abnormal return must notify independently of the wake policy");
		assert.deepEqual((h.sentMessages[0]!.message as NoticeMessage).details.notices.map((notice) => notice.kind), ["abnormal_return"]);
	});

	it("write term://<id>/on_exit wake arms a session started with on_exit none", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.5; exit 0",
			yield_time_ms: 250,
			on_exit: "none", });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		const r2 = await h.writeTerm(`term://${sid}/on_exit`, "wake");
		assert.match(r2!.content[0]!.type === "text" ? r2!.content[0]!.text : "", /armed.*wake armed/);
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "armed session should wake");
		await h.listTerm();
	});

	it("write term://<id>/on_exit unknown session_id throws", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(() => h.writeTerm("term://99999/on_exit", "none"), /No such session: 99999/);
	});

	it("read term:// reports [wake] for live wake sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		const l = await h.listTerm();
		const line = l.split("\n").find((row) => row.includes(`session_id=${sid} `));
		assert.ok(line);
		assert.match(line, /\[wake\]/);
		await h.writeTerm(`term://${sid}/kill`, "");
	});

	it("explicit model kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		await h.writeTerm(`term://${sid}/kill`, "");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("human slash-command kill suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 30", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		h.uiEvents.selectResponses.push((options) => options.find((o) => o.startsWith(`#${sid} `)));
		await h.invokeCommand("unified-exec-sessions");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 600)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("read term:// observing the exit before notification suppresses the wake", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		const sid = r1.details.session_id;
		assert.ok(typeof sid === "number");
		assert.ok(
			await waitFor(async () => {
				const l = await h.listTerm();
				return l.split("\n").some((row) => row.includes(`session_id=${sid} `) && row.includes("[exited"));
			}),
			"expected read term:// to observe exit",
		);
		await sleep(400); // remaining debounce budget if any
		assert.ok(h.sentMessages.length <= 1, `never more than one notification; got ${h.sentMessages.length}`);
	});

	it("session_shutdown cancels pending wakes (no stale prompt)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		await h.emit("session_shutdown");
		assert.ok(!(await waitFor(() => h.sentMessages.length > 0, 800)));
		assert.equal(h.sentMessages.length, 0);
	});

	it("several wake sessions finishing together produce one bounded batch", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const marker = `${process.env.TMPDIR || "/tmp"}/unified-exec-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const waitCmd = `while [ ! -f "${marker}" ]; do sleep 0.05; done`;
		const a = await h.call("exec_command", { title: "Test command", cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const b = await h.call("exec_command", { title: "Test command", cmd: waitCmd, yield_time_ms: 250, on_exit: "wake" });
		const release = await h.call("exec_command", { title: "Test command", cmd: `touch "${marker}"`, yield_time_ms: 5000 });
		assert.equal(release.details.exit_code, 0);
		assert.ok(typeof a.details.session_id === "number");
		assert.ok(typeof b.details.session_id === "number");
		assert.ok(await waitFor(() => h.sentMessages.length >= 1), "batch wake expected");
		await new Promise((res) => setTimeout(res, 800));
		assert.equal(h.sentMessages.length, 1, "one prompt for both completions");
		const content = h.sentMessages[0].message.content;
		assert.match(content, new RegExp(`session_id=${a.details.session_id}`));
		assert.match(content, new RegExp(`session_id=${b.details.session_id}`));
		await h.listTerm();
		await h.emit("session_shutdown");
	});

	it("a settled run flushes a wake whose send previously failed", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const originalPush = h.sentMessages.push.bind(h.sentMessages);
		let failures = 1;
		(h.sentMessages as any).push = (...args: any[]) => {
			if (failures > 0) {
				failures--;
				throw new Error("synthetic send failure");
			}
			return originalPush(...args);
		};
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "sleep 0.3", yield_time_ms: 250, on_exit: "wake" });
		assert.ok(typeof r1.details.session_id === "number");
		assert.ok(await waitFor(() => failures === 0), "first send attempt never happened");
		assert.equal(h.sentMessages.length, 0);
		await h.emit("agent_start", { type: "agent_start" });
		await h.emit("agent_end", { type: "agent_end", messages: [] });
		assert.ok(await waitFor(() => h.sentMessages.length === 1), "retry at the settled run");
		await h.listTerm();
	});
});
