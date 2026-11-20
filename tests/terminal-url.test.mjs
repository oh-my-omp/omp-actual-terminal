import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { initializeTerminalUrls, parseInternalUrlRouterHost } from "../fork-features/terminal-url.ts";

describe("term:// registration", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterAll(() => {
		InternalUrlRouter.resetForTests();
	});

	test("a host whose internal-urls module lacks InternalUrlRouter.instance fails with a requalify error", () => {
		expect(() => parseInternalUrlRouterHost({})).toThrow("internal-urls lacks InternalUrlRouter.instance");
		expect(() => parseInternalUrlRouterHost({ InternalUrlRouter: class {} })).toThrow(
			"internal-urls lacks InternalUrlRouter.instance",
		);
	});

	test("an in-process reload replaces the handler a version before the shared copy registered", async () => {
		const old = { [Symbol.for("omp-unified-exec.term-handler")]: true, scheme: "term", spec: {} };
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
});