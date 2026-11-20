import type * as InternalUrls from "@oh-my-pi/pi-coding-agent/internal-urls";

import { sanitizeOutputText } from "../src/output-safety.ts";
import { registerInternalScheme } from "./omomp-shared/internal-url.ts";
import { writeTerminalImage } from "./terminal-image.ts";
import { getTerminalResource, noteTerminalRead, parseTerminalTarget, readTerminal, terminalText } from "./terminal-resource.ts";

const handlerBrand = Symbol.for("omp-unified-exec.term-handler");

type TerminalUrlHandler = InternalUrls.ProtocolHandler & {
	readonly scheme: "term";
	readonly spec: InternalUrls.SchemeSpec & {
		readonly backing: "file";
		readonly selectors: "lines";
		readonly immutable: false;
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

export async function initializeTerminalUrls(): Promise<void> {
	const { InternalUrlRouter } = parseInternalUrlRouterHost(await import("@oh-my-pi/pi-coding-agent/internal-urls"));
	const router = InternalUrlRouter.instance();
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