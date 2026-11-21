import { sanitizeOutputText } from "./output-safety.ts";
import type { InputPromptLabel, TerminalNotice } from "./terminal-notice.ts";

export type InputScreenKind = "normal" | "alternate";

export interface InputScreenRow {
	readonly text: string;
	readonly wrapped: boolean;
}

export interface InputScreen {
	readonly kind: InputScreenKind;
	readonly rows: readonly InputScreenRow[];
	readonly cursorRow: number;
	readonly cursorCol: number;
}

export type InputPromptKind = InputPromptLabel;

export interface InputPrompt {
	readonly kind: InputPromptKind;
	readonly lines: readonly string[];
}

const DIALOG_BUTTON = /<\s*(?:ok|yes|no|cancel)\s*>/i;
const INLINE_PROMPTS: readonly RegExp[] = [
	/\[(?:[\w-]{1,12}\/)+[\w-]{1,12}\]/,
	/\((?:[\w[\]-]{1,14}\/)+[\w[\]-]{1,14}\)/,
	/\[default=[^\]]*\]/i,
	/\b(?:password|passphrase|passcode|pin)\b[^:]*:$/i,
	/\b(?:press|hit)\s+(?:enter|return|any key)\b/i,
];
const PAGER_PROMPT = /^(?::|.*\(END\)|--More--.*)$/;

const MAX_LINE_CHARS = 1024;
const MAX_DIALOG_LINES = 24;
const INLINE_CONTEXT_LINES = 3;
const BOX_DRAWING = /[\u2500-\u257f]+/g;

function clean(text: string): string {
	return sanitizeOutputText(text).trimEnd().slice(0, MAX_LINE_CHARS);
}

function logicalLines(rows: readonly InputScreenRow[], end: number): string[] {
	const lines: string[] = [];
	for (let index = 0; index < end; index++) {
		const row = rows[index]!;
		if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text;
		else lines.push(row.text);
	}
	return lines.map(clean).filter((line) => line !== "");
}

export function detectInputPrompt(screen: InputScreen): InputPrompt | undefined {
	const { rows, cursorRow, cursorCol } = screen;
	if (rows.some((row) => DIALOG_BUTTON.test(row.text))) {
		const lines = logicalLines(rows, rows.length).map((line) => line.replace(BOX_DRAWING, " ").replace(/\s{3,}/g, "  ").trim()).filter((line) => line !== "");
		return { kind: "dialog", lines: lines.slice(0, MAX_DIALOG_LINES) };
	}
	const cursorLine = rows[cursorRow];
	if (!cursorLine || cursorLine.text.slice(cursorCol).trim() !== "") return undefined;
	let start = cursorRow;
	while (start > 0 && rows[start]!.wrapped) start--;
	let beforeCursor = "";
	for (let index = start; index < cursorRow; index++) beforeCursor += rows[index]!.text;
	const prompt = clean(beforeCursor + cursorLine.text.slice(0, cursorCol));
	if (prompt === "") return undefined;
	const context = logicalLines(rows, start).slice(-INLINE_CONTEXT_LINES);
	if (INLINE_PROMPTS.some((pattern) => pattern.test(prompt))) return { kind: "inline", lines: [...context, prompt] };
	if (cursorRow === rows.length - 1 && PAGER_PROMPT.test(prompt)) return { kind: "pager", lines: [...context, prompt] };
	return undefined;
}

export interface InputWaitAlert {
	readonly notice: TerminalNotice;
	current(): boolean;
}

export function inputWaitNotice(input: {
	readonly jobId: string;
	readonly title: string;
	readonly command: string;
	readonly prompt: InputPrompt;
	readonly screen: InputScreenKind;
	readonly quietMs: number;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
}): TerminalNotice {
	return {
		identity: { jobId: input.jobId, title: input.title, terminalUrl: input.terminalUrl, logPath: input.logPath },
		body: { kind: "input_wait", command: input.command, prompt: input.prompt.kind, screen: input.screen, quietMs: input.quietMs, lines: input.prompt.lines },
	};
}
