# AGENTS.md

omp-actual-terminal is an omp extension that runs long-lived PTY sessions on
Bun's `Bun.Terminal`. omp is the only supported host. Setup, the
concern-to-file map, test recipes, live-testing commands and the omp-upgrade
requalification are in [docs/DEV.md](docs/DEV.md).

## Every change

- Write changelog entries with lgit: `git add` the change, then run
  `uvx --from lgit-cli lgit`. It commits and adds a top-level item for each
  user-visible change under `## [Unreleased]` of `CHANGELOG.md`, newest on top;
  a hand-written item in the same commit is kept. Keep that heading as the
  file's first section and leave versions alone: merging to `main` publishes
  nothing, and the daily `omomp-release` run at 02:00 GMT+9 promotes the
  section to a new version, bumps `package.json`, and moves `main`, the tag
  and the `release` branch together. Users install from
  `https://github.com/oh-my-omp/omp-actual-terminal#release`.
- Change `README.md` and `README.zh-CN.md` together, section for section.
- Commit with a Conventional Commit type and the issue number, e.g.
  `fix: sample alternate rows before cursor-moving CSIs too (#84)`.
- Manage dependencies with bun; `bun.lock` is the only lock file.

## Code

- Connect new behavior to existing modules at the narrowest seam.
- Deleted paths stay deleted: Pi host support, the Node PTY backend, the pipe
  backend and `tty`, zero-byte polling and the steer gate.
- Delete code a change makes obsolete instead of keeping compatibility shims
  or aliases.
- Never edit the copies in `src/omomp-shared/`; oh-my-omp/shared owns them.

## Verification

- `bun run check` (`tsc --noEmit`) and `OMOMP_LANG=en bun run test` must pass
  before a commit; the tests assert English UI text. While iterating, run
  `bun test ./tests/<file>.test.ts`.
- Stub-host tests do not prove host behaviour. A change to tools, results,
  presentation or omp seams also needs a run in real omp:
  `omp --no-extensions -e "$PWD/src/index.ts" --no-session`, or add
  `--mode json -p '…'` for one non-interactive call. A running omp keeps the
  old code until `/reload`, also when it drives its own tools.
- A Tern HUD change needs a real Tern window, checked as
  [docs/DEV.md](docs/DEV.md#tern-hud) describes.
