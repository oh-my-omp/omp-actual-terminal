import type { TruncationResult } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { formatBytes } from "@oh-my-pi/pi-utils";

import { sanitizeOutputText } from "./output-safety.ts";

const FALLBACK_MAX_BYTES = 50 * 1024;

export function safeMeta(value: string, max = 4096): string {
	const scanLimit = max * 8;
	let end = Math.min(value.length, scanLimit);
	if (end < value.length && end > 0 && /[\ud800-\udbff]/.test(value[end - 1]!)) end--;
	const clipped = end < value.length;
	const clean = sanitizeOutputText(value.slice(0, end)).replace(/\s+/g, " ").trim();
	if (!clipped && clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function truncationMarker(
	t: TruncationResult | undefined,
	logPath: string | undefined,
	maxBytes = FALLBACK_MAX_BYTES,
): string | null {
	if (!t?.truncated) return null;
	const full = logPath ? `. Full output: ${safeMeta(logPath)}` : "";
	if (t.lastLinePartial) {
		return `[Showing last ${formatBytes(t.outputBytes ?? Buffer.byteLength(t.content, "utf-8"))} of final line (line ${t.totalLines} is larger than the ${formatBytes(maxBytes)} limit)${full}]`;
	}
	const startLine = t.totalLines - (t.outputLines ?? t.content.split("\n").length) + 1;
	const endLine = t.totalLines;
	if (t.truncatedBy === "lines") {
		return `[Showing lines ${startLine}-${endLine} of ${t.totalLines}${full}]`;
	}
	return `[Showing lines ${startLine}-${endLine} of ${t.totalLines} (${formatBytes(maxBytes)} limit)${full}]`;
}
