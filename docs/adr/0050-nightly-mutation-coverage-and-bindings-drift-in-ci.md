# 0050. Nightly mutation/coverage gates (not per-PR) + bindings-drift in the fast `ci` job

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
