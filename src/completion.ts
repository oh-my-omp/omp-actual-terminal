import type { InputWaitAlert } from "./input-wait.ts";
import { MonitorError, MonitorSubscription, parseMonitorCondition, parseRemindAfter, type MonitorEndReason, type MonitorSession, type MonitorStatus } from "./monitor-subscription.ts";
import type { ScreenJudge } from "./screen-judge.ts";
import type { NoticeDispatcher, TerminalNotice } from "./terminal-notice.ts";


export type OnExitPolicy = "none" | "wake";

export interface CompletionSessionLike {
	readonly id: number;
	readonly title: string;
	readonly displayCommand: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly logPath: string | undefined;
	readonly terminalUrl?: string;
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage: string | null;
	onExit(listener: (session: unknown) => void): () => void;
}

export interface CompletionSnapshot {
	sessionId: number;
	title: string;
	command: string;
	cwd: string;
	startedAtMs: number;
	elapsedMs: number;
	exitCode: number | null;
	signal: string | null;
	failureMessage: string | null;
	logPath: string | undefined;
	terminalUrl?: string;
}

interface CompletionRecord {
	sessionId: number;
	armed: boolean;
	exited: boolean;
	observed: boolean;
	suppressed: boolean;
	wakeQueued: boolean;
	observers: Set<string>;
	pendingTerminal: Set<string>;
	snapshot: CompletionSnapshot | undefined;
	session: CompletionSessionLike;
	unsubscribeExit: () => void;
}


export interface CompletionCoordinatorOptions {
	notices: NoticeDispatcher;
	judge?: () => ScreenJudge | undefined;
	debounceMs?: number;
	setTimeoutFn?: (cb: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	nowFn?: () => number;
}

export interface MonitorOptions {
	condition?: string;
	judge?: string;
	judgeIntervalMs?: number;
	maxReturns?: number;
	remindAfterMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function sanitizeMeta(raw: string): string {
	// eslint-disable-next-line no-control-regex
	return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class CompletionCoordinator {
	private readonly records = new Map<number, CompletionRecord>();
	private monitors = new Map<number, MonitorSubscription>();
	private readonly opts: Required<Pick<CompletionCoordinatorOptions, "notices" | "debounceMs">> & CompletionCoordinatorOptions;
	private debounceHandle: unknown;
	private stopped = false;

	constructor(options: CompletionCoordinatorOptions) {
		this.opts = { debounceMs: DEFAULT_DEBOUNCE_MS, ...options };
	}

	private now(): number {
		return this.opts.nowFn ? this.opts.nowFn() : Date.now();
	}

	private setTimer(cb: () => void, ms: number): unknown {
		return this.opts.setTimeoutFn ? this.opts.setTimeoutFn(cb, ms) : setTimeout(cb, ms);
	}

	private clearTimer(handle: unknown): void {
		if (this.opts.clearTimeoutFn) this.opts.clearTimeoutFn(handle);
		else clearTimeout(handle as NodeJS.Timeout);
	}

	get recordCount(): number {
		return this.records.size;
	}

	async startMonitor(session: MonitorSession, options: MonitorOptions = {}, signal?: AbortSignal): Promise<MonitorStatus> {
		const condition = parseMonitorCondition(options);
		const maximum = options.maxReturns ?? 10;
		if (!Number.isSafeInteger(maximum) || maximum < 1) throw new MonitorError("invalid_max_returns", "max_returns must be a positive safe integer");
		const remindAfterMs = parseRemindAfter(options.remindAfterMs);
		const judge = this.opts.judge ?? (() => undefined);
		if (condition.kind === "judge" && judge()?.available() !== true) {
			throw new MonitorError("judge_unavailable", "no judge model resolves for this session");
		}
		const notices = this.opts.notices;
		const send = (notice: TerminalNotice, isCurrent: () => boolean) => notices.submit(notice, isCurrent);
		const scope = this.monitors;
		const current = (subscription: MonitorSubscription): boolean => !this.stopped && this.monitors === scope && scope.get(session.id) === subscription;
		const subscription = new MonitorSubscription(session, condition, maximum, remindAfterMs, judge, send,
			(sub, completed) => {
				if (!current(sub)) return;
				if (completed) {
					const record = this.records.get(session.id);
					if (record) this.resolveRecord(record);
				}
				scope.delete(session.id);
				sub.cancel();
				this.scheduleFlush();
			},
			current);
		const result = await session.subscribeMonitor(subscription, (handle) => {
			if (this.stopped || this.monitors !== scope || signal?.aborted) return false;
			subscription.attach(handle);
			const old = scope.get(session.id);
			scope.set(session.id, subscription);
			old?.cancel();
			subscription.begin();
			return true;
		}, signal);
		if (result !== "accepted") {
			subscription.cancel();
			throw new MonitorError(result === "not_running" ? "session_not_running" : "monitor_cancelled",
				result === "not_running" ? "session is no longer running" : "monitor establishment was cancelled");
		}
		if (signal?.aborted) {
			if (current(subscription)) {
				scope.delete(session.id);
				this.scheduleFlush();
			}
			subscription.cancel();
			throw new MonitorError("monitor_cancelled", "monitor establishment was cancelled");
		}
		return subscription.status();
	}

	monitorStatus(sessionId: number): MonitorStatus | undefined { return this.monitors.get(sessionId)?.status(); }

	cancelMonitor(sessionId: number): boolean {
		const subscription = this.monitors.get(sessionId);
		if (!subscription) return false;
		this.monitors.delete(sessionId);
		subscription.cancel();
		this.scheduleFlush();
		return true;
	}

	monitorEndReason(sessionId: number, reason: MonitorEndReason): void {
		this.monitors.get(sessionId)?.setEndReason(reason);
	}

	alertInputWait(alert: InputWaitAlert): void {
		if (this.stopped) return;
		void this.opts.notices.submit(alert.notice, () => !this.stopped && alert.current());
	}

	/**
	 * Call ONLY once a bash pty call has
	 * committed to returning a background session_id.
	 */
	register(session: CompletionSessionLike): void {
		if (this.stopped) return;
		if (this.records.has(session.id)) return;
		const record: CompletionRecord = {
			sessionId: session.id,
			armed: true,
			exited: false,
			observed: false,
			suppressed: false,
			wakeQueued: false,
			observers: new Set(),
			pendingTerminal: new Set(),
			snapshot: undefined,
			session,
			unsubscribeExit: () => {},
		};
		this.records.set(session.id, record);
		record.unsubscribeExit = session.onExit(() => this.recordExit(record));
	}

	isArmed(sessionId: number): boolean {
		const r = this.records.get(sessionId);
		return !!r && r.armed && !r.observed && !r.suppressed;
	}

	/**
	 * Disarm cannot recall a follow-up that `send` has already handed to pi.
	 */
	setOnExit(
		sessionId: number,
		policy: OnExitPolicy,
		session?: CompletionSessionLike | null,
	): "disarmed" | "already_none" | "armed" | "already_armed" | "too_late" {
		if (this.stopped) return policy === "wake" ? "too_late" : "already_none";
		const existing = this.records.get(sessionId);

		if (policy === "none") {
			if (!existing) return "already_none";
			existing.suppressed = true;
			this.resolveRecord(existing);
			return "disarmed";
		}

		if (existing) {
			if (existing.observed || existing.suppressed) return "too_late";
			return "already_armed";
		}
		if (!session || session.id !== sessionId || session.hasExited) return "too_late";
		this.register(session);
		return "armed";
	}

	private recordExit(record: CompletionRecord): void {
		// Repeated exit callbacks must never create duplicate wakes: the exited
		// flag latches and the snapshot is captured once.
		if (record.exited) return;
		record.exited = true;
		const s = record.session;
		record.snapshot = {
			sessionId: s.id,
			title: s.title,
			command: s.displayCommand,
			cwd: s.cwd,
			startedAtMs: s.startedAt,
			elapsedMs: this.now() - s.startedAt,
			exitCode: s.exitCode,
			signal: s.signal,
			failureMessage: s.failureMessage,
			logPath: s.logPath,
			terminalUrl: s.terminalUrl,
		};
		this.scheduleFlush();
	}


	beginObservation(sessionId: number, toolCallId: string): void {
		this.records.get(sessionId)?.observers.add(toolCallId);
	}

	releaseObservation(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.delete(toolCallId);
		r.pendingTerminal.delete(toolCallId);
		if (r.exited) this.scheduleFlush();
	}

	markPendingTerminal(sessionId: number, toolCallId: string): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.observers.add(toolCallId);
		r.pendingTerminal.add(toolCallId);
	}

	handleToolExecutionEnd(toolCallId: string, isError: boolean): void {
		for (const r of this.records.values()) {
			if (r.pendingTerminal.has(toolCallId)) {
				r.pendingTerminal.delete(toolCallId);
				r.observers.delete(toolCallId);
				if (!isError) {
					this.commitObserved(r);
				} else if (r.exited) {
					this.scheduleFlush();
				}
			} else if (r.observers.has(toolCallId)) {
				r.observers.delete(toolCallId);
				if (r.exited) this.scheduleFlush();
			}
		}
		this.flushPending();
	}

	private commitObserved(record: CompletionRecord): void {
		record.observed = true;
		this.resolveRecord(record);
	}

	observeViaListing(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		this.commitObserved(r);
	}


	/** Suppress the wake BEFORE signaling the process on an explicit kill. */
	suppress(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (r) r.suppressed = true;
	}

	confirmKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (r) this.resolveRecord(r);
	}

	restoreAfterFailedKill(sessionId: number): void {
		const r = this.records.get(sessionId);
		if (!r) return;
		r.suppressed = false;
		if (r.exited) this.scheduleFlush();
	}

	handleEviction(session: CompletionSessionLike): void {
		const r = this.records.get(session.id);
		if (!r) return;
		if (!session.hasExited) {
			r.suppressed = true;
			this.resolveRecord(r);
			return;
		}
		this.scheduleFlush();
	}

	shutdown(): void {
		this.stopped = true;
		const monitors = this.monitors;
		this.monitors = new Map();
		for (const subscription of monitors.values()) subscription.cancel();
		monitors.clear();
		if (this.debounceHandle !== undefined) {
			this.clearTimer(this.debounceHandle);
			this.debounceHandle = undefined;
		}
		for (const r of this.records.values()) {
			r.unsubscribeExit();
		}
		this.records.clear();
	}

	reset(): void {
		this.shutdown();
		this.stopped = false;
	}

	private resolveRecord(record: CompletionRecord): void {
		if (this.records.get(record.sessionId) !== record) return;
		record.unsubscribeExit();
		this.records.delete(record.sessionId);
	}


	private scheduleFlush(): void {
		if (this.stopped) return;
		if (this.debounceHandle !== undefined) return;
		this.debounceHandle = this.setTimer(() => {
			this.debounceHandle = undefined;
			this.flushPending();
		}, this.opts.debounceMs);
	}

	flushPending(): void {
		if (this.stopped) return;
		for (const r of this.records.values()) {
			if (
				r.armed &&
				r.exited &&
				!r.observed &&
				!r.suppressed &&
				!r.wakeQueued &&
				!this.monitors.has(r.sessionId) &&
				r.observers.size === 0 &&
				r.snapshot
			) {
				this.submitWake(r, r.snapshot);
			}
		}
		this.opts.notices.flush();
	}

	private submitWake(record: CompletionRecord, s: CompletionSnapshot): void {
		// Reserve BEFORE submitting so a re-entrant flush cannot double-submit.
		record.wakeQueued = true;
		const live = () => !this.stopped && this.records.get(record.sessionId) === record && !record.observed && !record.suppressed;
		void this.opts.notices.submit({
			identity: { sessionId: s.sessionId, title: s.title, terminalUrl: s.terminalUrl, logPath: s.logPath },
			body: { kind: "exit_wake", command: s.command, cwd: s.cwd, elapsedMs: s.elapsedMs, exitCode: s.exitCode, signal: s.signal, failure: s.failureMessage },
		}, live).then((outcome) => {
			if (this.records.get(record.sessionId) !== record) return;
			switch (outcome) {
				case "delivered":
				case "withheld":
					this.resolveRecord(record);
					break;
				case "dropped":
					record.wakeQueued = false;
					break;
			}
		});
	}
}
