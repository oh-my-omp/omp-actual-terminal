import type { FinalScreenOutput } from "../src/collect.ts";
import { TerminalGrid } from "../src/terminal-screen.ts";


import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionRender,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { DEFAULT_MAX_LINES } from "@oh-my-pi/pi-coding-agent/tools/streaming-output";
import { Type } from "@oh-my-pi/omptype/typebox";
import { isUiNode, setNativeRenderingForTest } from "@oh-my-pi/pi-tui";
import type { UiNode } from "@oh-my-pi/pi-tui";

import {
	bashToolHooks,
	killShellArgs,
	parseResultView,
	presentOnOmp,
	toShellResult,
	type ActivatedExtension,
	withHostPresentation,
	writeStdinShellArgs,
} from "../src/omp-presentation.ts";
import { SessionStore } from "../src/session-store.ts";
import {
	finalizeKillResult,
	finalizeProcessResult,
	renderKillResultText,
	renderProcessResultText,
	truncationMarker,
	type FinalizeKillInput,
	type FinalizeProcessInput,
	type ProcessResultDetails,
} from "../src/tool-result.ts";


function finalScreen(text: string): FinalScreenOutput {
	const lines = text.split("\n");
	return {
		kind: "final-screen",
		terminalUrl: "term://test",
		projection: {
			view: { screen: "normal", cols: 120, rows: lines.length, cursor: { row: 1, col: 1 } },
			retainedLines: lines, screenLines: lines, grid: new TerminalGrid(0, 0, new Uint32Array(0), []), appearance: "dark", historyMayBeTruncated: false,
		},
	};
}


const exitedDetails: ProcessResultDetails = {
	chunk_id: "86445f",
	wall_time_seconds: 0.007,
	output: "ok\n",
	original_token_count: 1,
	log_path: "/tmp/omp-presentation-exit.log",
	output_bytes_total: 3,
	operation: "bash",
	status: "exited",
	running: false,
	exit_code: 0,
	cwd: "/repo",
	command: "echo ok",
	yield_time_ms: 10000,
};

const processInput: FinalizeProcessInput = {
	operation: "bash",
	wallTimeSec: 0.25,
	collected: finalScreen("last output\n"),
	jobId: undefined,
	exitCode: 0,
	signal: null,
	failure: null,
	logPath: "/tmp/omp-presentation-process.log",
};

const killInput: FinalizeKillInput = {
	wallTimeSec: 0.003,
	collected: finalScreen("last output\n"),
	totalBytes: 12,
	jobId: "bg_1",
	pid: 45828,
	requestedSignal: "SIGTERM",
	exitCode: undefined,
	signal: "SIGTERM",
	failure: null,
	logPath: "/tmp/omp-presentation-kill.log",
	cwd: "/repo",
	command: "cat",
	escalated: false,
	killed: true,
};

function processView(details: ProcessResultDetails) {
	return parseResultView({
		details,
		content: [{ type: "text", text: renderProcessResultText(details) }],
		isError: false,
	}, false);
}

const noisyOutput = Array.from({ length: DEFAULT_MAX_LINES + 1000 }, (_, index) => `line-${index + 1}`).join("\n");

describe("omp shell result presentation", () => {
	it("presents a zero exit as output only, with milliseconds and a successful exit code", () => {
		const view = processView(exitedDetails);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: exitedDetails.output }],
			details: { exitCode: 0, wallTimeMs: exitedDetails.wall_time_seconds * 1000 },
			isError: false,
		});
	});

	it("classifies a nonzero exit as an error even when the tool envelope is not an error", () => {
		const details = { ...exitedDetails, output: "boom\n", exit_code: 3, command: "echo boom; exit 3" };
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "boom\n" }],
			details: { exitCode: 3, wallTimeMs: 7 },
			isError: true,
		});
	});

	for (const operation of ["bash", "write_stdin"] as const) {
		it(`presents a yielded live ${operation} result as backgrounded`, () => {
			const details: ProcessResultDetails = {
				chunk_id: "6cba2f",
				wall_time_seconds: 0.501,
				output: "",
				original_token_count: 0,
				log_path: "/tmp/omp-presentation-live.log",
				output_bytes_total: 0,
				operation,
				status: "running",
				running: true,
				job_id: "bg_1",
				cwd: "/repo",
				command: "sleep 3; echo done",
				tool_time_utc: "2026-10-10T11:34:59.455Z",
			};
			const view = processView(details);
			assert.equal(view.kind, "backgrounded");
			assert.deepEqual(toShellResult(view), {
				content: [{ type: "text", text: "" }],
				details: { wallTimeMs: 501, async: { state: "running", jobId: "bg_1", type: "bash" } },
				isError: false,
			});
		});
	}

	it("presents partial details as streaming without terminal or background metadata", () => {
		const details = {
			job_id: "bg_1",
			pid: 45842,
			running: true,
			total_bytes: 18,

			command: "printf 'update-1\\n'; sleep 0.35; printf 'update-2\\n'",
			cwd: "/repo",
			log_path: "/tmp/omp-presentation-stream.log",
			output: "update-1\nupdate-2\n",
		};
		const view = parseResultView({ details, content: [{ type: "text", text: details.output }] }, true);
		assert.deepEqual(view, { kind: "streaming", output: details.output });
		const result = toShellResult(view);
		assert.deepEqual(result, { content: [{ type: "text", text: details.output }], details: {}, isError: false });
		for (const field of ["exitCode", "wallTimeMs", "async"]) {
			assert.equal(Object.hasOwn(result.details, field), false);
		}
	});

	it("appends the exact recovery marker after a blank line and keeps it last", () => {
		const details = finalizeProcessResult({
			...processInput,
			collected: finalScreen(noisyOutput),
		});
		const marker = truncationMarker(details.truncation, details.log_path);
		assert.equal(details.truncation?.truncated, true);
		const total = DEFAULT_MAX_LINES + 1000;
		assert.equal(marker, `[Showing lines 1001-${total} of ${total}. Full output: ${details.log_path}]`);
		const result = toShellResult(processView(details));
		assert.equal(result.content[0].text, `${details.output.replace(/\n+$/, "")}\n\n${marker}`);
		assert.equal(result.content[0].text.split("\n").at(-1), marker);
		assert.equal(result.isError, false);
	});

	it("shows a nonexistent-workdir failure and marks it as an error", () => {
		const failure = "process error: ENOENT: no such file or directory, posix_spawn 'bash' (check shell binary and workdir: /definitely/not/a/real/dir)";
		const details: ProcessResultDetails = {
			...exitedDetails,
			output: "",
			exit_code: undefined,
			wall_time_seconds: 0.001,
			failure_message: failure,
			cwd: "/definitely/not/a/real/dir",
			command: "echo hi",
		};
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: `[failure: ${failure}]` }],
			details: { exitCode: undefined, wallTimeMs: 1 },
			isError: true,
		});
	});

	it("marks signal-terminated exec as an error and shows its signal", () => {
		const details = finalizeProcessResult({ ...processInput, exitCode: undefined, signal: "SIGTERM" });
		const view = processView(details);
		assert.equal(view.kind, "exited");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "last output\n\n[signal: SIGTERM]" }],
			details: { exitCode: undefined, wallTimeMs: 250 },
			isError: true,
		});
	});

	it("does not treat the expected SIGTERM from successful kill as an error", () => {
		const details = finalizeKillResult(killInput);
		assert.equal(details.signal, "SIGTERM");
		const view = parseResultView({ details, content: [{ type: "text", text: renderKillResultText(details) }] }, false);
		assert.equal(view.kind, "killed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: details.output }],
			details: { wallTimeMs: 3 },
			isError: false,
		});
	});

	it("shows SIGKILL escalation without making a successful kill an error", () => {
		const details = finalizeKillResult({ ...killInput, escalated: true, signal: "SIGKILL" });
		const view = parseResultView({ details, content: [] }, false);
		assert.equal(view.kind, "killed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "last output\n\n[escalated to SIGKILL]" }],
			details: { wallTimeMs: 3 },
			isError: false,
		});
	});

	it("shows failed kill diagnostics and marks the result as an error", () => {
		const failure = "process still running; session remains registered";
		const details = finalizeKillResult({ ...killInput, killed: false, signal: null, failure, escalated: true });
		const view = parseResultView({ details, content: [] }, false);
		assert.equal(view.kind, "kill_failed");
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: `last output\n\n[kill failed: ${failure}]` }],
			details: { wallTimeMs: 3 },
			isError: true,
		});
	});

	for (const isError of [false, undefined]) {
		it(`marks no-such-session kill as an error with outer isError=${isError}`, () => {
			const view = parseResultView({
				details: { operation: "kill_session", status: "kill_failed", running: false, job_id: "bg_9", found: false },
				content: [{ type: "text", text: "No such terminal: bg_9" }],
				isError,
			}, false);
			assert.deepEqual(view, { kind: "message", text: "No such terminal: bg_9", isError: true });
			assert.deepEqual(toShellResult(view), {
				content: [{ type: "text", text: "No such terminal: bg_9" }],
				details: {},
				isError: true,
			});
		});
	}

	it("preserves thrown-error text and error status without details", () => {
		const view = parseResultView({
			details: undefined,
			content: [{ type: "text", text: "unknown job_id: bg_999999" }],
			isError: true,
		}, false);
		assert.deepEqual(view, { kind: "message", text: "unknown job_id: bg_999999", isError: true });
		assert.deepEqual(toShellResult(view), {
			content: [{ type: "text", text: "unknown job_id: bg_999999" }],
			details: {},
			isError: true,
		});
	});

	it("strips ANSI and OSC controls from persisted output and failure notices", () => {
		const details = {
			...exitedDetails,
			output: "\x1b[31mred\x1b[0m\x1b]52;c;YXR0YWNrZXI=\x07\n",
			failure_message: "\x1b[31mbad\x1b[0m\x1b]0;unsafe title\x1b\\ workdir",
		};
		const result = toShellResult(processView(details));
		assert.equal(result.content[0].text, "red\n\n[failure: bad workdir]");
		assert.doesNotMatch(result.content[0].text, /[\u001b\u0007\u009b\u009d]/);
		assert.equal(result.isError, true);
	});

	for (const scenario of ["signal", "failure", "escalated kill", "failed kill"] as const) {
		it(`keeps recovery marker last when truncated output also has a ${scenario} notice`, () => {
			const collected = finalScreen(noisyOutput);
			const details = scenario === "signal" || scenario === "failure"
				? finalizeProcessResult({
					...processInput,
					collected,
					exitCode: undefined,
					signal: scenario === "signal" ? "SIGTERM" : null,
					failure: scenario === "failure" ? "process error" : null,
				})
				: finalizeKillResult({
					...killInput,
					collected,
					escalated: true,
					killed: scenario === "escalated kill",
					signal: scenario === "escalated kill" ? "SIGKILL" : null,
					failure: scenario === "failed kill" ? "process still running" : null,
				});
			const marker = truncationMarker(details.truncation, details.log_path);
			assert.equal(details.truncation?.truncated, true);
			assert.ok(marker);
			const text = toShellResult(parseResultView({ details, content: [] }, false)).content[0].text;
			assert.equal(text.split("\n").at(-1), marker);
			assert.ok(text.startsWith(`${details.output.replace(/\n+$/, "")}\n\n`), "notices must follow a blank line");
		});
	}
});

describe("omp shell argument presentation", () => {
	it("describes required input, escaped stdin, and base64 byte counts as shell comments", () => {
		assert.deepEqual(writeStdinShellArgs({ job_id: "bg_1" }), { command: "# stdin → bg_1: (input required)" });
		assert.deepEqual(writeStdinShellArgs({ job_id: "bg_1", chars: "" }), { command: "# stdin → bg_1: (input required)" });
		assert.deepEqual(writeStdinShellArgs({ job_id: "bg_1", chars: "q\n" }), { command: '# stdin → bg_1: "q\\n"' });
		assert.deepEqual(writeStdinShellArgs({ job_id: "bg_1", chars_b64: "aGk=" }), { command: "# stdin → bg_1: 2 bytes" });
		assert.deepEqual(writeStdinShellArgs({}), { command: "# stdin → ?: (input required)" });
		assert.deepEqual(writeStdinShellArgs(undefined), { command: "# stdin → ?: (input required)" });
	});

	it("describes default and custom kill signals, including streamed missing args", () => {
		assert.deepEqual(killShellArgs({ job_id: "bg_1" }), { command: "# kill bg_1 (SIGTERM)" });
		assert.deepEqual(killShellArgs({ job_id: "bg_1", signal: "SIGINT" }), { command: "# kill bg_1 (SIGINT)" });
		assert.deepEqual(killShellArgs(undefined), { command: "# kill ? (SIGTERM)" });
	});
});

function cardNode(render: ExtensionRender | undefined): UiNode {
	if (render === undefined || !isUiNode(render)) assert.fail("the shell card is not one node");
	return render;
}

function childOf(node: UiNode, kind: string): UiNode {
	const child = node.children().find((candidate) => candidate.kind === kind);
	if (child === undefined) assert.fail(`the shell card has no ${kind} node`);
	return child;
}

function propsOf(node: UiNode): Record<string, unknown> {
	return { ...node.props() };
}

function textOf(node: UiNode): string {
	const props = propsOf(node);
	if (typeof props.text === "string") return props.text;
	const spans: unknown = props.spans;
	if (!Array.isArray(spans)) return "";
	const list: readonly unknown[] = spans;
	return list
		.map((span) => (typeof span === "object" && span !== null && "t" in span && typeof span.t === "string" ? span.t : ""))
		.join("");
}

function spanTokens(node: UiNode): ReadonlyArray<{ readonly t: string; readonly s?: string }> {
	const spans: unknown = propsOf(node).spans;
	if (!Array.isArray(spans)) return [];
	const list: readonly unknown[] = spans;
	const tokens: Array<{ t: string; s?: string }> = [];
	for (const span of list) {
		if (typeof span !== "object" || span === null || !("t" in span) || typeof span.t !== "string") continue;
		tokens.push("s" in span && typeof span.s === "string" ? { t: span.t, s: span.s } : { t: span.t });
	}
	return tokens;
}

describe("omp shell card hooks", () => {
	const options = { expanded: false, isPartial: false };

	it("draws a terminal result's command, output and job id", () => {
		const result: AgentToolResult = {
			details: {
				operation: "bash",
				status: "running",
				running: true,
				job_id: "bg_1",
				wall_time_seconds: 0.501,
				output: "waiting for input\n",
			},
			content: [{ type: "text", text: "" }],
		};
		const card = cardNode(
			bashToolHooks().renderResult(result, options, undefined, { command: "ssh host", pty: true }),
		);
		assert.equal(textOf(childOf(card, "code")), "$ ssh host");
		assert.equal(propsOf(childOf(card, "ansi")).text, "waiting for input");
		const footer = spanTokens(childOf(card, "text")).map((span) => span.t).join("");
		assert.match(footer, /background · job bg_1/);
		assert.match(footer, /501ms/);
	});

	it("tones a non-zero exit as an error", () => {
		const result: AgentToolResult = {
			details: {
				operation: "bash",
				status: "exited",
				running: false,
				output: "boom\n",
				exit_code: 3,
				wall_time_seconds: 0.007,
			},
			content: [],
		};
		const card = cardNode(
			bashToolHooks().renderResult(result, options, undefined, { command: "exit 3", pty: true }),
		);
		assert.equal(propsOf(childOf(card, "ansi")).text, "boom");
		assert.equal(spanTokens(childOf(card, "text")).find((span) => span.t === "exit 3")?.s, "error");
	});

	it("leaves omp's own bash to native rendering and draws it in the plain terminal", (t) => {
		t.after(() => setNativeRenderingForTest(false));
		const hooks = bashToolHooks();
		const result: AgentToolResult = {
			details: { exitCode: 0, wallTimeMs: 12 },
			content: [{ type: "text", text: "hello from omp\n" }],
		};
		setNativeRenderingForTest(true);
		assert.equal(hooks.renderCall({ command: "echo hello" }, options), undefined);
		assert.equal(hooks.renderResult(result, options, undefined, { command: "echo hello" }), undefined);
		assert.ok(isUiNode(hooks.renderCall({ command: "ssh host", pty: true }, options)));

		setNativeRenderingForTest(false);
		const card = cardNode(hooks.renderResult(result, options, undefined, { command: "echo hello" }));
		assert.equal(textOf(childOf(card, "code")), "$ echo hello");
		assert.equal(propsOf(childOf(card, "ansi")).text, "hello from omp");
		assert.equal(spanTokens(childOf(card, "text")).find((span) => span.t === "exit 0")?.s, "success");

		const background: AgentToolResult = {
			details: { async: { state: "running", jobId: "bg_7" } },
			content: [],
		};
		const live = cardNode(hooks.renderResult(background, options, undefined, { command: "sleep 9" }));
		assert.match(spanTokens(childOf(live, "text")).map((span) => span.t).join(""), /background · job bg_7/);
	});
});

describe("host presentation activation", () => {
	const parameters = Type.Object({ command: Type.Optional(Type.String()) });
	const definition: ToolDefinition<typeof parameters, ProcessResultDetails> = {
		name: "bash",
		label: "Exec",
		description: "Test registration",
		parameters,
		execute: async () => { throw new Error("This registration test must not execute a tool"); },
	};

	it("rejects a non-omp host at factory invocation without activating or registering tools", () => {
		const registered: Array<typeof definition> = [];
		const api = { registerTool: (tool: typeof definition) => registered.push(tool) } as unknown as ExtensionAPI;
		let activations = 0;
		const factory = withHostPresentation((host): ActivatedExtension => {
			activations++;
			host.registerTool(definition);
			return { store: () => new SessionStore({ maxSessions: 10, lruProtectedCount: 2 }), kill: async () => false };
		});
		assert.throws(() => factory(api), {
			name: "Error",
			message: /^omp-actual-terminal only supports omp \(oh-my-pi\).*current host is not omp/,
		});
		assert.equal(activations, 0);
		assert.deepEqual(registered, []);
	});

	it("rejects an omp-shaped Node host before loading modules or registering tools", (t) => {
		const temporary = mkdtempSync(join(tmpdir(), "omp-bun-admission-"));
		t.after(() => rmSync(temporary, { recursive: true, force: true }));
		const root = fileURLToPath(new URL("../", import.meta.url));
		const compiled = join(temporary, "plugin.mjs");
		const build = spawnSync(process.execPath, [
			"build", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
			"--target=node", "--packages=external", "--outfile", compiled,
		], { cwd: root, encoding: "utf8" });
		assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
		// --packages=external keeps the bundle's package imports external, but
		// Node cannot load them: the @oh-my-pi packages ship TypeScript
		// source. Stage a temporary
		// node_modules mirroring the specifiers the bundle actually imports so
		// Node reaches the factory's Bun guard; the guard throws before any of
		// these exports is invoked, so a universal stub export is sufficient.
		// @xterm/headless is real because the bundle reads its default export at
		// module scope.
		const writeStubModules = (modules: string): void => {
			const bundle = readFileSync(compiled, "utf8");
			const specifiers = new Map<string, Set<string>>();
			for (const match of bundle.matchAll(/^(?:import|export)\s+[^"']*?from\s*["']([^"']+)["']/gm)) {
				const specifier = match[1];
				if (specifier === "@xterm/headless" || specifier.startsWith("node:")) continue;
				const names = specifiers.get(specifier) ?? new Set<string>();
				const clause = match[0].slice(0, match[0].lastIndexOf("from"));
				const namespace = /\*\s+as\s+(\w+)/.exec(clause);
				if (namespace) {
					for (const use of bundle.matchAll(new RegExp(`\\b${namespace[1]}\\.(\\w+)`, "g"))) names.add(use[1]);
				}
				const named = /\{([\s\S]*)\}/.exec(clause);
				if (named) {
					for (const part of named[1].split(",")) {
						const member = part.trim().replace(/^type\s+/, "");
						if (!member) continue;
						const name = /\bas\s+(\w+)\s*$/.exec(member)?.[1] ?? member;
						if (name !== "default") names.add(name);
					}
				}
				specifiers.set(specifier, names);
			}
			const stubSource = "const base = function () {};\n" +
				"const stub = new Proxy(base, {\n" +
				"\tget: (target, prop) => prop === Symbol.toPrimitive ? () => 0 : prop === \"then\" ? undefined : stub,\n" +
				"\tapply: () => stub,\n" +
				"\tconstruct: () => stub,\n" +
				"});\nexport default stub;\n";
			const packages = new Map<string, Map<string, string>>();
			for (const [specifier, names] of specifiers) {
				const segments = specifier.split("/");
				const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
				const subpath = specifier.startsWith("@") ? segments.slice(2).join("/") : segments.slice(1).join("/");
				const file = subpath === "" ? "index.mjs" : `${subpath}.mjs`;
				const target = join(modules, packageName, file);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, stubSource + [...names].map((name) => `export const ${name} = stub;`).join("\n") + "\n");
				const exportsMap = packages.get(packageName) ?? new Map<string, string>();
				exportsMap.set(subpath === "" ? "." : `./${subpath}`, `./${file}`);
				packages.set(packageName, exportsMap);
			}
			for (const [packageName, exportsMap] of packages) {
				writeFileSync(join(modules, packageName, "package.json"), JSON.stringify({
					name: packageName,
					type: "module",
					exports: Object.fromEntries(exportsMap),
				}));
			}
		};
		const modules = join(dirname(compiled), "node_modules");
		writeStubModules(modules);
		mkdirSync(join(modules, "@xterm"), { recursive: true });
		symlinkSync(join(root, "node_modules", "@xterm", "headless"), join(modules, "@xterm", "headless"), "junction");
		const result = spawnSync("node", ["--input-type=module", "--eval", `
			import assert from "node:assert/strict";
			import factory from ${JSON.stringify(pathToFileURL(compiled).href)};
			let registrations = 0;
			assert.throws(
				() => factory({ arktype: {}, registerTool() { registrations++; } }),
				/requires a Bun host with Bun\\.Terminal; the current runtime is not Bun/,
			);
			assert.equal(registrations, 0);
			console.log("NODE_HOST_REJECTED");
		`], { encoding: "utf8" });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /NODE_HOST_REJECTED/);
	});

	it("preserves tool definition getters during registerTool and loads extensions without Settings.init()", async () => {
		const registered: Array<ToolDefinition<typeof parameters, ProcessResultDetails>> = [];
		const host = {
			registerTool: (tool: ToolDefinition<typeof parameters, ProcessResultDetails>) => {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;
		const presented = await presentOnOmp(host);
		let descriptionGets = 0;
		let parameterGets = 0;
		const lazyDefinition: ToolDefinition<typeof parameters, ProcessResultDetails> = {
			name: "bash",
			label: "Exec",
			get description() {
				descriptionGets++;
				return "Lazy bash description";
			},
			get parameters() {
				parameterGets++;
				return parameters;
			},
			execute: async () => {
				throw new Error("This registration test must not execute a tool");
			},
		};
		presented.registerTool(lazyDefinition);
		assert.equal(registered.length, 1);
		assert.equal(descriptionGets, 0);
		assert.equal(parameterGets, 0);
		assert.equal(typeof Object.getOwnPropertyDescriptor(registered[0], "description")?.get, "function");
		assert.equal(typeof Object.getOwnPropertyDescriptor(registered[0], "parameters")?.get, "function");
		assert.equal(registered[0].description, "Lazy bash description");
		assert.equal(registered[0].parameters, parameters);
		assert.equal(descriptionGets, 1);
		assert.equal(parameterGets, 1);

		const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const loaded = await loadExtensions([entry], process.cwd());
		assert.deepEqual(loaded.errors, []);
		assert.ok(loaded.extensions[0]?.tools.has("bash"));
		assert.ok(loaded.extensions[0]?.tools.has("write_stdin"));
	});
});
