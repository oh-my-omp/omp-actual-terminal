# Terminal lifetime, reclaim and exit wakes

- Every terminal is an omp job: a running result returns its `job_id` (`bg_N`); a finished one returns `exit_code`. A process that exits is never restarted, so run it again yourself if that is what you want.
- With a `job_id`, send input with `write_stdin`, wait for output or completion with `monitor`, and read `terminal_url` (`term://`) for state.
- The job ends when the terminal returns, but it never delivers a job result: notices name a terminal by `job_id` and `title`. While you work they arrive between your steps, after the current tool results; when you are idle, a notice wakes you. They are not addressed to the user and need no reply.
- The human sees the terminal on omp's jobs page; cancelling its job there ends the terminal as if the human had ended it.
- In the main agent, `wait` counts running terminals among your jobs, so it blocks while a server or watcher runs; to wait for a terminal's output or end, use `monitor`.
- A returned terminal stays in `list_sessions` until reclaimed. An abnormal return is reported at once; a normal one is not. A terminal ended by the `timeout` of its `bash` call returns abnormally. A return after your own `kill_session`, or after you wrote Ctrl-C (`\x03`) or Ctrl-\ (`\x1c`) with `write_stdin`, is normal; input you write after the interrupt makes a later failure abnormal again.
- A normal return with nothing left running is reclaimed silently 5 minutes later, read or not; reading does not extend it. A tool call that names its `job_id` afterwards answers with its `term://` and `log_path`.
- For an abnormal return, or a normal one whose background jobs still run, reclaim timers start at the return or at the last read: 30 minutes later, a never-read terminal gets one read reminder and a read one gets a reclaim notice. Then it is killed with its background jobs and unlisted unless you read it within 5 minutes. A notice after that reclaim comes only if the human enabled it; do not wait for one.
- When your final response shows the task finished, returned terminals are reclaimed silently — no notice — and until your next run only an abnormal return wakes you: armed wakes, monitors and input prompts are settled without a notice. Do not rely on a finished terminal staying alive across turns.
- `term://` stays readable after reclaim, so read the retained history or `log_path` instead of starting the command again.
- `on_exit: wake` resumes you once when the process exits unobserved. Set it only when the human asked for that; never for servers or watchers. A tool result that observes the exit consumes the wake.
- `set_on_exit` changes the policy without stopping the process: `none` disarms, `wake` re-arms. A queued follow-up cannot be recalled.
- `kill_session` terminates the process and suppresses the wake.
