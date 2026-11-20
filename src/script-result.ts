import type { MonitorStatus } from "../fork-features/monitor-subscription.ts";

export type MonitorScriptResult =
	| { session_id: number; status: "started"; monitor: MonitorStatus }
	| { session_id: number; status: "cancelled" | "not_monitored" }
	| { session_id: number; status: "error"; code: string; message: string };
