# omp-actual-terminal

English | [简体中文](README.zh-CN.md)

Long-lived terminal sessions for [oh-my-pi](https://github.com/can1357/oh-my-pi)
(omp), with a Console in Tern. The plugin takes over omp's `bash` with
`pty: true`: long commands, interactive programs (REPLs, TUIs, `ssh`, `sudo`),
concurrent computation and dev-time daemons run in a PTY session of the
session's own shell, which the model drives with input, reads and monitors
instead of a single blocking call. Every other `bash` call stays omp's own.
Sessions keep running between turns, with no deadline unless the call sets
one, in main agents, subagents and `omp -p` alike, and a human can open any of
them from omp's jobs page in Tern, watch it and type into it.

## Install

```bash
omp plugin install https://github.com/oh-my-omp/omp-actual-terminal#release
```

`#release` is the published channel; `main` is the development branch, and a
new version is published from it daily at 02:00 GMT+9. Nothing is published to
npm.

Updates use the same command with `--force`:

```bash
omp plugin install https://github.com/oh-my-omp/omp-actual-terminal#release --force
```

The extension needs no Tern plugin. Versions up to 0.14.7 installed one
(`omp-unified-exec`); when `tern` is on PATH, loading the extension (including
install validation) removes that copy or link through Tern's own CLI.

This plugin supports only omp running on Bun 1.4+ (omp is a compiled Bun
executable). Pi and other non-omp hosts fail immediately at the extension
factory with an explicit “only supports omp” error. Every session uses Bun's
native `Bun.Terminal`; a host without `Bun.spawn` and `Bun.Terminal` fails at
that same factory before omp modules load or any tools register.

## UI language

Human-facing notifications, widgets, the omp bash card annotations,
and the Tern Console follow `OMOMP_LANG` (`en` or `zh`, case-insensitive).
When it is unset or invalid, the plugin uses the first non-empty `LC_ALL`,
`LC_MESSAGES`, or `LANG` value (`zh*` selects Chinese); otherwise it uses English.
For language selection this plugin does not read an `omomp` file. Tool labels
resolve the environment once when registered for each session;
notifications, widgets, renderers, and the Console resolve it when generating their
display text. Tool descriptions, prompts, protocol values, and model-facing tool
results remain in English.

## What it does

- **Sessions, not calls.** `bash` with `pty: true` starts a process in a PTY
  and returns within its yield window with output so far and a `job_id`;
  on later turns `write_stdin` writes bytes to it verbatim (text, `\x03`
  Ctrl-C, arrow keys). Read `terminal_url` for state/content and use `monitor`
  for events or completion. Cancelling a call never kills the process. A
  terminal has no deadline unless the call sets `timeout`, and a process that
  exits is never restarted.
- **Terminals are omp jobs.** Each terminal is registered as an omp background
  job before its process starts, and the job id (`bg_N`) is its only id in
  every tool, result, notice, log name and `term://` address. omp's jobs page
  lists it, a subagent's under its main agent; cancelling the job there ends
  the terminal the way the Console's End does. The job ends when the terminal
  returns: exit 0 completes it, a non-zero exit, signal, `timeout` or failure
  fails it, and `kill_session` or a human's kill cancels it. It never delivers
  a job result to the model (terminal notices report the terminal), and a
  running terminal does not keep a run awaiting background work; an explicit
  `wait` by the main agent does wait on it, as on its other jobs. `/new` or a
  session switch cancels the main agent's jobs, which ends its terminals and
  its subagents' terminals. Terminals
  count toward omp's running-job limit (`async.maxJobs`); at the limit the
  call fails with omp's own message and nothing starts. A session omp's agent
  registry does not resolve has no job manager, so it cannot open a terminal.
- **The session's shell.** Unless the call names a `shell`, the terminal runs
  omp's own shell (bash 5.3 syntax) started from where the session's earlier
  `bash` calls left it: exported variables, functions, aliases and the
  session's URL paths (`local://`, `skill://`, …) are there. A named `shell`
  keeps the exported environment only. `cmd` is refused instead of launched.
  Every result names the shell it started, so the model writes that shell's
  syntax.
- **omp's own approval.** A terminal call is judged by omp's bash approval,
  with the same `bash.patterns`, environment allowlist and approval mode as
  any other `bash` call.
- **Output is what a terminal shows.** Every session runs through a headless
  terminal emulator, so progress bars, redraws and full-screen programs return
  the current screen plus unseen history while running, not every redraw
  appended. Exited results contain only the final active screen;
  `terminal_url` recovers earlier retained rows. The emulator answers
  the terminal queries a real terminal would (cursor position, device
  attributes, default colours), so programs that wait for them, or pick a light
  or dark palette from them, behave as in a real terminal.
- **Bounded output, complete recovery.** Every result the model sees is
  tail-capped at 50 KiB / 3000 lines and stripped of terminal controls; the
  complete raw stream of every session is written to `log_path`.
- **Terminal lifecycle.** A background terminal stays listed after its
  command returns until it is reclaimed. A normal return with no process left
  lingers 5 minutes and is reclaimed silently, read or not; its `term://` and
  log stay readable. An abnormal return is reported at once; 30 minutes after
  the return or the last read, a never-read terminal of an abnormal return, or
  of one whose processes remain, gets one read reminder, and a read one gets a
  reclaim-due notice and a 5-minute grace before its remaining processes are
  killed and it is reclaimed, silently unless the `notice.graceReclaim` plugin
  setting is on. See [Terminal lifecycle](#terminal-lifecycle).
- **One notice channel.** Wakes, monitor returns and reminders, input-wait
  alerts and lifecycle notices are all terminal notices: each names the
  terminal by `job_id` and the title given to its `bash` call, with a short
  reason. A running agent reads them at its next step boundary, as omp-todo-more
  delivers its reminders; an idle agent is woken with a turn of its own rather
  than seeing them at the user's next prompt.
- **Quiet after finished work.** When the main agent stops, its final response
  is judged (OMP's judge, else `@smol`, else the todo list) before any notice
  goes out; if the work is done, returned terminals are reclaimed and, until
  the next run, only a terminal problem (`abnormal_return`) starts a turn. A
  finished subagent follows the same rule. See [Finished work](#finished-work).
- **Opt-in completion wake.** `on_exit: "wake"` resumes the agent once when a
  backgrounded process exits unobserved; `set_on_exit` disarms it.
- **Await matching output.** `monitor` watches an existing session without
  consuming output, wakes for matching batches, for new screens a judge model
  finds meet a stated intent, or for completion, and defaults to at most ten
  successful returns. A monitor that has not returned for 20 minutes reminds
  the agent once to check the session.
- **Input-wait alerts.** With or without a monitor, a session whose screen
  settles on a prompt the agent has not seen (a debconf/whiptail dialog such as
  the sshd_config question during `apt upgrade`, `[Y/n]`, a password, a pager)
  wakes the agent.
- **omp-native presentation.** `bash`, `write_stdin` and `kill_session`
  render through omp's own bash card (command line, output, exit chip, error
  tone), in the ANSI TUI and in Tern alike.
- **A Console in Tern.** Open any of the model's terminals from omp's jobs
  page, scroll back through it, type into it and leave it running, or end it,
  without a tool call.

## Tern Console

When omp renders natively in Tern:

- **The screen in the tray and on the jobs page.** Each terminal's job
  carries its current screen, updated within half a second of a change: the
  tray card shows its last lines, the card's closer look more of them, and
  the jobs page's output pane the whole screen. Once the terminal returns,
  the tray and the jobs page show its last screen followed by how it
  returned. The tray card's Open goes to the jobs page with that terminal
  selected.
- **Open from the jobs page.** omp's jobs page lists every terminal as a job.
  With a terminal selected, a subagent's included, its status row offers Open
  (key `o`) before Cancel job; every other job keeps only omp's own actions.
- **Console.** Open closes the jobs page and shows the terminal full-pane in
  the frame of omp's own Console, headed by its job id, title and state: its
  retained history and current screen in colour, following new output and
  scrollable back. Typed keys go to the terminal as omp's Console sends them,
  so the model sees their effect, and what the model writes with
  `write_stdin` shows here at once. Esc / Leave closes the Console and leaves
  the terminal running; End ends it as a person's kill, and its job shows as
  cancelled.
- **Size.** While the Console is open the terminal takes the Console's grid,
  which the model then reads as well; leaving gives the terminal back the
  `cols`/`rows` its call started it with.

omp's ANSI TUI has no jobs page, so it offers no Console. Tool results stay
plain text; explicit `read term://…/screen.png` requests return images.

**How Open joins omp's jobs page.** omp has no extension point for job
actions, so the extension wraps omp's `JobsSheet.prototype` (`describe`,
`handleInput`, `handleNativeEvent`) once per process. It puts the Open button
into a copy of the selected terminal's status row and leaves omp's own nodes
unchanged; any other job's page is the one omp built. If a selected
terminal's status row loses the spacer before its actions, describing fails
with a "requalify" error instead of silently dropping Open. The page cannot
tell a job that is not a terminal from a detail omp no longer keys by its job
id, so such an omp change leaves Open absent; omp upgrades requalify that key.

**No Tern plugin.** The Console uses omp's own overlay role
(`omp.overlay.console`), so Tern's built-in styles draw it. That role is a
presentation contract of omp and Tern, requalified on upgrades. The extension
removes the `omp-unified-exec` Tern plugin that earlier versions installed,
because its stylesheet still moved omp's shared widget container: during
omp's awaited factory it asks Tern's `plugin list`, then `plugin remove` (or
`plugin unlink` when Tern answers that it is linked), and confirms Tern no
longer lists it. Without `tern` nothing runs; if an available Tern fails,
loading fails with its diagnostics.

## Tools

### `bash` with `pty: true`

The plugin registers `bash` in place of omp's own. A call without `pty: true`,
or one that names a service with `name`, goes to omp's own `bash` unchanged:
the same fields, approval, execution, result and rendering. A call with
`pty: true` runs its command in a persistent PTY session. Use it for long
commands, interactive programs (REPLs, TUIs, `ssh`, `sudo`), concurrent
computation and dev-time daemons; keep short one-shot commands without `pty`.
Nothing restarts a process that exits. Observe a session with `monitor` and
`read term://…`, and send input with `write_stdin`; its output is the rendered
terminal screen (see [Terminal output](#terminal-output)).

The schema is omp's own `bash` schema plus the terminal fields below, in every
session: main agents, subagents and `omp -p`, with or without a UI. Its
description is omp's own `bash` description followed by the terminal's.

All six are top-level omp tools (`loadMode: "essential"`), not tool commands.
Each tool lists its topic pointers at the end of its description, and `read help://<tool>` lists a tool's topic URLs.
Each tool supplies its own topic bodies through `docTopics()`:

- `help://bash/terminal`: the terminal's shell, its return, input bytes, monitoring output and remote-script quoting.
- `help://bash/lifecycle`: terminal reclaim and exit wakes.
- `help://bash/waiting`: terminal lifetime, completion-only monitors and non-consuming reads.
- `help://write_stdin/input`: verbatim input, empty-input rejection, cancellation and observed exits.
- `help://set_on_exit/wake`: arming, disarming and queued exit wakes.
- `help://monitor/subscription`: future-output matching, judge monitors, cancellation, reminders and input-wait alerts.
- `help://kill_session/termination`: signals, wake/monitor suppression and retained terminals.
- `help://list_sessions/inventory`: inventory state, output reads and exit-wake effects.

The Markdown files ship in `src/topics/`; topic reads need no external
configuration extension. An unknown topic returns a missing-topic error.

| Param | Type | Default | Notes |
|---|---|---|---|
| `command` | string | — | Shell command, in the syntax of the terminal's shell. Required. |
| `pty` | boolean | omitted | `true` opens a terminal. Omitted or `false`: omp's own `bash`. |
| `title` | string | — | Required with `pty: true`: names the terminal in `list_sessions`, omp's jobs page, the Console and every notice about it. Folded to one line; at most 80 characters are kept. A missing or blank title fails the call before anything starts. |
| `cwd` | string | session cwd | Working directory: a host path, relative paths resolving against the session cwd, or a URL directory such as `local://…`, which only the session's shell can enter. The default is read for each call; a `cd` inside a session never changes it. A missing path or a non-directory fails with `Working directory does not exist: <path>` / `Working directory is not a directory: <path>` (omp's bash wording) and starts nothing. |
| `shell` | string | the session's shell | Shell executable instead of the session's shell; see [Shell selection](#shell-selection). `cmd` is refused; `powershell` / `pwsh` get `-Command`; every other shell gets `-c`. |
| `timeout` | number | none | Seconds. Omitted or `0`: the terminal has no deadline. A positive value ends the terminal at that time (SIGTERM, SIGKILL after 2 s) and its return is abnormal (`timeout=Ns`). omp's 300-second default applies only to calls without `pty`. |
| `async` | boolean | `false` | `true`: return the terminal's `job_id` at once, without waiting for output. |
| `notify` | string | omitted | JavaScript regex source (no `/` delimiters): starts a [`monitor`](#monitor) on the terminal with it as `condition`. The result's `monitor` line reports `started …` or why the monitor did not start. |
| `cols` | number | `120` | PTY width. Clamped to [20, 500]. |
| `rows` | number | `80` | PTY height. Clamped to [5, 300]. |
| `yield_time_ms` | number | `10_000` | How long this call stays attached waiting for output (not the command's lifetime), clamped to [250, 30_000]. |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | Policy for exits nobody is observing. `"wake"`: one follow-up prompt resumes the agent — only when the human explicitly wants auto-resume. Change later with `set_on_exit`. |

`title`, `shell`, `cols`, `rows`, `yield_time_ms` and `on_exit` apply only to a
terminal: a call carrying any of them without `pty: true`, or together with
`name`, fails before anything runs. `ready` applies only to a named service, so a
terminal call carrying it fails the same way. `async`, `notify` and `timeout` keep
omp's meaning on calls without `pty: true` and on named services.

Response body (running, short output, no truncation):

```
[still running]                     (or [exited])
job_id: bg_1                        (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with job_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/omp-actual-terminal-41237-bg_1-5cc5e104.log  (omp pid, job id, random)
terminal_url: term://bg_1-9f2c1a7e-…
cwd: /home/you/project
shell: pi-shell (session)          (the session's shell, or the absolute path of a named shell)
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn)
terminal: normal screen 120x80, cursor row 4 col 5
history_lines: 2                   (running, optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

When output exceeds the caps (50 KiB / 3000 lines), a footer is appended:

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/omp-actual-terminal-41237-bg_1-5cc5e104.log]
```

#### Command approval

Every `bash` call, terminal or not, is approved by omp's own bash approval:
ordered `bash.patterns` rules (`allow`, `deny`, `prompt`),
`bash.allowedEnvVars` for leading `NAME=value` assignments,
`bash.allowCompoundCommands`, critical-command patterns and omp's approval
mode. The confirmation details are omp's own. A deny prevents execution.

Rules are read live from the calling session, including a child agent's own
settings overlay. The first `session_start` binds that session by agent id and
session-manager identity; switches and branches only recheck identity. A
session omp's agent registry does not resolve is judged by omp's process
settings. Input written later with `write_stdin` is not reinterpreted as a new
command for approval.

#### Shell selection

Without `shell`, or with a blank one, the terminal runs the session's shell:
omp's own shell process (bash 5.3 syntax, on every platform), started from the
state the session's earlier `bash` calls left in omp's persistent shell — its
exported variables, functions and aliases — with the session's URL paths
(`local://`, `skill://`, `attachment://`, …) mounted and the working directory
entered, URL directories included. Results name it `pi-shell (session)`. If
omp cannot report that state, the call fails with `could not read the session
shell's state: …` and nothing runs.

With `shell`, that executable runs instead. It gets the same exported
environment but not the functions, aliases or URL paths, so a URL `cwd` fails.
The executable is resolved to an absolute path before the process starts: a
bare name through `PATH`, a relative path containing `/` or `\` against the
effective `cwd`. A shell that cannot be found or started fails the call
(`failure_message: spawn <file> ENOENT: …`, or on Windows an error naming a
shell that is not on `PATH`); the command never runs under another shell.

An explicit `cmd` is refused: omp's own shell test recognizes it, the call
fails without spawning anything, and one notice points at the session's shell
or a bash path. `omp-actual-terminal` never launches cmd.

`powershell` / `pwsh` get `-NoProfile -NoLogo -Command`; every other shell
runs as `<shell> -c <command>`. The command text is passed unchanged, so write
it in the syntax of the shell the result names.

Every terminal's environment is the session shell's exports without omp's
non-interactive overrides for its own `bash` (such as `PAGER=cat`, `TERM=dumb`
and `CI=true`), plus `TERM=xterm-256color` and `PI_SESSION_ID`,
`PI_SESSION_FILE` and `PI_TOOL_CALL_ID` naming the calling session and call.

The result header and `details` carry the shell as `shell`: for short
commands, started sessions and spawn failures alike. `write_stdin` results,
streaming updates, `kill_session` results and `list_sessions` entries repeat
the shell the session started with; they never select again. The shell is
metadata only and is never added to `output`.

#### Init file

The plugin setting `exec.initFile` names a POSIX shell script that every
terminal's shell sources before running `command`. Its exports and aliases
reach terminals only, not `bash` calls without `pty` or omp itself:

```sh
# ~/.config/omp-actual-terminal/init.sh
export PIP_REQUIRE_VIRTUALENV=1
alias omp='omp --hide-thinking'
```

- **User value:** omp's `/settings` → Plugins, or
  `omp plugin config set omp-actual-terminal exec.initFile ~/.config/omp-actual-terminal/init.sh`.
  Use an absolute or `~/` path: a relative one would name a different file
  in every project.
- **Project value:** `settings["omp-actual-terminal"]["exec.initFile"]` in the
  project's `.omp/plugin-overrides.json`, written by hand. omp merges settings
  per key, so it replaces the user value; a project file that also wants the
  user's presets sources that file itself. A relative path resolves against
  the calling session's cwd, never against `cwd`. A blank value turns a
  user value off for the project.
- The setting is read when each call starts, so a change applies to the next
  call.
- The file must exist and be a regular file, the settings must be readable
  and the value must be a string; otherwise the call fails with a
  `failure_message` naming the problem and nothing runs. omp itself ignores a
  malformed `.omp/plugin-overrides.json` with a log warning, and the user
  value then applies.
- Only the session's shell and POSIX shells (`sh`, `bash`, `dash`, `ash`,
  `ksh`, `zsh`, the names omp treats as POSIX) can source it. While it is
  set, a call whose shell is anything else, such as `fish`, `pwsh` or `cmd`,
  fails instead of running without the file.
- The shell sources the file, stops with its status if that is nonzero (a
  `set -e` inside the file keeps its meaning), and then runs `command` through
  `eval`, because zsh parses a whole `-c` string before running any of it
  and would not expand aliases defined in the same string. The session's
  shell and bash also get `shopt -s expand_aliases`. Errors in `command` may
  therefore be reported at `(eval)` positions. Results, `list_sessions`,
  notices and approval still show `command` as given; what the file prints
  appears in the terminal and the log.
- An alias applies only where `command` names it as a command word, including
  after `&&` or `;`. Nested shells, scripts and wrappers like `xargs` or
  `timeout` do not see aliases; exported variables they do see. An `omp` started in a
  terminal sources the same user file for its own terminals, so keep the file
  idempotent.
- The file is trusted startup code. Command approval checks only `command`,
  not the file or what its aliases expand to, so a project value runs whatever
  that repository's file says.

#### Terminal output

Every session feeds every byte its child writes, in order, into a headless
terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless))
of the session's `cols`×`rows`, and each result reports what that terminal
shows rather than the raw stream. Every read is therefore bounded by the screen
size; the raw stream goes only to `log_path`.

- **Running history plus screen.** Lines that scrolled off the top since the
  previous call and were not already reported come first, then the whole current
  screen. Carriage-return progress bars and redraws show their final state.
- **Unchanged running screen.** When neither the screen, the cursor nor the
  history changed, the result has `screen_changed: false` and `(no output)`.
- **Exit screen only.** Every completed result, including short commands and
  confirmed kills, returns the frozen final active screen even when unchanged.
  `terminal_url` stays at the result root; `terminal.retained_rows`,
  `terminal.rows` and `terminal.history_may_be_truncated` describe the retained
  normal-screen projection. Final metadata has no `screen_changed` or
  `history_lines`. The 50 KiB / 3000-line result cap still applies; read the URL's
  `/screen` for the complete screen and `/page/N` for earlier retained rows.
- **Full-screen programs** (alternate screen, e.g. `top`, editors, `tmux`) are
  reported as `terminal: alternate screen …`; leaving it restores the normal screen.
- **The child sees `TERM=xterm-256color`**, the terminal it actually draws on,
  whatever terminal omp itself runs in; a command can still set its own `TERM`.
- **Plain text and cursor in tool results.** Colours stay out of exec/write/kill
  text; Tern's Console and explicit `read term://…/screen.png` show them.
- **Terminal queries are answered** on the child's input: cursor position and
  device attributes, and the default foreground/background colours (OSC 10/11).
  The colours follow omp's theme (light or dark, which in Tern follows
  Tern's appearance).
- History between calls is bounded by a cell budget (`TERMINAL_HISTORY_CELLS`
  divided by `cols` rows). Lines scrolled past it before a call reports them
  set `history_may_be_truncated: true`; they are only in the log.

#### Reading retained terminals on omp

Results and `list_sessions` include a process-unique `terminal_url`, such as
`term://bg_3-9f2c1a7e-…`. What a human sees in the terminal remains readable
independently of result consumption:

| Read path | Content |
|---|---|
| `term://<key>` | All retained normal-screen physical rows, without trailing spaces or trailing empty rows. While a full-screen program (e.g. `tmux`) holds the alternate screen, that screen instead, which has no history; normal history is back once it leaves. |
| `term://<key>/screen` | The active screen, including an active alternate screen. |
| `term://<key>/screen.png` | An image of the full active grid, with cell colours and attributes. |
| `term://<key>/page/2` | The second page of the rows `term://<key>` reads; each page has the session's `rows` rows. |
| `term://<key>/page/-1` | The last page; negative page numbers count from the end. |
| `term://<key>:raw:1-2` / `term://<key>:raw:-3` | The existing `read` head/tail selectors, with no context rows in raw mode. |

Reads do not consume output, advance observation markers or remove sessions.
A complete read of a terminal whose command has returned counts as reading it
for its [lifecycle](#terminal-lifecycle).
An out-of-range page reports the total page count; an unknown key reports
`unknown_terminal`. A session whose spawn failed has no terminal resource.

After output closes and every accepted byte is parsed, the session freezes its
physical rows, active styled cells, geometry, cursor and current appearance.
The styled cells are kept compact, three 32-bit words and the characters per
cell; a screenshot builds each cell from them when it draws.
The same URL remains readable after short-command completion, normal exit,
confirmed kill, LRU removal or reclaim, until the omp process ends. Frozen resources
are not deleted; unfinished live projections need not survive plugin shutdown.
Keys remain distinct across child agents and extension reloads.

`read term://<key>/screen.png` uses omp's image pipeline; do not add `:img`.
The grid uses 8×16 logical pixels per cell and a system monospace font, with
wide glyphs spanning two cells. Live reads use the current host appearance and
draw an outline cursor; frozen reads preserve the frozen appearance and omit
the cursor. Large grids scale uniformly to the native rasterizer's pixel limit.
Each image read creates a private PNG in the OS temporary directory; it is a
point-in-time copy, not a cache, and relies on OS cleanup like session logs.
Restart omp once when upgrading from the text-only terminal handler; subsequent
extension reloads preserve the image handler and existing URLs.

### `write_stdin`

Sends nonempty decoded input to an existing session. Missing or zero-byte input
returns the typed `empty_poll_removed` error without consuming observations or
affecting the process. The error points to the session's `read term://…` address
and `monitor`.

| Param | Type | Default | Notes |
|---|---|---|---|
| `job_id` | string | — | Required: the `bg_N` a `bash` call with `pty: true` returned. |
| `chars` | string | omitted | Text decoded with C-style escapes, then written verbatim with nothing appended. Mutually exclusive with `chars_b64`; decoded input must be nonempty. |
| `chars_b64` | string | omitted | Base64-encoded input bytes. Binary-safe; decoded input must be nonempty. Mutually exclusive with `chars`. |
| `yield_time_ms` | number | `250` | Attachment window after writing, not a process timeout. Clamped to [250, 30_000]; fractional milliseconds round down. |

#### Waiting on long-running commands

1. Read `terminal_url` (or its `/screen`) for state and content without consuming
   ordinary observations.
2. Use `monitor` with a condition for future output events, or without a condition
   to await output closure and process completion. Send input only with `write_stdin`.
3. `on_exit` defaults to `"none"`. Use `"wake"` only when the human explicitly
   wants auto-resume; `set_on_exit(job_id, on_exit: "none")` disarms it
   without killing.
4. A completion observed directly by an input-bearing tool result consumes the
   wake; an attachment window ending or cancellation leaves it armed. Monitor
   End merges an already-armed wake into the same notification.

The attachment window never kills a process. Cache warming during waits is the
host's business, not this package's. Raw logs have no size cap; see **Logs**
under [Semantics](#semantics) for their seven-day compression.

#### Control bytes and escapes in `chars`

`chars` is decoded as a C-style escape string before it is written.

| Escape | Produces |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH` (2 hex) | single byte |
| `\\uHHHH` (4 hex) | Unicode char |
| `\\u{H…H}` (1–6 hex) | Unicode code point |
| `\\\\` `\\"` `\\'` | literal `\` `"` `'` |
| `\\X` not in the list above | preserved literally (both chars) |
| Raw bytes in the string | pass through untouched |

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
write_stdin chars_b64="G3s6wgo="  → exact 5 decoded bytes
```

Passing both `chars` and `chars_b64`, or malformed base64, rejects the call.
Bytes reach the PTY verbatim: nothing (no `\r` or `\n`) is appended, so ESC and
arrow keys go alone. The terminal's line discipline turns `\x03` (Ctrl-C) into
SIGINT for the foreground process group, and `\x04` (Ctrl-D) at the start of a
line into end-of-file for a program reading in canonical mode; programs in raw
mode read both as keys. Submit a line with `\r` (Enter): it works everywhere,
while `\n` does not run a line in legacy Windows consoles.

### `set_on_exit`

Changes the `on_exit` policy **without killing the process**.

| Param | Type | Default | Notes |
|---|---|---|---|
| `job_id` | string | — | Required. |
| `on_exit` | `"none"` \| `"wake"` | — | `"none"` disarms a pending wake (also for coordinator tombstones after eviction). `"wake"` arms it while the session is still running in the store. |

Status tokens: `disarmed`, `already_none`, `armed`, `already_armed`,
`too_late`; unknown ids return `found: false`. Disarming cannot recall a
follow-up already queued to the host.

### `on_exit: "wake"` — completion notifications

> Terminal completion is delivered through a finalized tool result **or** it
> causes one synthetic model prompt — never both.

- An exit that lands while a `write_stdin` is observing is returned by that
  call, and the wake is consumed when the result is finalized. A result
  finalized as error or cancelled keeps the wake eligible.
- A deadline or a cancelled call leaves the wake armed; when the process later
  exits, exactly one notice is sent (`deliverAs: "aside"`): a running agent
  reads it at its next step boundary without being interrupted, and an idle
  agent is woken with a turn of its own. Simultaneous completions are batched
  into one notice.
- The wake is an `exit_wake` [terminal notice](#terminal-notices): bounded
  metadata only (job id, title, exit code/signal, command, cwd, elapsed
  time, terminal reading address, log path, failure) — never raw output.
- `kill_session`, the Console's End, LRU eviction of a live
  process and `session_shutdown` suppress the wake; a kill that fails restores
  it. A naturally exited wake session evicted before notification keeps a
  bounded tombstone so its wake is still delivered.

### `monitor`

Subscribes to future output from an existing running session without stopping
the process or consuming ordinary observations.

| Param | Type | Default | Notes |
|---|---|---|---|
| `job_id` | string | — | Existing running terminal. |
| `action` | `"start"` \| `"cancel"` | `"start"` | Start/replaces the session's one subscription, or silently cancel it. |
| `condition` | string | omitted | JavaScript regex source (no `/` delimiters); omit it and `judge` to return only at output closure. |
| `judge` | string | omitted | Intent a judge model checks each new screen against; excludes `condition`. |
| `judge_interval_ms` | number | `60000` | With `judge` only. Integer 1–2147483647: time between judgments. |
| `max_returns` | number | `10` | Positive safe integer, counting successful match or met-screen messages, not lines or End. |
| `remind_after_ms` | number | `1200000` | Integer 1–2147483647: silence before one reminder that the monitor has not returned. |

Conditions see changed/new rendered logical lines, including prompts without a
newline; wrapped physical rows are joined. On the alternate screen, the
cursor's row is also seen as it was just before a bare carriage return (one not
followed by a line feed) or a cursor-moving CSI hands it to the next output, so
a marker that `tmux` draws and overwrites still matches. Each line is sanitized and bounded
to its first 1024 UTF-16 code units. Pure cursor/style changes do not trigger,
and old output is never replayed.

Matches coalesce for about 250 ms. Each delivered batch is a `monitor_match`
[terminal notice](#terminal-notices) that wakes the model, with at most 16
matching lines of at most 1024 characters, an omitted count, successful
returns/limit, and the session's `terminal_url` and `log_path`. More than
20 matches in the last 60 seconds adds a narrow-the-condition advisory, without
stopping. The final allowed match announces the limit and ends only the monitor.

A judge monitor serves states that no stable text marks. One
`judge_interval_ms` (60 seconds by default) after it starts, and one interval
after each judgment ends, it reads the current visible screen; if that screen
differs from the screen it last judged (or showed when the monitor started),
omp's judge role chain answers one met/not-met question whose state is the
screen's sanitized non-blank lines and whose question carries the intent. Not
met is silent. Each met screen is a `monitor_judge_match` notice quoting the
judged screen's last 16 lines and counts as a return, so a later changed screen
that still meets the intent returns again until `max_returns`. A judgment that
fails (no judge model, an error, no choice, or no answer within 30 seconds) sends
one `monitor_judge_failed` notice with the failure and ends the monitor, not the
process. Starting fails with `judge_unavailable` when no judge model resolves for
the session. Judgments are billed to the session under the
`omp-actual-terminal-monitor` purpose; omp's judgment cache answers a repeated screen
and intent without a model call. While omp has the agent parked, judgments wait
for its revival.

Actual output closure sends End (a `monitor_end` notice) with pending matches and exit code/signal;
terminations by a person (the Console's End or a jobs-page cancel) and by LRU
eviction identify their reason. End merges an
already-armed ordinary completion wake. Model `kill_session`, explicit cancel,
replacement, reset and shutdown end monitoring silently, including a failed
model kill. Already-enqueued follow-ups cannot be recalled. Unknown/ended
sessions, invalid regexes, invalid or conflicting judge parameters, invalid
limits and invalid reminder intervals return typed errors.

If no return or End has been delivered for `remind_after_ms` (20 minutes by
default) since the monitor started or since its last delivered return, it sends
one `monitor_silent` notice with `silentMs` in its body:
the monitor has not returned, what it waits for, the time since the last output,
the screen kind and the last eight non-blank screen lines (labelled as command
output), and the terminal's read address, asking the agent to check whether the
session is waiting for input, stalled or slow. The reminder does not count toward
`max_returns` and does not end the monitor; it is not repeated until a
delivered return starts a new silent period, so a waiting agent calls `monitor`
again for another deadline. A judge failure goes out before a pending return,
a pending return before a due reminder, and End replaces an undelivered
reminder or met screen.

### Input-wait alerts

No terminal protocol tells a program's host that it is waiting for input.
`apt upgrade` asks about a locally modified `sshd_config` through debconf
(openssh-server's maintainer script uses ucf, which uses debconf); debconf talks
to its frontend over its own pipe, and the whiptail/dialog frontend reaches the
PTY only as ordinary drawing (alternate screen, hidden cursor, box characters).
Over `ssh` the local process state says nothing either. Every running session
therefore examines its rendered screen once output has been quiet for 5 seconds
and sends an `input_wait` [terminal notice](#terminal-notices) that wakes the model when all of
these hold:

- no `bash`/`write_stdin` call is attached (its result shows the screen), and
  no tool result has shown this exact screen yet;
- the screen shows a prompt:
  - **dialog** — a `<Ok>`, `<Yes>`, `<No>` or `<Cancel>` button anywhere
    (whiptail, dialog, debconf, needrestart);
  - **inline** — the cursor waits at the end of a line containing `[Y/n]`-style
    choices, `(yes/no)` or `(Y/I/N/O/D/Z)`, `[default=…]`, a line ending in
    `password …:` / `passphrase …:`, or `press Enter/Return/any key`;
  - **pager** — the cursor sits on the bottom row after `:`, `(END)` or
    `--More--`;
- that screen has not been alerted before.

The alert names the session, its title and command, quotes the prompt lines as
command output, and gives the read address. It is heuristic: a screen read through
`read term://…` does not count as shown, and shells, progress lines and
prompts away from the cursor are ignored. A newer alert for the same session
replaces an undelivered one; a failed send is retried at the next safe
boundary while the screen is unchanged and unseen.

### `kill_session`

| Param | Type | Default | Notes |
|---|---|---|---|
| `job_id` | string | — | Required. |
| `signal` | string | `"SIGTERM"` | Escalates to SIGKILL after 2s. `"SIGKILL"` skips the grace. On Windows any signal force-kills the process tree. |

Signal names are normalized (`term`, `INT`, `sigkill`); unknown names are
rejected. The result uses the same bounded envelope as the other tools, with
`killed`, `escalated`, requested/actual signal and `running`. A failed kill
stays registered and reports `running: true`. A confirmed kill is a normal
ending: the terminal stays listed (`running: false`) and its
[lifecycle](#terminal-lifecycle) reclaims it, after the 5-minute linger once
nothing of it runs; the kill result shows its final screen, which counts as
reading it, and its job shows as cancelled. The Console's End and a cancel of
the job from omp's jobs page use the same path and count as read as well.

### `list_sessions`

Lists every stored terminal: running ones, and returned ones until their
[lifecycle](#terminal-lifecycle) reclaims them. Each entry has its `title`, the
`shell` it started with, `running`, `exit_code`/`signal` once the terminal
closed, `wake_armed`, an active monitor's `watch` (`end`, `regex` with its
condition, or `judge` with its intent and interval), returns/limit/reminder
interval and, once the command returned, `lifecycle`: how it returned
(`normally` or `abnormally (<reason>)`), whether it has been read, and its
phase (`ttl`, `unread_reminded`, `grace`, `linger`, `reclaiming`). The response carries
`running_count`, `returned_count` and the current host `tool_time_utc`.
Reporting an exit here suppresses a not-yet-sent `on_exit` wake; it is not a
read of the terminal's output.

### Terminal lifecycle

From the result that hands out a `job_id` until reclaim, the terminal
lifecycle owns the terminal. Its command **returns** when the shell exits —
background processes may still hold the terminal — or the terminal closes.

- **Normal return with no process left** (the terminal closed and its process
  group is empty): the terminal **lingers 5 minutes**, then is reclaimed
  silently, read or not, with no `unread`, `reclaim_due` or `reclaimed`
  notice; reads do not extend the linger. When background jobs outlive the
  shell, the linger starts at the check that finds them gone. A tool call that
  names a reclaimed terminal's `job_id` (`write_stdin`, `monitor`,
  `set_on_exit`, `kill_session`) answers that it was reclaimed, how it
  returned, and its `term://` address and `log_path`.
- **Abnormal return** (non-zero exit, signal, spawn/runtime failure, the
  call's `timeout`) sends an
  `abnormal_return` notice at once, read or not. A kill by `kill_session`, the
  Console's End or a jobs-page cancel is a normal ending, and so is a return after
  the agent wrote Ctrl-C (`\x03`) or Ctrl-\ (`\x1c`) with `write_stdin`. Later
  input without one of them clears that mark, so a program that survived the
  interrupt and fails afterwards is reported.
- **Reads** count from the return on: a complete `read term://…` (text or
  `/screen.png`), or a finalized `write_stdin`/`kill_session` result (or a
  `bash` result for a shell that already exited) that shows the
  returned terminal. Errored or cancelled results do not count. `list_sessions`,
  `monitor` End and wakes report status only and do not count.
- **30 minutes** after the return or the latest read of an abnormal return, or
  of a normal one whose processes remain:
  - never read: one `unread` notice; the checks keep the terminal until it is
    read (only [finished work](#finished-work) reclaims it unread; a finished
    agent's is reclaimed instead of reminded);
  - read: a `reclaim_due` notice and a **5-minute grace**. A read during the
    grace starts a new 30 minutes; otherwise the terminal is reclaimed.
- **Reclaim** kills whatever is left of the terminal's process group —
  background jobs holding the terminal on Linux, and jobs that outlived the
  closed terminal on macOS (SIGTERM, SIGKILL after 2 s) — and removes the
  terminal from `list_sessions`, and its job no longer offers Open. The `term://` address and
  `log_path` stay readable. A terminal whose processes cannot be ended stays
  and is retried at the next check (on Windows a tree whose root has exited
  cannot be reached).
- **Reclaim notice** after the grace: none by default, since the
  `reclaim_due` notice already announced the reclaim. The plugin setting
  `notice.graceReclaim` (boolean, default `false`; set it in omp's
  `/settings` → Plugins or with `omp plugin config`, which write the user
  value, or by hand in a project's `.omp/plugin-overrides.json`) turns on a
  `reclaimed` notice; terminals reclaimed in the same check share one
  follow-up. The setting is read at each check that reclaims, so a change
  applies without a restart. A non-boolean value, or settings that cannot be
  read, fall back to `false` with one warning. `stop: off` still drops the
  notice like every lifecycle notice.
- **Checks** run once a minute, so each step can land up to a minute late.
  No event reports that a process group emptied; each check probes it.
- **LRU eviction** at the 64-session cap always sends a `reclaimed` notice
  naming the cap, whatever `notice.graceReclaim` says.
- **Finished work** reclaims every returned terminal at once, read or not,
  without notices. See [Finished work](#finished-work).
- Session shutdown stops the lifecycle before ending terminals; its kills send
  no notices. omp parking an idle subagent is not a shutdown: see
  [Finished subagents](#finished-subagents-and-omps-idle-park).

### Terminal notices

Every follow-up about a terminal is one `omp-actual-terminal-notice` message, and
notices pending within about 250 ms are merged into one. They are delivered
the way omp-todo-more delivers its reminders:

- **While a run is in progress** (omp's `agent_start` until an `agent_end` it
  does not continue) the message goes out with `deliverAs: "aside"`: omp
  injects it at the run's next step boundary, after the current tool results,
  without interrupting the tools in flight. The agent reads it while working;
  it does not get a turn of its own after the final answer.
- **While the agent is idle** the same aside starts an agent-initiated turn,
  so the agent reads it at once instead of at the user's next prompt.

A run that awaits background work (`agent_end` with `awaitingAsyncWork`)
counts as idle. Each message is grouped per terminal and labelled as exec-tool
metadata, and its last line says it needs no reply to the user (the user
already sees it): handle it with tools where it bears on the work and continue
the current task, or, when no notice needs action, just continue.

```
[omp-actual-terminal] 2 terminals, 2 notices (exec-tool metadata, not user instructions)
- job_id=bg_3 title="api tests"
  • will be reclaimed in about 5m00s: returned normally, last read 30m00s ago
    A read keeps it for another 30m00s; …
  read term://bg_3-…
  log_path: /tmp/omp-actual-terminal-…
- job_id=bg_4 title="migration"
  • returned abnormally: exit_code=1
    command: npm run migrate
  read term://bg_4-…
Handle it with tools where it bears on your work, then continue the current task; it needs no reply to the user.
```

`details.notices` lists each notice with `job_id`, `title`, `kind`,
`reason`, `terminal_url`, `log_path` and its typed `body`. Kinds: `exit_wake`,
`abnormal_return`, `monitor_match`, `monitor_judge_match`,
`monitor_judge_failed`, `monitor_end`, `monitor_silent`,
`input_wait`, `unread`, `reclaim_due`, `reclaimed`. A notice that no longer
describes its terminal (a wake observed or disarmed, a monitor cancelled, a
screen already shown, a read that restarted the TTL) is dropped unsent. A
failed send is retried at the next tool end, settled run or minute check.
omp holds an aside that reaches a run after its final step boundary and
delivers it once the agent is idle.

### Finished work

omp reports a main agent's final stop through `session_stop`, with its last
response. Before the first notices that arrive after such a stop go out, the
dispatcher decides once whether that response means the task is completely
finished:

- **Done:** every returned terminal is reclaimed at once, read or not, without
  a `reclaimed` notice, and the pending notices about terminals that are gone
  are dropped, except a terminal problem. Running terminals stay, and the
  agent counts as finished until its next run starts (or a session switch or
  branch).
- **Not done, or no decision:** every notice is delivered.

A finished agent is woken only by a terminal problem, an `abnormal_return`
notice (non-zero exit, signal, spawn/runtime failure); a batch holding one goes
out whole. A batch without one is withheld and its notices are settled
silently:

| Withheld notice | What happens instead |
|---|---|
| `exit_wake` | The armed wake is consumed |
| `monitor_match`, `monitor_judge_match`, `monitor_judge_failed`, `monitor_end`, `monitor_silent` | The monitor ends, consuming its terminal's armed wake |
| `unread`, `reclaim_due` | The terminal is reclaimed at once |
| `input_wait`, `reclaimed` | Nothing |

A run that starts during the decision discards it, and the notices go into
that run. Subagents, aborted runs and runs awaiting background work
have no final response and are never decided; a subagent counts as finished
once omp adopts its task, see
[Finished subagents](#finished-subagents-and-omps-idle-park).

`stop` in the `omp-actual-terminal` section of omomp picks the detector:

| `stop` | Decision |
|---|---|
| `auto` (default) | `judge` when OMP's judge role resolves a model, else `llm` when `@smol` resolves one, else `todo` |
| `judge` | One done / not-done choice through OMP's judge role chain, billed to the session like OMP's own judgments |
| `llm` | The chat models of the `@smol` role in order, each answering `DONE` or `NOT_DONE` on its first line; a provider error moves to the next |
| `todo` | Done when omp-todo-more's list has items and every one is completed or abandoned; a pending or in-progress item keeps it open; an empty list or no omp-todo-more gives no decision |
| `off` | No decision; lifecycle notices (`abnormal_return`, `unread`, `reclaim_due`, `reclaimed`) are not delivered, while monitor, wake and input-wait notices are |

An explicitly chosen detector that is unavailable gives no decision; one that
fails, or runs past 30 seconds, also shows a warning. A done decision shows an
info notification naming the detector.

```yaml
omp-actual-terminal:
  stop: auto
  judgePrompt: |
    A coding agent stopped. Its final response, its todo list and the terminal notices that arrived for it follow.

    Final response:
    {last_response}

    Todo list:
    {todo}

    Pending terminal notices:
    {notices}
  noticeTemplate: "{summary}\n{items}\n{instruction}"
```

The values above are the defaults. `judgePrompt` is the material the judge or
`@smol` reads; the question it answers and the answer format are fixed.
Placeholders: `{last_response}` (the final response), `{notices}` (the pending
notices as the agent would read them) and `{todo}` (objective, item counts per
status and open items, or `(unavailable)`). `noticeTemplate` is the injected
text: `{summary}` (the `[omp-actual-terminal] …` line), `{items}` (the per-terminal
lines), `{instruction}` (the last line), `{terminal_count}` and
`{notice_count}`. A brace pair around anything but a bare name (such as
`{ "done": true }`) stays literal. Substitution is a single pass, so inserted text is never
expanded again. The human-facing transcript keeps the default layout.

The section is read from `<cwd>/.omp/omomp.{yml,yaml,json,toml}`, then from the
agent directory's `omomp.*`; the first valid copy wins, and it is read again at
every stop, so edits apply without a restart. An unknown key, mode or
placeholder makes a copy invalid: a warning names it once and the next
location, or the defaults, apply. Owned configuration and detector failure explanations
use the current UI language; field names, model identifiers and external error
payloads remain unchanged.

### Finished subagents and omp's idle park

A subagent's task is finished once omp's task executor adopts it, after the
result went back to its parent. omp then parks it after `task.agentIdleTtlMs`
of idleness (seven minutes by default): it disposes the subagent's session
and revives it, as a new session, when a message reaches it. The plugin keeps
no timer of its own for this; it reads omp's agent registry and lifecycle.

- **Only a terminal problem starts a turn** in a finished subagent, idle or
  parked: the [Finished work](#finished-work) rule applies. An
  `abnormal_return` notice asks omp to revive a parked subagent
  (`ensureLive`), then goes to the revived session with whatever was pending.
  Every other notice is withheld and settled silently, so the subagent stays
  idle and omp parks it on schedule.
- **The park keeps the terminals.** Its `session_shutdown` ends the
  activation, not the terminals: running commands, monitors, `on_exit`
  wakes, input-wait alerts and the 30-minute lifecycle carry on. A revive for
  any reason (a message from its parent, an `abnormal_return`) resumes the
  same terminals: their `job_id`s, `term://` addresses and logs are
  unchanged.
- **The terminals end with the agent:** when omp releases or kills the
  parked subagent (including when the main session ends), its terminals get
  the shutdown treatment (SIGTERM, SIGKILL after 1 s), and the main session's
  shutdown waits for that.

## Presentation

**On omp,** `bash`, `write_stdin` and `kill_session` render through omp's
exported bash renderer, in the ANSI TUI and in Tern. A `bash` call without a
terminal is omp's own call and result, rendered as omp renders it; a terminal
call shows `$ command`, collapsed
output with omp's expand binding, the exit chip and error tone for failures,
`Backgrounded: bg_N` for running terminals, and the truncation marker with
the log path as the last line. `write_stdin` and `kill_session` show their
action as a bash comment (`# stdin → bg_N: "…"`,
`# kill bg_N (SIGTERM)`). `monitor`, `set_on_exit` and `list_sessions`
use omp's default card. If omp's bash renderer is missing or reshaped, plugin loading
fails rather than showing raw envelopes.

## Constants

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
DEFAULT_TERMINAL_YIELD_MS    = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
TERMINAL_HISTORY_CELLS       = 240_000 (history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 3000
DEFAULT_REMIND_AFTER_MS      = 1_200_000 (monitor silence before one reminder)
DEFAULT_JUDGE_INTERVAL_MS    = 60_000 (judge monitor: time between judgments)
JUDGE_DEADLINE_MS            = 30_000 (judge monitor: one judgment's deadline)
INPUT_WAIT_QUIET_MS          = 5_000 (output silence before the screen is examined for a prompt)
RECLAIM_TTL_MS               = 1_800_000 (after a return or read: read reminder or reclaim-due notice)
RECLAIM_GRACE_MS             = 300_000 (reclaim-due notice to reclaim, unless read)
RECLAIM_LINGER_MS            = 300_000 (normal return with no process left to its silent reclaim)
LIFECYCLE_SWEEP_MS           = 60_000 (lifecycle check interval)
```

## Semantics

- **Early exit:** commands that finish within 150 ms never enter the session
  store; the result has `exit_code` and no `job_id`, and the job registered
  before the process started has already completed or failed.
- **Returned terminals** stay in the store and `list_sessions`, and their jobs
  keep offering Open, until their [lifecycle](#terminal-lifecycle) reclaims them; no tool call
  removes them on observing the exit.
- **Spawn failures** (missing shell or `cwd`) are checked before the PTY
  starts and surface as `failure_message` (`spawn <file> ENOENT: …`). A
  missing selected shell is never replaced by another shell.
- **Bun PTY required:** a host without `Bun.spawn` and `Bun.Terminal` is rejected at the extension factory, before tools register.
- **No deadline unless asked, no restart:** the package ends a terminal for
  running long only at the `timeout` its call set, and never restarts a
  process that exits.
- **Shell exit vs terminal close:** a session runs until its terminal closes.
  A descendant that survives the shell and still holds the PTY (e.g. a
  `nohup`'d or SIGHUP-ignoring job) keeps it open; such results carry a `note`
  on how to detach it (`setsid cmd >log 2>&1 </dev/null &`; on Windows, where
  no session shell runs that recipe, the note names only `kill_session`), and the
  running-session widget marks the session `terminal held`. `kill_session`,
  reclaim and shutdown still signal the shell's process group then, so a
  descendant that stayed in it is ended; one that left it (`setsid`) is not.
- **A closed terminal** never crashes the host; writes report `failure_message`.
- **Esc** breaks the current wait but leaves the session running.
- **Shutdown** sends SIGTERM to every session and SIGKILLs survivors after 1s.
  omp parking an idle subagent is not a shutdown; its terminals stay until omp
  releases the agent ([Finished subagents](#finished-subagents-and-omps-idle-park)).
  A `bash` call still inside its 150 ms start-up grace never gets a
  `job_id`: it waits for the shutdown to end the process and reports that
  exit (or `running: true` with `exit not confirmed` if the process outlives
  the SIGKILL wait), so the session never appears after the next
  `session_start`. Any other in-flight call whose terminal shutdown has already
  released returns empty output and reports the process as it is: exited, or
  still running until the SIGKILL lands.
- **LRU eviction** at 64 sessions takes the oldest non-protected one, preferring
  exited sessions; the 8 most recent are never evicted. A tracked terminal
  evicted this way gets a `reclaimed` notice naming the cap. A running one gets
  SIGTERM, then SIGKILL if it has not exited after 2s, and its job shows as
  cancelled once it ends.
- **Observations** are serialized per session; streaming updates, `read term://`,
  monitor and the Tern Console never consume ordinary observations. A streaming
  update is sent every 250 ms only when the parsed screen, the exit state or
  the byte count changed since the last one. Frozen terminal resources outlive
  session-store membership.
- **Logs** live in the temp directory (`/tmp` or `%TEMP%`) as
  `omp-actual-terminal-<omp pid>-<job id>-<random>.log`. The package never
  deletes their content. A log last written more than seven days ago is
  replaced by a standard gzip `<log_path>.gz` with the same modification time,
  once its writer is provably gone: this process closed it, the omp pid in its
  name no longer exists, or it was last written before the last boot. omp
  checks when the extension loads and
  daily after that. Read an archive with `zcat <file>` on Linux, or
  `gzcat <file>` / `zcat < <file>` on macOS, whose `zcat` given a path looks
  for `<file>.Z`. Inspect raw PTY logs with a non-executing viewer, not `cat`.

## Worked examples

### Dev server

```
> bash(command="npm run dev", pty=true, title="dev server", yield_time_ms=5000)
[still running]
job_id: bg_1
terminal_url: term://bg_1-9f2c1a7e-…
---
> Server listening on :3000

> monitor(job_id="bg_1", condition="GET /health")
{"job_id":"bg_1","status":"started",…}
# A subsequent matching request wakes the model.
> read term://bg_1-9f2c1a7e-…/screen
Server listening on :3000
  GET /health 200 in 3ms

> kill_session(job_id="bg_1")   # stays listed until its lifecycle reclaims it
```

### A state without fixed text

```
> bash(command="./deploy.sh staging", pty=true, title="staging deploy", yield_time_ms=5000)
[still running]
job_id: bg_2
…
> monitor(job_id="bg_2", judge="the deploy finished and every service reports healthy", judge_interval_ms=30000, max_returns=1)
{"job_id":"bg_2","status":"started","monitor":{"watch":{"kind":"judge","intent":"the deploy finished and every service reports healthy","interval_ms":30000},"returns":0,"max_returns":1,…}}
# Every 30 s a changed screen is judged; the first screen judged met wakes the model
# with a monitor_judge_match notice quoting it, and the monitor ends.
```

### Interactive Python REPL

```
> bash(command="python3 -q", pty=true, title="python repl", yield_time_ms=1500)
[still running]
job_id: bg_1
terminal: normal screen 120x80, cursor row 1 col 5
---
>>>

> write_stdin(job_id="bg_1", chars="print(7*6)\r", yield_time_ms=1000)
[still running]
terminal: normal screen 120x80, cursor row 3 col 5
---
>>> print(7*6)
42
>>>
```

### Long job with auto-resume (human asked for it)

```
> bash(command="npm test", pty=true, title="npm test", yield_time_ms=1000, on_exit="wake")
[still running]
job_id: bg_2
completion_notification: armed
---
# …the agent ends its turn; when npm test exits, one follow-up prompt resumes it.
> set_on_exit(job_id="bg_2", on_exit="none")   # if the job is abandoned
```

## Windows

Every session runs in ConPTY through Bun's native `Bun.Terminal`.

- **The session's shell** (no `shell` argument) is omp's own shell process
  here too: the omp executable's bash 5.3 engine, present on every machine
  omp runs on. No Git Bash discovery, no PowerShell fallback.
- **Shell names** are resolved to absolute paths before spawning: a bare name
  through PATH, and a bash name never through System32's WSL stub.
  `OMP_ACTUAL_TERMINAL_BASH` names the bash that a bash selection resolves
  to. A bare name not found on PATH fails the call instead of being looked up
  in `cwd`.
- **`shell: cmd` is refused**: the call fails with one notice pointing at the
  session's shell or a bash path.
- **PowerShell** (`powershell`, or `pwsh` on any platform) runs as
  `-NoProfile -NoLogo -Command <command>`, so its interactive prompts can be
  answered with `write_stdin`.
- **No POSIX signals:** every kill is a tree kill (`taskkill /T /F`); killed
  processes report `exit_code: 1`, and failed kills are reported, not hidden.

## Layout

```
src/
├── index.ts              # tool registration, event handlers
├── session.ts            # ExecSession: spawn, read, write, kill, log file, state
├── session-store.ts      # SessionStore + LRU eviction
├── terminal-job.ts       # a terminal as an omp job: registration, its screen as progress, its status and last screen at the return, cancels from omp
├── collect.ts            # CollectResult: screen, final screen or none
├── long-wait.ts          # event-driven waits (collection, shutdown, kill)
├── format-time.ts        # elapsed labels and host UTC time
├── completion.ts         # on_exit "wake" coordination (exactly-once), monitor ownership
├── notify.ts             # Notify / Gate / sleep primitives
├── pty.ts                # Bun.Terminal backend, host admission, spawn preflight, shell-exit events, process-group signals, Windows tree-kill
├── bash-tool.ts          # the plugin's `bash` schema; splits a call between omp's bash and a terminal
├── terminal-host.ts      # omp's bash, session-shell seed, shell process and URL mounts, loaded at factory time
├── shell.ts              # shell choice (session shell, explicit shell, refused cmd) and argv; omp's POSIX-shell test
├── output-safety.ts      # terminal-control stripping
├── terminal-screen.ts    # headless terminal: observations, styled screens, query answers
├── tool-result.ts        # bounded envelopes + model-visible text
├── script-result.ts      # monitor result details
├── unescape.ts           # C-style escape decoder for `chars`
├── omp-presentation.ts   # omp host detection, bash-renderer delegation, theme appearance
├── shell-host.ts         # omp's cmd.exe test, loaded at factory time
├── agent-park.ts         # omp's agent registry/lifecycle reader; parked subagents' terminal runtimes
├── session-binding.ts    # activation-local AgentSession identity for bash settings, stop detectors and the terminals' job owner
├── tern-terminal-hud.ts  # Open on omp's jobs page for a terminal job; the full-pane Console
├── terminal-resource.ts  # process-global terminal keys, live/frozen projections
├── terminal-url.ts       # omp `term://` read handler; reports reads to the terminal's owner
├── terminal-image.ts     # terminal screenshots (SVG → PNG)
├── terminal-notice.ts    # terminal notice ADT, formatter and the one dispatcher: run-held, merged, stop-gated
├── terminal-lifecycle.ts # returned-terminal silent linger, TTL, read/reclaim reminders, grace, reclaim, reclaimed record, finished-work collection
├── compact-handoff-wiring.ts # Compaction handoff PTY terminal table & notice barrier
├── stop-config.ts        # `omp.settings` stop config: stop mode, judge prompt, notice template
├── plugin-settings.ts    # native plugin settings (`omp.settings`): `notice.graceReclaim`, read via omp's getPluginSettings
├── exec-init.ts          # `exec.initFile`: resolve the init file, source it before `command` in POSIX shells
├── stop-gate.ts          # judge / @smol / todo stop detectors over factory-loaded omp modules
├── screen-judge.ts       # judge monitors' screen judgment through omp's judge role chain
├── stop-reasons.ts       # structured stop/config reasons; English/Chinese boundary rendering
├── tool-docs.ts          # six tools' lazy documentation providers and topic pointers
├── topics/               # packaged body-only tool documentation
├── monitor-subscription.ts # monitor conditions, batching, judgments and reminders as terminal notices
├── input-wait.ts         # input prompt detection; input-wait alerts as terminal notices
├── log-archive.ts        # seven-day gzip compression of session logs
├── tern-plugin-removal.ts# removes the Tern plugin earlier versions installed
└── omomp-shared/         # copies of oh-my-omp/shared files declared in omomp-shared.json
docs/
└── DEV.md                # maintainer guide
```

## Tests

```bash
bun install
bun run check                              # strict typecheck
OMOMP_LANG=en bun run test                 # Bun unit/integration suites (they assert English UI text)
bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
```

The full suite runs with Bun's native `bun test` runner, including real PTY
session and Console tests; PTY availability is mandatory, not a skip
condition. Node remains a test prerequisite because the standalone
`tests/bun-pty-runtime.mjs` fixture starts `node` as an ordinary child program,
not as the plugin host. CI runs the full suite and the source/compiled fixture
on Linux, macOS and Windows. Tern behaviour is qualified in a real Tern window,
as described in [docs/DEV.md](docs/DEV.md).

## Development

[docs/DEV.md](docs/DEV.md) covers the dev loop, focused test recipes, omp
compatibility checks and recording README demos.

Licensed [MIT](./LICENSE).
