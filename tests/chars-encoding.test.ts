import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { initializeTerminalUrls } from "../fork-features/terminal-url.ts";
import { activate } from "../src/index.ts";
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
	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (_m: string) => {},
			setStatus: (_k: string, _v: unknown) => {},
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
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api, undefined, STUB_SHELL_PATH, undefined, undefined, {}, undefined, undefined, undefined, stubShellHost);
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, undefined, stubCtx);
		},
		async kill(sid: number) {
			await initializeTerminalUrls();
			return InternalUrlRouter.instance().write(`term://${sid}/kill`, "");
		},
		async emit(event: string, evt: any = {}) {
			for (const h of handlers[event] ?? []) await h(evt, stubCtx);
		},
	};
}

type ExecCaller = {
	call(toolName: string, params: Record<string, unknown>): Promise<{ details: { session_id?: unknown; log_path?: unknown } }>;
};

async function startRawCat(h: ExecCaller, out: string): Promise<number> {
	const r1 = await h.call("exec_command", {
		title: "Test command",
		cmd: `stty raw -echo; printf raw-ready; exec cat > '${out}'`,
		yield_time_ms: 300,
	});
	const { session_id: sid, log_path: logPath } = r1.details;
	assert.ok(typeof sid === "number", `expected session_id; got ${JSON.stringify(r1.details)}`);
	assert.ok(typeof logPath === "string");
	const deadline = Date.now() + 8000;
	while (!readFileSync(logPath, "utf8").includes("raw-ready")) {
		assert.ok(Date.now() < deadline, "raw mode was never set");
		await delay(25);
	}
	return sid;
}

async function spawnCapture() {
	const dir = mkdtempSync(join(tmpdir(), "unified-exec-chars-"));
	const out = join(dir, "stdin.bin");
	const h = makeHarness();
	await h.emit("session_start");
	const sid = await startRawCat(h, out);
	return {
		sid,
		outFile: out,
		dir,
		harness: h,
		async send(params: Record<string, unknown>) {
			await h.call("write_stdin", { session_id: sid, yield_time_ms: 250, ...params });
		},
		async finish(): Promise<Buffer> {
			await h.kill(sid);
			await new Promise((r) => setTimeout(r, 50));
			const buf = readFileSync(out);
			await h.emit("session_shutdown");
			rmSync(dir, { recursive: true, force: true });
			return buf;
		},
	};
}

describe("write_stdin zero-escape encoding", () => {
	it("writes text verbatim without C-escape decoding (preserves literal \\n and \\\\)", async () => {
		const c = await spawnCapture();
		await c.send({ text: "A\\nB\\\\C" });
		const buf = await c.finish();
		assert.deepEqual([...buf], [...Buffer.from("A\\nB\\\\C", "utf8")]);
	});

	it("writes real LF and ESC when text contains real characters", async () => {
		const c = await spawnCapture();
		await c.send({ text: "A\nB\u001bC" });
		const buf = await c.finish();
		assert.deepEqual([...buf], [0x41, 0x0a, 0x42, 0x1b, 0x43]);
	});

	it("appends CR (0x0D) when enter is true, or sends CR alone", async () => {
		const c = await spawnCapture();
		await c.send({ text: "hi", enter: true });
		await c.send({ enter: true });
		const buf = await c.finish();
		assert.deepEqual([...buf], [0x68, 0x69, 0x0d, 0x0d]);
	});

	it("maps special_key values to exact control/ANSI byte sequences", async () => {
		const c = await spawnCapture();
		await c.send({ special_key: "ctrl-c" });
		await c.send({ special_key: "ctrl-d" });
		await c.send({ special_key: "ctrl-z" });
		await c.send({ special_key: "esc" });
		await c.send({ special_key: "tab" });
		await c.send({ special_key: "up" });
		await c.send({ special_key: "down" });
		await c.send({ special_key: "left" });
		await c.send({ special_key: "right" });
		await c.send({ special_key: "backspace" });
		await c.send({ special_key: "delete" });
		const buf = await c.finish();
		assert.deepEqual(
			[...buf],
			[
				0x03, 0x04, 0x1a, 0x1b, 0x09,
				0x1b, 0x5b, 0x41,
				0x1b, 0x5b, 0x42,
				0x1b, 0x5b, 0x44,
				0x1b, 0x5b, 0x43,
				0x7f,
				0x1b, 0x5b, 0x33, 0x7e,
			],
		);
	});

	it("UTF-8 multi-byte chars are passed through verbatim", async () => {
		const c = await spawnCapture();
		await c.send({ text: "é" });
		const buf = await c.finish();
		assert.deepEqual([...buf], [0xc3, 0xa9]);
	});

	it("raw_base64 delivers the exact decoded bytes (binary-safe)", async () => {
		const c = await spawnCapture();
		const b64 = Buffer.from([0x1b, 0x03, 0x41, 0x0a, 0xc3, 0xa9]).toString("base64");
		await c.send({ raw_base64: b64 });
		const buf = await c.finish();
		assert.deepEqual([...buf], [0x1b, 0x03, 0x41, 0x0a, 0xc3, 0xa9]);
	});

	it("rejects combining raw_base64 with text, enter, or special_key", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "cat > /dev/null", yield_time_ms: 200 });
		const sid = r1.details.session_id as number;
		for (const combo of [
			{ text: "hi", raw_base64: "aGk=" },
			{ enter: true, raw_base64: "aGk=" },
			{ special_key: "esc", raw_base64: "aGk=" },
		]) {
			await assert.rejects(
				() => h.call("write_stdin", { session_id: sid, ...combo }),
				/raw_base64.*cannot be combined/,
			);
		}
		await h.kill(sid);
		await h.emit("session_shutdown");
	});

	it("malformed raw_base64 rejects the call", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("exec_command", { title: "Test command", cmd: "cat > /dev/null", yield_time_ms: 200 });
		const sid = r1.details.session_id as number;
		await assert.rejects(
			() => h.call("write_stdin", { session_id: sid, raw_base64: "not@valid!" }),
			/not valid base64/,
		);
		await h.kill(sid);
		await h.emit("session_shutdown");
	});
});
