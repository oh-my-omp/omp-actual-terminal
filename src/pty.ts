import { spawn as cpSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";

import { findOnPath, IS_WINDOWS, isFile, resolveBinary } from "./shell.ts";

export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 80;

export interface SpawnOptions {
	command: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	cols?: number;
	rows?: number;
}

export type ExitCallback = (
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	failureMessage?: string,
) => void;

export interface SpawnedChild {
	readonly pid: number | undefined;
	readonly processExited: boolean;
	readonly processExit: ProcessExit | undefined;
	write(data: Uint8Array): boolean;
	onData(handler: (chunk: Uint8Array) => void): () => void;
	onExit(handler: ExitCallback): void;
	onProcessExit(handler: (exit: ProcessExit) => void): () => void;
	kill(signal?: NodeJS.Signals): void;
	signalGroup(signal: NodeJS.Signals | 0): boolean;
}

type BunTerminal = {
	readonly closed: boolean;
	write(data: Uint8Array): number;
	close(): void;
};

type BunSubprocess = {
	readonly pid: number;
	readonly terminal?: BunTerminal;
	kill(signal?: NodeJS.Signals): void;
};

type BunSpawnOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	terminal: {
		name: string;
		cols: number;
		rows: number;
		data(terminal: BunTerminal, data: Uint8Array): void;
		exit(
			terminal: BunTerminal,
			exitCode: number | null,
			signalCode: number | string | null,
			error?: Error,
		): void;
	};
	onExit(
		subprocess: BunSubprocess,
		exitCode: number | null,
		signalCode: number | string | null,
		error?: Error,
	): void;
};

type BunRuntime = {
	readonly version?: string;
	spawn(command: string[], options: BunSpawnOptions): BunSubprocess;
};

export function requireBunRuntime(
	candidate: unknown = Reflect.get(globalThis, "Bun"),
): BunRuntime {
	const requirement = "omp-actual-terminal requires a Bun host with Bun.Terminal";
	if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") {
		throw new Error(`${requirement}; the current runtime is not Bun. Load this plugin in omp.`);
	}
	const fields = candidate as Record<string, unknown>;
	const version = typeof fields.version === "string" ? fields.version : "unknown";
	if (typeof fields.spawn !== "function" || typeof fields.Terminal !== "function") {
		throw new Error(
			`${requirement}; Bun ${version} does not provide Bun.spawn with Bun.Terminal support. Upgrade the omp/Bun host.`,
		);
	}
	return candidate as BunRuntime;
}

const SIGNAL_NAMES: Record<number, NodeJS.Signals> = {};
for (const [name, num] of Object.entries(osConstants.signals)) {
	if (SIGNAL_NAMES[num] === undefined) SIGNAL_NAMES[num] = name as NodeJS.Signals;
}

export function signalNameFromNumber(num: number): NodeJS.Signals | null {
	return SIGNAL_NAMES[num] ?? null;
}

/**
 * Killing only the
 * direct child (the shell) leaves grandchildren alive holding the console
 * open, which delays the terminal's exit indefinitely and orphans the
 * subtree.
 */
/**
 * Never spawn the bare name: Windows'
 * CreateProcess checks the parent's cwd before PATH, so a taskkill.exe
 * planted in an untrusted repository would execute with every kill.
 */
function taskkillPath(): string {
	const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	return `${root}\\System32\\taskkill.exe`;
}

function killWindowsTree(pid: number): void {
	try {
		const tk = cpSpawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		tk.on("error", () => {});
	} catch {
	}
}

function killPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
		}
	}
}

function assertSpawnable(opts: SpawnOptions): void {
	const file = opts.command[0];
	if (!file) throw new Error("spawnChild: empty command");
	const found = /[\\/]/.test(file) ? isFile(resolvePath(opts.cwd, file)) : findOnPath(file, opts.env) !== undefined;
	if (!found) throw new Error(`spawn ${file} ENOENT: shell binary not found (check shell binary and workdir: ${opts.cwd})`);
}

export function spawnChild(opts: SpawnOptions): SpawnedChild {
	assertSpawnable(opts);
	return spawnBunPty(requireBunRuntime(), opts);
}

export type ProcessExit = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	failureMessage?: string;
};

function bunSignalName(signalCode: number | string | null): NodeJS.Signals | null {
	if (typeof signalCode === "number") return signalCode === 0 ? null : signalNameFromNumber(signalCode);
	if (
		typeof signalCode === "string" &&
		Object.prototype.hasOwnProperty.call(osConstants.signals, signalCode)
	) {
		return signalCode as NodeJS.Signals;
	}
	return null;
}

export function spawnBunPty(runtime: BunRuntime, opts: SpawnOptions): SpawnedChild {
	let [file, ...args] = opts.command;
	if (!file) throw new Error("spawnChild: empty command");
	if (IS_WINDOWS) file = resolveBinary(file);

	const dataHandlers = new Set<(chunk: Uint8Array) => void>();
	const exitHandlers = new Set<ExitCallback>();
	const processExitHandlers = new Set<(exit: ProcessExit) => void>();
	let processExited = false;
	let terminalClosed = false;
	let finalized = false;
	let processExit: ProcessExit | undefined;
	let terminal: BunTerminal | undefined;
	let bufferingInitialData = true;
	let pendingData: Uint8Array[] = [];

	const emitData = (chunk: Uint8Array) => {
		if (finalized) return;
		if (bufferingInitialData) {
			// Bun may invoke terminal callbacks before spawn() returns. Preserve
			// those bytes until ExecSession can subscribe to the returned child.
			pendingData.push(chunk.slice());
			return;
		}
		for (const handler of dataHandlers) {
			try {
				handler(chunk);
			} catch {
			}
		}
	};

	const finalize = () => {
		if (finalized || !terminalClosed || !processExit) return;
		finalized = true;
		for (const handler of exitHandlers) {
			try {
				handler(processExit.exitCode, processExit.signal, processExit.failureMessage);
			} catch {
			}
		}
		exitHandlers.clear();
		dataHandlers.clear();
	};

	const child = runtime.spawn([file, ...args], {
		cwd: opts.cwd,
		env: { ...opts.env, TERM: "xterm-256color" },
		terminal: {
			name: "xterm-256color",
			cols: opts.cols ?? DEFAULT_PTY_COLS,
			rows: opts.rows ?? DEFAULT_PTY_ROWS,
			data(activeTerminal, chunk) {
				terminal = activeTerminal;
				emitData(chunk);
			},
			exit(activeTerminal) {
				terminal = activeTerminal;
				terminalClosed = true;
				finalize();
			},
		},
		onExit(subprocess, exitCode, signalCode, error) {
			processExited = true;
			terminal = subprocess.terminal ?? terminal;
			const signal = bunSignalName(signalCode);
			processExit = {
				exitCode: signal ? null : exitCode,
				signal,
				...(error ? { failureMessage: `process error: ${error.message}` } : {}),
			};
			if (terminal?.closed) terminalClosed = true;
			const exit = processExit;
			for (const handler of processExitHandlers) {
				try {
					handler(exit);
				} catch {
				}
			}
			processExitHandlers.clear();
			finalize();
		},
	});
	terminal = child.terminal;
	if (!terminal) throw new Error("Bun.spawn did not return a terminal");

	return {
		pid: child.pid,
		get processExited() {
			return processExited;
		},
		get processExit() {
			return processExit;
		},
		write(data) {
			const activeTerminal = terminal;
			if (finalized || processExited || !activeTerminal || activeTerminal.closed) return false;
			try {
				activeTerminal.write(data);
				return true;
			} catch {
				return false;
			}
		},
		onData(handler) {
			bufferingInitialData = false;
			for (const chunk of pendingData) {
				try {
					handler(chunk);
				} catch {
				}
			}
			pendingData = [];
			if (finalized) return () => {};
			dataHandlers.add(handler);
			return () => dataHandlers.delete(handler);
		},
		onExit(handler) {
			if (finalized) {
				const exit = processExit;
				if (!exit) return;
				try {
					handler(exit.exitCode, exit.signal, exit.failureMessage);
				} catch {
				}
				return;
			}
			exitHandlers.add(handler);
		},
		onProcessExit(handler) {
			if (processExit) {
				const exit = processExit;
				let active = true;
				queueMicrotask(() => {
					if (active) handler(exit);
				});
				return () => {
					active = false;
				};
			}
			processExitHandlers.add(handler);
			return () => processExitHandlers.delete(handler);
		},
		kill(signal = "SIGTERM") {
			if (finalized) return;
			if (IS_WINDOWS) {
				// taskkill /T cannot walk a tree whose root has exited.
				if (!processExited) killWindowsTree(child.pid);
				return;
			}
			if (!processExited) {
				killPosixProcessGroup(child.pid, signal);
				return;
			}
			try {
				process.kill(-child.pid, signal);
			} catch {
			}
		},
		signalGroup(signal) {
			if (IS_WINDOWS) return false;
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch {
				return false;
			}
		},
	};
}

