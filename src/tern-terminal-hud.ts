import type { ExtensionAPI, ExtensionContext, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import type { AutocompleteItem } from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	createRoot,
	effect,
	isUiNode,
	type JSX,
	type JSXNode,
	jsx,
	type KeyEvent,
	nativeRendering,
	type PasteEvent,
	signal,
	type Signal,
	type UiNode,
} from "@oh-my-pi/pi-tui";

import { sanitizeOutputText } from "./output-safety.ts";
import { tr } from "./omomp-shared/i18n.ts";
import type { ExecSession } from "./session.ts";
import type { SessionStore } from "./session-store.ts";
import type { StyledScreen } from "./terminal-screen.ts";

export const KILL_ACTION = "kill";
export const LEAVE_ACTION = "leave";

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

const PAGE_ROLE = "omp.overlay.console";

interface HeadSpan {
	readonly t: string;
	readonly s?: string;
}

function frameHead(entry: TerminalSummary | undefined, id: string): readonly HeadSpan[] {
	if (entry === undefined) {
		return [{ t: tr("Console · ", "控制台 · "), s: "muted" }, { t: `${id} ` }, { t: tr("removed", "已移除"), s: "muted" }];
	}
	return [
		{ t: tr("Console · ", "控制台 · "), s: "muted" },
		{ t: `${id} ` },
		{ t: entry.title },
		{ t: "  " },
		{ t: stateText(entry.state), s: stateTone(entry.state) },
	];
}

export function terminalPageFrame(
	entry: TerminalSummary | undefined,
	id: string,
): {
	readonly role: typeof PAGE_ROLE;
	readonly anchor: "bottom";
	readonly size: "full";
	readonly head: readonly HeadSpan[];
} {
	return { role: PAGE_ROLE, anchor: "bottom", size: "full", head: frameHead(entry, id) };
}

function el<K extends keyof JSX.IntrinsicElements>(kind: K, props: JSX.IntrinsicElements[K]): UiNode {
	const node: JSXNode = jsx(kind, { ...props });
	if (!isUiNode(node)) throw new TypeError(`omp-actual-terminal: jsx(${String(kind)}) did not build a node`);
	return node;
}

function consoleFooter(entry: () => TerminalEntry | undefined): JSXNode {
	return el("row", {
		key: "footer",
		role: "omp.actions",
		align: "center",
		gap: "sm",
		children: () => {
			const current = entry();
			const leave = el("button", {
				key: "leave",
				text: tr("Leave", "离开"),
				keys: ["escape"],
				actions: { click: LEAVE_ACTION },
			});
			if (current === undefined) return [el("spacer", { key: "spacer", grow: 1 }), leave];
			const running = current.state.kind === "running";
			return [
				el("text", {
					key: "note",
					spans: [{ t: running ? tr("Keys go to the terminal", "按键将发送到终端") : tr("Terminal finished", "终端已结束"), s: "dim" }],
				}),
				el("spacer", { key: "spacer", grow: 1 }),
				running ? el("button", { key: "end", text: tr("End", "结束"), variant: "danger", actions: { click: KILL_ACTION } }) : null,
				leave,
			];
		},
	});
}

export function describeTerminalPage(entry: () => TerminalEntry | undefined): JSXNode {
	return el("col", {
		key: "body",
		gap: "sm",
		min: { h: 1 },
		children: [
			el("text", {
				key: "gone",
				hidden: () => entry() !== undefined,
				spans: [{ t: tr("This terminal is no longer stored.", "此终端已不再存储。"), s: "dim" }],
			}),
			el("ansi", {
				key: "screen",
				hidden: () => entry() === undefined,
				follow: true,
				grow: 1,
				min: { h: 1 },
				text: () => entry()?.screen.text ?? "",
				cols: () => entry()?.screen.view.cols ?? 1,
			}),
			consoleFooter(entry),
		],
	});
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

const CURSOR_KEYS: Readonly<Record<string, string>> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	insert: "\x1b[2~",
	delete: "\x1b[3~",
	"shift+tab": "\x1b[Z",
	enter: "\r",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	escape: "\x1b",
};

const KITTY_SEQUENCE = /^\x1b\[[\d;:]*[u~A-Z]$/;

export function consoleKeyBytes(key: KeyEvent, applicationCursorKeys: boolean): string {
	if (key.kind === "release") return "";
	const cursor = CURSOR_KEYS[key.id];
	if (cursor !== undefined) return applicationCursorKeys ? `\x1bO${cursor}` : `\x1b[${cursor}`;
	const named = NAMED_KEYS[key.id];
	if (named !== undefined) return named;
	const ctrl = /^ctrl\+([a-z])$/.exec(key.id)?.[1];
	if (ctrl !== undefined) return String.fromCharCode(ctrl.charCodeAt(0) - 96);
	const alt = /^alt\+(.)$/.exec(key.id);
	if (alt !== null) return `\x1b${key.text ?? alt[1]}`;
	if (key.text) return key.text;
	return KITTY_SEQUENCE.test(key.raw) ? "" : key.raw;
}

const SHEET_COLS = 8;
const FRAME_COLS = 2;
const FRAME_ROWS = 4;

export function consoleGrid(columns: number, rows: number): { readonly cols: number; readonly rows: number } {
	return {
		cols: Math.max(20, columns - (nativeRendering() ? SHEET_COLS : FRAME_COLS)),
		rows: Math.max(1, Math.max(5, Math.floor(rows * 0.8)) - FRAME_ROWS),
	};
}

/**
 * A person's view of one terminal: its screen with history, keys typed straight into it, Esc to
 * leave it running, End to end it as a person would. While it is open the terminal takes the
 * Console's size; leaving gives it back the size its call started it with.
 */
class TerminalPage {
	private readonly revision: Signal<number> = signal(0);
	private readonly watch: SessionWatch;
	private applied: { readonly session: ExecSession; readonly cols: number; readonly rows: number } | undefined;
	private left = false;

	constructor(
		private readonly store: SessionStore,
		private readonly id: string,
		private readonly ui: ExtensionUiHost,
		private readonly kill: KillSession,
		private readonly done: () => void,
		private readonly disposeRoot: () => void,
	) {
		this.watch = new SessionWatch(store, id, this.changed);
	}

	private readonly changed = (): void => {
		if (this.session() === undefined) {
			this.leave();
			return;
		}
		this.revision.update((revision) => revision + 1);
	};

	private session(): ExecSession | undefined {
		return this.store.get(this.id);
	}

	private summary(): TerminalSummary | undefined {
		this.revision();
		return summaryOf(this.session());
	}

	private entry(): TerminalEntry | undefined {
		this.revision();
		return entryOf(this.session());
	}

	view(): JSXNode {
		this.trackSize();
		const head = (): readonly HeadSpan[] => frameHead(this.summary(), this.id);
		const handlers = {
			onKey: (key: KeyEvent): boolean => this.key(key),
			onPaste: (paste: PasteEvent): boolean => this.paste(paste),
			onAction: (act: string): void => this.action(act),
		};
		const body = describeTerminalPage(() => this.entry());
		return nativeRendering()
			? el("overlay", {
					role: PAGE_ROLE,
					anchor: "bottom",
					size: "full",
					head,
					...handlers,
					children: body,
				})
			: el("col", {
					...handlers,
					children: [
						el("text", { key: "head", wrap: "none", truncate: "end", spans: head }),
						body,
					],
				});
	}

	private trackSize(): void {
		effect(() => {
			const size = this.ui.size();
			this.follow(consoleGrid(size.columns, size.rows));
		});
	}

	/** The terminal takes the Console's grid; the model reads the same, resized screen meanwhile. */
	private follow(grid: { readonly cols: number; readonly rows: number }): void {
		const session = this.session();
		if (session === undefined || session.hasExited) return;
		const applied = this.applied;
		if (applied?.session === session && applied.cols === grid.cols && applied.rows === grid.rows) return;
		if (session.resize(grid.cols, grid.rows)) this.applied = { session, cols: grid.cols, rows: grid.rows };
	}

	private key(key: KeyEvent): boolean {
		if (key.kind !== "release" && key.id === "escape") {
			this.leave();
			return true;
		}
		const session = this.session();
		if (session !== undefined && !session.hasExited) {
			const bytes = consoleKeyBytes(key, session.applicationCursorKeys());
			if (bytes.length > 0) session.write(encoder.encode(bytes));
		}
		return true;
	}

	private paste(paste: PasteEvent): boolean {
		const session = this.session();
		if (session !== undefined && !session.hasExited) session.write(encoder.encode(paste.text));
		return true;
	}

	private action(act: string): void {
		if (act === LEAVE_ACTION) {
			this.leave();
			return;
		}
		if (act !== KILL_ACTION) return;
		const session = this.session();
		if (session === undefined || session.hasExited) return;
		void this.kill(this.id).then(this.changed);
	}

	private leave(): void {
		if (this.left) return;
		this.left = true;
		this.release();
		this.disposeRoot();
		this.done();
	}

	/** Gives the terminal back its own size and stops watching it. */
	private release(): void {
		this.watch.dispose();
		const applied = this.applied;
		if (applied === undefined) return;
		this.applied = undefined;
		applied.session.resize(applied.session.size.cols, applied.session.size.rows);
	}
}

/** One plugin activation: its terminals and how a person ends one. */
interface HudActivation {
	readonly store: () => SessionStore;
	readonly kill: KillSession;
}

type ConsoleUi = ExtensionContext["ui"];

interface HudRegistry {
	/** Weak: a session that ends drops its activation with it (the command it registered holds it). */
	readonly activations: Set<WeakRef<HudActivation>>;
	/** The UIs showing a Console now: one Console per UI. */
	readonly showing: WeakSet<ConsoleUi>;
}

export const TERMINALS_COMMAND = "terminals";

const registrySymbol = Symbol.for("omp-actual-terminal.console-registry");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: HudRegistry };
const registry: HudRegistry = processGlobal[registrySymbol] ??= { activations: new Set(), showing: new WeakSet() };

function liveActivations(): HudActivation[] {
	const live: HudActivation[] = [];
	for (const ref of registry.activations) {
		const activation = ref.deref();
		if (activation === undefined) registry.activations.delete(ref);
		else live.push(activation);
	}
	return live;
}

function ownerOf(id: string): HudActivation | undefined {
	return liveActivations().find((activation) => activation.store().get(id) !== undefined);
}

/** The process's stored terminals, `first`'s before the rest, each once. */
function listTerminals(first?: HudActivation): TerminalSummary[] {
	const activations = liveActivations();
	const ordered = first === undefined ? activations : [first, ...activations.filter((activation) => activation !== first)];
	const seen = new Set<string>();
	const terminals: TerminalSummary[] = [];
	for (const activation of ordered) {
		for (const session of activation.store().values()) {
			if (seen.has(session.id)) continue;
			seen.add(session.id);
			terminals.push(terminalSummary(session));
		}
	}
	return terminals;
}

/** Shows terminal `id`'s Console in `ui`; false when no activation stores it or `ui` already shows one. */
export function openTerminalConsole(id: string, ui: ConsoleUi): boolean {
	const owner = ownerOf(id);
	if (owner === undefined || registry.showing.has(ui)) return false;
	registry.showing.add(ui);
	const closed = (): void => {
		registry.showing.delete(ui);
	};
	void ui.custom<void>(
		(host, _theme, _keybindings, done) =>
			createRoot((dispose) => new TerminalPage(owner.store(), id, host, owner.kill, () => {
				closed();
				done();
			}, dispose).view()),
		{ overlay: true },
	).catch(closed);
	return true;
}

function terminalLabel(terminal: TerminalSummary): string {
	return `${terminal.id}  ${terminal.title}  ${stateText(terminal.state)}`;
}

function terminalCompletions(activation: HudActivation, prefix: string): AutocompleteItem[] | null {
	const wanted = prefix.trim();
	const items = listTerminals(activation)
		.filter((terminal) => terminal.id.startsWith(wanted))
		.map((terminal) => ({ value: terminal.id, label: terminal.id, description: `${terminal.title}  ${stateText(terminal.state)}` }));
	return items.length === 0 ? null : items;
}

async function runTerminalsCommand(activation: HudActivation, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(tr("omp-actual-terminal: a terminal's Console needs the interactive UI", "omp-actual-terminal：终端控制台需要交互界面"), "warning");
		return;
	}
	const terminals = listTerminals(activation);
	const named = args.trim();
	let id: string;
	if (named !== "") {
		if (!terminals.some((terminal) => terminal.id === named)) {
			ctx.ui.notify(tr(`omp-actual-terminal: no terminal ${named}`, `omp-actual-terminal：没有终端 ${named}`), "warning");
			return;
		}
		id = named;
	} else {
		if (terminals.length === 0) {
			ctx.ui.notify(tr("omp-actual-terminal: no terminals to open", "omp-actual-terminal：没有可打开的终端"), "info");
			return;
		}
		const labels = new Map(terminals.map((terminal) => [terminalLabel(terminal), terminal.id]));
		const choice = await ctx.ui.select(tr("Open a terminal's Console", "打开终端的控制台"), [...labels.keys()]);
		const chosen = choice === undefined ? undefined : labels.get(choice);
		if (chosen === undefined) return;
		id = chosen;
	}
	if (!openTerminalConsole(id, ctx.ui)) {
		ctx.ui.notify(tr(`omp-actual-terminal: ${id}'s Console did not open; a Console is already showing or the terminal is gone`, `omp-actual-terminal：${id} 的控制台没有打开：已有控制台在显示，或终端已不在`), "warning");
	}
}

export function mountTerminalHud(pi: ExtensionAPI, store: () => SessionStore, kill: KillSession): void {
	const activation: HudActivation = { store, kill };
	registry.activations.add(new WeakRef(activation));
	pi.registerCommand(TERMINALS_COMMAND, {
		description: tr(
			"Open a terminal's Console: pick one, or name its job id (/terminals bg_1)",
			"打开终端的控制台：从列表中选一个，或写出它的 job id（/terminals bg_1）",
		),
		getArgumentCompletions: (prefix) => terminalCompletions(activation, prefix),
		handler: (args, ctx) => runTerminalsCommand(activation, args, ctx),
	});
}
