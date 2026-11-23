import type { TodoReadResult } from "./omomp-shared/todo-read.ts";
import { fillTemplate, type JudgePromptField, type StopConfig } from "./stop-config.ts";
import type { StopInput, StopVerdict } from "./terminal-notice.ts";
import type { ModelFailure } from "./stop-reasons.ts";
import type { BoundSession } from "./session-binding.ts";

import type * as AgentRoot from "@oh-my-pi/pi-coding-agent";
import type * as Judgment from "@oh-my-pi/pi-coding-agent/judgment";
import type * as ModelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import type * as ModelRoles from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type * as PiAi from "@oh-my-pi/pi-ai";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

const DETECT_DEADLINE_MS = 30_000;

const JUDGE_INSTRUCTIONS =
	"The state holds a coding agent's final response before it stopped, its todo list and the terminal notices waiting for it. Decide whether the response shows the task it was given is completely finished, so nothing in the notices needs the agent.";
const DONE_CRITERION = "The response reports the work finished and delivered, with nothing left to do, verify or wait for.";
const NOT_DONE_CRITERION =
	"The response says work remains, plans further steps, waits for a terminal, background job or the user, reports a failure it has not resolved, or is cut off.";
const LLM_SYSTEM_PROMPT = [
	"You decide whether a coding agent has completely finished its task, from its final response before it stopped.",
	`DONE: ${DONE_CRITERION}`,
	`NOT_DONE: ${NOT_DONE_CRITERION}`,
	"Answer with exactly DONE or NOT_DONE on the first line; one short reason may follow on the next line.",
].join("\n");

export interface StopHost {
	readonly getAgentDir: typeof AgentRoot.getAgentDir;
	readonly resolveJudge: typeof Judgment.resolveJudge;
	readonly journalJudgmentUsage: typeof Judgment.journalJudgmentUsage;
	readonly sharedJudgmentCache: typeof Judgment.sharedJudgmentCache;
	readonly kindOf: typeof Judgment.kindOf;
	readonly resolveRoleChain: typeof ModelResolver.resolveRoleChain;
	readonly roleCandidatePool: typeof ModelRoles.roleCandidatePool;
	readonly completeSimple: typeof PiAi.completeSimple;
	readonly thinkingLevels: typeof PiAi.THINKING_EFFORTS;
}

function hostFunction<T>(value: T | undefined, name: string, from: string): T {
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}`);
	return value;
}

export async function loadStopHost(): Promise<StopHost> {
	const [agent, judgment, resolver, roles, ai] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-coding-agent/config/model-roles"),
		import("@oh-my-pi/pi-ai"),
	]);
	const thinkingLevels = ai.THINKING_EFFORTS;
	if (!Array.isArray(thinkingLevels)) {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-ai lacks THINKING_EFFORTS");
	}
	return {
		getAgentDir: hostFunction(agent.getAgentDir, "getAgentDir", "@oh-my-pi/pi-coding-agent"),
		resolveJudge: hostFunction(judgment.resolveJudge, "resolveJudge", "judgment"),
		journalJudgmentUsage: hostFunction(judgment.journalJudgmentUsage, "journalJudgmentUsage", "judgment"),
		sharedJudgmentCache: hostFunction(judgment.sharedJudgmentCache, "sharedJudgmentCache", "judgment"),
		kindOf: hostFunction(judgment.kindOf, "kindOf", "judgment"),
		resolveRoleChain: hostFunction(resolver.resolveRoleChain, "resolveRoleChain", "config/model-resolver"),
		roleCandidatePool: hostFunction(roles.roleCandidatePool, "roleCandidatePool", "config/model-roles"),
		completeSimple: hostFunction(ai.completeSimple, "completeSimple", "@oh-my-pi/pi-ai"),
		thinkingLevels,
	};
}

export interface DetectorSession {
	readonly settings: AgentRoot.Settings;
	readonly sessionManager: BoundSession["sessionManager"];
	readonly sessionId: string;
	readonly registry: ModelRegistry;
	readonly metadataForProvider: Agent["metadataForProvider"];
	readonly telemetry: Agent["telemetry"];
}

type SessionExtras = {
	readonly sessionId: string;
	readonly modelRegistry: ModelRegistry;
	readonly agent: Pick<Agent, "metadataForProvider" | "telemetry">;
};

export function detectorSession(session: (BoundSession & Partial<SessionExtras>) | undefined): DetectorSession | undefined {
	if (session === undefined) return undefined;
	const { sessionId, modelRegistry, agent } = session;
	if (typeof sessionId !== "string") return undefined;
	if (typeof modelRegistry?.resolver !== "function") return undefined;
	if (typeof agent?.metadataForProvider !== "function") return undefined;
	return {
		settings: session.settings,
		sessionManager: session.sessionManager,
		sessionId,
		registry: modelRegistry,
		metadataForProvider: (provider) => agent.metadataForProvider(provider),
		telemetry: agent.telemetry,
	};
}

export function todoVerdict(todo: TodoReadResult): StopVerdict {
	switch (todo.kind) {
		case "unavailable":
		case "no_reply":
			return { kind: "undecided", cause: "unavailable", reason: { kind: "todo_unavailable" } };
		case "malformed":
			return { kind: "undecided", cause: "unavailable", reason: { kind: "todo_malformed", detail: todo.reason } };
		case "ok": {
			const { pending, in_progress, completed, abandoned } = todo.counts;
			if (pending + in_progress + completed + abandoned === 0) {
				return { kind: "undecided", cause: "unavailable", reason: { kind: "todo_empty" } };
			}
			return { kind: pending + in_progress === 0 ? "done" : "not_done", detector: "todo" };
		}
	}
}

function todoText(todo: TodoReadResult): string {
	switch (todo.kind) {
		case "unavailable":
		case "no_reply":
			return "(unavailable)";
		case "malformed":
			return `(malformed reply: ${todo.reason})`;
		case "ok": {
			const lines: string[] = [];
			if (todo.goal !== null) {
				lines.push(`objective: ${todo.goal.objective}`);
				lines.push(`measure: ${todo.goal.measure}`);
				lines.push(`done when: ${todo.goal.doneWhen}`);
			}
			const c = todo.counts;
			lines.push(`items: ${c.completed} completed, ${c.abandoned} abandoned, ${c.in_progress} in progress, ${c.pending} pending`);
			for (const item of todo.openItems) {
				lines.push(`open: ${item.phase}: ${item.title}${item.explanation === null ? "" : ` — ${item.explanation}`}`);
			}
			return lines.join("\n");
		}
	}
}

function isTextBlock(block: PiAi.AssistantMessage["content"][number]): block is PiAi.TextContent {
	return block.type === "text";
}

function textOf(content: PiAi.AssistantMessage["content"]): string {
	return content.filter(isTextBlock).map((block) => block.text).join("");
}

export function parseLlmAnswer(text: string): "done" | "not_done" | undefined {
	const head = (text.trim().split("\n")[0] ?? "").replace(/^[`*\s]+|[`*\s.]+$/g, "").toUpperCase();
	if (head === "DONE") return "done";
	if (head === "NOT_DONE" || head === "NOT DONE") return "not_done";
	return undefined;
}

export function judgeChain(host: StopHost, session: DetectorSession, purpose: string): Judgment.ChainJudge | undefined {
	const chain = host.resolveJudge({
		settings: session.settings,
		registry: session.registry,
		sessionId: session.sessionId,
		metadataResolver: session.metadataForProvider,
		purpose,
		onUsage: host.journalJudgmentUsage(session.sessionManager),
		telemetry: session.telemetry,
		cache: host.sharedJudgmentCache(),
	});
	return chain.primaryModel() === undefined ? undefined : chain;
}

async function runJudge(chain: Judgment.ChainJudge, prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const result = await chain.judge({
		state: prompt,
		questions: { finished: { type: "choice", instructions: JUDGE_INSTRUCTIONS, criteria: { done: DONE_CRITERION, not_done: NOT_DONE_CRITERION } } },
	}, { signal });
	const finished = result.answers.finished;
	if (finished.choice === "done" || finished.choice === "not_done") return { kind: finished.choice, detector: "judge" };
	return { kind: "undecided", cause: "failed", reason: { kind: "judge_no_choice", payload: JSON.stringify(finished) } };
}

function defaultEffort(levels: typeof PiAi.THINKING_EFFORTS): PiAi.Effort {
	const low = levels.find((level) => String(level) === "low");
	if (low === undefined) {
		throw new Error("omp-unified-exec: @oh-my-pi/pi-ai offers no low thinking level; requalify fork-features/stop-gate.ts for this omp version");
	}
	return low;
}

function smolModels(host: StopHost, session: DetectorSession): readonly ModelResolver.RoleChainCandidate[] {
	const pool = host.roleCandidatePool("smol", session.settings, session.registry);
	return host.resolveRoleChain("smol", session.settings, pool).filter((candidate) => host.kindOf(candidate) === "online");
}

async function runLlm(host: StopHost, session: DetectorSession, models: readonly ModelResolver.RoleChainCandidate[], prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const failures: ModelFailure[] = [];
	for (const { model, thinkingLevel } of models) {
		if (signal.aborted) return { kind: "undecided", cause: "failed", reason: { kind: "aborted" } };
		const label = `${model.provider}/${model.id}`;
		const apiKey = session.registry.resolver(model, session.sessionId);
		const effort = host.thinkingLevels.find((level) => level === thinkingLevel) ?? defaultEffort(host.thinkingLevels);
		try {
			const reply = await host.completeSimple(
				model,
				{ systemPrompt: [LLM_SYSTEM_PROMPT], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
				thinkingLevel === "off" ? { apiKey, disableReasoning: true, signal } : { apiKey, reasoning: effort, signal },
			);
			if (reply.stopReason === "aborted") return { kind: "undecided", cause: "failed", reason: { kind: "aborted" } };
			if (reply.stopReason === "error") {
				failures.push(reply.errorMessage === undefined ? { kind: "error", model: label } : { kind: "external_error", model: label, detail: reply.errorMessage });
				continue;
			}
			const answer = parseLlmAnswer(textOf(reply.content));
			if (answer !== undefined) return { kind: answer, detector: "llm" };
			failures.push({ kind: "unparseable_answer", model: label });
		} catch (error) {
			if (signal.aborted) return { kind: "undecided", cause: "failed", reason: { kind: "aborted" } };
			failures.push({ kind: "external_error", model: label, detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return { kind: "undecided", cause: "failed", reason: { kind: "models_failed", failures } };
}

export interface StopDetectorDeps {
	readonly host: StopHost;
	readonly session: () => BoundSession | undefined;
	readonly readTodo: () => TodoReadResult;
}

export async function detectStop(deps: StopDetectorDeps, config: StopConfig, input: StopInput, signal: AbortSignal): Promise<StopVerdict> {
	if (config.mode === "off") return { kind: "undecided", cause: "unavailable", reason: { kind: "off" } };
	const todo = deps.readTodo();
	const prompt = fillTemplate<JudgePromptField>(config.judgePrompt, { last_response: input.lastResponse, notices: input.notices, todo: todoText(todo) });
	if (config.mode === "todo") return todoVerdict(todo);
	const session = detectorSession(deps.session());
	if (session === undefined) return { kind: "undecided", cause: "unavailable", reason: { kind: "no_session" } };
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(DETECT_DEADLINE_MS)]);
	const judge = config.mode === "llm" ? undefined : judgeChain(deps.host, session, "unified-exec-stop");
	if (judge !== undefined) return runJudge(judge, prompt, deadline);
	if (config.mode === "judge") return { kind: "undecided", cause: "unavailable", reason: { kind: "no_judge" } };
	const models = smolModels(deps.host, session);
	if (models.length > 0) return runLlm(deps.host, session, models, prompt, deadline);
	if (config.mode === "llm") return { kind: "undecided", cause: "unavailable", reason: { kind: "no_smol" } };
	return todoVerdict(todo);
}
