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

`.github/workflows/nightly.yml` runs the slow checks, and its `notify` job opens one
issue per failed, skipped or cancelled job. `mutation` (game-core) allows zero
surviving mutants: kill each survivor with a test, never with a baseline.
`mutation-server` fails when survivors exceed the cap in the `mutate-server` recipe.
Each run uploads its `mutants.out/` as a workflow artifact (`mutants-out-core` /
`mutants-out-server`, kept 14 days); download the failing run's and the last green
run's and diff their `missed.txt` before touching the cap. A new survivor in code the
change touched gets a killing test. Raise the cap only for a survivor proven
equivalent (it cannot change observable behaviour), recorded as a `MUT-server-*` row
in `docs/debloat/ledger.ndjson`. The cap is then that full-run missed count plus
headroom of max(3, 5%). A
`smoke-republish` failure means publishing over live data would fail or lose data, so
fix it before the next publish.
