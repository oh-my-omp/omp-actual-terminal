export type LongWaitOutcome = "exit" | "deadline" | "cancelled";

export const MAX_TIMER_ARM_MS = 2_147_483_647;

export interface LongWaitInputs {
	exited: AbortSignal;
	externalAbort?: AbortSignal;
	durationMs: number;
	monotonicNow?: () => number;
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

export async function waitForExitOrDeadline(inputs: LongWaitInputs): Promise<LongWaitOutcome> {
	const { exited, externalAbort, durationMs } = inputs;
	const monotonicNow = inputs.monotonicNow ?? (() => performance.now());
	const setTimeoutFn = inputs.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
	const clearTimeoutFn = inputs.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));

	if (!Number.isFinite(durationMs) || Math.abs(durationMs) > Number.MAX_SAFE_INTEGER) {
		throw new Error("Wait duration must be finite and within the safe millisecond range.");
	}
	if (exited.aborted) return "exit";
	if (externalAbort?.aborted) return "cancelled";
	if (durationMs <= 0) return "deadline";

	const startedAt = monotonicNow();
	const remainingMs = () => durationMs - (monotonicNow() - startedAt);

	const cleanups: Array<() => void> = [];
	try {
		const exitP = new Promise<LongWaitOutcome>((resolve) => {
			const onAbort = () => resolve("exit");
			exited.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => exited.removeEventListener("abort", onAbort));
		});
		const cancelP: Promise<LongWaitOutcome> = externalAbort
			? new Promise((resolve) => {
					const onAbort = () => resolve("cancelled");
					externalAbort.addEventListener("abort", onAbort, { once: true });
					cleanups.push(() => externalAbort.removeEventListener("abort", onAbort));
				})
			: new Promise<never>(() => {});

		let timerHandle: unknown;
		cleanups.push(() => {
			if (timerHandle !== undefined) clearTimeoutFn(timerHandle);
		});
		const armTimer = (): Promise<void> =>
			new Promise<void>((resolve) => {
				const remaining = Math.max(1, remainingMs());
				const armMs = Math.min(remaining, MAX_TIMER_ARM_MS);
				timerHandle = setTimeoutFn(() => {
					timerHandle = undefined;
					resolve();
				}, armMs);
			});

		for (;;) {
			const which = await Promise.race([exitP, cancelP, armTimer().then(() => "timer" as const)]);
			if (which === "exit" || which === "cancelled") return which;
			if (remainingMs() <= 0) return "deadline";
			if (timerHandle !== undefined) {
				clearTimeoutFn(timerHandle);
				timerHandle = undefined;
			}
		}
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}
