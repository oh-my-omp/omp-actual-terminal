/**
 * Removes the Tern plugin earlier versions of this extension installed.
 *
 * Up to 0.14.7 the extension installed a CSS-only Tern plugin
 * (`omp-unified-exec`), a normal copy (0.14.7) or a developer link (0.14.6).
 * The HUD now uses omp's own roles and Tern's built-in styles only, and the
 * old stylesheet still selects omp's shared `belowEditor` container, moving
 * other extensions' widgets. The extension created that plugin, so it ends
 * it: omp awaits this during install validation and ordinary loading, before
 * activation, as it awaited the installer.
 *
 * Tern owns its plugin directory, registration and reload; every change goes
 * through its CLI, and only the plugin id `omp-unified-exec` is touched.
 */
import { sanitizeOutputText } from "../src/output-safety.ts";
import { findTern, type TernPluginCli } from "./omomp-shared/tern-plugin.ts";

/** The id the earlier versions' `plugin.toml` declared. */
export const TERN_PLUGIN_ID = "omp-unified-exec";
// Each mutation reloads Tern's daemon, whose documented wait is up to 60 seconds.
const CLI_TIMEOUT_MS = 75_000;
const MAX_DIAGNOSTIC_CHARS = 4096;
/** Tern's answer to `remove` for a plugin registered with `link`. */
const LINKED = `tern plugin: ${TERN_PLUGIN_ID} is linked; use unlink`;

export type RemovalStage = "inspect" | "remove" | "unlink" | "verify";

export type RemovalFailure =
	/** A `tern plugin` call or its JSON answer failed; `message` carries the stage detail. */
	| { readonly kind: "tern"; readonly stage: RemovalStage; readonly message: string }
	| { readonly kind: "verification"; readonly message: string };

export type RemovalOutcome =
	/** Tern is not installed; nothing of ours can be registered. */
	| { readonly kind: "unavailable" }
	/** Tern lists no `omp-unified-exec` plugin. */
	| { readonly kind: "absent" }
	/** Removed through Tern's `remove` (a copy) or `unlink` (a link). */
	| { readonly kind: "removed"; readonly via: "remove" | "unlink" }
	| { readonly kind: "failed"; readonly failure: RemovalFailure };

/** Whether Tern's catalog lists our plugin; a list call or parse failure is a `failed` outcome at `stage`. */
async function listed(cli: TernPluginCli, stage: "inspect" | "verify"): Promise<boolean | RemovalOutcome> {
	const catalog = await cli.list();
	if (!catalog.ok) return { kind: "failed", failure: { kind: "tern", stage, message: catalog.error.message } };
	return catalog.value.some((plugin) => plugin.id === TERN_PLUGIN_ID);
}

/**
 * Ask Tern to remove `omp-unified-exec` when it lists one: `remove` for a
 * copy, `unlink` only when Tern answers that it is linked. Tern's catalog
 * must then no longer list it.
 */
export async function removeTernPlugin(env: NodeJS.ProcessEnv): Promise<RemovalOutcome> {
	const found = findTern({ env, timeoutMs: CLI_TIMEOUT_MS });
	if (found.kind === "not_installed") return { kind: "unavailable" };
	const cli = found.cli;
	const before = await listed(cli, "inspect");
	if (typeof before !== "boolean") return before;
	if (!before) return { kind: "absent" };

	let via: "remove" | "unlink" = "remove";
	const removed = await cli.remove(TERN_PLUGIN_ID);
	if (!removed.ok) {
		if (!removed.error.message.includes(LINKED)) {
			return { kind: "failed", failure: { kind: "tern", stage: "remove", message: removed.error.message } };
		}
		via = "unlink";
		const unlinked = await cli.unlink(TERN_PLUGIN_ID);
		if (!unlinked.ok) return { kind: "failed", failure: { kind: "tern", stage: "unlink", message: unlinked.error.message } };
	}

	const after = await listed(cli, "verify");
	if (typeof after !== "boolean") return after;
	if (after) return { kind: "failed", failure: { kind: "verification", message: `Tern still lists ${TERN_PLUGIN_ID} after ${via}` } };
	return { kind: "removed", via };
}

function diagnostic(text: string): string {
	const bounded = text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]` : text;
	return sanitizeOutputText(bounded);
}

function formatFailure(failure: RemovalFailure): string {
	switch (failure.kind) {
		case "tern":
			return `omp-unified-exec: removing the old Tern plugin failed at ${failure.stage}: ${diagnostic(failure.message)}`;
		case "verification":
			return `omp-unified-exec: removing the old Tern plugin failed: ${diagnostic(failure.message)}`;
	}
}

export class TernPluginRemovalError extends Error {
	constructor(readonly failure: RemovalFailure) {
		super(formatFailure(failure));
		this.name = "TernPluginRemovalError";
	}
}

/** omp awaits this during install validation and ordinary loading; a failing Tern rejects loading with diagnostics. */
export async function retireTernPlugin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const outcome = await removeTernPlugin(env);
	switch (outcome.kind) {
		case "unavailable":
		case "absent":
		case "removed":
			return;
		case "failed":
			throw new TernPluginRemovalError(outcome.failure);
	}
}
