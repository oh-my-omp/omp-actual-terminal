import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeOutputText } from "./output-safety.ts";
import { findTern, pluginCopyMatches, readPluginManifest } from "./omomp-shared/tern-plugin.ts";

export const TERN_PLUGIN_ID = "omp-actual-terminal";
const CLI_TIMEOUT_MS = 75_000;
const MAX_DIAGNOSTIC_CHARS = 4096;
const PACKAGE_PLUGIN_DIR = fileURLToPath(new URL("../tern-plugin", import.meta.url));

export type InstallStage = "locate" | "inspect" | "install";

export type InstallFailure = { readonly kind: "tern"; readonly stage: InstallStage; readonly message: string };

export type InstallOutcome =
	| { readonly kind: "unavailable" }
	| { readonly kind: "current" }
	| { readonly kind: "installed" }
	| { readonly kind: "linked" }
	| { readonly kind: "failed"; readonly failure: InstallFailure };

export interface InstallOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly packageDir?: string;
}

function linkedCopy(root: string): boolean {
	try {
		lstatSync(join(root, `${TERN_PLUGIN_ID}.path`));
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

export async function installTernPlugin(options: InstallOptions = {}): Promise<InstallOutcome> {
	const env = options.env ?? process.env;
	const packageDir = options.packageDir ?? PACKAGE_PLUGIN_DIR;
	const found = findTern({ env, timeoutMs: CLI_TIMEOUT_MS });
	if (found.kind === "not_installed") return { kind: "unavailable" };
	const cli = found.cli;
	const manifest = await readPluginManifest(packageDir, TERN_PLUGIN_ID);
	if (!manifest.ok) return { kind: "failed", failure: { kind: "tern", stage: "locate", message: manifest.error.message } };
	const root = await cli.dir();
	if (!root.ok) return { kind: "failed", failure: { kind: "tern", stage: "inspect", message: root.error.message } };
	if (linkedCopy(root.value)) return { kind: "linked" };
	const catalog = await cli.list();
	if (!catalog.ok) return { kind: "failed", failure: { kind: "tern", stage: "inspect", message: catalog.error.message } };
	const listed = catalog.value.some((plugin) => plugin.id === TERN_PLUGIN_ID);
	const matches = await pluginCopyMatches(packageDir, join(root.value, TERN_PLUGIN_ID));
	if (!matches.ok) return { kind: "failed", failure: { kind: "tern", stage: "inspect", message: matches.error.message } };
	if (listed && matches.value) return { kind: "current" };
	const installed = await cli.install(packageDir);
	if (!installed.ok) return { kind: "failed", failure: { kind: "tern", stage: "install", message: installed.error.message } };
	return { kind: "installed" };
}

function diagnostic(text: string): string {
	const bounded = text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}\n[diagnostic truncated]` : text;
	return sanitizeOutputText(bounded);
}

export class TernPluginInstallError extends Error {
	constructor(readonly failure: InstallFailure) {
		super(`omp-actual-terminal: installing the Tern plugin failed at ${failure.stage}: ${diagnostic(failure.message)}`);
		this.name = "TernPluginInstallError";
	}
}

export async function ensureTernPlugin(options: InstallOptions = {}): Promise<void> {
	const outcome = await installTernPlugin(options);
	if (outcome.kind !== "failed") return;
	throw new TernPluginInstallError(outcome.failure);
}
