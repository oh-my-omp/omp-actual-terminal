import { JUDGE_PROMPT_KEY, NOTICE_TEMPLATE_KEY, STOP_KEY, type PluginSettingsReader } from "./plugin-settings.ts";
import type { StopConfigReason } from "./stop-reasons.ts";

export type StopMode = "off" | "auto" | "judge" | "llm" | "todo";
const STOP_MODES: Readonly<Record<StopMode, true>> = { off: true, auto: true, judge: true, llm: true, todo: true };

export interface StopConfig {
	readonly mode: StopMode;
	readonly judgePrompt: string;
	readonly noticeTemplate: string;
}

export const JUDGE_PROMPT_FIELDS = ["last_response", "notices", "todo"] as const;
export type JudgePromptField = (typeof JUDGE_PROMPT_FIELDS)[number];
export const NOTICE_TEMPLATE_FIELDS = ["summary", "items", "instruction", "terminal_count", "notice_count"] as const;
export type NoticeTemplateField = (typeof NOTICE_TEMPLATE_FIELDS)[number];

export const DEFAULT_JUDGE_PROMPT = [
	"A coding agent stopped. Its final response, its todo list and the terminal notices that arrived for it follow.",
	"",
	"Final response:",
	"{last_response}",
	"",
	"Todo list:",
	"{todo}",
	"",
	"Pending terminal notices:",
	"{notices}",
].join("\n");

export const DEFAULT_NOTICE_TEMPLATE = "{summary}\n{items}\n{instruction}";

export const DEFAULT_STOP_CONFIG: StopConfig = {
	mode: "auto",
	judgePrompt: DEFAULT_JUDGE_PROMPT,
	noticeTemplate: DEFAULT_NOTICE_TEMPLATE,
};

export interface ConfigProblem {
	readonly path: string;
	readonly reason: StopConfigReason;
}

export interface StopConfigLoad {
	readonly config: StopConfig;
	readonly problems: readonly ConfigProblem[];
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function parseTemplate(value: unknown, key: string, fields: readonly string[]): { kind: "ok"; value: string } | { kind: "error"; reason: StopConfigReason } {
	if (typeof value !== "string" || value.trim().length === 0) return { kind: "error", reason: { kind: "invalid_template", key } };
	const unknown = [...value.matchAll(PLACEHOLDER)]
		.map((match) => match[1])
		.filter((name): name is string => name !== undefined && !fields.includes(name));
	if (unknown.length > 0) {
		return { kind: "error", reason: { kind: "unknown_placeholders", key, names: unknown, known: fields } };
	}
	return { kind: "ok", value };
}

export function parseStopSection(value: unknown): { kind: "ok"; config: StopConfig } | { kind: "error"; reason: StopConfigReason } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "error", reason: { kind: "non_mapping", scope: "section" } };
	const record = value as Record<string, unknown>;
	const extra = Object.keys(record).filter((key) => key !== STOP_KEY && key !== JUDGE_PROMPT_KEY && key !== NOTICE_TEMPLATE_KEY);
	if (extra.length > 0) return { kind: "error", reason: { kind: "unknown_keys", keys: extra } };
	let mode = DEFAULT_STOP_CONFIG.mode;
	if (record[STOP_KEY] !== undefined) {
		if (typeof record[STOP_KEY] !== "string" || !Object.hasOwn(STOP_MODES, record[STOP_KEY])) {
			return { kind: "error", reason: { kind: "invalid_stop", modes: Object.keys(STOP_MODES) } };
		}
		mode = record[STOP_KEY] as StopMode;
	}
	let judgePrompt = DEFAULT_STOP_CONFIG.judgePrompt;
	if (record[JUDGE_PROMPT_KEY] !== undefined) {
		const parsed = parseTemplate(record[JUDGE_PROMPT_KEY], JUDGE_PROMPT_KEY, JUDGE_PROMPT_FIELDS);
		if (parsed.kind === "error") return parsed;
		judgePrompt = parsed.value;
	}
	let noticeTemplate = DEFAULT_STOP_CONFIG.noticeTemplate;
	if (record[NOTICE_TEMPLATE_KEY] !== undefined) {
		const parsed = parseTemplate(record[NOTICE_TEMPLATE_KEY], NOTICE_TEMPLATE_KEY, NOTICE_TEMPLATE_FIELDS);
		if (parsed.kind === "error") return parsed;
		noticeTemplate = parsed.value;
	}
	return { kind: "ok", config: { mode, judgePrompt, noticeTemplate } };
}

export function parseStopSettings(settings: Readonly<Record<string, unknown>>): StopConfigLoad {
	const section: Record<string, unknown> = {};
	if (settings[STOP_KEY] !== undefined) section[STOP_KEY] = settings[STOP_KEY];
	if (settings[JUDGE_PROMPT_KEY] !== undefined) section[JUDGE_PROMPT_KEY] = settings[JUDGE_PROMPT_KEY];
	if (settings[NOTICE_TEMPLATE_KEY] !== undefined) section[NOTICE_TEMPLATE_KEY] = settings[NOTICE_TEMPLATE_KEY];
	const parsed = parseStopSection(section);
	if (parsed.kind === "ok") return { config: parsed.config, problems: [] };
	return { config: DEFAULT_STOP_CONFIG, problems: [{ path: "plugin-settings", reason: parsed.reason }] };
}

export function fillTemplate<K extends string>(template: string, values: Readonly<Record<K, string>>): string {
	return template.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? values[name as K] : whole));
}

export async function loadStopConfig(pluginSettings: PluginSettingsReader | undefined, cwd: string): Promise<StopConfigLoad> {
	if (!pluginSettings) return { config: DEFAULT_STOP_CONFIG, problems: [] };
	let raw: Readonly<Record<string, unknown>>;
	try {
		raw = await pluginSettings(cwd);
	} catch (error) {
		return {
			config: DEFAULT_STOP_CONFIG,
			problems: [{ path: "plugin-settings", reason: { kind: "parse_error", detail: error instanceof Error ? error.message : String(error) } }],
		};
	}
	return parseStopSettings(raw);
}
