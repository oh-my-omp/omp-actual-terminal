import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui";
import { JobsSheet, type JobsPanelJob, type JobsSheetSource } from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import { END_ACTION, LEAVE_ACTION, loadConsoleHost, mountConsole, OPEN_ACTION, decorateJobsPage } from "../src/console.ts";
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

function screenText(node: NativeNode): string {
	return nodes(node).filter((candidate) => candidate.k === "ansi").map((candidate) => {
		const value: unknown = candidate.p && "text" in candidate.p ? candidate.p.text : undefined;
		return typeof value === "string" ? value : "";
	}).join("\n");
}

function cx(cols: number): DescribeContext {
	return { cols, reduceMotion: true, dark: true, supports: () => false, feature: () => false };
}

/** The Console as Tern sees it in a 100-column sheet. */
function consoleNode(component: Component): NativeNode {
	const node = component.describe?.(cx(100));
	assert.ok(node, "the Console describes itself");
	return node;
}
function action(act: string): NativeUiEvent {
	return { type: "action", key: "", act, mods: [] };
}

async function until(condition: () => boolean, subscribe: (listener: () => void) => () => void, label: string | (() => string)): Promise<void> {
	if (condition()) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const stop = subscribe(() => {
		if (!condition()) return;
		clearTimeout(deadline);
		stop();
		resolve();
	});
	// A deadline on a real child, not a wait: the awaited event names the failure.
	const deadline = setTimeout(() => {
		stop();
		reject(new Error(`timed out: ${typeof label === "string" ? label : label()}`));
	}, 3_000);
	await promise;
}

function job(id: string): JobsPanelJob {
	return { id, type: "bash", status: "running", label: `job ${id}`, startTime: Date.now() };
}

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];

/** A plugin activation with a real store and real PTY sessions, mounted on omp's real jobs page. */
async function makeHarness(t: TestContext) {
	const host = await loadConsoleHost();
	const store = new SessionStore({ maxSessions: 20, lruProtectedCount: 0 });
	const handlers = new Map<string, Handler[]>();
	const sessions: ExecSession[] = [];
	const killed: string[] = [];
	const opened: { component: Component & { nativeOverlay?: { role?: string } }; overlay: boolean | undefined; closed: Promise<unknown> }[] = [];
	let terminalRows = 50;
	const ui = {
		custom(factory: CustomFactory, options?: { overlay?: boolean }): Promise<unknown> {
			const { promise: closed, resolve } = Promise.withResolvers<unknown>();
			const tui = { terminal: { get rows() { return terminalRows; } }, requestRender() {} };
			const component = factory(tui as never, {} as never, {} as never, (value?: unknown) => resolve(value)) as Component;
			opened.push({ component, overlay: options?.overlay, closed });
			return closed;
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	mountConsole(pi, () => store, host, async (id) => {
		killed.push(id);
		const session = store.get(id);
		if (session === undefined) return false;
		const exited = until(() => session.hasExited, (listener) => session.onExit(listener), "ended terminal exits");
		session.terminate("SIGKILL");
		await exited;
		return true;
	});
	for (const handler of handlers.get("session_start") ?? []) await handler({}, { hasUI: true, ui } as unknown as ExtensionContext);

	t.after(async () => {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {} as ExtensionContext);
		for (const session of sessions) session.terminate("SIGKILL");
		await Promise.all(sessions.map((session) => until(() => session.hasExited, (listener) => session.onExit(listener), "test terminal exits")));
		await Promise.all(sessions.map((session) => session.release()));
		for (const session of sessions) store.remove(session.id);
	});

	return {
		store,
		killed,
		opened,
		set terminalRows(rows: number) { terminalRows = rows; },
		/** `sh` reading lines and answering each with the terminal's own size as the kernel reports it. */
		spawn(id: string): ExecSession {
			const session = ExecSession.spawn(id, {
				title: "Console test",
				shell: "test",
				command: ["/bin/sh", "-c", "stty -echo; echo ready; while read line; do echo \"got $line size $(stty size)\"; done"],
				cwd: process.cwd(),
				env: process.env,
				cols: 80,
				rows: 24,
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
			return { sheet: new JobsSheet(source, { selected }), calls };
		},
	};
}

async function screenShows(session: ExecSession, needle: string): Promise<void> {
	await until(() => session.styledScreen()?.text.includes(needle) === true, (listener) => session.onScreenChange(listener),
		() => `screen shows ${needle}; screen is ${JSON.stringify(session.styledScreen()?.text)}`);
}

describe("Console from omp's jobs page", () => {
	it("offers Open only on a selected terminal job, before Cancel job, and opens with o or the button", async (t) => {
		const h = await makeHarness(t);
		const terminal = h.spawn("bg_1");
		await screenShows(terminal, "ready");
		const jobs = [job("bg_1"), job("bg_9")];

		const other = h.sheet(jobs, "bg_9");
		assert.deepEqual(buttons(withRole(other.sheet.describe(cx(120)), "omp.jobs.status")), ["cancel"]);
		other.sheet.handleInput("o");
		assert.equal(h.opened.length, 0, "o on another job opens nothing");
		assert.equal(other.calls.closed, 0);
		other.sheet.handleInput("x");
		assert.deepEqual(other.calls.cancelled, ["bg_9"], "the page's own Cancel job still runs");

		const byKey = h.sheet(jobs, "bg_1");
		assert.deepEqual(buttons(withRole(byKey.sheet.describe(cx(120)), "omp.jobs.status")), [OPEN_ACTION, "cancel"]);
		byKey.sheet.handleInput("o");
		assert.equal(byKey.calls.closed, 1, "opening closes the jobs page");
		assert.equal(h.opened.length, 1);
		assert.equal(h.opened[0]!.overlay, true);
		assert.equal(h.opened[0]!.component.nativeOverlay?.role, "omp.overlay.console");
		h.opened[0]!.component.handleInput?.("\x1b");
		await h.opened[0]!.closed;

		const byButton = h.sheet(jobs, "bg_1");
		byButton.sheet.describe(cx(120));
		byButton.sheet.handleNativeEvent?.(action(OPEN_ACTION));
		assert.equal(byButton.calls.closed, 1);
		assert.equal(h.opened.length, 2);
		h.opened[1]!.component.handleNativeEvent?.(action(LEAVE_ACTION));
		await h.opened[1]!.closed;
		assert.equal(terminal.hasExited, false);
	});

	it("types into the terminal at the Console's size, leaves on Esc and gives the size back", async (t) => {
		const h = await makeHarness(t);
		const terminal = h.spawn("bg_1");
		await screenShows(terminal, "ready");
		const page = h.sheet([job("bg_1")], "bg_1");
		page.sheet.describe(cx(120));
		page.sheet.handleInput("o");
		const { component, closed } = h.opened[0]!;

		h.terminalRows = 50;
		component.describe?.(cx(100));
		component.handleInput?.("first\r");
		// 100 columns less omp's 8-column inset; 80% of 50 rows less the head and actions.
		await screenShows(terminal, "got first size 36 92");

		terminal.write(new TextEncoder().encode("model\r"));
		await screenShows(terminal, "got model size 36 92");
		assert.match(screenText(consoleNode(component)), /got model size 36 92/, "the Console shows what the model wrote");

		component.handleInput?.("\x1b");
		await closed;
		terminal.write(new TextEncoder().encode("after\r"));
		await screenShows(terminal, "got after size 24 80");
		assert.equal(terminal.hasExited, false, "Esc leaves the terminal running");
		assert.deepEqual(h.killed, []);
	});

	it("ends the terminal as a person through End and stops taking input once it has ended", async (t) => {
		const h = await makeHarness(t);
		const terminal = h.spawn("bg_1");
		await screenShows(terminal, "ready");
		const page = h.sheet([job("bg_1")], "bg_1");
		page.sheet.describe(cx(120));
		page.sheet.handleInput("o");
		const { component } = h.opened[0]!;
		const actions = withRole(consoleNode(component), "omp.actions");
		assert.deepEqual(buttons(actions), [END_ACTION, LEAVE_ACTION]);

		component.handleNativeEvent?.(action(END_ACTION));
		await until(() => terminal.hasExited, (listener) => terminal.onExit(listener), "End ends the terminal");
		assert.deepEqual(h.killed, ["bg_1"]);
		assert.deepEqual(buttons(withRole(consoleNode(component), "omp.actions")), [LEAVE_ACTION]);
		const writes = t.mock.method(terminal, "write");
		component.handleInput?.("ignored");
		assert.equal(writes.mock.callCount(), 0);
	});

	it("names the omp change when the selected terminal's status row loses its spacer", () => {
		const detail: NativeNode = { k: "col", p: { role: "omp.jobs.detail" }, key: "k1", c: [{ k: "row", p: { role: "omp.jobs.status" }, c: [] }] };
		assert.throws(
			() => decorateJobsPage({ k: "col", c: [detail] }, () => "bg_1", () => ({ k: "spacer" })),
			{ message: /requalify src\/console\.ts/ },
		);
		const untouched: NativeNode = { k: "col", c: [detail] };
		assert.equal(decorateJobsPage(untouched, () => undefined, () => ({ k: "spacer" })).node, untouched, "another job's page is returned as omp built it");
	});
});
