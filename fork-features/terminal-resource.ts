import { randomUUID } from "node:crypto";

import type { TerminalProjection, TerminalScreen } from "../src/terminal-screen.ts";

export type TerminalResource =
	| { readonly kind: "live"; readonly id: number; readonly screen: TerminalScreen; readonly onRead?: () => void }
	| { readonly kind: "frozen"; readonly id: number; readonly projection: TerminalProjection; readonly onRead?: () => void };

interface TerminalRegistry {
	readonly resources: Map<string, TerminalResource>;
	resolveKeyById?: (id: number) => string | undefined;
}

const registrySymbol = Symbol.for("omp-unified-exec.terminal-resources");
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

export function setTerminalIdResolver(resolver: ((id: number) => string | undefined) | undefined): void {
	terminalRegistry.resolveKeyById = resolver;
}

export function registerTerminal(id: number, screen: TerminalScreen, onRead?: () => void): string {
	const key = `${id}-${randomUUID()}`;
	terminalRegistry.resources.set(key, { kind: "live", id, screen, onRead });
	return key;
}

export function resolveTerminalKey(idOrKey: string): string {
	if (terminalRegistry.resources.has(idOrKey)) return idOrKey;
	if (/^\d+$/.test(idOrKey)) {
		const id = Number(idOrKey);
		const activeKey = terminalRegistry.resolveKeyById?.(id);
		if (activeKey !== undefined && terminalRegistry.resources.has(activeKey)) return activeKey;
		let matchedKey: string | undefined;
		for (const [key, resource] of terminalRegistry.resources) {
			if (resource.id === id) matchedKey = key;
		}
		if (matchedKey !== undefined) return matchedKey;
	}
	throw new TerminalResourceError("unknown_terminal", `No retained terminal exists for ${idOrKey}.`);
}

export function noteTerminalRead(idOrKey: string): void {
	try {
		const key = resolveTerminalKey(idOrKey);
		terminalRegistry.resources.get(key)?.onRead?.();
	} catch {
		/* the owner's bookkeeping must not fail a read */
	}
}

export function detachTerminalReader(key: string): void {
	const resource = terminalRegistry.resources.get(key);
	if (resource?.onRead) terminalRegistry.resources.set(key, { ...resource, onRead: undefined });
}

export function getTerminalResource(idOrKey: string): TerminalResource {
	const key = resolveTerminalKey(idOrKey);
	const resource = terminalRegistry.resources.get(key);
	if (!resource) throw new TerminalResourceError("unknown_terminal", `No retained terminal exists for ${idOrKey}.`);
	return resource;
}

export async function readTerminal(idOrKey: string): Promise<TerminalProjection> {
	const resource = getTerminalResource(idOrKey);
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
		terminalRegistry.resources.set(key, { kind: "frozen", id: current.id, projection, onRead: current.onRead });
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
