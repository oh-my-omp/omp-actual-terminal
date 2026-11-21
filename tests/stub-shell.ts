import { Settings } from "@oh-my-pi/pi-coding-agent";
import { type TerminalHost, terminalEnvFrom } from "../src/terminal-host.ts";

export const stubShellHost = {
	isCmdShell: (shell: string): boolean => /(^|[\\/])cmd(\.exe)?$/i.test(shell),
} as const;

/** This process's environment as a session shell would export it. */
export function processEnv(): Record<string, string> {
	return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function posixQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * A terminal host whose session shell is the `bash` on PATH: the seed is this process's
 * environment, nothing is mounted, no path is an internal URL, and approval always asks for exec.
 */
export function stubTerminalHost(overrides: Partial<TerminalHost> = {}): TerminalHost {
	const settings = Settings.isolated();
	return {
		get: () => undefined,
		settings,
		bash: () => ({
			approval: () => "exec",
			formatApprovalDetails: () => [],
			description: "stub bash",
		}),
		servicesEnabled: () => false,
		seed: async () => ({ env: processEnv(), script: "" }),
		mounts: async () => "",
		// A line break, not `;`: bash parses a line whole, so aliases the prelude defines reach only later lines.
		shellProcess: (spec) => ["bash", "-c", spec.source === undefined ? spec.command : `. ${posixQuote(spec.source)}\n${spec.command}`],
		terminalEnv: (exports) => terminalEnvFrom(exports, {}),
		urlPath: () => undefined,
		urlDirectory: async () => ({ kind: "unavailable", reason: "the stub host has no internal URLs" }),
		...overrides,
	};
}

/** The session-manager part of a tool call's context, as omp hands it to `execute`. */
export const STUB_SESSION = {
	sessionManager: { getSessionId: () => "stub-session", getSessionFile: () => undefined },
	localProtocolOptions: undefined,
} as const;
