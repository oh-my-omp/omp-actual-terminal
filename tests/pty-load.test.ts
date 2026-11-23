import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type BunPtyRuntime, requireBunRuntime, spawnBunPty } from "../src/pty.ts";

const spawnOptions = {
	command: [process.execPath],
	cwd: process.cwd(),
	env: process.env,
};

describe("Bun host admission", () => {
	it("requires the real host to provide native PTY support", () => {
		assert.ok(requireBunRuntime());
	});

	it("rejects a non-Bun runtime with an explicit host requirement", () => {
		assert.throws(
			() => requireBunRuntime(null),
			/requires a Bun host with Bun\.Terminal; the current runtime is not Bun/,
		);
	});

	it("rejects Bun without Terminal support and names its version", () => {
		assert.throws(
			() => requireBunRuntime({ version: "1.3.3", spawn() {} }),
			/requires a Bun host with Bun\.Terminal; Bun 1\.3\.3 does not provide Bun\.spawn with Bun\.Terminal support/,
		);
	});

	it("rejects Bun without spawn support", () => {
		assert.throws(
			() => requireBunRuntime({ version: "test", Terminal() {} }),
			/requires a Bun host with Bun\.Terminal; Bun test does not provide Bun\.spawn/,
		);
	});
});

describe("Bun PTY lifecycle", () => {
	it("replays data and exit when Bun invokes callbacks before spawn returns", () => {
		const terminal = new Bun.Terminal({});
		terminal.close();
		const subprocess = { pid: 123, terminal };
		const runtime: BunPtyRuntime = {
			spawn(_command, options) {
				options.terminal.data(terminal, new TextEncoder().encode("EARLY_DATA"));
				options.terminal.exit(terminal, 0, null);
				options.onExit(subprocess, 0, null);
				return subprocess;
			},
		};
		const child = spawnBunPty(runtime, spawnOptions);
		let output = "";
		child.onData((chunk) => { output += new TextDecoder().decode(chunk); });
		let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
		child.onExit((...args) => { exit = args; });
		assert.equal(output, "EARLY_DATA");
		assert.deepEqual(exit, [0, null, undefined]);
		assert.equal(child.processExited, true);
	});

	it("waits for terminal closure after an early Bun process exit", () => {
		const terminal = new Bun.Terminal({});
		const subprocess = { pid: 123, terminal };
		let emitData: ((value: string) => void) | undefined;
		let closeTerminal: (() => void) | undefined;
		const runtime: BunPtyRuntime = {
			spawn(_command, options) {
				emitData = (value) => options.terminal.data(terminal, new TextEncoder().encode(value));
				closeTerminal = () => {
					terminal.close();
					options.terminal.exit(terminal, 0, null);
				};
				options.onExit(subprocess, 0, null);
				return subprocess;
			},
		};
		const child = spawnBunPty(runtime, spawnOptions);
		let output = "";
		const unsubscribe = child.onData((chunk) => { output += new TextDecoder().decode(chunk); });
		let exit: [number | null, NodeJS.Signals | null, string?] | undefined;
		child.onExit((...args) => { exit = args; });
		assert.equal(exit, undefined);
		assert.ok(emitData);
		emitData("FIRST");
		assert.equal(output, "FIRST");
		unsubscribe();
		emitData("UNSUBSCRIBED");
		let resubscribedOutput = "";
		child.onData((chunk) => { resubscribedOutput += new TextDecoder().decode(chunk); });
		assert.equal(resubscribedOutput, "");
		emitData("LATE_DATA");
		assert.equal(resubscribedOutput, "LATE_DATA");
		assert.ok(closeTerminal);
		closeTerminal();
		assert.deepEqual(exit, [0, null, undefined]);
	});
});
