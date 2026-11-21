import type { NoticeDispatcher, TerminalIdentity, TerminalNotice, TerminalOutcome } from "./terminal-notice.ts";

export const RECLAIM_TTL_MS = 30 * 60_000;
export const RECLAIM_GRACE_MS = 5 * 60_000;
export const RECLAIM_LINGER_MS = 5 * 60_000;
export const LIFECYCLE_SWEEP_MS = 60_000;

export interface ShellExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage?: string;
}

export interface LifecycleSession {
	readonly id: number;
	readonly title: string;
	readonly displayCommand: string;
	readonly terminalUrl: string | undefined;
	readonly logPath: string;
	readonly hasExited: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly failureMessage: string | null;
	readonly shellExited: boolean;
	readonly shellExit: ShellExit | undefined;
	onShellExit(listener: (exit: ShellExit) => void): () => void;
	onExit(listener: () => void): () => void;
	onTerminalRead(listener: () => void): () => void;
	processesRemain(): boolean;
}

type Deadline = { readonly kind: "open" } | { readonly kind: "expired"; readonly seconds: number };

interface Ending {
	readonly killed: boolean;
	readonly interrupted: boolean;
	readonly deadline: Deadline;
}

const NATURAL: Ending = { killed: false, interrupted: false, deadline: { kind: "open" } };

const INTERRUPT_BYTES: readonly number[] = [0x03, 0x1c];

export function carriesInterrupt(bytes: Uint8Array): boolean {
	return INTERRUPT_BYTES.some((byte) => bytes.includes(byte));
}

type ReadState = { readonly kind: "unread" } | { readonly kind: "read"; readonly at: number };

type Phase =
	| { readonly kind: "ttl"; readonly due: number }
	| { readonly kind: "unread_reminded" }
	| { readonly kind: "grace"; readonly until: number }
	| { readonly kind: "linger"; readonly until: number }
	| { readonly kind: "reclaiming" };

type Life =
	| { readonly kind: "running"; readonly ending: Ending }
	| { readonly kind: "returned"; readonly outcome: TerminalOutcome; readonly returnedAt: number; readonly read: ReadState; readonly phase: Phase };

interface Tracked {
	readonly session: LifecycleSession;
	life: Life;
	readonly unsubscribe: Array<() => void>;
}
export interface LifecycleClock {
	readonly nowFn?: () => number;
	readonly setIntervalFn?: (cb: () => void, ms: number) => unknown;
	readonly clearIntervalFn?: (handle: unknown) => void;
}

export type ReclaimResult = { readonly kind: "gone"; readonly killedProcesses: boolean } | { readonly kind: "held" };

export interface ReclaimedTerminal {
	readonly identity: TerminalIdentity;
	readonly outcome: TerminalOutcome | undefined;
}

export interface TerminalLifecycleOptions extends LifecycleClock {
	readonly notices: NoticeDispatcher;
	readonly reclaim: (sessionId: number) => Promise<ReclaimResult>;
	readonly ttlMs?: number;
	readonly graceMs?: number;
	readonly lingerMs?: number;
	readonly sweepMs?: number;
	readonly graceReclaimNotice?: () => Promise<boolean>;
}

export function identityOf(session: LifecycleSession): TerminalIdentity {
	return { sessionId: session.id, title: session.title, terminalUrl: session.terminalUrl, logPath: session.logPath };
}

export function classifyReturn(exit: ShellExit, failureMessage: string | null, ending: Ending): TerminalOutcome {
	if (ending.deadline.kind === "expired") return { kind: "abnormal", reason: `timeout=${ending.deadline.seconds}s` };
	if (ending.killed || ending.interrupted) return { kind: "normal" };
	const failure = failureMessage ?? exit.failureMessage;
	if (failure) return { kind: "abnormal", reason: `failure: ${failure}` };
	if (exit.signal) return { kind: "abnormal", reason: `signal=${exit.signal}` };
	if (exit.exitCode === null) return { kind: "abnormal", reason: "exit status unknown" };
	if (exit.exitCode !== 0) return { kind: "abnormal", reason: `exit_code=${exit.exitCode}` };
	return { kind: "normal" };
}

export class TerminalLifecycle {
	private readonly tracked = new Map<number, Tracked>();
	private readonly toolReads = new Map<string, Set<number>>();
	private readonly gone = new Map<number, ReclaimedTerminal>();
	private sweeper: unknown;
	private stopped = false;
	private readonly ttlMs: number;
	private readonly graceMs: number;
	private readonly lingerMs: number;
	private readonly sweepMs: number;

	constructor(private readonly opts: TerminalLifecycleOptions) {
		this.ttlMs = opts.ttlMs ?? RECLAIM_TTL_MS;
		this.graceMs = opts.graceMs ?? RECLAIM_GRACE_MS;
		this.lingerMs = opts.lingerMs ?? RECLAIM_LINGER_MS;
		this.sweepMs = opts.sweepMs ?? LIFECYCLE_SWEEP_MS;
	}

	private now(): number {
		return this.opts.nowFn ? this.opts.nowFn() : Date.now();
	}

	track(session: LifecycleSession): void {
		if (this.stopped || this.tracked.has(session.id)) return;
		const entry: Tracked = { session, life: { kind: "running", ending: NATURAL }, unsubscribe: [] };
		this.tracked.set(session.id, entry);
		entry.unsubscribe.push(
			session.onShellExit((exit) => this.returned(entry, exit)),
			session.onExit(() => { this.returned(entry, undefined); this.linger(entry); }),
			session.onTerminalRead(() => this.markRead(session.id)),
		);
		if (session.shellExited || session.hasExited) this.returned(entry, session.shellExit);
		this.ensureSweeper();
	}

	isTracked(sessionId: number): boolean {
		return this.tracked.has(sessionId);
	}

	reclaimed(sessionId: number): ReclaimedTerminal | undefined {
		return this.gone.get(sessionId);
	}

	status(sessionId: number): { readonly outcome: TerminalOutcome; readonly read: boolean; readonly phase: Phase["kind"] } | undefined {
		const life = this.tracked.get(sessionId)?.life;
		return life?.kind === "returned" ? { outcome: life.outcome, read: life.read.kind === "read", phase: life.phase.kind } : undefined;
	}

	noteKill(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") entry.life = { kind: "running", ending: { ...entry.life.ending, killed: true } };
	}

	/** The terminal's `timeout` ended it: whatever ends it now is an abnormal return. */
	noteDeadline(sessionId: number, seconds: number): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") entry.life = { kind: "running", ending: { ...entry.life.ending, deadline: { kind: "expired", seconds } } };
	}

	killFailed(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") entry.life = { kind: "running", ending: { ...entry.life.ending, killed: false } };
	}

	noteInput(sessionId: number, bytes: Uint8Array): void {
		const entry = this.tracked.get(sessionId);
		if (entry?.life.kind === "running") {
			entry.life = { kind: "running", ending: { ...entry.life.ending, interrupted: carriesInterrupt(bytes) } };
		}
	}

	markRead(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		// A read can race the shell-exit event; the session state is authoritative.
		if (entry.life.kind === "running" && (entry.session.shellExited || entry.session.hasExited)) this.returned(entry, entry.session.shellExit);
		const life = entry.life;
		if (life.kind !== "returned" || life.phase.kind === "reclaiming") return;
		const now = this.now();
		const read: ReadState = { kind: "read", at: now };
		entry.life = life.phase.kind === "linger" ? { ...life, read } : { ...life, read, phase: { kind: "ttl", due: now + this.ttlMs } };
		this.linger(entry);
	}

	noteToolRead(toolCallId: string, sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		if (entry.life.kind === "running" && !(entry.session.shellExited || entry.session.hasExited)) return;
		let ids = this.toolReads.get(toolCallId);
		if (!ids) this.toolReads.set(toolCallId, ids = new Set());
		ids.add(sessionId);
	}

	commitToolReads(toolCallId: string, isError: boolean): void {
		const ids = this.toolReads.get(toolCallId);
		if (!ids) return;
		this.toolReads.delete(toolCallId);
		if (!isError) for (const id of ids) this.markRead(id);
	}

	evicted(session: LifecycleSession, cap: number): void {
		const entry = this.tracked.get(session.id);
		if (!entry) return;
		const outcome = entry.life.kind === "returned" ? entry.life.outcome : undefined;
		this.forget(session.id);
		this.gone.set(session.id, { identity: identityOf(session), outcome });
		void this.opts.notices.submit({
			identity: identityOf(session),
			body: { kind: "reclaimed", outcome, cause: { kind: "capacity", cap, signalled: !session.hasExited } },
		});
	}

	private forget(sessionId: number): void {
		const entry = this.tracked.get(sessionId);
		if (!entry) return;
		for (const unsubscribe of entry.unsubscribe) unsubscribe();
		this.tracked.delete(sessionId);
		if (this.tracked.size === 0) this.stopSweeper();
	}

	private returned(entry: Tracked, shellExit: ShellExit | undefined): void {
		if (this.stopped || entry.life.kind !== "running" || this.tracked.get(entry.session.id) !== entry) return;
		const session = entry.session;
		const exit: ShellExit = shellExit ?? session.shellExit ?? { exitCode: session.exitCode, signal: session.signal };
		const outcome = classifyReturn(exit, session.failureMessage, entry.life.ending);
		const now = this.now();
		const life: Life = { kind: "returned", outcome, returnedAt: now, read: { kind: "unread" }, phase: { kind: "ttl", due: now + this.ttlMs } };
		entry.life = life;
		if (outcome.kind === "abnormal") {
			void this.opts.notices.submit({
				identity: identityOf(session),
				body: { kind: "abnormal_return", command: session.displayCommand, reason: outcome.reason },
			}, () => !this.stopped);
		}
		this.linger(entry);
	}

	private linger(entry: Tracked): void {
		const life = entry.life;
		if (this.stopped || this.tracked.get(entry.session.id) !== entry || life.kind !== "returned" || life.outcome.kind !== "normal") return;
		if (life.phase.kind !== "ttl" && life.phase.kind !== "unread_reminded") return;
		if (entry.session.processesRemain()) return;
		entry.life = { ...life, phase: { kind: "linger", until: this.now() + this.lingerMs } };
	}

	sweep(): void {
		if (this.stopped) return;
		const now = this.now();
		const reclaims: Tracked[] = [];
		const lingered: Tracked[] = [];
		for (const entry of this.tracked.values()) {
			if (entry.life.kind === "running") {
				if (entry.session.shellExited || entry.session.hasExited) this.returned(entry, entry.session.shellExit);
				continue;
			}
			this.linger(entry);
			const life = entry.life;
			if (life.kind !== "returned") continue;
			const phase = life.phase;
			switch (phase.kind) {
				case "ttl": {
					if (now < phase.due) break;
					const identity = identityOf(entry.session);
					if (life.read.kind === "read") {
						const next: Life = { ...life, phase: { kind: "grace", until: now + this.graceMs } };
						entry.life = next;
						this.submit(entry, {
							identity,
							body: { kind: "reclaim_due", outcome: life.outcome, lastReadAgoMs: now - life.read.at, graceMs: this.graceMs, ttlMs: this.ttlMs },
						}, () => entry.life === next, () => this.reclaimWithheld(entry, next));
					} else {
						const next: Life = { ...life, phase: { kind: "unread_reminded" } };
						entry.life = next;
						this.submit(entry, { identity, body: { kind: "unread", outcome: life.outcome, returnedAgoMs: now - life.returnedAt } },
							() => entry.life === next, () => this.reclaimWithheld(entry, next));
					}
					break;
				}
				case "grace":
					if (now >= phase.until) reclaims.push(entry);
					break;
				case "linger":
					if (now >= phase.until) lingered.push(entry);
					break;
				case "unread_reminded":
				case "reclaiming":
					break;
			}
		}
		if (reclaims.length) void this.reclaimAll(reclaims);
		for (const entry of lingered) void this.reclaimEntry(entry, entry.life);
		this.opts.notices.flush();
	}

	private async reclaimAll(entries: readonly Tracked[]): Promise<void> {
		const notify = this.opts.graceReclaimNotice?.() ?? Promise.resolve(false);
		const reclaimed = Promise.all(entries.map(async (entry): Promise<TerminalNotice | undefined> => {
			const life = entry.life;
			if (life.kind !== "returned") return undefined;
			const identity = identityOf(entry.session);
			const result = await this.reclaimEntry(entry, { ...life, phase: { kind: "grace", until: this.now() } });
			if (result?.kind !== "gone") return undefined;
			return { identity, body: { kind: "reclaimed", outcome: life.outcome, cause: { kind: "grace_expired", killed: result.killedProcesses } } };
		}));
		const [send, results] = await Promise.all([notify, reclaimed]);
		if (this.stopped || !send) return;
		for (const notice of results) if (notice) void this.opts.notices.submit(notice);
	}

	async collectReturned(): Promise<ReadonlySet<number>> {
		const entries = [...this.tracked.values()].filter((entry) => entry.life.kind === "returned" && entry.life.phase.kind !== "reclaiming");
		const results = await Promise.all(entries.map(async (entry) => {
			const result = await this.reclaimEntry(entry, entry.life);
			return result?.kind === "gone" ? entry.session.id : undefined;
		}));
		return new Set(results.filter((id): id is number => id !== undefined));
	}

	private async reclaimEntry(entry: Tracked, onHeld: Life): Promise<ReclaimResult | undefined> {
		const life = entry.life;
		if (life.kind !== "returned") return undefined;
		entry.life = { ...life, phase: { kind: "reclaiming" } };
		let result: ReclaimResult;
		try { result = await this.opts.reclaim(entry.session.id); } catch { result = { kind: "held" }; }
		if (this.tracked.get(entry.session.id) !== entry) return undefined;
		if (result.kind === "held") entry.life = onHeld;
		else {
			this.forget(entry.session.id);
			this.gone.set(entry.session.id, { identity: identityOf(entry.session), outcome: life.outcome });
		}
		return result;
	}

	private reclaimWithheld(entry: Tracked, reminded: Life): void {
		if (this.stopped || this.tracked.get(entry.session.id) !== entry || entry.life !== reminded || reminded.kind !== "returned") return;
		void this.reclaimEntry(entry, { ...reminded, phase: { kind: "grace", until: this.now() } });
	}

	private submit(entry: Tracked, notice: TerminalNotice, current: () => boolean, withheld?: () => void): void {
		void this.opts.notices.submit(notice, () => !this.stopped && this.tracked.get(entry.session.id) === entry && current())
			.then((outcome) => { if (outcome === "withheld") withheld?.(); });
	}

	private ensureSweeper(): void {
		if (this.sweeper !== undefined || this.stopped) return;
		const set = this.opts.setIntervalFn ?? ((cb: () => void, ms: number) => {
			const handle = setInterval(cb, ms);
			handle.unref?.();
			return handle;
		});
		this.sweeper = set(() => this.sweep(), this.sweepMs);
	}

	private stopSweeper(): void {
		if (this.sweeper === undefined) return;
		const clear = this.opts.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));
		clear(this.sweeper);
		this.sweeper = undefined;
	}

	shutdown(): void {
		this.stopped = true;
		this.stopSweeper();
		for (const entry of this.tracked.values()) for (const unsubscribe of entry.unsubscribe) unsubscribe();
		this.tracked.clear();
		this.toolReads.clear();
		this.gone.clear();
	}

	restart(): void {
		this.stopped = false;
	}

	get size(): number {
		return this.tracked.size;
	}
}
