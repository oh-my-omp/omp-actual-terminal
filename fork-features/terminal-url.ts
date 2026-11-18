import { sanitizeOutputText } from "../src/output-safety.ts";
import { registerInternalScheme } from "./omomp-shared/internal-url.ts";
import { writeTerminalImage } from "./terminal-image.ts";
import { getTerminalResource, noteTerminalRead, parseTerminalTarget, readTerminal, terminalText } from "./terminal-resource.ts";
import type { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";

// The brand marks every handler this plugin registered, including versions
// before the shared copy: such a handler carries only this brand, so the shared
// copy would treat it as foreign. It is this plugin's own, and an in-process
// reload after an upgrade releases it before registering.
const handlerBrand = Symbol.for("omp-unified-exec.term-handler");

interface TerminalUrlHandler {
	readonly [handlerBrand]: true;
	readonly scheme: "term";
	readonly spec: { readonly backing: "file"; readonly selectors: "lines"; readonly immutable: false };
	resolve(url: URL): Promise<{ url: string; content: string; contentType: "text/plain"; immutable: false }>;
	locate(url: URL): Promise<string | null>;
}

const ROUTER_MEMBERS = ["register", "isBuiltin", "unregister", "getHandler", "specs"] as const;

/** The router members the shared copy reads; a missing one fails plugin loading with a requalify hint. */
function isInternalUrlRouter(value: unknown): value is InternalUrlRouter {
	if (typeof value !== "object" || value === null) return false;
	for (const member of ROUTER_MEMBERS) {
		if (!(member in value) || typeof Reflect.get(value, member) !== "function") return false;
	}
	return true;
}

/** The router owns registration; the shared copy arbitrates ownership and sorts non-built-in schemes by name. */
export async function initializeTerminalUrls(): Promise<void> {
	// This host-only subpath does not exist in the Node/Pi development runtime.
	const module = await import("@oh-my-pi/pi-coding-agent/internal-urls");
	const Router: unknown = module.InternalUrlRouter;
	if (typeof Router !== "function" || !("instance" in Router) || typeof Router.instance !== "function") {
		throw new Error("omp-unified-exec: internal-urls lacks InternalUrlRouter.instance; requalify term:// integration");
	}
	const router: unknown = Router.instance();
	if (!isInternalUrlRouter(router)) {
		throw new Error("omp-unified-exec: InternalUrlRouter lacks register/isBuiltin/getHandler/unregister/specs; requalify term:// integration");
	}
	const handler: TerminalUrlHandler = {
		[handlerBrand]: true,
		scheme: "term",
		spec: { backing: "file", selectors: "lines", immutable: false },
		async resolve(url) {
			const projection = await readTerminal(url.hostname);
			const target = parseTerminalTarget(url.pathname);
			const content = sanitizeOutputText(terminalText(projection, target));
			noteTerminalRead(url.hostname);
			return { url: url.href, content, contentType: "text/plain", immutable: false };
		},
		async locate(url) {
			if (url.pathname !== "/screen.png") return null;
			// Capture the source variant once: a concurrent freeze must not change
			// cursor policy halfway through a single screenshot read.
			const resource = getTerminalResource(url.hostname);
			const projection = resource.kind === "live" ? await resource.screen.project() : resource.projection;
			const image = await writeTerminalImage(projection, resource.kind === "live");
			noteTerminalRead(url.hostname);
			return image;
		},
	};
	const existing: unknown = router.getHandler("term");
	if (typeof existing === "object" && existing !== null && Reflect.get(existing, handlerBrand) === true) router.unregister("term");
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
