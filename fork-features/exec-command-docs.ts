import { readFileSync } from "node:fs";
import { registerToolTopics, toDocTopics, type ToolTopicDoc } from "./omomp-shared/internal-url.ts";

export function loadExecCommandTopics(): readonly ToolTopicDoc[] {
	return [
		{
			tool: "exec_command",
			topic: "pty-io",
			title: "PTY I/O, Interactive Input, and term:// URLs",
			when: "before sending input with write_stdin, passing remote heredocs, or reading/writing term:// URLs",
			body: readFileSync(new URL("./topics/pty-io.md", import.meta.url), "utf8"),
		},
		{
			tool: "exec_command",
			topic: "pty-lifecycle",
			title: "PTY Lifecycle, Reclaim, on_exit Wakes, and monitor",
			when: "before relying on a terminal across turns, configuring on_exit wakes, or starting/cancelling monitor",
			body: readFileSync(new URL("./topics/pty-lifecycle.md", import.meta.url), "utf8"),
		},
	];
}

export const TOOL_TOPIC_OWNER = "omp-actual-terminal";

export function registerExecCommandTopics(): () => Record<string, string> {
	const docs = loadExecCommandTopics();
	registerToolTopics(TOOL_TOPIC_OWNER, docs);
	return toDocTopics(docs);
}

export const execCommandTopicPointers = "Topics: `help://exec_command/pty-io`, `help://exec_command/pty-lifecycle`.";
export const writeStdinTopicPointers = "Topic: `help://exec_command/pty-io`.";
export const monitorTopicPointers = "Topic: `help://exec_command/pty-lifecycle`.";
