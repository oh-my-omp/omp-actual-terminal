import { ExecSession } from "./session.ts";

export interface SessionStoreOptions {
	maxSessions: number;
	lruProtectedCount: number;
	onEvict?: (session: ExecSession, reason: "lru" | "shutdown") => void;
}

export class SessionStore {
	private readonly sessions = new Map<string, ExecSession>();
	readonly maxSessions: number;
	readonly lruProtectedCount: number;
	private readonly onEvict: SessionStoreOptions["onEvict"];
	private readonly membershipListeners = new Set<() => void>();

	constructor(opts: SessionStoreOptions) {
		this.maxSessions = opts.maxSessions;
		this.lruProtectedCount = opts.lruProtectedCount;
		this.onEvict = opts.onEvict;
	}

	get(id: string): ExecSession | undefined {
		return this.sessions.get(id);
	}

	values(): ExecSession[] {
		return Array.from(this.sessions.values());
	}

	get size(): number {
		return this.sessions.size;
	}

	/**
	 * A removed session's
	 * terminal emulator is being released by then, so listeners re-read
	 * `values()` instead of keeping removed sessions.
	 */
	subscribe(listener: () => void): () => void {
		this.membershipListeners.add(listener);
		return () => this.membershipListeners.delete(listener);
	}

	private notifyMembership(): void {
		for (const listener of this.membershipListeners) listener();
	}

	insert(session: ExecSession): { pruned?: ExecSession; count: number } {
		let pruned: ExecSession | undefined;
		if (this.sessions.size >= this.maxSessions) {
			pruned = this.pruneLru() ?? undefined;
		}
		this.sessions.set(session.id, session);
		this.notifyMembership();
		return { pruned, count: this.sessions.size };
	}

	remove(id: string): ExecSession | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		this.sessions.delete(id);
		void entry.release();
		this.notifyMembership();
		return entry;
	}

	terminateAll(): ExecSession[] {
		const all = Array.from(this.sessions.values());
		const live: ExecSession[] = [];
		this.sessions.clear();
		for (const s of all) {
			if (!s.hasExited) {
				live.push(s);
				try {
					s.terminate();
				} catch {
				}
			}
			void s.releaseForShutdown();
			this.onEvict?.(s, "shutdown");
		}
		if (all.length > 0) this.notifyMembership();
		return live;
	}

	private pruneLru(): ExecSession | null {
		const entries = Array.from(this.sessions.values());
		if (entries.length === 0) return null;

		const byRecencyAsc = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
		const protectedIds = new Set<string>(
			this.lruProtectedCount > 0 ? byRecencyAsc.slice(-this.lruProtectedCount).map((e) => e.id) : [],
		);

		const exitedCandidate = byRecencyAsc.find((e) => !protectedIds.has(e.id) && e.hasExited);
		const victim = exitedCandidate ?? byRecencyAsc.find((e) => !protectedIds.has(e.id));
		if (!victim) return null;

		this.sessions.delete(victim.id);
		this.onEvict?.(victim, "lru");
		try {
			victim.terminate();
		} catch {
		}
		void victim.release();
		return victim;
	}
}
