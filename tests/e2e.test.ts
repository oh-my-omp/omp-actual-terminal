import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/tools/streaming-output";
import { activate, EmptyPollRemovedError } from "../src/index.ts";
import { readTerminal } from "../src/terminal-resource.ts";
import { IS_WINDOWS } from "../src/shell.ts";
import type { TerminalHost } from "../src/terminal-host.ts";
import { processEnv, STUB_SESSION, stubShellHost, stubTerminalHost } from "./stub-shell.ts";


interface ToolDef {
	name: string;
	description: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: any,
		ctx: any,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
	renderCall?: (...args: any[]) => unknown;
	renderResult?: (...args: any[]) => unknown;
}

function makeHarness(host: TerminalHost = stubTerminalHost()) {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Array<(event: any, ctx: any) => any>> = {};
	const sentMessages: Array<{ customType: string; content: string }> = [];
	const uiEvents = {
		notifications: [] as Array<{ message: string; type?: string }>,
		statuses: new Map<string, string | undefined>(),
		widgets: new Map<string, { content: string[] | undefined; options?: unknown }>(),
	};

	const stubCtx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string, type?: string) => uiEvents.notifications.push({ message, type }),
			setStatus: (key: string, value: string | undefined) => uiEvents.statuses.set(key, value),
			setWidget: (key: string, content: string[] | undefined, options?: unknown) =>
				uiEvents.widgets.set(key, { content, options }),
		},
		hasUI: false,
		...STUB_SESSION,
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
		sendMessage: (message: { customType: string; content: string }) => { sentMessages.push(message); },
	};

	const api = pi as unknown as Parameters<typeof activate>[0];
	activate(api, undefined, host, undefined, {}, undefined, undefined, undefined, stubShellHost);

	return {
		async call(toolName: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void) {
			const def = tools[toolName];
			if (!def) throw new Error(`no such tool: ${toolName}`);
			return def.execute("test-call-id", params, signal, onUpdate, stubCtx);
		},
		stubCtx,
		tools,
		sentMessages,
		uiEvents,
		async emit(event: string, evt: any = {}) {
			const results = [];
			for (const h of handlers[event] ?? []) results.push(await h(evt, stubCtx));
			return results;
		},
	};
}

function assertReportedShell(
	result: { content: Array<{ text: string }>; details: { shell?: string } },
	shell: string,
) {
	assert.equal(result.details.shell, shell);
	assert.ok(result.details && typeof result.details === "object" && "shell" in result.details);
	assert.equal(result.details.shell, shell);
	assert.ok(result.content[0].text.split("\n").includes(`shell: ${shell}`), result.content[0].text);
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cond()) return true;
		await delay(50);
	}
	return await cond();
}

describe("omp-actual-terminal e2e", () => {
	it("rejects zero-byte input before observation and preserves later input", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("bash", { pty: true, title: "Test command", command: "sleep 0.5; echo unobserved-marker; exec cat", yield_time_ms: 250 });
			const sid = started.details.job_id;
			const url: string = started.details.terminal_url;
			assert.ok(await waitFor(async () => (await readTerminal(url.slice(7))).screenLines.some((line) => line.includes("unobserved-marker"))));
			for (const input of [{}, { chars: "" }, { chars_b64: "" }, { chars_b64: " \n" }]) {
				await assert.rejects(h.call("write_stdin", { job_id: sid, ...input }), (error: unknown) => {
					assert.ok(error instanceof EmptyPollRemovedError);
					assert.equal(error.code, "empty_poll_removed");
					assert.ok(error.message.includes(`read ${url}`), error.message);
					assert.match(error.message, /monitor/);
					return true;
				});
			}
			const after = await h.call("write_stdin", { job_id: sid, chars: "after\n" });
			assert.equal(after.details.running, true);
			assert.match(after.details.output, /unobserved-marker/);
			assert.match(after.details.output, /after/);
			for (const input of [{}, { chars: "" }, { chars_b64: "" }]) {
				await assert.rejects(h.call("write_stdin", { job_id: "bg_0", ...input }), EmptyPollRemovedError);
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("leaves presentation hooks to the omp factory rather than the tool core", () => {
		const h = makeHarness();
		for (const name of ["bash", "write_stdin", "set_on_exit", "monitor", "kill_session", "list_sessions"]) {
			assert.equal(h.tools[name]?.renderCall, undefined, `${name} has a core renderCall`);
			assert.equal(h.tools[name]?.renderResult, undefined, `${name} has a core renderResult`);
		}
	});

	// PowerShell's cold start on hosted Windows runners can exceed Bun's default 5 s test timeout; the call itself yields up to 20 s.
	it("Windows: shell=powershell keeps its flags and shell=cmd is refused", { skip: !IS_WINDOWS, timeout: 45_000 }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "Write-Output ps-ok", shell: "powershell", yield_time_ms: 20000 });
		assert.equal(r1.details.exit_code, 0, `powershell details=${JSON.stringify(r1.details)}`);
		assert.ok(
			r1.details.output.includes("ps-ok"),
			`powershell output=${JSON.stringify(r1.details.output)} job_id=${r1.details.job_id}`,
		);
		const r2 = await h.call("bash", { pty: true, title: "Test command", command: "echo cmd-ok", shell: "cmd", yield_time_ms: 20000 });
		assert.equal(r2.details.job_id, undefined, JSON.stringify(r2.details));
		assert.match(String(r2.details.failure_message), /never launches cmd/, JSON.stringify(r2.details));
		assert.doesNotMatch(r2.details.output, /cmd-ok/);
		assert.match(h.uiEvents.notifications.at(-1)?.message ?? "", /session's shell/);
		await h.emit("session_shutdown");
	});

	it("POSIX: an explicit shell names the resolved interpreter", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const result = await h.call("bash", { pty: true, title: "Test command", command: 'printf "bash-version:%s\\n" "${BASH_VERSION:?not running bash}"',
				shell: "bash",
				yield_time_ms: 2000, });
			assert.equal(result.details.exit_code, 0, JSON.stringify(result.details));
			assert.match(result.details.output, /bash-version:\d/);
			const shell: unknown = result.details.shell;
			assert.ok(typeof shell === "string" && isAbsolute(shell), `unresolved shell: ${String(shell)}`);
			assertReportedShell(result, shell);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("POSIX: without shell the terminal is the session's shell, with its exports, functions and aliases", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness(stubTerminalHost({
			seed: async () => ({
				env: { ...processEnv(), UE_SEEDED: "from-session" },
				script: "shopt -s expand_aliases\ngreet() { printf 'hello-%s\\n' \"$1\"; }\nalias hi='printf alias-%s\\\\n'\n",
			}),
		}));
		try {
			await h.emit("session_start");
			for (const blank of [undefined, "", " \t\n "]) {
				const result = await h.call("bash", { pty: true, title: "Session shell", command: 'greet seed; hi ok; printf "env=%s\\n" "$UE_SEEDED"',
					...(blank === undefined ? {} : { shell: blank }),
					yield_time_ms: 2000, });
				assert.equal(result.details.exit_code, 0, JSON.stringify(result.details));
				assert.match(result.details.output, /hello-seed/);
				assert.match(result.details.output, /alias-ok/);
				assert.match(result.details.output, /env=from-session/);
				assertReportedShell(result, "pi-shell (session)");
			}
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("POSIX: an explicit shell keeps the session's exports but not its functions", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness(stubTerminalHost({
			seed: async () => ({ env: { ...processEnv(), UE_SEEDED: "from-session" }, script: "greet() { :; }\n" }),
		}));
		try {
			await h.emit("session_start");
			const result = await h.call("bash", { pty: true, title: "Explicit shell", command: 'printf "env=%s\\n" "$UE_SEEDED"; command -v greet || echo no-greet',
				shell: "/bin/sh",
				yield_time_ms: 2000, });
			assert.equal(result.details.exit_code, 0, JSON.stringify(result.details));
			assert.match(result.details.output, /env=from-session/);
			assert.match(result.details.output, /no-greet/);
			assertReportedShell(result, "/bin/sh");
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("a session shell that cannot report its state starts nothing", async () => {
		const h = makeHarness(stubTerminalHost({
			seed: async () => {
				throw new Error("seed refused");
			},
		}));
		try {
			await h.emit("session_start");
			const result = await h.call("bash", { pty: true, title: "No seed", command: "echo must-not-run" });
			assert.equal(result.details.job_id, undefined, JSON.stringify(result.details));
			assert.match(String(result.details.failure_message), /could not read the session shell's state: seed refused/);
			assert.doesNotMatch(result.details.output, /must-not-run/);
			const listed = await h.call("list_sessions", {});
			assert.equal(listed.details.running_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("a URL working directory needs the session's shell and an existing directory", async () => {
		const h = makeHarness(stubTerminalHost({
			urlPath: (path) => (path.startsWith("local://") ? path : undefined),
			urlDirectory: async (url) => (url === "local://dir" ? { kind: "directory" } : { kind: "missing" }),
		}));
		try {
			await h.emit("session_start");
			const explicit = await h.call("bash", { pty: true, title: "URL cwd", command: "echo must-not-run", shell: "/bin/sh", cwd: "local://dir" });
			assert.match(String(explicit.details.failure_message), /only the session's shell can enter/, JSON.stringify(explicit.details));
			const missing = await h.call("bash", { pty: true, title: "URL cwd", command: "echo must-not-run", cwd: "local://gone" });
			assert.equal(missing.details.failure_message, "Working directory does not exist: local://gone", JSON.stringify(missing.details));
			assert.equal(missing.details.cwd, "local://gone");
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("POSIX: a terminal keeps its shell through poll, list, kill and streams", { skip: IS_WINDOWS }, async () => {
		const h = makeHarness();
		try {
			await h.emit("session_start");
			const initialUpdates: Array<{ details: { shell?: string } }> = [];
			const started = await h.call("bash", { pty: true, title: "Test command", command: 'stty -echo; printf "interpreter:%s\\n" "$0"; while IFS= read -r line; do printf "reply:%s\\n" "$line"; done',
					shell: "/bin/sh",
					yield_time_ms: 1000, }, undefined,
				(partial: { details: { shell?: string } }) => initialUpdates.push(partial),);
			const sid: unknown = started.details.job_id;
			assert.equal(typeof sid, "string", JSON.stringify(started.details));
			assert.ok(typeof sid === "string");
			assert.match(started.details.output, /interpreter:\/bin\/sh/);
			assertReportedShell(started, "/bin/sh");
			assert.ok(initialUpdates.length > 0, "expected a streaming update from the live readline loop");
			assert.ok(initialUpdates.every((update) => update.details.shell === "/bin/sh"));

			const next = await h.call("bash", { pty: true, title: "Test command", command: 'printf "new-bash-version:%s\\n" "${BASH_VERSION:?not running bash}"',
				yield_time_ms: 2000, });
			assert.equal(next.details.exit_code, 0, JSON.stringify(next.details));
			assert.match(next.details.output, /new-bash-version:\d/);
			assertReportedShell(next, "pi-shell (session)");

			const pollUpdates: Array<{ details: { shell?: string } }> = [];
			const polled = await h.call(
				"write_stdin",
				{ job_id: sid, chars: "still-original\n", yield_time_ms: 1000 },
				undefined,
				(partial: { details: { shell?: string } }) => pollUpdates.push(partial),
			);
			assert.equal(polled.details.job_id, sid);
			assert.match(polled.details.output, /reply:still-original/);
			assertReportedShell(polled, "/bin/sh");
			assert.ok(pollUpdates.length > 0, "expected a streaming update while the old PTY remains live");
			assert.ok(pollUpdates.every((update) => update.details.shell === "/bin/sh"));

			const listed = await h.call("list_sessions", {});
			const entries: Array<{ job_id: string; shell?: string }> = listed.details.sessions;
			assert.equal(entries.find((entry) => entry.job_id === sid)?.shell, "/bin/sh");
			assert.ok(
				listed.details && typeof listed.details === "object" && "sessions" in listed.details,
			);
			assert.ok(Array.isArray(listed.details.sessions));
			const structuredEntry: unknown = listed.details.sessions.find(
				(entry: unknown) => typeof entry === "object" && entry !== null && "job_id" in entry && entry.job_id === sid,
			);
			assert.ok(structuredEntry && typeof structuredEntry === "object" && "shell" in structuredEntry);
			assert.equal(structuredEntry.shell, "/bin/sh");
			assert.ok(listed.content[0].text.includes("shell: /bin/sh"));

			const killed = await h.call("kill_session", { job_id: sid });
			assert.equal(killed.details.killed, true, JSON.stringify(killed.details));
			assertReportedShell(killed, "/bin/sh");
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("an explicit cmd is refused before anything spawns", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("bash", { pty: true, title: "Refused shell", command: "echo must-not-run", shell: "cmd.exe" });
			assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
			assert.equal(r.details.shell, "cmd.exe");
			assert.match(String(r.details.failure_message), /never launches cmd/, JSON.stringify(r.details));
			assert.doesNotMatch(r.details.output, /must-not-run/);
			assert.equal(h.uiEvents.notifications.length, 1, JSON.stringify(h.uiEvents.notifications));
			assert.match(h.uiEvents.notifications[0]?.message ?? "", /session's shell/);
			const listed = await h.call("list_sessions", {});
			assert.equal(listed.details.running_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("short-lived command returns exit_code and no job_id", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("bash", { pty: true, title: "Test command", command: "echo hello && echo world" });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.job_id, undefined);
		assert.ok(r.details.output.includes("hello"));
		assert.ok(r.details.output.includes("world"));
		await h.emit("session_shutdown");
	});

	it("process that exits BETWEEN calls remains readable through its terminal", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "for i in 1 2 3; do echo tock $i; sleep 0.2; done",
			yield_time_ms: 250, });
		assert.ok(
			typeof r1.details.job_id === "string",
			`first yield should return job_id; got ${JSON.stringify(r1.details)}`,
		);
		const sid = r1.details.job_id;

		await new Promise((r) => setTimeout(r, 800));

		const projection = await readTerminal(r1.details.terminal_url.slice(7));
		assert.ok(projection.screenLines.some((line) => line.includes("tock 3")));
		const listed = await h.call("list_sessions", {});
		assert.equal(listed.details.sessions.find((s: { job_id: string }) => s.job_id === sid)?.exit_code, 0);
		await h.emit("session_shutdown");
	});


	it("long-running command yields a session and monitor awaits completion", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "for i in 1 2 3 4 5; do echo tick $i; sleep 0.3; done",
			yield_time_ms: 600, });
		assert.equal(r1.details.exit_code, undefined, "should still be running");
		assert.ok(typeof r1.details.job_id === "string", `got job_id=${r1.details.job_id}`);
		const sid = r1.details.job_id;
		assert.ok(r1.details.output.includes("tick 1"), `first out: ${r1.details.output}`);

		const monitoring = await h.call("monitor", { job_id: sid });
		assert.equal(monitoring.details.status, "started");
		assert.ok(await waitFor(() => h.sentMessages.some((m) => m.customType === "omp-actual-terminal-notice" && m.content.includes("monitor ended:"))));
		const projection = await readTerminal(r1.details.terminal_url.slice(7));
		assert.ok(projection.screenLines.some((line) => line.includes("tick 5")));
		const listed = await h.call("list_sessions", {});
		assert.equal(listed.details.sessions.find((s: { job_id: string }) => s.job_id === sid)?.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("write_stdin sends input and terminal EOF to cat", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "stty -echo; exec cat",
			yield_time_ms: 300, });
		assert.ok(typeof r1.details.job_id === "string", `got ${JSON.stringify(r1.details)}`);
		const sid = r1.details.job_id;

		const r2 = await h.call("write_stdin", {
			job_id: sid,
			chars: "hello from stdin\n",
			yield_time_ms: 400,
		});
		assert.ok(r2.details.output.includes("hello from stdin"), `got ${JSON.stringify(r2.details)}`);
		assert.ok(typeof r2.details.job_id === "string");

		const r3 = await h.call("write_stdin", {
			job_id: sid,
			chars: "\x04",
			yield_time_ms: 5000,
		});
		assert.equal(r3.details.exit_code, 0);
		assert.equal(r3.details.job_id, undefined);
		await h.emit("session_shutdown");
	});

	it("kill_session terminates a stuck process", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 60",
			yield_time_ms: 300, });
		assert.ok(typeof r1.details.job_id === "string");
		const sid = r1.details.job_id;

		const t0 = Date.now();
		const r2 = await h.call("kill_session", { job_id: sid });
		const dt = Date.now() - t0;
		assert.ok(dt < 2500, `kill_session took too long: ${dt}ms`);
		assert.equal(r2.details.job_id, sid);
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, `details=${JSON.stringify(r2.details)}`);
		await h.emit("session_shutdown");
	});

	it("kill_session bounds delayed noisy output while the log retains the complete stream", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = await h.call("bash", { pty: true, title: "Test command", command: 'sleep 0.8; for i in $(seq 1 4000); do echo "kill-line-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; sleep 60',
				yield_time_ms: 250, });
			const sid = started.details.job_id;
			assert.ok(typeof sid === "string", JSON.stringify(started.details));
			const logPath = started.details.log_path;
			assert.ok(typeof logPath === "string");
			assert.ok(
				await waitFor(() => {
					try {
						return readFileSync(logPath, "utf8").includes("kill-line-4000-");
					} catch {
						return false;
					}
				}),
				"noisy command did not finish its output burst",
			);

			const killed = await h.call("kill_session", { job_id: sid });
			assert.equal(killed.details.operation, "kill_session");
			assert.equal(killed.details.status, "killed");
			assert.equal(killed.details.running, false);
			assert.equal(killed.details.killed, true);
			assert.equal(Object.hasOwn(killed.details, "final_output"), false);
			assert.ok(Buffer.byteLength(killed.details.output, "utf8") <= DEFAULT_MAX_BYTES);
			assert.ok(killed.details.output.split("\n").length <= killed.details.terminal.rows);
			assert.match(killed.details.output, /kill-line-4000-/);
			assert.match(killed.content[0].text, /^\[killed\]/);
			assert.ok(
				Buffer.byteLength(killed.content[0].text, "utf8") < DEFAULT_MAX_BYTES + 4096,
				`kill content unexpectedly large: ${Buffer.byteLength(killed.content[0].text, "utf8")}`,
			);

			const fullLog = readFileSync(logPath, "utf8");
			// Count by content, not line start: ConPTY (Windows) writes its own
			// init and window-title sequences in front of the first lines.
			const logged = new Set([...fullLog.matchAll(/kill-line-(\d+)-/g)].map((m) => Number(m[1])));
			assert.equal(logged.size, 4000);
			assert.ok(logged.has(1) && logged.has(4000));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("kill_session escalates to SIGKILL when SIGTERM is trapped", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "trap '' TERM; sleep 60",
			shell: "bash",
			yield_time_ms: 300, });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string");
		const r2 = await h.call("kill_session", { job_id: sid });
		if (IS_WINDOWS) {
			// Don't assert
			// on exit timing (taskkill on a loaded runner can exceed the 2s
			// window) — assert the retained session is no longer running instead.
			assert.equal(r2.details.escalated, false, `details=${JSON.stringify(r2.details)}`);
			const l = await h.call("list_sessions", {});
			assert.ok(
				!l.details.sessions.some((s: any) => s.job_id === sid && s.running),
				`session ${sid} still listed as running: ${JSON.stringify(l.details)}`,
			);
		} else {
			assert.equal(r2.details.escalated, true, `details=${JSON.stringify(r2.details)}`);
		}
		await h.emit("session_shutdown");
	});

	it("kill_session ends a session whose shell exited while a group member holds the terminal", { skip: process.platform !== "linux" }, async () => {
		const h = makeHarness();
		await h.emit("session_start");
		let bg = 0;
		try {
			const r1 = await h.call("bash", { pty: true, title: "Test command", command: "(trap '' HUP; exec sleep 300) & echo bg=$!; sleep 0.5",
				shell: "/bin/sh",
				yield_time_ms: 1500, });
			bg = Number(/bg=(\d+)/.exec(r1.details.output)?.[1]);
			assert.ok(bg > 0, r1.details.output);
			assert.match(r1.details.note ?? "", /shell has exited/, JSON.stringify(r1.details));
			const killed = await h.call("kill_session", { job_id: r1.details.job_id });
			assert.equal(killed.details.killed, true, JSON.stringify(killed.details));
			assert.throws(() => process.kill(bg, 0), "the held-open group member survived kill_session");
			bg = 0;
		} finally {
			if (bg > 0) {
				try {
					process.kill(bg, "SIGKILL");
				} catch {
				}
			}
			await h.emit("session_shutdown");
		}
	});

	it("list_sessions enumerates live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 300 });
		const r2 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 11", yield_time_ms: 300 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.running_count, 2, `details=${JSON.stringify(l.details)}`);
		const ids = l.details.sessions.map((s: any) => s.job_id);
		assert.ok(ids.includes(r1.details.job_id));
		assert.ok(ids.includes(r2.details.job_id));
		await h.call("kill_session", { job_id: r1.details.job_id });
		await h.call("kill_session", { job_id: r2.details.job_id });
		await h.emit("session_shutdown");
	});

	it("session_tree surfaces running sessions in the TUI", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 300 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string");

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("omp-actual-terminal.sessions"), "omp-actual-terminal: 1 session running");
		const widget = h.uiEvents.widgets.get("omp-actual-terminal.sessions");
		const widgetContent = widget?.content;
		if (!widgetContent) assert.fail(`widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent[0].includes("1 session still running"), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes(`${sid} `)), `widget=${JSON.stringify(widget)}`);
		assert.ok(widgetContent.some((line) => line.includes("set_on_exit") || line.includes("write_stdin")), `widget=${JSON.stringify(widget)}`);
		assert.ok(
			h.uiEvents.notifications.some((n) => n.type === "warning" && n.message.includes("still running after /tree")),
			`notifications=${JSON.stringify(h.uiEvents.notifications)}`,
		);

		await h.call("kill_session", { job_id: sid });
		assert.equal(h.uiEvents.statuses.get("omp-actual-terminal.sessions"), undefined);
		assert.equal(h.uiEvents.widgets.get("omp-actual-terminal.sessions")?.content, undefined);
		await h.emit("session_shutdown");
	});

	it("running-session footer clears automatically when a background process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string", `details=${JSON.stringify(r1.details)}`);
		assert.equal(h.uiEvents.statuses.get("omp-actual-terminal.sessions"), "omp-actual-terminal: 1 session running");

		// Poll, don't fixed-sleep: `sleep 0.4` can take >700ms wall time on a
		// loaded CI runner (observed on windows-latest).
		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("omp-actual-terminal.sessions") === undefined),
			`status did not clear: ${h.uiEvents.statuses.get("omp-actual-terminal.sessions")}`,
		);

		const r2 = await h.call("list_sessions", {});
		assert.equal(r2.details.sessions.find((s: { job_id: string }) => s.job_id === sid)?.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("post-tree running-session widget clears automatically when the process exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 0.4", yield_time_ms: 250 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string", `details=${JSON.stringify(r1.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.ok(h.uiEvents.widgets.get("omp-actual-terminal.sessions")?.content?.[0].includes("1 session still running"));

		// Poll, don't fixed-sleep (slow CI runners).
		assert.ok(
			await waitFor(() => h.uiEvents.widgets.get("omp-actual-terminal.sessions")?.content === undefined),
			`widget did not clear: ${JSON.stringify(h.uiEvents.widgets.get("omp-actual-terminal.sessions"))}`,
		);

		const r2 = await h.call("list_sessions", {});
		assert.equal(r2.details.sessions.find((s: { job_id: string }) => s.job_id === sid)?.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("running-session UI decrements when one of multiple sessions exits", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const short = await h.call("bash", { pty: true, title: "Test command", command: "sleep 1.2", yield_time_ms: 250 });
		const long = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 250 });
		const shortSid = short.details.job_id;
		const longSid = long.details.job_id;
		assert.ok(typeof shortSid === "string", `short=${JSON.stringify(short.details)}`);
		assert.ok(typeof longSid === "string", `long=${JSON.stringify(long.details)}`);

		await h.emit("session_tree", { oldLeafId: "old", newLeafId: "new" });
		assert.equal(h.uiEvents.statuses.get("omp-actual-terminal.sessions"), "omp-actual-terminal: 2 sessions running");

		assert.ok(
			await waitFor(() => h.uiEvents.statuses.get("omp-actual-terminal.sessions") === "omp-actual-terminal: 1 session running"),
			`status did not decrement: ${h.uiEvents.statuses.get("omp-actual-terminal.sessions")}`,
		);
		const widget = h.uiEvents.widgets.get("omp-actual-terminal.sessions")?.content?.join("\n") ?? "";
		assert.ok(widget.includes(`${longSid} `), `widget=${widget}`);
		assert.ok(!widget.includes(`${shortSid} `), `widget=${widget}`);

		const listed = await h.call("list_sessions", {});
		assert.equal(listed.details.sessions.find((s: { job_id: string }) => s.job_id === shortSid)?.exit_code, 0);
		await h.call("kill_session", { job_id: longSid });
		await h.emit("session_shutdown");
	});

	it("session_shutdown terminates all live sessions", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 200 });
		const r2 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 11", yield_time_ms: 200 });
		assert.ok(r1.details.job_id);
		assert.ok(r2.details.job_id);
		await h.emit("session_shutdown");
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.running_count, 0);
	});

	it("session_shutdown does not notify when only already-exited terminals remain in the store, and counts only live ones otherwise", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const finished = await h.call("bash", { pty: true, title: "ShortBG", command: "sleep 0.4; echo done-short", yield_time_ms: 250 });
		assert.equal(finished.details.status, "running");
		assert.ok(await waitFor(async () => {
			const l = await h.call("list_sessions", {});
			return l.details.running_count === 0 && l.details.returned_count === 1;
		}));
		h.uiEvents.notifications.length = 0;
		await h.emit("session_shutdown");
		assert.equal(
			h.uiEvents.notifications.some((n) => /terminated \d+ live session/.test(n.message)),
			false,
			JSON.stringify(h.uiEvents.notifications),
		);

		await h.emit("session_start");
		const finished2 = await h.call("bash", { pty: true, title: "ShortBG2", command: "sleep 0.4; echo done-short2", yield_time_ms: 250 });
		assert.equal(finished2.details.status, "running");
		assert.ok(await waitFor(async () => {
			const l = await h.call("list_sessions", {});
			return l.details.running_count === 0 && l.details.returned_count === 1;
		}));
		const live = await h.call("bash", { pty: true, title: "LiveBG", command: "sleep 10", yield_time_ms: 250 });
		assert.equal(live.details.status, "running");
		h.uiEvents.notifications.length = 0;
		await h.emit("session_shutdown");
		const shutdownNotices = h.uiEvents.notifications.filter((n) => /terminated \d+ live session/.test(n.message));
		assert.equal(shutdownNotices.length, 1, JSON.stringify(h.uiEvents.notifications));
		assert.match(shutdownNotices[0].message, /terminated 1 live session\(s\) on shutdown/);
	});

	it("session_shutdown racing a terminal's creation does not orphan the child", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const inflight = h.call("bash", { pty: true, title: "Test command", command: "sleep 30", yield_time_ms: 500 });
		await new Promise((r) => setTimeout(r, 40)); // inside the grace window
		await h.emit("session_shutdown");
		const r = await inflight;
		assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
		const reportedExit = r.details.exit_code != null || Boolean(r.details.signal);
		const unconfirmed = r.details.running === true && /exit not confirmed/.test(r.details.failure_message ?? "");
		assert.ok(reportedExit || unconfirmed, JSON.stringify(r.details));
		await h.emit("session_start");
		const l = await h.call("list_sessions", {});
		assert.deepEqual(l.details.sessions, [], JSON.stringify(l.details));
		await h.emit("session_shutdown");
	});

	it("a session in the grace window at shutdown never reaches the next session period", { skip: IS_WINDOWS }, async () => {
		const marker = `30.${process.pid}${Date.now() % 1000}`;
		const readyDir = mkdtempSync(join(tmpdir(), "oat-trap-ready-"));
		const ready = join(readyDir, "ready");
		try {
			const h = makeHarness();
			await h.emit("session_start");
			let returned = false;
			const inflight = h.call("bash", { pty: true, title: "Test command", command: `trap '' TERM HUP; : > '${ready}'; sleep ${marker}`, shell: "/bin/bash", yield_time_ms: 500 });
			inflight.then(() => { returned = true; }, () => { returned = true; });
			while (!existsSync(ready) && !returned) await delay(5);
			const pending = await h.call("list_sessions", {});
			assert.ok(!returned && pending.details.sessions.length === 0, "the session left its grace window before the shell ignored SIGTERM");
			await h.emit("session_shutdown");
			const r = await inflight;
			assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
			assert.equal(r.details.signal, "SIGKILL", JSON.stringify(r.details));
			assert.equal(r.details.shell, "/bin/bash", JSON.stringify(r.details));
			await h.emit("session_start");
			const l = await h.call("list_sessions", {});
			assert.deepEqual(l.details.sessions, [], JSON.stringify(l.details));
			assert.throws(() => execFileSync("pgrep", ["-f", `slee[p] ${marker}`]), "trapping child must be dead");
			await h.emit("session_shutdown");
		} finally {
			rmSync(readyDir, { recursive: true, force: true });
		}
	});

	it("an in-flight write_stdin whose terminal shutdown released before the child died returns empty output", { skip: IS_WINDOWS }, async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const h = makeHarness();
			await h.emit("session_start");
			const r1 = await h.call("bash", { pty: true, title: "Test command", command: "trap '' TERM HUP; echo trap-ready; sleep 30", yield_time_ms: 250 });
			const sid = r1.details.job_id;
			assert.ok(typeof sid === "string", JSON.stringify(r1.details));
			const logPath: string = r1.details.log_path;
			assert.ok(await waitFor(() => readFileSync(logPath, "utf8").includes("trap-ready")), "SIGTERM trap was not installed");
			const listed: Array<{ job_id: string; pid: number }> = (await h.call("list_sessions", {})).details.sessions;
			const pid = listed.find((s) => s.job_id === sid)?.pid;
			assert.ok(typeof pid === "number");

			const inflight = h.call("write_stdin", { job_id: sid, chars: "x", yield_time_ms: 500 });
			await h.emit("session_shutdown"); // releases the terminal now; returns after the SIGKILL escalation
			const r = await inflight;
			assert.equal(r.details.running, true, JSON.stringify(r.details));
			assert.equal(r.details.output, "");
			assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
			assert.deepEqual(unhandled.map(String), []);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("a terminal is refused after session_shutdown until the next session_start", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await h.emit("session_shutdown");
		await assert.rejects(() => h.call("bash", { pty: true, title: "Test command", command: "echo nope" }), /shutting down/);
		await h.emit("session_start");
		const r = await h.call("bash", { pty: true, title: "Test command", command: "echo back" });
		assert.equal(r.details.exit_code, 0);
		await h.emit("session_shutdown");
	});

	it("session_switch to a new or different session clears running and returned terminals and suppresses old notices, while session_branch and same-session reload keep them", async () => {
		const h = makeHarness();
		let currentSessionFile = "/tmp/omp-session-a.jsonl";
		const mgr = h.stubCtx.sessionManager as { getSessionFile?: () => string | undefined };
		const prevGetSessionFile = mgr.getSessionFile;
		mgr.getSessionFile = () => currentSessionFile;
		await h.emit("session_start");
		try {
			const exited = await h.call("bash", { pty: true, title: "PrevExited", command: "sleep 0.4; exit 3", yield_time_ms: 250, on_exit: "wake" });
			assert.equal(exited.details.status, "running");
			assert.ok(await waitFor(async () => {
				const l = await h.call("list_sessions", {});
				return l.details.running_count === 0 && l.details.returned_count === 1;
			}));
			const live = await h.call("bash", { pty: true, title: "PrevLive", command: "sleep 15", yield_time_ms: 250, on_exit: "wake" });
			assert.equal(live.details.status, "running");
			const livePid = (await h.call("list_sessions", {})).details.sessions.find((s: { job_id: string }) => s.job_id === live.details.job_id)?.pid;

			// session_branch keeps current session's terminals intact.
			await h.emit("session_branch", { type: "session_branch" });
			assert.equal((await h.call("list_sessions", {})).details.sessions.length, 2);

			// Same-session reload (resume to same sessionFile) keeps terminals intact.
			await h.emit("session_switch", { type: "session_switch", reason: "resume", previousSessionFile: currentSessionFile });
			assert.equal((await h.call("list_sessions", {})).details.sessions.length, 2);

			// /new (session_switch reason="new") resets the runtime completely.
			const prevFile = currentSessionFile;
			currentSessionFile = "/tmp/omp-session-b.jsonl";
			h.sentMessages.length = 0;
			await h.emit("session_switch", { type: "session_switch", reason: "new", previousSessionFile: prevFile });
			const afterNew = await h.call("list_sessions", {});
			assert.deepEqual(afterNew.details.sessions, [], JSON.stringify(afterNew.details));
			if (typeof livePid === "number" && !IS_WINDOWS) {
				assert.throws(() => process.kill(livePid, 0), /ESRCH/, `old live pid ${livePid} must be terminated on /new`);
			}
			// No notice or wake leaks from the previous session into the new one.
			await h.emit("agent_end", { willContinue: false, awaitingAsyncWork: false });
			await delay(300);
			assert.deepEqual(h.sentMessages, [], JSON.stringify(h.sentMessages));

			// Switching to another existing session (reason="resume" with different file) also resets.
			const sessB = await h.call("bash", { pty: true, title: "SessBLive", command: "sleep 15", yield_time_ms: 250 });
			assert.equal(sessB.details.status, "running");
			const prevFileB = currentSessionFile;
			currentSessionFile = "/tmp/omp-session-c.jsonl";
			await h.emit("session_switch", { type: "session_switch", reason: "resume", previousSessionFile: prevFileB });
			const afterResume = await h.call("list_sessions", {});
			assert.deepEqual(afterResume.details.sessions, [], JSON.stringify(afterResume.details));
		} finally {
			mgr.getSessionFile = prevGetSessionFile;
			await h.emit("session_shutdown");
		}
	});

	for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
		it(`session_shutdown reason=${reason} terminates live sessions`, async () => {
			const h = makeHarness();
			await h.emit("session_start");
			const r = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 200 });
			assert.ok(r.details.job_id);
			await h.emit("session_shutdown", {
				type: "session_shutdown",
				reason,
				targetSessionFile: reason === "new" || reason === "resume" || reason === "fork" ? "/tmp/next.jsonl" : undefined,
			});
			const l = await h.call("list_sessions", {});
			assert.equal(l.details.running_count, 0);
		});
	}

	it("external abort breaks the yield but leaves session alive", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const ac = new AbortController();
		const promise = h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 30_000 }, ac.signal,);
		setTimeout(() => ac.abort(), 100);
		const t0 = Date.now();
		const r = await promise;
		const dt = Date.now() - t0;
		assert.ok(dt < 2000, `should have returned near abort time; dt=${dt}`);
		assert.ok(typeof r.details.job_id === "string", `${JSON.stringify(r.details)}`);
		const sid = r.details.job_id;
		const list = await h.call("list_sessions", {});
		assert.ok(list.details.sessions.some((s: any) => s.job_id === sid));
		await h.call("kill_session", { job_id: sid });
		await h.emit("session_shutdown");
	});

	it("unknown job_id throws", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(
			() => h.call("write_stdin", { job_id: "bg_9999", chars: "hi\n" }),
			/unknown job_id/,
		);
		await h.emit("session_shutdown");
	});

	it("kill_session on unknown id returns found: false", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("kill_session", { job_id: "bg_9999" });
		assert.equal(r.details.found, false);
		await h.emit("session_shutdown");
	});

	it("response includes cwd, command, yield_time_ms in details and header", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("bash", { pty: true, title: "Test command", command: "echo ok", yield_time_ms: 2000 });
		assert.equal(r.details.exit_code, 0);
		assert.equal(r.details.cwd, process.cwd());
		assert.equal(r.details.command, "echo ok");
		assert.equal(r.details.yield_time_ms, 2000);
		assert.ok(r.content[0].text.includes(`cwd: ${process.cwd()}`), `cwd header missing: ${r.content[0].text}`);
		await h.emit("session_shutdown");
	});

	it("short command includes a persistent log_path in details", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r = await h.call("bash", { pty: true, title: "Test command", command: "echo hello" });
		assert.equal(r.details.exit_code, 0);

		assert.ok(typeof r.details.log_path === "string" && r.details.log_path.length > 0, `log_path missing: ${JSON.stringify(r.details)}`);
		assert.ok(existsSync(r.details.log_path), `log file should exist: ${r.details.log_path}`);
		const logContent = readFileSync(r.details.log_path, "utf-8");
		assert.ok(logContent.includes("hello"), `log content: ${logContent}`);
		await h.emit("session_shutdown");
	});



	it("list_sessions entries include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 200 });
		const l = await h.call("list_sessions", {});
		assert.equal(l.details.running_count, 1);
		const entry = l.details.sessions[0];
		assert.equal(entry.job_id, r1.details.job_id);
		assert.equal(entry.log_path, r1.details.log_path);
		assert.ok(existsSync(entry.log_path));
		await h.call("kill_session", { job_id: r1.details.job_id });
		await h.emit("session_shutdown");
	});

	it("kill_session details include log_path", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 10", yield_time_ms: 200 });
		const sid = r1.details.job_id;
		const r2 = await h.call("kill_session", { job_id: sid });
		assert.equal(r2.details.log_path, r1.details.log_path);
		await h.emit("session_shutdown");
	});

	it("an invalid explicit shell fails without running a fallback", async () => {
		const h = makeHarness();
		const missingShell = "definitely-not-a-real-shell-xyz";
		try {
			await h.emit("session_start");
			const args = { pty: true, title: "Unavailable shell", command: "echo fallback-must-not-run", shell: missingShell };
			if (IS_WINDOWS) {
				await assert.rejects(() => h.call("bash", args), /not found on PATH/);
			} else {
				const result = await h.call("bash", args);
				assert.equal(result.details.job_id, undefined, JSON.stringify(result.details));
				assert.match(String(result.details.failure_message), /ENOENT/);
				assert.notEqual(result.details.exit_code, 0);
				assert.doesNotMatch(result.details.output, /fallback-must-not-run/);
				assertReportedShell(result, missingShell);
			}
			const listed = await h.call("list_sessions", {});
			assert.equal(listed.details.running_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("a relative workdir resolves against the session cwd and an unusable one never spawns", async () => {
		const root = mkdtempSync(join(tmpdir(), "uexec-workdir-"));
		try {
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "f"), "");
			const h = makeHarness();
			h.stubCtx.cwd = root;
			await h.emit("session_start");
			const ok = await h.call("bash", { pty: true, title: "Test command", command: "pwd", cwd: "sub" });
			assert.equal(ok.details.cwd, join(root, "sub"), JSON.stringify(ok.details));
			assert.equal(ok.details.exit_code, 0, JSON.stringify(ok.details));
			for (const [workdir, message] of [
				["nope", `Working directory does not exist: ${join(root, "nope")}`],
				["f", `Working directory is not a directory: ${join(root, "f")}`],
			] as const) {
				const marker = join(root, `ran-${workdir}`);
				const r = await h.call("bash", { pty: true, title: "Test command", command: `echo > "${marker}"`, cwd: workdir });
				assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
				assert.equal(r.details.failure_message, message, JSON.stringify(r.details));
				assert.equal(existsSync(marker), false, "nothing may run for an unusable workdir");
			}
			await h.emit("session_shutdown");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});


	it("kill_session normalizes signal names (lowercase, no SIG prefix)", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 60", yield_time_ms: 300 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string");
		const r2 = await h.call("kill_session", { job_id: sid, signal: "term" });
		assert.equal(r2.details.job_id, sid);
		assert.ok(r2.details.signal === "SIGTERM" || r2.details.exit_code != null, JSON.stringify(r2.details));
		await h.emit("session_shutdown");
	});

	it("kill_session rejects unknown signal names instead of silently no-opping", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		await assert.rejects(() => h.call("kill_session", { job_id: "bg_1", signal: "BOGUS" }), /unknown signal/);
		await h.emit("session_shutdown");
	});

	it("list_sessions retains returned sessions with exit info until lifecycle reclamation", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "sleep 0.3", yield_time_ms: 250 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string", JSON.stringify(r1.details));
		assert.ok(await waitFor(() => h.uiEvents.statuses.get("omp-actual-terminal.sessions") === undefined), "exit was not observed");

		const l1 = await h.call("list_sessions", {});
		assert.equal(l1.details.running_count, 0, JSON.stringify(l1.details));
		const entry = l1.details.sessions.find((s: any) => s.job_id === sid);
		assert.ok(entry, `returned session should remain listed: ${JSON.stringify(l1.details)}`);
		assert.equal(entry.running, false);
		assert.equal(entry.exit_code, 0);
		assert.equal(entry.title, "Test command");
		assert.equal(l1.details.returned_count, 1);
		assert.equal(entry.lifecycle.returned, "normally");

		const l2 = await h.call("list_sessions", {});
		assert.equal(l2.details.sessions.length, 1, JSON.stringify(l2.details));
		assert.equal(l2.details.sessions[0].job_id, sid);
		assert.equal(l2.details.sessions[0].running, false);
		await h.emit("session_shutdown");
	});

	it("session_shutdown SIGKILLs children that trap SIGTERM", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const r1 = await h.call("bash", { pty: true, title: "Test command", command: "trap '' TERM; sleep 30", shell: "bash", yield_time_ms: 300 });
		const sid = r1.details.job_id;
		assert.ok(typeof sid === "string", JSON.stringify(r1.details));
		const l = await h.call("list_sessions", {});
		const pid = l.details.sessions.find((s: any) => s.job_id === sid)?.pid;
		assert.ok(typeof pid === "number");

		await h.emit("session_shutdown");
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), /ESRCH/, `pid ${pid} should be dead after shutdown`);
	});

	it("onUpdate streams growing partial output while running", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const updates: any[] = [];
		const r = await h.call("bash", { pty: true, title: "Test command", command: "for i in 1 2 3 4; do echo beat-$i; sleep 0.25; done", yield_time_ms: 1500 }, undefined,
			(partial: any) => updates.push(partial),);
		assert.ok(updates.length >= 2, `expected >=2 partial updates; got ${updates.length}`);
		const first = updates[0];
		const last = updates[updates.length - 1];
		assert.ok(typeof first.details.output === "string");
		assert.ok(last.details.output.length >= first.details.output.length, "output should grow");
		assert.ok(last.details.output.includes("beat-1"), last.details.output);
		assert.ok(
			updates.every((u) => typeof u.details.job_id === "string"),
			"partial updates should carry job_id",
		);
		if (r.details.job_id !== undefined) {
			await h.call("kill_session", { job_id: r.details.job_id });
		}
		await h.emit("session_shutdown");
	});

	it("onUpdate sends no repeat while the screen, exit state and byte count stay unchanged", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		const updates: any[] = [];
		const r = await h.call("bash", { pty: true, title: "Test command", command: "echo quiet-start; sleep 30", yield_time_ms: 2000 }, undefined,
			(partial: any) => updates.push(partial));
		assert.ok(updates.length >= 1, "the first tick still streams the screen");
		assert.ok(updates.at(-1).details.output.includes("quiet-start"), updates.at(-1).details.output);
		for (let i = 1; i < updates.length; i++) {
			assert.notDeepEqual(updates[i], updates[i - 1], `update ${i} repeats update ${i - 1}`);
		}
		assert.ok(updates.length <= 3, `silence streams no repeats; got ${updates.length} updates`);
		await h.call("kill_session", { job_id: r.details.job_id });
		await h.emit("session_shutdown");
	});
});

describe("bash without a terminal", () => {
	it("hands a call without pty, or a named service, to omp's own bash unchanged", async () => {
		const h = makeHarness();
		const invoked: unknown[] = [];
		const native = { content: [{ type: "text", text: "native-result" }], details: { native: true } };
		Object.assign(h.stubCtx, { invokeTool: async (params: unknown) => { invoked.push(params); return native; } });
		await h.emit("session_start");
		try {
			for (const params of [
				{ command: "echo plain" },
				{ command: "echo plain", pty: false, timeout: 5, async: true, notify: "x" },
				{ command: "python3 -m http.server", pty: true, name: "svc", ready: { port: 8000 } },
			]) {
				invoked.length = 0;
				assert.equal(await h.call("bash", params), native);
				assert.deepEqual(invoked, [params]);
			}
			const listed = await h.call("list_sessions", {});
			assert.equal(listed.details.running_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("refuses terminal fields on a call that opens no terminal", async () => {
		const h = makeHarness();
		Object.assign(h.stubCtx, { invokeTool: async () => assert.fail("a refused call must not reach omp's bash") });
		await h.emit("session_start");
		try {
			await assert.rejects(h.call("bash", { command: "echo x", title: "t", yield_time_ms: 10 }), /`title`, `yield_time_ms` only apply with `pty: true`/);
			await assert.rejects(h.call("bash", { command: "echo x", title: "t" }), /`title` only applies with `pty: true`; drop it,/);
			await assert.rejects(h.call("bash", { command: "x", pty: true, name: "svc", shell: "/bin/sh" }), /`shell` only applies to a terminal/);
			await assert.rejects(h.call("bash", { command: "echo x", workdir: "/" }), /bash: /);
			await assert.rejects(h.call("bash", { command: "echo x", pty: true, title: "t", on_exit: "always" }), /on_exit/);
			await assert.rejects(h.call("bash", { command: "echo x", pty: true, title: "t", ready: { port: 1 } }), /`ready` only applies to a named service/);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("names the missing host seam when omp passes no invokeTool", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			await assert.rejects(h.call("bash", { command: "echo x" }), /no ctx\.invokeTool; requalify/);
		} finally {
			await h.emit("session_shutdown");
		}
	});
});

describe("bash pty fields", { skip: IS_WINDOWS }, () => {
	it("requires notify to be a valid JavaScript regex", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			await assert.rejects(h.call("bash", { command: "echo x", pty: true, title: "t", notify: "(" }), /`notify` is not a valid JavaScript regex/);
			const listed = await h.call("list_sessions", {});
			assert.equal(listed.details.running_count, 0);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("ends a terminal at its timeout and reports an abnormal return", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = Date.now();
			const r = await h.call("bash", { command: "echo before-deadline; sleep 30", pty: true, title: "Deadline", timeout: 1, yield_time_ms: 6000 });
			assert.ok(Date.now() - started < 5000, "the deadline, not the yield, must end the call");
			assert.equal(r.details.job_id, undefined, JSON.stringify(r.details));
			assert.equal(r.details.status, "exited");
			assert.match(r.details.output, /before-deadline/);
			assert.match(String(r.details.failure_message), /timeout: ended after 1s/);
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("returns a detached terminal at once with async", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = Date.now();
			const r = await h.call("bash", { command: "sleep 30", pty: true, title: "Detached", async: true });
			assert.ok(Date.now() - started < 1000, `async waited ${Date.now() - started}ms`);
			assert.equal(typeof r.details.job_id, "string", JSON.stringify(r.details));
			assert.equal(r.details.status, "running");
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("starts a monitor on the terminal with notify", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const r = await h.call("bash", { command: "sleep 30", pty: true, title: "Notify", notify: "ready-line", yield_time_ms: 250 });
			assert.equal(typeof r.details.job_id, "string", JSON.stringify(r.details));
			assert.match(String(r.details.monitor), /^started /, JSON.stringify(r.details));
			assert.match(r.content[0].text, /monitor: started /);
			const listed = await h.call("list_sessions", {});
			const entry = listed.details.sessions.find((s: { job_id: string }) => s.job_id === r.details.job_id);
			assert.ok(entry?.monitor, JSON.stringify(listed.details));
		} finally {
			await h.emit("session_shutdown");
		}
	});

	it("clamps yield_time_ms: 0 to the 250ms lower bound instead of falling back to the 10s default", async () => {
		const h = makeHarness();
		await h.emit("session_start");
		try {
			const started = Date.now();
			const r = await h.call("bash", { command: "sleep 3; echo y0-done", pty: true, title: "YieldZero", yield_time_ms: 0 });
			const elapsed = Date.now() - started;
			assert.ok(elapsed < 1500, `yield_time_ms: 0 waited ${elapsed}ms instead of clamping to 250ms`);
			assert.equal(r.details.status, "running", JSON.stringify(r.details));
			assert.equal(typeof r.details.job_id, "string", JSON.stringify(r.details));
			assert.equal(r.details.yield_time_ms, 250, JSON.stringify(r.details));
		} finally {
			await h.emit("session_shutdown");
		}
	});
});
