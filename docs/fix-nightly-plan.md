# Plan — slice `fix-nightly` (branch `fix/nightly-mutation-smoke`)

Restore the Nightly workflow to green (RED 7 consecutive nights, Jul 3–9; jobs
`mutation` + `smoke-republish`). Planner output ratified 2026-07-10 with
amendments A1–A3 (below). ADR: 0088 (pre-assigned).

## Root causes (from `gh run` logs + local reproduction)

1. **`mutation` (`just mutate-core`, zero-tolerance per ADR-0050)** — red since
   Jul 3. PR #73 (M11a, Jul 2, merged hours after the last green nightly) added
   `game-core/src/bin/tiled_import.rs` (hand-rolled JSON parser bin) whose
   mutants were never killed; M11b/M12b/M12c/M13b added more. Latest run:
   `819 mutants tested in 72m: 38 missed, 673 caught, 104 unviable, 4 timeouts`
   → cargo-mutants exit 3. **Local reproduction (scoped, 4 min): identical —
   38 missed + 4 timeouts** (census at `docs/fix-nightly-census.txt`, the
   authoritative kill-list with current line numbers).
2. **`smoke-republish`** — failed its FIRST-ever nightly run (added PR #98,
   Jul 4); never green. `scripts/smoke-republish.sh:42` passes the `join_game`
   reducer arg as a JSON array `'["SmokePlayer"]'`; spacetime 2.6.0 CLI wants
   each reducer arg as its own JSON value. **Empirically confirmed locally**:
   array form reproduces the exact CI error ("trailing characters at line 1
   column 5"); `'"SmokePlayer"'` succeeds; with only that change the WHOLE
   script (Phases 1–6, incl. never-CI-exercised republish/sync_content/assert
   phases) passes end-to-end against a live 2.6.0 instance.

## Acceptance criteria (EARS)

Job 1 — mutation:
- **AC-M1**: game-core tests exist such that `cargo mutants -p game-core`
  reports **0 MISSED** (down from 38).
- **AC-M2**: WHEN cargo-mutants reports ≥1 TIMEOUT and 0 MISSED, `mutate-core`
  SHALL exit 0 (an infinite-loop mutant that hangs the suite is *detected*).
- **AC-M3**: WHEN cargo-mutants reports ≥1 MISSED, `mutate-core` SHALL exit
  non-zero regardless of timeout count (zero-tolerance preserved).
- **AC-M4**: IF cargo-mutants exits with a build/config error (not 0/2/3),
  the recipe SHALL fail loud with that exit code.
- **AC-M5**: the recipe body SHALL contain `-p game-core` + a `missed.txt`
  count-compare, and SHALL NOT contain `--shard`/`--file`/`--exclude-re`/
  `--exclude`/` -o `/`--output`, nor a `cap=` parameter (hard zero).
- **AC-M6**: `nightly.yml` `mutation` job step stays EXACTLY
  `- run: just mutate-core`, no `if:`/`continue-on-error:` (wiring eval).
- **AC-M7**: every new mutant-killing test bites a specific census mutant
  (`// kills:` comment naming it) and fails when that mutant is applied.
- **AC-M8** (A2): `.cargo/mutants.toml` SHALL contain EXACTLY ONE `exclude_re`
  entry — the line-pinned, provably-equivalent mutant
  `rules.rs:61:15 replace > with >= in toward_home` — guarded by an eval tooth
  that fails if the list grows or loosens.

Job 2 — smoke-republish:
- **AC-S1**: the script passes the `join_game` arg as a bare JSON string value
  (`'"SmokePlayer"'`), not a JSON array; comment corrected.
- **AC-S2**: starter-monster poll (Phase 2) passes.
- **AC-S3**: the WHOLE script exits 0 against a live local 2.6.0 instance
  (Phases 3–6 validated — already demonstrated pre-plan; re-proven at T7 with
  the committed script).
- **AC-S4**: no player-table assertion reintroduced
  (`smoke-republish-on-disconnect-compat` stays green).
- **AC-S5**: `nightly-smoke-wiring` eval stays green.

## Amendments to the planner output

- **A1 — T0 satisfied**: the scoped red-proof (`cargo mutants -p game-core
  --re '<census fns>'`: 162 tested / 38 missed / 107 caught / 4 timeouts, 4 min)
  already reproduces CI exactly with current line numbers. No full baseline run;
  the full `just mutate-core` runs once at T8.
- **A2 — R4 resolved, 61:15 is provably equivalent**: `toward_home`'s Y-branch
  is guarded by `dx.abs() >= dy.abs()` taking the X-branch on ties; the else
  branch requires `|dx| < |dy|` → `|dy| ≥ 1` → `dy ≠ 0`, so `dy > 0` and
  `dy >= 0` are indistinguishable on the reachable domain — no test can kill
  it. Remedy per the blessed ADR-0050 policy ("tighten/exclude equivalents as
  discovered", quoted in the justfile itself): a **line-pinned** `exclude_re`
  in `.cargo/mutants.toml` (config change, within touches) + the equivalence
  proof in ADR-0088 + an eval tooth pinning the exclusion list to exactly that
  entry. Line-pinning is brittle-but-fail-loud: drift resurfaces the mutant →
  nightly red → pin updated consciously. NOTE: 53:15 (`dx > 0 → >= 0`) is NOT
  equivalent — `toward_home(home, home)` reaches the X-branch with `dx == 0`
  (returns West; mutant returns East) — it gets a killing test, not exclusion.
- **A3 — eval scope extended**: the new
  `evals/mutate-core-recipe-integrity.eval.mjs` also guards
  `.cargo/mutants.toml` (exact allowed-exclusion pinning, AC-M8), since the
  config file changes mutation semantics for every run in the tree.

## Tasks (test-first; tester ≠ implementer; implementer never edits gating tests)

- **T1** tester: `evals/mutate-core-recipe-integrity.eval.mjs` — predicates +
  proof-of-teeth (bite before real-file checks; NO `new RegExp`, literal
  regex/indexOf only). Teeth: recipe absent; `--file`/`--exclude` narrowing;
  `cap=` smuggled tolerance; `|| true`/`; exit 0` shell-neuter; missing
  `missed.txt` compare; mutants.toml with extra/loosened entries; positive
  controls (canonical wrapper + canonical mutants.toml pass every tooth).
  Starts RED against the current bare recipe.
- **T2** tester: kill tiled_import.rs 28 missed — in-file `#[cfg(test)]` tests
  (negative-byte/literal cases, depth-boundary pair at exactly-64/65, number
  known-answer tests incl. `-12`, `1.5`, `1e3`, `1.5e-2`, trailing-content
  pair, two-tilelayer first-wins, non-square 3×2 GID map) + NEW
  `game-core/tests/tiled_import_cli.rs` via `env!("CARGO_BIN_EXE_tiled_import")`
  for the two `main` mutants (bad arg count → exit 1 + usage; valid input →
  exit 0 + RON on stdout).
- **T3** tester: content.rs — `load_shops()` non-empty + known M13b content;
  `parse_shops_parts` non-trivial parts; `validate_npc_content` heal-location
  cost_item_id present-passes/absent-errors pair.
- **T4** tester: world.rs `validate_zone_maps` — width == bound passes /
  bound+1 errors; height == bound passes / bound+1 errors (kills `>`→`>=`/`==`).
- **T5** tester: npc/rules.rs — `toward_home(home, home)` == West (kills
  53:15); seeded `npc_decide` arm tests: search ticks for `(h>>1)%4 == 0`
  (assert North) and `== 2` (assert East) with `h % 5 != 0` (kills arm
  deletions). 61:15 → A2 exclusion, not a test.
- **T6** specialist: smoke script arg + comment fix (AC-S1); justfile
  `mutate-core` wrapper (AC-M2..M5, sketch in ADR-0088); `.cargo/mutants.toml`
  (A2). nightly.yml expected UNTOUCHED (verify only).
- **T7** specialist: scoped mutants re-run (green proof, ~4 min) → full
  `just smoke-republish` against local instance → `node evals/run.mjs`.
- **T8** verifier-gated full gate: full `just mutate-core` (expect 0 missed /
  timeouts tolerated / exit 0, ~70 min, backgrounded) + full `just ci`.

## Anti-patterns (named)

Scope-narrowing flags in recipes; shell-neuter (`|| true`, `; exit 0`);
any `if:` step in mutation/coverage/mutation-server jobs (flat-scan eval);
`new RegExp(...)` in evals (Semgrep bite ×3); vacuous mutant tests (must fail
under the applied mutant); trusting stale census line numbers (use
`docs/fix-nightly-census.txt`); reintroducing `FROM player` in the smoke
script (RT-SR-01); JSON-array reducer args; editing supervisor-owned
`CHANGELOG.md`/`docs/adr/README.md`; implementer editing gating tests;
unbounded growth of `mutants.toml` exclusions (eval-pinned).

## Risks

- **R1 CONFIRMED — not parkable**: any surviving missed mutant leaves nightly
  red; all 38 land here (37 tests + 1 proven-equivalent exclusion).
- **R2 Phases 3–6 unproven in CI** — already validated locally pre-plan;
  re-proven at T7 with the committed script.
- **R3 `main` mutants need the bin seam** — CARGO_BIN_EXE integration test;
  if cargo-mutants doesn't kill 522/523 with it (verify in T7 scoped run),
  fall back to a `run(args) -> ExitCode` seam (test-enabling refactor).
- **R5 wrapper tolerates a genuinely-slow-test timeout** — bounded: only with
  0 missed; documented as accepted gap in ADR-0088.
- **R6 eval teeth theater** — every bad fixture must bite before real checks.
