# Sending input to a terminal

- Bytes go verbatim with nothing appended: end each line with `\r` (Windows console programs ignore `\n`); send ESC or arrows alone.
- Empty input is rejected with `empty_poll_removed`. To read without writing use `terminal_url`; to wait use `monitor`.
- An exit observed here consumes an armed wake; cancellation leaves the process alive.
- Results are rendered terminal state like a `bash` call with `pty: true`, not raw bytes. A running result shows unseen history plus the current screen (`screen_changed:false` when unchanged); a finished one shows its final screen. Raw bytes stay in `log_path`.

See `help://bash/terminal` for rendered terminal addresses and input encodings, `help://monitor/subscription` for waits, and `help://set_on_exit/wake` for exit wakes.
