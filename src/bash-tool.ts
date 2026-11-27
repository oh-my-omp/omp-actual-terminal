import { Type, type Static, type TSchema } from "@oh-my-pi/omptype/typebox";

import type { OnExitPolicy } from "./completion.ts";
import { DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS } from "./pty.ts";
import { MAX_TITLE_CHARS, parseTerminalTitle } from "./terminal-notice.ts";

export const MIN_YIELD_TIME_MS = 250;
export const MAX_YIELD_TIME_MS = 30_000;
export const DEFAULT_TERMINAL_YIELD_MS = 10_000;
export const MIN_PTY_COLS = 20;
export const MAX_PTY_COLS = 500;
export const MIN_PTY_ROWS = 5;
export const MAX_PTY_ROWS = 300;

const PTY_ONLY = "Only with `pty: true`";

const baseFields = {
	command: Type.String({ description: "Shell command. Without `pty: true` it runs in omp's embedded shell; with `pty: true`, in the terminal's shell." }),
	timeout: Type.Optional(Type.Number({
		description: "Seconds. Without `pty: true`: the command deadline, default 300; 0 disables it; nonzero values are clamped to 1-3600. With `pty: true`: omitted or 0, the terminal has no deadline; a positive value ends the terminal at that time and reports it as an abnormal return.",
	})),
	cwd: Type.Optional(Type.String({ description: "Working directory: a host path, relative to the session cwd, or a URL directory such as `local://`. Defaults to the session cwd." })),
	pty: Type.Optional(Type.Boolean({ description: "`true`: run `command` in a terminal of its own that outlives this call (`help://bash/terminal`). Omitted or `false`: a finite command." })),
	async: Type.Optional(Type.Boolean({
		description: "Without `pty: true`: run as a background job whose result arrives as a follow-up (needs `async.enabled`). With `pty: true`: return the terminal's `job_id` at once, without waiting for output.",
	})),
	notify: Type.Optional(Type.String({
		description: "Regex. Without `pty: true`, or with `name` (Rust syntax): each matching output line arrives as a follow-up while the command or service runs; a command without `name` becomes a background job like `async`. With `pty: true` and no `name` (JavaScript regex source, no `/` delimiters): starts a `monitor` on the terminal with it as `condition`.",
	})),
	title: Type.Optional(Type.String({
		description: `${PTY_ONLY}, and required there: terminal name in list_sessions, omp's jobs page, the Console and every notice; one nonblank line, at most ${MAX_TITLE_CHARS} characters kept.`,
	})),
	shell: Type.Optional(Type.String({
		description: `${PTY_ONLY}: shell executable to run instead of the session's shell; the terminal keeps the session shell's environment but not its functions, aliases or URL paths. cmd is refused. Write \`command\` in that shell's syntax.`,
	})),
	cols: Type.Optional(Type.Number({ description: `${PTY_ONLY}: terminal width in columns. Default ${DEFAULT_PTY_COLS}, clamped to [${MIN_PTY_COLS}, ${MAX_PTY_COLS}].` })),
	rows: Type.Optional(Type.Number({ description: `${PTY_ONLY}: terminal height in rows. Default ${DEFAULT_PTY_ROWS}, clamped to [${MIN_PTY_ROWS}, ${MAX_PTY_ROWS}].` })),
	yield_time_ms: Type.Optional(Type.Number({
		description: `${PTY_ONLY}: how long (ms) this call waits for output before returning. Default ${DEFAULT_TERMINAL_YIELD_MS}, clamped to [${MIN_YIELD_TIME_MS}, ${MAX_YIELD_TIME_MS}].`,
	})),
	on_exit: Type.Optional(Type.Enum(["none", "wake"], {
		description: `${PTY_ONLY}: "none" (default). "wake": resume you once when the process exits unobserved; only when the human explicitly asks, never for servers or watchers. A tool result observing the exit consumes it; set_on_exit changes it.`,
	})),
};

const serviceFields = {
	name: Type.Optional(Type.String({
		pattern: "^(?:\\s*|[A-Za-z0-9][A-Za-z0-9._-]{0,47})$",
		description: "Starts a long-lived supervised service under this name; omit for finite commands, async jobs included. 1-48 of [A-Za-z0-9._-], starting with a letter or digit.",
	})),
	ready: Type.Optional(Type.Object({
		log: Type.Optional(Type.String({ description: "Regex an output line matches once the service is ready." })),
		port: Type.Optional(Type.Number({ description: "TCP port the service accepts connections on once ready." })),
		host: Type.Optional(Type.String({ description: "Host for the port probe; default localhost (127.0.0.1 and ::1)." })),
		timeout: Type.Optional(Type.Number({ description: "Seconds to wait for readiness; default 30." })),
	}, { description: "Service readiness; needs log or port.", additionalProperties: false })),
};

/** Every field the plugin's `bash` declares; the session's schema leaves out the service fields while services are off. */
export const BASH_PARAMETERS = Type.Object({ ...baseFields, ...serviceFields }, { additionalProperties: false });
const BASH_PARAMETERS_WITHOUT_SERVICES = Type.Object(baseFields, { additionalProperties: false });

export type BashParams = Static<typeof BASH_PARAMETERS>;

/** The two shapes of the plugin's `bash` schema. */
export type BashSchema = typeof BASH_PARAMETERS | typeof BASH_PARAMETERS_WITHOUT_SERVICES;

export function bashParameters(services: boolean): BashSchema {
	return services ? BASH_PARAMETERS : BASH_PARAMETERS_WITHOUT_SERVICES;
}

/** Fields that only shape a terminal; a call that does not open one must not carry them. */
const TERMINAL_FIELDS = ["title", "shell", "cols", "rows", "yield_time_ms", "on_exit"] as const satisfies readonly (keyof BashParams)[];

export type Deadline = { readonly kind: "none" } | { readonly kind: "after"; readonly seconds: number };

export interface TerminalRequest {
	readonly command: string;
	readonly cwd: string | undefined;
	readonly title: string;
	readonly shell: string | undefined;
	readonly cols: number | undefined;
	readonly rows: number | undefined;
	readonly yieldTimeMs: number | undefined;
	readonly onExit: OnExitPolicy | undefined;
	readonly deadline: Deadline;
	/** Return at once instead of waiting for output. */
	readonly detached: boolean;
	/** Regex source of a monitor to start on the terminal. */
	readonly notify: string | undefined;
}

export type BashCall =
	| { readonly kind: "native"; readonly params: BashParams }
	| { readonly kind: "terminal"; readonly request: TerminalRequest };

/** Splits a validated `bash` call into omp's own bash and the plugin's terminal; throws for a call neither accepts. */
export function parseBashCall(input: unknown): BashCall {
	const parsed = BASH_PARAMETERS.safeParse(input);
	if (!parsed.success) throw new Error(`bash: ${parsed.error.message}`);
	const params = parsed.data;
	const service = params.name;
	if (params.pty !== true || service !== undefined) {
		const stray = TERMINAL_FIELDS.filter((field) => params[field] !== undefined);
		if (stray.length > 0) {
			const fields = stray.map((field) => `\`${field}\``).join(", ");
			const [applies, them] = stray.length === 1 ? ["applies", "it"] : ["apply", "them"];
			throw new Error(service === undefined
				? `bash: ${fields} only ${applies} with \`pty: true\`; drop ${them}, or set \`pty: true\` to open a terminal.`
				: `bash: ${fields} only ${applies} to a terminal (\`pty: true\` without \`name\`); a named service takes none of these fields.`);
		}
		return { kind: "native", params };
	}
	if (params.ready !== undefined) {
		throw new Error("bash: `ready` only applies to a named service; add `name` to start a service, or drop `ready` to open a terminal.");
	}
	const title = parseTerminalTitle(params.title);
	if (title === undefined) {
		throw new Error(`bash: \`title\` is required with \`pty: true\` — a short nonblank name for this terminal (at most ${MAX_TITLE_CHARS} characters shown); notices and list_sessions identify the terminal by it.`);
	}
	const notify = params.notify;
	if (notify !== undefined) {
		try {
			new RegExp(notify);
		} catch (error) {
			throw new Error(`bash: \`notify\` is not a valid JavaScript regex: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const timeout = params.timeout;
	return {
		kind: "terminal",
		request: {
			command: params.command,
			cwd: params.cwd,
			title,
			shell: params.shell,
			cols: params.cols,
			rows: params.rows,
			yieldTimeMs: params.yield_time_ms,
			onExit: params.on_exit,
			deadline: timeout !== undefined && timeout > 0 ? { kind: "after", seconds: timeout } : { kind: "none" },
			detached: params.async === true,
			notify,
		},
	};
}
