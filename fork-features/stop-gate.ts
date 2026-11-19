import type { TodoReadResult } from "./omomp-shared/todo-read.ts";
import { fillTemplate, type JudgePromptField, type StopConfig } from "./stop-config.ts";
import type { StopInput, StopVerdict } from "./terminal-notice.ts";
import type { ModelFailure } from "./stop-reasons.ts";

const DETECT_DEADLINE_MS = 30_000;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

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

interface HostModel {
	readonly provider: string;
	readonly id: string;
}

interface RoleCandidate {
	readonly model: HostModel;
	readonly thinkingLevel?: string;
}

export interface ChainJudge {
	primaryModel(): unknown;
	judge(request: unknown, options: { signal: AbortSignal }): Promise<unknown>;
}

interface AssistantReply {
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly content?: unknown;
}

export interface StopHost {
	readonly getAgentDir: () => string;
	readonly resolveJudge: (deps: unknown) => ChainJudge;
	readonly journalJudgmentUsage: (sessionManager: unknown) => unknown;
	readonly sharedJudgmentCache: () => unknown;
	readonly kindOf: (candidate: RoleCandidate) => string;
	readonly resolveRoleChain: (role: string, settings: unknown, pool: unknown) => readonly RoleCandidate[];
	readonly roleCandidatePool: (role: string, settings: unknown, registry: unknown) => unknown;
	readonly completeSimple: (model: HostModel, context: unknown, options: unknown) => Promise<AssistantReply>;
}

function functionOf(module: unknown, name: string, from: string): (...args: never[]) => unknown {
	const value: unknown = typeof module === "object" && module !== null ? Reflect.get(module, name) : undefined;
	if (typeof value !== "function") throw new Error(`omp-unified-exec: ${from} lacks ${name}`);
	return value as (...args: never[]) => unknown;
}

export async function loadStopHost(): Promise<StopHost> {
	const [agent, judgment, resolver, roles, ai] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent"),
		import("@oh-my-pi/pi-coding-agent/judgment"),
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-coding-agent/config/model-roles"),
		import("@oh-my-pi/pi-ai"),
	]);
	return {
		getAgentDir: functionOf(agent, "getAgentDir", "@oh-my-pi/pi-coding-agent") as StopHost["getAgentDir"],
		resolveJudge: functionOf(judgment, "resolveJudge", "judgment") as StopHost["resolveJudge"],
		journalJudgmentUsage: functionOf(judgment, "journalJudgmentUsage", "judgment") as StopHost["journalJudgmentUsage"],
		sharedJudgmentCache: functionOf(judgment, "sharedJudgmentCache", "judgment") as StopHost["sharedJudgmentCache"],
		kindOf: functionOf(judgment, "kindOf", "judgment") as StopHost["kindOf"],
		resolveRoleChain: functionOf(resolver, "resolveRoleChain", "config/model-resolver") as StopHost["resolveRoleChain"],
		roleCandidatePool: functionOf(roles, "roleCandidatePool", "config/model-roles") as StopHost["roleCandidatePool"],
		completeSimple: functionOf(ai, "completeSimple", "@oh-my-pi/pi-ai") as StopHost["completeSimple"],
	};
}

export interface DetectorSession {
	readonly settings: unknown;
	readonly sessionManager: unknown;
	readonly sessionId: string;
	readonly registry: { resolver(model: HostModel, sessionId?: string): unknown };
	readonly metadataForProvider: (provider: string) => unknown;
	readonly telemetry: unknown;
}

export function detectorSession(session: unknown): DetectorSession | undefined {
	if (typeof session !== "object" || session === null) return undefined;
	const registry: unknown = Reflect.get(session, "modelRegistry");
	const agent: unknown = Reflect.get(session, "agent");
	const sessionId: unknown = Reflect.get(session, "sessionId");
	if (typeof registry !== "object" || registry === null || typeof Reflect.get(registry, "resolver") !== "function") return undefined;
	if (typeof agent !== "object" || agent === null || typeof Reflect.get(agent, "metadataForProvider") !== "function") return undefined;
	if (typeof sessionId !== "string") return undefined;
	return {
		settings: Reflect.get(session, "settings"),
		sessionManager: Reflect.get(session, "sessionManager"),
		sessionId,
		registry: registry as DetectorSession["registry"],
		metadataForProvider: (provider) => (Reflect.get(agent, "metadataForProvider") as (p: string) => unknown).call(agent, provider),
		telemetry: Reflect.get(agent, "telemetry"),
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
			const { pending, in_progress, completed, abandoned, blocked } = todo.counts;
			if (pending + in_progress + completed + abandoned + blocked === 0) {
				return { kind: "undecided", cause: "unavailable", reason: { kind: "todo_empty" } };
			}
			return { kind: pending + in_progress + blocked === 0 ? "done" : "not_done", detector: "todo" };
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
			lines.push(`items: ${c.completed} completed, ${c.abandoned} abandoned, ${c.blocked} blocked, ${c.in_progress} in progress, ${c.pending} pending`);
			for (const item of todo.openItems) {
				lines.push(`open: ${item.phase}: ${item.title}${item.explanation === null ? "" : ` — ${item.explanation}`}`);
			}
			return lines.join("\n");
		}
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

export function parseLlmAnswer(text: string): "done" | "not_done" | undefined {
	const head = (text.trim().split("\n")[0] ?? "").replace(/^[`*\s]+|[`*\s.]+$/g, "").toUpperCase();
	if (head === "DONE") return "done";
	if (head === "NOT_DONE" || head === "NOT DONE") return "not_done";
	return undefined;
}

export function judgeChain(host: StopHost, session: DetectorSession, purpose: string): ChainJudge | undefined {
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

async function runJudge(chain: ChainJudge, prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const result = await chain.judge({
		state: prompt,
		questions: { finished: { type: "choice", instructions: JUDGE_INSTRUCTIONS, criteria: { done: DONE_CRITERION, not_done: NOT_DONE_CRITERION } } },
	}, { signal });
	const answers: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "answers") : undefined;
	const finished: unknown = typeof answers === "object" && answers !== null ? Reflect.get(answers, "finished") : undefined;
	const choice: unknown = typeof finished === "object" && finished !== null ? Reflect.get(finished, "choice") : undefined;
	if (choice === "done" || choice === "not_done") return { kind: choice, detector: "judge" };
	return { kind: "undecided", cause: "failed", reason: { kind: "judge_no_choice", payload: JSON.stringify(finished) } };
}

function smolModels(host: StopHost, session: DetectorSession): readonly RoleCandidate[] {
	const pool = host.roleCandidatePool("smol", session.settings, session.registry);
	return host.resolveRoleChain("smol", session.settings, pool).filter((candidate) => host.kindOf(candidate) === "online");
}

async function runLlm(host: StopHost, session: DetectorSession, models: readonly RoleCandidate[], prompt: string, signal: AbortSignal): Promise<StopVerdict> {
	const failures: ModelFailure[] = [];
	for (const { model, thinkingLevel } of models) {
		if (signal.aborted) return { kind: "undecided", cause: "failed", reason: { kind: "aborted" } };
		const label = `${model.provider}/${model.id}`;
		const apiKey = session.registry.resolver(model, session.sessionId);
		const effort: Effort = EFFORTS.find((level) => level === thinkingLevel) ?? "low";
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
	readonly session: () => unknown;
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
