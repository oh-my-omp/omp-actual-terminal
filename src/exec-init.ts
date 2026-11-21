import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { IS_WINDOWS, isPosixShell, type LaunchShell, shellBase } from "./shell.ts";
import type { PluginSettingsReader } from "./plugin-settings.ts";

export const INIT_FILE_KEY = "exec.initFile";

export type InitFile =
	| { readonly kind: "none" }
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "invalid"; readonly reason: string };

export function resolveInitPath(raw: string, cwd: string, home: string): string {
	if (raw === "~") return home;
	if (raw.startsWith("~/") || (IS_WINDOWS && raw.startsWith("~\\"))) return resolve(home, raw.slice(2));
	return resolve(cwd, raw);
}

export function parseInitFile(settings: Readonly<Record<string, unknown>>, cwd: string, home: string = homedir()): InitFile {
	const raw = settings[INIT_FILE_KEY];
	if (raw === undefined) return { kind: "none" };
	if (typeof raw !== "string") return { kind: "invalid", reason: `plugin setting ${INIT_FILE_KEY} must be a string path` };
	const trimmed = raw.trim();
	if (trimmed === "") return { kind: "none" };
	const path = resolveInitPath(trimmed, cwd, home);
	try {
		if (statSync(path).isFile()) return { kind: "file", path };
		return { kind: "invalid", reason: `${INIT_FILE_KEY} is not a regular file: ${path}` };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { kind: "invalid", reason: code === "ENOENT" ? `${INIT_FILE_KEY} does not exist: ${path}` : `${INIT_FILE_KEY} is unreadable: ${path} (${code ?? String(error)})` };
	}
}

export async function loadInitFile(read: PluginSettingsReader | undefined, cwd: string): Promise<InitFile> {
	if (!read) return { kind: "none" };
	let settings: Readonly<Record<string, unknown>>;
	try {
		settings = await read(cwd);
	} catch (error) {
		return { kind: "invalid", reason: `could not read plugin settings for ${INIT_FILE_KEY}: ${error instanceof Error ? error.message : String(error)}` };
	}
	return parseInitFile(settings, cwd);
}

function posixQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

const STATUS_VAR = "__omp_actual_terminal_init_status";

export type ShellScript =
	| { readonly kind: "ready"; readonly cmd: string }
	| { readonly kind: "unusable"; readonly reason: string };

export function shellScript(initFile: InitFile, shell: LaunchShell, cmd: string, isWindows: boolean = IS_WINDOWS): ShellScript {
	switch (initFile.kind) {
		case "none":
			return { kind: "ready", cmd };
		case "invalid":
			return { kind: "unusable", reason: initFile.reason };
		case "file":
			break;
	}
	const bash = shell.kind === "pi-shell" || shellBase(shell.shell) === "bash";
	if (shell.kind === "shell" && !isPosixShell(shell.shell)) {
		return { kind: "unusable", reason: `${INIT_FILE_KEY} is a POSIX shell script; ${shell.shell} is not sh, bash, dash, ash, ksh or zsh. Unset ${INIT_FILE_KEY} or run the command under a POSIX shell.` };
	}
	const sourced = isWindows ? initFile.path.replaceAll("\\", "/") : initFile.path;
	const lines = [
		...(bash ? ["shopt -s expand_aliases"] : []),
		`. ${posixQuote(sourced)}`,
		`${STATUS_VAR}=$?`,
		`if [ "$${STATUS_VAR}" -ne 0 ]; then exit "$${STATUS_VAR}"; fi`,
		`unset ${STATUS_VAR}`,
		`eval ${posixQuote(cmd)}`,
	];
	return { kind: "ready", cmd: lines.join("\n") };
}
