import { sanitizeOutputText } from "./output-safety.ts";
import { findTern, type TernPluginCli } from "./omomp-shared/tern-plugin.ts";

export const TERN_PLUGIN_ID = "omp-unified-exec";
const CLI_TIMEOUT_MS = 75_000;
const MAX_DIAGNOSTIC_CHARS = 4096;
const LINKED = `tern plugin: ${TERN_PLUGIN_ID} is linked; use unlink`;

export type RemovalStage = "inspect" | "remove" | "unlink" | "verify";

export type RemovalFailure =
	| { readonly kind: "tern"; readonly stage: RemovalStage; readonly message: string }
	| { readonly kind: "verification"; readonly message: string };

export type RemovalOutcome =
	| { readonly kind: "unavailable" }
	| { readonly kind: "absent" }
	| { readonly kind: "removed"; readonly via: "remove" | "unlink" }
	| { readonly kind: "failed"; readonly failure: RemovalFailure };

async function listed(cli: TernPluginCli, stage: "inspect" | "verify"): Promise<boolean | RemovalOutcome> {
	const catalog = await cli.list();
	if (!catalog.ok) return { kind: "failed", failure: { kind: "tern", stage, message: catalog.error.message } };
	return catalog.value.some((plugin) => plugin.id === TERN_PLUGIN_ID);
}

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
			return `omp-actual-terminal: removing the old Tern plugin failed at ${failure.stage}: ${diagnostic(failure.message)}`;
		case "verification":
			return `omp-actual-terminal: removing the old Tern plugin failed: ${diagnostic(failure.message)}`;
	}
}

export class TernPluginRemovalError extends Error {
	constructor(readonly failure: RemovalFailure) {
		super(formatFailure(failure));
		this.name = "TernPluginRemovalError";
	}
}

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
