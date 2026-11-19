import manifest from "../package.json";

export const PLUGIN_NAME = "omp-unified-exec";

export type PluginSettingsReader = (cwd: string) => Promise<Readonly<Record<string, unknown>>>;

export const GRACE_RECLAIM_KEY = "notice.graceReclaim";

export type SettingRead<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "invalid"; readonly key: string; readonly fallback: T };

export function parseGraceReclaim(settings: Readonly<Record<string, unknown>>): SettingRead<boolean> {
	const fallback = manifest.omp.settings[GRACE_RECLAIM_KEY].default;
	const raw = settings[GRACE_RECLAIM_KEY];
	if (raw === undefined) return { kind: "ok", value: fallback };
	return typeof raw === "boolean" ? { kind: "ok", value: raw } : { kind: "invalid", key: GRACE_RECLAIM_KEY, fallback };
}

export async function loadPluginSettingsReader(): Promise<PluginSettingsReader> {
	const module: unknown = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
	if (typeof module !== "object" || module === null ||
		!("getPluginSettings" in module) || typeof module.getPluginSettings !== "function") {
		throw new Error("omp-unified-exec: extensibility/plugins/loader lacks getPluginSettings");
	}
	const getPluginSettings = module.getPluginSettings as (plugin: string, cwd: string) => Promise<unknown>;
	return async (cwd) => {
		const value = await getPluginSettings(PLUGIN_NAME, cwd);
		if (typeof value !== "object" || value === null) throw new Error("omp-unified-exec: getPluginSettings returned no settings object");
		return value as Readonly<Record<string, unknown>>;
	};
}
