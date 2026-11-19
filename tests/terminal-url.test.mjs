import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeTerminalUrls } from "../fork-features/terminal-url.ts";

class FakeRouter {
	static current = new FakeRouter();
	static instance() {
		return FakeRouter.current;
	}
	handlers = new Map();
	register(handler) {
		this.handlers.set(handler.scheme, handler);
	}
	isBuiltin() {
		return false;
	}
	unregister(scheme) {
		return this.handlers.delete(scheme);
	}
	getHandler(scheme) {
		return this.handlers.get(scheme);
	}
	specs() {
		return new Map([...this.handlers].map(([scheme, handler]) => [scheme, handler.spec]));
	}
}

mock.module("@oh-my-pi/pi-coding-agent/internal-urls", () => ({ InternalUrlRouter: FakeRouter }));

describe("term:// registration", () => {
	beforeEach(() => {
		FakeRouter.current = new FakeRouter();
	});

	test("an in-process reload replaces the handler a version before the shared copy registered", async () => {
		const old = { [Symbol.for("omp-unified-exec.term-handler")]: true, scheme: "term", spec: {} };
		FakeRouter.current.register(old);
		await initializeTerminalUrls();
		const now = FakeRouter.current.getHandler("term");
		expect(now).toBeDefined();
		expect(now).not.toBe(old);
	});

	test("a reload replaces the handler this version registered", async () => {
		await initializeTerminalUrls();
		const first = FakeRouter.current.getHandler("term");
		await initializeTerminalUrls();
		expect(FakeRouter.current.getHandler("term")).not.toBe(first);
	});

	test("a term:// handler another plugin registered is refused and kept", async () => {
		const foreign = { scheme: "term", spec: {} };
		FakeRouter.current.register(foreign);
		await expect(initializeTerminalUrls()).rejects.toThrow("term:// belongs to another handler");
		expect(FakeRouter.current.getHandler("term")).toBe(foreign);
	});
});
