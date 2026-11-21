import type {
	ExtensionAPI,
	ToolDefinition,
	ToolRenderResultOptions,
	TruncationResult,
} from "@oh-my-pi/pi-coding-agent";
import type * as GhCache from "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation";
import type * as ThemeModule from "@oh-my-pi/pi-tui/theme";
import type * as PiTuiTools from "@oh-my-pi/pi-tui/tools";
import type { Component } from "@oh-my-pi/pi-tui";

import { sanitizeOutputText } from "./output-safety.ts";
import { tr } from "./omomp-shared/i18n.ts";
import { requireBunRuntime } from "./pty.ts";
import type { SessionStore } from "./session-store.ts";
import type { TerminalAppearance } from "./terminal-screen.ts";
import { truncationMarker } from "./tool-result.ts";
import { type AgentHost, loadAgentHost } from "./agent-park.ts";
import { loadShellHost, type ShellHost } from "./shell-host.ts";
import { loadTerminalHost, type TerminalHost } from "./terminal-host.ts";
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

type StreamedArgs<K extends string> = { readonly [P in K]?: unknown } | undefined;

function streamedArgs<K extends string>(args: unknown): StreamedArgs<K> {
	return typeof args === "object" ? (args ?? undefined) : undefined;
}

/**
 * The bash entry of `toolRenderers` with the members the delegate below
 * requires. `describeCall`/`describeResult`/`mergeCallAndResult`/`inline` are
 * optional on the host `ToolRenderer`; {@link parseShellRenderer} proves them
 * present and narrows the entry to this shape.
 */
type BashRenderer = Required<
	Pick<PiTuiTools.ToolRenderer, "renderCall" | "renderResult" | "describeCall" | "describeResult" | "mergeCallAndResult" | "inline">
>;

/**
 * Renderer hooks spliced onto a presented tool definition, typed by the host's
 * `ToolDefinition` hook signatures. `mergeCallAndResult` and `inline` are
 * forwarded for `applyToolProxy` (they are `ToolRenderer` members, absent from
 * `ToolDefinition`).
 */
type OmpToolHooks = Required<Pick<ToolDefinition, "renderCall" | "renderResult" | "describeCall" | "describeResult">> &
	Required<Pick<PiTuiTools.ToolRenderer, "mergeCallAndResult" | "inline">>;

function parseShellRenderer(value: Partial<Pick<typeof PiTuiTools, "toolRenderers">>): BashRenderer {
	const bash = value.toolRenderers?.bash;
	if (!bash) {
		throw new Error(
			"omp-actual-terminal: @oh-my-pi/pi-tui/tools toolRenderers.bash no longer provides renderCall/renderResult/describeCall/describeResult/mergeCallAndResult/inline; requalify src/omp-presentation.ts for this omp version",
		);
	}
	const { renderCall, renderResult, describeCall, describeResult, mergeCallAndResult, inline } = bash;
	if (
		typeof renderCall !== "function" ||
		typeof renderResult !== "function" ||
		typeof describeCall !== "function" ||
		typeof describeResult !== "function" ||
		typeof mergeCallAndResult !== "boolean" ||
		typeof inline !== "boolean"
	) {
		throw new Error(
			"omp-actual-terminal: @oh-my-pi/pi-tui/tools toolRenderers.bash no longer provides renderCall/renderResult/describeCall/describeResult/mergeCallAndResult/inline; requalify src/omp-presentation.ts for this omp version",
		);
	}
	return { renderCall, renderResult, describeCall, describeResult, mergeCallAndResult, inline };
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

function messageView(result: PiTuiTools.ToolRenderResult, isError: boolean): ResultView {
	const text = result.content
		.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
	return { kind: "message", text: sanitizeOutputText(text), isError };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? sanitizeOutputText(value) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A `details.truncation` value persisted by this plugin's own tool results,
 * parsed at the boundary against the host's `TruncationResult` contract
 * (required fields only; optional fields are read through the interface).
 */
function isTruncationResult(value: unknown): value is TruncationResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		typeof value.content === "string" &&
		"totalLines" in value &&
		typeof value.totalLines === "number" &&
		"totalBytes" in value &&
		typeof value.totalBytes === "number"
	);
}

export function parseResultView(result: PiTuiTools.ToolRenderResult, isPartial: boolean): ResultView {
	const details: PersistedDetails | undefined =
		typeof result.details === "object" && result.details !== null ? result.details : undefined;
	if (details?.operation === "kill_session" && details.found === false) return messageView(result, true);
	if (typeof details?.output !== "string") return messageView(result, result.isError === true);
	const output = sanitizeOutputText(details.output);
	if (isPartial) return { kind: "streaming", output };

	const wallSeconds = optionalNumber(details.wall_time_seconds);
	const wallTimeMs = wallSeconds === undefined ? undefined : wallSeconds * 1000;
	const marker = truncationMarker(
		isTruncationResult(details.truncation) ? details.truncation : undefined,
		typeof details.log_path === "string" ? details.log_path : undefined,
	);
	const failure = optionalString(details.failure_message);

	switch (details.operation) {
		case "bash":
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

/**
 * `ToolDefinition` render hooks return a `Component`, but the host
 * `ToolRenderer` signature permits `undefined`. The presented tools cannot
 * paint nothing silently; fail loudly instead of discarding the result.
 */
function requireComponent(component: Component | undefined): Component {
	if (component === undefined) {
		throw new Error(
			"omp-actual-terminal: @oh-my-pi/pi-tui/tools toolRenderers.bash rendered no component; requalify src/omp-presentation.ts for this omp version",
		);
	}
	return component;
}

function delegateToShell<K extends string>(
	bash: BashRenderer,
	adaptArgs: (args: StreamedArgs<K>) => ShellArgs,
): OmpToolHooks {
	const adaptResult = (result: PiTuiTools.ToolRenderResult, options: ToolRenderResultOptions): ShellResult =>
		toShellResult(parseResultView(result, options.isPartial));
	return {
		renderCall: (args, options, theme) =>
			requireComponent(bash.renderCall(adaptArgs(streamedArgs(args)), options, theme)),
		renderResult: (result, options, theme, args) =>
			requireComponent(bash.renderResult(adaptResult(result, options), options, theme, adaptArgs(streamedArgs(args)))),
		describeCall: (args, options) => bash.describeCall(adaptArgs(streamedArgs(args)), options),
		describeResult: (result, options, args) => {
			const shell = adaptResult(result, options);
			const view = bash.describeResult(shell, options, adaptArgs(streamedArgs(args)));
			return shell.isError && view !== undefined ? { ...view, tone: view.tone ?? "error" } : view;
		},
		mergeCallAndResult: bash.mergeCallAndResult,
		inline: bash.inline,
	};
}

/** Whether a bash result came from a plugin terminal rather than from omp's own bash. */
function isTerminalResult(result: PiTuiTools.ToolRenderResult): boolean {
	const details: PersistedDetails | undefined =
		typeof result.details === "object" && result.details !== null ? result.details : undefined;
	return details?.operation === "bash";
}

/**
 * omp drops its own renderer for a re-registered bash, so the plugin hands every bash call back
 * to it: the arguments are omp's own, results of omp's bash pass through, and only terminal
 * results are adapted.
 */
function presentBash(bash: BashRenderer): OmpToolHooks {
	const adapt = (result: PiTuiTools.ToolRenderResult, options: ToolRenderResultOptions): PiTuiTools.ToolRenderResult | ShellResult =>
		isTerminalResult(result) ? toShellResult(parseResultView(result, options.isPartial)) : result;
	return {
		renderCall: (args, options, theme) => requireComponent(bash.renderCall(args, options, theme)),
		renderResult: (result, options, theme, args) => requireComponent(bash.renderResult(adapt(result, options), options, theme, args)),
		describeCall: (args, options) => bash.describeCall(args, options),
		describeResult: (result, options, args) => {
			const shown = adapt(result, options);
			const view = bash.describeResult(shown, options, args);
			return shown.isError === true && view !== undefined ? { ...view, tone: view.tone ?? "error" } : view;
		},
		mergeCallAndResult: bash.mergeCallAndResult,
		inline: bash.inline,
	};
}

export const SHELL_PRESENTED_TOOLS = ["bash", "write_stdin", "kill_session"] as const;
type ShellPresentedTool = (typeof SHELL_PRESENTED_TOOLS)[number];

function isShellPresented(name: string): name is ShellPresentedTool {
	return (SHELL_PRESENTED_TOOLS as readonly string[]).includes(name);
}

/**
 * The bash renderer is required; a missing or reshaped one fails plugin loading.
 */
async function presentOnOmp(pi: ExtensionAPI): Promise<ExtensionAPI> {
	const bash = parseShellRenderer(await import("@oh-my-pi/pi-tui/tools"));
	const hooks: Record<ShellPresentedTool, OmpToolHooks> = {
		bash: presentBash(bash),
		write_stdin: delegateToShell(bash, writeStdinShellArgs),
		kill_session: delegateToShell(bash, killShellArgs),
	};
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		const overrides = isShellPresented(definition.name)
			? { loadMode: "essential" as const, ...hooks[definition.name] }
			: { loadMode: "essential" as const };
		// Copied by descriptor: a spread would freeze getters such as bash's settings-dependent
		// `description` and `parameters` at their registration-time value.
		const presented = Object.defineProperties(
			{ ...definition, ...overrides },
			{ ...Object.getOwnPropertyDescriptors(definition), ...Object.getOwnPropertyDescriptors(overrides) },
		);
		pi.registerTool(presented);
	};
	const wrapped: ExtensionAPI = Object.create(pi, { registerTool: { value: registerTool } });
	return wrapped;
}

export interface ActivatedExtension {
	readonly store: () => SessionStore;
	readonly kill: (id: number) => Promise<boolean>;
}

async function loadOmpAppearance(): Promise<() => TerminalAppearance> {
	const themeModule: Partial<Pick<typeof ThemeModule, "isLightTheme" | "getCurrentThemeName">> =
		await import("@oh-my-pi/pi-tui/theme");
	const { isLightTheme, getCurrentThemeName } = themeModule;
	if (typeof isLightTheme !== "function" || typeof getCurrentThemeName !== "function") {
		throw new Error("omp-actual-terminal: @oh-my-pi/pi-tui/theme lacks isLightTheme/getCurrentThemeName");
	}
	return () => (isLightTheme(getCurrentThemeName()) ? "light" : "dark");
}

async function loadGithubCacheInvalidation(): Promise<(command: string) => void> {
	const { invalidateGithubCacheForBashCommand }: Partial<
		Pick<typeof GhCache, "invalidateGithubCacheForBashCommand">
	> = await import("@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation");
	if (typeof invalidateGithubCacheForBashCommand !== "function") {
		throw new Error("omp-actual-terminal: tools/gh-cache-invalidation lacks invalidateGithubCacheForBashCommand");
	}
	return invalidateGithubCacheForBashCommand;
}

export function withHostPresentation(
	activate: (
		pi: ExtensionAPI,
		appearance: () => TerminalAppearance,
		terminalHost: TerminalHost,
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
			throw new Error("omp-actual-terminal only supports omp (oh-my-pi); the current host is not omp (missing arktype).");
		}
		requireBunRuntime();
		return Promise.all([
			presentOnOmp(host), loadTernHudHost(), loadOmpAppearance(), loadTerminalHost(),
			loadGithubCacheInvalidation(), loadStopHost(), loadPluginSettingsReader(), loadAgentHost(), loadShellHost(),
		]).then(async ([pi, hud, appearance, terminalHost, invalidateGithubCache, stopHost, pluginSettings, agentHost, shellHost]) => {
			// The specifier
			// is non-literal so bundlers leave it deferred: inlining it would hoist
			// those imports into the bundle and fail module loading before the
			// host-admission checks above can reject a foreign host.
			const removal: typeof TernPluginRemoval = await import(TERN_PLUGIN_REMOVAL_MODULE);
			await removal.retireTernPlugin();
			await initializeTerminalUrls();
			const activated = activate(pi, appearance, terminalHost, invalidateGithubCache, {}, stopHost, pluginSettings, agentHost, shellHost);
			mountTerminalHud(pi, activated.store, hud, activated.kill);
			scheduleLogArchive();
		});
	};
}
