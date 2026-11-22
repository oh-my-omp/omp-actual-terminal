import manifest from "../package.json";
import type * as Loader from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";

export const PLUGIN_NAME = "omp-unified-exec";

export type PluginSettingsReader = (cwd: string) => Promise<Readonly<Record<string, unknown>>>;

export const GRACE_RECLAIM_KEY = "notice.graceReclaim";
export const STOP_KEY = "stop";
export const JUDGE_PROMPT_KEY = "judgePrompt";
export const NOTICE_TEMPLATE_KEY = "noticeTemplate";

export type SettingRead<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly key: string; readonly fallback: T };

export function parseGraceReclaim(settings: Readonly<Record<string, unknown>>): SettingRead<boolean> {
	const fallback = manifest.omp.settings[GRACE_RECLAIM_KEY].default;
	const raw = settings[GRACE_RECLAIM_KEY];
	if (raw === undefined) return { kind: "ok", value: fallback };
	return typeof raw === "boolean" ? { kind: "ok", value: raw } : { kind: "invalid", key: GRACE_RECLAIM_KEY, fallback };
}

export async function loadPluginSettingsReader(): Promise<PluginSettingsReader> {
	// `Partial` says what the guard below checks: the installed omp may not export `getPluginSettings`.
	const loader: Partial<typeof Loader> = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
	const getPluginSettings = loader.getPluginSettings;
	if (typeof getPluginSettings !== "function") {
		throw new Error("omp-unified-exec: extensibility/plugins/loader lacks getPluginSettings");
	}
	return async (cwd) => getPluginSettings(PLUGIN_NAME, cwd);
}
