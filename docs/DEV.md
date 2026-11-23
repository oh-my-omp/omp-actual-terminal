# Development

Onboarding guide for hacking on this extension. For end-user install
and tool reference, see [../README.md](../README.md).

## Prerequisites

- **Bun 1.4+**, providing native TypeScript imports, the package manager
  (`bun.lock`), the `bun test` runner and `Bun.Terminal` (see `package.json`
  `engines`).
- **Node** for ordinary `node` children in `tests/bun-pty-runtime.mjs` and the
  unsupported-host rejection regression. Node is not a supported plugin host.
- **Linux, macOS, or Windows.** A terminal's default shell is the session's
  shell, omp's own shell process (see
  [Shell selection](../README.md#shell-selection)). The stub host of the test
  suite is not omp, so it runs that shell as the `bash` on `PATH` — on Windows
  Git for Windows, which the CI job provides by running every step under bash.
  Every PTY uses Bun's native `Bun.Terminal`.
- **omp** installed and runnable (`omp --version`). Only omp is supported;
  non-omp hosts fail at the extension factory before tool registration.

## First-time setup

Clone the repo and install dev dependencies:

```bash
git clone https://github.com/oh-my-omp/omp-actual-terminal
cd omp-actual-terminal
bun install
```

Load the working copy directly for interactive testing:

```bash
omp --no-extensions -e "$PWD/src/index.ts" --no-session
```

The package declares its extension under `omp.extensions`. To exercise package
installation rather than a checkout, use `omp plugin install` with a Git URL.

Every session needs Bun's native PTY. The extension factory checks for
`Bun.spawn` and `Bun.Terminal` after identifying omp, before loading omp
modules or registering tools. A non-Bun host or a Bun build lacking those
capabilities fails immediately with the runtime reason.

Verify the install:

```bash
bun run check                       # clean strict typecheck
OMOMP_LANG=en bun run test          # all tests
```

The tests assert English UI text, so run them with `OMOMP_LANG=en` when the
locale environment selects another language.

Expect zero failures on Linux, macOS and Windows; CI runs the full suite on all
three. Platform-specific cases and the explicit omp install gate may skip; PTY
availability never does.
The Node admission regression compiles the actual
TypeScript entry before executing it in Node, whose strip-only loader cannot
parse the Console's parameter properties; it runs against stub packages for the
names the bundle imports, because the host packages ship TypeScript source.
The missing-renderer regression runs the built presentation module in a child
`bun --no-install` whose staged `@oh-my-pi/pi-tui` re-exports the real package
root and `./tools/streaming-output` but has no `./tools` subpath.

## Repo layout

See [Layout](../README.md#layout) for the `src/` layout. A sibling view,
indexed by concern:

| Concern | File(s) |
|---|---|
| Tool schemas and orchestration | `src/index.ts` (`bash`, `write_stdin`, `set_on_exit`, `monitor`, `kill_session`, `list_sessions`) |
| `bash` schema and the split between omp's own bash (`ctx.invokeTool`) and a terminal | `src/bash-tool.ts` (`parseBashCall`); registration and `runTerminal` in `src/index.ts` |
| omp's bash for approval and description, the session-shell seed, shell process, URL mounts and terminal environment | `src/terminal-host.ts` (`loadTerminalHost`) |
| Tool-owned topics (`read help://<tool>/<topic>`) and full-description pointers for all six PTY tools | `src/tool-docs.ts`, `src/topics/*.md`; typed definitions in `src/index.ts` |
| Session lifecycle (spawn, write, kill, log-stream) | `src/session.ts` |
| Session registry, LRU eviction, shutdown | `src/session-store.ts` |
| Terminals as omp jobs: registration before spawn, the screen as the job's progress, the job's status and last screen at the return, cancels from omp's jobs page; the root agent as owner | `src/terminal-job.ts`; `runTerminal`, `terminateSessionById` and `endRuntime` in `src/index.ts`; `rootAgentOf` in `src/session-binding.ts` |
| Per-call observation (`CollectResult`: screen, final screen or none) | `src/collect.ts`; produced by `ExecSession.collect` in `src/session.ts` |
| Event-driven, monotonic waits: collection, shutdown and kill confirmation | `src/long-wait.ts` |
| Human duration labels and host UTC time | `src/format-time.ts` |
| `on_exit: "wake"` completion scheduling (exactly-once) and monitor ownership | `src/completion.ts` (`setOnExit`, tombstones, flush) |
| Terminal notices: ADT, formatter, the dispatcher that holds notices during a run and merges them at its stop (`omp-actual-terminal-notice`) | `src/terminal-notice.ts`; run events (`agent_start`, `agent_end`, `session_stop`) in `src/index.ts` |
| Finished-work stop gate: `omp.settings` stop configuration, judge / `@smol` / todo detectors, silent collection of returned terminals; a finished agent woken only by a terminal problem (`isTerminalProblem`, the `done` stop state) | `src/stop-config.ts`, `src/stop-gate.ts` (omp modules loaded by `loadStopHost`), `TerminalLifecycle.collectReturned`, `NoticeDispatcher.flush` in `src/terminal-notice.ts`; withheld settlement in `src/completion.ts` (`submitWake`) and `src/monitor-subscription.ts`; `tests/stop-gate.test.ts` |
| Compaction handoff PTY terminal table & notice barrier | `src/compact-handoff-wiring.ts`, `src/omomp-shared/compact-handoff.ts`, `src/omomp-shared/context-delta.ts`; `tests/compact-handoff.test.ts` |
| Structured stop/config diagnostics and boundary-only English/Chinese rendering | `src/stop-reasons.ts`; producers in `stop-config.ts`, `stop-gate.ts` and `terminal-notice.ts`, human notifications in `src/index.ts` |
| Terminal lifecycle: return, reads, silent linger of a normal return with no process left, TTL, grace, reclaim, reclaimed-terminal record, minute sweep; the `notice.graceReclaim` plugin setting gating the grace reclaim notice | `src/terminal-lifecycle.ts`; `src/plugin-settings.ts` (omp's `getPluginSettings`, loaded by `loadPluginSettingsReader`); reclaim, leftover-group kill and setting parsing/warnings in `src/index.ts`; `onShellExit`/`onTerminalRead`/`signalProcessGroup` in `src/session.ts` |
| A subagent's terminals across omp's idle park: agent registry/lifecycle reader, parked runtimes, revive-then-deliver | `src/agent-park.ts`; `createRuntime`, `deliverNotice`, `endRuntime` and the `session_start`/`session_shutdown` handlers in `src/index.ts`; `finished` in `src/terminal-notice.ts`; `tests/agent-park.test.ts` |
| Rendered terminal screen: emulator, history + screen observations, snapshots | `src/terminal-screen.ts` (owned by `ExecSession`) |
| On-disk raw log file mirroring | `src/session.ts` (`logStream`) |
| Terminal-inert result/partial text | `src/output-safety.ts` |
| Bounded process/kill details + LLM-visible text | `src/tool-result.ts` (host-compatible `truncateTail`) |
| C-style escape decoding for `chars` | `src/unescape.ts` |
| Bun.Terminal backend, runtime admission, spawn preflight, shell-exit events, process-group signals, Windows tree-kill | `src/pty.ts` |
| Shell selection & argv construction; omp's cmd.exe test loaded at factory time | `src/shell.ts`; `src/shell-host.ts` |
| `exec.initFile` plugin setting: parse, path resolution, the source-then-`eval` script for POSIX shells | `src/exec-init.ts`; omp's POSIX-shell test in `src/shell.ts` (`isPosixShell`); read per call in `runTerminal` (`src/index.ts`); `tests/exec-init.test.ts` |
| omp-only host admission, top-level `loadMode`, bash delegation, argument/result display adapters | `src/omp-presentation.ts` |
| Console from omp's jobs page: Open on a terminal job, the full-pane Console, the terminal's size while it is open | `src/tern-terminal-hud.ts`; `resize` in `src/session.ts`, `src/terminal-screen.ts` and `src/pty.ts` (`SpawnedChild`) |
| Removal of the `omp-unified-exec` Tern plugin that versions up to 0.14.7 installed | `src/tern-plugin-removal.ts` |
| `term://` resources, read handler and screenshots | `src/terminal-resource.ts`, `src/terminal-url.ts`, `src/terminal-image.ts` |
| Monitors: conditions, judge monitors, batching, End/match/judgment/reminder notices | `src/monitor-subscription.ts`; screen judgment through omp's judge chain in `src/screen-judge.ts`, reached per judgment through `RuntimeHost.judge` in `src/index.ts`; subscriptions owned by `src/completion.ts` (`startMonitor`) |
| Input-wait alerts: prompt detection, quiet watcher, notice | `src/input-wait.ts`; `ExecSession.watchInputWait` in `src/session.ts`; `alertInputWait` in `src/completion.ts` |
| Session log naming, open-log tracking and seven-day gzip compression | `src/log-archive.ts`; `ExecSession.spawn` in `src/session.ts`; scheduled by `withHostPresentation` |
| Host session binding: the settings `bash` approval, description and schema read | `src/session-binding.ts`; `sessionSettings` in `src/index.ts` |
| Copies of oh-my-omp/shared code (`i18n.ts`, `todo-read.ts`, `internal-url.ts`, `tern-plugin.ts`), declared in `omomp-shared.json` | `src/omomp-shared/`; never edit a copy, shared main owns them and its sync workflow opens PRs that refresh them |
| `monitor` result details type | `src/script-result.ts` |
| Terminal yield and PTY size limits | top of `src/bash-tool.ts` |
| `write_stdin` yield, early-exit grace, session-store limits | top of `src/index.ts` |

## Dev loop

1. Edit files under `src/`.
2. `bun run check` (catch type errors early).
3. `bun test ./tests/<relevant>.test.ts` (fast inner loop).
4. `bun run check` and `OMOMP_LANG=en bun run test` before committing.
5. In a running omp: `/reload` to pick up changes.

### Important gotchas for the dev loop

- **`/reload` does NOT affect tool calls already in flight.** Finish or
  kill the call (`kill_session` tool, or Esc on the omp prompt) before
  reloading, otherwise you'll mix old and new code.
- **If you're driving this extension's own tools from the omp session
  you're editing,** you're working against a snapshot: your edits take
  effect *after* `/reload` (or after full omp restart). Symptom: you
  change `src/unescape.ts`, save, call `write_stdin chars="\x03"` —
  still see the old behavior. Run `/reload` and retry.
- **`omp -p` (print mode) loads extensions fresh per invocation.** No
  `/reload` needed, but each run is a new process.

### Live testing on omp

```bash
omp --no-extensions -e "$PWD/src/index.ts" --no-session
```

Ask the model to start a long-running command through `bash` with
`pty: true`, drive input with `write_stdin`, and terminate it with
`kill_session`. Bash/write/kill must use omp's bash cards, and a `bash` call
without `pty` must look exactly as without the plugin; monitor/set-on-exit/list
use omp's default cards.
For Tern, open a terminal from omp's jobs page and drive its Console in a real
window as [Tern Console](#tern-console) describes.

For a fresh non-interactive tool execution:

```bash
omp --no-extensions -e "$PWD/src/index.ts" --mode json --no-session \
  -p 'Call bash with {"command":"echo omp-only-ok","pty":true,"title":"smoke"}. Reply done.'
```

## Running specific test files

```bash
# Pure units (fast, no subprocesses)
bun test ./tests/notify.test.ts \
         ./tests/unescape.test.ts \
         ./tests/session-store.test.ts

# End-to-end against real bash / cat in a PTY (seconds)
bun test ./tests/e2e.test.ts
bun test ./tests/chars-encoding.test.ts

# Real Bun PTY sessions
bun test ./tests/e2e-pty.test.ts

# Bun PTY backend, directly and from a compiled executable
bun tests/bun-pty-runtime.mjs
bun build --compile tests/bun-pty-runtime.mjs --outfile /tmp/bun-pty-runtime
/tmp/bun-pty-runtime

# Shared waits, wake delivery and the terminal lifecycle
bun test ./tests/long-wait.test.ts ./tests/wake-e2e.test.ts ./tests/terminal-lifecycle.test.ts

# Display adapters and direct host-admission checks
bun test ./tests/omp-presentation.test.ts

# Console from omp's real jobs page over real Bun PTY sessions
bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

## Writing new tests

We use Bun's native `bun test` runner with its supported `node:test` API
(no jest, no vitest). Pattern:

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { myFunction } from "../src/my-module.ts";

describe("my-module", () => {
  it("does the thing", () => {
    assert.equal(myFunction("in"), "out");
  });
});
```

For end-to-end tests that need the full tool pipeline, use the
`makeHarness()` pattern from `tests/e2e.test.ts` — it calls the named
`activate` export with a stub `ExtensionAPI` and exposes `call(toolName, args)`
and `emit(event)` so you can drive tools directly without a running LLM.
The default factory is the omp admission boundary; never use a fake host there
to test generic tool behavior.

## Common tasks

### Add a new escape sequence to `unescape.ts`

1. If it's a one-character escape (`\X` → single char): add an entry
   to the `SIMPLE_ESCAPES` map in `src/unescape.ts`.
2. Add a test case under `"decodes simple one-char escapes"` in
   `tests/unescape.test.ts`.
3. Update the escape table in `README.md` under
   "Control bytes and escapes in `chars`".

Multi-char escapes (like `\xHH`, `\u{…}`) live in the main decode
loop; see the existing `\x` and `\u` branches for the pattern.

### Change a documented constant

The constants in the README's `## Constants` section live in the module that
owns them: `MIN_YIELD_TIME_MS`, `MAX_YIELD_TIME_MS` and
`DEFAULT_TERMINAL_YIELD_MS` at the top of `src/bash-tool.ts`;
`DEFAULT_WRITE_STDIN_YIELD_MS`, early-exit grace, session-store limits and
`INPUT_WAIT_QUIET_MS` at the top of `src/index.ts`; `TERMINAL_HISTORY_CELLS`
in `src/terminal-screen.ts`, `DEFAULT_REMIND_AFTER_MS` and
`DEFAULT_JUDGE_INTERVAL_MS` in `src/monitor-subscription.ts`,
`JUDGE_DEADLINE_MS` in `src/screen-judge.ts`, `RECLAIM_TTL_MS`,
`RECLAIM_GRACE_MS`, `RECLAIM_LINGER_MS` and `LIFECYCLE_SWEEP_MS` in
`src/terminal-lifecycle.ts`, the output caps in the host's
`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` (`@oh-my-pi/pi-tui/tools/streaming-output`). When you touch one:

1. Update the value in its owning module.
2. Update `## Constants` (and any prose quoting the value) in `README.md` and
   `README.zh-CN.md`.
3. Check whether any test depends on the old value (search for the number
   literal).

### Add a new output-result field

1. Add it to `ProcessResultDetails`, `KillResultDetails`, or their shared
   envelope in `src/tool-result.ts`.
2. Populate it in `finalizeProcessResult()` / `finalizeKillResult()`.
3. Add it to `renderProcessResultText()` / `renderKillResultText()` only when
   the model needs the field in textual content (details are TUI/session data).
4. If the TUI should show it, update the display adapter in
   `src/omp-presentation.ts`.
5. Add a pure assertion in `tests/tool-result.test.ts` and an end-to-end
   assertion in `tests/e2e.test.ts` when process lifecycle matters; update the
   response example and API tables in both READMEs.

Never put an unbounded value in `content` or details and expect
`renderResult` to hide it: model bounds must hold independently of display.
Child bytes go through the session's `TerminalScreen` first; pass its rendered
text through `sanitizeOutputText()` before model/session/TUI use. Only the
on-disk log owns the exact raw stream. Keep renderer-side sanitization as
defense for legacy results and fallback content.

### Tune TUI rendering

Tool result cards: `src/omp-presentation.ts` adapts terminal `bash` results,
write and kill to omp's exported bash renderer, including Tern's describe
hooks, and hands omp's own `bash` results to it unchanged. Other tools
use omp's default cards. Keep model content and persisted details unchanged by
display adapters. Update `tests/omp-presentation.test.ts`, then exercise the
actual omp ANSI TUI and Tern path. A missing or reshaped required omp module
must fail factory loading before tools register, not fall back to another
rendering.

The Console and the jobs page's Open: `src/tern-terminal-hud.ts`, covered by
`tests/tern-terminal-hud.test.ts` on omp's real `JobsSheet` and real PTY sessions;
requalify in a real Tern window as [Tern Console](#tern-console) describes.

## Debugging aids

- **Per-session log files** at `omp-actual-terminal-<pid>-<job id>-*.log` in the
  system temporary directory (`/tmp` or `%TEMP%`) capture the complete raw
  byte stream the child wrote; after seven days with a provably gone writer
  they become `*.log.gz` (`gzcat` or `zcat <` on macOS). Inspect them with a
  non-executing viewer to diagnose ANSI / control-sequence issues.
- **`details.output` vs `content[0].text`**: the LLM reads
  `content[0].text` (structured); the TUI renderer reads
  `details.output` (clean body). If the TUI shows a header like
  `[still running]\njob_id: …` verbatim, the renderer is failing
  and falling back to omp's default. Check `src/omp-presentation.ts`.
- **`list_sessions` tool** (invokable from the LLM side) is the
  quickest way to audit what's stored, including each returned terminal's
  lifecycle phase and whether it has been read.
- **omp's `/reload` output** echoes the extensions it loaded — check
  that this extension is among them.

## Checking omp compatibility

Review [oh-my-pi](https://github.com/can1357/oh-my-pi) release notes and the
extension API, bash renderer, theme, native rendering and internal-URL seams
listed under [omp upgrade requalification](#omp-upgrade-requalification).
The host must continue to identify itself through `ExtensionAPI.arktype`.

The host packages are the `@oh-my-pi/*` devDependencies and peerDependencies
at `latest` / `*`; every type that describes the host, including the host
modules the factory loads, comes from their exports, and TypeBox comes from
`@oh-my-pi/omptype/typebox`. Two workflows check every PR, every push to
`main` and a daily schedule. `omomp-check` is this repository's own job: it
checks out oh-my-omp/shared main and runs the dependency convention, `bun
install --frozen-lockfile`, an upgrade of the `@oh-my-pi/*` packages to their
newest release, `bun run check`, `bun run test` and the comparison of
`src/omomp-shared/` with shared main. `ci.yml` runs the same install, upgrade,
check and test on Linux, macOS and Windows, plus the Bun PTY runtime fixture
from source and from a compiled executable. A host type change therefore fails
`bun run check` before an omp release reaches users; refresh `bun.lock` with
`bun update` when it does.

Run `bun run check` and `OMOMP_LANG=en bun run test`, then validate the actual
installed omp runtime. Stub-host tests alone do not qualify host
compatibility. Confirm checkout loading, `omp plugin install` loading through
`omp.extensions`, bash/write/kill cards, and Tern terminal interactions;
required host modules must fail loading rather than silently degrade. Record
observed qualification in `CHANGELOG.md` with environment and evidence.

## omp upgrade requalification

Each seam below is a host contract the plugin depends on. On an omp upgrade,
check the named exports and run the listed real-omp scenario.

### Tool text and topics

On omp upgrades, read every installed tool's topic index (`help://<tool>`), all
advertised `help://<tool>/<topic>` addresses, and an unknown topic per tool
through real `read`; known topics must return body-only Markdown and unknown
ones an error. Stop/config diagnostic changes must retain structured reasons
until human notification generation and preserve environment-only language
selection; requalify a malformed section warning in both English and Chinese.

### Top-level mount

In a real `omp --mode rpc` session, `get_state` `dumpTools` (top-level
definitions only) must list all six tools, none of them may be mounted as tool
commands, and omp must still read no `promptSnippet`/`promptGuidelines`.

### `exec.initFile`

Through real omp: with a user value whose file defines an alias and an
export, a terminal in the session's shell, under zsh and under bash must show
both, a `bash` call without `pty` must show neither, and a project
`.omp/plugin-overrides.json` value must replace the user one.

### Session shell

`loadTerminalHost` imports `tools/bash`'s `BashTool`, `config/settings`'s
`settings`, `registry/agent-registry`'s `AgentRegistry`,
`exec/bash-executor`'s `executeBash`, `exec/settings`'s
`cfgBashGitGuard`, `exec/non-interactive-env`'s `buildNonInteractiveEnv`,
`exec/shell-process`'s `shellProcessCommand` and `shellMounts`,
`internal-urls/router`'s `InternalUrlRouter`, `internal-urls/url-filesystem`'s
`InternalUrlFilesystem` and `UrlFsError`, `task/settings`'s `ovnfsCommand`,
`tools/settings`'s `cfgLaunchEnabled` and `config/registry`'s `lookup`, which
must still find `spotlight.experiment.enabled`; `@oh-my-pi/pi-utils` must still export
`procmgr.isCmdShell`. A missing export fails loading. The seed repeats
`BashTool`'s private session seed (`tools/bash.ts`): compare its session key,
seed key, minimizer, git guard and overlay options with the current one on
every upgrade, and check that the session's tool session still carries the
Spotlight experiment exactly when `spotlight.experiment.enabled` is on
(`sdk.ts`, `startSpotlightExperiment`). The mounts call `shellMounts` without a
tool session and add the attachment lines themselves from the bound session's
`getImageAttachments()`: compare them with `shellMounts`' own attachment loop.

Through real interactive omp, in a main agent, a subagent and `omp -p`: after
a `bash` call exports a variable, defines a function and an alias, a terminal
without `shell` must see all three, read `local://`, `skill://` and an
attached image's `attachment://1` (`omp -p @image.png …`), see them again with
`PI_SPOTLIGHT_EXPERIMENT=1`, and start in a URL `cwd`; one with
`shell: "/bin/sh"` must see the export only and
refuse a URL `cwd`; an explicit `shell: "C:\\Windows\\System32\\cmd.exe"` must
fail with one notice and no cmd process; an explicit `shell` that does not
exist must return `spawn … ENOENT` and no output rather than another shell;
later input writes, kills and listings must repeat the session's shell; and
the default `cwd` must still follow omp's cwd.
`OMP_ACTUAL_TERMINAL_BASH` names the bash a bash selection resolves to.

### GitHub view cache

The factory imports omp's
`tools/gh-cache-invalidation.invalidateGithubCacheForBashCommand` and calls it
with the raw `command` before spawning a terminal, as `BashTool.execute` does.
Requalify that this export still exists and that a `gh issue close` in a
terminal makes the next `issue://` read refetch.

### `bash` registration

The plugin registers `bash` over omp's own. A call without `pty: true`, or with
`name`, goes through `ctx.invokeTool`, which must still run the built-in tool
unwrapped (not approved again) with the call's signal and update callback.
Approval, approval details and description come from a `BashTool` built per
call from the session's settings with `hasUI: false`, so its description
carries no pty paragraph of omp's own. omp's tool proxy must still read
`description`, `parameters` and `formatApprovalDetails` from the definition on
every access, and a re-registered `bash` must still lose omp's built-in
renderer, which `src/omp-presentation.ts` therefore supplies.

On omp upgrades compare `BashTool`'s schema (`tools/bash.ts`) with
`src/bash-tool.ts`. Then, in real omp: `/dump` in a main agent, a subagent and
`omp -p` must show the same `bash` fields, `pty` and the terminal fields
included; a `bash` call without `pty` must keep omp's own approval, execution,
result and card, named services included; a terminal call with an allowed
leading `NAME=value` (`bash.allowedEnvVars`) must pass approval while
`--approval-mode always-ask` still prompts, a denied call must spawn nothing,
and the confirmation must show omp's own details. Requalify the session
binding too: registry registration before `session_start`, `ctx.agent.id`,
the exact `sessionManager` identity and live `session.settings`;
switches/branches must keep the same session without a registry lookup, and
child agents with distinct settings overlays must each be judged by their
own.

### `term://` resources and screenshots

`@oh-my-pi/pi-coding-agent/internal-urls`: `InternalUrlRouter.instance()` must
share the production `read` router; after `registerInternalScheme` (the
`src/omomp-shared/internal-url.ts` copy) reports `registered`,
`getHandler("term")` must return the handler object just registered, whose
spec and methods the router consults per request. The handler uses
`{backing: "file", selectors: "lines", immutable: false}`: `locate()` returns
a path only for `/screen.png`, null for text. Read all retained rows,
`/screen`, the bare read inside `tmux` (it must equal `/screen`),
positive/negative pages, head/tail and unknown-key/page errors through real
`read`; confirm distinct keys across child agents, post-exit/kill/LRU access and
two reloads preserve URLs without consuming observations or re-registering.
Requalify root `@oh-my-pi/pi-natives.rasterizeSvg`: PNG bytes, system-font
CJK, palette/RGB and attributes, the 16,777,216-pixel limit, and real `read`
image blocks. Check one live session across dark/light themes, frozen
appearance, Live outline cursor versus Frozen no cursor, and concurrent
private PNG paths. Successful screenshots rely on OS temporary-file cleanup,
like logs, because the path-only host API supplies no read-complete callback.
Upgrading an already running text-only handler requires one omp restart;
reloads of the same version do not.

### Terminal jobs

`@oh-my-pi/pi-coding-agent/async/job-manager` must still export
`AsyncJobManagerApi` whose `register(type, label, run, {ownerId, process})`
returns the `bg_N` id, calls `run` with an abort `signal` and a
`reportProgress(text)` that sets the job's `progressText`, and throws its own
error at the running-job limit; `run`'s returned text must become the job's
`resultText` and its thrown message its `errorText`;
`acknowledgeDeliveries(ids)` must keep a job's result out of delivery and out
of the run's awaited work, and `cancel(id)` must abort `run` and keep the job
`cancelled` whatever `run` returns, and
change nothing for a job that is no longer running. The bound
AgentSession must still expose `asyncJobManager`, a subagent's being its
root's, and `AgentRegistry` entries `parentId`. Through real omp, in a main
agent and a subagent: a terminal's `bash` result must carry `job_id: bg_N`
that `write_stdin` and `kill_session` accept; the main session's jobs page and
`/jobs` must list the terminal under its `title`; an exit 0 must show the job
completed, a non-zero exit failed and `kill_session` cancelled, each with the
last screen above how it returned on the jobs page and the tray card, whose
`progressText` takes that text too; cancelling the job from the jobs page must
end the terminal as the Console's End does; and a running terminal alone must
not keep the run awaiting background work.

### Notice delivery, monitors, input waits and lifecycle

Through real RPC and interactive hosts: an `omp-actual-terminal-notice` sent
during a run must reach the model as a `developer` message at the next step
boundary (`/dump`) and start no turn after the final answer, and one sent
while idle must start a model turn without an additional user prompt. Verify
monitor default/custom limits, batching, advisory, last partial output,
human/model termination, End/wake merging, rendered prompts and redraws, and
unchanged default-card/message styling in ANSI/Tern. With a short
`remind_after_ms`, a silent monitor must send exactly one `monitor_silent`
notice on its own, and a delivered match must restart its clock. Without any
monitor, a real whiptail/debconf dialog (`ucf --debconf-ok` on a modified file
in a Debian container through a `bash` terminal) and an apt `[Y/n]` prompt must
each enqueue one `input_wait` notice that triggers a turn, and none while an
attached call shows the prompt. For the lifecycle, a real `read term://` of a
returned terminal must mark it read (`list_sessions` `lifecycle.read`), and an
idle agent must be woken by a reclaim-due notice; after the grace its terminal
must leave `list_sessions` with its background jobs gone, with no further
notice while `notice.graceReclaim` is off and one `reclaimed` notice after it
is turned on in `/settings` without a restart.
`@oh-my-pi/pi-coding-agent/extensibility/plugins/loader` must still export
`getPluginSettings(plugin, cwd)` returning the merged stored values without
defaults.

### Stop gate

`agent_end` must still carry `willContinue` and `awaitingAsyncWork`, and
`session_stop` must still fire for main-agent final stops with
`last_assistant_message`; the functions `loadStopHost` loads must exist with
the shapes `stop-gate.ts` parses, and the bound AgentSession must still expose
`settings`, `modelRegistry.resolver`, `sessionId`, `sessionManager` and
`agent.metadataForProvider`/`telemetry`. Through real omp with a returned,
unread background terminal: a final answer that finishes the task must start
no notice turn and remove the terminal from `list_sessions`, and afterwards a
running terminal's `on_exit: "wake"` exit must start no turn while its
non-zero exit starts one with `abnormal_return`; an answer that leaves work
open must deliver one merged notice; a notice raised during a long tool call
must reach the model right after that call's result, in the same run;
`stop: off` must drop lifecycle notices and keep monitor ones; and `judge`,
`llm` and `todo` must each decide when chosen explicitly.

### Judge monitors

`@oh-my-pi/pi-coding-agent/judgment` must still resolve a chain whose
`judge({state, questions}, {signal})` accepts a `choice` question and answers
`answers.<name>.choice`, rejecting on failure. Through real omp with a session
whose screen changes from an unready to a ready state worded differently from
the intent: a judge monitor with a short `judge_interval_ms` must stay silent
on the unready screen, deliver one `monitor_judge_match` notice quoting the
ready screen that triggers a turn, and appear in `list_sessions` as
`judge=… every=…`; with no judge model bound, starting must fail with
`judge_unavailable`.

### Agent park

`@oh-my-pi/pi-coding-agent/registry/agent-registry` must still export `AgentRegistry` with `global()`,
`get(id)` and `onChange()` emitting `removed` and `status_changed` with the
entry as `ref`, and `@oh-my-pi/pi-coding-agent/registry/agent-lifecycle` must
stay mapped for plugins with `AgentLifecycleManager.global()`,
`isParking(id, ref)` (true through the park's `session_shutdown`),
`has(id, ref)` and `ensureLive(id)` (resolving after the revived activation's
`session_start`). Through real omp with `task.agentIdleTtlMs` lowered: a
parked subagent's running terminal must survive and be driven by the same
`job_id` after a revive; a parked subagent's `on_exit: "wake"` exit must
not revive it; its non-zero exit must revive it and deliver one
`abnormal_return`; quitting the main session must leave no process of a
parked subagent's terminal.

### Presentation

`toolRenderers.bash` from `@oh-my-pi/pi-tui/tools` must still expose
`renderCall`/`renderResult`/`describeCall`/`describeResult`/`mergeCallAndResult`/`inline`,
accept `{command, cwd}` args and `{exitCode, wallTimeMs, async}` details, and
render omp's own `bash` results passed to it unchanged.
Package installation validation must still await the extension factory and
propagate its rejection.

### Tern Console

`@oh-my-pi/pi-tui/overlays/jobs-panel` must still export `JobsSheet` whose
prototype holds `describe`, `handleInput` and `handleNativeEvent`; its
`describe` must still key the selected job's detail (role `omp.jobs.detail`)
by `stableKey(job id)` and put a spacer before Cancel job in its status row
(role `omp.jobs.status`), and its `close` action must still close the page
through its source whatever key `tui.select.cancel` is bound to.
`@oh-my-pi/pi-tui/native/overlay` must still export
`actionButton`/`actionBar`, and `@oh-my-pi/pi-tui/tools/bash-interactive`
`normalizeInputForPty(data, applicationCursorKeys)`. The Console insets the
terminal's grid 8 columns from the sheet as omp's own Console does
(`NATIVE_SHEET_INSET_COLS` in `tools/bash-interactive.ts`, not exported):
compare it on every upgrade. A custom overlay's `nativeOverlay` role and head
must still reach Tern's overlay frame with `action` events and `handleInput`
keys reaching the component, and the action ids
`omp-actual-terminal.terminal.open`, `kill` and `leave` must not be one of
Tern's own actions (0.9.5 consumes `open`, `copy` and `zoom` itself). omp's
tray (`@oh-my-pi/pi-coding-agent/modes/tray`) must still draw a job card's
output from the job's `progressText` and open the jobs page on the card's job
from its Open, and the jobs page's output pane must still read `progressText`
while the job runs and `resultText`/`errorText` once it settles
(`inspectAsyncJob` in `session/async-job-views`). Tern must still draw
`omp.overlay.console` as a full-pane overlay whose `ansi`
fills the height its action bar leaves under `grow` and a fractional `max.h`
and scrolls inside itself. Tern's `plugin list --json` (`plugins[].id`),
`remove ID --json`, its exact `is linked; use unlink` answer and
`unlink ID --json` must retain their contract for the removal of the old
`omp-unified-exec` Tern plugin, with a 75-second timeout covering Tern's
60-second reload wait.

Check it in a real Tern window (`tern --control`, plugins load only in
windows, not in `tern serve`) with the owner's settings, isolated
`TERN_CONFIG_DIR` and `TERN_DAEMON_SOCKET`, a running turn, a background agent
and a background bash job, at 1100×850 and 700px width, with a light and a
dark appearance (`palette "Dark appearance"`; `theme dark NAME` only picks the
dark theme), both with no Tern plugin and with omp-todo-ng's extension and
Tern plugin. A terminal's tray card, its closer look and the jobs page's output
pane must show its current screen and follow a change within a second; the
card's Open must show the jobs page with the terminal selected. omp's jobs page
must offer Open (`o` and a button before Cancel
job) on a selected terminal job, a subagent's included, and on no other job.
Open must close the page and show the full-pane Console with the terminal's
history, typed keys reaching a running `cat`, and the terminal's grid
following the Console (`stty size`) and returning to its own `cols`/`rows`
after Esc. Esc must leave the process alive and the composer usable; End must
end the terminal as a person does; a model `write_stdin` while the Console is
open must show in it. Other jobs must keep the page's list, detail, Cancel
job and Close unchanged. A Tern config holding the old `omp-unified-exec`
plugin must list no `omp-unified-exec` after loading.

## Recording README demos

A README demo is a real omp turn in a headless Tern session, filmed by Tern's
own `record` scenario command and stored as `docs/assets/OUT.mp4` and
`OUT.gif`. Record it again when the Console, the jobs page's Open or omp's
tool cards change visibly.

1. Start an isolated headless Tern with the owner's settings:
   `TERN_CONFIG_DIR=$D/config TERN_DAEMON_SOCKET=$D/daemon.sock tern serve
   --control $D/control.sock --out $D/out`, `$D` under `/tmp`, with
   `settings.json` copied into `$D/config`. omp's native rendering and the
   Console need no Tern plugin, so `serve` shows them.
2. Drive it with `tern ctl --control $D/control.sock …`: `size 1120 760`, then
   `run "cd DIR; TMPDIR=/tmp omp --no-extensions -e $PWD/src/index.ts
   --no-session --no-title --model MODEL"` so session logs show `/tmp` rather
   than the per-user temp directory. `--no-extensions` also drops
   extension-provided model providers; pick a built-in one such as
   `openai-codex/gpt-6.1-sol`. Send `/new` before `record start NAME fps 30`:
   it clears omp's startup notices, which can name the signed-in account.
   For lazygit, `DIR` is a throwaway repository with a local `Demo` author,
   and `LG_CONFIG_FILE` points at a config with `disableStartupPopups: true`.
   Reset that repository by emptying it, not removing it: omp crashes on
   `process.cwd` when its working directory disappears.
3. Type prompts one character per `type` with `wait 28` between them (a
   prompt cannot contain `"`, which ends the scenario string), and switch to
   `record speed 3` while a model turn runs. A turn has ended when the last
   `… this turn` text in `tern ctl tree` changes. Open omp's jobs page with
   `/jobs`, select the terminal's job and press `o` (or `click` the Open
   button, located with `tern ctl dump '[data-role="omp.jobs.status"]'`): in
   the Console typed keys reach the terminal, Escape leaves it running, and
   End ends it.
4. `record stop`, then `mkdir -p docs/assets` and encode
   `$D/out/serve/NAME.mp4` into `docs/assets/OUT.mp4` and `OUT.gif`:

```bash
ffmpeg -i NAME.mp4 -vf "scale=1680:-2:flags=lanczos,fps=30" -c:v libx264 \
  -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -an docs/assets/OUT.mp4
ffmpeg -i NAME.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff" palette.png
ffmpeg -i NAME.mp4 -i palette.png -lavfi \
  "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" docs/assets/OUT.gif
```

Check every frame for account names, home-directory paths and tokens before
committing. GitHub does not play a repository-relative MP4 inline, so a README
shows a demo's GIF and links its MP4.

## Package delivery

Nothing is published to npm. The `release` branch is the published channel,
moved daily at 02:00 GMT+9 by the `omomp-release` workflow, while `main` is
development. A run promotes `## [Unreleased]` of `CHANGELOG.md` to a version
section, bumps `package.json`, and moves `main`, the tag and the `release`
branch together; a run with no top-level item under `## [Unreleased]` pushes
nothing. Users install the Git source with:

```bash
omp plugin install https://github.com/oh-my-omp/omp-actual-terminal#release --force
```

`files` in `package.json` includes `src` (with `src/topics/*.md`),
`README.md`, `LICENSE` and `CHANGELOG.md` (the `omomp.changelog`
declaration). Keep required runtime files inside that package set.

## Commit conventions

Match the existing history: Conventional Commit types (`feat`, `fix`, `docs`,
`test`, `refactor`, `ci`, `chore`; `!` marks a breaking change) with a terse
present-tense summary and the issue number:

```
fix: sample alternate rows before cursor-moving CSIs too (#84)
```

Keep each commit focused (one feature / fix). `git log --oneline` for
prior commits gives a sense of scope.

## Sources to read before changing core behavior

- The plugin's behavior is defined by the READMEs, the implementation and its
  tests.
- Codex's `unified_exec`
  ([`codex-rs/core/src/unified_exec/`](https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec))
  is useful for comparing shared session semantics and candidate fixes.
- omp's built-in `bash` renderer and extension APIs:
  [oh-my-pi source](https://github.com/can1357/oh-my-pi), especially
  `packages/tui/src/tools` and `packages/coding-agent/src/extensibility`.
