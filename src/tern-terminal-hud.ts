import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, stableKey, type Component, type DescribeContext, type NativeNode, type NativeUiEvent } from "@oh-my-pi/pi-tui";
import type * as Overlay from "@oh-my-pi/pi-tui/native/overlay";
import type * as JobsPanel from "@oh-my-pi/pi-tui/overlays/jobs-panel";
import type * as BashInteractive from "@oh-my-pi/pi-tui/tools/bash-interactive";

import { sanitizeOutputText } from "./output-safety.ts";
import { tr } from "./omomp-shared/i18n.ts";
import type { ExecSession } from "./session.ts";
import type { SessionStore } from "./session-store.ts";
import type { StyledScreen } from "./terminal-screen.ts";

function requalify(change: string): Error {
	return new Error(`omp-actual-terminal: ${change}; requalify src/tern-terminal-hud.ts for this omp version`);
}

/** The jobs page's methods the Open action wraps. */
export type JobsSheetPrototype = Pick<JobsPanel.JobsSheet, "describe" | "handleInput" | "handleNativeEvent">;

function isJobsSheetPrototype(value: unknown): value is JobsSheetPrototype {
	return typeof value === "object" && value !== null &&
		"describe" in value && typeof value.describe === "function" &&
		"handleInput" in value && typeof value.handleInput === "function" &&
		"handleNativeEvent" in value && typeof value.handleNativeEvent === "function";
}

export interface TernHudHost {
	readonly sheet: JobsSheetPrototype;
	readonly actionButton: typeof Overlay.actionButton;
	readonly actionBar: typeof Overlay.actionBar;
	readonly normalizeInput: typeof BashInteractive.normalizeInputForPty;
}

export function parseTernHudHost(
	panel: Partial<Pick<typeof JobsPanel, "JobsSheet">>,
	overlay: Partial<Pick<typeof Overlay, "actionButton" | "actionBar">>,
	interactive: Partial<Pick<typeof BashInteractive, "normalizeInputForPty">>,
): TernHudHost {
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

export const OPEN_TERMINAL_ACTION = "omp-actual-terminal.terminal.open";
export const OPEN_KEY = "o";
export const KILL_ACTION = "kill";
export const LEAVE_ACTION = "leave";
/** omp's own Console (`@oh-my-pi/pi-tui/tools/bash-interactive`) insets its grid from the sheet's width by the same columns. */
const CONSOLE_INSET_COLS = 8;

export type TerminalState =
	| { readonly kind: "running" }
	| {
			readonly kind: "exited";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly failure: string | null;
	  };

export interface TerminalSummary {
	readonly id: string;
	readonly title: string;
	readonly state: TerminalState;
}

export interface TerminalEntry extends TerminalSummary {
	readonly screen: StyledScreen;
}

const TITLE_MAX = 120;

function oneLine(text: string): string {
	const line = sanitizeOutputText(text).replace(/\s+/g, " ").trim();
	return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1)}…`;
}

function terminalSummary(session: ExecSession): TerminalSummary {
	const state: TerminalState = session.hasExited
		? { kind: "exited", exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage }
		: { kind: "running" };
	return { id: session.id, title: oneLine(session.title), state };
}

function exitSucceeded(state: Extract<TerminalState, { kind: "exited" }>): boolean {
	return state.exitCode === 0 && state.signal === null && state.failure === null;
}

function stateText(state: TerminalState): string {
	if (state.kind === "running") return tr("running", "运行中");
	if (state.failure !== null) return tr(`failed: ${oneLine(state.failure)}`, `失败：${oneLine(state.failure)}`);
	if (state.signal !== null) return state.signal;
	return state.exitCode === null ? tr("exited", "已退出") : tr(`exit ${state.exitCode}`, `退出 ${state.exitCode}`);
}

function stateTone(state: TerminalState): string {
	if (state.kind === "running") return "accent";
	return exitSucceeded(state) ? "success" : "error";
}

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

export function terminalPageFrame(entry: TerminalSummary | undefined, id: string): Readonly<Record<string, unknown>> {
	return {
		role: "omp.overlay.console",
		size: "full",
		head: [
			{ t: tr("Console · ", "控制台 · "), s: "muted" },
			{ t: `${id} ` },
			...(entry ? [{ t: entry.title }, { t: "  " }, { t: stateText(entry.state), s: stateTone(entry.state) }] : [{ t: tr("removed", "已移除"), s: "muted" }]),
		],
	};
}

export function describeTerminalPage(entry: TerminalEntry | undefined, host: Pick<TernHudHost, "actionButton" | "actionBar">): NativeNode {
	const leave = host.actionButton(tr("Leave", "离开"), LEAVE_ACTION, { keys: "escape" });
	if (!entry) {
		return {
			k: "col",
			p: { gap: "sm" },
			c: [
				{ k: "text", key: "gone", p: { spans: [{ t: tr("This terminal is no longer stored.", "此终端已不再存储。"), s: "dim" }] } },
				host.actionBar([null, leave]),
			],
		};
	}
	const running = entry.state.kind === "running";
	return {
		k: "col",
		p: { gap: "sm", min: { h: 1 } },
		c: [
			{
				k: "ansi",
				key: `page-s${entry.id}`,
				p: {
					text: entry.screen.text,
					cols: entry.screen.view.cols,
					follow: true,
					grow: 1,
					max: { h: 1 },
				},
			},
			host.actionBar([
				{ k: "text", key: "note", p: { spans: [{ t: running ? tr("Keys go to the terminal", "按键将发送到终端") : tr("Terminal finished", "终端已结束"), s: "dim" }] } },
				null,
				...(running ? [host.actionButton(tr("End", "结束"), KILL_ACTION, { tone: "error" })] : []),
				leave,
			]),
		],
	};
}

function summaryOf(session: ExecSession | undefined): TerminalSummary | undefined {
	return session?.screenRevision() === undefined ? undefined : terminalSummary(session);
}

function entryOf(session: ExecSession | undefined): TerminalEntry | undefined {
	const screen = session?.styledScreen();
	return session && screen ? { ...terminalSummary(session), screen } : undefined;
}

export type KillSession = (id: string) => Promise<boolean>;

/** Watches one stored terminal: its removal from the store, its exit, and its screen. */
class SessionWatch {
	private watched: { readonly session: ExecSession; readonly unsubscribe: readonly (() => void)[] } | undefined;
	private readonly unsubscribeStore: () => void;

	constructor(
		private readonly store: SessionStore,
		private readonly id: string,
		private readonly changed: () => void,
	) {
		this.unsubscribeStore = store.subscribe(() => {
			this.sync();
			changed();
		});
		this.sync();
	}

	private sync(): void {
		const session = this.store.get(this.id);
		if (this.watched?.session === session) return;
		this.unwatch();
		if (session) this.watched = { session, unsubscribe: [session.onExit(this.changed), session.onScreenChange(this.changed)] };
	}

	private unwatch(): void {
		for (const unsubscribe of this.watched?.unsubscribe ?? []) unsubscribe();
		this.watched = undefined;
	}

	dispose(): void {
		this.unsubscribeStore();
		this.unwatch();
	}
}

const encoder = new TextEncoder();

/**
 * A person's view of one terminal: its screen with history, keys typed straight into it, Esc to
 * leave it running, End to end it as a person would. While it is open the terminal takes the
 * Console's size; leaving gives it back the size its call started it with.
 */
class TerminalPage implements Component {
	private described: NativeNode | undefined;
	private applied: { readonly session: ExecSession; readonly cols: number; readonly rows: number } | undefined;
	private left = false;
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		private readonly id: string,
		private readonly host: TernHudHost,
		private readonly terminalRows: () => number,
		private readonly requestRender: () => void,
		private readonly back: () => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, id, this.changed);
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private session(): ExecSession | undefined {
		return this.store.get(this.id);
	}

	get nativeOverlay(): Readonly<Record<string, unknown>> {
		return terminalPageFrame(summaryOf(this.session()), this.id);
	}

	describe(cx: DescribeContext): NativeNode {
		const session = this.session();
		if (session && !session.hasExited) {
			this.follow(session, Math.max(20, cx.cols - CONSOLE_INSET_COLS), Math.max(1, Math.max(5, Math.floor(this.terminalRows() * 0.8)) - 4));
		}
		this.described ??= describeTerminalPage(entryOf(session), this.host);
		return this.described;
	}

	/** The terminal takes the Console's grid; the model reads the same, resized screen meanwhile. */
	private follow(session: ExecSession, cols: number, rows: number): void {
		const applied = this.applied;
		if (applied?.session === session && applied.cols === cols && applied.rows === rows) return;
		if (session.resize(cols, rows)) this.applied = { session, cols, rows };
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === LEAVE_ACTION) this.leave();
		else if (event.act === KILL_ACTION && this.session() && !this.session()!.hasExited) void this.kill(this.id).then(this.changed);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.leave();
			return;
		}
		const session = this.session();
		if (!session || session.hasExited) return;
		const input = this.host.normalizeInput(data, session.applicationCursorKeys());
		if (input) session.write(encoder.encode(input));
	}

	private leave(): void {
		if (this.left) return;
		this.left = true;
		this.release();
		this.back();
	}

	/** Gives the terminal back its own size and stops watching it. */
	private release(): void {
		this.watch.dispose();
		const applied = this.applied;
		if (applied === undefined) return;
		this.applied = undefined;
		applied.session.resize(applied.session.size.cols, applied.session.size.rows);
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

/** One plugin activation: its terminals, how a person ends one, and its UI when it has one. */
interface HudActivation {
	readonly store: () => SessionStore;
	readonly kill: KillSession;
	ui: ExtensionContext["ui"] | undefined;
}

interface HudRegistry {
	/** Weak: a session that ends drops its activation with it (the handlers it registered hold it). */
	readonly activations: Set<WeakRef<HudActivation>>;
	readonly wrapped: WeakSet<object>;
	/** The terminal each open jobs page has selected, for its key handler. */
	readonly selected: WeakMap<object, string>;
	readonly decorated: WeakMap<NativeNode, { readonly terminal: string; readonly node: NativeNode }>;
	host: TernHudHost | undefined;
}

const registrySymbol = Symbol.for("omp-actual-terminal.tern-hud");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: HudRegistry };
const registry: HudRegistry = processGlobal[registrySymbol] ??= {
	activations: new Set(),
	wrapped: new WeakSet(),
	selected: new WeakMap(),
	decorated: new WeakMap(),
	host: undefined,
};

function liveActivations(): HudActivation[] {
	const live: HudActivation[] = [];
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

function ownerOf(id: string): HudActivation | undefined {
	return liveActivations().find((activation) => activation.store().get(id) !== undefined);
}

function decorate(sheet: object, described: NativeNode): NativeNode {
	const host = registry.host;
	if (host === undefined) return described;
	const cached = registry.decorated.get(described);
	if (cached !== undefined && ownerOf(cached.terminal) !== undefined) {
		registry.selected.set(sheet, cached.terminal);
		return cached.node;
	}
	const { node, terminal } = decorateJobsPage(described, terminalForDetail, () =>
		host.actionButton(tr("Open", "打开"), OPEN_TERMINAL_ACTION, { keys: OPEN_KEY }));
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
export function wrapJobsSheet(prototype: JobsSheetPrototype): void {
	if (registry.wrapped.has(prototype)) return;
	registry.wrapped.add(prototype);
	const { describe, handleInput, handleNativeEvent } = prototype;
	const open = (sheet: JobsSheetPrototype): boolean => {
		const id = registry.selected.get(sheet);
		if (id === undefined) return false;
		const opened = openTerminalPage(id);
		// The page's own Close action, whatever key closes it; the Console takes the focus the page had.
		if (opened) handleNativeEvent.call(sheet, { type: "action", key: "", act: "close", mods: [] });
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
		if (event.type === "action" && event.act === OPEN_TERMINAL_ACTION) {
			open(this);
			return;
		}
		handleNativeEvent.call(this, event);
	};
}

function openTerminalPage(id: string): boolean {
	const host = registry.host;
	const owner = ownerOf(id);
	const ui = liveActivations().find((activation) => activation.ui !== undefined)?.ui;
	if (host === undefined || owner === undefined || ui === undefined) return false;
	void ui.custom<void>(
		(tui, _theme, _keybindings, done) =>
			new TerminalPage(owner.store(), id, host, () => tui.terminal.rows, () => tui.requestRender(), () => done(), owner.kill),
		{ overlay: true },
	);
	return true;
}

export async function loadTernHudHost(): Promise<TernHudHost> {
	const [panel, overlay, interactive] = await Promise.all([
		import("@oh-my-pi/pi-tui/overlays/jobs-panel"),
		import("@oh-my-pi/pi-tui/native/overlay"),
		import("@oh-my-pi/pi-tui/tools/bash-interactive"),
	]);
	return parseTernHudHost(panel, overlay, interactive);
}

/**
 * Offers each of this activation's terminals on omp's jobs page and opens its Console from there.
 * The UI comes from the activation that has one: a subagent's terminals open in its main session.
 */
export function mountTerminalHud(pi: ExtensionAPI, store: () => SessionStore, host: TernHudHost, kill: KillSession): void {
	registry.host = host;
	wrapJobsSheet(host.sheet);
	const activation: HudActivation = { store, kill, ui: undefined };
	registry.activations.add(new WeakRef(activation));
	pi.on("session_start", async (_event, eventCtx) => {
		activation.ui = eventCtx.hasUI ? eventCtx.ui : undefined;
	});
	pi.on("session_shutdown", async () => {
		activation.ui = undefined;
	});
}
