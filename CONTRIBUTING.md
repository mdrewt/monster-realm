# Contributing

1. Branch `feat/…` or `fix/…` from `master`. Parallel work goes in separate worktrees.
2. Write the failing test first, then the change. A change to a game rule goes in
   `game-core`; the server and client only call it (see `docs/DECISIONS.md`).
3. `just ci` must pass before you open a PR. Run `just e2e` when you touch netcode,
   reducers or client flows.
4. Commits follow Conventional Commits. `lefthook` checks the message
   (`scripts/check-commit-msg.mjs`) and runs the secret scan and `just lint` before
   each commit. PRs are squash-merged under a Conventional Commit title.
5. A change that alters a design decision updates its entry in `docs/DECISIONS.md` in
   the same PR.
6. `CHANGELOG.md` is generated, never hand-edited. Regenerate it with
   `git cliff --config cliff.toml -o CHANGELOG.md`.

## When the nightly run is red

`.github/workflows/nightly.yml` runs the slow checks, and its `notify` job opens one
issue per failed, skipped or cancelled job. `mutation` (game-core) allows zero
surviving mutants: kill each survivor with a test, never with a baseline.
`mutation-server` fails when survivors exceed the cap in the `mutate-server` recipe.
Diff `mutants.out/missed.txt` against the last run before touching the cap. A
`smoke-republish` failure means publishing over live data would fail or lose data, so
fix it before the next publish.
