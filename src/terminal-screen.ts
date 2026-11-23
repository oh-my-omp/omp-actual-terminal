import xtermHeadless from "@xterm/headless";
import type { IBufferCell, IDisposable, IMarker } from "@xterm/headless";

import type { InputScreen } from "../fork-features/input-wait.ts";
import type { MonitorStart } from "../fork-features/monitor-subscription.ts";

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;

const CR = 0x0d;
const LF = 0x0a;
const NO_BYTES = new Uint8Array(0);

export const TERMINAL_HISTORY_CELLS = 240_000;

export type TerminalScreenKind = "normal" | "alternate";

export interface TerminalView {
	readonly screen: TerminalScreenKind;
	readonly cols: number;
	readonly rows: number;
	readonly cursor: { readonly row: number; readonly col: number };
}

export type TerminalObservation =
	| { readonly kind: "unchanged"; readonly view: TerminalView }
	| {
			readonly kind: "rendered";
			readonly view: TerminalView;
			readonly text: string;
			readonly historyLines: number;
			readonly historyMayBeTruncated: boolean;
	  };

export interface TerminalSnapshot {
	readonly view: TerminalView;
	readonly text: string;
}

export type TerminalColor =
	| { readonly kind: "default" }
	| { readonly kind: "palette"; readonly value: number }
	| { readonly kind: "rgb"; readonly value: number };

/** Copied values only: xterm reuses both its line and cell objects. */
export interface TerminalCell {
	readonly chars: string;
	readonly width: 0 | 1 | 2;
	readonly foreground: TerminalColor;
	readonly background: TerminalColor;
	readonly bold: boolean;
	readonly dim: boolean;
	readonly italic: boolean;
	readonly underline: boolean;
	readonly inverse: boolean;
	readonly invisible: boolean;
	readonly strikethrough: boolean;
}

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDERLINE = 8;
const INVERSE = 16;
const INVISIBLE = 32;
const STRIKETHROUGH = 64;
const PRESENT = 128;
const WIDTH_SHIFT = 8;
const PALETTE = 1 << 24;
const RGB = 2 << 24;
const COLOR_VALUE = 0xffffff;

function unpackColor(word: number): TerminalColor {
	switch (word & ~COLOR_VALUE) {
		case PALETTE: return { kind: "palette", value: word & COLOR_VALUE };
		case RGB: return { kind: "rgb", value: word & COLOR_VALUE };
		default: return { kind: "default" };
	}
}

export class TerminalGrid {
	constructor(
		readonly rows: number,
		readonly cols: number,
		private readonly words: Uint32Array,
		private readonly chars: readonly string[],
	) {}

	cell(row: number, col: number): TerminalCell | undefined {
		const index = row * this.cols + col;
		const flags = this.words[index * 3 + 2]!;
		if ((flags & PRESENT) === 0) return undefined;
		return {
			chars: this.chars[index]!,
			width: ((flags >> WIDTH_SHIFT) & 3) as 0 | 1 | 2,
			foreground: unpackColor(this.words[index * 3]!),
			background: unpackColor(this.words[index * 3 + 1]!),
			bold: (flags & BOLD) !== 0,
			dim: (flags & DIM) !== 0,
			italic: (flags & ITALIC) !== 0,
			underline: (flags & UNDERLINE) !== 0,
			inverse: (flags & INVERSE) !== 0,
			invisible: (flags & INVISIBLE) !== 0,
			strikethrough: (flags & STRIKETHROUGH) !== 0,
		};
	}
}

export interface TerminalProjection {
	readonly view: TerminalView;
	readonly retainedLines: readonly string[];
	readonly screenLines: readonly string[];
	readonly grid: TerminalGrid;
	readonly appearance: TerminalAppearance;
	readonly historyMayBeTruncated: boolean;
}

export interface StyledScreen {
	readonly view: TerminalView;
	readonly text: string;
}

export interface TerminalLineSubscription {
	cancel(): void;
	finish(): Promise<boolean>;
}

interface Row {
	readonly text: string;
	readonly wrapped: boolean;
}

interface ObservedScreen {
	readonly screen: TerminalScreenKind;
	readonly rows: readonly Row[];
	readonly cursorRow: number;
	readonly cursorCol: number;
	readonly altEpoch: number;
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i]!.text !== b[i]!.text || a[i]!.wrapped !== b[i]!.wrapped) return false;
	}
	return true;
}

function toLines(rows: readonly Row[], splitRow = 0): { lines: string[]; startedBefore: number } {
	const lines: string[] = [];
	let startedBefore = 0;
	rows.forEach((row, index) => {
		if (row.wrapped && lines.length > 0) {
			lines[lines.length - 1] += row.text;
			return;
		}
		lines.push(row.text);
		if (index < splitRow) startedBefore++;
	});
	const trimmed = lines.map((line) => line.trimEnd());
	while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
	return { lines: trimmed, startedBefore: Math.min(startedBefore, trimmed.length) };
}

function paletteColor(color: number, base: number, brightBase: number, extended: number): string {
	if (color < 8) return String(base + color);
	if (color < 16) return String(brightBase + color - 8);
	return `${extended};5;${color}`;
}

function rgbColor(color: number, extended: number): string {
	return `${extended};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
}

function cellSgr(cell: IBufferCell): string {
	if (cell.isAttributeDefault()) return "";
	const params: string[] = [];
	if (cell.isBold()) params.push("1");
	if (cell.isDim()) params.push("2");
	if (cell.isItalic()) params.push("3");
	if (cell.isUnderline()) params.push("4");
	if (cell.isBlink()) params.push("5");
	if (cell.isInverse()) params.push("7");
	if (cell.isInvisible()) params.push("8");
	if (cell.isStrikethrough()) params.push("9");
	if (cell.isOverline()) params.push("53");
	if (cell.isFgPalette()) params.push(paletteColor(cell.getFgColor(), 30, 90, 38));
	else if (cell.isFgRGB()) params.push(rgbColor(cell.getFgColor(), 38));
	if (cell.isBgPalette()) params.push(paletteColor(cell.getBgColor(), 40, 100, 48));
	else if (cell.isBgRGB()) params.push(rgbColor(cell.getBgColor(), 48));
	return params.join(";");
}

export type TerminalAppearance = "dark" | "light";

const DEFAULT_COLORS: Readonly<Record<TerminalAppearance, { readonly fg: string; readonly bg: string }>> = {
	dark: { fg: "rgb:ffff/ffff/ffff", bg: "rgb:0000/0000/0000" },
	light: { fg: "rgb:0000/0000/0000", bg: "rgb:ffff/ffff/ffff" },
};

interface MarkedRow {
	readonly row: Row;
	readonly marker: IMarker;
}

interface NormalCursor {
	readonly rows: readonly MarkedRow[];
	readonly frontier: IMarker | undefined;
}

interface LineSource {
	readonly term: Terminal;
	readonly rows: number;
	readonly carriageReturnListeners: Set<() => void>;
	altEpoch(): number;
	readRows(kind: TerminalScreenKind, start: number, end: number): Row[];
	onChange(listener: () => void): () => void;
	serialized<T>(work: () => Promise<T>): Promise<T>;
	parsed(): Promise<void>;
}

const CURSOR_MOVE_FINALS = ["A", "B", "D", "E", "F", "G", "H", "d", "f"];

function changedLines(rows: readonly Row[], changed: readonly boolean[]): string[] {
	const lines: string[] = [];
	for (let start = 0; start < rows.length;) {
		let end = start + 1;
		while (end < rows.length && rows[end]!.wrapped) end++;
		let dirty = false;
		for (let index = start; index < end; index++) dirty ||= changed[index]!;
		if (dirty) {
			const parts: string[] = [];
			for (let index = start; index < end; index++) parts.push(rows[index]!.text);
			lines.push(parts.join("").trimEnd());
		}
		start = end;
	}
	return lines;
}

class LineSubscription implements TerminalLineSubscription {
	private readonly source: LineSource;
	private readonly onLines: (lines: readonly string[]) => void;
	private active = true;
	private normal: NormalCursor | undefined;
	private previousAlt: Row[];
	private previousEpoch: number;
	private quiet: NodeJS.Timeout | undefined;
	private maximum: NodeJS.Timeout | undefined;
	private changedAt = 0;
	private readonly reset: IDisposable;
	private readonly bufferSwitch: IDisposable;
	private readonly unsubscribe: () => void;
	private readonly cursorMoves: IDisposable[];

	constructor(source: LineSource, onLines: (lines: readonly string[]) => void) {
		this.source = source;
		this.onLines = onLines;
		const term = source.term;
		this.normal = term.buffer.active.type === "normal" ? this.baseline() : undefined;
		this.previousAlt = source.readRows("alternate", 0, source.rows);
		this.previousEpoch = source.altEpoch();
		// RIS replaces xterm's underlying normal buffer, while its public
		// BufferApiView object stays identical. Invalidate this cursor at
		// that authoritative parser boundary, not by guessing from row text.
		this.reset = term.parser.registerEscHandler({ final: "c" }, () => {
			this.disposeNormal();
			this.normal = undefined;
			this.previousAlt = [];
			return false;
		});
		// Normal markers cannot be created while alternate is active.
		this.bufferSwitch = term.buffer.onBufferChange((buffer) => {
			if (buffer.type === "normal" && this.normal === undefined) this.normal = this.baseline();
		});
		this.unsubscribe = source.onChange(() => {
			this.changedAt = performance.now();
			this.quiet ??= setTimeout(this.settle, 50);
			this.maximum ??= setTimeout(this.evaluate, 250);
		});
		source.carriageReturnListeners.add(this.sampleCursorRow);
		this.cursorMoves = CURSOR_MOVE_FINALS.map((final) =>
			term.parser.registerCsiHandler({ final }, () => { this.sampleCursorRow(); return false; }));
	}

	cancel(): void {
		this.active = false;
		this.clearTimers();
		this.unsubscribe();
		this.stopSampling();
		this.bufferSwitch.dispose();
		this.reset.dispose();
		this.disposeNormal();
	}

	async finish(): Promise<boolean> {
		this.clearTimers();
		this.unsubscribe();
		await this.drain();
		this.stopSampling();
		this.bufferSwitch.dispose();
		if (!this.active) return false;
		this.active = false;
		this.reset.dispose();
		this.disposeNormal();
		return true;
	}

	private logicalStart(): number {
		const buffer = this.source.term.buffer.normal;
		let start = buffer.baseY;
		while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
		return start;
	}

	private markerAt(line: number): IMarker {
		const term = this.source.term;
		const buffer = term.buffer.normal;
		const marker = term.registerMarker(line - buffer.baseY - buffer.cursorY);
		if (!marker) throw new Error("normal terminal monitor marker unavailable");
		return marker;
	}

	private capture(start: number, rows: readonly Row[], prior: ReadonlyMap<number, MarkedRow>, old?: NormalCursor): NormalCursor {
		const frontierLine = start - 1;
		const frontier = old?.frontier && !old.frontier.isDisposed && old.frontier.line === frontierLine
			? old.frontier : frontierLine >= 0 ? this.markerAt(frontierLine) : undefined;
		if (old?.frontier !== frontier) old?.frontier?.dispose();
		const marked = rows.map((row, index): MarkedRow => {
			const previous = prior.get(start + index);
			return { row, marker: previous?.marker ?? this.markerAt(start + index) };
		});
		for (const [line, previous] of prior) {
			if (line < start || line >= start + rows.length) previous.marker.dispose();
		}
		return { rows: marked, frontier };
	}

	private baseline(): NormalCursor {
		const start = this.logicalStart();
		return this.capture(start, this.source.readRows("normal", start, this.source.term.buffer.normal.baseY + this.source.rows), new Map());
	}

	private disposeNormal(): void {
		this.normal?.frontier?.dispose();
		for (const row of this.normal?.rows ?? []) row.marker.dispose();
	}

	private clearTimers(): void {
		clearTimeout(this.quiet);
		clearTimeout(this.maximum);
		this.quiet = this.maximum = undefined;
	}

	private drain(): Promise<void> {
		return this.source.serialized(async () => {
			if (!this.active) return;
			await this.source.parsed();
			if (!this.active) return;
			const changed = this.source.term.buffer.active.type === "alternate" ? this.drainAlternate() : this.drainNormal();
			if (changed.length) this.onLines(changed);
		});
	}

	private drainAlternate(): string[] {
		const previousAlt = this.previousAlt;
		const altEpoch = this.source.altEpoch();
		const rows = this.source.readRows("alternate", 0, this.source.rows);
		const changed = changedLines(rows, rows.map((row, index) =>
			row.text.trimEnd() !== (previousAlt[index]?.text.trimEnd() ?? "") || row.wrapped !== (previousAlt[index]?.wrapped ?? false) ||
			(this.previousEpoch !== altEpoch && row.text.trimEnd() !== "")));
		this.previousAlt = rows;
		this.previousEpoch = altEpoch;
		return changed;
	}

	private drainNormal(): string[] {
		const buffer = this.source.term.buffer.active;
		const normal = this.normal;
		const prior = new Map<number, MarkedRow>();
		for (const row of normal?.rows ?? []) if (!row.marker.isDisposed) prior.set(row.marker.line, row);
		const frontier = normal?.frontier;
		const start = frontier && !frontier.isDisposed ? frontier.line + 1 : 0;
		const rows = this.source.readRows("normal", start, buffer.baseY + this.source.rows);
		const oldScreenStart = (normal?.rows.length ?? 0) - this.source.rows;
		const differences = rows.map((row, index) => {
			const line = start + index;
			const positional = normal?.rows[oldScreenStart + line - buffer.baseY];
			const previous = prior.get(line)?.row ??
				(line >= buffer.baseY && positional?.marker.isDisposed && ((frontier && !frontier.isDisposed) || buffer.baseY === 0)
					? positional.row : undefined);
			if (previous) return row.text !== previous.text || row.wrapped !== previous.wrapped;
			return row.text.trimEnd() !== "" || line <= buffer.baseY + buffer.cursorY;
		});
		const changed = changedLines(rows, differences);
		const nextStart = this.logicalStart();
		this.normal = this.capture(nextStart, rows.slice(nextStart - start), prior, normal);
		return changed;
	}

	private readonly evaluate = (): void => {
		this.clearTimers();
		void this.drain();
	};

	private readonly settle = (): void => {
		const silent = performance.now() - this.changedAt;
		if (silent < 50) this.quiet = setTimeout(this.settle, 50 - silent);
		else this.evaluate();
	};

	private readonly sampleCursorRow = (): void => {
		if (!this.active) return;
		const buffer = this.source.term.buffer.active;
		if (buffer.type !== "alternate") return;
		if (this.previousEpoch !== this.source.altEpoch()) {
			this.previousAlt = [];
			this.previousEpoch = this.source.altEpoch();
		}
		let start = buffer.cursorY;
		while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
		let end = buffer.cursorY + 1;
		while (end < this.source.rows && buffer.getLine(end)?.isWrapped) end++;
		const rows = this.source.readRows("alternate", start, end);
		const previousAlt = this.previousAlt;
		const changed = rows.some((row, index) =>
			row.text.trimEnd() !== (previousAlt[start + index]?.text.trimEnd() ?? "") ||
			row.wrapped !== (previousAlt[start + index]?.wrapped ?? false));
		if (!changed) return;
		rows.forEach((row, index) => { previousAlt[start + index] = row; });
		this.onLines([rows.map((row) => row.text).join("").trimEnd()]);
	};

	private stopSampling(): void {
		this.source.carriageReturnListeners.delete(this.sampleCursorRow);
		for (const move of this.cursorMoves) move.dispose();
	}
}

function isBlankCell(cell: IBufferCell): boolean {
	const chars = cell.getChars();
	return (chars === "" || chars === " ") && cell.isBgDefault() && !cell.isInverse();
}

export class TerminalScreen {
	readonly cols: number;
	readonly rows: number;
	private readonly scrollback: number;
	private readonly term: Terminal;
	private pendingWrites = 0;
	private flushWaiters: Array<() => void> = [];
	private observeChain: Promise<unknown> = Promise.resolve();
	private altEpoch = 0;
	private lastNormal: ObservedScreen | undefined;
	private lastAlt: ObservedScreen | undefined;
	private lastScreen: TerminalScreenKind | undefined;
	private observedTop: IMarker | undefined;
	private disposed = false;
	private readonly changeListeners = new Set<() => void>();
	private readonly carriageReturnListeners = new Set<() => void>();
	private pendingCarriageReturn = false;
	private readonly appearance: () => TerminalAppearance;
	private revision = 0;
	private presentedRevision = 0;
	private readonly lineSource: LineSource;

	constructor(
		cols: number,
		rows: number,
		reply: (bytes: Uint8Array) => void,
		appearance: () => TerminalAppearance = () => "dark",
	) {
		this.cols = cols;
		this.rows = rows;
		this.appearance = appearance;
		this.scrollback = Math.max(rows, Math.floor(TERMINAL_HISTORY_CELLS / cols));
		this.term = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true });
		const encoder = new TextEncoder();
		this.term.onData((data) => reply(encoder.encode(data)));
		for (const [osc, slot] of [[10, "fg"], [11, "bg"]] as const) {
			this.term.parser.registerOscHandler(osc, (data) => {
				if (data !== "?") return false;
				reply(encoder.encode(`\x1b]${osc};${DEFAULT_COLORS[appearance()][slot]}\x07`));
				return true;
			});
		}
		this.term.buffer.onBufferChange((buffer) => {
			if (buffer.type === "alternate") this.altEpoch++;
		});
		this.lineSource = {
			term: this.term,
			rows,
			carriageReturnListeners: this.carriageReturnListeners,
			altEpoch: () => this.altEpoch,
			readRows: (kind, start, end) => this.readRows(kind, start, end),
			onChange: (listener) => this.onChange(listener),
			serialized: (work) => this.serialized(work),
			parsed: () => this.parsed(),
		};
	}

	write(chunk: Uint8Array): void {
		if (this.disposed) return;
		if (chunk.length === 0) return;
		const pending = this.pendingCarriageReturn;
		this.pendingCarriageReturn = chunk[chunk.length - 1] === CR;
		if (this.carriageReturnListeners.size === 0) {
			this.enqueue(chunk, this.notifyChange);
			return;
		}
		if (pending && chunk[0] !== LF && chunk[0] !== CR) this.enqueue(NO_BYTES, this.notifyCarriageReturn);
		let start = 0;
		for (let index = 0; index + 1 < chunk.length; index++) {
			if (chunk[index] !== CR || chunk[index + 1] === LF || chunk[index + 1] === CR) continue;
			this.enqueue(chunk.subarray(start, index + 1), this.notifyCarriageReturn);
			start = index + 1;
		}
		this.enqueue(chunk.subarray(start), this.notifyChange);
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private readonly notifyChange = (): void => {
		this.revision++;
		for (const listener of this.changeListeners) listener();
	};

	private readonly notifyCarriageReturn = (): void => {
		for (const listener of this.carriageReturnListeners) listener();
	};

	parsedRevision(): number {
		return this.revision;
	}

	private enqueue(data: Uint8Array | string, parsed?: () => void): void {
		this.pendingWrites++;
		this.term.write(data, () => {
			this.pendingWrites--;
			if (this.pendingWrites === 0) {
				const waiters = this.flushWaiters;
				this.flushWaiters = [];
				for (const resolve of waiters) resolve();
			}
			parsed?.();
		});
	}

	private serialized<T>(work: () => Promise<T>): Promise<T> {
		const run = this.observeChain.then(work);
		this.observeChain = run.catch(() => undefined);
		return run;
	}

	private parsed(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.term.write("", resolve);
		return promise;
	}

	private flushed(): Promise<void> {
		if (this.pendingWrites === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.flushWaiters.push(resolve);
		return promise;
	}

	private view(): TerminalView {
		const buffer = this.term.buffer.active;
		return {
			screen: buffer.type,
			cols: this.cols,
			rows: this.rows,
			cursor: { row: buffer.cursorY + 1, col: Math.min(buffer.cursorX, this.cols - 1) + 1 },
		};
	}

	private readRows(kind: TerminalScreenKind, start: number, end: number): Row[] {
		const buffer = kind === "normal" ? this.term.buffer.normal : this.term.buffer.alternate;
		const rows: Row[] = [];
		for (let y = start; y < end; y++) {
			const line = buffer.getLine(y);
			rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
		}
		return rows;
	}

	snapshot(): TerminalSnapshot {
		const buffer = this.term.buffer.active;
		const rows = this.readRows(buffer.type, buffer.baseY, buffer.baseY + this.rows);
		return { view: this.view(), text: toLines(rows).lines.join("\n") };
	}

	inputProbe(): (InputScreen & { readonly revision: number; readonly presented: boolean }) | undefined {
		if (this.disposed || this.pendingWrites > 0) return undefined;
		const buffer = this.term.buffer.active;
		return {
			kind: buffer.type,
			rows: this.readRows(buffer.type, buffer.baseY, buffer.baseY + this.rows),
			cursorRow: buffer.cursorY,
			cursorCol: Math.min(buffer.cursorX, this.cols),
			revision: this.revision,
			presented: this.presentedRevision === this.revision,
		};
	}

	unseen(revision: number): boolean {
		return !this.disposed && revision === this.revision && this.presentedRevision !== revision;
	}

	project(): Promise<TerminalProjection> {
		return this.serialized(async () => {
			if (this.disposed) throw new Error("terminal screen read after release");
			await this.parsed();
			const normal = this.term.buffer.normal;
			const active = this.term.buffer.active;
			const physicalLines = (kind: TerminalScreenKind, start: number, end: number): readonly string[] => {
				const lines = this.readRows(kind, start, end).map((row) => row.text.trimEnd());
				while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
				return Object.freeze(lines);
			};
			const cell = active.getNullCell();
			const words = new Uint32Array(this.rows * this.cols * 3);
			const chars: string[] = new Array(this.rows * this.cols).fill("");
			for (let y = 0; y < this.rows; y++) {
				const line = active.getLine(active.baseY + y);
				for (let x = 0; x < this.cols; x++) {
					if (!line?.getCell(x, cell)) continue;
					const width = cell.getWidth();
					if (width !== 0 && width !== 1 && width !== 2) throw new Error(`unexpected terminal cell width: ${width}`);
					const index = y * this.cols + x;
					chars[index] = cell.getChars();
					words[index * 3] = cell.isFgPalette() ? PALETTE | cell.getFgColor() : cell.isFgRGB() ? RGB | cell.getFgColor() : 0;
					words[index * 3 + 1] = cell.isBgPalette() ? PALETTE | cell.getBgColor() : cell.isBgRGB() ? RGB | cell.getBgColor() : 0;
					words[index * 3 + 2] = PRESENT | (width << WIDTH_SHIFT) |
						(cell.isBold() ? BOLD : 0) | (cell.isDim() ? DIM : 0) | (cell.isItalic() ? ITALIC : 0) |
						(cell.isUnderline() ? UNDERLINE : 0) | (cell.isInverse() ? INVERSE : 0) |
						(cell.isInvisible() ? INVISIBLE : 0) | (cell.isStrikethrough() ? STRIKETHROUGH : 0);
				}
			}
			const view = this.view();
			return Object.freeze({
				view: Object.freeze({ ...view, cursor: Object.freeze(view.cursor) }),
				retainedLines: physicalLines("normal", 0, normal.baseY + this.rows),
				screenLines: physicalLines(active.type, active.baseY, active.baseY + this.rows),
				grid: new TerminalGrid(this.rows, this.cols, words, chars),
				appearance: this.appearance(),
				historyMayBeTruncated: normal.baseY >= this.scrollback,
			});
		});
	}
	/**
	 * Must not be called after release.
	 */
	styledScreen(): StyledScreen {
		const buffer = this.term.buffer.active;
		const cell = buffer.getNullCell();
		const lines: string[] = [];
		for (let y = 0; y < buffer.baseY + this.rows; y++) {
			const line = buffer.getLine(y);
			if (!line) {
				lines.push("");
				continue;
			}
			let end = 0;
			for (let x = 0; x < this.cols; x++) {
				if (line.getCell(x, cell) && !isBlankCell(cell)) end = x + 1;
			}
			let out = "";
			let current = "";
			for (let x = 0; x < end; x++) {
				if (!line.getCell(x, cell) || cell.getWidth() === 0) continue;
				const sgr = cellSgr(cell);
				if (sgr !== current) {
					out += sgr === "" ? "\x1b[0m" : `\x1b[0;${sgr}m`;
					current = sgr;
				}
				out += cell.getChars() || " ";
			}
			lines.push(current === "" ? out : `${out}\x1b[0m`);
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return { view: this.view(), text: lines.join("\n") };
	}

	subscribeLines(
		isRunning: () => boolean,
		onLines: (lines: readonly string[]) => void,
		accept: (handle: TerminalLineSubscription) => boolean,
		signal?: AbortSignal,
	): Promise<MonitorStart> {
		return this.serialized(async (): Promise<MonitorStart> => {
			await this.parsed();
			if (signal?.aborted || this.disposed) return "cancelled";
			if (!isRunning()) return "not_running";
			const handle = new LineSubscription(this.lineSource, onLines);
			try {
				if (!accept(handle)) { handle.cancel(); return "cancelled"; }
			} catch (error) {
				handle.cancel();
				throw error;
			}
			return "accepted";
		});
	}

	observe(): Promise<TerminalObservation> {
		return this.serialized(() => this.observeNow());
	}

	private async observeNow(): Promise<TerminalObservation> {
		if (this.disposed) throw new Error("terminal screen observed after release");
		await this.parsed();
		this.presentedRevision = this.revision;
		const view = this.view();
		const buffer = this.term.buffer.active;

		if (buffer.type === "alternate") {
			const rows = this.readRows("alternate", 0, this.rows);
			const current: ObservedScreen = {
				screen: "alternate",
				rows,
				cursorRow: view.cursor.row,
				cursorCol: view.cursor.col,
				altEpoch: this.altEpoch,
			};
			const previous = this.lastScreen === "alternate" ? this.lastAlt : undefined;
			this.lastAlt = current;
			this.lastScreen = "alternate";
			if (
				previous &&
				previous.altEpoch === current.altEpoch &&
				previous.cursorRow === current.cursorRow &&
				previous.cursorCol === current.cursorCol &&
				sameRows(previous.rows, rows)
			) {
				return { kind: "unchanged", view };
			}
			return {
				kind: "rendered",
				view,
				text: toLines(rows).lines.join("\n"),
				historyLines: 0,
				historyMayBeTruncated: false,
			};
		}

		const baseY = buffer.baseY;
		const top = this.observedTop;
		const start = top && !top.isDisposed ? Math.min(top.line, baseY) : 0;
		const history = this.readRows("normal", start, baseY);
		const screen = this.readRows("normal", baseY, baseY + this.rows);
		const previous = this.lastNormal;
		const returningFromAlt = this.lastScreen === "alternate";
		this.lastNormal = { screen: "normal", rows: screen, cursorRow: view.cursor.row, cursorCol: view.cursor.col, altEpoch: 0 };
		this.lastScreen = "normal";

		// Never start inside a wrapped logical line.
		const priorRows = previous?.rows ?? [];
		let skip = 0;
		while (
			skip < history.length &&
			skip < priorRows.length &&
			history[skip]!.text === priorRows[skip]!.text &&
			history[skip]!.wrapped === priorRows[skip]!.wrapped
		) {
			skip++;
		}
		while (skip > 0 && (skip < history.length ? history[skip]! : screen[0])?.wrapped) skip--;
		const newHistory = history.slice(skip);
		const historyMayBeTruncated = (top === undefined || top.isDisposed) && baseY >= this.scrollback;

		top?.dispose();
		this.observedTop = this.term.registerMarker(-buffer.cursorY);

		if (
			previous &&
			!returningFromAlt &&
			newHistory.length === 0 &&
			previous.cursorRow === view.cursor.row &&
			previous.cursorCol === view.cursor.col &&
			sameRows(previous.rows, screen)
		) {
			return { kind: "unchanged", view };
		}
		const { lines, startedBefore } = toLines([...newHistory, ...screen], newHistory.length);
		return {
			kind: "rendered",
			view,
			text: lines.join("\n"),
			historyLines: startedBefore,
			historyMayBeTruncated,
		};
	}

	release(): Promise<void> {
		this.changeListeners.clear();
		return this.serialized(async () => {
			if (this.disposed) return;
			await this.flushed();
			this.disposed = true;
			this.term.dispose();
		});
	}
}
