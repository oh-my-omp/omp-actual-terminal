import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	buildShellCommand,
	chooseShell,
	findOnPath,
	IS_WINDOWS,
	resetDefaultShellCache,
	resolveBinary,
	resolveWindowsShell,
} from "../src/shell.ts";

const WIN_EXTS = [".exe", ".cmd", ".bat", ""];

const isCmdShell = (shell: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(shell);

const tempRoots: string[] = [];
function makePathDir(name: string, files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), `uexec-shell-${name}-`));
	tempRoots.push(dir);
	for (const f of files) {
		const full = join(dir, f);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, "");
	}
	return dir;
}

after(() => {
	for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
	resetDefaultShellCache();
});

describe("buildShellCommand", () => {
	it("POSIX shells get -c", () => {
		assert.deepEqual(buildShellCommand("bash", "echo hi"), ["bash", "-c", "echo hi"]);
		assert.deepEqual(buildShellCommand("sh", "ls"), ["sh", "-c", "ls"]);
		assert.deepEqual(buildShellCommand("zsh", "ls"), ["zsh", "-c", "ls"]);
	});

	it("absolute bash path still gets -c", () => {
		assert.deepEqual(buildShellCommand("/usr/bin/bash", "echo hi"), ["/usr/bin/bash", "-c", "echo hi"]);
	});

	it("Windows bash.exe path gets -c (extension and case insensitive)", () => {
		assert.deepEqual(buildShellCommand("C:\\Program Files\\Git\\bin\\BASH.EXE", "echo hi"), [
			"C:\\Program Files\\Git\\bin\\BASH.EXE",
			"-c",
			"echo hi",
		]);
	});

	it("powershell and pwsh allow PTY interaction with -NoProfile -NoLogo -Command", () => {
		const flags = ["-NoProfile", "-NoLogo", "-Command", "Get-Date"];
		assert.deepEqual(buildShellCommand("powershell", "Get-Date"), ["powershell", ...flags]);
		assert.deepEqual(buildShellCommand("pwsh", "Get-Date"), ["pwsh", ...flags]);
		assert.deepEqual(buildShellCommand("powershell.exe", "Get-Date"), ["powershell.exe", ...flags]);
	});

	it("multiline commands are passed through unchanged", () => {
		assert.deepEqual(buildShellCommand("bash", "echo one\necho two"), ["bash", "-c", "echo one\necho two"]);
	});
});

describe("findOnPath", () => {
	it("finds node (present in every test environment)", () => {
		assert.ok(findOnPath("node"), "expected node to be found on PATH");
	});

	it("returns undefined for a nonexistent binary or empty PATH", () => {
		assert.equal(findOnPath("definitely-not-a-real-binary-12345"), undefined);
		assert.equal(findOnPath("node", { PATH: "" }), undefined);
	});

	it("probes Windows extensions in order (.exe before .cmd before bare)", () => {
		const dir = makePathDir("exts", ["tool.exe", "tool.cmd", "tool"]);
		const found = findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS });
		assert.equal(found, join(dir, "tool.exe"));
	});

	it("falls through extensions to the bare name", () => {
		const dir = makePathDir("bare", ["tool"]);
		assert.equal(findOnPath("tool", { PATH: dir }, { exts: WIN_EXTS }), join(dir, "tool"));
	});

	it("earlier PATH entries win", () => {
		const first = makePathDir("first", ["tool.exe"]);
		const second = makePathDir("second", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: first + delimiter + second }, { exts: WIN_EXTS });
		assert.equal(found, join(first, "tool.exe"));
	});

	it("skips directories that match the name (only regular files count)", () => {
		const trap = mkdtempSync(join(tmpdir(), "uexec-shell-dirtrap-"));
		tempRoots.push(trap);
		mkdirSync(join(trap, "tool.exe")); // a DIRECTORY named tool.exe
		const real = makePathDir("real", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: trap + delimiter + real }, { exts: WIN_EXTS });
		assert.equal(found, join(real, "tool.exe"));
	});

	it("honors the exclude pattern", () => {
		const excluded = makePathDir("excl", ["tool.exe"]);
		const found = findOnPath("tool", { PATH: excluded }, { exts: WIN_EXTS, exclude: /uexec-shell-excl/ });
		assert.equal(found, undefined);
	});
});

describe("resolveWindowsShell", () => {
	it("resolves bare names to absolute .exe paths", () => {
		const dir = makePathDir("ws", ["myshell.exe"]);
		assert.equal(resolveWindowsShell("myshell", { PATH: dir }), join(dir, "myshell.exe"));
	});

	it("fails closed on unresolvable bare names (no cwd-first spawn)", () => {
		assert.throws(() => resolveWindowsShell("nonexistent-shell-4711", { PATH: "" }), /not found on PATH/);
	});

	it("does not resolve to .cmd/.bat (Node cannot spawn them directly)", () => {
		const dir = makePathDir("wscmd", ["wrapper.cmd", "wrapper.bat"]);
		assert.throws(() => resolveWindowsShell("wrapper", { PATH: dir }), /not found on PATH/);
	});

	it("passes explicit paths through", () => {
		assert.equal(resolveWindowsShell("C:\\tools\\x.exe", { PATH: "" }), "C:\\tools\\x.exe");
	});

	it("OMP_ACTUAL_TERMINAL_BASH names the bash that a bash name resolves to", () => {
		const override = makePathDir("envbash", ["custom-bash.exe"]);
		const pathDir = makePathDir("pathbash", ["bash.exe"]);
		const env = { PATH: pathDir, OMP_ACTUAL_TERMINAL_BASH: join(override, "custom-bash.exe") };
		assert.equal(resolveWindowsShell("bash", env), join(override, "custom-bash.exe"));
		assert.equal(resolveWindowsShell("bash.exe", env), join(override, "custom-bash.exe"));
	});

	it("ignores OMP_ACTUAL_TERMINAL_BASH for other shells and when it names no file", () => {
		const override = makePathDir("envbash2", ["custom-bash.exe"]);
		const pathDir = makePathDir("pathbash2", ["powershell.exe", "bash.exe"]);
		assert.equal(
			resolveWindowsShell("powershell", { PATH: pathDir, OMP_ACTUAL_TERMINAL_BASH: join(override, "custom-bash.exe") }),
			join(pathDir, "powershell.exe"),
		);
		assert.equal(
			resolveWindowsShell("bash", { PATH: pathDir, OMP_ACTUAL_TERMINAL_BASH: join(override, "nope.exe") }),
			join(pathDir, "bash.exe"),
		);
	});

	it("keeps a bash name off System32's WSL stub", () => {
		const stub = makePathDir("sys", ["System32/bash.exe"]);
		const git = makePathDir("gitbin", ["bash.exe"]);
		assert.equal(
			resolveWindowsShell("bash", { PATH: join(stub, "System32") + delimiter + git }),
			join(git, "bash.exe"),
		);
		assert.throws(() => resolveWindowsShell("bash", { PATH: join(stub, "System32") }), /pi-shell/);
	});

	it("unresolvable bash points at pi-shell and OMP_ACTUAL_TERMINAL_BASH", () => {
		assert.throws(() => resolveWindowsShell("bash", { PATH: "" }), /OMP_ACTUAL_TERMINAL_BASH/);
		assert.throws(() => resolveWindowsShell("bash", { PATH: "" }), /pi-shell/);
	});
});

describe("chooseShell", () => {
	it("a missing or blank shell is the session's shell", () => {
		for (const requested of [undefined, "", " \t\n"]) {
			assert.deepEqual(chooseShell(requested, isCmdShell), { kind: "session" });
		}
	});

	it("keeps the caller's trimmed choice, even one not on PATH", () => {
		assert.deepEqual(chooseShell("  /bin/zsh \n", isCmdShell), { kind: "explicit", shell: "/bin/zsh" });
		assert.deepEqual(chooseShell("nonexistent-host-shell-4711", isCmdShell), { kind: "explicit", shell: "nonexistent-host-shell-4711" });
	});

	it("refuses cmd but keeps a shell that merely contains the name", () => {
		for (const shell of ["C:\\Windows\\System32\\cmd.exe", "cmd", " cmd.exe "]) {
			assert.deepEqual(chooseShell(shell, isCmdShell), { kind: "refused", shell: shell.trim(), reason: "cmd" });
		}
		assert.deepEqual(chooseShell("C:\\tools\\cmdline.exe", isCmdShell), { kind: "explicit", shell: "C:\\tools\\cmdline.exe" });
	});
});

describe("resolveBinary", () => {
	it("passes through names with a directory component", () => {
		assert.equal(resolveBinary("/usr/bin/bash"), "/usr/bin/bash");
		assert.equal(resolveBinary("C:\\tools\\thing.exe"), "C:\\tools\\thing.exe");
	});

	it("resolves bare names via the provided env PATH", () => {
		const dir = makePathDir("rb", IS_WINDOWS ? ["mytool.exe"] : ["mytool"]);
		assert.equal(resolveBinary("mytool", { PATH: dir }), join(dir, IS_WINDOWS ? "mytool.exe" : "mytool"));
	});

	it("returns the bare name when unresolvable", () => {
		assert.equal(resolveBinary("definitely-not-real-98765", { PATH: "" }), "definitely-not-real-98765");
	});

	it("caches no-env resolutions across PATH changes (production path)", () => {
		resetDefaultShellCache();
		const dir = makePathDir("rbcache", IS_WINDOWS ? ["cachetool.exe"] : ["cachetool"]);
		const savedPath = process.env.PATH;
		try {
			process.env.PATH = dir;
			const first = resolveBinary("cachetool");
			assert.equal(first, join(dir, IS_WINDOWS ? "cachetool.exe" : "cachetool"));
			process.env.PATH = ""; // a fresh lookup would now fail...
			assert.equal(resolveBinary("cachetool"), first); // ...but the cache holds
		} finally {
			process.env.PATH = savedPath;
			resetDefaultShellCache();
		}
	});

	it("resolves relative PATH entries to absolute paths", () => {
		const found = findOnPath("node", { PATH: process.env.PATH ?? "" });
		assert.ok(found);
		const dir = makePathDir("rel", IS_WINDOWS ? ["reltool.exe"] : ["reltool"]);
		const cwd = process.cwd();
		try {
			process.chdir(join(dir, ".."));
			const rel = dir.slice(join(dir, "..").length + 1); // relative dir name
			const hit = findOnPath("reltool", { PATH: rel }, { exts: IS_WINDOWS ? [".exe"] : [""] });
			assert.ok(hit && (hit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(hit)), `not absolute: ${hit}`);
		} finally {
			process.chdir(cwd);
		}
	});
});
