import type * as InternalUrls from "@oh-my-pi/pi-coding-agent/internal-urls";

import { sanitizeOutputText } from "../src/output-safety.ts";
import { registerInternalScheme } from "./omomp-shared/internal-url.ts";
import { writeTerminalImage } from "./terminal-image.ts";
import {
	getTerminalResource,
	noteTerminalRead,
	parseTerminalTarget,
	readTerminal,
	resolveTerminalKey,
	setTerminalIdResolver,
	TerminalResourceError,
	terminalText,
} from "./terminal-resource.ts";

const handlerBrand = Symbol.for("omp-unified-exec.term-handler");
const runtimeSymbol = Symbol.for("omp-unified-exec.term-runtime");

export interface TerminalUrlRuntime {
	listSessions(): string;
	resolveSessionKey(id: number): string | undefined;
	writeStdin(target: string, content: string, toolCallId?: string, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
	killSession(target: string, signal: string | undefined, toolCallId?: string): Promise<{ text: string; killed: boolean }>;
	setOnExit(target: string, policy: "wake" | "none"): string;
	cancelMonitor(target: string): string;
}

const runtimeHolder = globalThis as typeof globalThis & { [runtimeSymbol]?: TerminalUrlRuntime };

export function setTerminalUrlRuntime(runtime: TerminalUrlRuntime | undefined): void {
	runtimeHolder[runtimeSymbol] = runtime;
	setTerminalIdResolver(runtime ? (id) => runtime.resolveSessionKey(id) : undefined);
}

export function getTerminalUrlRuntime(): TerminalUrlRuntime | undefined {
	return runtimeHolder[runtimeSymbol];
}

type TerminalUrlHandler = InternalUrls.ProtocolHandler & {
	readonly scheme: "term";
	readonly spec: InternalUrls.SchemeSpec & {
		readonly backing: "file";
		readonly selectors: "lines";
		readonly immutable: false;
		readonly write: InternalUrls.SchemeWritePolicy;
	};
	readonly [handlerBrand]: true;
};

type InternalUrlRouterHost = Pick<typeof InternalUrls, "InternalUrlRouter">;

export function parseInternalUrlRouterHost(value: Partial<InternalUrlRouterHost>): InternalUrlRouterHost {
	const { InternalUrlRouter } = value;
	if (typeof InternalUrlRouter !== "function" || typeof InternalUrlRouter.instance !== "function") {
		throw new Error("omp-unified-exec: internal-urls lacks InternalUrlRouter.instance; requalify term:// integration");
	}
	return { InternalUrlRouter };
}

function writeOnlyReadError(host: string, path: string): string {
	switch (path) {
		case "/kill":
			return `term://${host}/kill is write-only; reading it did not stop anything. Call write with ${JSON.stringify({ path: `term://${host}/kill`, content: "" })} to terminate, or read term://${host} for output.`;
		case "/on_exit":
			return `term://${host}/on_exit is write-only; reading it changed nothing. Call write with ${JSON.stringify({ path: `term://${host}/on_exit`, content: "none" })} ("wake" or "none").`;
		case "/monitor":
			return `term://${host}/monitor is write-only; reading it cancelled nothing. Call write with ${JSON.stringify({ path: `term://${host}/monitor`, content: "cancel" })} to cancel.`;
		default:
			return `term://${host}${path} is write-only.`;
	}
}

export async function initializeTerminalUrls(): Promise<void> {
	const { InternalUrlRouter } = parseInternalUrlRouterHost(await import("@oh-my-pi/pi-coding-agent/internal-urls"));
	const router = InternalUrlRouter.instance();
	const handler: TerminalUrlHandler = {
		[handlerBrand]: true,
		scheme: "term",
		spec: {
			backing: "file",
			selectors: "lines",
			immutable: false,
			write: {
				via: "handler",
				payload: "verbatim",
				scope: "workspace",
				tier: () => "exec",
				cancels: (url) => url.pathname.endsWith("/kill") || url.pathname.endsWith("/monitor"),
			},
		},
		promptDoc(): string {
			return "`term://` / `term://<id>` / `term://<id>/screen.png` — List or inspect interactive PTY sessions (like `proc://` for PTYs); write `term://<id>` (stdin), `term://<id>/kill`, `term://<id>/on_exit` (`wake`|`none`), or `term://<id>/monitor` (`cancel`).";
		},
		promptReference(): string {
			return [
				"term:// — interactive PTY terminal sessions",
				"  read term://                                   list all running and exited sessions (session_id, key, title, status, URLs)",
				"  read term://<id_or_key>                        retained history (normal screen) or active screen (alternate screen)",
				"  read term://<id_or_key>/screen                 active visible screen text",
				"  read term://<id_or_key>/page/<n>               paged lines (1-based, or negative from end such as -1)",
				"  read term://<id_or_key>/screen.png             styled terminal screenshot",
				"  write term://<id_or_key>                       send stdin text (appends Enter unless ending in CR/LF; empty = Enter)",
				"  write term://<id_or_key>/kill[?signal=SIGTERM] terminate session (content empty or signal name)",
				'  write term://<id_or_key>/on_exit               set exit wake policy: "wake" or "none"',
				'  write term://<id_or_key>/monitor               cancel active monitor subscription: "cancel"',
			].join("\n");
		},
		async resolve(url) {
			const host = url.rawHost || url.hostname;
			const path = url.rawPathname ?? url.pathname;
			if (!host) {
				if (path !== "" && path !== "/") {
					throw new TerminalResourceError("invalid_terminal_target", `Expected term:// or term://<id_or_key>; received ${url.href}.`);
				}
				const runtime = getTerminalUrlRuntime();
				const content = runtime ? runtime.listSessions() : "Active terminals (0 running, 0 exited):\n  (no terminals)";
				return { url: url.href, content, contentType: "text/plain", immutable: false, isDirectory: true };
			}
			if (path === "/kill" || path === "/on_exit" || path === "/monitor") {
				throw new Error(writeOnlyReadError(host, path));
			}
			const key = resolveTerminalKey(host);
			const projection = await readTerminal(key);
			const target = parseTerminalTarget(path);
			const content = sanitizeOutputText(terminalText(projection, target));
			noteTerminalRead(key);
			return { url: url.href, content, contentType: "text/plain", immutable: false };
		},
		async locate(url) {
			const host = url.rawHost || url.hostname;
			const path = url.rawPathname ?? url.pathname;
			if (!host || path !== "/screen.png") return null;
			const key = resolveTerminalKey(host);
			const resource = getTerminalResource(key);
			const projection = resource.kind === "live" ? await resource.screen.project() : resource.projection;
			const image = await writeTerminalImage(projection, resource.kind === "live");
			noteTerminalRead(key);
			return image;
		},
		async write(url, content, context) {
			const host = url.rawHost || url.hostname;
			const path = url.rawPathname ?? url.pathname;
			if (!host) {
				throw new Error("term:// is read-only; write to term://<id>, term://<id>/kill, term://<id>/on_exit, or term://<id>/monitor.");
			}
			const runtime = getTerminalUrlRuntime();
			if (!runtime) {
				throw new Error("No active PTY terminal runtime is available.");
			}
			const toolCallId = context?.toolCall?.id;
			switch (path) {
				case "":
				case "/": {
					const { text, isError } = await runtime.writeStdin(host, content, toolCallId, context?.signal);
					return {
						content: [{ type: "text", text }],
						details: { touchesNoFiles: true },
						...(isError ? { isError: true } : {}),
					};
				}
				case "/kill": {
					const querySignal = url.searchParams.get("signal")?.trim() || undefined;
					const bodySignal = content.trim() || undefined;
					if (querySignal && bodySignal && querySignal.toUpperCase() !== bodySignal.toUpperCase()) {
						throw new Error(`term://${host}/kill: conflicting signals in query (${querySignal}) and body (${bodySignal}).`);
					}
					const { text, killed } = await runtime.killSession(host, querySignal ?? bodySignal, toolCallId);
					return {
						content: [{ type: "text", text }],
						details: { touchesNoFiles: true },
						...(killed ? {} : { isError: true }),
					};
				}
				case "/on_exit": {
					const policy = content.trim();
					if (policy !== "wake" && policy !== "none") {
						throw new Error(`term://${host}/on_exit requires content "wake" or "none".`);
					}
					const text = runtime.setOnExit(host, policy);
					return { content: [{ type: "text", text }], details: { touchesNoFiles: true } };
				}
				case "/monitor": {
					const action = content.trim();
					if (action !== "cancel") {
						throw new Error(`term://${host}/monitor requires content "cancel".`);
					}
					const text = runtime.cancelMonitor(host);
					return { content: [{ type: "text", text }], details: { touchesNoFiles: true } };
				}
				default:
					throw new Error(`Unsupported term:// write path "${path}"; use /kill, /on_exit, or /monitor.`);
			}
		},
	};
	const existing = router.getHandler("term");
	if (existing !== undefined && handlerBrand in existing && existing[handlerBrand] === true) router.unregister("term");
	const outcome = registerInternalScheme(router, "omp-unified-exec/term", handler);
	switch (outcome.kind) {
		case "registered":
			if (router.getHandler("term") !== handler) {
				throw new Error("omp-unified-exec: InternalUrlRouter did not retain term handler identity");
			}
			return;
		case "builtin":
		case "held":
			throw new Error(
				`omp-unified-exec: term:// belongs to another handler (${outcome.reason}); restart omp after upgrading the plugin`,
			);
	}
}
