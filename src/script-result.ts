import type { MonitorStatus } from "./monitor-subscription.ts";

export type MonitorScriptResult =
	| { job_id: string; status: "started"; monitor: MonitorStatus }
	| { job_id: string; status: "cancelled" | "not_monitored" }
	| { job_id: string; status: "error"; code: string; message: string };
