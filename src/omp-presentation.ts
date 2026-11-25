import type {
	ExtensionAPI,
	ExtensionRender,
	ExtensionTheme,
	ToolDefinition,
	ToolRenderResultOptions,
	TruncationResult,
} from "@oh-my-pi/pi-coding-agent";
import type * as GhCache from "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation";
import { jsx, nativeRendering } from "@oh-my-pi/pi-tui";
import type { JSX, JSXNode, UiKind } from "@oh-my-pi/pi-tui";
import type * as ThemeRuntime from "@oh-my-pi/pi-tui/theme/runtime";

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
import { mountTerminalHud } from "./tern-terminal-hud.ts";
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

type ToolRenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0];

type ShellHeadline = "command" | "description";

interface ShellToolHooks {
	readonly renderCall: (
		args: unknown,
		options: ToolRenderResultOptions,
		theme?: ExtensionTheme,
	) => ExtensionRender | undefined;
	readonly renderResult: (
		result: ToolRenderResult,
		options: ToolRenderResultOptions,
		theme?: ExtensionTheme,
		args?: unknown,
	) => ExtensionRender | undefined;
	readonly mergeCallAndResult: true;
}

function element<K extends UiKind>(
	kind: K,
	attributes: JSX.IntrinsicElements[K] & Readonly<Record<string, unknown>>,
): JSXNode {
	return jsx(kind, attributes);
}

export type ResultView =
	| { readonly kind: "streaming"; readonly output: string }
	| {
			readonly kind: "backgrounded";
			readonly output: string;
			readonly jobId: string;
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

type UnknownRecord = Readonly<Record<string, unknown>>;

function recordOf(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null ? (value as UnknownRecord) : undefined;
}

function contentText(result: ToolRenderResult): string {
	return result.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function messageView(result: ToolRenderResult, isError: boolean): ResultView {
	return { kind: "message", text: sanitizeOutputText(contentText(result)), isError };
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

export function parseResultView(result: ToolRenderResult, isPartial: boolean): ResultView {
	const details = recordOf(result.details);
	if (details?.operation === "kill_session" && details.found === false) return messageView(result, true);
	if (details === undefined || typeof details.output !== "string") return messageView(result, result.isError === true);
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
			const jobId = optionalString(details.job_id);
			if (details.status === "running" && jobId !== undefined) {
				return { kind: "backgrounded", output, jobId, wallTimeMs, marker };
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
					async: { state: "running", jobId: view.jobId, type: "bash" },
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

export function writeStdinShellArgs(args: StreamedArgs<"job_id" | "chars" | "chars_b64">): ShellArgs {
	const target = optionalString(args?.job_id) ?? "?";
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

export function killShellArgs(args: StreamedArgs<"job_id" | "signal">): ShellArgs {
	const target = optionalString(args?.job_id) ?? "?";
	const signal = optionalString(args?.signal) ?? "SIGTERM";
	return { command: tr(`# kill ${target} (${signal})`, `# 结束 ${target}（${signal}）`) };
}

const COLLAPSED_OUTPUT_LINES = 10;

function shellArgsOf(args: unknown): ShellArgs {
	const value = streamedArgs<"command" | "cwd">(args);
	return { command: optionalString(value?.command), cwd: optionalString(value?.cwd) };
}

function collapsedOutput(text: string, expanded: boolean): string {
	const body = text.replace(/\n+$/, "");
	if (expanded) return body;
	const lines = body.split("\n");
	return lines.length <= COLLAPSED_OUTPUT_LINES ? body : lines.slice(-COLLAPSED_OUTPUT_LINES).join("\n");
}

function formatWallTime(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

interface CardState {
	readonly word: string;
	readonly token: string;
}

function cardState(result: ShellResult | undefined, options: ToolRenderResultOptions): CardState {
	const job = result?.details.async;
	if (job !== undefined) return { word: `background · job ${job.jobId}`, token: "warning" };
	if (result === undefined || options.isPartial) return { word: "running", token: "warning" };
	const exitCode = result.details.exitCode;
	if (exitCode !== undefined) {
		return { word: `exit ${exitCode}`, token: exitCode === 0 && !result.isError ? "success" : "error" };
	}
	return result.isError ? { word: "failed", token: "error" } : { word: "killed", token: "muted" };
}

function headlineNode(command: string | undefined, headline: ShellHeadline): JSXNode {
	const text = command ?? "…";
	switch (headline) {
		case "command":
			return element("code", { lang: "bash", text: `$ ${text}` });
		case "description":
			return element("text", { spans: [{ t: text, s: "muted" }] });
	}
}

function footerNode(result: ShellResult | undefined, options: ToolRenderResultOptions): JSXNode {
	const state = cardState(result, options);
	const spans: Array<{ readonly t: string; readonly s?: string }> = [{ t: state.word, s: state.token }];
	const wallTimeMs = result?.details.wallTimeMs;
	if (wallTimeMs !== undefined) spans.push({ t: " · ", s: "muted" }, { t: formatWallTime(wallTimeMs), s: "muted" });
	return element("text", { spans });
}

export function shellCard(
	args: ShellArgs,
	result: ShellResult | undefined,
	options: ToolRenderResultOptions,
	headline: ShellHeadline,
): ExtensionRender {
	const children: JSXNode[] = [headlineNode(args.command, headline)];
	const output = result === undefined ? "" : collapsedOutput(contentText(result), options.expanded);
	if (output.length > 0) children.push(element("ansi", { text: output }));
	children.push(footerNode(result, options));
	return element("col", { gap: "xs", children });
}

export function shellToolHooks(headline: ShellHeadline, adaptArgs: (args: unknown) => ShellArgs): ShellToolHooks {
	return {
		mergeCallAndResult: true,
		renderCall: (args, options) => shellCard(adaptArgs(args), undefined, options, headline),
		renderResult: (result, options, _theme, args) =>
			shellCard(adaptArgs(args), toShellResult(parseResultView(result, options.isPartial)), options, headline),
	};
}

function isTerminalResult(result: ToolRenderResult): boolean {
	return recordOf(result.details)?.operation === "bash";
}

function isTerminalCall(args: unknown): boolean {
	return streamedArgs<"pty">(args)?.pty === true;
}

function ompShellResult(result: ToolRenderResult): ShellResult {
	const details = recordOf(result.details);
	const job = recordOf(details?.async);
	const jobId = job?.state === "running" && typeof job.jobId === "string" ? job.jobId : undefined;
	const isError = result.isError === true;
	const exitCode = optionalNumber(details?.exitCode) ?? (isError ? undefined : 0);
	const wallTimeMs = optionalNumber(details?.wallTimeMs);
	return shellResult(
		sanitizeOutputText(contentText(result)),
		jobId === undefined
			? { exitCode, wallTimeMs }
			: { exitCode, wallTimeMs, async: { state: "running", jobId, type: "bash" } },
		isError,
	);
}

export function bashToolHooks(): ShellToolHooks {
	return {
		mergeCallAndResult: true,
		renderCall: (args, options) => {
			if (!isTerminalCall(args) && nativeRendering()) return undefined;
			return shellCard(shellArgsOf(args), undefined, options, "command");
		},
		renderResult: (result, options, _theme, args) => {
			if (isTerminalResult(result)) {
				return shellCard(
					shellArgsOf(args),
					toShellResult(parseResultView(result, options.isPartial)),
					options,
					"command",
				);
			}
			if (nativeRendering()) return undefined;
			return shellCard(shellArgsOf(args), ompShellResult(result), options, "command");
		},
	};
}

export const SHELL_PRESENTED_TOOLS = ["bash", "write_stdin", "kill_session"] as const;
type ShellPresentedTool = (typeof SHELL_PRESENTED_TOOLS)[number];

function isShellPresented(name: string): name is ShellPresentedTool {
	return (SHELL_PRESENTED_TOOLS as readonly string[]).includes(name);
}

export async function presentOnOmp(pi: ExtensionAPI): Promise<ExtensionAPI> {
	const hooks: Record<ShellPresentedTool, ShellToolHooks> = {
		bash: bashToolHooks(),
		write_stdin: shellToolHooks("description", (args) => writeStdinShellArgs(streamedArgs(args))),
		kill_session: shellToolHooks("description", (args) => killShellArgs(streamedArgs(args))),
	};
	const registerTool: ExtensionAPI["registerTool"] = (definition) => {
		const overrides = isShellPresented(definition.name)
			? { loadMode: "essential" as const, ...hooks[definition.name] }
			: { loadMode: "essential" as const };
		// Copied by descriptor: a spread would freeze getters such as bash's settings-dependent
		// `description` and `parameters` at their registration-time value.
		const presented = Object.defineProperties(
			{},
			{ ...Object.getOwnPropertyDescriptors(definition), ...Object.getOwnPropertyDescriptors(overrides) },
		) as typeof definition & typeof overrides;
		pi.registerTool(presented);
	};
	const wrapped: ExtensionAPI = Object.create(pi, { registerTool: { value: registerTool } });
	return wrapped;
}

export interface ActivatedExtension {
	readonly store: () => SessionStore;
	readonly kill: (id: string) => Promise<boolean>;
}

async function loadOmpAppearance(): Promise<() => TerminalAppearance> {
	const { currentTheme }: Partial<Pick<typeof ThemeRuntime, "currentTheme">> = await import("@oh-my-pi/pi-tui/theme/runtime");
	if (typeof currentTheme !== "function") {
		throw new Error("omp-actual-terminal: @oh-my-pi/pi-tui/theme/runtime lacks currentTheme");
	}
	return () => (currentTheme().dark ? "dark" : "light");
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
			presentOnOmp(host), loadOmpAppearance(), loadTerminalHost(),
			loadGithubCacheInvalidation(), loadStopHost(), loadPluginSettingsReader(), loadAgentHost(), loadShellHost(),
		]).then(async ([pi, appearance, terminalHost, invalidateGithubCache, stopHost, pluginSettings, agentHost, shellHost]) => {
			// The specifier
			// is non-literal so bundlers leave it deferred: inlining it would hoist
			// those imports into the bundle and fail module loading before the
			// host-admission checks above can reject a foreign host.
			const removal: typeof TernPluginRemoval = await import(TERN_PLUGIN_REMOVAL_MODULE);
			await removal.retireTernPlugin();
			await initializeTerminalUrls();
			const activated = activate(pi, appearance, terminalHost, invalidateGithubCache, {}, stopHost, pluginSettings, agentHost, shellHost);
			mountTerminalHud(pi, activated.store, activated.kill);
			scheduleLogArchive();
		});
	};
}
