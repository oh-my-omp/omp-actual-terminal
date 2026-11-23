import type { ScopeLike, Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { BashApprovalPatternRule as HostBashApprovalPatternRule } from "@oh-my-pi/pi-coding-agent/exec/settings";
import type * as ApprovalHost from "@oh-my-pi/pi-coding-agent/tools/approval";
import type * as BashHost from "@oh-my-pi/pi-coding-agent/tools/bash";
import type * as ShellTokenize from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import { isPosixShell } from "../src/shell.ts";
import type { HostBindingState, HostSettings, SessionRegistry } from "./session-binding.ts";

export type BashApprovalPatternRule = Pick<HostBashApprovalPatternRule, "match" | "approval">;
export type BashPatternApproval = BashApprovalPatternRule["approval"];
export type CommandApproval =
	| "exec"
	| { readonly tier: "write"; readonly policy: "allow" }
	| { readonly tier: "exec"; readonly override: true; readonly reason: "Critical pattern detected" }
	| { readonly tier: "exec"; readonly override: true; readonly policy: "deny" | "prompt"; readonly reason: string };

export interface BashPatternViews {
	readonly session: readonly BashApprovalPatternRule[];
	readonly authority: readonly BashApprovalPatternRule[];
}

export type LiteralShellCommandSegment = ShellTokenize.LiteralShellCommandSegment;
export interface ApprovalHelpers {
	readonly criticalPatterns: readonly (typeof BashHost.CRITICAL_BASH_PATTERNS)[number][];
	readonly tokenizeShellSegments: typeof ShellTokenize.tokenizeShellSegments;
	readonly isShellEnvironmentAssignment: typeof ShellTokenize.isShellEnvironmentAssignment;
	readonly extractLiteralAndChainSegments: typeof ShellTokenize.extractLiteralAndChainSegments;
	readonly truncateForPrompt: typeof ApprovalHost.truncateForPrompt;
}

type Segmenting = Pick<ApprovalHelpers, "tokenizeShellSegments" | "isShellEnvironmentAssignment">;
const BASH_APPROVAL_SHELL_CONTROL_CHARS: Readonly<Record<string, true>> = {
	"\n": true, "\r": true, ";": true, "&": true, "|": true, "<": true,
	">": true, "`": true, $: true, "(": true, ")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) hasReinterpretableShellControl = true;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') { quote = undefined; continue; }
			if (ch === "`" || ch === "$") return true;
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}
function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern).split("*")
		.map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&")).join(".*");
	return new RegExp(`^${escaped}$`, "u");
}
function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "allow" || normalized === "deny" || normalized === "prompt" ? normalized : undefined;
}

export function getBashApprovalPatternRules(value: unknown): readonly BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	const items: readonly unknown[] = value;
	return items.map((item): BashApprovalPatternRule | undefined => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
		if (!("match" in item) || typeof item.match !== "string" || !("approval" in item)) return undefined;
		const match = normalizeBashApprovalPattern(item.match);
		const approval = normalizeBashPatternApproval(item.approval);
		return match.length > 0 && approval ? { match, approval } : undefined;
	}).filter((rule): rule is BashApprovalPatternRule => rule !== undefined);
}
function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalized = normalizeBashApprovalPattern(command);
	return normalized.length > 0 && bashApprovalPatternToRegExp(pattern).test(normalized);
}

function bashCommandSegments(command: string, segmenting: Segmenting): string[] {
	const candidates: string[] = [];
	for (const words of segmenting.tokenizeShellSegments(command)) {
		if (words.length === 0) continue;
		candidates.push(words.join(" "));
		let firstCmdIndex = 0;
		while (firstCmdIndex < words.length && segmenting.isShellEnvironmentAssignment(words[firstCmdIndex])) firstCmdIndex++;
		if (firstCmdIndex > 0 && firstCmdIndex < words.length) candidates.push(words.slice(firstCmdIndex).join(" "));
	}
	return candidates;
}
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string, segmenting: Segmenting): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalized = normalizeBashApprovalPattern(command);
	if (normalized.length === 0) return false;
	if (regex.test(normalized)) return true;
	return bashCommandSegments(command, segmenting).some((segment) => regex.test(segment));
}
function bashApprovalRuleMatches(command: string, rule: BashApprovalPatternRule, segmenting: Segmenting): boolean {
	if (rule.approval === "allow") {
		if (hasBashApprovalShellControl(command)) return false;
		return commandMatchesBashApprovalPattern(command, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match, segmenting);
}

function findNonCompoundBashRestrictionRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	segmenting: Segmenting,
): BashApprovalPatternRule | undefined {
	const segments = bashCommandSegments(command, segmenting);
	let promptRule: BashApprovalPatternRule | undefined;
	for (const rule of rules) {
		if (
			rule.approval !== "allow" &&
			commandMatchesBashApprovalPattern(command, rule.match) &&
			!segments.some((segment) => commandMatchesBashApprovalPattern(segment, rule.match))
		) {
			if (rule.approval === "deny") return rule;
			promptRule ??= rule;
		}
	}
	for (const segment of segments) {
		const segmentRule = rules.find((rule) => rule.approval !== "allow" && commandMatchesBashApprovalPattern(segment, rule.match));
		if (segmentRule?.approval === "deny") return segmentRule;
		if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
	}
	return promptRule;
}

function findBashApprovalPatternRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	segmenting: Segmenting,
): BashApprovalPatternRule | undefined {
	if (hasBashApprovalShellControl(command)) return findNonCompoundBashRestrictionRule(command, rules, segmenting);
	return rules.find((rule) => bashApprovalRuleMatches(command, rule, segmenting));
}

type PatternDecision =
	| { readonly kind: "deny"; readonly rule: BashApprovalPatternRule }
	| { readonly kind: "prompt"; readonly rule: BashApprovalPatternRule }
	| { readonly kind: "allow" }
	| { readonly kind: "unmatched" };

function resolveBashPatternDecision(
	command: string,
	compoundSegments: readonly LiteralShellCommandSegment[] | null,
	rules: readonly BashApprovalPatternRule[],
	segmenting: Segmenting,
): PatternDecision {
	if (compoundSegments) {
		let promptRule: BashApprovalPatternRule | undefined;
		for (const rule of rules) {
			if (
				rule.approval !== "allow" &&
				commandMatchesBashApprovalPattern(command, rule.match) &&
				!compoundSegments.some((segment) => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match, segmenting))
			) {
				if (rule.approval === "deny") return { kind: "deny", rule };
				promptRule ??= rule;
			}
		}
		let hasUnmatchedSegment = false;
		for (const segment of compoundSegments) {
			const segmentRule = findBashApprovalPatternRule(segment.text, rules, segmenting);
			if (segmentRule?.approval === "deny") return { kind: "deny", rule: segmentRule };
			if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
			if (!segmentRule) hasUnmatchedSegment = true;
		}
		if (promptRule) return { kind: "prompt", rule: promptRule };
		return hasUnmatchedSegment ? { kind: "unmatched" } : { kind: "allow" };
	}
	const patternRule = findBashApprovalPatternRule(command, rules, segmenting);
	if (patternRule?.approval === "deny") return { kind: "deny", rule: patternRule };
	if (patternRule?.approval === "prompt") return { kind: "prompt", rule: patternRule };
	if (patternRule?.approval === "allow") return { kind: "allow" };
	return { kind: "unmatched" };
}

export function approveCommand(
	command: string,
	views: BashPatternViews,
	shell: string | undefined,
	helpers: ApprovalHelpers,
): CommandApproval {
	const compoundSegments = shell && isPosixShell(shell) ? helpers.extractLiteralAndChainSegments(command) : null;
	const decision = resolveBashPatternDecision(command, compoundSegments, views.session, helpers);
	const authorityDecision = views.authority === views.session
		? decision
		: resolveBashPatternDecision(command, compoundSegments, views.authority, helpers);
	const denied = authorityDecision.kind === "deny" ? authorityDecision : decision.kind === "deny" ? decision : undefined;
	if (denied) {
		return { tier: "exec", override: true, policy: "deny", reason: `Blocked by bash pattern: ${denied.rule.match}` };
	}
	const prompted = authorityDecision.kind === "prompt" ? authorityDecision : decision.kind === "prompt" ? decision : undefined;
	if (prompted) {
		return { tier: "exec", override: true, policy: "prompt", reason: `Prompt required by bash pattern: ${prompted.rule.match}` };
	}
	const criticalCommand = command !== "" && helpers.criticalPatterns.some((pattern) => pattern.test(command));
	if (!compoundSegments && criticalCommand) return { tier: "exec", override: true, reason: "Critical pattern detected" };
	if (compoundSegments) {
		for (const segment of compoundSegments) {
			const literalCommand = segment.argv.join(" ");
			if (criticalCommand || helpers.criticalPatterns.some((pattern) => pattern.test(literalCommand))) {
				return { tier: "exec", override: true, reason: "Critical pattern detected" };
			}
		}
	}
	if (decision.kind === "allow") return { tier: "write", policy: "allow" };
	return "exec";
}

export function approvalCommand(args: unknown, fallback: string): string {
	return typeof args === "object" && args !== null && "cmd" in args && typeof args.cmd === "string" ? args.cmd : fallback;
}

export interface CommandApprovalHost extends SessionRegistry {
	readonly approvalRules: (settings: HostSettings) => readonly BashApprovalPatternRule[];
	readonly allowCompoundCommands: (settings: HostSettings) => boolean;
	readonly helpers: ApprovalHelpers;
}

export function approveBoundCommand(host: CommandApprovalHost, binding: HostBindingState, args: unknown): CommandApproval {
	if (binding.kind !== "bound") return "exec";
	const settings = binding.session.settings;
	const sessionRules = host.approvalRules(settings);
	const operatorSettings = settings.grantAuthority?.();
	const views: BashPatternViews = {
		session: sessionRules,
		authority: operatorSettings ? host.approvalRules(operatorSettings) : sessionRules,
	};
	const shell = host.allowCompoundCommands(settings) ? settings.getShellConfig().shell : undefined;
	return approveCommand(approvalCommand(args, ""), views, shell, host.helpers);
}

function exportedFunction<M extends object, K extends keyof M>(module: M, name: K, from: string): M[K] {
	const value = module[name];
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${String(name)}()`);
	return value;
}

function settingReader<T>(setting: Setting<T, string> | undefined, name: string): (scope: ScopeLike) => T {
	const get = setting?.get;
	if (typeof get !== "function") throw new Error(`omp-unified-exec: exec/settings lacks ${name}.get()`);
	return (scope) => get.call(setting, scope);
}

export async function loadCommandApprovalHost(): Promise<CommandApprovalHost> {
	const [root, execSettings, tokenizer, approval] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/exec/settings"),
		import("@oh-my-pi/pi-coding-agent/tools/shell-tokenize"),
		import("@oh-my-pi/pi-coding-agent/tools/approval"),
	]);
	const registryClass = root.AgentRegistry;
	const global = registryClass?.global;
	if (typeof registryClass !== "function" || typeof global !== "function") {
		throw new Error("omp-unified-exec: host lacks AgentRegistry.global()");
	}
	const registry = global.call(registryClass);
	const get = exportedFunction(registry, "get", "AgentRegistry");
	const patterns = settingReader(execSettings.cfgBashPatterns, "cfgBashPatterns");
	const compound = settingReader(execSettings.cfgBashAllowCompoundCommands, "cfgBashAllowCompoundCommands");
	const criticalPatterns = root.CRITICAL_BASH_PATTERNS;
	if (!Array.isArray(criticalPatterns) || !criticalPatterns.every((pattern: unknown) => pattern instanceof RegExp)) {
		throw new Error("omp-unified-exec: host lacks CRITICAL_BASH_PATTERNS");
	}
	return {
		get: (agentId) => get.call(registry, agentId),
		approvalRules: (sessionSettings) => getBashApprovalPatternRules(patterns(sessionSettings)),
		allowCompoundCommands: (sessionSettings) => {
			const value = compound(sessionSettings);
			if (typeof value !== "boolean") throw new Error("omp-unified-exec: bash.allowCompoundCommands must be boolean");
			return value;
		},
		helpers: {
			criticalPatterns,
			tokenizeShellSegments: exportedFunction(tokenizer, "tokenizeShellSegments", "tools/shell-tokenize"),
			isShellEnvironmentAssignment: exportedFunction(tokenizer, "isShellEnvironmentAssignment", "tools/shell-tokenize"),
			extractLiteralAndChainSegments: exportedFunction(tokenizer, "extractLiteralAndChainSegments", "tools/shell-tokenize"),
			truncateForPrompt: exportedFunction(approval, "truncateForPrompt", "tools/approval"),
		},
	};
}
