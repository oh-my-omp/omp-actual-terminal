import type { ExtensionAPI, ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";

import { sanitizeOutputText } from "../src/output-safety.ts";
import { tr } from "./omomp-shared/i18n.ts";
import { requireBunRuntime } from "../src/pty.ts";
import type { SessionStore } from "../src/session-store.ts";
import type { TerminalAppearance } from "../src/terminal-screen.ts";
import { truncationMarker } from "../src/tool-result.ts";
import { type AgentHost, loadAgentHost } from "./agent-park.ts";
import { loadShellHost, type ShellHost } from "./shell-host.ts";
import { type CommandApprovalHost, loadCommandApprovalHost } from "./command-approval.ts";
import { loadPluginSettingsReader, type PluginSettingsReader } from "./plugin-settings.ts";
import { loadStopHost, type StopHost } from "./stop-gate.ts";
import type { LifecycleClock } from "./terminal-lifecycle.ts";
import { scheduleLogArchive } from "./log-archive.ts";
import { loadTernHudHost, mountTerminalHud } from "./tern-terminal-hud.ts";
import { initializeTerminalUrls } from "./terminal-url.ts";
import type * as TernPluginRemoval from "./tern-plugin-removal.ts";

const TERN_PLUGIN_REMOVAL_MODULE = "./tern-plugin-removal.ts";

export interface ShellArgs {
	readonly command?: string;
	readonly cwd?: string;
}

export interface ShellDetails {
	readonly exitCode?: number;
	readonly wallTimeMs?: number;
	readonly async?: { readonly state: "running"; readonly jobId: string; readonly type: "bash" };
}

export interface ShellResult {
	readonly content: Array<{ type: "text"; text: string }>;
	readonly details: ShellDetails;
	readonly isError: boolean;
}

interface RenderOptions {
	readonly isPartial?: boolean;
}

type HostValue = unknown;

interface OmpShellRenderer {
	renderCall(args: ShellArgs, options: RenderOptions, theme: HostValue): HostValue;
	renderResult(result: ShellResult, options: RenderOptions, theme: HostValue, args?: ShellArgs): HostValue;
	describeCall(args: ShellArgs, options: RenderOptions): HostValue;
	describeResult(result: ShellResult, options: RenderOptions, args?: ShellArgs): HostValue;
	readonly mergeCallAndResult: boolean;
	readonly inline: boolean;
}

type StreamedArgs<K extends string> = { readonly [P in K]?: unknown } | undefined;

export interface HostResult {
	readonly content?: unknown;
	readonly details?: unknown;
	readonly isError?: unknown;
}

interface OmpToolHooks<K extends string> {
	renderCall(args: StreamedArgs<K>, options: RenderOptions, theme: HostValue): HostValue;
	renderResult(result: HostResult, options: RenderOptions, theme: HostValue, args?: StreamedArgs<K>): HostValue;
	describeCall(args: StreamedArgs<K>, options: RenderOptions): HostValue;
	describeResult(result: HostResult, options: RenderOptions, args?: StreamedArgs<K>): HostValue;
	readonly mergeCallAndResult: boolean;
	readonly inline: boolean;
}

function parseShellRenderer(value: unknown): OmpShellRenderer {
	const bash = value as Partial<Record<keyof OmpShellRenderer, unknown>> | undefined;
	if (
		typeof bash?.renderCall !== "function" ||
		typeof bash.renderResult !== "function" ||
		typeof bash.describeCall !== "function" ||
		typeof bash.describeResult !== "function" ||
		typeof bash.mergeCallAndResult !== "boolean" ||
		typeof bash.inline !== "boolean"
	) {
		throw new Error(
			"omp-unified-exec: @oh-my-pi/pi-tui/tools toolRenderers.bash no longer provides renderCall/renderResult/describeCall/describeResult/mergeCallAndResult/inline; requalify fork-features/omp-presentation.ts for this omp version",
		);
	}
	return bash as OmpShellRenderer;
}

export type ResultView =
	| { readonly kind: "streaming"; readonly output: string }
	| {
			readonly kind: "backgrounded";
			readonly output: string;
			readonly sessionId: number;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "exited";
			readonly output: string;
			readonly exitCode: number | undefined;
			readonly signal: string | undefined;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "killed";
			readonly output: string;
			readonly escalated: boolean;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| {
			readonly kind: "kill_failed";
			readonly output: string;
			readonly failure: string | undefined;
			readonly wallTimeMs: number | undefined;
			readonly marker: string | null;
	  }
	| { readonly kind: "message"; readonly text: string; readonly isError: boolean };

type PersistedDetails = {
	readonly [K in
		| "operation"
		| "status"
		| "output"
		| "session_id"
		| "exit_code"
		| "signal"
		| "failure_message"
		| "wall_time_seconds"
		| "log_path"
		| "truncation"
		| "escalated"
		| "found"]?: unknown;
};

function messageView(result: HostResult, isError: boolean): ResultView {
	const text = Array.isArray(result.content)
		? result.content
				.map((block: { readonly type?: unknown; readonly text?: unknown } | null) =>
					block?.type === "text" && typeof block.text === "string" ? block.text : "",
				)
				.filter((text) => text.length > 0)
				.join("\n")
		: "";
	return { kind: "message", text: sanitizeOutputText(text), isError };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? sanitizeOutputText(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseResultView(result: HostResult, isPartial: boolean): ResultView {
	const details =
		typeof result.details === "object" && result.details !== null ? (result.details as PersistedDetails) : undefined;
	if (details?.operation === "kill_session" && details.found === false) return messageView(result, true);
	if (typeof details?.output !== "string") return messageView(result, result.isError === true);
	const output = sanitizeOutputText(details.output);
	if (isPartial) return { kind: "streaming", output };

	const wallSeconds = optionalNumber(details.wall_time_seconds);
	const wallTimeMs = wallSeconds === undefined ? undefined : wallSeconds * 1000;
	const marker = truncationMarker(
		details.truncation as TruncationResult | undefined,
		typeof details.log_path === "string" ? details.log_path : undefined,
	);
	const failure = optionalString(details.failure_message);

	switch (details.operation) {
		case "exec_command":
		case "write_stdin": {
			const sessionId = optionalNumber(details.session_id);
			if (details.status === "running" && sessionId !== undefined) {
				return { kind: "backgrounded", output, sessionId, wallTimeMs, marker };
			}
			if (details.status === "exited") {
				return {
					kind: "exited",
					output,
					exitCode: optionalNumber(details.exit_code),
					signal: optionalString(details.signal),
					failure,
					wallTimeMs,
					marker,
				};
			}
			break;
		}
		case "kill_session":
			if (details.status === "killed") {
				return { kind: "killed", output, escalated: details.escalated === true, failure, wallTimeMs, marker };
			}
			if (details.status === "kill_failed") {
				return { kind: "kill_failed", output, failure, wallTimeMs, marker };
			}
			break;
	}
	return messageView(result, result.isError === true);
}

function withNotices(output: string, notices: ReadonlyArray<string | null | undefined>): string {
	const present = notices.filter((notice): notice is string => Boolean(notice));
	if (present.length === 0) return output;
	const body = output.replace(/\n+$/, "");
	return body ? `${body}\n\n${present.join("\n")}` : present.join("\n");
}

function shellResult(text: string, details: ShellDetails, isError: boolean): ShellResult {
	return { content: [{ type: "text", text }], details, isError };
}

export function toShellResult(view: ResultView): ShellResult {
	switch (view.kind) {
		case "streaming":
			return shellResult(view.output, {}, false);
		case "backgrounded":
			return shellResult(
				withNotices(view.output, [view.marker]),
				{
					wallTimeMs: view.wallTimeMs,
					async: { state: "running", jobId: tr(`session ${view.sessionId}`, `会话 ${view.sessionId}`), type: "bash" },
				},
				false,
			);
		case "exited":
			return shellResult(
				withNotices(view.output, [
					view.signal && tr(`[signal: ${view.signal}]`, `[信号：${view.signal}]`),
					view.failure && tr(`[failure: ${view.failure}]`, `[失败：${view.failure}]`),
					view.marker,
				]),
				{ exitCode: view.exitCode, wallTimeMs: view.wallTimeMs },
				(view.exitCode !== undefined && view.exitCode !== 0) || view.signal !== undefined || view.failure !== undefined,
			);
		case "killed":
			return shellResult(
				withNotices(view.output, [
					view.escalated ? tr("[escalated to SIGKILL]", "[已升级为 SIGKILL]") : null,
					view.failure && tr(`[failure: ${view.failure}]`, `[失败：${view.failure}]`),
					view.marker,
				]),
				{ wallTimeMs: view.wallTimeMs },
				false,
			);
		case "kill_failed":
			return shellResult(
				withNotices(view.output, [
					tr(
						`[kill failed: ${view.failure ?? "process still running"}]`,
						`[结束失败：${view.failure ?? "进程仍在运行"}]`,
					),
					view.marker,
				]),
				{ wallTimeMs: view.wallTimeMs },
				true,
			);
		case "message":
			return shellResult(view.text, {}, view.isError);
	}
}

function base64ByteLength(b64: string): number {
	const compact = b64.replace(/\s+/g, "");
	const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function stringifyChars(chars: string): string {
	const escaped = chars
		.replace(/\x03/g, "^C")
		.replace(/\x04/g, "^D")
		.replace(/\x1b/g, "^[")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	const safe = sanitizeOutputText(escaped);
	return safe.length > 40 ? `${safe.slice(0, 37)}…` : safe;
}

export function execShellArgs(args: StreamedArgs<"cmd" | "workdir">): ShellArgs {
	return {
		command: typeof args?.cmd === "string" ? args.cmd : undefined,
		cwd: typeof args?.workdir === "string" && args.workdir.length > 0 ? args.workdir : undefined,
	};
}

export function writeStdinShellArgs(args: StreamedArgs<"session_id" | "chars" | "chars_b64">): ShellArgs {
	const target = typeof args?.session_id === "number"
		? tr(`session ${args.session_id}`, `会话 ${args.session_id}`)
		: tr("session ?", "会话 ?");
	if (typeof args?.chars === "string" && args.chars.length > 0) {
		return { command: tr(
			`# stdin → ${target}: "${stringifyChars(args.chars)}"`,
			`# 输入 → ${target}：“${stringifyChars(args.chars)}”`,
		) };
	}
	if (typeof args?.chars_b64 === "string" && args.chars_b64.length > 0) {
		const bytes = base64ByteLength(args.chars_b64);
		return { command: tr(`# stdin → ${target}: ${bytes} bytes`, `# 输入 → ${target}：${bytes} 字节`) };
	}
	return { command: tr(`# stdin → ${target}: (input required)`, `# 输入 → ${target}：（需要输入）`) };
}

export function killShellArgs(args: StreamedArgs<"session_id" | "signal">): ShellArgs {
	const target = typeof args?.session_id === "number"
		? tr(`session ${args.session_id}`, `会话 ${args.session_id}`)
		: tr("session ?", "会话 ?");
	const signal = optionalString(args?.signal) ?? "SIGTERM";
	return { command: tr(`# kill ${target} (${signal})`, `# 结束 ${target}（${signal}）`) };
}

function delegateToShell<K extends string>(
	bash: OmpShellRenderer,
	adaptArgs: (args: StreamedArgs<K>) => ShellArgs,
): OmpToolHooks<K> {
	const adaptResult = (result: HostResult, options: RenderOptions): ShellResult =>
		toShellResult(parseResultView(result, options.isPartial === true));
	return {
		renderCall: (args, options, theme) => bash.renderCall(adaptArgs(args), options, theme),
		renderResult: (result, options, theme, args) =>
			bash.renderResult(adaptResult(result, options), options, theme, adaptArgs(args)),
		describeCall: (args, options) => bash.describeCall(adaptArgs(args), options),
		describeResult: (result, options, args) => {
			const shell = adaptResult(result, options);
			const view = bash.describeResult(shell, options, adaptArgs(args)) as { readonly tone?: unknown } | undefined;
			return shell.isError && view !== undefined ? { ...view, tone: view.tone ?? "error" } : view;
		},
		mergeCallAndResult: bash.mergeCallAndResult,
		inline: bash.inline,
	};
}

export const SHELL_PRESENTED_TOOLS = ["exec_command", "write_stdin", "kill_session"] as const;
type ShellPresentedTool = (typeof SHELL_PRESENTED_TOOLS)[number];

function isShellPresented(name: string): name is ShellPresentedTool {
	return (SHELL_PRESENTED_TOOLS as readonly string[]).includes(name);
}

/**
 * The bash renderer is required; a missing or reshaped one fails plugin loading.
 */
async function presentOnOmp(pi: ExtensionAPI): Promise<ExtensionAPI> {
	const { toolRenderers } = await import("@oh-my-pi/pi-tui/tools");
	const bash = parseShellRenderer(toolRenderers.bash);
	const hooks: Record<ShellPresentedTool, OmpToolHooks<string>> = {
		exec_command: delegateToShell(bash, execShellArgs),
		write_stdin: delegateToShell(bash, writeStdinShellArgs),
		kill_session: delegateToShell(bash, killShellArgs),
	};
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		const topLevel = { ...definition, loadMode: "essential" };
		const presented = isShellPresented(definition.name) ? { ...topLevel, ...hooks[definition.name] } : topLevel;
		pi.registerTool(presented as unknown as ToolDefinition);
	};
	return Object.create(pi, { registerTool: { value: registerTool } }) as ExtensionAPI;
}

export interface ActivatedExtension {
	readonly store: () => SessionStore;
	readonly kill: (id: number) => Promise<boolean>;
}

async function loadOmpAppearance(): Promise<() => TerminalAppearance> {
	const themeModule: unknown = await import("@oh-my-pi/pi-tui/theme");
	if (
		typeof themeModule !== "object" ||
		themeModule === null ||
		!("isLightTheme" in themeModule) ||
		typeof themeModule.isLightTheme !== "function" ||
		!("getCurrentThemeName" in themeModule) ||
		typeof themeModule.getCurrentThemeName !== "function"
	) {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-tui/theme lacks isLightTheme/getCurrentThemeName");
	}
	const isLightTheme = themeModule.isLightTheme as (name?: string) => boolean;
	const getCurrentThemeName = themeModule.getCurrentThemeName as () => string | undefined;
	return () => (isLightTheme(getCurrentThemeName()) ? "light" : "dark");
}

async function loadOmpShellPath(host: ExtensionAPI): Promise<() => string | undefined> {
	const registry: unknown = await import("@oh-my-pi/pi-coding-agent/config/registry");
	if (typeof registry !== "object" || registry === null ||
		!("lookup" in registry) || typeof registry.lookup !== "function") {
		throw new Error("omp-unified-exec: settings registry lacks lookup");
	}
	const handle: unknown = registry.lookup("shellPath");
	const runtime: unknown = "pi" in host ? host.pi : undefined;
	if (typeof handle !== "object" || handle === null ||
		!("get" in handle) || typeof handle.get !== "function" ||
		typeof runtime !== "object" || runtime === null || !("settings" in runtime)) {
		throw new Error("omp-unified-exec: host lacks shellPath setting or pi.settings scope");
	}
	return shellPathReader(handle.get.bind(handle), runtime);
}

function shellPathReader(get: (settings: unknown) => unknown, runtime: { readonly settings: unknown }): () => string | undefined {
	return () => {
		const value: unknown = get(runtime.settings);
		if (value === undefined) return undefined;
		if (typeof value !== "string") throw new Error("omp-unified-exec: shellPath must be a string or undefined");
		return value.trim() || undefined;
	};
}

async function loadGithubCacheInvalidation(): Promise<(command: string) => void> {
	const module: unknown = await import("@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation");
	if (typeof module !== "object" || module === null ||
		!("invalidateGithubCacheForBashCommand" in module) || typeof module.invalidateGithubCacheForBashCommand !== "function") {
		throw new Error("omp-unified-exec: tools/gh-cache-invalidation lacks invalidateGithubCacheForBashCommand");
	}
	return module.invalidateGithubCacheForBashCommand as (command: string) => void;
}

export function withHostPresentation(
	activate: (
		pi: ExtensionAPI,
		appearance?: () => TerminalAppearance,
		shellPath?: () => string | undefined,
		approvalHost?: CommandApprovalHost,
		invalidateGithubCache?: (command: string) => void,
		lifecycleClock?: LifecycleClock,
		stopHost?: StopHost,
		pluginSettings?: PluginSettingsReader,
		agentHost?: AgentHost,
		shellHost?: ShellHost,
	) => ActivatedExtension,
): (host: ExtensionAPI) => void | Promise<void> {
	return (host) => {
		if (!("arktype" in host)) {
			throw new Error("omp-unified-exec only supports omp (oh-my-pi); the current host is not omp (missing arktype).");
		}
		requireBunRuntime();
		return Promise.all([
			presentOnOmp(host), loadTernHudHost(), loadOmpAppearance(), loadOmpShellPath(host), loadCommandApprovalHost(),
			loadGithubCacheInvalidation(), loadStopHost(), loadPluginSettingsReader(), loadAgentHost(), loadShellHost(),
		]).then(async ([pi, hud, appearance, shellPath, approvalHost, invalidateGithubCache, stopHost, pluginSettings, agentHost, shellHost]) => {
			// The specifier
			// is non-literal so bundlers leave it deferred: inlining it would hoist
			// those imports into the bundle and fail module loading before the
			// host-admission checks above can reject a foreign host.
			const removal: typeof TernPluginRemoval = await import(TERN_PLUGIN_REMOVAL_MODULE);
			await removal.retireTernPlugin();
			await initializeTerminalUrls();
			const activated = activate(pi, appearance, shellPath, approvalHost, invalidateGithubCache, {}, stopHost, pluginSettings, agentHost, shellHost);
			mountTerminalHud(pi, activated.store, hud, activated.kill);
			scheduleLogArchive();
		});
	};
}
