import { Settings } from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
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

/** The session-manager part of a tool call's context, as omp hands it to `execute`, with the calling agent. */
export const STUB_SESSION = {
	sessionManager: { getSessionId: () => "stub-session", getSessionFile: () => undefined },
	localProtocolOptions: undefined,
	agent: { id: "Main" },
} as const;

/**
 * omp's own job manager, as a root session owns it: the stub registry resolves every agent id to a
 * root session holding it, so terminals bind and become real omp jobs.
 */
export function stubJobManager(maxRunningJobs = 100): AsyncJobManager {
	return new AsyncJobManager({ maxRunningJobs });
}

/** A registry entry for `agentId`: a root agent whose session is the stub session with `jobs`. */
function stubAgentRef(agentId: string, settings: Settings, jobs: AsyncJobManager): AgentRef {
	const session = {
		settings,
		sessionManager: STUB_SESSION.sessionManager,
		skills: [],
		getImageAttachments: () => [],
		asyncJobManager: jobs,
	};
	return {
		id: agentId, generation: 1, displayName: agentId, kind: "main", status: "running",
		session: session as unknown as AgentSessionHandle, sessionFile: null, createdAt: 0, lastActivity: 0,
	};
}

/**
 * A terminal host whose session shell is the `bash` on PATH: the seed is this process's
 * environment, nothing is mounted, no path is an internal URL, and approval always asks for exec.
 * Its registry binds every agent to a root session whose terminals are jobs of `jobs`.
 */
export function stubTerminalHost(overrides: Partial<TerminalHost> = {}, jobs: AsyncJobManager = stubJobManager()): TerminalHost {
	const settings = Settings.isolated();
	return {
		get: (agentId) => stubAgentRef(agentId, settings, jobs),
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
