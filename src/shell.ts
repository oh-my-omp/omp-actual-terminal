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

/**
 * The shell a terminal runs: the session's own shell (omp's shell process, started from the
 * session shell's state), or the shell the call names.
 */
export type TerminalShell =
	| { readonly kind: "session" }
	| { readonly kind: "explicit"; readonly shell: string };

export type ShellChoice =
	| TerminalShell
	| { readonly kind: "refused"; readonly shell: string; readonly reason: "cmd" };

/** A blank `shell` argument is no choice; cmd is never launched. */
export function chooseShell(requested: string | undefined, isCmdShell: (shell: string) => boolean): ShellChoice {
	const choice = requested?.trim();
	if (!choice) return { kind: "session" };
	return isCmdShell(choice) ? { kind: "refused", shell: choice, reason: "cmd" } : { kind: "explicit", shell: choice };
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
