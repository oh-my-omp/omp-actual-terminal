import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import {
	bashDocumentation, bashTerminalSection, bashTopicPointers,
	writeStdinDocumentation, writeStdinTopicPointers,
	setOnExitDocumentation, setOnExitTopicPointers,
	monitorDocumentation, monitorTopicPointers,
	killSessionDocumentation, killSessionTopicPointers,
	listSessionsDocumentation, listSessionsTopicPointers,
} from "../src/tool-docs.ts";
import { activate } from "../src/index.ts";
import { stubTerminalHost } from "./stub-shell.ts";

function registeredTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	activate({
		registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
		registerCommand: () => {}, registerFlag: () => {}, registerMessageRenderer: () => {}, on: () => {},
	} as unknown as ExtensionAPI, undefined, stubTerminalHost({
		bash: () => ({ approval: () => "exec", formatApprovalDetails: () => [], description: "omp's own bash description" }),
	}));
	return tools;
}

test("bash describes omp's own bash, then the plugin's terminal, then its topics", () => {
	const bash = registeredTools().get("bash");
	assert.ok(bash);
	assert.equal(bash.description, `omp's own bash description${bashTerminalSection}${bashTopicPointers}`);
});

test("waiting documents the plugin contract without the local polling policy", () => {
	const { waiting, terminal } = bashDocumentation.docTopics();
	assert.match(waiting, /yield_time_ms/);
	assert.match(waiting, /without `condition`/);
	assert.match(waiting, /observes without consuming output/);
	assert.doesNotMatch(waiting, /seq 288|sleep 300|Do not loop|Never add a per-check marker/);
	assert.ok(terminal.includes("ssh host bash -s <<'EOF'"));
});

test("all six registrations own packaged providers and end with full topic pointers", () => {
	const tools = registeredTools();
	const definitions = [
		["bash", bashDocumentation, bashTopicPointers, ["terminal", "lifecycle", "waiting"]],
		["write_stdin", writeStdinDocumentation, writeStdinTopicPointers, ["write-stdin-input"]],
		["set_on_exit", setOnExitDocumentation, setOnExitTopicPointers, ["set-on-exit-wake"]],
		["monitor", monitorDocumentation, monitorTopicPointers, ["monitor-subscription"]],
		["kill_session", killSessionDocumentation, killSessionTopicPointers, ["kill-session-termination"]],
		["list_sessions", listSessionsDocumentation, listSessionsTopicPointers, ["list-sessions-inventory"]],
	] as const;
	assert.equal(tools.size, definitions.length);
	for (const [name, documentation, pointers, files] of definitions) {
		const tool = tools.get(name);
		assert.ok(tool);
		assert.ok("docTopics" in tool);
		assert.equal(tool.docTopics, documentation.docTopics);
		assert.ok(tool.description.endsWith(pointers));
		assert.ok(pointers.startsWith("\n\nTopics — read the one a call needs before making it:\n"));
		const topics = documentation.docTopics();
		assert.equal(pointers.split("\n").filter((line) => line.startsWith("- ")).length, Object.keys(topics).length);
		for (const [[topic, body], index] of Object.entries(topics).map((entry, index) => [entry, index] as const)) {
			assert.equal(body, readFileSync(new URL(`../src/topics/${files[index]}.md`, import.meta.url), "utf8"));
			assert.ok(body.startsWith("# "));
			assert.ok(!body.startsWith("---"));
			assert.ok(!body.includes("tool://"));
			assert.ok(pointers.includes(`- \`xd://${name}/${topic}\` — `));
		}
		assert.equal(Object.hasOwn(topics, "nope"), false);
	}
	const bash = tools.get("bash")!;
	assert.doesNotMatch(bash.description, /30 minutes|screen_changed|Notices name/);
	assert.match(bashDocumentation.docTopics().terminal, /screen_changed:false/);
	assert.match(bashDocumentation.docTopics().lifecycle, /Notices name.*session_id.*title/);
});

test("no tool description, field or topic names a tool the plugin no longer registers", () => {
	const tools = registeredTools();
	for (const tool of tools.values()) {
		const text = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
		assert.doesNotMatch(text, /exec_command|xd:\/\/exec_command/, tool.name);
	}
	for (const file of readdirSync(new URL("../src/topics/", import.meta.url))) {
		assert.doesNotMatch(readFileSync(new URL(`../src/topics/${file}`, import.meta.url), "utf8"), /exec_command/, file);
	}
});
