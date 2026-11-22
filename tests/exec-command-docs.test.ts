import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
	loadExecCommandTopics,
	execCommandTopicPointers,
	monitorTopicPointers,
	TOOL_TOPIC_OWNER,
	writeStdinTopicPointers,
} from "../fork-features/exec-command-docs.ts";
import { clearToolTopics, listToolTopics, resolveToolTopic } from "../fork-features/omomp-shared/internal-url.ts";
import { activate } from "../src/index.ts";

test("exec_command registers the two pty topics under tool:// without legacy device scheme", () => {
	const legacyScheme = `${"xd"}://`;
	clearToolTopics(TOOL_TOPIC_OWNER);
	const tools = new Map<string, ToolDefinition>();
	activate({
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand: () => {}, registerFlag: () => {}, registerMessageRenderer: () => {}, on: () => {},
	} as unknown as ExtensionAPI);

	assert.deepEqual([...tools.keys()].sort(), ["exec_command", "monitor", "write_stdin"]);

	const listed = listToolTopics("exec_command");
	assert.deepEqual(listed.map((d) => d.topic), ["pty-io", "pty-lifecycle"]);
	for (const doc of loadExecCommandTopics()) {
		const resolved = resolveToolTopic(doc.tool, doc.topic);
		assert.ok(resolved);
		const fileBody = readFileSync(new URL(`../fork-features/topics/${doc.topic}.md`, import.meta.url), "utf8");
		assert.equal(resolved.content, fileBody);
		assert.ok(fileBody.startsWith("# "));
		assert.ok(!fileBody.includes(legacyScheme));
	}
	assert.equal(resolveToolTopic("exec_command", "nope"), undefined);

	for (const tool of tools.values()) {
		assert.equal("docTopics" in tool, false);
		assert.ok(!tool.description.includes(legacyScheme));
	}
	assert.ok(tools.get("exec_command")!.description.endsWith(execCommandTopicPointers));
	assert.ok(tools.get("write_stdin")!.description.endsWith(writeStdinTopicPointers));
	assert.ok(tools.get("monitor")!.description.endsWith(monitorTopicPointers));
	assert.match(resolveToolTopic("exec_command", "pty-io")!.content, /ssh host bash -s <<'EOF'/);
	assert.match(resolveToolTopic("exec_command", "pty-io")!.content, /screen_changed:false/);
	assert.match(resolveToolTopic("exec_command", "pty-lifecycle")!.content, /Notices identify a terminal by `session_id` and `title`/);
});
