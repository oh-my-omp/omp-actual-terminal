import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	ensureTernPlugin,
	installTernPlugin,
	TERN_PLUGIN_ID,
	TernPluginInstallError,
	type InstallOutcome,
} from "../src/tern-plugin-install.ts";

const packageDir = fileURLToPath(new URL("../tern-plugin", import.meta.url));
const fixtureBin = mkdtempSync(join(tmpdir(), "tern-plugin-install-bin-"));
after(() => { rmSync(fixtureBin, { recursive: true, force: true }); });
before(() => {
	const stub = join(fixtureBin, "tern-install-stub.mjs");
	writeFileSync(stub, [
		'import * as fs from "node:fs";',
		'import * as path from "node:path";',
		"",
		"const args = process.argv.slice(2);",
		'const options = JSON.parse(fs.readFileSync(process.env.TERN_INSTALL_TEST_OPTIONS, "utf8"));',
		"const root = process.env.TERN_INSTALL_TEST_ROOT;",
		`const id = ${JSON.stringify(TERN_PLUGIN_ID)};`,
		'const copy = path.join(root, id);',
		'const link = path.join(root, id + ".path");',
		'fs.appendFileSync(process.env.TERN_INSTALL_TEST_LOG, JSON.stringify(args) + "\\n");',
		"function reply(value) {",
		'	process.stdout.write(JSON.stringify(value) + "\\n");',
		"}",
		"function fail(message, code = 1) {",
		'	process.stderr.write(message + "\\n");',
		"	process.exit(code);",
		"}",
		"function versionAt(dir) {",
		'	const text = fs.readFileSync(path.join(dir, "plugin.toml"), "utf8");',
		'	const match = /^version\\s*=\\s*"([^"]*)"/m.exec(text);',
		'	return match ? match[1] : "0.0.0";',
		"}",
		'if (args[0] !== "plugin") fail("unexpected command", 64);',
		"const operation = args[1];",
		'if (options.failure === operation) fail(options.failureMessage || "tern plugin: " + operation + " unavailable", 23);',
		'if (operation === "dir" && args.length === 3 && args[2] === "--json") {',
		"	reply({ dir: root });",
		'} else if (operation === "list" && args.length === 3 && args[2] === "--json") {',
		"	if (options.catalogReply !== undefined) {",
		"		process.stdout.write(options.catalogReply);",
		"	} else {",
		'		const plugins = [{ id: "another-plugin", version: "1.0.0", css: "", status: "ready" }];',
		'		if (fs.existsSync(copy)) plugins.push({ id, version: versionAt(copy), css: "", status: "ready" });',
		'		if (fs.existsSync(link)) plugins.push({ id, version: versionAt(fs.readFileSync(link, "utf8").trim()), css: "", status: "ready" });',
		"		reply({ plugins });",
		"	}",
		'} else if (operation === "install" && args.length === 5 && args[3] === "--force" && args[4] === "--json") {',
		"	const source = args[2];",
		'	if (fs.existsSync(link)) fail("tern plugin: " + id + " is linked; unlink it first");',
		"	const version = versionAt(source);",
		"	fs.rmSync(copy, { recursive: true, force: true });",
		"	fs.cpSync(source, copy, { recursive: true });",
		"	reply({ id, version, dir: copy });",
		"} else {",
		'	fail("unexpected arguments", 64);',
		"}",
	].join("\n"));
	const executable = join(fixtureBin, process.platform === "win32" ? "tern.exe" : "tern");
	execFileSync(process.execPath, ["build", "--compile", stub, "--outfile", executable], { stdio: "inherit" });
});

interface SimulatorOptions {
	readonly failure?: "dir" | "list" | "install";
	readonly failureMessage?: string;
	readonly catalogReply?: string;
}

function makeTern(t: TestContext, options: SimulatorOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "tern-plugin-install-"));
	t.after(() => { rmSync(root, { recursive: true, force: true }); });
	const pluginRoot = join(root, "Tern plugins with spaces");
	const copy = join(pluginRoot, TERN_PLUGIN_ID);
	const link = join(pluginRoot, `${TERN_PLUGIN_ID}.path`);
	const logPath = join(root, "argv.jsonl");
	const optionsPath = join(root, "options.json");
	const emptyPath = join(root, "empty-bin");
	mkdirSync(pluginRoot);
	mkdirSync(emptyPath);
	writeFileSync(logPath, "");
	writeFileSync(optionsPath, JSON.stringify(options));
	const env: NodeJS.ProcessEnv = {
		PATH: fixtureBin,
		TERN_INSTALL_TEST_OPTIONS: optionsPath,
		TERN_INSTALL_TEST_ROOT: pluginRoot,
		TERN_INSTALL_TEST_LOG: logPath,
	};
	return {
		env, root, pluginRoot, copy, link, emptyPath,
		get calls(): string[][] {
			return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line: string) => JSON.parse(line) as string[]);
		},
	};
}

function failed(outcome: InstallOutcome) {
	assert.equal(outcome.kind, "failed");
	assert.ok(outcome.kind === "failed");
	return outcome.failure;
}

describe("installing the Tern plugin this package ships", () => {
	it("installs the packaged plugin when Tern lists no such plugin", async (t) => {
		const h = makeTern(t);
		assert.deepEqual(await installTernPlugin({ env: h.env }), { kind: "installed" });
		assert.deepEqual(h.calls, [
			["plugin", "dir", "--json"],
			["plugin", "list", "--json"],
			["plugin", "install", packageDir, "--force", "--json"],
		]);
		assert.deepEqual(readFileSync(join(h.copy, "plugin.toml")), readFileSync(join(packageDir, "plugin.toml")));
		assert.deepEqual(readFileSync(join(h.copy, "window.luau")), readFileSync(join(packageDir, "window.luau")));
	});

	it("replaces an installed copy that differs from the packaged plugin", async (t) => {
		const h = makeTern(t);
		cpSync(packageDir, h.copy, { recursive: true });
		writeFileSync(join(h.copy, "plugin.toml"), 'schema = 1\nid = "omp-actual-terminal"\nversion = "0.0.0"\nwindow = "window.luau"\n');
		assert.deepEqual(await installTernPlugin({ env: h.env }), { kind: "installed" });
		assert.deepEqual(h.calls.slice(2), [["plugin", "install", packageDir, "--force", "--json"]]);
		assert.deepEqual(readFileSync(join(h.copy, "plugin.toml")), readFileSync(join(packageDir, "plugin.toml")));
	});

	it("changes nothing when Tern lists a matching copy", async (t) => {
		const h = makeTern(t);
		cpSync(packageDir, h.copy, { recursive: true });
		assert.deepEqual(await installTernPlugin({ env: h.env }), { kind: "current" });
		assert.deepEqual(h.calls, [
			["plugin", "dir", "--json"],
			["plugin", "list", "--json"],
		]);
		await ensureTernPlugin({ env: h.env });
		assert.deepEqual(h.calls, [
			["plugin", "dir", "--json"],
			["plugin", "list", "--json"],
			["plugin", "dir", "--json"],
			["plugin", "list", "--json"],
		]);
	});

	it("leaves a linked copy untouched", async (t) => {
		const h = makeTern(t);
		const checkout = join(h.root, "developer checkout");
		cpSync(packageDir, checkout, { recursive: true });
		writeFileSync(h.link, `${checkout}\n`);
		assert.deepEqual(await installTernPlugin({ env: h.env }), { kind: "linked" });
		assert.deepEqual(h.calls, [["plugin", "dir", "--json"]]);
		assert.equal(readFileSync(h.link, "utf8"), `${checkout}\n`);
		assert.equal(existsSync(join(checkout, "window.luau")), true);
		assert.equal(existsSync(h.copy), false);
	});

	it("does nothing without a tern executable", async (t) => {
		const h = makeTern(t);
		const env = { ...h.env, PATH: h.emptyPath };
		assert.deepEqual(await installTernPlugin({ env }), { kind: "unavailable" });
		await ensureTernPlugin({ env });
		assert.deepEqual(h.calls, []);
		assert.equal(existsSync(h.copy), false);
	});

	it("rejects loading with Tern's diagnostics when the plugin directory or catalog fails", async (t) => {
		for (const options of [{ failure: "dir" }, { failure: "list" }, { catalogReply: "not JSON" }, { catalogReply: '{"plugins":7}' }] as const) {
			const h = makeTern(t, options);
			const failure = failed(await installTernPlugin({ env: h.env }));
			assert.equal(failure.stage, "inspect");
			assert.equal(h.calls.some((args) => args[1] === "install"), false);
			await assert.rejects(ensureTernPlugin({ env: h.env }), (error: unknown) =>
				error instanceof TernPluginInstallError && /failed at inspect/.test(error.message));
		}
	});

	it("rejects loading with Tern's diagnostics when install fails, leaving no copy", async (t) => {
		const h = makeTern(t, { failure: "install", failureMessage: "tern plugin: permission denied" });
		const failure = failed(await installTernPlugin({ env: h.env }));
		assert.equal(failure.stage, "install");
		assert.match(failure.message, /exited 23/);
		assert.match(failure.message, /permission denied/);
		assert.equal(existsSync(h.copy), false);
		await assert.rejects(ensureTernPlugin({ env: h.env }), (error: unknown) =>
			error instanceof TernPluginInstallError && /failed at install/.test(error.message) && /permission denied/.test(error.message));
	});
});

describe("the packaged Tern plugin manifest", () => {
	it("declares this package's id and version, and ships with the package", () => {
		const manifest = Bun.TOML.parse(readFileSync(join(packageDir, "plugin.toml"), "utf8")) as {
			schema?: unknown;
			id?: unknown;
			name?: unknown;
			version?: unknown;
			window?: unknown;
		};
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: unknown;
			files?: unknown;
		};
		assert.equal(manifest.schema, 1);
		assert.equal(manifest.id, "omp-actual-terminal");
		assert.equal(manifest.name, "omp actual terminal");
		assert.equal(manifest.version, pkg.version);
		assert.equal(manifest.window, "window.luau");
		assert.equal(existsSync(join(packageDir, "window.luau")), true);
		assert.ok(Array.isArray(pkg.files));
		assert.ok((pkg.files as unknown[]).includes("tern-plugin"));
	});
});
