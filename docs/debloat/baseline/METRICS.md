# Phase 0 baseline — oracle runs and metrics

Recorded 2026-09-27 at tag `pre-debloat` (commit 950c083) on branch `debloat/phase0`.
Method: `method-snapshot.sh` in this directory (re-run at program end for the "after" table).

## Baseline CI (`just ci` steps, run sequentially, warm caches)

| step | verdict | seconds |
| lint | OK | 14 |
| typecheck | OK | 0 |
| test | OK | 17 |
| eval | OK | 91 |
| security | OK | 2 |
| wasm | OK | 5 |
| client-typecheck | OK | 1 |
| client-test | OK | 7 |
| observability-validate | OK | 7 |

Overall: overall=OK
Suite evidence: 2500 nextest tests across 21 binaries; 99/99 evals PASS; 133 vitest files / 3447 tests; biome over 397 files; 8 observability checks.

## Exclusive e2e (Playwright, local spacetime, workers=1)

- expected=76 unexpected=0 skipped=1 flaky=0, 21 spec files, 121 s (suite only; spacetime ready in 2 s)
- The 1 skip is permanent and pre-existing: `recruit.spec.ts › R4: bait selector lists only items with recruit_bonus > 0` — annotated in-repo as "blocked: __game() test-hook not exposed".
- Roster: `rosters/playwright-list.txt` (Total: 77 tests in 21 files = 76 runnable + 1 skip).

## Suite count floors (the rebuilt CI must meet or explain every delta)

- nextest tests: 2500
- vitest tests: 3447
- playwright: Total: 77 tests in 21 files
- eval files: 99

## Tracked LOC by category

See `loc-by-category.md`. Categorization caveat: "production" counts every non-test-named file under the src trees, so it includes inline `#[cfg(test)]` modules; "client-tests" = `client/e2e/` + `*.test.*` under `client/`; the same script re-measures at program end, so deltas are like-for-like.

## Surface snapshots in this directory

- `evals-baselines/` — copies of `evals/baselines/*.json` (schema, spacetime types, content-id rosters) as they stood at Phase 0.
- `client_wasm.d.ts` — the wasm-bindgen export surface (built artifact, gitignored at source).
- `server-surface.md` — table visibility roster + all reducer signatures, distilled from the generated okf bundle.
- `module-bindings.sha256` — per-file SHA-256 of `client/src/module_bindings/` (aggregate in `module-bindings.aggregate.sha256`); the bindings must be byte-identical at every phase exit unless a conductor-approved schema change regenerates them.
- `rosters/` — full test/eval rosters backing the count floors.
