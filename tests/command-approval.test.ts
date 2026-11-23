import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	approveBoundCommand, approveCommand, getBashApprovalPatternRules, type ApprovalHelpers, type BashApprovalPatternRule,
	type BashPatternViews, type CommandApproval, type CommandApprovalHost,
} from "../fork-features/command-approval.ts";
import { bindSession, bindingContext, recheckBinding, type HostSettings } from "../fork-features/session-binding.ts";
import { activate } from "../src/index.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

const helpers: ApprovalHelpers = {
	criticalPatterns: [/rm -rf/],
	tokenizeShellSegments(command) {
		assert.ok(["true", "echo x", "rm -rf /", "ls"].includes(command), command);
		return [command.split(" ")];
	},
	isShellEnvironmentAssignment: (word) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(word),
	extractLiteralAndChainSegments(command) {
		assert.equal(command, "true && echo x");
		return [{ text: "true", argv: ["true"] }, { text: "echo x", argv: ["echo", "x"] }];
	},
	truncateForPrompt: (command) => command.slice(0, 40),
};

const single = (rules: readonly BashApprovalPatternRule[]): BashPatternViews => ({ session: rules, authority: rules });

function unusedSessionMember(): never {
	throw new Error("unused session-manager member");
}

const sessionManager = {
	getCwd: () => process.cwd(),
	getSessionId: () => "main",
	getSessionFile: () => undefined,
	getArtifactsDir: () => null,
	getUsageStatistics: () => ({
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		orchestrationInput: 0, orchestrationOutput: 0, orchestrationCacheRead: 0,
		premiumRequests: 0, cost: 0, subagentCost: 0,
	}),
};

function agentSessionStub() {
	return {
		instanceKey: "test:main",
		agent: { isPaused: false, state: { messages: [], streamMessage: null, pendingToolCalls: new Set<string>() } },
		sessionManager,
		isStreaming: false,
		runStartedAt: undefined,
		ircWakesPending: false,
		hasPendingWake: false,
		messages: [],
		sessionFile: undefined,
		model: undefined,
		thinkingLevel: undefined,
		servingModel: undefined,
		effectiveExtensionRoots: { explicit: [], mode: "merge" as const, configured: [], configuredLevel: "user" as const },
		hindsightActive: false,
		subscribe: unusedSessionMember,
		subscribeRunState: unusedSessionMember,
		getSessionStats: unusedSessionMember,
		getAdvisorStatusOverview: unusedSessionMember,
		getSessionAgents: unusedSessionMember,
		hasQueuedIrcFrom: unusedSessionMember,
		hasIrcInterrupts: unusedSessionMember,
		emitIrcRelayObservation: unusedSessionMember,
		deliverIrcMessage: unusedSessionMember,
		waitForIrcReplies: unusedSessionMember,
		prompt: unusedSessionMember,
		steer: unusedSessionMember,
		abort: unusedSessionMember,
		setWorkPoolYieldItems: unusedSessionMember,
		dispose: unusedSessionMember,
	};
}

const segmentHelpers: ApprovalHelpers = {
	criticalPatterns: [/rm -rf/, /git reset/],
	tokenizeShellSegments: (command) => command.split(/&&|\|\||;|\|/u)
		.map((segment) => segment.trim().split(/\s+/u).filter((word) => word.length > 0))
		.filter((words) => words.length > 0),
	isShellEnvironmentAssignment: (word) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(word),
	extractLiteralAndChainSegments: (command) => command.split("&&").map((text) => ({
		text: text.trim(), argv: text.trim().split(/\s+/u),
	})),
	truncateForPrompt: (command) => command,
};

interface RegisteredTool {
	readonly name: string;
	readonly approval?: (args: unknown) => CommandApproval;
	readonly formatApprovalDetails?: (args: unknown) => string[];
}

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function harness(host: CommandApprovalHost) {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, EventHandler[]>();
	const api = {
		registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
		on(name: string, handler: EventHandler) {
			const listeners = handlers.get(name) ?? [];
			listeners.push(handler);
			handlers.set(name, listeners);
		},
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {}, getFlag() { return false; },
	} as unknown as ExtensionAPI;
	activate(api, { shellPath: STUB_SHELL_PATH, approvalHost: host, shellHost: stubShellHost });
	const tool = tools.get("exec_command")!;
	assert.ok(tool.approval);
	assert.ok(tool.formatApprovalDetails);
	return {
		tool, tools,
		async emit(name: string, sessionManager: unknown, id = "main") {
			for (const handler of handlers.get(name) ?? []) {
				await handler({}, { agent: { id }, sessionManager, ui: { setStatus() {}, setWidget() {} } });
			}
		},
	};
}

describe("command approval port", () => {
	it("filters malformed rules and preserves order and normalization", () => {
		assert.deepEqual(getBashApprovalPatternRules([null, [], {}, { match: " ", approval: "deny" },
			{ match: "true", approval: "invalid" }, { match: " true  ", approval: " ALLOW " },
			{ match: "true", approval: "deny" }]), [
			{ match: "true", approval: "allow" }, { match: "true", approval: "deny" },
		]);
		assert.deepEqual(getBashApprovalPatternRules(undefined), []);
	});

	it("keeps first-match semantics rather than strictest-rule sorting", () => {
		for (const first of ["allow", "prompt", "deny"] as const) {
			const decision = approveCommand("true", single([{ match: "true", approval: first }, { match: "*", approval: "deny" }]), undefined, helpers);
			assert.equal(typeof decision === "object" && "policy" in decision ? decision.policy : decision, first);
		}
	});

	it("does not carry a standalone allow across shell control", () => {
		const literalHelpers = { ...helpers, tokenizeShellSegments: () => [["true"], ["echo", "x"]] };
		assert.equal(approveCommand("true && echo x", single([{ match: "true", approval: "allow" }]), undefined, literalHelpers), "exec");
	});

	it("aggregates whole-chain restrictions while preserving segment first matches", () => {
		const rules: BashApprovalPatternRule[] = [
			{ match: "true && echo x", approval: "prompt" },
			{ match: "true && echo x", approval: "deny" },
			{ match: "true", approval: "allow" }, { match: "echo x", approval: "allow" },
		];
		assert.deepEqual(approveCommand("true && echo x", single(rules), "/bin/zsh", helpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: true && echo x",
		});
		assert.equal(approveCommand("true && echo x", single(rules.slice(2, 3)), "/bin/zsh", helpers), "exec");
		assert.deepEqual(approveCommand("true && echo x", single(rules.slice(2)), "/bin/zsh", helpers), { tier: "write", policy: "allow" });
		assert.deepEqual(approveCommand("true && echo x", single([rules[0], ...rules.slice(2)]), "/bin/zsh", helpers), {
			tier: "exec", override: true, policy: "prompt", reason: "Prompt required by bash pattern: true && echo x",
		});
		assert.deepEqual(approveCommand("true && echo x", single([...rules.slice(2), { match: "true", approval: "deny" }]), "/bin/zsh", helpers), { tier: "write", policy: "allow" });
	});

	it("preserves deny and critical precedence, with an explicit prompt ahead of critical", () => {
		assert.deepEqual(approveCommand("rm -rf /", single([{ match: "*", approval: "deny" }]), undefined, helpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: *",
		});
		assert.deepEqual(approveCommand("rm -rf /", single([{ match: "*", approval: "prompt" }]), undefined, helpers), {
			tier: "exec", override: true, policy: "prompt", reason: "Prompt required by bash pattern: *",
		});
		assert.deepEqual(approveCommand("rm -rf /", single([]), undefined, helpers), {
			tier: "exec", override: true, reason: "Critical pattern detected",
		});
	});
});

describe("command approval host precedence", () => {
	const allowNpm: BashApprovalPatternRule = { match: "npm publish *", approval: "allow" };

	it("lets no project allow lift an operator deny or prompt, compound or not", () => {
		const deny = { match: "npm publish *", approval: "deny" } as const;
		const prompt = { match: "npm publish *", approval: "prompt" } as const;
		assert.deepEqual(approveCommand("npm publish pkg", { session: [allowNpm], authority: [deny] }, undefined, segmentHelpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: npm publish *",
		});
		assert.deepEqual(approveCommand("npm publish pkg", { session: [allowNpm], authority: [prompt] }, undefined, segmentHelpers), {
			tier: "exec", override: true, policy: "prompt", reason: "Prompt required by bash pattern: npm publish *",
		});
		assert.deepEqual(approveCommand("cd x && npm publish pkg", { session: [allowNpm], authority: [deny] }, "/bin/zsh", segmentHelpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: npm publish *",
		});
	});

	it("keeps a project allow effective when no operator layer restricts the command", () => {
		assert.deepEqual(approveCommand("npm publish pkg", { session: [allowNpm], authority: [] }, undefined, segmentHelpers), { tier: "write", policy: "allow" });
		assert.equal(approveCommand("npm publish pkg", { session: [], authority: [] }, undefined, segmentHelpers), "exec");
	});

	it("lets a later segment deny beat an earlier segment prompt on a line with shell control", () => {
		assert.deepEqual(approveCommand("cd x && rm -rf y", single([
			{ match: "cd *", approval: "prompt" }, { match: "rm -rf *", approval: "deny" },
		]), undefined, segmentHelpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: rm -rf *",
		});
	});

	it("judges an explicit prompt rule before a critical pattern", () => {
		assert.deepEqual(approveCommand("git reset --hard", single([{ match: "git reset *", approval: "prompt" }]), undefined, segmentHelpers), {
			tier: "exec", override: true, policy: "prompt", reason: "Prompt required by bash pattern: git reset *",
		});
	});

	it("matches restriction rules after leading environment assignments", () => {
		assert.deepEqual(approveCommand("FOO=1 npm publish pkg", single([{ match: "npm publish *", approval: "deny" }]), undefined, segmentHelpers), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: npm publish *",
		});
	});

	it("reads the operator layers from the bound session's grantAuthority view", () => {
		const session = Settings.isolated();
		const operator = session.grantAuthority();
		const rulesBySettings = new Map<HostSettings, readonly BashApprovalPatternRule[]>([
			[session, [allowNpm]], [operator, [{ match: "npm publish *", approval: "deny" }]],
		]);
		const host: CommandApprovalHost = {
			get: () => undefined,
			approvalRules: (settings) => rulesBySettings.get(settings) ?? [],
			allowCompoundCommands: () => false,
			helpers: segmentHelpers,
		};
		assert.deepEqual(approveBoundCommand(host, { kind: "bound", agentId: "main", session: { settings: session, sessionManager } }, { cmd: "npm publish pkg" }), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: npm publish *",
		});
	});
});

describe("approval session binding via activate", () => {
	it("pending and Unbound do not read settings, including dangerous commands", async () => {
		const host: CommandApprovalHost = {
			get: () => undefined,
			approvalRules() { throw new Error("must not read rules"); },
			allowCompoundCommands() { throw new Error("must not read compound setting"); }, helpers,
		};
		const h = harness(host);
		for (const phase of ["pending", "unbound"]) {
			assert.equal(h.tool.approval!({ cmd: "rm -rf /" }), "exec", phase);
			assert.equal(h.tool.approval!({ cmd: "true" }), "exec", phase);
			await h.emit("session_start", {});
		}
		for (const tool of h.tools.values()) if (tool.name !== "exec_command") {
			assert.equal(tool.approval, undefined, tool.name);
			assert.equal(tool.formatApprovalDetails, undefined, tool.name);
		}
		assert.deepEqual(h.tool.formatApprovalDetails!({ cmd: "rm -rf /definitely-not-here-uexec" }), ["Command: rm -rf /definitely-not-here-uexec"]);
		assert.deepEqual(h.tool.formatApprovalDetails!({}), ["Command: (missing)"]);
	});

	it("binds once, reads live settings, and only rechecks identity on switches/branches", async () => {
		const initial = Settings.isolated();
		const replacement = Settings.isolated();
		const compoundProbe: ApprovalHelpers = {
			...helpers,
			extractLiteralAndChainSegments() { throw new Error("compound disabled: no shell read"); },
		};
		const session = { ...agentSessionStub(), settings: initial };
		const ref: AgentRef = {
			id: "main", generation: 1, displayName: "main", kind: "sub", status: "idle",
			session, sessionFile: null, createdAt: 0, lastActivity: 0,
		};
		let lookups = 0;
		let rules: BashApprovalPatternRule[] = [{ match: "true", approval: "allow" }];
		const seen: HostSettings[] = [];
		const h = harness({
			get(id) { assert.equal(id, "main"); lookups++; return ref; },
			approvalRules(settings) { seen.push(settings); return rules; },
			allowCompoundCommands: () => false, helpers: compoundProbe,
		});
		await h.emit("session_start", sessionManager);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "write", policy: "allow" });
		assert.equal(seen[0], initial);
		rules = [{ match: "true", approval: "deny" }];
		Object.assign(session, { settings: replacement });
		await h.emit("session_switch", sessionManager);
		await h.emit("session_branch", sessionManager);
		await h.emit("session_start", sessionManager);
		assert.equal(lookups, 1);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: true" });
		assert.ok(seen.includes(replacement));
		await h.emit("session_branch", {});
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		await h.emit("session_switch", sessionManager);
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		assert.equal(lookups, 1);
	});

	it("rejects missing entries and mismatched managers without reading settings", () => {
		const session = {
			...agentSessionStub(),
			get settings() { throw new Error("must not read settings during bind"); },
		};
		const ref: AgentRef = {
			id: "main", generation: 1, displayName: "main", kind: "sub", status: "idle",
			session, sessionFile: null, createdAt: 0, lastActivity: 0,
		};
		const host = { get: () => ref };
		assert.deepEqual(bindSession(host, { agentId: undefined, sessionManager }), { kind: "unbound", reason: "no-registry-entry" });
		assert.deepEqual(bindSession(host, { agentId: "main", sessionManager: { ...sessionManager, getSessionId: () => "other" } }), { kind: "unbound", reason: "identity-mismatch" });
		const pending = { kind: "pending" } as const;
		assert.equal(recheckBinding(pending, { agentId: "main", sessionManager }), pending);
		const agent = { kind: "main", id: "main", name: "main", depth: 0 } as const;
		assert.deepEqual(bindingContext({ agent, sessionManager }), { agentId: "main", sessionManager });
	});
});
