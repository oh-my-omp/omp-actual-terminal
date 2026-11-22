# PTY I/O, Interactive Input, and `term://` URLs

## Sending input with `write_stdin`
- `write_stdin` takes zero-escape intuitive fields (`session_id` plus input fields):
  - `text`: UTF-8 string written verbatim (no backslash/C-escape decoding).
  - `enter: true`: appends `\r` after `text` (or sends `\r` alone if `text` is omitted; works on both POSIX shells and Windows console programs).
  - `special_key`: `"ctrl-c"`, `"ctrl-d"`, `"ctrl-z"`, `"esc"`, `"tab"`, `"up"`, `"down"`, `"left"`, `"right"`, `"backspace"`, or `"delete"` (mapped directly to control/ANSI bytes).
  - `raw_base64`: raw binary bytes encoded as base64 (mutually exclusive with `text`, `enter`, and `special_key`).
- Empty input is rejected (`empty_poll_removed`): use `read term://<id>` to inspect without writing, or `monitor` to wait.
- `yield_time_ms` is an attachment window (250–30000 ms), not a process timeout.
- Results return rendered terminal state, not raw bytes: a running result shows unseen history plus the current screen (`screen_changed:false` when unchanged); an exited result shows the final screen. Full raw bytes stay in `log_path`.

## Reading and controlling sessions via `term://`
- Sessions can be addressed by numeric `session_id` (`term://1`) or retained session `key` (`term://1-<uuid>`).
- `read term://`: list all running and returned (not yet reclaimed) PTY sessions with `session_id`, `key`, `title`, running status, lifecycle phase, and `term://<id>` URLs. Observing an exited session in the listing suppresses an unsent `on_exit` wake without marking output as read.
- `read term://<id>`: retained history (normal screen) or active screen (alternate screen). Subpaths: `/screen` (active screen text), `/page/<n>` (1-based page, or `-1` for last), `/screen.png` (styled screenshot). `term://` remains readable after reclaim.
- `write term://<id>/kill` (empty content or signal name such as `SIGTERM`, `SIGINT`, `SIGKILL`, or `?signal=...`): terminate the session (SIGTERM, then SIGKILL after 2 s; on Windows any signal force-kills the process tree).
- `write term://<id>/on_exit` (`"wake"` or `"none"`): arm or disarm completion wake without stopping the process.
- `write term://<id>/monitor` (`"cancel"`): cancel an active `monitor` subscription silently.

## Remote or container scripts (heredoc)
- For a remote or container script, write `ssh host bash -s <<'EOF'` in `cmd` with the script as the quoted here-document body; `cmd` is passed unchanged to the selected shell.
