import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ansi, col, keyed, matchesKey, span, stableKey, text, type Component, type DescribeContext, type NativeNode, type NativeUiEvent } from "@oh-my-pi/pi-tui";
import type * as Overlay from "@oh-my-pi/pi-tui/native/overlay";
import type * as JobsPanel from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import type * as BashInteractive from "@oh-my-pi/pi-tui/tools/bash-interactive";

import { tr } from "./omomp-shared/i18n.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import type { ExecSession } from "./session.ts";
import type { SessionStore } from "./session-store.ts";

function requalify(change: string): Error {
	return new Error(`omp-actual-terminal: ${change}; requalify src/console.ts for this omp version`);
}

/** The jobs page's methods the open action wraps. */
export type JobsSheetPrototype = Pick<JobsPanel.JobsSheet, "describe" | "handleInput" | "handleNativeEvent">;

function isJobsSheetPrototype(value: unknown): value is JobsSheetPrototype {
	return typeof value === "object" && value !== null &&
		"describe" in value && typeof value.describe === "function" &&
		"handleInput" in value && typeof value.handleInput === "function" &&
		"handleNativeEvent" in value && typeof value.handleNativeEvent === "function";
}

export interface ConsoleHost {
	readonly sheet: JobsSheetPrototype;
	readonly actionButton: typeof Overlay.actionButton;
	readonly actionBar: typeof Overlay.actionBar;
	readonly normalizeInput: typeof BashInteractive.normalizeInputForPty;
}

export function parseConsoleHost(
	panel: Partial<Pick<typeof JobsPanel, "JobsSheet">>,
	overlay: Partial<Pick<typeof Overlay, "actionButton" | "actionBar">>,
	interactive: Partial<Pick<typeof BashInteractive, "normalizeInputForPty">>,
): ConsoleHost {
	const prototype: unknown = typeof panel.JobsSheet === "function" ? panel.JobsSheet.prototype : undefined;
	if (!isJobsSheetPrototype(prototype)) {
		throw requalify("@oh-my-pi/pi-tui/overlays/jobs-panel no longer provides JobsSheet with describe/handleInput/handleNativeEvent");
	}
	const { actionButton, actionBar } = overlay;
	if (typeof actionButton !== "function" || typeof actionBar !== "function") {
		throw requalify("@oh-my-pi/pi-tui/native/overlay no longer provides actionButton/actionBar");
	}
	const { normalizeInputForPty } = interactive;
	if (typeof normalizeInputForPty !== "function") {
		throw requalify("@oh-my-pi/pi-tui/tools/bash-interactive no longer provides normalizeInputForPty");
	}
	return { sheet: prototype, actionButton, actionBar, normalizeInput: normalizeInputForPty };
}

export async function loadConsoleHost(): Promise<ConsoleHost> {
	const [panel, overlay, interactive] = await Promise.all([
		import("@oh-my-pi/pi-tui/overlays/jobs-panel"),
		import("@oh-my-pi/pi-tui/native/overlay"),
		import("@oh-my-pi/pi-tui/tools/bash-interactive"),
	]);
	return parseConsoleHost(panel, overlay, interactive);
}

export const OPEN_ACTION = "omp-actual-terminal.console.open";
export const OPEN_KEY = "o";
export const END_ACTION = "omp-actual-terminal.console.end";
export const LEAVE_ACTION = "omp-actual-terminal.console.leave";
/** omp's own Console (`@oh-my-pi/pi-tui/tools/bash-interactive`) insets its grid from the sheet's width by the same columns. */
const CONSOLE_INSET_COLS = 8;

const DETAIL_ROLE = "omp.jobs.detail";
const STATUS_ROLE = "omp.jobs.status";

function isNode(child: unknown): child is NativeNode {
	return typeof child === "object" && child !== null && "k" in child;
}

/**
 * The jobs page's status row of the selected job with the Open button after its spacer, so it sits
 * before Cancel job. Undefined when the row lost the spacer the host puts before its actions.
 */
function withOpenButton(status: NativeNode, button: NativeNode): NativeNode | undefined {
	const children = status.c ?? [];
	const spacer = children.findIndex((child) => isNode(child) && child.k === "spacer");
	if (spacer < 0) return undefined;
	return { ...status, c: [...children.slice(0, spacer + 1), button, ...children.slice(spacer + 1)] };
}

/**
 * `described` with the Open button on the selected job's status row when that job is a terminal,
 * and which terminal that is. The jobs page keys the selected job's detail by the host's
 * `stableKey(job id)`, so the terminal is found by that key, not by reading the row's text.
 */
export function decorateJobsPage(
	described: NativeNode,
	terminalFor: (detailKey: string) => string | undefined,
	button: () => NativeNode,
): { readonly node: NativeNode; readonly terminal: string | undefined } {
	let terminal: string | undefined;
	const visit = (current: NativeNode): NativeNode => {
		if (current.p?.role === DETAIL_ROLE) {
			terminal = current.key === undefined ? undefined : terminalFor(current.key);
			if (terminal === undefined) return current;
			const children = current.c ?? [];
			const index = children.findIndex((child) => isNode(child) && child.p?.role === STATUS_ROLE);
			const status = children[index];
			const decorated = isNode(status) ? withOpenButton(status, button()) : undefined;
			if (decorated === undefined) throw requalify("the jobs page's selected job no longer has a status row with a spacer before its actions");
			return { ...current, c: children.map((child, at) => (at === index ? decorated : child)) };
		}
		const children = current.c;
		if (children === undefined) return current;
		let changed = false;
		const next = children.map((child) => {
			if (!isNode(child)) return child;
			const visited = visit(child);
			if (visited !== child) changed = true;
			return visited;
		});
		return changed ? { ...current, c: next } : current;
	};
	return { node: visit(described), terminal };
}

/** One plugin activation: its terminals, how a person ends one, and its UI when it has one. */
interface ConsoleActivation {
	readonly store: () => SessionStore;
	readonly kill: (id: string) => Promise<boolean>;
	ui: ExtensionContext["ui"] | undefined;
}

interface ConsoleRegistry {
	/** Weak: a session that ends drops its activation with it (the handlers it registered hold it). */
	readonly activations: Set<WeakRef<ConsoleActivation>>;
	readonly wrapped: WeakSet<object>;
	/** The terminal each open jobs page has selected, for its key handler. */
	readonly selected: WeakMap<object, string>;
	readonly decorated: WeakMap<NativeNode, { readonly terminal: string; readonly node: NativeNode }>;
	host: ConsoleHost | undefined;
}

const registrySymbol = Symbol.for("omp-actual-terminal.console");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: ConsoleRegistry };
const registry: ConsoleRegistry = processGlobal[registrySymbol] ??= {
	activations: new Set(),
	wrapped: new WeakSet(),
	selected: new WeakMap(),
	decorated: new WeakMap(),
	host: undefined,
};

function liveActivations(): ConsoleActivation[] {
	const live: ConsoleActivation[] = [];
	for (const ref of registry.activations) {
		const activation = ref.deref();
		if (activation === undefined) registry.activations.delete(ref);
		else live.push(activation);
	}
	return live;
}

const detailKeys = new Map<string, string>();

function detailKeyOf(id: string): string {
	let key = detailKeys.get(id);
	if (key === undefined) {
		key = stableKey(id);
		detailKeys.set(id, key);
	}
	return key;
}

function terminalForDetail(detailKey: string): string | undefined {
	for (const activation of liveActivations()) {
		for (const session of activation.store().values()) {
			if (detailKeyOf(session.id) === detailKey) return session.id;
		}
	}
	return undefined;
}

function findTerminal(id: string): { readonly session: ExecSession; readonly owner: ConsoleActivation } | undefined {
	for (const activation of liveActivations()) {
		const session = activation.store().get(id);
		if (session !== undefined) return { session, owner: activation };
	}
	return undefined;
}

function decorate(sheet: object, described: NativeNode): NativeNode {
	const host = registry.host;
	if (host === undefined) return described;
	const cached = registry.decorated.get(described);
	if (cached !== undefined && findTerminal(cached.terminal) !== undefined) {
		registry.selected.set(sheet, cached.terminal);
		return cached.node;
	}
	const { node, terminal } = decorateJobsPage(described, terminalForDetail, () =>
		host.actionButton(tr("Open", "打开"), OPEN_ACTION, { keys: OPEN_KEY }));
	if (terminal === undefined) {
		registry.selected.delete(sheet);
		return described;
	}
	registry.selected.set(sheet, terminal);
	registry.decorated.set(described, { terminal, node });
	return node;
}

/**
 * Wraps the jobs page once per process: its selected terminal gets Open (`o` or the button), which
 * closes the page and opens that terminal's Console. Every other job keeps the page's own keys and
 * actions.
 */
function wrapJobsSheet(prototype: JobsSheetPrototype): void {
	if (registry.wrapped.has(prototype)) return;
	registry.wrapped.add(prototype);
	const { describe, handleInput, handleNativeEvent } = prototype;
	const open = (sheet: JobsSheetPrototype): boolean => {
		const id = registry.selected.get(sheet);
		if (id === undefined) return false;
		const opened = openConsole(id);
		// Esc is the page's own close; the Console takes the focus the page had.
		if (opened) handleInput.call(sheet, "\x1b");
		return opened;
	};
	prototype.describe = function (this: JobsSheetPrototype, cx: DescribeContext): NativeNode {
		return decorate(this, describe.call(this, cx));
	};
	prototype.handleInput = function (this: JobsSheetPrototype, data: string): void {
		if (matchesKey(data, OPEN_KEY) && open(this)) return;
		handleInput.call(this, data);
	};
	prototype.handleNativeEvent = function (this: JobsSheetPrototype, event: NativeUiEvent): void {
		if (event.type === "action" && event.act === OPEN_ACTION) {
			open(this);
			return;
		}
		handleNativeEvent.call(this, event);
	};
}

function openConsole(id: string): boolean {
	const host = registry.host;
	const target = findTerminal(id);
	const ui = liveActivations().find((activation) => activation.ui !== undefined)?.ui;
	if (host === undefined || target === undefined || ui === undefined) return false;
	const { session, owner } = target;
	void ui.custom<void>(
		(tui, _theme, _keybindings, done) =>
			new TerminalConsole(session, host, () => tui.terminal.rows, () => tui.requestRender(), done, () => owner.kill(session.id)),
		{ overlay: true },
	);
	return true;
}

type TerminalState = { readonly kind: "running" } | { readonly kind: "ended"; readonly label: string; readonly tone: "success" | "error" };

function terminalState(session: ExecSession): TerminalState {
	if (!session.hasExited) return { kind: "running" };
	if (session.failureMessage !== null) return { kind: "ended", label: tr("failed", "失败"), tone: "error" };
	if (session.signal !== null) return { kind: "ended", label: session.signal, tone: "error" };
	if (session.exitCode === 0) return { kind: "ended", label: tr("exit 0", "退出 0"), tone: "success" };
	return {
		kind: "ended",
		label: session.exitCode === null ? tr("exited", "已退出") : tr(`exit ${session.exitCode}`, `退出 ${session.exitCode}`),
		tone: "error",
	};
}

const encoder = new TextEncoder();

/**
 * A person's view of one terminal: its screen with history, keys typed straight into it, Esc to
 * leave it running, End to end it as a person would. While it is open the terminal takes the
 * Console's size; leaving gives it back the size its call started it with.
 */
export class TerminalConsole implements Component {
	private described: { readonly key: string; readonly node: NativeNode } | undefined;
	private applied: { readonly cols: number; readonly rows: number } | undefined;
	private left = false;
	private readonly unsubscribe: readonly (() => void)[];

	constructor(
		private readonly session: ExecSession,
		private readonly host: ConsoleHost,
		private readonly terminalRows: () => number,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly end: () => Promise<boolean>,
	) {
		this.unsubscribe = [session.onScreenChange(requestRender), session.onExit(requestRender)];
	}

	get nativeOverlay(): Readonly<Record<string, unknown>> {
		const state = terminalState(this.session);
		return {
			role: "omp.overlay.console",
			size: "full",
			head: [
				{ t: tr("Console · ", "控制台 · "), s: "muted" },
				{ t: `${this.session.id} ` },
				{ t: sanitizeOutputText(this.session.title) },
				{ t: "  " },
				state.kind === "running" ? { t: tr("running", "运行中"), s: "accent" } : { t: state.label, s: state.tone },
			],
		};
	}

	describe(cx: DescribeContext): NativeNode {
		const running = !this.session.hasExited;
		if (running) this.follow(Math.max(20, cx.cols - CONSOLE_INSET_COLS), Math.max(1, Math.max(5, Math.floor(this.terminalRows() * 0.8)) - 4));
		const key = `${this.session.screenRevision() ?? "gone"}|${running}`;
		if (this.described?.key === key) return this.described.node;
		const screen = this.session.styledScreen();
		const body = screen === undefined
			? text([span(tr("This terminal's screen is no longer kept.", "此终端的屏幕已不再保留。"), "dim")])
			: keyed(ansi(screen.text, { cols: screen.view.cols, follow: true, grow: 1, max: { h: 1 } }), "screen");
		const note = text([span(running ? tr("Keys go to the terminal", "按键将发送到终端") : tr("Terminal finished", "终端已结束"), "dim")]);
		const actions = this.host.actionBar([
			note,
			null,
			...(running ? [this.host.actionButton(tr("End", "结束"), END_ACTION, { tone: "error" })] : []),
			this.host.actionButton(tr("Leave", "离开"), LEAVE_ACTION, { keys: "escape" }),
		]);
		const node = col([body, actions], { gap: "sm", min: { h: 1 } });
		this.described = { key, node };
		return node;
	}

	/** The terminal takes the Console's grid; the model reads the same, resized screen meanwhile. */
	private follow(cols: number, rows: number): void {
		if (this.applied?.cols === cols && this.applied.rows === rows) return;
		if (this.session.resize(cols, rows)) this.applied = { cols, rows };
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.leave();
			return;
		}
		if (this.session.hasExited) return;
		const input = this.host.normalizeInput(data, this.session.applicationCursorKeys());
		if (input) this.session.write(encoder.encode(input));
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === LEAVE_ACTION) this.leave();
		else if (event.act === END_ACTION && !this.session.hasExited) void this.end().then(this.requestRender);
	}

	private leave(): void {
		if (this.left) return;
		this.left = true;
		this.release();
		this.done();
	}

	/** Gives the terminal back its own size and stops watching it. */
	private release(): void {
		for (const unsubscribe of this.unsubscribe) unsubscribe();
		if (this.applied !== undefined) {
			this.applied = undefined;
			this.session.resize(this.session.size.cols, this.session.size.rows);
		}
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		this.release();
	}
}

/**
 * Offers each of this activation's terminals on omp's jobs page and opens its Console from there.
 * The UI comes from the activation that has one: a subagent's terminals open in its main session.
 */
export function mountConsole(pi: ExtensionAPI, store: () => SessionStore, host: ConsoleHost, kill: (id: string) => Promise<boolean>): void {
	registry.host = host;
	wrapJobsSheet(host.sheet);
	const activation: ConsoleActivation = { store, kill, ui: undefined };
	registry.activations.add(new WeakRef(activation));
	pi.on("session_start", async (_event, ctx) => {
		activation.ui = ctx.hasUI ? ctx.ui : undefined;
	});
	pi.on("session_shutdown", async () => {
		activation.ui = undefined;
	});
}
