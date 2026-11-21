import { statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

const WINDOWS_EXEC_EXTS = [".com", ".exe", ".bat", ".cmd", ""];

const WINDOWS_SHELL_EXTS = [".com", ".exe"];

export function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

export function shellBase(shellBin: string): string {
	const base = shellBin.split(/[\\/]/).pop() ?? shellBin;
	return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

const POSIX_SHELL_PATTERN = /(?:^|[\\/])(?:sh|bash|dash|ash|ksh|zsh)(?:\.exe)?$/i;

export function isPosixShell(shell: string): boolean {
	return POSIX_SHELL_PATTERN.test(shell);
}

export function buildShellCommand(shellBin: string, cmd: string): string[] {
	const base = shellBase(shellBin);
	if (base === "powershell" || base === "pwsh") {
		// No -NonInteractive: in a PTY it
		// would block interactive prompts the session is meant to answer.
		return [shellBin, "-NoProfile", "-NoLogo", "-Command", cmd];
	}
	return [shellBin, "-c", cmd];
}

export interface FindOnPathOptions {
	exts?: string[];
	exclude?: RegExp;
}

export function findOnPath(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	opts: FindOnPathOptions = {},
): string | undefined {
	const pathVar = env.PATH ?? env.Path ?? "";
	const exts = opts.exts ?? (IS_WINDOWS ? WINDOWS_EXEC_EXTS : [""]);
	for (const dir of pathVar.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			// resolve() (not join): a relative PATH entry must not yield a
			// cwd-dependent result that breaks when spawned from another cwd.
			const full = resolve(dir, bin + ext);
			if (opts.exclude?.test(full)) continue;
			if (isFile(full)) return full;
		}
	}
	return undefined;
}

export type LaunchShell =
	| {
		readonly kind: "pi-shell";
		readonly shell: string;
	}
	| {
		readonly kind: "shell";
		readonly shell: string;
	};

export type ShellSource = "call" | "shellPath" | "SHELL";

export type ShellChoice =
	| LaunchShell
	| {
		readonly kind: "refused";
		readonly shell: string;
		readonly reason: "cmd";
		readonly source: ShellSource;
	};

export interface DefaultShellOptions {
	readonly omp?: string;
	readonly isWindows?: boolean;
	readonly requestedSource?: "call" | "shellPath";
	readonly isCmdShell: (shell: string) => boolean;
}

export function resolveDefaultShell(
	env: NodeJS.ProcessEnv | undefined,
	requested: string | undefined,
	options: DefaultShellOptions,
): ShellChoice {
	const choice = requested?.trim();
	const explicit = choice || (env ?? process.env).SHELL?.trim();
	if (explicit) {
		return options.isCmdShell(explicit)
			? { kind: "refused", shell: explicit, reason: "cmd", source: choice ? (options.requestedSource ?? "call") : "SHELL" }
			: { kind: "shell", shell: explicit };
	}
	if (options.isWindows ?? IS_WINDOWS) return { kind: "pi-shell", shell: options.omp ?? process.execPath };
	return { kind: "shell", shell: "bash" };
}

export function shellArgv(shell: LaunchShell, cmd: string): string[] {
	switch (shell.kind) {
		case "pi-shell":
			return [shell.shell, "bash", "-c", cmd];
		case "shell":
			return buildShellCommand(shell.shell, cmd);
	}
}

const resolvedBinaryCache = new Map<string, string>();

/**
 * Spawning the resolved absolute path (instead of the bare name) keeps the
 * probed binary and the spawned binary identical, and avoids Windows'
 * CreateProcess cwd-first lookup — a `bash.exe` planted in an untrusted
 * workdir must not shadow the real shell.
 */
export function resolveBinary(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin;
	if (env) return findOnPath(bin, env) ?? bin; // test hook: no caching
	const cached = resolvedBinaryCache.get(bin);
	if (cached) return cached;
	const resolved = findOnPath(bin) ?? bin;
	resolvedBinaryCache.set(bin, resolved);
	return resolved;
}

const SYSTEM32_RE = /[\\/]system32[\\/]/i;

/**
 * Unlike resolveBinary, an unresolvable bare name throws instead of passing
 * through: spawning a bare name lets CreateProcess check the child's cwd
 * (the LLM-supplied workdir) first, so "powershell" with a mangled PATH
 * would happily execute an attacker's powershell.exe from an untrusted
 * repo. Only .com/.exe are accepted (Node can't spawn .cmd/.bat directly).
 */
export function resolveWindowsShell(bin: string, env?: NodeJS.ProcessEnv): string {
	if (/[\\/]/.test(bin)) return bin; // explicit path: caller's responsibility
	const cacheKey = `shell:${bin}`;
	if (!env) {
		const cached = resolvedBinaryCache.get(cacheKey);
		if (cached) return cached;
	}
	const effectiveEnv = env ?? process.env;
	const bash = bin.replace(/\.(exe|com)$/i, "").toLowerCase() === "bash";
	const override = bash ? effectiveEnv.OMP_ACTUAL_TERMINAL_BASH?.trim() : undefined;
	const found = override && isFile(override)
		? override
		// A bash name must not land on System32's WSL stub (a different OS view).
		: findOnPath(bin, effectiveEnv, { exts: WINDOWS_SHELL_EXTS, exclude: bash ? SYSTEM32_RE : undefined });
	if (!found) {
		throw new Error(
			bash
				? `bash not found on PATH (searched ${WINDOWS_SHELL_EXTS.join("/")}). Install Git for Windows, set OMP_ACTUAL_TERMINAL_BASH to your bash.exe, or omit shell to run in omp's pi-shell (omp bash).`
				: `shell "${bin}" not found on PATH (searched ${WINDOWS_SHELL_EXTS.join("/")}). Pass an absolute path, or use "powershell" or an installed bash.`,
		);
	}
	if (!env) resolvedBinaryCache.set(cacheKey, found);
	return found;
}

export function resetDefaultShellCache(): void {
	resolvedBinaryCache.clear();
}
