import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	CompletionCoordinator,
	type CompletionSessionLike,
	sanitizeMeta,
} from "../src/completion.ts";
import { buildNoticeMessage, NoticeDispatcher, type NoticeMessage, type TerminalNotice } from "../src/terminal-notice.ts";

class FakeSession implements CompletionSessionLike {
	readonly id: string;
	title = "Background sleep";
	displayCommand = "sleep 99";
	cwd = "/tmp/project";
	startedAt = Date.now() - 1234;
	logPath: string | undefined = "/tmp/omp-actual-terminal-fake.log";
	get terminalUrl(): string { return `term://${this.id}-fake`; }
	hasExited = false;
	exitCode: number | null = null;
	signal: string | null = null;
	failureMessage: string | null = null;
	private listeners = new Set<(s: unknown) => void>();

	constructor(id: string) {
		this.id = id;
	}

	onExit(listener: (s: unknown) => void): () => void {
		this.listeners.add(listener);
		if (this.hasExited) queueMicrotask(() => listener(this));
		return () => this.listeners.delete(listener);
	}

	exit(code: number): void {
		this.hasExited = true;
		this.exitCode = code;
		for (const l of this.listeners) l(this);
	}

	fireExitAgain(): void {
		for (const l of this.listeners) l(this);
	}
}

function makeCoordinator(opts: { failSends?: number; finished?: () => boolean } = {}) {
	const sent: NoticeMessage[] = [];
	const errors: unknown[] = [];
	let remainingFailures = opts.failSends ?? 0;
	const notices = new NoticeDispatcher({
		finished: opts.finished,
		send: (message) => {
			if (remainingFailures > 0) {
				remainingFailures--;
				throw new Error("send failed");
			}
			sent.push(message);
		},
		setTimeoutFn: () => 1,
		clearTimeoutFn: () => {},
		onSendError: (error) => errors.push(error),
	});
	const coordinator = new CompletionCoordinator({ notices, debounceMs: 5 });
	return { coordinator, sent, errors };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("CompletionCoordinator", () => {
	it("unregistered sessions (on_exit omitted/none) never wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		s.exit(0);
		coordinator.flushPending();
		await settle();
		assert.equal(sent.length, 0);
	});

	it("armed session exiting while idle sends exactly one wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
		assert.match(sent[0].content, /job_id=bg_1/);
		assert.match(sent[0].content, /exit_code=0/);
		assert.equal(coordinator.recordCount, 0, "record resolved after send");
	});

	it("a finished agent's wake is withheld and consumed, never sent at a later flush", async () => {
		const { coordinator, sent } = makeCoordinator({ finished: () => true });
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 0, "finished work is not woken by a normal exit");
		assert.equal(coordinator.recordCount, 0, "the withheld wake resolved its record");
		coordinator.flushPending();
		await settle();
		assert.equal(sent.length, 0, "no later resubmission");
	});

	it("register handles the boundary race: session already exited when registered", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		s.exit(3); // exits before register (the bash call decided while it was alive)
		coordinator.register(s);
		await settle();
		assert.equal(sent.length, 1, "completion must not be lost");
		assert.match(sent[0].content, /exit_code=3/);
	});

	it("exit while an observer is active is held; successful finalization suppresses the wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.beginObservation("bg_1", "call-1");
		s.exit(0);
		await settle();
		assert.equal(sent.length, 0, "exit held while observed");
		coordinator.markPendingTerminal("bg_1", "call-1");
		coordinator.handleToolExecutionEnd("call-1", false);
		await settle();
		assert.equal(sent.length, 0, "direct delivery consumed the wake");
		assert.equal(coordinator.recordCount, 0);
	});

	it("terminal result finalized as error keeps the completion wake-eligible", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.beginObservation("bg_1", "call-1");
		s.exit(0);
		coordinator.markPendingTerminal("bg_1", "call-1");
		coordinator.handleToolExecutionEnd("call-1", true); // error/cancelled finalization
		await settle();
		assert.equal(sent.length, 1, "wake must still fire");
	});

	it("observer released at deadline keeps the wake armed; later exit wakes once", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.beginObservation("bg_1", "call-1");
		coordinator.releaseObservation("bg_1", "call-1"); // deadline reached, still running
		await settle();
		assert.equal(sent.length, 0);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
	});

	it("cancelled observation (lease cleaned via tool_execution_end) keeps the wake armed", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.beginObservation("bg_1", "call-1");
		coordinator.handleToolExecutionEnd("call-1", true);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
	});

	it("setOnExit none disarms an armed wake; natural exit does not notify", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		assert.equal(coordinator.setOnExit("bg_1", "none", s), "disarmed");
		assert.equal(coordinator.isArmed("bg_1"), false);
		s.exit(1);
		await settle();
		assert.equal(sent.length, 0);
		assert.equal(coordinator.setOnExit("bg_1", "none", s), "already_none");
	});

	it("setOnExit wake arms a previously unarmed running session", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_2");
		assert.equal(coordinator.setOnExit("bg_2", "wake", s), "armed");
		assert.equal(coordinator.isArmed("bg_2"), true);
		assert.equal(coordinator.setOnExit("bg_2", "wake", s), "already_armed");
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
	});

	it("setOnExit wake is too_late after the session has already exited unregistered", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_3");
		s.exit(0);
		assert.equal(coordinator.setOnExit("bg_3", "wake", s), "too_late");
		await settle();
		assert.equal(sent.length, 0);
	});

	it("setOnExit none after exit but before flush suppresses the wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_4");
		coordinator.register(s);
		s.exit(7);
		assert.equal(coordinator.setOnExit("bg_4", "none", s), "disarmed");
		await settle();
		assert.equal(sent.length, 0);
	});

	it("setOnExit none disarms a tombstone record without a store session", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_5");
		coordinator.register(s);
		s.exit(1);
		coordinator.handleEviction(s);
		assert.equal(coordinator.setOnExit("bg_5", "none", null), "disarmed");
		await settle();
		assert.equal(sent.length, 0);
	});

	it("explicit kill suppresses the wake before the exit lands", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.suppress("bg_1"); // kill_session / slash command, before signaling
		s.exit(143);
		coordinator.confirmKill("bg_1");
		await settle();
		assert.equal(sent.length, 0);
		assert.equal(coordinator.recordCount, 0);
	});

	it("failed kill restores wake eligibility", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.suppress("bg_1");
		coordinator.restoreAfterFailedKill("bg_1");
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
	});

	it("shutdown cancels pending wakes and never injects stale prompts", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		coordinator.shutdown(); // before the debounce fires
		await settle();
		assert.equal(sent.length, 0);
		coordinator.reset();
		coordinator.flushPending();
		await settle();
		assert.equal(sent.length, 0);
	});

	it("simultaneous completions batch into one bounded prompt", async () => {
		const { coordinator, sent } = makeCoordinator();
		const a = new FakeSession("bg_1");
		const b = new FakeSession("bg_2");
		const c = new FakeSession("bg_3");
		coordinator.register(a);
		coordinator.register(b);
		coordinator.register(c);
		a.exit(0);
		b.exit(1);
		c.exit(0);
		await settle();
		assert.equal(sent.length, 1, "one prompt for the batch");
		assert.match(sent[0].content, /job_id=bg_1/);
		assert.match(sent[0].content, /job_id=bg_2/);
		assert.match(sent[0].content, /job_id=bg_3/);
	});

	it("duplicate exit callbacks and repeated flushes never duplicate wakes", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		s.fireExitAgain();
		s.fireExitAgain();
		coordinator.flushPending();
		coordinator.flushPending();
		await settle();
		coordinator.flushPending();
		assert.equal(sent.length, 1);
	});

	it("after a wake is sent, later observations never cause another wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 1);
		coordinator.beginObservation("bg_1", "call-2");
		coordinator.markPendingTerminal("bg_1", "call-2");
		coordinator.handleToolExecutionEnd("call-2", false);
		await settle();
		assert.equal(sent.length, 1);
	});

	it("list_sessions observing the exit before notification suppresses the wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		coordinator.observeViaListing("bg_1"); // observed before the notice debounce
		await settle();
		assert.equal(sent.length, 0);
	});

	it("eviction of a live process suppresses the wake", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		coordinator.handleEviction(s); // still alive → LRU terminates it
		s.exit(143); // induced exit
		await settle();
		assert.equal(sent.length, 0);
	});

	it("eviction of a naturally exited wake session keeps a tombstone and still wakes once", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0); // natural completion, not yet notified
		coordinator.handleEviction(s); // store drops the session
		await settle();
		assert.equal(sent.length, 1, "completion must not be silently lost");
		assert.match(sent[0].content, /log_path: \/tmp\/omp-actual-terminal-fake\.log/);
	});

	it("a failed send is retried at the next flush trigger, still exactly once", async () => {
		const { coordinator, sent, errors } = makeCoordinator({ failSends: 1 });
		const s = new FakeSession("bg_1");
		coordinator.register(s);
		s.exit(0);
		await settle();
		assert.equal(sent.length, 0);
		assert.equal(errors.length, 1);
		coordinator.flushPending(); // e.g. a settled run's agent_end
		await settle();
		assert.equal(sent.length, 1);
		coordinator.flushPending();
		assert.equal(sent.length, 1);
	});

	it("wake content is bounded metadata without raw output, with control chars stripped", async () => {
		const { coordinator, sent } = makeCoordinator();
		const s = new FakeSession("bg_7");
		s.displayCommand = `echo \u001b[31mevil\u0007 && ${"x".repeat(500)}`;
		s.failureMessage = `bad\u001b]0;title\u0007thing ${"y".repeat(500)}`;
		coordinator.register(s);
		s.exit(2);
		await settle();
		assert.equal(sent.length, 1);
		const content = sent[0].content;
		assert.ok(!content.includes("\u001b"), "escape bytes stripped");
		assert.ok(!content.includes("\u0007"), "BEL stripped");
		assert.ok(content.length < 2000, `content should be bounded; got ${content.length}`);
		assert.match(content, /read term:\/\/bg_7-fake/);
		assert.doesNotMatch(content, /write_stdin/);
	});
});

describe("buildNoticeMessage", () => {
	it("includes every terminal and groups multiple reasons under one heading", () => {
		const notices: TerminalNotice[] = Array.from({ length: 40 }, (_, i) => ({
			identity: { jobId: `bg_${i + 1}`, title: `Job ${i + 1}`, logPath: `/tmp/log-${i + 1}.log`, terminalUrl: `term://bg_${i + 1}-fake` },
			body: { kind: "exit_wake", command: `job ${i + 1}`, cwd: "/tmp", elapsedMs: 1000, exitCode: 0, signal: null, failure: null },
		}));
		notices.push({ identity: notices[39]!.identity, body: { kind: "abnormal_return", command: "job 40", reason: "failed" } });
		const msg = buildNoticeMessage(notices);
		assert.equal(msg.details.notices.length, 41);
		assert.deepEqual(msg.details.notices.slice(39).map(({ job_id, title, kind }) => ({ job_id, title, kind })), [
			{ job_id: "bg_40", title: "Job 40", kind: "exit_wake" },
			{ job_id: "bg_40", title: "Job 40", kind: "abnormal_return" },
		]);
		assert.equal(msg.content.split('- job_id=bg_40 title="Job 40"').length, 2, "one terminal heading for both notices");
		assert.match(msg.content, /on_exit wake/);
		assert.match(msg.content, /returned abnormally: failed/);
	});
});

describe("sanitizeMeta", () => {
	it("strips C0/C1 control characters but keeps plain text", () => {
		assert.equal(sanitizeMeta("a\u0000b\u001bc\u0007d\u009fe"), "abcde");
		assert.equal(sanitizeMeta("plain text"), "plain text");
	});
});
