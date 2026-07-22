# 0050. Nightly mutation/coverage gates (not per-PR) + bindings-drift in the fast `ci` job

**Status:** Accepted
**Date:** 2026-06-27
**Slice:** m8.5c
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates
**Decision:** Run mutation and coverage gates nightly (not per-PR); include bindings-drift check in the fast per-PR ci job to catch schema/code divergence early.


- Status: accepted
- Date: 2026-06-27
- Milestone: M8.5c (gate teeth & test rigor)

> **ADR numbering note.** 0044–0049 are taken; 0050 is the next free number. This
> ADR is the SSOT for the two CI-policy decisions below; the broader M8.5 doc sweep
> (M8.5e) reconciles any stale spec/PLAN cross-references.

## Context and problem statement

Two gaps surfaced while hardening the M8.5 gates:

1. **The "Done =" claim was false.** `AGENTS.md` and the PR template both claimed
   `just ci` is "meaningful (coverage + mutation + security)". But `just ci`
   (`justfile`: `lint typecheck test eval security wasm client-typecheck
   client-test`) runs **neither** mutation **nor** coverage. We want both signals
   without slowing the per-PR inner loop that ADR-0043 deliberately keeps fast.

2. **bindings-drift was structurally un-catchable.** `evals/bindings-drift.eval.mjs`
   runs under `just eval` (the fast `ci` job), where it does a real
   `spacetime generate` + diff against the committed TS bindings — but **only if the
   spacetime CLI is on PATH**. The `ci` job did **not** install the CLI, so the eval
   SKIPPED (`pass:true`) on every PR. The CLI is installed only in the slow `e2e`
   job, which runs `just e2e` (Playwright), **not** `just eval` — so committed-binding
   drift was never actually compared anywhere in CI. A drift could merge silently.

## Considered alternatives

- **Run mutation + coverage on every PR.** Rejected: cargo-mutants and a full
  coverage run are minutes-scale; putting them on the PR path directly contradicts
  ADR-0043's fast inner loop and would tax every push.
- **Make `just ci` itself include coverage/mutation.** Rejected for the same reason;
  also it would couple the fast local gate to slow tooling contributors run rarely.
- **bindings-drift: a "no-CLI in CI = fail" backstop with no CLI install.** Rejected:
  that would red **every** `ci` run (the CLI genuinely isn't there). The fail-loud
  branch is a *regression detector* for the install step, not the primary mechanism —
  the primary fix is to actually install the CLI in `ci` so the real compare runs.
- **bindings-drift only in the e2e job.** Rejected: e2e runs `just e2e`, not
  `just eval`; wiring the eval there too would duplicate eval invocation and still
  leave the fast gate blind to drift.

## Decision outcome

### 1. Mutation + coverage run NIGHTLY, never per-PR

- Chosen: a new `.github/workflows/nightly.yml` (`on: schedule` cron `0 7 * * *`
  + `workflow_dispatch`; `permissions: contents: read`) with two jobs:
  - **mutation:** `just mutate-core` → `cargo mutants -p game-core` (scoped to the
    rule core; the existing `mutate` recipe is `--workspace` and stays for manual
    use). **cargo-mutants policy:** report and **fail on surviving mutants** (the
    default); tighten / `--exclude` equivalent mutants as they are discovered and
    triaged, rather than weakening the recipe pre-emptively.
  - **coverage:** `just coverage` → a self-contained vitest line-coverage run
    (`npm ci` + `npm i --no-save -D @vitest/coverage-v8@2.1.9` +
    `npx vitest run --coverage --coverage.provider=v8 --coverage.reporter=text
    --coverage.thresholds.lines=25`). vitest exits non-zero below the threshold.
- **Initial coverage threshold: 25% lines.** Measured current line coverage on
  the M8.5c worktree = **29.65%** (the denominator includes the gitignored,
  regenerated `client/src/module_bindings/` — generated code with ~0% coverage —
  which is why the absolute number is low; the metric is used as a **regression
  ratchet**, not an aspirational target). 25 is set a few points below 29.65 so it
  is green today but bites on a real regression. Tightening the threshold and/or
  excluding the generated bindings from the denominator is M8.5d's domain (it owns
  `client/vite.config.ts`); this ADR deliberately keeps the recipe self-contained
  (CLI flags only) and touches neither `package.json`, the lockfile, nor
  `vite.config.ts`. The coverage-provider pin (`@vitest/coverage-v8@2.1.9`) matches
  the project's pinned `vitest@2.x` (the unpinned `*` resolves to v4 and fails the
  peer-dep check).
- **No `continue-on-error` on the threshold steps** — a soft failure would make the
  gates toothless. Action major versions are pinned (`@v4` etc.) to match `ci.yml`;
  M8.5d SHA-pins all workflow actions, nightly.yml included. The nightly rust cache
  uses a **distinct** `prefix-key: v1-nightly` so it never collides with the ci
  (`v1-ci`) / e2e (`v1-e2e`) caches.
- `just ci` is **unchanged in scope** — it remains the fast per-PR gate; the slow
  signals live exclusively in nightly. The false "coverage + mutation" claim in
  `AGENTS.md` and `.github/PULL_REQUEST_TEMPLATE.md` is corrected to state exactly
  what `just ci` enforces vs what nightly enforces (surgical edit; the broader sweep
  is M8.5e).

### 2. bindings-drift now runs for real in the fast `ci` job

- Chosen: install + pin the SpacetimeDB CLI (2.6.0) in the `ci` job (mirroring the
  e2e job's `Install SpacetimeDB CLI` + `Pin spacetime 2.6.0` steps), inserted
  after `just setup` and before `just eval`. Now `just eval` →
  `bindings-drift.eval.mjs` runs the real `spacetime generate` + diff against the
  committed bindings on every PR, so drift reds the fast gate.
- The eval's no-CLI branch **fail-louds in CI**: if `process.env.CI` is set AND
  committed bindings exist AND the CLI is absent → `pass:false` (this catches a
  regressed CLI-install step); locally, a CLI-less environment still SKIPS green.
- **Accepted cost:** the `ci` job now builds the server module once more (for
  `spacetime generate`). This is accepted per the slice brief and recorded here — a
  drift catchable only in the slow e2e job (which never actually ran the eval) was a
  correctness hole worth the one extra module build.

## Consequences

- **Positive:** mutation + coverage signals exist without taxing the PR path;
  the fast inner loop (ADR-0043) is preserved; bindings drift is now genuinely
  caught on every PR and a regressed CLI install fail-louds; the project's "Done ="
  documentation is now accurate.
- **Negative / cost:** one extra module build in the `ci` job (bindings-drift);
  nightly cannot fully run from a PR, so its YAML correctness (real thresholds, no
  `continue-on-error`, `just ci` scope unchanged) is validated by the verifier
  rather than by a PR run.
- **Follow-ups:** M8.5d SHA-pins the workflow actions and owns whether the generated
  `module_bindings/` are excluded from the coverage denominator (which would let the
  threshold be raised meaningfully). cargo-mutants exclusions are added as equivalent
  mutants are triaged.
- **References:** ADR-0043 (CI caching / fast inner loop — the constraint this
  decision preserves), ADR-0009 (e2e against a version-pinned standalone
  SpacetimeDB — why the CLI is pinned at 2.6.0), ADR-0010 (every mechanical gate
  ships a known-bad fixture / proof-of-teeth — why bindings-drift must actually run).

---

## Amendment (M13.5a — gate-of-gates): coverage ratchet re-measure, server-module mutation gate, CI-integrity enforcement topology

- Date: 2026-07-04 · Milestone: M13.5a (spec `M13.5-seventh-review-residuals.spec.md` §13.5a; D-13.5-2 decided by Drew 2026-07-04)

### A1. Coverage threshold re-measured post-exclusion; ratchet re-applied (25 → 96)

Decision #1 set `--coverage.thresholds.lines=25` from a **29.65%** measurement whose
denominator included the ~0%-covered generated `module_bindings/` (see the original
text above — this ADR's own follow-up said excluding them "would let the threshold be
raised meaningfully"). The exclusions landed (M-infra-c / vite `coverage.exclude`)
with the threshold left unchanged, leaving the ratchet slack. Fresh measurement on
the m13.5a worktree (base `e875af0`, vitest v8, post-exclusion): **99.35% lines**.
Per the ratchet policy the threshold is re-set to **96** (`justfile` `coverage:`
recipe) — a few points below actual: green today, bites a real regression. The stale
`vite.config.ts` "threshold is UNCHANGED" comment is corrected. The measurement's
denominator is now tamper-gated: `dom-shell-coverage-exclusion.eval.mjs` adds
`findUnsanctionedExclusions` (exact-set comparison of the `coverage.exclude` literals
vs the DOM_SHELLS allowlist + `src/module_bindings/**` + the
`...coverageConfigDefaults.exclude` spread token) and an include-narrowing guard
(`coverage.include` must stay `['src/**/*.ts']` — narrowing the include shrinks the
denominator without touching exclude). The `coverage:` recipe body itself is guarded
(threshold literal ≥ 96) by the nightly wiring eval.

### A2. Server-module mutation gate (D-13.5-2), nightly, gating

New nightly job runs mutation testing over the server module. **Package-name
nuance:** the `server-module/` directory's cargo package is **`monster-realm-module`**
(`cargo mutants -p server-module` fails "Package not found in source tree").

- **Baseline** (2026-07-04, `e875af0`, cargo-mutants 27.1.0, `--test-tool nextest`,
  local 32-core `-j 4`): **253 mutants — 180 missed / 56 caught / 17 unviable —
  2 min wall-clock.** server-module is an imperative shell: its reducers are covered
  by evals/integration/e2e, not in-crate units (the rule core, game-core, carries the
  zero-survivor `mutate-core` gate), so a high survivor count is expected and the
  gate is a **regression ratchet**, not an aspirational target — same posture as the
  coverage threshold above.
- **Re-baseline (2026-07-15, ADR-0118):** measured on master `908c99b` (cargo-mutants
  27.1.0, `--test-tool nextest`, local 32-core): **499 mutants — 309 missed / 158
  caught / 32 unviable — 3 min wall-clock.** The crate roughly doubled from merged
  M15 trading / M16 PvP / M16.5 reducer work (new files `pvp.rs`, `trading.rs`;
  survivors verified to sit in `#[reducer]` bodies / ctx-taking helpers, killable
  in-crate set empty; miss ratio improved 71% → 62%). **Cap = 309** (exact
  measurement, same convention as the original 180); the wiring-eval cap ceiling
  raised 200 → 340 in the same commit. Full evidence + procedure: ADR-0118.
- **Threshold mechanism:** cargo-mutants has no built-in survivor-count cap, so the
  `mutate-server` justfile recipe (shebang) runs
  `cargo mutants -p monster-realm-module --test-tool nextest`, tolerates exit code 2
  (mutants missed) but no other non-zero exit, then counts `mutants.out/missed.txt`
  lines and fails if the count exceeds the cap. **Cap = 180** (the exact baseline,
  per review: "tighten, don't weaken" — bump only deliberately, with the bump
  justified in a commit touching this ADR (re-baselined to 309, 2026-07-15 — see
  the Re-baseline bullet and ADR-0118)). `--test-tool nextest` is pinned for
  determinism with the recorded baseline (server-module has zero doctests, so
  nextest-vs-cargo-test does not change catch results).
- **Sharding:** NOT needed — 2-min local runtime extrapolates to roughly 15–30 min on
  a 2-core hosted runner, far inside the nightly window; the spec's "sharded if
  runtime demands" clause is satisfied by this recorded measurement. Single job, no
  matrix. (Re-baseline check 2026-07-15: 43 min observed on the hosted runner at the
  499-mutant scale — still inside the nightly window; sharding still not needed.)
- **No `continue-on-error`** (same posture as decision #1 — a soft mutation gate is
  toothless), distinct cache `prefix-key: v1-nightly-server`, SHA-pinned actions
  matching the file's style. The job is covered from its first commit by the
  nightly wiring guards below (spec 13.5a-6 mandate).

### A3. Gate-of-gates enforcement topology (13.5a-1/2/5)

**The self-sealing hole (the seventh review's one High):** deleting or neutering
`run: just eval` / `just test` in ci.yml's `ci:` job tripped nothing — every eval
runs under the very step being deleted. Nightly `mutation:`/`coverage:` jobs were
equally unguarded prose.

**Fix — mutual reinforcement across a non-self-sealing anchor:**

- `evals/ci-gate-wiring.eval.mjs` asserts, against a **hardcoded** oracle (NOT
  derived from the justfile — deriving would let a single commit remove a dep from
  `ci:` and its ci.yml step simultaneously without tripping): the `ci:` job block
  contains all 7 `run: just <verb>` steps (lint, typecheck, test, eval, wasm,
  client-typecheck, client-test), each **step-level** un-neutered — exact run value
  (rejects `|| true` / `; exit 0` shell neuters), not commented, no step/job `if:`,
  no truthy `continue-on-error` **scoped per-step** so the legitimate
  `if:`/`continue-on-error` on the dependency-review step is not flagged; an empty
  job-block extraction fails loudly (no vacuous pass). It also cross-checks every
  justfile `ci:` dep appears in ci.yml (13.5a-5) minus the documented substitution
  `security` → gitleaks-action + `cargo audit` + Semgrep + SBOM; guards the
  `test:`/`eval:`/`client-test:` recipe **bodies** (canonical command substrings —
  gutting a recipe while ci.yml stays pristine was the largest bypass found in
  review); and checks `evals/run.mjs` integrity (zero-eval guard + per-eval
  try/catch + failure exit path) — run.mjs cannot guard itself from inside `just
  eval`.
- **Anchors (where the eval runs):** (1) under `just eval` on every CI run; (2) a
  dedicated `- run: node evals/ci-gate-wiring.eval.mjs` step in the **e2e job** — a
  separate PR-blocking job, so deleting the `ci:` job's `just eval` step no longer
  hides the check (the file is directly runnable via an `import.meta.url`
  main-guard, exits non-zero on failure); (3) a `lefthook.yml` pre-commit command —
  wired for environments with lefthook installed. The eval asserts anchors (2) and
  (3) stay wired, so deleting either trips the runs that remain.
- `evals/nightly-smoke-wiring.eval.mjs` gains `nightlyHasMutationJob` /
  `nightlyHasCoverageJob` / `nightlyHasServerMutationJob` + per-job neuter detection
  (no `if:` / truthy `continue-on-error` inside those three job blocks; schedule +
  workflow_dispatch triggers live), plus recipe-body guards for `coverage:`
  (threshold literal ≥ 96) and `mutate-server` (count-compare present; no
  `--shard`/`--file`/`--exclude-re` narrowing; cap default ≤ 200 — ceiling raised
  to 340 by ADR-0118, 2026-07-15).

**Accepted gaps (recorded honestly — threat model is honest error / lazy shortcut,
not an adversary with admin):**

1. A single commit that deletes BOTH the `ci:` job's `just eval` step AND the e2e
   anchor step defeats both CI-side layers; lefthook is the only remainder and the
   lefthook binary is not installed on the current dev machine (config-as-
   documentation until it is). Residual mitigation: PR review of any
   workflow-touching diff.
2. The nightly job names (`mutation:`, `coverage:`, and the new server job) are a
   stable contract — renaming one false-REDs the wiring eval (fails loud, not
   silent; update the eval deliberately with the rename).
3. A duplicate `exclude:` key in vite.config.ts could shadow the checked array at
   runtime (source-text checks can't see object-literal override semantics); Biome's
   duplicate-key lint covers this class.
4. run.mjs's zero-eval guard trips only at exactly zero eval files (the "40+" in its
   message is prose); mass-deletion to one file is caught by eval-count review, not
   mechanically.
5. The `mutate-server` cap default is eval-ceiling-checked (≤ 200) (ceiling 340 as
   of ADR-0118) rather than pinned exactly, so a deliberate, reviewed bump inside
   the ceiling doesn't require an eval edit; bumps must update this ADR (see A2).
6. `jobIsNotNeutered` is a flat block scan (unlike `ciStepsUnneutered`'s per-step
   scoping), so the three guarded nightly jobs (`mutation:`, `coverage:`,
   `mutation-server:`) must never carry a legitimate step-level `if:` (e.g. an
   `if: failure()` log-dump like smoke-republish's). Adding one will false-RED the
   wiring eval by design — either keep diagnostics out of the guarded jobs or
   upgrade the predicate to per-step scoping when the need first arises.
7. `selfContainsMainGuard` (the ci-gate-wiring eval's check that its own source
   still carries the standalone main-guard) matches needle tokens with `indexOf` —
   a gutted file that keeps the tokens in comments would pass it. Low risk: gutting
   the file also has to survive the e2e-anchor run and PR review of an
   eval-infrastructure diff; recorded rather than parsed-AST-hardened.


---

## Amendment (2026-07-22 — vitest 4.x: derive the coverage provider from the installed vitest)

- Date: 2026-07-22 · Trigger: `npm audit fix --force` (commit `6a81c6a`) intentionally
  bumped `client/package.json` devDep `vitest` `^2.0.0` → `^4.1.10` (resolved 4.1.10).

**Problem.** Decision #1 pinned the nightly coverage provider to a hardcoded
`@vitest/coverage-v8@2.1.9` "to match the project's pinned vitest@2.x" — and this ADR
itself warned that "the unpinned `*` resolves to v4 and fails the peer-dep check".
vitest's `peerDependencies` require `@vitest/coverage-v8` at the **exact** vitest
version, so once vitest became 4.1.10 the pinned 2.1.9 provider's `npm i` fails with
`ERESOLVE` and `just coverage` dies at that step, before vitest runs. The provider
version was a **duplicated source of truth** (the same fact — the installed vitest
version — kept in two files) and drifted exactly as the Tier-1 "mechanical enforcement
over discipline" principle predicts a remember-to-update pin will.

**Decision.** The `coverage:` recipe no longer hardcodes the provider version; it
**derives** it from the installed vitest at run time:
`npm i --no-save -D @vitest/coverage-v8@$(node -p 'require("vitest/package.json").version')`.
The vitest installed by `npm ci` (from the lockfile) is the single source of truth and
the provider is always its exact match, so this drift class is now structurally
impossible — no second literal, no new gate. The `--no-save` posture is unchanged
(touches neither `package.json`, the lockfile, nor `vite.config.ts`). If vitest is
absent, `node -p` exits non-zero and the `&&` chain fails loud (Tier-1 fail-early)
rather than installing a version-less `@vitest/coverage-v8@`. The recipe stays one
POSIX-shell line (command substitution); nightly runs on Linux.

**Threshold re-measured under vitest 4.** vitest ≥3's v8 provider uses AST-aware
remapping and measures lines slightly differently than the v2 figure in A1. Fresh
measurement post-upgrade (vitest 4.1.10 / `@vitest/coverage-v8` 4.1.10, all 1327 unit
tests green): **97.56% lines** (was 99.35% under v2). Still above the **96** ratchet,
so the threshold is **unchanged**; headroom narrowed ~4.3pp → ~1.6pp, recorded so a
future sub-96 dip reads as a real regression, not a surprise.

**Guard / CI interaction.** `coverageRecipeThresholdIntact`
(`evals/nightly-smoke-wiring.eval.mjs`) parses the recipe only for the
`--coverage.thresholds.lines=` literal (≥96) — the provider token is not asserted, so
deriving keeps that gate green; `nightly.yml` invokes `just coverage` unchanged, so no
workflow/renovate edit is needed.

**Related build fix (same audit-fix commit).** `npm audit fix --force` also *downgraded*
`vite-plugin-top-level-await` `^1.4.4` → `^1.2.2` to clear a moderate advisory in its
transitive `uuid` (GHSA-w5hq-g745-h8pq). But 1.2.2's `package.json` `exports` map does
not expose its type declarations, so `tsc --noEmit` (`just client-typecheck`, a `just
ci` gate) fails TS7016 on `vite.config.ts`. Restored the declared range to `^1.4.4`
(typecheck green). The uuid advisory is dev-only / build-time (the plugin is not in the
shipped bundle) and is **not** CI-gated (the SCA gate is `cargo audit`, Rust only; there
is no `npm audit` gate) — it predates this audit-fix. Clearing it without the breaking
downgrade would need an npm `overrides` pin of `uuid` to a patched, API-compatible
version (deferred pending owner decision).

**Coverage denominator under v4 (M8.5d domain, resolved 2026-07-22).** vitest 4 also
empties `coverageConfigDefaults.exclude` to `[]` (it removed the non-Vitest/Vite default
patterns), so `client/vite.config.ts`'s `...coverageConfigDefaults.exclude` spread — kept
for forward-compat — no longer drops the unit **test files** from the coverage
denominator. Empirically the v4 report still excludes them (via the `include:
['src/**/*.ts']` scope + vitest's built-in test-file handling; 97.56% either way), but
relying on undocumented behavior is fragile, so the config now excludes them
**explicitly** with `'src/**/*.test.ts'`. The exact-set guard
(`dom-shell-coverage-exclusion.eval.mjs`) gains a `REQUIRED_EXCLUDES` list so the entry
is both sanctioned AND mechanically required (a fixture missing it fails a new tooth),
and the stale "preserve vitest defaults" comment is corrected. The 96 threshold and the
97.56% measurement are unchanged (the test files were already absent from the report).
