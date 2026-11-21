import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SessionStore } from "../src/session-store.ts";
import type { ExecSession } from "../src/session.ts";

class StubSession {
	readonly id: string;
	private lastUsedAt: number;
	private exited: boolean;
	terminatedWith: NodeJS.Signals | null = null;
	constructor(id: number, lastUsed: number, exited = false) {
		this.id = `bg_${id}`;
		this.lastUsedAt = lastUsed;
		this.exited = exited;
	}
	get lastUsed(): number {
		return this.lastUsedAt;
	}
	get hasExited(): boolean {
		return this.exited;
	}
	setExited() {
		this.exited = true;
	}
	setLastUsed(ms: number) {
		this.lastUsedAt = ms;
	}
	terminate(signal: NodeJS.Signals = "SIGTERM") {
		this.terminatedWith = signal;
	}
	release(): Promise<void> {
		return Promise.resolve();
	}
	releaseForShutdown(): Promise<void> {
		return Promise.resolve();
	}
}

function stub(id: number, lastUsed: number, exited = false): ExecSession {
	return new StubSession(id, lastUsed, exited) as unknown as ExecSession;
}

describe("SessionStore", () => {
	it("insert+get+remove roundtrip", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		const a = stub(1, 1000);
		store.insert(a);
		assert.equal(store.get("bg_1"), a);
		assert.equal(store.size, 1);
		store.remove("bg_1");
		assert.equal(store.get("bg_1"), undefined);
		assert.equal(store.size, 0);
	});

	it("evicts nothing when under cap", () => {
		const store = new SessionStore({ maxSessions: 5, lruProtectedCount: 2 });
		for (let i = 1; i <= 4; i++) {
			const { pruned } = store.insert(stub(i, 1000 + i));
			assert.equal(pruned, undefined);
		}
		assert.equal(store.size, 4);
	});

	it("evicts oldest exited entry first", () => {
		const store = new SessionStore({ maxSessions: 3, lruProtectedCount: 1 });
		const a = stub(1, 1000, /*exited*/ true); // oldest exited
		const b = stub(2, 2000, /*exited*/ true); // newer exited
		const c = stub(3, 3000, /*exited*/ false); // newest alive
		store.insert(a);
		store.insert(b);
		store.insert(c);
		const d = stub(4, 4000);
		const { pruned } = store.insert(d);
		assert.ok(pruned, "expected a pruned entry");
		assert.equal(pruned?.id, "bg_1", `expected bg_1 evicted, got id=${pruned!.id}`);
		assert.equal(store.size, 3);
	});

	it("falls back to oldest alive when no unprotected exited entries", () => {
		const store = new SessionStore({ maxSessions: 3, lruProtectedCount: 1 });
		store.insert(stub(1, 1000));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000)); // newest → protected
		const d = stub(4, 4000);
		const { pruned } = store.insert(d);
		assert.equal(pruned?.id, "bg_1");
	});

	it("protects the N most recent entries", () => {
		const store = new SessionStore({ maxSessions: 5, lruProtectedCount: 3 });
		store.insert(stub(1, 1000, /*exited*/ true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000));
		store.insert(stub(4, 4000));
		store.insert(stub(5, 5000)); // most recent (protected)
		const newEntry = stub(6, 6000);
		const { pruned } = store.insert(newEntry);
		assert.equal(pruned?.id, "bg_1");
	});

	it("terminates evicted session", () => {
		const store = new SessionStore({ maxSessions: 1, lruProtectedCount: 0 });
		const victim = stub(1, 1000);
		store.insert(victim);
		store.insert(stub(2, 2000));
		const terminated = (victim as unknown as StubSession).terminatedWith;
		assert.equal(terminated, "SIGTERM");
	});

	it("terminateAll clears and signals each session", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		const a = stub(1, 1);
		const b = stub(2, 2);
		store.insert(a);
		store.insert(b);
		const drained = store.terminateAll();
		assert.equal(drained.length, 2);
		assert.equal(store.size, 0);
		assert.equal((a as unknown as StubSession).terminatedWith, "SIGTERM");
		assert.equal((b as unknown as StubSession).terminatedWith, "SIGTERM");
	});

	it("terminateAll excludes already-exited sessions from its returned live list while still clearing and evicting them", () => {
		const evicted: Array<{ id: string; reason: string }> = [];
		const store = new SessionStore({
			maxSessions: 10,
			lruProtectedCount: 2,
			onEvict: (s, reason) => evicted.push({ id: s.id, reason }),
		});
		const exited = stub(1, 1000, /*exited*/ true);
		const live = stub(2, 2000, /*exited*/ false);
		store.insert(exited);
		store.insert(live);
		const drained = store.terminateAll();
		assert.deepEqual(drained.map((s) => s.id), ["bg_2"]);
		assert.equal(store.size, 0);
		assert.equal((exited as unknown as StubSession).terminatedWith, null);
		assert.equal((live as unknown as StubSession).terminatedWith, "SIGTERM");
		assert.deepEqual(evicted.map((e) => e.id).sort(), ["bg_1", "bg_2"]);
	});

	it("onEvict callback fires for LRU and shutdown", () => {
		const events: Array<{ id: string; reason: string }> = [];
		const store = new SessionStore({
			maxSessions: 2,
			lruProtectedCount: 1,
			onEvict: (s, reason) => events.push({ id: s.id, reason }),
		});
		store.insert(stub(1, 1000, /*exited*/ true));
		store.insert(stub(2, 2000));
		store.insert(stub(3, 3000)); // evicts 1
		assert.deepEqual(events, [{ id: "bg_1", reason: "lru" }]);

		store.terminateAll();
		const reasons = events.slice(1).map((e) => e.reason).sort();
		assert.deepEqual(reasons, ["shutdown", "shutdown"]);
	});

	it("notifies once for inserted and stored sessions, ignores unknown removals, and unsubscribes", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		const snapshots: string[][] = [];
		const unsubscribe = store.subscribe(() => {
			snapshots.push(store.values().map((session) => session.id));
		});

		const session = stub(1, 1000);
		store.insert(session);
		assert.deepEqual(snapshots, [["bg_1"]]);

		assert.equal(store.remove("bg_999"), undefined);
		assert.deepEqual(snapshots, [["bg_1"]], "unknown removals must not notify");

		assert.equal(store.remove(session.id), session);
		assert.deepEqual(snapshots, [["bg_1"], []]);

		unsubscribe();
		store.insert(stub(2, 2000));
		assert.deepEqual(snapshots, [["bg_1"], []], "unsubscribed listeners must not be called");
	});

	it("notifies once when an insert prunes at the cap and sees the post-prune values", () => {
		const store = new SessionStore({ maxSessions: 1, lruProtectedCount: 0 });
		store.insert(stub(1, 1000));

		const snapshots: string[][] = [];
		store.subscribe(() => {
			snapshots.push(store.values().map((session) => session.id));
		});

		const { pruned } = store.insert(stub(2, 2000));
		assert.equal(pruned?.id, "bg_1");
		assert.deepEqual(snapshots, [["bg_2"]], "prune plus insert must emit one post-mutation notification");
	});

	it("notifies once after terminateAll with sessions, but not when already empty", () => {
		const store = new SessionStore({ maxSessions: 10, lruProtectedCount: 2 });
		store.insert(stub(1, 1000));
		store.insert(stub(2, 2000));

		const snapshots: string[][] = [];
		store.subscribe(() => {
			snapshots.push(store.values().map((session) => session.id));
		});

		assert.equal(store.terminateAll().length, 2);
		assert.deepEqual(snapshots, [[]]);

		assert.deepEqual(store.terminateAll(), []);
		assert.deepEqual(snapshots, [[]], "an empty terminateAll must not notify");
	});
});
