# Terminals opened with `bash` and `pty: true`

- `pty: true` runs `command` in a terminal of its own. Without `shell` the terminal runs this session's shell, started from where your earlier `bash` calls left it: exported variables, functions and aliases are there, and `local://`, `skill://` and `attachment://` paths open. With `shell` it runs that shell with the same environment, but without the functions, aliases and URL paths.
- The call waits up to `yield_time_ms` for output. A program still running then returns its current screen with `session_id`, `terminal_url` and `log_path`; one that ended returns its exit code and final screen. With `async: true` it returns `session_id` at once.
- The terminal outlives the call and the turn. Cancelling the call never stops it; `kill_session` does. Send input with `write_stdin`, wait for output or completion with `monitor`, and read `terminal_url` for state.
- Without `timeout` the terminal has no deadline. With one, the terminal is ended at that time and the return is reported as abnormal.
- No overlay opens and the call does not block other tools, so one turn can open several terminals.

## Sending input and monitoring output

- `write_stdin` writes bytes verbatim, appending nothing: end every line with `\r` (Windows console programs ignore `\n`), and send ESC or an arrow key sequence on its own.
- An empty payload is rejected (`empty_poll_removed`): to read without writing, read `terminal_url`; to wait, use `monitor`.
- `chars` takes C-style escapes (`\xHH`, `\uHHHH`, `\u{H…}`, `\n`, `\r`, `\t`, `\0`, `\a`, `\e`, `\b`, `\f`, `\v`, `\\`, `\"`; an unknown `\X` stays literal). `chars_b64` sends raw bytes. They are mutually exclusive.
- `yield_time_ms` on `write_stdin` is an attachment window, not a process timeout.
- `monitor` with a `condition` (JavaScript regex source, no `/` delimiters) wakes you for each batch matching it, up to `max_returns` (default 10); `notify` on the `bash` call starts the same monitor. With `judge` instead, a judge model checks each new screen against your stated intent every `judge_interval_ms` (default 60 s) and each met screen wakes you; see `xd://monitor/subscription`. With neither it wakes once when the session ends.
- It observes without consuming: only output produced after the call counts, and matches coalesce for about 250 ms. `kill_session` or a session reset ends it silently, and delivered follow-ups cannot be recalled.
- `remind_after_ms` (default 20 minutes) sends one reminder quoting the current screen; it neither counts toward `max_returns` nor ends the monitor, and a return restarts it. On that reminder, read the terminal, answer the prompt with `write_stdin`, call `monitor` again, or `action: "cancel"`.
- A session that settles on an unseen input prompt raises an input-wait alert with or without a monitor.
- Results show rendered terminal state, not raw bytes: a running result shows unseen history plus the current screen (`screen_changed:false` when unchanged), a finished one its final screen. `terminal_url` gives retained history or a full-screen program's screen, `/screen` the active text, `/screen.png` colours and styles; raw bytes stay in `log_path`.

## Remote or container scripts

For a remote or container script, write `ssh host bash -s <<'EOF'` in `command` with the script as the quoted here-document body: moving the same quoted string into `command` keeps the extra quote layer. `command` is passed unchanged to the terminal's shell; use that shell's syntax.

See `xd://bash/lifecycle` for terminal lifetime and exit wakes, and `xd://bash/waiting` for completion-only waits.
