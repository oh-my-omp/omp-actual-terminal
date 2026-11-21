import { randomUUID } from "node:crypto";

import type { TerminalProjection, TerminalScreen } from "./terminal-screen.ts";

export type TerminalResource =
	| { readonly kind: "live"; readonly screen: TerminalScreen; readonly onRead?: () => void }
	| { readonly kind: "frozen"; readonly projection: TerminalProjection; readonly onRead?: () => void };

interface TerminalRegistry {
	readonly resources: Map<string, TerminalResource>;
}

const registrySymbol = Symbol.for("omp-actual-terminal.terminal-resources");
const processGlobal = globalThis as typeof globalThis & { [registrySymbol]?: TerminalRegistry };
export const terminalRegistry: TerminalRegistry = processGlobal[registrySymbol] ??= {
	resources: new Map(),
};

export class TerminalResourceError extends Error {
	constructor(readonly code: "unknown_terminal" | "invalid_terminal_target" | "terminal_page_out_of_range", message: string) {
		super(`${code}: ${message}`);
		this.name = "TerminalResourceError";
	}
}

export function registerTerminal(id: string, screen: TerminalScreen, onRead?: () => void): string {
	const key = `${id}-${randomUUID()}`;
	terminalRegistry.resources.set(key, { kind: "live", screen, onRead });
	return key;
}

export function noteTerminalRead(key: string): void {
	try { terminalRegistry.resources.get(key)?.onRead?.(); } catch { /* the owner's bookkeeping must not fail a read */ }
}

export function detachTerminalReader(key: string): void {
	const resource = terminalRegistry.resources.get(key);
	if (resource?.onRead) terminalRegistry.resources.set(key, { ...resource, onRead: undefined });
}

export function getTerminalResource(key: string): TerminalResource {
	const resource = terminalRegistry.resources.get(key);
	if (!resource) throw new TerminalResourceError("unknown_terminal", `No retained terminal exists for ${key}.`);
	return resource;
}

export async function readTerminal(key: string): Promise<TerminalProjection> {
	const resource = getTerminalResource(key);
	switch (resource.kind) {
		case "live": return resource.screen.project();
		case "frozen": return resource.projection;
	}
}

export async function freezeTerminal(key: string): Promise<void> {
	const live = terminalRegistry.resources.get(key);
	if (!live || live.kind === "frozen") return;
	const projection = await live.screen.project();
	const current = terminalRegistry.resources.get(key);
	if (current?.kind === "live" && current.screen === live.screen) {
		terminalRegistry.resources.set(key, { kind: "frozen", projection, onRead: current.onRead });
	}
}

/**
 * Shutdown may discard unfinished live projections, never frozen or other
 * activations' resources.
 */
export function discardLiveTerminal(key: string): boolean {
	if (terminalRegistry.resources.get(key)?.kind !== "live") return false;
	return terminalRegistry.resources.delete(key);
}

export type TerminalReadTarget =
	| { readonly kind: "retained" }
	| { readonly kind: "screen" }
	| { readonly kind: "page"; readonly page: number };

export function parseTerminalTarget(path: string): TerminalReadTarget {
	if (path === "" || path === "/") return { kind: "retained" };
	if (path === "/screen") return { kind: "screen" };
	const page = /^\/page\/(-?[1-9]\d*)$/.exec(path);
	if (page) {
		const value = Number(page[1]);
		if (Number.isSafeInteger(value)) return { kind: "page", page: value };
	}
	throw new TerminalResourceError("invalid_terminal_target", `Expected /screen or /page/N; received ${path}.`);
}

function visibleLines(projection: TerminalProjection): readonly string[] {
	switch (projection.view.screen) {
		case "normal": return projection.retainedLines;
		case "alternate": return projection.screenLines;
	}
}

export function terminalText(projection: TerminalProjection, target: TerminalReadTarget): string {
	switch (target.kind) {
		case "retained": return visibleLines(projection).join("\n");
		case "screen": return projection.screenLines.join("\n");
		case "page": {
			const lines = visibleLines(projection);
			const totalPages = Math.max(1, Math.ceil(lines.length / projection.view.rows));
			const page = target.page > 0 ? target.page : totalPages + target.page + 1;
			if (page < 1 || page > totalPages) {
				throw new TerminalResourceError("terminal_page_out_of_range", `Page ${target.page} is outside ${totalPages} total pages.`);
			}
			const start = (page - 1) * projection.view.rows;
			return lines.slice(start, start + projection.view.rows).join("\n");
		}
	}
}
