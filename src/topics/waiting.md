# Waiting for an outside condition

- A terminal opened with `bash` and `pty: true` has no deadline unless `timeout` sets one, so a command may outlive the call's `yield_time_ms`; the call returns `session_id` while the command keeps running. `yield_time_ms` only controls how long the call stays attached, not the command's lifetime.
- Attach `monitor` to that `session_id` without `condition` or `judge` to receive one wake when the session ends. With a `condition`, matching output can also wake you; every printed line can contribute to a match. With `judge`, a screen the judge finds meets your stated intent wakes you, for states no fixed text reliably marks.
- To look at progress without disturbing the wait, read `terminal_url` (`term://…`); `monitor` observes without consuming output.
- `kill_session` stops the session and cancels its monitor silently. It does not require the waiting command to exit on its own.

See `xd://bash/terminal` for conditional monitors and `xd://bash/lifecycle` for exit wakes and reclaim.
