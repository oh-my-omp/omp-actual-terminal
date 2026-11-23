import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { registerTerminal, terminalRegistry } from "../src/terminal-resource.ts";
import { initializeTerminalUrls, parseInternalUrlRouterHost, setTerminalUrlRuntime } from "../src/terminal-url.ts";
import { TerminalScreen } from "../src/terminal-screen.ts";

describe("term:// registration", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
		setTerminalUrlRuntime(undefined);
	});

	afterAll(() => {
		InternalUrlRouter.resetForTests();
		setTerminalUrlRuntime(undefined);
	});

	test("a host whose internal-urls module lacks InternalUrlRouter.instance fails with a requalify error", () => {
		expect(() => parseInternalUrlRouterHost({})).toThrow("internal-urls lacks InternalUrlRouter.instance");
		expect(() => parseInternalUrlRouterHost({ InternalUrlRouter: class {} })).toThrow(
			"internal-urls lacks InternalUrlRouter.instance",
		);
	});

	test("an in-process reload replaces the handler a version before the shared copy registered", async () => {
		const old = { [Symbol.for("omp-actual-terminal.term-handler")]: true, scheme: "term", spec: {} };
		InternalUrlRouter.instance().register(old);
		await initializeTerminalUrls();
		const now = InternalUrlRouter.instance().getHandler("term");
		expect(now).toBeDefined();
		expect(now).not.toBe(old);
	});

	test("a reload replaces the handler this version registered", async () => {
		await initializeTerminalUrls();
		const first = InternalUrlRouter.instance().getHandler("term");
		await initializeTerminalUrls();
		expect(InternalUrlRouter.instance().getHandler("term")).not.toBe(first);
	});

	test("a term:// handler another plugin registered is refused and kept", async () => {
		const foreign = { scheme: "term", spec: {} };
		InternalUrlRouter.instance().register(foreign);
		await expect(initializeTerminalUrls()).rejects.toThrow("term:// belongs to another handler");
		expect(InternalUrlRouter.instance().getHandler("term")).toBe(foreign);
	});

	test("exposes promptDoc, promptReference, spec.write, job_id/key read, and write dispatch", async () => {
		await initializeTerminalUrls();
		const router = InternalUrlRouter.instance();
		const handler = router.getHandler("term");
		expect(handler).toBeDefined();
		expect(handler.promptDoc?.({})).toBe(
			"`term://` / `term://<job_id>` / `term://<job_id>/screen.png` — List or inspect interactive PTY terminals (like `proc://` for PTYs); write `term://<job_id>` (stdin), `term://<job_id>/kill`, `term://<job_id>/on_exit` (`wake`|`none`), or `term://<job_id>/monitor` (`cancel`).",
		);
		expect(handler.promptReference?.()).toContain("write term://<job_id_or_key>");
		expect(handler.promptReference?.()).toContain("write term://<job_id_or_key>/kill");
		expect(handler.spec.write?.via).toBe("handler");
		expect(handler.spec.write?.payload).toBe("verbatim");
		expect(handler.spec.write?.scope).toBe("workspace");
		expect(handler.spec.write?.tier(new URL("term://bg_1/kill"), "", undefined)).toBe("exec");
		expect(handler.spec.write?.cancels?.(new URL("term://bg_1"))).toBe(false);
		expect(handler.spec.write?.cancels?.(new URL("term://bg_1/kill"))).toBe(true);
		expect(handler.spec.write?.cancels?.(new URL("term://bg_1/monitor"))).toBe(true);
		expect(handler.spec.write?.cancels?.(new URL("term://bg_1/on_exit"))).toBe(false);

		const screen = new TerminalScreen(40, 5, () => {});
		const key = registerTerminal("bg_77", screen);
		screen.write(new TextEncoder().encode("hello-term-bg_77\r\n"));
		try {
			const byKey = await router.resolve(`term://${key}`);
			expect(byKey.content).toContain("hello-term-bg_77");
			const byId = await router.resolve("term://bg_77");
			expect(byId.content).toContain("hello-term-bg_77");
		} finally {
			terminalRegistry.resources.delete(key);
			await screen.release();
		}

		const calls = [];
		setTerminalUrlRuntime({
			listSessions: () => "Active terminals (1 running, 0 exited):\n  job_id=bg_77 \"shell\" [running] url=term://bg_77",
			resolveSessionKey: () => undefined,
			writeStdin: async (target, content) => {
				calls.push(["stdin", target, content]);
				return { text: `[still running]\njob_id: ${target}`, isError: false };
			},
			killSession: async (target, signal) => {
				calls.push(["kill", target, signal]);
				return { text: `[killed]\njob_id: ${target}`, killed: true };
			},
			setOnExit: (target, policy) => {
				calls.push(["on_exit", target, policy]);
				return `on_exit job_id=${target} policy=${policy}`;
			},
			cancelMonitor: (target) => {
				calls.push(["monitor", target]);
				return JSON.stringify({ job_id: "bg_77", status: "cancelled" });
			},
		});

		const listing = await router.resolve("term://");
		expect(listing.content).toContain("job_id=bg_77");
		await expect(router.resolve("term://bg_77/kill")).rejects.toThrow(/write-only/);
		await expect(router.resolve("term://bg_77/on_exit")).rejects.toThrow(/write-only/);
		await expect(router.resolve("term://bg_77/monitor")).rejects.toThrow(/write-only/);

		const stdinWrite = await router.write("term://bg_77", "echo hello");
		expect(stdinWrite?.isError).toBeUndefined();
		await router.write("term://bg_77/kill", "SIGINT");
		await router.write("term://bg_77/kill?signal=SIGKILL", "");
		await router.write("term://bg_77/on_exit", "wake");
		await router.write("term://bg_77/monitor", "cancel");
		await expect(router.write("term://bg_77/on_exit", "bad")).rejects.toThrow(/requires content "wake" or "none"/);
		await expect(router.write("term://bg_77/monitor", "start")).rejects.toThrow(/requires content "cancel"/);
		expect(calls).toEqual([
			["stdin", "bg_77", "echo hello"],
			["kill", "bg_77", "SIGINT"],
			["kill", "bg_77", "SIGKILL"],
			["on_exit", "bg_77", "wake"],
			["monitor", "bg_77"],
		]);
	});
});
