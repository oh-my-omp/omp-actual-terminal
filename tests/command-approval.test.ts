import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	approveBoundCommand, approveCommand, getBashApprovalPatternRules, type ApprovalHelpers, type BashApprovalPatternRule,
	type BashPatternViews, type CommandApproval, type CommandApprovalHost,
} from "../fork-features/command-approval.ts";
import { bindSession, bindingContext, recheckBinding, type BoundSession, type HostSettings } from "../fork-features/session-binding.ts";
import { activate } from "../src/index.ts";
import { STUB_SHELL_PATH, stubShellHost } from "./stub-shell.ts";

// Canned literal segments exercise the port's branches, not shell parsing or
// builtin parity. Real tokenizer and builtin comparisons run in real omp.
const helpers: ApprovalHelpers = {
	criticalPatterns: [/rm -rf/],
	tokenizeShellSegments(command) {
		assert.ok(["true", "echo x", "rm -rf /", "ls"].includes(command), command);
		return [command.split(" ")];
	},
	extractLiteralAndChainSegments(command) {
		assert.equal(command, "true && echo x");
		return [{ text: "true", argv: ["true"] }, { text: "echo x", argv: ["echo", "x"] }];
	},
	truncateForPrompt: (command) => command.slice(0, 40),
};

/** One view only: the session's rules are also the operator view, as when no operator layer exists. */
const single = (rules: readonly BashApprovalPatternRule[]): BashPatternViews => ({ session: rules, authority: rules });

// Splits on the separators the approval tests use; real tokenizer parity runs in real omp.
const segmentHelpers: ApprovalHelpers = {
	criticalPatterns: [/rm -rf/, /git reset/],
	tokenizeShellSegments: (command) => command.split(/&&|\|\||;|\|/u)
		.map((segment) => segment.trim().split(/\s+/u).filter((word) => word.length > 0))
		.filter((words) => words.length > 0),
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
	activate(api, undefined, STUB_SHELL_PATH, host, undefined, {}, undefined, undefined, undefined, stubShellHost);
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
		const operator: HostSettings = { getShellConfig: () => ({ shell: "/bin/bash" }) };
		const session: HostSettings = { getShellConfig: () => ({ shell: "/bin/bash" }), grantAuthority: () => operator };
		const rulesBySettings = new Map<HostSettings, readonly BashApprovalPatternRule[]>([
			[session, [allowNpm]], [operator, [{ match: "npm publish *", approval: "deny" }]],
		]);
		const host: CommandApprovalHost = {
			registeredSession: () => undefined,
			approvalRules: (settings) => rulesBySettings.get(settings) ?? [],
			allowCompoundCommands: () => false,
			helpers: segmentHelpers,
		};
		assert.deepEqual(approveBoundCommand(host, { kind: "bound", agentId: "main", session: { settings: session, sessionManager: {} } }, { cmd: "npm publish pkg" }), {
			tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: npm publish *",
		});
	});
});

describe("approval session binding via activate", () => {
	it("pending and Unbound do not read settings, including dangerous commands", async () => {
		// The formatted text is person-facing; pin the language so the assertions are about approval.
		const savedLanguage = process.env.OMOMP_LANG;
		process.env.OMOMP_LANG = "en";
		try {
			await runPendingAndUnbound();
		} finally {
			if (savedLanguage === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = savedLanguage;
		}
	});

	async function runPendingAndUnbound() {
		const host: CommandApprovalHost = {
			registeredSession: () => undefined,
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
	}

	it("binds once, reads live settings, and only rechecks identity on switches/branches", async () => {
		const manager = {};
		const initial = { getShellConfig() { throw new Error("compound disabled: no shell read"); } };
		const replacement = { getShellConfig() { return { shell: "/bin/zsh" }; } };
		const session: BoundSession = { settings: initial, sessionManager: manager };
		let lookups = 0;
		let rules: BashApprovalPatternRule[] = [{ match: "true", approval: "allow" }];
		let lastSettings: unknown;
		const h = harness({
			registeredSession(id) { assert.equal(id, "main"); lookups++; return { session }; },
			approvalRules(settings) { lastSettings = settings; return rules; },
			allowCompoundCommands: () => false, helpers,
		});
		await h.emit("session_start", manager);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "write", policy: "allow" });
		assert.equal(lastSettings, initial);
		rules = [{ match: "true", approval: "deny" }];
		Object.assign(session, { settings: replacement });
		await h.emit("session_switch", manager);
		await h.emit("session_branch", manager);
		await h.emit("session_start", manager);
		assert.equal(lookups, 1);
		assert.deepEqual(h.tool.approval!({ cmd: "true" }), { tier: "exec", override: true, policy: "deny", reason: "Blocked by bash pattern: true" });
		assert.equal(lastSettings, replacement);
		await h.emit("session_branch", {});
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		await h.emit("session_switch", manager);
		assert.equal(h.tool.approval!({ cmd: "true" }), "exec");
		assert.equal(lookups, 1);
	});

	it("rejects missing entries and mismatched managers without reading settings", () => {
		const manager = {};
		const session = { sessionManager: manager, get settings() { throw new Error("must not read settings during bind"); } };
		const host = { registeredSession: () => ({ session }) };
		assert.deepEqual(bindSession(host, { agentId: undefined, sessionManager: manager }), { kind: "unbound", reason: "no-registry-entry" });
		assert.deepEqual(bindSession(host, { agentId: "main", sessionManager: {} }), { kind: "unbound", reason: "identity-mismatch" });
		const pending = { kind: "pending" } as const;
		assert.equal(recheckBinding(pending, { agentId: "main", sessionManager: manager }), pending);
		assert.deepEqual(bindingContext({ agent: { id: "main" }, sessionManager: manager }), { agentId: "main", sessionManager: manager });
	});
});
