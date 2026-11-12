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

## Updating an eval baseline

Baselines in `evals/baselines/` change only on purpose, in the same PR as the change
that needs them:

| Baseline | When | How |
|---|---|---|
| `table-schemas.json` | a legal (additive) table change | `node evals/battle-schema-snapshot.eval.mjs --write` |
| `spacetime-types.json` | a legal nested-type change | `node evals/spacetime-type-snapshot.eval.mjs --write` |
| `content-hash.json` | any edit under `game-core/content/` | bump `CONTENT_VERSION` in `server-module/src/lib.rs` first, then run the command the `content-version` eval prints |
| `*-ids.json`, `evolution-path-edge-ids.json` | a new content id or evolution edge | edit by hand: append the new id (never remove or renumber); an edge's ledger entry stays even after the edge is retired |
| `dialogue-trees.txt` | a dialogue edit (also update `client/src/ui/dialogueContent.ts`) | `MR_BLESS_DIALOGUE_TREES=1 cargo nextest run -p monster-realm-module dialogue_trees_contract` |
| `client-visible-tables.json`, `client-callable-reducers.json` | a new public table/view or client-callable reducer | `just gen`, then edit the allowlist by hand; `client-surface-privacy` compares the two |

The `--write` modes only record the current source; the evals still reject a
non-additive change against the merge base, so `--write` cannot launder one.

## When the nightly run is red

`.github/workflows/nightly.yml` runs the slow checks, and its `notify` job keeps one open
issue per failed, skipped or cancelled job (a job still red the next night gets a comment on
it). `mutation` (game-core) and `mutation-server` (server-module) both allow zero surviving
mutants: kill each survivor with a test, never with a baseline or a budget. Only a mutant
that provably cannot change observable behaviour (equivalent: no input can tell it from the
original) may be excluded, in `.cargo/mutants.toml`, with the written proof, keyed by file +
function + operator + column. Both gates are sharded (6 and 8 shards) to fit GitHub's 6 h
job cap; every shard is its own verdict. Each shard uploads its `mutants.out/` as a workflow
artifact (`mutants-out-core-<n>` / `mutants-out-server-<n>`, kept 14 days); download the
failing run's and read its `missed.txt`. A `smoke-republish` failure means publishing over
live data would fail or lose data, so fix it before the next publish.

To check a change before pushing, `just mutate-diff` mutates only the `game-core` /
`server-module` lines changed against `origin/master` (pass another base, e.g. `just mutate-diff
HEAD~1`; an empty diff exits 0 without building). While killing survivors in one file,
`cargo mutants -p <crate> -f <file> --iterate` re-tests only the mutants the previous run missed.
