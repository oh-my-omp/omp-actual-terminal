import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { activate } from "../src/index.ts";
import { TerminalJob } from "../src/terminal-job.ts";
import { STUB_SESSION, stubJobManager, stubShellHost, stubTerminalHost } from "./stub-shell.ts";

interface Details {
	job_id?: string;
	exit_code?: number;
	failure_message?: string;
	sessions?: Array<{ job_id: string; running: boolean }>;
}
interface ToolDef {
	execute: (id: string, params: object, signal: undefined, onUpdate: undefined, ctx: object) => Promise<{ details: Details }>;
}
type Handler = (event: object, ctx: object) => unknown;

interface Harness {
	readonly jobs: AsyncJobManager;
	call(name: string, params: object): Promise<Details>;
	shutdown(): Promise<void>;
}

const live = new Set<Harness>();

async function makeHarness(jobs: AsyncJobManager = stubJobManager()): Promise<Harness> {
	const tools: Record<string, ToolDef> = {};
	const handlers: Record<string, Handler[]> = {};
	const ctx = { cwd: process.cwd(), ui: { notify() {}, setStatus() {}, setWidget() {} }, hasUI: false, ...STUB_SESSION };
	const pi = {
		registerTool: (def: ToolDef & { name: string }) => { tools[def.name] = def; },
		on: (event: string, handler: Handler) => { (handlers[event] ??= []).push(handler); },
		registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
		getFlag: () => false, getActiveTools: () => ["bash"], setActiveTools() {}, sendMessage() {},
	};
	activate(pi as unknown as Parameters<typeof activate>[0], undefined, stubTerminalHost({}, jobs), undefined, {}, undefined, undefined, undefined, stubShellHost);
	for (const h of handlers.session_start ?? []) await h({}, ctx);
	const harness: Harness = {
		jobs,
		async call(name, params) {
			return (await tools[name]!.execute("call", params, undefined, undefined, ctx)).details;
		},
		async shutdown() {
			for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
		},
	};
	live.add(harness);
	return harness;
}

afterEach(async () => {
	for (const h of live) await h.shutdown();
	live.clear();
});

async function statusOf(jobs: AsyncJobManager, id: string, want: string): Promise<string | undefined> {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline && jobs.getJob(id)?.status !== want) await delay(25);
	return jobs.getJob(id)?.status;
}

async function start(h: Harness, command: string): Promise<string> {
	const started = await h.call("bash", { pty: true, title: "job test", command, shell: "/bin/sh", yield_time_ms: 250 });
	assert.match(started.job_id ?? "", /^bg_\d+$/, JSON.stringify(started));
	return started.job_id!;
}

describe("terminals as omp jobs", () => {
	it("registers each terminal as an acknowledged job of the root agent under its title", async () => {
		const h = await makeHarness();
		const id = await start(h, "sleep 30");
		const job = h.jobs.getJob(id);
		assert.equal(job?.status, "running");
		assert.equal(job?.label, "job test");
		assert.equal(job?.ownerId, STUB_SESSION.agent.id);
		assert.equal(h.jobs.isDeliverySuppressed(id), true);
	});

	it("completes on exit 0 and fails on a non-zero exit", async () => {
		const h = await makeHarness();
		const ok = await start(h, "sleep 0.4; exit 0");
		const bad = await start(h, "sleep 0.4; exit 3");
		assert.equal(await statusOf(h.jobs, ok, "completed"), "completed");
		assert.equal(await statusOf(h.jobs, bad, "failed"), "failed");
	});

	it("shows cancelled after kill_session, with a normal return rather than a failure", async () => {
		const h = await makeHarness();
		const id = await start(h, "sleep 30");
		await h.call("kill_session", { job_id: id });
		assert.equal(await statusOf(h.jobs, id, "cancelled"), "cancelled");
		await h.jobs.getJob(id)?.promise;
		assert.equal(h.jobs.getJob(id)?.errorText, undefined);
		assert.equal(h.jobs.getJob(id)?.resultText, "returned normally");
	});

	it("ends the terminal when omp cancels its job", async () => {
		const h = await makeHarness();
		const id = await start(h, "sleep 30");
		h.jobs.cancel(id);
		const deadline = Date.now() + 8000;
		let entry: { running: boolean } | undefined;
		while (Date.now() < deadline) {
			entry = (await h.call("list_sessions", {})).sessions?.find((s) => s.job_id === id);
			if (entry?.running === false) break;
			await delay(50);
		}
		assert.equal(entry?.running, false, "the terminal ended and stays listed");
		assert.equal(h.jobs.getJob(id)?.status, "cancelled");
		await h.jobs.getJob(id)?.promise;
		assert.equal(h.jobs.getJob(id)?.errorText, undefined, "a cancelled terminal is not reported as failing");
	});

	it("keeps the job running while a terminal survives the plugin's end, and cancels it once it returns", async () => {
		const jobs = stubJobManager();
		let reentered = 0;
		const job = TerminalJob.open(
			{ manager: jobs, ownerId: STUB_SESSION.agent.id },
			{ label: "survivor", command: "sleep 30", cwd: process.cwd(), pids: () => [], cancelled: () => { reentered++; } },
		);
		job.cancel();
		job.killFailed();
		assert.equal(jobs.getJob(job.id)?.status, "running");
		job.cancel();
		job.returned({ exitCode: null, signal: "SIGTERM" }, null);
		assert.equal(await statusOf(jobs, job.id, "cancelled"), "cancelled");
		assert.equal(reentered, 0, "the plugin's own end never comes back through the job's abort");
	});

	it("returns omp's limit error verbatim and starts nothing at capacity", async () => {
		const h = await makeHarness(stubJobManager(1));
		await start(h, "sleep 30");
		const refused = await h.call("bash", { pty: true, title: "over", command: "echo never-started", shell: "/bin/sh", yield_time_ms: 250 });
		assert.equal(refused.job_id, undefined);
		assert.match(refused.failure_message ?? "", /^Background job limit reached \(1\)\./);
		assert.equal((await h.call("list_sessions", {})).sessions?.length, 1);
	});
});
