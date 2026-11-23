import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { readTerminal } from "../fork-features/terminal-resource.ts";
import { initializeTerminalUrls } from "../fork-features/terminal-url.ts";
import { activate } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

function hasRealPython3(): boolean {
	try {
		const r = spawnSync("python3", ["--version"], { timeout: 5000, windowsHide: true });
		return r.status === 0;
	} catch {
		return false;
	}
}

function makeHarness() {
	const tools: Record<string, any> = {};
	const handlers: Record<string, any[]> = {};
	const stubCtx = {
		cwd: process.cwd(),
		ui: { notify: () => {}, setStatus: () => {} },
		hasUI: false,
	};
	const pi = {
		registerTool: (def: any) => { tools[def.name] = def; },
		on: (event: string, h: any) => { (handlers[event] ??= []).push(h); },
		registerCommand: () => {}, registerShortcut: () => {}, registerFlag: () => {},
		registerMessageRenderer: () => {},
		getFlag: () => false,
		getActiveTools: () => ["bash"],
		setActiveTools: () => {},
	};
	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api, { shellPath: STUB_SHELL_PATH, shellHost: stubShellHost });
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute("id", params, signal, undefined, stubCtx);
		},
		async readTermListing(): Promise<string> {
			await initializeTerminalUrls();
			const res = await InternalUrlRouter.instance().resolve("term://");
			return typeof res.content === "string" ? res.content : res.content.toString("utf8");
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

async function readUntil(url: string, expected: RegExp): Promise<string> {
	const deadline = Date.now() + 8000;
	let text = "";
	do {
		text = (await readTerminal(url.slice(7))).screenLines.join("\n");
		if (expected.test(text)) return text;
		await delay(25);
	} while (Date.now() < deadline);
	assert.match(text, expected);
	return text;
}

describe("unified-exec PTY mode", () => {
	it("runs a command with a PTY that announces the emulator's TERM", async () => {
		const hostTerm = process.env.TERM;
		process.env.TERM = "xterm-kitty";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				title: "Test command",
				cmd: 't=$(tty) && echo "tty=$t" && echo "seen=$TERM"',
				yield_time_ms: 1500,
			});
			assert.match(r.details.output, /^tty=\/dev\//m, `output=${r.details.output}`);
			if (!IS_WINDOWS) assert.match(r.details.output, /^seen=xterm-256color$/m);
			if (r.details.session_id !== undefined) {
				await h.kill(r.details.session_id);
			}
		} finally {
			if (hostTerm === undefined) delete process.env.TERM;
			else process.env.TERM = hostTerm;
			await h.emit("session_shutdown");
		}
	});

	it("write_stdin drives a Python REPL over PTY", { skip: !hasRealPython3(), timeout: 15_000 }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", {
				title: "Test command",
				cmd: "python3 -q",
				yield_time_ms: 800,
			});
			const sid = r1.details.session_id;
			assert.equal(typeof sid, "number", `REPL did not stay alive: ${JSON.stringify(r1.details)}`);
			if (typeof sid !== "number") return;

			const r2 = await h.call("write_stdin", {
				session_id: sid,
				text: "print(2 + 40)",
				enter: true,
				yield_time_ms: 2000,
			});
			const output = r2.details.output.includes("42")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /^42$/m);
			assert.ok(output.includes("42"), `got: ${output}`);

			await h.call("write_stdin", { session_id: sid, text: "exit()", enter: true, yield_time_ms: 1500 });
			const listing = await h.readTermListing();
			if (listing.includes(`session_id=${sid}`) && listing.includes("[running]")) {
				await h.kill(sid);
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("write_stdin round-trips input through a Node line-echo fixture", { timeout: 15_000 }, async () => {
		const fixture =
			"node -e 'let b=\"\";process.stdin.on(\"data\",d=>{b+=d.toString();let i;while((i=b.search(/[\\r\\n]/))>=0){const line=b.slice(0,i).trim();b=b.slice(i+1);if(line){process.stdout.write(\"GOT:\"+line+\"|\\n\");if(line===\"quit\")process.exit(7);}}})'";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", { title: "Test command", cmd: fixture, yield_time_ms: 1500 });
			const sid = r1.details.session_id;
			assert.equal(typeof sid, "number", `fixture did not stay alive: ${JSON.stringify(r1.details)}`);

			const r2 = await h.call("write_stdin", { session_id: sid, text: "hello", enter: true, yield_time_ms: 2000 });
			const output = r2.details.output.includes("GOT:hello|")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /GOT:hello\|/);
			assert.ok(output.includes("GOT:hello|"), `PTY input did not round-trip: ${JSON.stringify(output)}`);

			const r3 = await h.call("write_stdin", { session_id: sid, text: "quit", enter: true, yield_time_ms: 3000 });
			let exitCode = r3.details.exit_code;
			const deadline = Date.now() + 8000;
			while (exitCode === undefined && Date.now() < deadline) {
				const listing = await h.readTermListing();
				const match = new RegExp(`session_id=${sid}\\b[^\\n]*\\[exited exit_code=(\\d+)`).exec(listing);
				if (match) exitCode = Number(match[1]);
				if (exitCode === undefined) await delay(25);
			}
			assert.equal(exitCode, 7, `fixture did not exit on quit: ${JSON.stringify(r3.details)}`);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("an explicit cmd never reaches a PTY", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("exec_command", {
				title: "Test command",
				cmd: "echo tty-cmd",
				shell: "cmd",
				yield_time_ms: 20000,
			});
			assert.equal(r.details.session_id, undefined, JSON.stringify(r.details));
			assert.match(String(r.details.failure_message), /never launches cmd/, JSON.stringify(r.details));
			assert.equal(r.details.terminal_url, undefined, JSON.stringify(r.details));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("Ctrl-C (special_key: ctrl-c) interrupts a PTY loop", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("exec_command", {
				title: "Test command",
				cmd: "while true; do echo alive; sleep 0.2; done",
				yield_time_ms: 400,
			});
			const sid = r1.details.session_id;
			assert.ok(typeof sid === "number");

			const r2 = await h.call("write_stdin", {
				session_id: sid,
				special_key: "ctrl-c",
				yield_time_ms: 1000,
			});
			if (r2.details.session_id !== undefined) {
				await h.kill(sid);
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});
});
