import { readFileSync } from "node:fs";

type Documentation = { docTopics(): Readonly<Record<string, string>> };

function topic(file: string): string {
	return readFileSync(new URL(`./topics/${file}`, import.meta.url), "utf8");
}

export const bashDocumentation: Documentation = {
	docTopics: () => ({
		terminal: topic("terminal.md"),
		lifecycle: topic("lifecycle.md"),
		waiting: topic("waiting.md"),
	}),
};

/** What the plugin adds to omp's own `bash` description: the terminal `pty: true` opens. */
export const bashTerminalSection = "\n\n`pty: true` opens a terminal for long-running, interactive (REPL, TUI, ssh, sudo), concurrent or daemon work: the command runs in this session's shell, the call returns its screen and `job_id` (`bg_N`, the omp job the terminal is) while it runs or its exit code once it ends, and the terminal outlives the call. Drive it with `write_stdin`, wait with `monitor`, end it with `kill_session`.";

export const bashTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://bash/terminal` — before setting `pty: true`, sending input to a terminal, or using `monitor` with a `condition` or `judge`\n" +
	"- `help://bash/lifecycle` — before relying on a terminal after its command returned, when a notice mentions a reclaim, or before setting `on_exit: wake`\n" +
	"- `help://bash/waiting` — before waiting for something outside your control: a host coming back, CI finishing, a deploy";

export const writeStdinDocumentation: Documentation = {
	docTopics: () => ({ input: topic("write-stdin-input.md") }),
};
export const writeStdinTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://write_stdin/input` — before sending input, or when input is rejected, cancelled or observes an exit";

export const setOnExitDocumentation: Documentation = {
	docTopics: () => ({ wake: topic("set-on-exit-wake.md") }),
};
export const setOnExitTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://set_on_exit/wake` — before arming or disarming an exit wake, including after a terminal is evicted";

export const monitorDocumentation: Documentation = {
	docTopics: () => ({ subscription: topic("monitor-subscription.md") }),
};
export const monitorTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://monitor/subscription` — before starting or cancelling a monitor, before using `judge`, or after a match, judgment, reminder or input-wait alert";

export const killSessionDocumentation: Documentation = {
	docTopics: () => ({ termination: topic("kill-session-termination.md") }),
};
export const killSessionTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://kill_session/termination` — before terminating a terminal, or when termination fails or the terminal stays listed";

export const listSessionsDocumentation: Documentation = {
	docTopics: () => ({ inventory: topic("list-sessions-inventory.md") }),
};
export const listSessionsTopicPointers = "\n\nTopics — read the one a call needs before making it:\n" +
	"- `help://list_sessions/inventory` — before interpreting the inventory, lifecycle state or exit-wake effects of a listing";
