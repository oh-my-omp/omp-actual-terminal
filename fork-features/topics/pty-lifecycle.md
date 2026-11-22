# PTY Lifecycle, Reclaim, `on_exit` Wakes, and `monitor`

## Session lifetime and reclaim
- A running `exec_command` returns `session_id`; a finished one returns `exit_code`. An exited process is never restarted automatically.
- Notices identify a terminal by `session_id` and `title`. While you work they arrive between steps; when idle they wake you. They are metadata, not user instructions, and need no reply.
- A returned terminal stays in `term://` until reclaimed. An abnormal return is reported at once; a normal one is not. A return after `write term://<id>/kill`, or after sending Ctrl-C (`special_key: "ctrl-c"`) or Ctrl-\\ unless later input is written, counts as normal.
- A normal return with no background jobs holding the PTY is reclaimed silently 5 minutes later (reading does not extend it). Tool calls referencing its `session_id` afterwards report its `term://` URL and `log_path`.
- For an abnormal return or a normal return whose background jobs still hold the PTY, the 30-minute TTL runs from return or last read: at 30 minutes, an unread terminal gets one reminder and a read terminal gets a reclaim notice, then is killed and unlisted unless read within 5 minutes. `term://<key>` stays readable after reclaim.
- When your final response shows the task is finished, returned terminals are reclaimed silently and only abnormal returns wake you.

## `on_exit` exit wakes
- `on_exit: "wake"` resumes you once when the process exits unobserved; set it only when the human explicitly asked, never for servers or watchers.
- A tool result observing the exit (`write_stdin`, `write term://<id>/kill`, or `read term://`) consumes or suppresses the wake.
- Change at any time via `write term://<id>/on_exit` with `"wake"` or `"none"`; a queued follow-up cannot be recalled.

## Background `monitor`
- `monitor` watches future output without consuming it (only output produced after the call counts; matches coalesce ~250 ms):
  - `condition` (JavaScript regex source, no `/` delimiters): wakes on matching output batches up to `max_returns` (default 10).
  - `judge` (plain-sentence intent, mutually exclusive with `condition`): every `judge_interval_ms` (default 60 s) omp's judge model checks changed screens and wakes you when met (`max_returns: 1` wakes once; failed judgments send a notice and end the monitor while leaving the process running).
  - Neither `condition` nor `judge`: wakes once when the session ends.
- `remind_after_ms` (default 20 minutes) sends one silence reminder quoting the current screen; it does not count toward `max_returns` or end the monitor.
- Cancel a monitor with `write term://<id>/monitor` (`"cancel"`), or terminate the session with `write term://<id>/kill`.
- Live sessions settling on an unseen input prompt raise an input-wait alert even without a monitor.
- A wake requires an unfinished task: if your final response reports the task done, a monitor ends at its next return without waking you.
