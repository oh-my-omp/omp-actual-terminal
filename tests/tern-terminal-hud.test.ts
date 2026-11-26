import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionRender, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { isUiNode, type KeyEvent, setNativeRenderingForTest, signal, type UiNode } from "@oh-my-pi/pi-tui";

import {
	consoleGrid,
	consoleKeyBytes,
	KILL_ACTION,
	LEAVE_ACTION,
	mountTerminalHud,
	openTerminalConsole,
	TERMINALS_COMMAND,
	terminalPageFrame,
	type TerminalEntry,
	type TerminalState,
} from "../src/tern-terminal-hud.ts";
import { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";

function properties(node: UiNode): Readonly<Record<string, unknown>> {
	return { ...node.props() };
}

function children(node: UiNode): UiNode[] {
	return [...node.children()];
}

function walk(node: UiNode): UiNode[] {
	return [node, ...children(node).flatMap(walk)];
}

function buttons(node: UiNode): string[] {
	return walk(node)
		.filter((child) => child.kind === "button")
		.map((button) => {
			const actions = properties(button).actions;
			assert.ok(typeof actions === "object" && actions !== null && "click" in actions, "a button carries its click action");
			return String(actions.click);
		});
}

function headSpans(node: UiNode): unknown {
	const head = properties(node).head;
	if (head !== undefined) return head;
	const first = children(node)[0];
	assert.ok(first, "the ANSI Console draws its head first");
	assert.equal(first.kind, "text");
	return properties(first).spans;
}

function screen(node: UiNode): UiNode {
	const found = walk(node).find((child) => child.kind === "ansi");
	assert.ok(found, "the Console shows the terminal's screen");
	return found;
}

function screenText(node: UiNode): string {
	const text = properties(screen(node)).text;
	assert.ok(typeof text === "string", "the screen is drawn as text");
	return text;
}

function entry(state: TerminalState): TerminalEntry {
	return {
		id: "bg_7",
		title: "Terminal 7",
		state,
		screen: { text: "\x1b[31mscreen-7\x1b[0m", view: { screen: "normal", cols: 100, rows: 24, cursor: { row: 1, col: 1 } } },
	};
}

const exited = (exitCode: number | null): TerminalState => ({ kind: "exited", exitCode, signal: null, failure: null });

function actionEvent(act: string) {
	return { type: "action", key: "", act, mods: [] } as const;
}

function keyEvent(id: string, text?: string): KeyEvent {
	return text === undefined ? { id, kind: "press", raw: id } : { id, text, kind: "press", raw: text };
}

function typeKeys(root: UiNode, text: string): void {
	for (const char of text) {
		const key = char === "\r" ? keyEvent("enter") : char === " " ? keyEvent("space") : keyEvent(char, char);
		assert.equal(root.handlers.onKey?.(key), true, "the Console takes the key");
	}
}

function waitFor(
	condition: () => boolean,
	subscribe: (listener: () => void) => () => void,
	message: string | (() => string),
): Promise<void> {
	if (condition()) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timeout = AbortSignal.timeout(8000);
	const failed = () => {
		unsubscribe();
		reject(new Error(typeof message === "string" ? message : message()));
	};
	const changed = () => {
		if (!condition()) return;
		unsubscribe();
		timeout.removeEventListener("abort", failed);
		resolve();
	};
	const unsubscribe = subscribe(changed);
	timeout.addEventListener("abort", failed, { once: true });
	changed();
	return promise;
}

function screenShows(session: ExecSession, needle: string): Promise<void> {
	return waitFor(() => session.styledScreen()?.text.includes(needle) === true, (listener) => session.onScreenChange(listener),
		() => `screen shows ${needle}; screen is ${JSON.stringify(session.styledScreen()?.text)}`);
}

type CustomFactory<T> = (
	host: ExtensionUiHost,
	theme: unknown,
	keybindings: unknown,
	done: (result: T) => void,
) => ExtensionRender | Promise<ExtensionRender>;

interface CustomOptions {
	readonly overlay: boolean;
}

interface CustomUi {
	custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface CommandStub {
	readonly description?: string;
	getArgumentCompletions?(prefix: string): { readonly value: string; readonly description?: string }[] | null;
	handler(args: string, context: ExtensionContext): Promise<void>;
}

interface Notice {
	readonly message: string;
	readonly type: string | undefined;
}

interface CustomCall {
	readonly root: UiNode;
	readonly promise: Promise<unknown>;
	readonly options: CustomOptions;
	readonly resolved: boolean;
}

let nextActivation = 0;

async function makeHarness(t: TestContext, hasUI = true) {
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const calls: CustomCall[] = [];
	const killCalls: string[] = [];
	const sessions: ExecSession[] = [];
	const notices: Notice[] = [];
	const selects: { readonly title: string; readonly options: string[] }[] = [];
	let pick: (options: string[]) => string | undefined = () => undefined;
	const commands = new Map<string, CommandStub>();
	// Terminal ids are per activation in omp; distinct ids keep concurrent harnesses apart.
	const prefix = `bg_${++nextActivation}_`;
	let nextSpawnId = 1;
	const terminal = signal({ columns: 100, rows: 50 });
	const host: ExtensionUiHost = {
		requestRender() {},
		size: () => terminal(),
		suspend: (run) => run(),
	};
	const ui: CustomUi = {
		custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
			const { promise, resolve } = Promise.withResolvers<T>();
			let root: UiNode | undefined;
			let resolved = false;
			const done = (result: T): void => {
				resolved = true;
				resolve(result);
			};
			const output = factory(host, undefined, undefined, done);
			assert.equal(output instanceof Promise, false, "the Console builds its view synchronously");
			assert.ok(isUiNode(output), "the Console builds one root node");
			root = output;
			calls.push({
				get root(): UiNode {
					if (root === undefined) throw new Error("the Console builds its view before it is read");
					return root;
				},
				promise,
				options: options ?? { overlay: false },
				get resolved(): boolean {
					return resolved;
				},
			});
			return promise;
		},
		async select(title: string, options: string[]): Promise<string | undefined> {
			selects.push({ title, options });
			return pick(options);
		},
		notify(message: string, type?: "info" | "warning" | "error"): void {
			notices.push({ message, type });
		},
	};
	const consoleUi = ui as unknown as ExtensionContext["ui"];
	const pi = {
		registerCommand(name: string, command: CommandStub) {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI;
	mountTerminalHud(pi, () => store, async (id) => {
		killCalls.push(id);
		const session = store.get(id);
		assert.ok(session, "kill targets a stored real session");
		const ended = waitFor(() => session.hasExited, (listener) => session.onExit(listener), "killed child exits");
		session.terminate("SIGKILL");
		await ended;
		store.remove(id);
		return true;
	});
	const command = commands.get(TERMINALS_COMMAND);
	assert.ok(command, "the extension registers its terminals command");

	t.after(async () => {
		for (const call of calls) call.root.handlers.onAction?.(LEAVE_ACTION, actionEvent(LEAVE_ACTION));
		// Keep removed sessions in this list: removing ownership does not kill the child.
		for (const session of sessions) session.terminate("SIGKILL");
		await Promise.all(sessions.map((session) => waitFor(
			() => session.hasExited, (listener) => session.onExit(listener), "all test children exited",
		)));
		await Promise.all(sessions.map((session) => session.release()));
		for (const session of sessions) store.remove(session.id);
	});

	return {
		store,
		calls,
		killCalls,
		notices,
		selects,
		command,
		ui: consoleUi,
		choose(choice: (options: string[]) => string | undefined) {
			pick = choice;
		},
		run(args: string): Promise<void> {
			return command.handler(args, { hasUI, ui: consoleUi } as unknown as ExtensionContext);
		},
		resize(columns: number, rows: number) {
			terminal.set({ columns, rows });
		},
		open(id: string): CustomCall {
			assert.equal(openTerminalConsole(id, consoleUi), true, "the terminal's Console opens");
			const call = calls.at(-1);
			assert.ok(call, "the Console asked the UI to show its view");
			assert.deepEqual(call.options, { overlay: true });
			return call;
		},
		spawn(command = [process.execPath, "-e", "process.stdin.resume()"]): ExecSession {
			const session = ExecSession.spawn(`${prefix}${nextSpawnId++}`, {
				title: "Test terminal", shell: "test", command, cwd: process.cwd(), env: process.env, cols: 80, rows: 24,
			});
			sessions.push(session);
			assert.equal(session.failureMessage, null, "child spawn succeeds");
			store.insert(session);
			return session;
		},
	};
}

const SIZER = [process.execPath, "-e", [
	"process.stdin.setRawMode(true)",
	"const size = () => `${process.stdout.rows} ${process.stdout.columns}`",
	"process.stdout.on('resize', () => process.stdout.write(`resized ${size()}\\n`))",
	"let pending = ''",
	"process.stdin.on('data', (data) => { const lines = (pending + data).split('\\r'); pending = lines.pop(); for (const line of lines) process.stdout.write(`got ${line} size ${size()}\\n`) })",
	"process.stdout.write('ready\\n')",
].join("; ")];

const KEYS = [process.execPath, "-e", [
	"process.stdin.setRawMode(true)",
	"let received = 0",
	"process.stdin.on('data', (data) => process.stdout.write(`keys:${(received += data.length)}\\n`))",
	"process.stdout.write('keys-ready\\n')",
].join("; ")];

const encoder = new TextEncoder();

describe("Console head", () => {
	it("names the terminal's id, title and state, and says removed once it is no longer stored", () => {
		for (const [state, label, tone] of [
			[{ kind: "running" }, "running", "accent"],
			[exited(0), "exit 0", "success"],
			[exited(1), "exit 1", "error"],
			[{ kind: "exited", exitCode: 0, signal: null, failure: "spawn\nfailed" }, "failed: spawn failed", "error"],
		] satisfies [TerminalState, string, string][]) {
			const value = entry(state);
			assert.deepEqual(terminalPageFrame(value, value.id), {
				role: "omp.overlay.console",
				anchor: "bottom",
				size: "full",
				head: [{ t: "Console · ", s: "muted" }, { t: "bg_7 " }, { t: value.title }, { t: "  " }, { t: label, s: tone }],
			});
		}
		assert.deepEqual(terminalPageFrame(undefined, "bg_7").head, [{ t: "Console · ", s: "muted" }, { t: "bg_7 " }, { t: "removed", s: "muted" }]);
	});
});

describe("Console node structure", () => {
	it("takes the head as Tern's sheet head, and as the first row of the ANSI terminal", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn();

		const head = [
			{ t: "Console · ", s: "muted" },
			{ t: `${session.id} ` },
			{ t: "Test terminal" },
			{ t: "  " },
			{ t: "running", s: "accent" },
		];
		const ansi = h.open(session.id);
		assert.equal(ansi.root.kind, "col");
		assert.deepEqual(headSpans(ansi.root), head);
		ansi.root.handlers.onAction?.(LEAVE_ACTION, actionEvent(LEAVE_ACTION));
		await ansi.promise;

		setNativeRenderingForTest(true);
		t.after(() => setNativeRenderingForTest(false));
		const native = h.open(session.id);
		assert.equal(native.root.kind, "overlay");
		const props = properties(native.root);
		assert.equal(props.role, "omp.overlay.console");
		assert.equal(props.anchor, "bottom");
		assert.equal(props.size, "full");
		assert.deepEqual(props.head, head);
		native.root.handlers.onAction?.(LEAVE_ACTION, actionEvent(LEAVE_ACTION));
		await native.promise;
		assert.equal(session.hasExited, false);
	});
});

describe("Console with real terminals", () => {
	it("sends typed keys and pastes to the running terminal", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn(KEYS);
		await screenShows(session, "keys-ready");
		const root = h.open(session.id).root;

		typeKeys(root, "hi\r");
		assert.equal(root.handlers.onPaste?.({ text: "p" }), true, "the Console takes the paste");
		await screenShows(session, "keys:4");
		assert.match(screenText(root), /keys:4/);
	});

	it("shows output written after opening and re-grids the terminal when the screen resizes", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn(SIZER);
		await screenShows(session, "ready");
		const root = h.open(session.id).root;
		await screenShows(session, "resized 36 98");

		typeKeys(root, "first\r");
		await screenShows(session, "got first size 36 98");
		assert.match(screenText(root), /got first size 36 98/);

		session.write(encoder.encode("model\r"));
		await screenShows(session, "got model size 36 98");
		assert.match(screenText(root), /got model size 36 98/, "the Console shows what the process wrote after it opened");

		h.resize(120, 60);
		await waitFor(() => session.styledScreen()?.view.cols === 118, (listener) => session.onScreenChange(listener),
			() => `the grid follows the screen size; grid is ${session.styledScreen()?.view.cols}`);
		await screenShows(session, "resized 44 118");
		typeKeys(root, "after\r");
		await screenShows(session, "got after size 44 118");
	});

	it("leaves the terminal running on Esc and gives it back the size its call started it with", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn(SIZER);
		await screenShows(session, "ready");
		const call = h.open(session.id);
		const writes = t.mock.method(session, "write");
		await waitFor(() => session.styledScreen()?.view.cols === 98, (listener) => session.onScreenChange(listener), "the Console grids the terminal");
		await screenShows(session, "resized 36 98");

		assert.equal(call.root.handlers.onKey?.(keyEvent("escape")), true);
		await call.promise;
		assert.equal(call.resolved, true, "leaving resolves the custom view");
		assert.equal(writes.mock.callCount(), 0, "Esc is navigation, not terminal input");
		assert.equal(session.hasExited, false, "Esc leaves the terminal running");
		await screenShows(session, "resized 24 80");

		session.write(encoder.encode("after\r"));
		await screenShows(session, "got after size 24 80");
	});

	it("stops forwarding keys once its child exits and drops End", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0))"]);
		await screenShows(session, "ready");
		const call = h.open(session.id);
		typeKeys(call.root, "exit\r");
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "the child exits");
		const writes = t.mock.method(session, "write");

		typeKeys(call.root, "ignored-after-exit");
		assert.equal(writes.mock.callCount(), 0, "the Console gates writes rather than relying on ExecSession to reject them");
		assert.deepEqual(buttons(call.root), [LEAVE_ACTION]);
		assert.deepEqual(h.killCalls, []);
	});

	it("ends the terminal as a person through End and closes once the terminal leaves the store", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn();
		const call = h.open(session.id);
		assert.deepEqual(buttons(call.root), [KILL_ACTION, LEAVE_ACTION], "End only while running");

		call.root.handlers.onAction?.(KILL_ACTION, actionEvent(KILL_ACTION));
		await waitFor(() => h.store.get(session.id) === undefined, (listener) => h.store.subscribe(listener), "End removes the ended terminal");
		assert.deepEqual(h.killCalls, [session.id]);
		assert.equal(session.hasExited, true);
		assert.equal(await call.promise, undefined);
		assert.equal(call.resolved, true, "a terminal that left the store closes its Console");
	});

	it("closes when its terminal leaves the store by any other path, and then opens again", async (t) => {
		const h = await makeHarness(t);
		const first = h.spawn();
		const call = h.open(first.id);
		h.store.remove(first.id);
		await call.promise;
		assert.equal(call.resolved, true);

		const second = h.spawn();
		h.open(second.id);
	});

	it("keeps one Console per UI: a second terminal opens none while one is showing", async (t) => {
		const h = await makeHarness(t);
		const shown = h.spawn();
		const call = h.open(shown.id);
		const later = h.spawn();
		assert.equal(openTerminalConsole(later.id, h.ui), false);
		assert.equal(h.calls.length, 1);

		call.root.handlers.onAction?.(LEAVE_ACTION, actionEvent(LEAVE_ACTION));
		await call.promise;
		h.open(later.id);
	});

	it("opens nothing for an id no activation stores", async (t) => {
		const h = await makeHarness(t);
		assert.equal(openTerminalConsole("bg_missing", h.ui), false);
		assert.equal(h.calls.length, 0);
	});
});

describe("terminals command", () => {
	it("lists the stored terminals and opens the one a person picks", async (t) => {
		const h = await makeHarness(t);
		const first = h.spawn();
		const second = h.spawn();
		h.choose((options) => options.find((option) => option.startsWith(`${second.id} `)));

		await h.run("");
		assert.equal(h.selects.length, 1);
		const listed = h.selects[0]!.options;
		assert.ok(listed.some((option) => option.startsWith(`${first.id} `)), "the first terminal is listed");
		assert.ok(listed.some((option) => option.startsWith(`${second.id} `) && option.includes("Test terminal") && option.includes("running")),
			"a row names the job id, title and state");
		assert.equal(h.calls.length, 1, "picking a terminal opens one Console");
		assert.deepEqual(headSpans(h.calls[0]!.root), terminalPageFrame({ id: second.id, title: "Test terminal", state: { kind: "running" } }, second.id).head);
	});

	it("opens nothing when the person dismisses the list", async (t) => {
		const h = await makeHarness(t);
		h.spawn();
		await h.run("");
		assert.equal(h.selects.length, 1);
		assert.equal(h.calls.length, 0);
	});

	it("opens a named job id without a list and completes job ids", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn();
		assert.deepEqual(h.command.getArgumentCompletions?.(session.id)?.map((item) => item.value), [session.id]);

		await h.run(` ${session.id} `);
		assert.equal(h.selects.length, 0, "a named terminal needs no list");
		assert.equal(h.calls.length, 1);
	});

	it("reports an unknown job id, an empty list and an open Console instead of opening", async (t) => {
		const h = await makeHarness(t);
		await h.run("bg_missing");
		await h.run("");
		const session = h.spawn();
		h.open(session.id);
		await h.run(session.id);
		assert.equal(h.calls.length, 1, "only the direct open showed a Console");
		assert.deepEqual(h.notices.map((notice) => notice.type), ["warning", "info", "warning"]);
		assert.match(h.notices[0]!.message, /no terminal bg_missing/);
		assert.match(h.notices[1]!.message, /no terminals to open/);
		assert.match(h.notices[2]!.message, /already showing/);
	});

	it("lists another activation's terminals after its own and opens one in the calling UI", async (t) => {
		const main = await makeHarness(t);
		const subagent = await makeHarness(t, false);
		const own = main.spawn();
		const child = subagent.spawn();
		main.choose((options) => options.find((option) => option.startsWith(`${child.id} `)));

		await main.run("");
		const listed = main.selects[0]!.options.map((option) => option.split(" ")[0]);
		assert.ok(listed.indexOf(own.id) >= 0 && listed.indexOf(own.id) < listed.indexOf(child.id),
			"the calling session's terminals come before another activation's");
		assert.equal(main.calls.length, 1, "the picked subagent terminal opens in the calling UI");
		assert.equal(subagent.calls.length, 0);

		const other = await makeHarness(t);
		await other.run(own.id);
		assert.equal(other.calls.length, 1, "a second UI opens its own Console while the first shows one");
	});

	it("opens nothing in a session without a UI", async (t) => {
		const h = await makeHarness(t, false);
		const session = h.spawn();
		await h.run(session.id);
		assert.equal(h.calls.length, 0);
		assert.match(h.notices[0]!.message, /needs the interactive UI/);
	});
});

const PTY_CONSOLE = new URL("../node_modules/@oh-my-pi/pi-coding-agent/src/ui/overlays/panels/pty-console.tsx", import.meta.url).href;

async function ompConsole(): Promise<{ readonly keyBytes: Function; readonly model: object; readonly gridFor: Function }> {
	const module: unknown = await import(PTY_CONSOLE);
	assert.ok(typeof module === "object" && module !== null, "omp's pty-console module loads");
	assert.ok("ptyKeyBytes" in module && typeof module.ptyKeyBytes === "function", "omp still exports ptyKeyBytes");
	assert.ok("PtyConsoleModel" in module && typeof module.PtyConsoleModel === "function", "omp still exports PtyConsoleModel");
	const model = module.PtyConsoleModel;
	assert.ok("gridFor" in model && typeof model.gridFor === "function", "PtyConsoleModel still has gridFor");
	return { keyBytes: module.ptyKeyBytes, model, gridFor: model.gridFor };
}

describe("Console bytes and grid against omp's own Console", () => {
	const keys: KeyEvent[] = [
		keyEvent("up"),
		keyEvent("left"),
		keyEvent("home"),
		keyEvent("end"),
		keyEvent("pageup"),
		keyEvent("delete"),
		keyEvent("shift+tab"),
		keyEvent("enter"),
		keyEvent("tab"),
		keyEvent("space", " "),
		keyEvent("backspace"),
		keyEvent("escape"),
		keyEvent("ctrl+c"),
		keyEvent("alt+x", "x"),
		keyEvent("é", "é"),
		{ id: "f5", kind: "press", raw: "\x1b[15~" },
		{ id: "ctrl+shift+a", kind: "press", raw: "\x1b[97;6u" },
		{ id: "a", text: "a", kind: "release", raw: "a" },
	];

	it("sends every key as omp's ptyKeyBytes does, in both cursor modes", async () => {
		const omp = await ompConsole();
		for (const applicationCursorKeys of [false, true]) {
			for (const key of keys) {
				assert.equal(
					consoleKeyBytes(key, applicationCursorKeys),
					Reflect.apply(omp.keyBytes, undefined, [key, applicationCursorKeys]),
					`${key.id} application=${applicationCursorKeys}`,
				);
			}
		}
	});

	it("sizes the grid as PtyConsoleModel.gridFor does in Tern and in the ANSI TUI", async (t) => {
		const omp = await ompConsole();
		t.after(() => setNativeRenderingForTest(false));
		for (const native of [false, true]) {
			setNativeRenderingForTest(native);
			for (const [columns, rows] of [[10, 3], [80, 24], [100, 50], [233, 61]] as const) {
				assert.deepEqual(consoleGrid(columns, rows), Reflect.apply(omp.gridFor, omp.model, [columns, rows]), `${columns}x${rows} native=${native}`);
			}
		}
	});
});
