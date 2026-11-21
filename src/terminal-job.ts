import type { AsyncJobManagerApi } from "@oh-my-pi/pi-coding-agent/async/job-manager";

import { classifyReturn, NATURAL_ENDING, type ShellExit } from "./terminal-lifecycle.ts";

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
}

type JobEnd = { readonly kind: "completed" } | { readonly kind: "failed"; readonly reason: string };

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

	private constructor(readonly id: string, private readonly manager: TerminalJobs, settle: (end: JobEnd) => void) {
		this.state = { kind: "running", settle };
	}

	/** Registers the job; throws omp's own error when it refuses (for example the running-job limit). */
	static open(host: JobHost, spec: TerminalJobSpec): TerminalJob {
		const ended = Promise.withResolvers<JobEnd>();
		let job: TerminalJob | undefined;
		const id = host.manager.register("bash", spec.label, async ({ signal }) => {
			const onAbort = (): void => {
				// The plugin's own cancel already ends the terminal its own way.
				if (job?.state.kind === "running") spec.cancelled();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			const end = await ended.promise;
			switch (end.kind) {
				case "completed": return "returned normally";
				case "failed": throw new Error(`returned abnormally (${end.reason})`);
			}
		}, {
			ownerId: host.ownerId,
			process: { command: spec.command, cwd: spec.cwd, pids: spec.pids },
		});
		host.manager.acknowledgeDeliveries([id]);
		job = new TerminalJob(id, host.manager, ended.resolve);
		return job;
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
	 * The terminal returned: one the plugin ended shows cancelled; otherwise exit 0 completes the job and
	 * anything else fails it. A job omp already cancelled keeps that status.
	 */
	returned(exit: ShellExit, failureMessage: string | null): void {
		if (this.state.kind === "settled") return;
		const endedByPlugin = this.state.kind === "ended_by_plugin";
		const settle = this.state.settle;
		this.state = { kind: "settled" };
		if (endedByPlugin) this.manager.cancel(this.id);
		const outcome = classifyReturn(exit, failureMessage, NATURAL_ENDING);
		switch (outcome.kind) {
			case "normal": settle({ kind: "completed" }); return;
			case "abnormal": settle({ kind: "failed", reason: outcome.reason }); return;
		}
	}
}
