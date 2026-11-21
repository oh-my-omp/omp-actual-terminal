import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type * as NativeState from "@oh-my-pi/pi-tui/native/state";
import { matchesKey, type Component, type NativeNode } from "@oh-my-pi/pi-tui";

import { formatElapsedUi } from "./format-time.ts";
import { sanitizeOutputText } from "./output-safety.ts";
import { tr } from "./omomp-shared/i18n.ts";
import type { ExecSession } from "./session.ts";
import type { SessionStore } from "./session-store.ts";
import type { StyledScreen } from "./terminal-screen.ts";

function requalify(change: string): Error {
	return new Error(`omp-actual-terminal: ${change}; requalify src/tern-terminal-hud.ts for this omp version`);
}

export type NativeRenderingState = Pick<typeof NativeState, "isNativeRendering" | "onNativeRenderingChange">;

function parseNativeRenderingState(value: Partial<NativeRenderingState>): NativeRenderingState {
	const { isNativeRendering, onNativeRenderingChange } = value;
	if (typeof isNativeRendering !== "function" || typeof onNativeRenderingChange !== "function") {
		throw requalify("@oh-my-pi/pi-tui/native/state no longer provides isNativeRendering/onNativeRenderingChange");
	}
	return { isNativeRendering, onNativeRenderingChange };
}

export type HudPillsPrototype = Pick<InteractiveMode, "describeHudPills">;

function isHudPillsPrototype(value: unknown): value is HudPillsPrototype {
	return typeof value === "object" && value !== null && "describeHudPills" in value && typeof value.describeHudPills === "function";
}

export function parseInteractiveModeModule(value: { readonly InteractiveMode?: unknown }): HudPillsPrototype {
	const mode = value.InteractiveMode;
	const prototype: unknown = typeof mode === "function" ? mode.prototype : undefined;
	if (!isHudPillsPrototype(prototype)) {
		throw requalify("@oh-my-pi/pi-coding-agent/modes/interactive-mode no longer provides InteractiveMode.prototype.describeHudPills");
	}
	return prototype;
}

export interface TernHudHost {
	readonly native: NativeRenderingState;
	readonly pills: HudPillsPrototype;
}

export const OPEN_ACTION = "omp-actual-terminal.terminals.open";
export const OPEN_TERMINAL_ACTION = "omp-actual-terminal.terminal.open";
export const KILL_ACTION = "kill";
export const CLOSE_ACTION = "close";
export const BACK_ACTION = "back";
export const VIEW_FRAME = { role: "omp.overlay.jobs", size: "lg", anchor: "center", head: "Terminals" } as const;

function viewFrame(): Readonly<Record<string, unknown>> {
	return { ...VIEW_FRAME, head: tr("Terminals", "终端") };
}
const COMMAND_MAX = 120;
const SGR = /\x1b\[[0-9;:]*m/g;

export type TerminalState =
	| { readonly kind: "running" }
	| {
			readonly kind: "exited";
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly failure: string | null;
			readonly exitedAt: number;
	  };

export interface TerminalSummary {
	readonly id: number;
	readonly title: string;
	readonly command: string;
	readonly script: string;
	readonly state: TerminalState;
	readonly cwd: string;
	readonly pid: number | undefined;
	readonly startedAt: number;
	readonly logPath: string;
}

export interface TerminalEntry extends TerminalSummary {
	readonly screen: StyledScreen;
}

function oneLine(command: string): string {
	const line = sanitizeOutputText(command).replace(/\s+/g, " ").trim();
	return line.length <= COMMAND_MAX ? line : `${line.slice(0, COMMAND_MAX - 1)}…`;
}

function terminalSummary(session: ExecSession): TerminalSummary {
	const exitedAt = session.exitedAt;
	const state: TerminalState = exitedAt === null
		? { kind: "running" }
		: { kind: "exited", exitCode: session.exitCode, signal: session.signal, failure: session.failureMessage, exitedAt };
	return {
		id: session.id,
		title: oneLine(session.title),
		command: oneLine(session.displayCommand),
		script: sanitizeOutputText(session.displayCommand),
		state,
		cwd: sanitizeOutputText(session.cwd),
		pid: session.pid,
		startedAt: session.startedAt,
		logPath: sanitizeOutputText(session.logPath),
	};
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

interface StateLook {
	readonly label: string;
	readonly tone: "pending" | "success" | "error";
	readonly glyph: { readonly t: string; readonly fx?: "pulse" };
}

function stateLook(state: TerminalState): StateLook {
	if (state.kind === "running") return { label: tr("Running", "运行中"), tone: "pending", glyph: { t: "●", fx: "pulse" } };
	if (exitSucceeded(state)) return { label: tr("Exit 0", "退出 0"), tone: "success", glyph: { t: "✓" } };
	const label = state.failure !== null
		? tr("Failed", "失败")
		: state.signal ?? (state.exitCode === null ? tr("Exited", "已退出") : tr(`Exit ${state.exitCode}`, `退出 ${state.exitCode}`));
	return { label, tone: "error", glyph: { t: "✕" } };
}

function elapsedMs(entry: TerminalSummary, now: number): number {
	const end = entry.state.kind === "running" ? now : entry.state.exitedAt;
	return Math.max(0, Math.round(end - entry.startedAt));
}

function itemId(id: number): string {
	return `s${id}`;
}

function parseItemId(item: unknown): number | undefined {
	if (typeof item !== "string" || !/^s\d+$/.test(item)) return undefined;
	const id = Number(item.slice(1));
	return Number.isSafeInteger(id) ? id : undefined;
}

export function describeTerminalSegment(count: number, running: number): NativeNode {
	const label = tr(
		`${count} terminal${count === 1 ? "" : "s"} · ${running} running`,
		`${count} 个终端 · ${running} 个运行中`,
	);
	return {
		k: "row",
		key: "terminals",
		p: { role: "omp.hud.seg", gap: "xs", align: "center", title: label, aria: label, actions: { click: OPEN_ACTION } },
		c: [
			{ k: "icon", key: "icon", p: { name: "terminal", tone: "success" } },
			{ k: "text", key: "count", p: { spans: [{ t: String(count), s: "num" }], wrap: "none" } },
		],
	};
}

type NodeProps<K extends NativeNode["k"]> = NonNullable<Extract<NativeNode, { readonly k: K }>["p"]>;
type RowNode = Extract<NativeNode, { readonly k: "row" }>;
type Tone = NonNullable<NodeProps<"row">["tone"]>;
type KvItem = NodeProps<"kv">["items"][number];

function isRow(value: unknown, role: string): value is RowNode {
	return typeof value === "object" && value !== null && "k" in value && value.k === "row"
		&& "p" in value && typeof value.p === "object" && value.p !== null && "role" in value.p && value.p.role === role;
}

const EMPTY_PILL: RowNode = { k: "row", key: "running", p: { role: "omp.hud.pill", align: "center" }, c: [] };

export function parseHudPillsNode(value: unknown): RowNode {
	if (!isRow(value, "omp.hud") || (value.c?.length ?? 0) > 1) {
		throw requalify("InteractiveMode.describeHudPills no longer returns an omp.hud row with one omp.hud.pill");
	}
	const pill = value.c?.[0];
	if (pill !== undefined && !isRow(pill, "omp.hud.pill")) {
		throw requalify("InteractiveMode.describeHudPills no longer returns an omp.hud row with one omp.hud.pill");
	}
	return value;
}

export function withTerminalSegment(hud: RowNode, segment: Component): RowNode {
	const existing = hud.c?.[0];
	const pill = isRow(existing, "omp.hud.pill") ? existing : EMPTY_PILL;
	return { ...hud, p: { ...hud.p, hidden: undefined }, c: [{ ...pill, c: [...(pill.c ?? []), segment] }] };
}

function actionButton(label: string, act: string, keys?: string, tone?: Tone): NativeNode {
	return {
		k: "row",
		key: act,
		p: { role: "omp.btn", gap: "xs", align: "center", title: keys ? `${label}  ${keys}` : label, actions: { click: act }, ...(tone ? { tone } : {}) },
		c: [{ k: "text", p: { text: label } }, ...(keys ? [{ k: "kbd", p: { keys: [keys] } } satisfies NativeNode] : [])],
	};
}

/**
 * omp's own `shortenPath`
 * lives in `@oh-my-pi/pi-tui/render`, which ships TypeScript source; importing it would
 * stop this module from loading on a Node host before the factory can reject that host.
 */
function shortenHome(path: string): string {
	const below = relative(homedir(), path);
	if (below === "") return "~";
	return below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below) ? path : `~${sep}${below}`;
}

function localDateTime(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function actionsRow(children: readonly NativeNode[]): NativeNode {
	return { k: "row", key: "actions", p: { role: "omp.actions", gap: "sm", align: "center" }, c: children };
}

const SPACER: NativeNode = { k: "spacer", p: { grow: 1 } };

function describeListItem(entry: TerminalSummary, now: number): NativeNode {
	const look = stateLook(entry.state);
	const elapsed = formatElapsedUi(elapsedMs(entry, now));
	return {
		k: "item",
		key: itemId(entry.id),
		p: {
			label: [{ t: entry.title }],
			value: [{ t: elapsed, s: "mono" }],
			icon: "terminal",
			tone: look.tone,
			title: `${entry.title}\n${entry.command}\n${look.label} · exec · #${entry.id}`,
			aria: tr(
				`${entry.title}, ${look.label.toLowerCase()}, ${elapsed}`,
				`${entry.title}，${look.label}，${elapsed}`,
			),
		},
	};
}

function describeDetail(entry: TerminalEntry, now: number): NativeNode {
	const look = stateLook(entry.state);
	const running = entry.state.kind === "running";
	const age = elapsedMs(entry, now);
	const facts: KvItem[] = [
		{ k: tr("Directory", "目录"), v: [{ t: shortenHome(entry.cwd), s: "path" }] },
		...(entry.pid !== undefined ? [{ k: "PID", v: [{ t: String(entry.pid), s: "num" }] }] : []),
		{ k: tr("Size", "大小"), v: [{ t: `${entry.screen.view.cols} × ${entry.screen.view.rows}`, s: "num" }] },
		{ k: tr("Started", "启动时间"), v: [{ t: localDateTime(entry.startedAt), s: "dim" }] },
		{ k: tr("Log", "日志"), v: [{ t: entry.logPath, s: "path", href: `file://${entry.logPath}` }] },
	];
	const hasOutput = entry.screen.text.replace(SGR, "").trim() !== "";
	return {
		k: "col",
		key: itemId(entry.id),
		p: { role: "omp.jobs.detail" },
		c: [
			{
				k: "row",
				key: "status",
				p: { role: "omp.jobs.status", gap: "sm", align: "center" },
				c: [
					{ k: "text", key: "state", p: { spans: [look.glyph, { t: ` ${look.label}` }], role: "omp.jobs.state", tone: look.tone, wrap: "none" } },
					{ k: "elapsed", key: "age", p: { age, ...(running ? {} : { stopped: age }), format: "short", role: "omp.jobs.age", title: running ? tr("Running for", "运行时长") : tr("Ran for", "运行时长") } },
					{ k: "text", key: "id", p: { spans: [{ t: `exec · #${entry.id}`, s: "mono" }], role: "omp.jobs.id", wrap: "none", truncate: "end" } },
					SPACER,
					...(running ? [actionButton(tr("Kill", "结束"), KILL_ACTION, "x", "error")] : []),
					actionButton(tr("Open", "打开"), OPEN_TERMINAL_ACTION, "enter"),
				],
			},
			{ k: "code", key: "command", p: { text: entry.script, lang: "bash", wrap: true, preview: { lines: 4 }, role: "omp.jobs.command" } },
			{ k: "kv", key: "facts", p: { items: facts, role: "omp.jobs.facts" } },
			{
				k: "col",
				key: "out",
				p: { role: "omp.jobs.out", gap: "sm" },
				c: [
					{ k: "text", key: "label", p: { text: tr("Output", "输出"), role: "omp.jobs.label" } },
					hasOutput
						? { k: "ansi", key: `output-${itemId(entry.id)}`, p: { text: entry.screen.text, follow: running, role: "omp.jobs.output", max: { h: "16lines" } } }
						: { k: "text", key: "none", p: { text: running ? tr("No output yet", "暂无输出") : tr("No output", "无输出"), role: "omp.jobs.nooutput" } },
				],
			},
		],
	};
}

export function describeTerminalsSheet(
	entries: readonly TerminalSummary[],
	selected: TerminalEntry | undefined,
	now = Date.now(),
): NativeNode {
	const close = actionButton(tr("Close", "关闭"), CLOSE_ACTION, "esc");
	if (!selected) {
		return {
			k: "col",
			c: [
				{
					k: "col",
					key: "empty",
					p: { role: "omp.jobs.empty", align: "center" },
					c: [
						{ k: "icon", key: "icon", p: { name: "terminal" } },
						{ k: "text", key: "title", p: { text: tr("No terminals", "没有终端"), role: "omp.jobs.empty.title" } },
						{ k: "text", key: "note", p: { text: tr("Sessions started by bash with pty: true show up here while they are stored.", "bash 以 pty: true 启动的会话在存储期间会显示在这里。"), role: "omp.jobs.empty.note", wrap: "word" } },
					],
				},
				actionsRow([SPACER, close]),
			],
		};
	}
	const running = entries.filter((entry) => entry.state.kind === "running").length;
	return {
		k: "col",
		c: [
			{
				k: "row",
				key: "split",
				p: { role: "omp.jobs.split" },
				c: [
					{
						k: "col",
						key: "master",
						p: { role: "omp.jobs.master" },
						c: [{
							k: "list",
							key: "terminals",
							p: { selected: itemId(selected.id), max: { lines: 12 }, actions: { click: "select", dblclick: "activate" } },
							c: entries.map((entry) => describeListItem(entry, now)),
						}],
					},
					describeDetail(selected, now),
				],
			},
			actionsRow([
				{ k: "text", key: "summary", p: { role: "omp.jobs.summary", text: tr(`${running} running · ${entries.length} stored`, `${running} 个运行中 · ${entries.length} 个已存储`), wrap: "none" } },
				SPACER,
				close,
			]),
		],
	};
}

export function terminalPageFrame(entry: TerminalSummary | undefined, id: number): Readonly<Record<string, unknown>> {
	return {
		role: "omp.overlay.console",
		size: "full",
		head: [
			{ t: tr("Terminals · ", "终端 · "), s: "muted" },
			{ t: `#${id} ` },
			...(entry ? [{ t: entry.title }, { t: "  " }, { t: stateText(entry.state), s: stateTone(entry.state) }] : [{ t: tr("removed", "已移除"), s: "muted" }]),
		],
	};
}

export function describeTerminalPage(entry: TerminalEntry | undefined): NativeNode {
	if (!entry) {
		return {
			k: "col",
			p: { gap: "sm" },
			c: [
				{ k: "text", key: "gone", p: { spans: [{ t: tr("This terminal is no longer stored.", "此终端已不再存储。"), s: "dim" }] } },
				{ k: "row", key: "actions", p: { role: "omp.actions", gap: "sm", align: "center" }, c: [{ k: "spacer", p: { grow: 1 } }, actionButton(tr("Back", "返回"), BACK_ACTION, "esc")] },
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
				key: `page-${itemId(entry.id)}`,
				p: {
					text: entry.screen.text,
					cols: entry.screen.view.cols,
					follow: true,
					grow: 1,
					max: { h: 1 },
				},
			},
			{
				k: "row",
				key: "actions",
				p: { role: "omp.actions", gap: "sm", align: "center" },
				c: [
					{ k: "text", key: "note", p: { spans: [{ t: running ? tr("Keys go to the terminal", "按键将发送到终端") : tr("Session finished", "会话已结束"), s: "dim" }] } },
					{ k: "spacer", p: { grow: 1 } },
					...(running ? [actionButton(tr("Kill", "结束"), KILL_ACTION, undefined, "error")] : []),
					actionButton(tr("Back", "返回"), BACK_ACTION, "esc"),
				],
			},
		],
	};
}

function sortedSessions(store: SessionStore): ExecSession[] {
	return store.values().sort((a, b) => a.id - b.id);
}

function summaryOf(session: ExecSession | undefined): TerminalSummary | undefined {
	return session?.screenRevision() === undefined ? undefined : terminalSummary(session);
}

function entryOf(session: ExecSession | undefined): TerminalEntry | undefined {
	const screen = session?.styledScreen();
	return session && screen ? { ...terminalSummary(session), screen } : undefined;
}

type HudEvent =
	| { readonly kind: "action"; readonly act: string }
	| { readonly kind: "select"; readonly id: number; readonly activate: boolean };

function parseHudEvent(event: unknown): HudEvent | undefined {
	if (typeof event !== "object" || event === null || !("type" in event)) return undefined;
	if (event.type === "action" && "act" in event && typeof event.act === "string") return { kind: "action", act: event.act };
	if ((event.type === "select" || event.type === "activate") && "item" in event) {
		const id = parseItemId(event.item);
		if (id !== undefined) return { kind: "select", id, activate: event.type === "activate" };
	}
	return undefined;
}

export type KillSession = (id: number) => Promise<boolean>;

export type SheetResult = { readonly kind: "closed" } | { readonly kind: "open"; readonly id: number };

interface RenderTarget {
	requestRender(): void;
}

function renderTargetOf(mode: object): RenderTarget {
	const ui: unknown = "ui" in mode ? mode.ui : undefined;
	const request: unknown = typeof ui === "object" && ui !== null && "requestRender" in ui ? ui.requestRender : undefined;
	if (typeof request !== "function") throw requalify("InteractiveMode no longer has ui.requestRender");
	return { requestRender: () => request.call(ui) };
}

/**
 * Each mode gets its own
 * component: omp skips a component described twice in one frame.
 */
class TerminalSegment implements Component {
	constructor(private readonly provider: SegmentProvider) {}

	describe(): NativeNode {
		return this.provider.segment();
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (parsed?.kind === "action" && parsed.act === OPEN_ACTION) this.provider.open();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

class SegmentProvider {
	private node: NativeNode | undefined;
	private readonly modes = new WeakMap<object, { readonly segment: TerminalSegment; decorated?: { readonly base: NativeNode; readonly node: NativeNode } }>();
	private readonly targets = new Map<object, RenderTarget>();
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		readonly open: () => void,
	) {
		this.watch = new SessionWatch(store, this.changed);
	}

	private changed = (): void => {
		this.node = undefined;
		this.requestRender();
	};

	requestRender(): void {
		for (const target of this.targets.values()) target.requestRender();
	}

	segment(): NativeNode {
		if (!this.node) {
			let running = 0;
			for (const session of this.store.values()) if (!session.hasExited) running++;
			this.node = describeTerminalSegment(this.store.size, running);
		}
		return this.node;
	}

	decorate = (mode: object, base: NativeNode): NativeNode => {
		if (!this.targets.has(mode)) this.targets.set(mode, renderTargetOf(mode));
		if (this.store.size === 0) return base;
		let entry = this.modes.get(mode);
		if (!entry) {
			entry = { segment: new TerminalSegment(this) };
			this.modes.set(mode, entry);
		}
		const memo = entry.decorated;
		if (memo && memo.base === base) return memo.node;
		const node = withTerminalSegment(parseHudPillsNode(base), entry.segment);
		entry.decorated = { base, node };
		return node;
	};

	dispose(): void {
		this.watch.dispose();
		this.requestRender();
		this.targets.clear();
	}
}

type DecoratePills = (mode: object, base: NativeNode) => NativeNode;

interface PillsRegistry {
	decorate: DecoratePills | undefined;
	readonly wrapped: WeakSet<object>;
}

const pillsRegistrySymbol = Symbol.for("omp-actual-terminal.tern-hud-pills");
const processGlobal = globalThis as typeof globalThis & { [pillsRegistrySymbol]?: PillsRegistry };
const pillsRegistry: PillsRegistry = processGlobal[pillsRegistrySymbol] ??= { decorate: undefined, wrapped: new WeakSet() };

export function wrapHudPills(prototype: HudPillsPrototype): void {
	if (pillsRegistry.wrapped.has(prototype)) return;
	const original = prototype.describeHudPills;
	prototype.describeHudPills = function describeHudPills(this: object): NativeNode {
		const base = original.call(this);
		return pillsRegistry.decorate ? pillsRegistry.decorate(this, base) : base;
	};
	pillsRegistry.wrapped.add(prototype);
}

class SessionWatch {
	private readonly watches = new Map<number, { readonly exit: () => void; screen: (() => void) | undefined }>();
	private readonly unsubscribeStore: () => void;

	constructor(
		private readonly store: SessionStore,
		private readonly changed: () => void,
		private readonly shown?: () => number | undefined,
	) {
		this.unsubscribeStore = store.subscribe(() => {
			this.sync();
			changed();
		});
		this.sync();
	}

	sync(): void {
		const sessions = sortedSessions(this.store);
		const shownId = this.shown ? (this.shown() ?? sessions[0]?.id) : undefined;
		const live = new Set<number>();
		for (const session of sessions) {
			live.add(session.id);
			let watch = this.watches.get(session.id);
			if (!watch) {
				watch = { exit: session.onExit(this.changed), screen: undefined };
				this.watches.set(session.id, watch);
			}
			const wantScreen = session.id === shownId;
			if (wantScreen && !watch.screen) watch.screen = session.onScreenChange(this.changed);
			if (!wantScreen && watch.screen) {
				watch.screen();
				watch.screen = undefined;
			}
		}
		for (const [id, watch] of this.watches) {
			if (live.has(id)) continue;
			watch.exit();
			watch.screen?.();
			this.watches.delete(id);
		}
	}

	dispose(): void {
		this.unsubscribeStore();
		for (const watch of this.watches.values()) {
			watch.exit();
			watch.screen?.();
		}
		this.watches.clear();
	}
}

const VIEW_TICK_MS = 1000;

class TerminalsSheet implements Component {
	get nativeOverlay(): Readonly<Record<string, unknown>> {
		return viewFrame();
	}
	private described: NativeNode | undefined;
	private shown: { readonly id: number; readonly revision: number; readonly screen: StyledScreen } | undefined;
	private readonly watch: SessionWatch;
	private readonly tick: NodeJS.Timeout;

	constructor(
		private readonly store: SessionStore,
		private readonly requestRender: () => void,
		private selectedId: number | undefined,
		private readonly done: (result: SheetResult) => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, this.changed, () => this.selectedId);
		this.tick = setInterval(() => {
			if (store.values().some((session) => !session.hasExited)) this.changed();
		}, VIEW_TICK_MS);
		this.tick.unref?.();
	}

	private changed = (): void => {
		this.described = undefined;
		this.requestRender();
	};

	private selected(): ExecSession | undefined {
		const sessions = sortedSessions(this.store);
		return sessions.find((session) => session.id === this.selectedId) ?? sessions[0];
	}

	private select(id: number): void {
		if (id === this.selectedId) return;
		this.selectedId = id;
		this.watch.sync();
		this.changed();
	}

	private move(delta: number): void {
		const sessions = sortedSessions(this.store);
		if (sessions.length === 0) return;
		const index = Math.max(0, sessions.findIndex((session) => session.id === this.selectedId));
		this.select(sessions[Math.min(sessions.length - 1, Math.max(0, index + delta))]!.id);
	}

	private openSelected(): void {
		const session = this.selected();
		if (session) this.done({ kind: "open", id: session.id });
	}

	private killSelected(): void {
		const session = this.selected();
		if (!session || session.hasExited) return;
		void this.kill(session.id).then(this.changed);
	}

	describe(): NativeNode {
		if (!this.described) {
			const sessions = sortedSessions(this.store).filter((session) => session.screenRevision() !== undefined);
			const selected = sessions.find((session) => session.id === this.selectedId) ?? sessions[0];
			this.described = describeTerminalsSheet(sessions.map(terminalSummary), selected && this.entry(selected));
		}
		return this.described;
	}

	private entry(session: ExecSession): TerminalEntry | undefined {
		const revision = session.screenRevision();
		const shown = this.shown;
		const screen = shown?.id === session.id && shown.revision === revision ? shown.screen : session.styledScreen();
		if (revision === undefined || !screen) return undefined;
		this.shown = { id: session.id, revision, screen };
		return { ...terminalSummary(session), screen };
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (!parsed) return;
		if (parsed.kind === "select") {
			this.select(parsed.id);
			if (parsed.activate) this.openSelected();
			return;
		}
		if (parsed.act === CLOSE_ACTION) this.done({ kind: "closed" });
		else if (parsed.act === OPEN_TERMINAL_ACTION) this.openSelected();
		else if (parsed.act === KILL_ACTION) this.killSelected();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.done({ kind: "closed" });
		else if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "enter")) this.openSelected();
		else if (data === "x") this.killSelected();
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		clearInterval(this.tick);
		this.watch.dispose();
	}
}

const encoder = new TextEncoder();

class TerminalPage implements Component {
	private described: NativeNode | undefined;
	private readonly watch: SessionWatch;

	constructor(
		private readonly store: SessionStore,
		private readonly id: number,
		private readonly requestRender: () => void,
		private readonly back: () => void,
		private readonly kill: KillSession,
	) {
		this.watch = new SessionWatch(store, this.changed, () => id);
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

	describe(): NativeNode {
		this.described ??= describeTerminalPage(entryOf(this.session()));
		return this.described;
	}

	handleNativeEvent(event: unknown): void {
		const parsed = parseHudEvent(event);
		if (parsed?.kind !== "action") return;
		if (parsed.act === BACK_ACTION || parsed.act === CLOSE_ACTION) this.back();
		else if (parsed.act === KILL_ACTION && this.session() && !this.session()!.hasExited) void this.kill(this.id).then(this.changed);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		const session = this.session();
		if (session && !session.hasExited) session.write(encoder.encode(data));
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {
		this.described = undefined;
	}

	dispose(): void {
		this.watch.dispose();
	}
}

export async function loadTernHudHost(): Promise<TernHudHost> {
	const [state, modes] = await Promise.all([
		import("@oh-my-pi/pi-tui/native/state"),
		import("@oh-my-pi/pi-coding-agent/modes/interactive-mode"),
	]);
	return { native: parseNativeRenderingState(state), pills: parseInteractiveModeModule(modes) };
}

export function mountTerminalHud(pi: ExtensionAPI, store: () => SessionStore, host: TernHudHost, kill: KillSession): void {
	let ui: ExtensionContext["ui"] | undefined;
	let provider: SegmentProvider | undefined;
	let sheetOpen = false;

	const openSheet = async (): Promise<void> => {
		const host = ui;
		if (!host || sheetOpen) return;
		sheetOpen = true;
		try {
			let selected: number | undefined;
			while (ui === host) {
				const result = await host.custom<SheetResult>(
					(tui, _theme, _keybindings, done) =>
						new TerminalsSheet(store(), () => tui.requestRender(), selected, done, kill),
					{ overlay: true },
				);
				if (result.kind === "closed" || ui !== host) return;
				selected = result.id;
				await host.custom<void>(
					(tui, _theme, _keybindings, done) =>
						new TerminalPage(store(), result.id, () => tui.requestRender(), () => done(), kill),
					{ overlay: true },
				);
			}
		} finally {
			sheetOpen = false;
		}
	};

	const deactivate = (): void => {
		const ended = provider;
		if (!ended) return;
		provider = undefined;
		// A later activation may already own the wrapper; only withdraw this one's decorator.
		if (pillsRegistry.decorate === ended.decorate) pillsRegistry.decorate = undefined;
		ended.dispose();
	};

	const sync = (): void => {
		if (ui === undefined || !host.native.isNativeRendering()) {
			deactivate();
			return;
		}
		if (provider) return;
		provider = new SegmentProvider(store(), () => void openSheet());
		wrapHudPills(host.pills);
		pillsRegistry.decorate = provider.decorate;
	};

	// The native-rendering listener set is process-global: a listener left behind
	// keeps this activation, and through it the disposed (e.g. parked) session,
	// reachable for the life of the process. Subscribe for each session period only.
	let unsubscribeNative: (() => void) | undefined;
	pi.on("session_start", async (_event, eventCtx) => {
		deactivate();
		ui = eventCtx.hasUI ? eventCtx.ui : undefined;
		unsubscribeNative ??= host.native.onNativeRenderingChange(sync);
		sync();
	});
	pi.on("session_shutdown", async () => {
		unsubscribeNative?.();
		unsubscribeNative = undefined;
		deactivate();
		ui = undefined;
	});
}
