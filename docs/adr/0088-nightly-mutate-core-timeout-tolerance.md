# 0088 — Nightly `mutate-core`: timeout tolerance, one proven-equivalent exclusion, zero-tolerance on MISSED preserved

**Status:** Accepted
**Date:** 2026-07-10
**Slice:** fix-nightly-mutants
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates
**Decision:** Repair nightly mutate-core gate: kill 37 missed mutants with tests, exempt one proven-equivalent mutant, and add timeout tolerance via wrap-recipe exit-3 check.


- Status: accepted
- Date: 2026-07-10
- Milestone: fix-nightly (Nightly RED Jul 3–9: jobs `mutation` + `smoke-republish`)

## Context

The nightly `mutation` job (`just mutate-core` = `cargo mutants -p game-core`,
zero-tolerance per ADR-0050) went red on Jul 3 and stayed red. Two distinct
causes surfaced in the run logs:

1. **38 MISSED mutants** accumulated because M11a (#73, `bin/tiled_import.rs`
   hand-rolled JSON parser), M11b (`world.rs` `validate_zone_maps`), M12b/M12c
   (`npc/rules.rs`), and M13b (`content.rs` shop loaders) merged without
   mutation-killing tests — the gate is nightly-only, so PR CI never caught it.
2. **5 TIMEOUT mutants**, all loop-advance `*=` mutations in `tiled_import.rs`
   (inner cursor loops for `skip_whitespace`, `parse_number` ×3, `parse_array`):
   the mutated parser never reaches EOF, the test suite hangs past cargo-mutants'
   auto timeout, and cargo-mutants exits 3. A bare
   `cargo mutants` invocation treats exit 3 as failure even when **zero
   mutants survived**.

Separately (same slice, documented here for the record): the nightly
`smoke-republish` job had failed every run since it was added (PR #98) because
`scripts/smoke-republish.sh` passed the `join_game` reducer argument as a JSON
array (`'["SmokePlayer"]'`). The spacetime 2.6.0 CLI takes **each reducer
argument as its own JSON value**; the fixed form `'"SmokePlayer"'` was
confirmed against a live 2.6.0 instance (the array form reproduces the exact
CI error "trailing characters at line 1 column 5"). No signature drift was
involved — the call had never worked; ADR-0079's failure policy (nightly
failure → next slice in the queue) is unchanged.

## Decision

1. **Kill all killable MISSED mutants with tests** (37 of 38): in-file
   `#[cfg(test)]` additions in `tiled_import.rs`/`content.rs`/`world.rs`,
   `npc/m12a_gating_tests.rs` additions, plus a new
   `game-core/tests/tiled_import_cli.rs` integration test that spawns
   `env!("CARGO_BIN_EXE_tiled_import")` to kill the two `fn main` mutants
   (bin `main` is unreachable from unit tests). Each test carries a
   `// kills:` comment naming its census mutant.
2. **Exclude the one provably-equivalent mutant** via `.cargo/mutants.toml`
   `exclude_re`, line-pinned to
   `npc/rules.rs:61:15: replace > with >= in toward_home`.
   **Equivalence proof:** `toward_home` takes the X-branch when
   `dx.abs() >= dy.abs()` (ties go to X). The Y-branch containing line 61 is
   therefore only reachable with `|dx| < |dy|`, which forces `|dy| >= 1`,
   i.e. `dy != 0`. On the reachable domain `dy > 0` and `dy >= 0` are
   extensionally identical — no test can distinguish the mutant. This is the
   exact case ADR-0050's recipe policy anticipates ("tighten/exclude
   equivalents as discovered"). Line-pinning is brittle-but-fail-loud: if the
   file shifts, the mutant resurfaces and nightly goes red, forcing a
   conscious re-pin (never a silent over-exclusion). By contrast 53:15
   (`dx > 0 → >= 0`) is NOT equivalent — `toward_home(home, home)` reaches
   the X-branch with `dx == 0` (West vs mutant East) — it gets a killing test.
3. **Wrap the `mutate-core` recipe** (justfile body only; the nightly.yml step
   stays exactly `- run: just mutate-core`): tolerate cargo-mutants exit 3
   **iff `mutants.out/missed.txt` is empty**; fail on ANY missed line
   regardless of exit code; pass through any exit other than 0/2/3 (build or
   config errors stay loud). Rationale: a timed-out infinite-loop mutant *is
   detected* — the suite hangs, which is how the mutation manifests;
   cargo-mutants buckets timeouts separately from missed for exactly this
   reason. Zero-tolerance on MISSED is unchanged (and now enforced by
   count-compare, not exit-code inference). This mirrors the blessed
   `mutate-server` recipe shape (ADR-0050 amendment A2) — with one deliberate
   asymmetry: **no `cap=` parameter exists** for mutate-core; the tolerance is
   hard-zero.
4. **Guard the new surface with an eval**:
   `evals/mutate-core-recipe-integrity.eval.mjs` (auto-discovered by
   `evals/run.mjs`) verifies the recipe body contains `-p game-core` + the
   `missed.txt` count-compare; bans `--shard`/`--file`/`--exclude-re`/
   `--exclude`/` -o `/`--output`, a `cap=` parameter, and shell-neuter suffixes
   (`|| true`, `; exit 0`); and pins `.cargo/mutants.toml` to EXACTLY the one
   blessed exclusion (any growth or loosening of the exclusion list fails the
   eval). All predicates use literal regexes/`indexOf` (no `new RegExp` —
   Semgrep detect-non-literal-regexp has bitten 3×), with proof-of-teeth
   fixtures that bite before the real-file checks.

## Alternatives considered

- **Restructure the parser loops so timeout mutants terminate and get caught**
  — rejected: production-logic change to a bin tool purely to satisfy the
  mutation runner; risks real bugs for zero behavioral benefit.
- **Raise cargo-mutants timeout / `timeout_multiplier` config** — rejected:
  infinite loops never terminate, so any finite timeout still exits 3; a
  larger multiplier only slows the nightly and can mask genuinely slow tests.
- **Exclude `tiled_import.rs` from mutation scope** — rejected: the project's
  posture is "kill survivors, don't narrow scope" (PR #66 precedent; the
  wiring eval treats `--file`/`--exclude-re` in recipe bodies as bypass
  smells). The parser feeds shipped content; its tests are worth having.
- **`#[mutants::skip]` attribute for the equivalent mutant** — rejected: adds
  a dependency (fan-out-ineligible) and skips the whole function, losing
  coverage of `toward_home`'s other (killable) mutants.
- **Rewrite line 61 (`dy.is_negative()`) to dodge the equivalent mutant** —
  rejected: production change outside the slice's test/config allowance;
  the config exclusion with a written proof is smaller and reviewable.

## Consequences

- Nightly `mutation` goes green and stays meaningful: 0 missed enforced by
  count, timeouts documented-tolerated, build errors loud.
- **Accepted gap (bounded):** a future genuinely-slow (non-infinite) test that
  times out under mutation is tolerated *only when 0 mutants are missed* —
  same honesty class as ADR-0050's recorded gaps.
- `.cargo/mutants.toml` applies workspace-wide (also to `mutate-server`); the
  single pinned exclusion references a game-core-only path, and the eval pins
  the list so it cannot quietly grow.
- **Accepted gap (pre-existing class):** `mutate-core` and `mutate-server`
  both read the default `mutants.out/` output directory (the eval bans
  `--output`/`-o` redirects as neutering vectors). Parallel LOCAL runs of the
  two recipes from the same checkout would clobber each other's
  `missed.txt` before the count-compare; the nightly jobs run on separate
  runners and are unaffected. Same gap class as ADR-0050's recorded gaps.
- The smoke-republish Phases 3–6 (republish-without-delete, `sync_content`,
  survival asserts) are now exercised nightly for the first time — the
  ADR-0006/ADR-0037 no-wipe promise finally has its intended teeth.
