import type { AsyncJobManagerApi } from "@oh-my-pi/pi-coding-agent/async/job-manager";

import { sanitizeOutputText } from "./output-safety.ts";
import { classifyReturn, NATURAL_ENDING, type ShellExit } from "./terminal-lifecycle.ts";
import type { TerminalSnapshot } from "./terminal-screen.ts";

/** A changed screen reaches the job's progress at most this often, so a flood of output is read once per interval. */
const SCREEN_REPORT_MS = 500;

/** The part of omp's job manager a terminal's job uses. */
export type TerminalJobs = Pick<AsyncJobManagerApi, "register" | "acknowledgeDeliveries" | "cancel">;

/** Where a session's terminals become jobs: the root's manager, owned by the root agent of the session's tree. */
export interface JobHost {
	readonly manager: TerminalJobs;
	readonly ownerId: string;
}

export interface TerminalJobSpec {
	/** What the jobs page lists the terminal as: its `title`. */
	readonly label: string;
	readonly command: string;
	readonly cwd: string;
	readonly pids: () => readonly number[];
	/** omp cancelled the job (jobs page, `/jobs kill`, `proc://<id>/kill`, the root's teardown): end the terminal as a person would. */
	readonly cancelled: () => void;
	/** The terminal's visible screen as parsed so far; undefined before it starts and after its screen is released. */
	readonly screen: () => TerminalSnapshot | undefined;
	/** The visible screen once every byte read so far is parsed, for the job's final text. */
	readonly settledScreen: () => Promise<TerminalSnapshot | undefined>;
}

type JobEnd = { readonly kind: "completed" } | { readonly kind: "failed"; readonly reason: string };

type ReportProgress = (text: string) => Promise<void>;

/** What omp's tray and jobs page show of a screen: its rows, sanitised, without trailing blanks. */
export function screenText(snapshot: TerminalSnapshot | undefined): string {
	if (snapshot === undefined) return "";
	const lines = snapshot.text.split("\n").map((line) => sanitizeOutputText(line).trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function withScreen(screen: string, ending: string): string {
	return screen === "" ? ending : `${screen}\n\n${ending}`;
}

type JobState =
	| { readonly kind: "running"; readonly settle: (end: JobEnd) => void }
	| { readonly kind: "ended_by_plugin"; readonly settle: (end: JobEnd) => void }
	| { readonly kind: "settled" };

/**
 * A terminal as an omp job. The job id is the terminal's only identity; the job ends when the
 * terminal returns, and its result is never delivered: terminals report through the plugin's notices.
 */
export class TerminalJob {
	private state: JobState;
	private reportTimer: ReturnType<typeof setTimeout> | undefined;
	private reported = "";

	private constructor(
		readonly id: string,
		private readonly manager: TerminalJobs,
		settle: (end: JobEnd) => void,
		private readonly report: ReportProgress | undefined,
		private readonly screen: () => TerminalSnapshot | undefined,
	) {
		this.state = { kind: "running", settle };
	}

	/** Registers the job; throws omp's own error when it refuses (for example the running-job limit). */
	static open(host: JobHost, spec: TerminalJobSpec): TerminalJob {
		const ended = Promise.withResolvers<JobEnd>();
		let job: TerminalJob | undefined;
		let report: ReportProgress | undefined;
		const id = host.manager.register("bash", spec.label, async ({ signal, reportProgress }) => {
			report = (text) => reportProgress(text);
			const onAbort = (): void => {
				// The plugin's own cancel already ends the terminal its own way.
				if (job?.state.kind !== "running") return;
				job.cancel();
				spec.cancelled();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			const end = await ended.promise;
			// Once settled, the jobs page shows this text: the last screen and how the terminal returned. The
			// tray shows a job's progress ahead of its result, so the progress becomes the same text.
			const screen = screenText(await spec.settledScreen());
			const text = end.kind === "completed"
				? withScreen(screen, "returned normally")
				: withScreen(screen, `returned abnormally (${end.reason})`);
			await reportProgress(text);
			if (end.kind === "failed") throw new Error(text);
			return text;
		}, {
			ownerId: host.ownerId,
			process: { command: spec.command, cwd: spec.cwd, pids: spec.pids },
		});
		host.manager.acknowledgeDeliveries([id]);
		job = new TerminalJob(id, host.manager, ended.resolve, report, spec.screen);
		return job;
	}

	/** The terminal's screen changed: omp's tray and jobs page show it within {@link SCREEN_REPORT_MS}. */
	screenChanged(): void {
		if (this.state.kind === "settled" || this.reportTimer !== undefined) return;
		this.reportTimer = setTimeout(() => {
			this.reportTimer = undefined;
			if (this.state.kind === "settled") return;
			const text = screenText(this.screen());
			if (text === this.reported) return;
			this.reported = text;
			void this.report?.(text);
		}, SCREEN_REPORT_MS);
		this.reportTimer.unref?.();
	}

	/**
	 * The plugin is ending the terminal (`kill_session`, a person's end, shutdown): once it returns, its job
	 * shows cancelled. Call before signalling it, so the job's abort never re-enters the end.
	 */
	cancel(): void {
		if (this.state.kind !== "running") return;
		this.state = { kind: "ended_by_plugin", settle: this.state.settle };
	}

	/** The terminal survived the plugin's end: its job keeps running. */
	killFailed(): void {
		if (this.state.kind !== "ended_by_plugin") return;
		this.state = { kind: "running", settle: this.state.settle };
	}

	/**
	 * The terminal returned: one that was ended on request shows cancelled and returned normally, as the
	 * plugin's own lifecycle counts it; otherwise exit 0 completes the job and anything else fails it.
	 */
	returned(exit: ShellExit, failureMessage: string | null): void {
		if (this.state.kind === "settled") return;
		const endedByPlugin = this.state.kind === "ended_by_plugin";
		const settle = this.state.settle;
		this.state = { kind: "settled" };
		clearTimeout(this.reportTimer);
		this.reportTimer = undefined;
		if (endedByPlugin) this.manager.cancel(this.id);
		const outcome = classifyReturn(exit, failureMessage, endedByPlugin ? { ...NATURAL_ENDING, killed: true } : NATURAL_ENDING);
		switch (outcome.kind) {
			case "normal": settle({ kind: "completed" }); return;
			case "abnormal": settle({ kind: "failed", reason: outcome.reason }); return;
		}
	}
}
