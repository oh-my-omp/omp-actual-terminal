# Terminating a terminal

- Send the initial signal (default `SIGTERM`), then escalate to `SIGKILL` after 2 seconds. On Windows any signal force-kills the process tree.
- A kill is a normal ending, and the terminal's job shows as cancelled. The result shows the final screen, which counts as a terminal read.
- Before signalling, `kill_session` suppresses an armed `on_exit` wake and cancels the monitor, even if termination fails. Delivered follow-ups cannot be recalled.
- The terminal stays listed until reclaimed. `term://` remains readable after reclaim.

See `xd://bash/lifecycle` for reclaim and `xd://list_sessions/inventory` for interpreting listed terminals.
