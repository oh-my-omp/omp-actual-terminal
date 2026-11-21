import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { JobsSheet, type JobsPanelJob, type JobsSheetSource } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import {
	decorateJobsPage,
	describeTerminalPage,
	KILL_ACTION,
	LEAVE_ACTION,
	loadTernHudHost,
	mountTerminalHud,
	OPEN_TERMINAL_ACTION,
	parseTernHudHost,
	terminalPageFrame,
	type TerminalEntry,
	type TerminalState,
} from "../src/tern-terminal-hud.ts";
import { ExecSession } from "../src/session.ts";
import { SessionStore } from "../src/session-store.ts";

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child;
}

function nodes(node: NativeNode): NativeNode[] {
	return [node, ...(node.c ?? []).filter(isNode).flatMap(nodes)];
}

function withRole(node: NativeNode, role: string): NativeNode | undefined {
	return nodes(node).find((candidate) => candidate.p?.role === role);
}

function onlyNode<K extends NativeNode["k"]>(node: NativeNode, kind: K): Extract<NativeNode, { readonly k: K }> {
	const matches = nodes(node).filter((candidate): candidate is Extract<NativeNode, { readonly k: K }> => candidate.k === kind);
	assert.equal(matches.length, 1, `expected one ${kind} node`);
	return matches[0]!;
}

/** The click actions of the buttons under `node`, in order. */
function buttons(node: NativeNode | undefined): string[] {
	if (node === undefined) return [];
	return nodes(node)
		.filter((candidate) => candidate.p?.role === "omp.btn")
		.map((candidate) => {
			const actions: unknown = candidate.p && "actions" in candidate.p ? candidate.p.actions : undefined;
			const click = typeof actions === "object" && actions !== null && "click" in actions ? actions.click : undefined;
			assert.equal(typeof click, "string", "a button carries its click action");
			return String(click);
		});
}

function ansiText(node: NativeNode): string {
	const text = onlyNode(node, "ansi").p?.text;
	assert.ok(typeof text === "string");
	return text;
}

function cx(cols: number): DescribeContext {
	return { cols, reduceMotion: true, dark: true, supports: () => false, feature: () => false };
}

function action(act: string): NativeUiEvent {
	return { type: "action", key: "", act, mods: [] };
}

function job(id: string): JobsPanelJob {
	return { id, type: "bash", status: "running", label: `job ${id}`, startTime: Date.now() };
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

function waitFor(
	condition: () => boolean,
	subscribe: (listener: () => void) => () => void,
	message: string | (() => string),
): Promise<void> {
	if (condition()) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		// Real PTY IO cannot use fake time; this deadline only bounds a missing event.
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
	});
}

function screenShows(session: ExecSession, needle: string): Promise<void> {
	return waitFor(() => session.styledScreen()?.text.includes(needle) === true, (listener) => session.onScreenChange(listener),
		() => `screen shows ${needle}; screen is ${JSON.stringify(session.styledScreen()?.text)}`);
}

interface PageComponent {
	readonly nativeOverlay?: Readonly<Record<string, unknown>>;
	describe(cx: DescribeContext): NativeNode;
	handleInput(data: string): void;
	handleNativeEvent(event: NativeUiEvent): void;
	dispose(): void;
}

type StubTui = { readonly terminal: { readonly rows: number }; requestRender(): void };
type CustomFactory = (tui: StubTui, theme: unknown, keybindings: unknown, done: (result?: unknown) => void) => PageComponent;
type CustomCall = {
	readonly component: PageComponent;
	readonly options: { readonly overlay: boolean };
	readonly promise: Promise<unknown>;
	readonly disposed: boolean;
};
type Handler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

let nextActivation = 0;

/** A plugin activation with a real store and real PTY sessions, mounted on omp's real jobs page. */
async function makeHarness(t: TestContext, hasUI = true) {
	const host = await loadTernHudHost();
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const handlers = new Map<string, Handler[]>();
	const customCalls: CustomCall[] = [];
	const killCalls: string[] = [];
	const sessions: ExecSession[] = [];
	// Terminal ids are per activation in omp; distinct ids keep concurrent harnesses apart.
	const prefix = `bg_${++nextActivation}_`;
	let nextSpawnId = 1;
	let terminalRows = 50;
	const tui: StubTui = { terminal: { get rows() { return terminalRows; } }, requestRender() {} };
	const ui = {
		custom(factory: CustomFactory, options: { overlay: boolean }): Promise<unknown> {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			let disposed = false;
			const done = (result?: unknown) => {
				if (disposed) return;
				disposed = true;
				try {
					component.dispose();
				} finally {
					resolve(result);
				}
			};
			const component = factory(tui, {}, {}, done);
			customCalls.push({ component, options, promise, get disposed() { return disposed; } });
			return promise;
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	mountTerminalHud(pi, () => store, host, async (id) => {
		killCalls.push(id);
		const session = store.get(id);
		assert.ok(session, "kill targets a stored real session");
		const ended = waitFor(() => session.hasExited, (listener) => session.onExit(listener), "killed child exits");
		session.terminate("SIGKILL");
		await ended;
		store.remove(id);
		return true;
	});

	async function emit(event: string): Promise<void> {
		const context = { hasUI, ui } as unknown as ExtensionContext;
		for (const handler of handlers.get(event) ?? []) await handler({}, context);
	}
	await emit("session_start");

	t.after(async () => {
		await emit("session_shutdown");
		for (const call of customCalls) call.component.handleNativeEvent(action(LEAVE_ACTION));
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
		customCalls,
		killCalls,
		set terminalRows(rows: number) { terminalRows = rows; },
		get page(): PageComponent {
			const page = customCalls.at(-1)?.component;
			assert.equal(page?.nativeOverlay?.role, "omp.overlay.console", "the Console is open");
			return page!;
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
		sheet(jobs: readonly JobsPanelJob[], selected: string) {
			const calls = { closed: 0, cancelled: [] as string[] };
			const source: JobsSheetSource = {
				load: () => ({ running: jobs, recent: [] }),
				inspect: () => ({ pids: [] }),
				cancel: (id) => { calls.cancelled.push(id); },
				close: () => { calls.closed++; },
			};
			const sheet = new JobsSheet(source, { selected });
			sheet.describe(cx(120));
			return { sheet, calls };
		},
	};
}

/** `sh` reading lines and answering each with the terminal's own size as the kernel reports it. */
const SIZER = ["/bin/sh", "-c", "stty -echo; echo ready; while read line; do echo \"got $line size $(stty size)\"; done"];

describe("Console page description", () => {
	it("frames a full Console overlay with the terminal id, title, and state in the head", () => {
		for (const [state, label, tone] of [
			[{ kind: "running" }, "running", "accent"],
			[exited(0), "exit 0", "success"],
			[exited(1), "exit 1", "error"],
			[{ kind: "exited", exitCode: 0, signal: null, failure: "spawn\nfailed" }, "failed: spawn failed", "error"],
		] satisfies [TerminalState, string, string][]) {
			const value = entry(state);
			assert.deepEqual(terminalPageFrame(value, value.id), {
				role: "omp.overlay.console",
				size: "full",
				head: [{ t: "Console · ", s: "muted" }, { t: "bg_7 " }, { t: value.title }, { t: "  " }, { t: label, s: tone }],
			});
		}
		assert.deepEqual(terminalPageFrame(undefined, "bg_7").head, [{ t: "Console · ", s: "muted" }, { t: "bg_7 " }, { t: "removed", s: "muted" }]);
	});

	it("describes a following screen keeping its colors, End only while running, and Leave on esc", async () => {
		const host = await loadTernHudHost();
		for (const state of [{ kind: "running" }, exited(0)] satisfies TerminalState[]) {
			const value = entry(state);
			const view = describeTerminalPage(value, host);
			const screen = onlyNode(view, "ansi");
			assert.equal(screen.key, "page-sbg_7");
			assert.equal(screen.p?.follow, true);
			assert.equal(screen.p?.cols, 100);
			assert.equal(ansiText(view), value.screen.text);
			assert.deepEqual(buttons(withRole(view, "omp.actions")), [...(state.kind === "running" ? [KILL_ACTION] : []), LEAVE_ACTION]);
		}
		const gone = describeTerminalPage(undefined, host);
		assert.equal(nodes(gone).some((node) => node.k === "ansi"), false);
		assert.deepEqual(buttons(withRole(gone, "omp.actions")), [LEAVE_ACTION], "a removed terminal can only be left");
	});
});

describe("Open on omp's jobs page", () => {
	it("names the omp change when the host modules or the selected terminal's status row are reshaped", () => {
		const requalify = { message: /requalify src\/tern-terminal-hud\.ts/ };
		const overlay = { actionButton: () => ({ k: "spacer" }) as NativeNode, actionBar: () => ({ k: "spacer" }) as NativeNode };
		const interactive = { normalizeInputForPty: (data: string) => data };
		class Sheet {
			describe() {}
			handleInput() {}
			handleNativeEvent() {}
		}
		for (const [panel, over, input] of [
			[{}, overlay, interactive],
			[{ JobsSheet: class { describe() {} } }, overlay, interactive],
			[{ JobsSheet: Sheet }, {}, interactive],
			[{ JobsSheet: Sheet }, overlay, {}],
		] as const) {
			assert.throws(() => parseTernHudHost(panel as never, over, input), requalify);
		}
		assert.strictEqual(parseTernHudHost({ JobsSheet: Sheet } as never, overlay, interactive).sheet, Sheet.prototype);

		const detail: NativeNode = { k: "col", p: { role: "omp.jobs.detail" }, key: "k1", c: [{ k: "row", p: { role: "omp.jobs.status" }, c: [] }] };
		assert.throws(() => decorateJobsPage({ k: "col", c: [detail] }, () => "bg_1", () => ({ k: "spacer" })), requalify);
		const untouched: NativeNode = { k: "col", c: [detail] };
		assert.equal(decorateJobsPage(untouched, () => undefined, () => ({ k: "spacer" })).node, untouched, "another job's page is returned as omp built it");
	});

	it("offers Open only on a selected terminal job, before Cancel job, and opens with o or the button", async (t) => {
		const h = await makeHarness(t);
		const terminal = h.spawn();
		const jobs = [job(terminal.id), job("bg_other")];

		const other = h.sheet(jobs, "bg_other");
		assert.deepEqual(buttons(withRole(other.sheet.describe(cx(120)), "omp.jobs.status")), ["cancel"]);
		other.sheet.handleInput("o");
		assert.equal(h.customCalls.length, 0, "o on another job opens nothing");
		assert.equal(other.calls.closed, 0);
		other.sheet.handleInput("x");
		assert.deepEqual(other.calls.cancelled, ["bg_other"], "the page's own Cancel job still runs");

		const byKey = h.sheet(jobs, terminal.id);
		assert.deepEqual(buttons(withRole(byKey.sheet.describe(cx(120)), "omp.jobs.status")), [OPEN_TERMINAL_ACTION, "cancel"]);
		byKey.sheet.handleInput("o");
		assert.equal(byKey.calls.closed, 1, "opening closes the jobs page");
		assert.equal(h.customCalls.length, 1);
		assert.deepEqual(h.customCalls[0]!.options, { overlay: true });
		assert.equal(h.page.nativeOverlay?.size, "full");
		h.page.handleInput("\x1b");
		await h.customCalls[0]!.promise;
		assert.equal(h.customCalls[0]!.disposed, true);

		const byButton = h.sheet(jobs, terminal.id);
		byButton.sheet.handleNativeEvent(action(OPEN_TERMINAL_ACTION));
		assert.equal(byButton.calls.closed, 1);
		assert.equal(h.customCalls.length, 2);
		h.page.handleNativeEvent(action(LEAVE_ACTION));
		await h.customCalls[1]!.promise;
		assert.equal(terminal.hasExited, false, "leaving does not end the terminal");
		assert.deepEqual(h.killCalls, []);
	});

	it("opens a subagent's terminal in the session that has a UI and ends it through its own activation", async (t) => {
		const main = await makeHarness(t);
		const subagent = await makeHarness(t, false);
		const terminal = subagent.spawn();
		const page = main.sheet([job(terminal.id)], terminal.id);
		page.sheet.handleInput("o");
		assert.equal(subagent.customCalls.length, 0, "a headless activation has no UI to open in");
		assert.equal(main.customCalls.length, 1);
		main.page.handleNativeEvent(action(KILL_ACTION));
		await waitFor(() => subagent.store.get(terminal.id) === undefined, (listener) => subagent.store.subscribe(listener), "End removes the ended terminal");
		assert.deepEqual(subagent.killCalls, [terminal.id]);
		assert.deepEqual(main.killCalls, []);
	});
});

describe("Console with real terminals", () => {
	it("types into the terminal at the Console's size, shows the model's writes, and gives the size back on Esc", { skip: process.platform === "win32" }, async (t) => {
		const h = await makeHarness(t);
		const terminal = h.spawn(SIZER);
		await screenShows(terminal, "ready");
		h.sheet([job(terminal.id)], terminal.id).sheet.handleInput("o");
		const page = h.page;

		page.describe(cx(100));
		page.handleInput("first\r");
		// 100 columns less omp's 8-column inset; 80% of 50 rows less the head and actions.
		await screenShows(terminal, "got first size 36 92");

		terminal.write(new TextEncoder().encode("model\r"));
		await screenShows(terminal, "got model size 36 92");
		assert.match(ansiText(page.describe(cx(100))), /got model size 36 92/, "the Console shows what the model wrote");

		page.handleInput("\x1b");
		await h.customCalls[0]!.promise;
		terminal.write(new TextEncoder().encode("after\r"));
		await screenShows(terminal, "got after size 24 80");
		assert.equal(terminal.hasExited, false, "Esc leaves the terminal running");
	});

	it("writes typed input to a real stdin terminal verbatim while Esc leaves without being written", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn([process.execPath, "-e", [
			"process.stdin.setRawMode(true)",
			"process.stdin.on('data', (data) => process.stdout.write(data))",
			"process.stdout.write('input-ready\\n')",
		].join("; ")]);
		await screenShows(session, "input-ready");
		h.sheet([job(session.id)], session.id).sheet.handleInput("o");
		const page = h.page;
		const writes = t.mock.method(session, "write");
		page.handleInput("typed-through-page\r");
		await screenShows(session, "typed-through-page");
		assert.match(ansiText(page.describe(cx(100))), /typed-through-page/);
		assert.equal(writes.mock.callCount(), 1);
		assert.equal(Buffer.from(writes.mock.calls[0]!.arguments[0]!).toString(), "typed-through-page\r");
		page.handleInput("\x1b");
		await h.customCalls[0]!.promise;
		assert.equal(writes.mock.callCount(), 1, "Esc is navigation, not terminal input");
		assert.equal(session.hasExited, false);
	});

	it("stops forwarding input after its real child exits and removes End", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn([process.execPath, "-e", "process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0))"]);
		await screenShows(session, "ready");
		h.sheet([job(session.id)], session.id).sheet.handleInput("o");
		const page = h.page;
		const writes = t.mock.method(session, "write");
		page.handleInput("exit\r");
		await waitFor(() => session.hasExited, (listener) => session.onExit(listener), "child exits on input");
		const writeCount = writes.mock.callCount();
		page.handleInput("ignored-after-exit");
		assert.equal(writes.mock.callCount(), writeCount, "the Console gates writes rather than relying on ExecSession to reject them");
		assert.deepEqual(buttons(withRole(page.describe(cx(100)), "omp.actions")), [LEAVE_ACTION]);
		assert.deepEqual(h.killCalls, []);
	});

	it("ends the running terminal as a person through End and then shows it is no longer stored", async (t) => {
		const h = await makeHarness(t);
		const session = h.spawn();
		h.sheet([job(session.id)], session.id).sheet.handleInput("o");
		const page = h.page;
		assert.deepEqual(buttons(withRole(page.describe(cx(100)), "omp.actions")), [KILL_ACTION, LEAVE_ACTION]);
		page.handleNativeEvent(action(KILL_ACTION));
		await waitFor(() => h.store.get(session.id) === undefined, (listener) => h.store.subscribe(listener), "End removes the exited terminal");
		assert.deepEqual(h.killCalls, [session.id]);
		assert.equal(session.hasExited, true);
		const gone = page.describe(cx(100));
		assert.equal(nodes(gone).some((node) => node.k === "ansi"), false);
		assert.deepEqual(buttons(withRole(gone, "omp.actions")), [LEAVE_ACTION]);
		page.handleNativeEvent(action(LEAVE_ACTION));
		assert.equal(await h.customCalls[0]!.promise, undefined);
	});
});
