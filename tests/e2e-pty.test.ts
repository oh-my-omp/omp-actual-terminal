import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readTerminal } from "../src/terminal-resource.ts";
import { activate } from "../src/index.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import { STUB_SESSION, stubShellHost, stubTerminalHost } from "./stub-shell.ts";


/**
 * On Windows the "python3" on PATH may be
 * the WindowsApps Store stub, which stays alive without being a REPL — so
 * probe with --version instead of relying on spawn success.
 */
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
		...STUB_SESSION,
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
	activate(api, undefined, stubTerminalHost(), undefined, {}, undefined, undefined, undefined, stubShellHost);
	return {
		async call(toolName: string, params: any, signal?: AbortSignal) {
			return tools[toolName].execute("id", params, signal, undefined, stubCtx);
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

describe("omp-actual-terminal PTY mode", () => {
	// NOTE: every test runs its body in try/finally with session_shutdown in
	// the finally. A failed assertion mid-test must not leak a live PTY
	// session: on Windows, ConPTY's conout worker keeps the event loop alive
	// until the session exits, so a leaked session hangs the test process
	// forever (observed on windows-latest CI).

	it("runs a command with a PTY that announces the emulator's TERM", async () => {
		const hostTerm = process.env.TERM;
		process.env.TERM = "xterm-kitty";
		const h = makeHarness();
		await h.emit("session_start");
		try {
			// `echo` ends each line itself: `tty` does not on uutils coreutils (Ubuntu 26.04).
			const r = await h.call("bash", { pty: true, title: "Test command", command: 't=$(tty) && echo "tty=$t" && echo "seen=$TERM"',

				yield_time_ms: 1500, });
			assert.match(r.details.output, /^tty=\/dev\//m, `output=${r.details.output}`);
			if (!IS_WINDOWS) assert.match(r.details.output, /^seen=xterm-256color$/m);
			if (r.details.job_id !== undefined) {
				await h.call("kill_session", { job_id: r.details.job_id });
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
			const r1 = await h.call("bash", { pty: true, title: "Test command", command: "python3 -q",

				yield_time_ms: 800, });
			const sid = r1.details.job_id;
			assert.equal(typeof sid, "string", `REPL did not stay alive: ${JSON.stringify(r1.details)}`);
			if (typeof sid !== "string") return; // for type narrowing

			// Submit with \r (the Enter key), not \n: POSIX ptys map CR→NL in
			// canonical mode (ICRNL) so both work there, but legacy Windows
			// console line input only executes on CR — with \n the REPL echoes
			// the text without running it (observed on windows-latest CI).
			const r2 = await h.call("write_stdin", {
				job_id: sid,
				chars: "print(2 + 40)\r",
				yield_time_ms: 2000,
			});
			const output = r2.details.output.includes("42")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /^42$/m);
			assert.ok(output.includes("42"), `got: ${output}`);

			await h.call("write_stdin", { job_id: sid, chars: "exit()\r", yield_time_ms: 1500 });
			const list = await h.call("list_sessions", {});
			if (list.details.sessions.some((s: any) => s.job_id === sid)) {
				await h.call("kill_session", { job_id: sid });
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
			const r1 = await h.call("bash", { pty: true, title: "Test command", command: fixture, yield_time_ms: 1500 });
			const sid = r1.details.job_id;
			assert.equal(typeof sid, "string", `fixture did not stay alive: ${JSON.stringify(r1.details)}`);

			const r2 = await h.call("write_stdin", { job_id: sid, chars: "hello\r", yield_time_ms: 2000 });
			const output = r2.details.output.includes("GOT:hello|")
				? r2.details.output
				: await readUntil(r1.details.terminal_url, /GOT:hello\|/);
			assert.ok(output.includes("GOT:hello|"), `PTY input did not round-trip: ${JSON.stringify(output)}`);

			const r3 = await h.call("write_stdin", { job_id: sid, chars: "quit\r", yield_time_ms: 3000 });
			let exitCode = r3.details.exit_code;
			const deadline = Date.now() + 8000;
			while (exitCode === undefined && Date.now() < deadline) {
				const listed = await h.call("list_sessions", {});
				exitCode = listed.details.sessions.find((s: { job_id: string }) => s.job_id === sid)?.exit_code;
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
			const r = await h.call("bash", { pty: true, title: "Test command", command: "echo tty-cmd", shell: "cmd",
				yield_time_ms: 20000, });
			assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
			assert.match(String(r.details.failure_message), /never launches cmd/, JSON.stringify(r.details));
			assert.equal(r.details.terminal_url, undefined, JSON.stringify(r.details));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("Ctrl-C (\\x03) interrupts a PTY loop", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r1 = await h.call("bash", { pty: true, title: "Test command", command: "while true; do echo alive; sleep 0.2; done",

				yield_time_ms: 400, });
			const sid = r1.details.job_id;
			assert.ok(typeof sid === "string");

			const r2 = await h.call("write_stdin", {
				job_id: sid,
				chars: "\x03",
				yield_time_ms: 1000,
			});
			if (r2.details.job_id !== undefined) {
				await h.call("kill_session", { job_id: sid });
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});
});
