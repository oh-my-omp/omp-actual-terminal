import { spawn as cpSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";

import { findOnPath, IS_WINDOWS, isFile, resolveBinary } from "./shell.ts";

export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 80;

export interface SpawnOptions {
	command: string[];
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

type BunPtyProcess = Pick<Bun.Subprocess, "pid" | "terminal">;

type BunPtySpawnOptions = Pick<Bun.SpawnOptions.SpawnOptions<"ignore", "pipe", "inherit">, "cwd" | "env"> & {
	terminal: Required<Pick<Bun.TerminalOptions, "name" | "cols" | "rows" | "data" | "exit">>;
	onExit(
		subprocess: BunPtyProcess,
		exitCode: number | null,
		signalCode: NodeJS.Signals | number | null,
		error?: Bun.ErrorLike,
	): void;
};

export type BunPtyRuntime = {
	spawn(command: string[], options: BunPtySpawnOptions): BunPtyProcess;
};

type BunHost = Pick<typeof Bun, "spawn" | "Terminal">;

function providesBunPty(candidate: object): candidate is BunHost {
	return typeof Reflect.get(candidate, "spawn") === "function" && typeof Reflect.get(candidate, "Terminal") === "function";
}

export function requireBunRuntime(
	candidate: unknown = Reflect.get(globalThis, "Bun"),
): BunPtyRuntime {
	const requirement = "omp-unified-exec requires a Bun host with Bun.Terminal";
	if ((typeof candidate !== "object" || candidate === null) && typeof candidate !== "function") {
		throw new Error(`${requirement}; the current runtime is not Bun. Load this plugin in omp.`);
	}
	if (!providesBunPty(candidate)) {
		const version = Reflect.get(candidate, "version");
		throw new Error(
			`${requirement}; Bun ${typeof version === "string" ? version : "unknown"} does not provide Bun.spawn with Bun.Terminal support. Upgrade the omp/Bun host.`,
		);
	}
	return candidate;
}

const SIGNAL_NAMES: Record<number, NodeJS.Signals> = {};
for (const [name, num] of Object.entries(osConstants.signals)) {
	if (SIGNAL_NAMES[num] === undefined) SIGNAL_NAMES[num] = name as NodeJS.Signals;
}

export function signalNameFromNumber(num: number): NodeJS.Signals | null {
	return SIGNAL_NAMES[num] ?? null;
}

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
		return;
	}
}

function sendSignal(pid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

function notifyEach<A extends unknown[]>(handlers: Iterable<(...args: A) => void>, ...args: A): void {
	for (const handler of handlers) {
		try {
			handler(...args);
		} catch {
			continue;
		}
	}
}

function killPosixProcessGroup(pid: number, signal: NodeJS.Signals): void {
	if (!sendSignal(-pid, signal)) sendSignal(pid, signal);
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

export function spawnBunPty(runtime: BunPtyRuntime, opts: SpawnOptions): SpawnedChild {
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
	let terminal: Bun.Terminal | undefined;
	let bufferingInitialData = true;
	let pendingData: Uint8Array[] = [];

	const emitData = (chunk: Uint8Array) => {
		if (finalized) return;
		if (bufferingInitialData) {
			pendingData.push(chunk.slice());
			return;
		}
		notifyEach(dataHandlers, chunk);
	};

	const finalize = () => {
		if (finalized || !terminalClosed || !processExit) return;
		finalized = true;
		notifyEach(exitHandlers, processExit.exitCode, processExit.signal, processExit.failureMessage);
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
			notifyEach(processExitHandlers, processExit);
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
			for (const chunk of pendingData) notifyEach([handler], chunk);
			pendingData = [];
			if (finalized) return () => {};
			dataHandlers.add(handler);
			return () => dataHandlers.delete(handler);
		},
		onExit(handler) {
			if (finalized) {
				const exit = processExit;
				if (!exit) return;
				notifyEach([handler], exit.exitCode, exit.signal, exit.failureMessage);
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
				if (!processExited) killWindowsTree(child.pid);
				return;
			}
			if (!processExited) {
				killPosixProcessGroup(child.pid, signal);
				return;
			}
			sendSignal(-child.pid, signal);
		},
		signalGroup(signal) {
			if (IS_WINDOWS) return false;
			return sendSignal(-child.pid, signal);
		},
	};
}

