import type * as Root from "@oh-my-pi/pi-coding-agent";
import type { BashTool, ImageAttachmentEntry, Settings, ToolSession, ToolTier } from "@oh-my-pi/pi-coding-agent";
import type * as BashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type * as ExecSettings from "@oh-my-pi/pi-coding-agent/exec/settings";
import type * as NonInteractiveEnv from "@oh-my-pi/pi-coding-agent/exec/non-interactive-env";
import type * as ShellProcess from "@oh-my-pi/pi-coding-agent/exec/shell-process";
import type { ShellProcessSpec } from "@oh-my-pi/pi-coding-agent/exec/shell-process-protocol";
import type * as Router from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type * as ConfigRegistry from "@oh-my-pi/pi-coding-agent/config/registry";
import type * as UrlFilesystem from "@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem";
import type * as TaskSettings from "@oh-my-pi/pi-coding-agent/task/settings";
import type * as ToolSettings from "@oh-my-pi/pi-coding-agent/tools/settings";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRegistry } from "./session-binding.ts";

/** omp's own bash as a session without a terminal UI sees it: the plugin reuses its approval and description. */
export type NativeBash = Pick<BashTool, "approval" | "formatApprovalDetails" | "description">;

/** Where the session's persistent shell stands: what it exports, and its functions and aliases as a script. */
export interface SessionSeed {
	readonly env: Readonly<Record<string, string>>;
	readonly script: string;
}

export interface SeedRequest {
	readonly sessionId: string | undefined;
	readonly cwd: string;
	readonly settings: Settings;
	readonly signal: AbortSignal | undefined;
}

export type UrlDirectory =
	| { readonly kind: "directory" }
	| { readonly kind: "missing" }
	| { readonly kind: "not_directory" }
	| { readonly kind: "unavailable"; readonly reason: string };

export interface TerminalHost extends SessionRegistry {
	/** Settings of a session the registry does not resolve. */
	readonly settings: Settings;
	readonly bash: (settings: Settings) => NativeBash;
	/** Whether `launch.enabled` gives bash its named services (`name`, `ready`). */
	readonly servicesEnabled: (settings: Settings) => boolean;
	readonly seed: (request: SeedRequest) => Promise<SessionSeed>;
	/**
	 * The script mounting the URL paths a session-shell terminal may open: `local://` and the skills
	 * of `context`, and the session's `attachments`.
	 */
	readonly mounts: (context: ResolveContext, tier: ToolTier, attachments: readonly ImageAttachmentEntry[]) => Promise<string>;
	/** argv of a shell process of this omp build running `spec`. */
	readonly shellProcess: (spec: ShellProcessSpec) => readonly string[];
	readonly terminalEnv: (exports: Readonly<Record<string, string>>) => Record<string, string>;
	/** The normalized URL when `path` names an internal URL, otherwise undefined. */
	readonly urlPath: (path: string) => string | undefined;
	readonly urlDirectory: (url: string, context: ResolveContext, tier: ToolTier) => Promise<UrlDirectory>;
}

const SHELL_BOOKKEEPING: Readonly<Record<string, true>> = { PWD: true, OLDPWD: true, SHLVL: true, _: true };

function posixQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Parses `env -0` output, keeping what a process started from the shell would inherit. */
export function parseEnvDump(dumped: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of dumped.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		if (Object.hasOwn(SHELL_BOOKKEEPING, key)) continue;
		env[key] = entry.slice(eq + 1);
	}
	return env;
}

/**
 * The environment of a program a user can sit at, from the session shell's exports. The session
 * shell carries the guards unattended commands run under (pagers and editors off, `CI`, a dumb
 * `TERM`, a pinned locale); a guard still at its guard value is left out, so the program gets the
 * value omp was launched with. omp keeps the same rule module-private in
 * `tools/bash-interactive.ts` (`terminalEnv`), so it is restated here over the exported guards.
 */
export function terminalEnvFrom(
	exports: Readonly<Record<string, string>>,
	guards: Readonly<Record<string, string>>,
): Record<string, string> {
	const env = { ...exports };
	for (const name in guards) {
		if (env[name] === guards[name]) delete env[name];
	}
	// procmgr's spawn env marks the session's stdin as no terminal.
	if (env.GPG_TTY === "not a tty") delete env.GPG_TTY;
	env.TERM ??= "xterm-256color";
	return env;
}

type RootModule = Partial<Pick<typeof Root, "BashTool" | "settings" | "Settings" | "AgentRegistry">>;
type ExecutorModule = Partial<Pick<typeof BashExecutor, "executeBash">>;
type ExecSettingsModule = Partial<Pick<typeof ExecSettings, "cfgBashGitGuard">>;
type NonInteractiveModule = Partial<Pick<typeof NonInteractiveEnv, "buildNonInteractiveEnv">>;
type ShellProcessModule = Partial<Pick<typeof ShellProcess, "shellProcessCommand" | "shellMounts">>;
type RouterModule = Partial<Pick<typeof Router, "InternalUrlRouter">>;
type UrlFilesystemModule = Partial<Pick<typeof UrlFilesystem, "InternalUrlFilesystem" | "UrlFsError">>;
type TaskSettingsModule = Partial<Pick<typeof TaskSettings, "ovnfsCommand">>;
type ToolSettingsModule = Partial<Pick<typeof ToolSettings, "cfgLaunchEnabled">>;
type ConfigRegistryModule = Partial<Pick<typeof ConfigRegistry, "lookup">>;

function missing(what: string): never {
	throw new Error(`omp-actual-terminal: ${what}; requalify src/terminal-host.ts for this omp version`);
}

export async function loadTerminalHost(): Promise<TerminalHost> {
	const [root, executor, execSettings, nonInteractive, shellProcess, router, urlFilesystem, taskSettings, toolSettings, configRegistry]: [
		RootModule, ExecutorModule, ExecSettingsModule, NonInteractiveModule, ShellProcessModule, RouterModule, UrlFilesystemModule, TaskSettingsModule,
		ToolSettingsModule, ConfigRegistryModule,
	] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/exec/bash-executor"),
		import("@oh-my-pi/pi-coding-agent/exec/settings"),
		import("@oh-my-pi/pi-coding-agent/exec/non-interactive-env"),
		import("@oh-my-pi/pi-coding-agent/exec/shell-process"),
		import("@oh-my-pi/pi-coding-agent/internal-urls/router"),
		import("@oh-my-pi/pi-coding-agent/internal-urls/url-filesystem"),
		import("@oh-my-pi/pi-coding-agent/task/settings"),
		import("@oh-my-pi/pi-coding-agent/tools/settings"),
		import("@oh-my-pi/pi-coding-agent/config/registry"),
	]);
	const { BashTool: Bash, settings, AgentRegistry } = root;
	const { executeBash } = executor;
	const { cfgBashGitGuard } = execSettings;
	const { buildNonInteractiveEnv } = nonInteractive;
	const { shellProcessCommand, shellMounts } = shellProcess;
	const { InternalUrlRouter } = router;
	const { InternalUrlFilesystem, UrlFsError } = urlFilesystem;
	const { ovnfsCommand } = taskSettings;
	const { cfgLaunchEnabled } = toolSettings;
	const { lookup } = configRegistry;
	if (typeof Bash !== "function") missing("@oh-my-pi/pi-coding-agent lacks BashTool");
	if (settings === undefined) missing("@oh-my-pi/pi-coding-agent lacks settings");
	if (AgentRegistry === undefined || typeof AgentRegistry.global !== "function") missing("@oh-my-pi/pi-coding-agent lacks AgentRegistry.global()");
	if (typeof executeBash !== "function") missing("exec/bash-executor lacks executeBash()");
	if (cfgBashGitGuard === undefined || typeof cfgBashGitGuard.get !== "function") missing("exec/settings lacks cfgBashGitGuard");
	if (typeof buildNonInteractiveEnv !== "function") missing("exec/non-interactive-env lacks buildNonInteractiveEnv()");
	if (typeof shellProcessCommand !== "function" || typeof shellMounts !== "function") missing("exec/shell-process lacks shellProcessCommand()/shellMounts()");
	if (InternalUrlRouter === undefined || typeof InternalUrlRouter.instance !== "function") missing("internal-urls/router lacks InternalUrlRouter.instance()");
	if (typeof InternalUrlFilesystem !== "function" || typeof UrlFsError !== "function") missing("internal-urls/url-filesystem lacks InternalUrlFilesystem/UrlFsError");
	if (typeof ovnfsCommand !== "function") missing("task/settings lacks ovnfsCommand()");
	if (cfgLaunchEnabled === undefined || typeof cfgLaunchEnabled.get !== "function") missing("tools/settings lacks cfgLaunchEnabled");
	if (typeof lookup !== "function") missing("config/registry lacks lookup()");
	// `spotlight/settings` is not among the package's exports, so its setting is looked up by id.
	const spotlightExperiment = lookup("spotlight.experiment.enabled");
	if (spotlightExperiment === undefined) missing("config/registry has no spotlight.experiment.enabled setting");
	const registry = AgentRegistry.global();

	return {
		get: (agentId) => registry.get(agentId),
		settings,
		bash: (sessionSettings) => {
			// A session without a UI: omp then describes bash without its own pty and judges
			// approval from `settings` alone, which is all these fields are read for.
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				settings: sessionSettings,
				isToolActive: (name) => name === "bash",
			};
			return new Bash(session);
		},
		servicesEnabled: (sessionSettings) => cfgLaunchEnabled.get(sessionSettings) === true,
		// omp's `BashTool` reads the same seed in its module-private `#sessionSeed`: a copy of the
		// session's persistent shell (same key, git guard and minimizer) dumps its state to files.
		seed: async ({ sessionId, cwd, settings: sessionSettings, signal }) => {
			const dir = await mkdtemp(join(tmpdir(), "omp-actual-terminal-seed-"));
			const envPath = join(dir, "env");
			const scriptPath = join(dir, "script.sh");
			try {
				const sessionKey = sessionId ?? "";
				const result = await executeBash(
					`env -0 > ${posixQuote(envPath)} && { shopt -p expand_aliases; declare -f; alias -p; } > ${posixQuote(scriptPath)} 2>/dev/null`,
					{
						cwd,
						sessionKey: `${sessionKey}:async:service-env:${crypto.randomUUID()}`,
						seedSessionKey: sessionKey,
						// The minimizer is part of the shell's key. omp runs a session's calls without it while
						// the Spotlight experiment shapes output (`nativeShapingOff`), and its tool session
						// carries the experiment exactly when this setting is on (`startSpotlightExperiment`).
						minimize: spotlightExperiment.get(sessionSettings) !== true,
						gitGuard: cfgBashGitGuard.get(sessionSettings),
						ovnfs: ovnfsCommand(sessionSettings),
						timeout: 10_000,
						signal,
					},
				);
				if (result.exitCode !== 0) throw new Error(result.output || `env exited ${result.exitCode}`);
				const [dumped, script] = await Promise.all([readFile(envPath, "utf8"), readFile(scriptPath, "utf8")]);
				return { env: parseEnvDump(dumped), script };
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		// omp mounts attachments from `context.session`, a tool session the plugin is not given; the
		// same `urlmap` lines are written here from the bound session's attachments instead.
		mounts: async (context, tier, attachments) =>
			(await shellMounts(context, tier))
			+ attachments.map((attachment) => `urlmap -r -e ${posixQuote(attachment.uri)} ${posixQuote(attachment.sourcePath)}\n`).join(""),
		shellProcess: (spec) => {
			const { application, args } = shellProcessCommand(spec);
			return [application, ...args];
		},
		terminalEnv: (exports) => terminalEnvFrom(exports, buildNonInteractiveEnv()),
		urlPath: (path) => {
			const urls = InternalUrlRouter.instance();
			return urls.canHandle(path) ? urls.normalize(path) : undefined;
		},
		urlDirectory: async (url, context, tier) => {
			try {
				const stat = await new InternalUrlFilesystem({ context, tier }).stat(url);
				return stat.type === "directory" ? { kind: "directory" } : { kind: "not_directory" };
			} catch (error) {
				if (error instanceof UrlFsError && error.code === "ENOENT") return { kind: "missing" };
				return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}
