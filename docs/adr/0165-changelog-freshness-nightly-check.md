# 0165 — Changelog freshness: nightly drift check (not per-PR, not manual)

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** 11r-d
**Supersedes:** —
**Amends:** ADR-0142
**Subsystems:** tooling-docs, ci-gates
**Decision:** Changelog freshness is enforced as a nightly drift check (spec D4's default), not a per-PR gate nor manual-only discipline; implementation defers to 11r-i, being outside 11r-d's declared `touches:`.

## Context

ADR-0142 (D1) regenerated `CHANGELOG.md` at ptc5f and explicitly left the
regen-on-close trigger cadence open, noting the SSOT mechanism (git-cliff)
already exists — only *when* it fires was undecided. This slice found that
gap had not self-resolved: `CHANGELOG.md` was still stopped at PR #239 while
`master` was at PR #269 — roughly 30 merges and 19 ADRs of lag, beyond
`ARCHITECTURE.md`'s "at most one open milestone" policy for the generated
changelog (m17.5g). The close-chore discipline alone did not hold across the
post-gate wave; that is the empirical case against the manual option
(`M-postgate-eleventh-review-residuals.spec.md` §4 D4, option c).

## Considered alternatives

- **Per-PR gate.** Rejected: the ledger is allowed to lag by up to one open
  milestone under existing policy, so a per-PR check would fire red on
  essentially every feature PR for a condition that PR did not cause — a nag
  that trains people to bypass it.
- **Status quo (manual regen-on-close).** Rejected: this is the option the
  30-merge / 19-ADR drift found in this slice demonstrates does not hold on
  its own.
- **Nightly drift check (D4 default).** Chosen — see Decision.

## Decision outcome

- Chosen: **nightly drift check**, matching D4's stated default. It matches
  the lag tolerance the existing policy already grants (one open milestone)
  and matches where this repo already places non-blocking drift gates
  (nightly mutation/coverage drift, ADR-0050).
- **Not implemented in this slice.** The check requires editing
  `.github/workflows/nightly.yml` and/or `scripts/`, both outside 11r-d's
  declared `touches:` path-set. Under the supervised build loop, an edit
  outside the declared set is a hidden-dependency STOP (a concurrent sibling
  slice may own those files). This ADR records the decision only; the
  follow-up is recommended for slice **11r-i** (gate-coverage extensions),
  which already carries a nightly-infra-only phase and whose declared
  `touches:` (`evals/`, `scripts/smoke-republish.sh`, `server-module/src/npc.rs`)
  already include `evals/`. Note it names only one `scripts/` file and does
  **not** include `.github/workflows/nightly.yml` — whoever
  schedules the follow-up must widen that declaration to cover the workflow
  file, or the check lands as an `evals/` script the nightly job already runs.
- Shape for the follow-up: a nightly job step runs `just changelog` into a
  temp file and diffs it against the committed `CHANGELOG.md`, reporting (not
  hard-failing the PR path) when the committed ledger is behind. Subtlety to
  preserve: `cliff.toml` sets `filter_unconventional = true`, so
  non-Conventional-Commit history is legitimately absent from the generated
  output — the diff must not treat that absence as drift.

## Consequences

- + The open item from ADR-0142 D1 is resolved: cadence is nightly, not
  undecided.
- + Non-blocking by design — matches the policy's own lag tolerance, avoiding
  per-PR nag/bypass failure mode.
- − No enforcement exists yet; drift can recur until 11r-i lands the check.
- Breadcrumb: this slice also replaced `docs/adr/README.md`'s hand-maintained
  ADR catalog table with a pointer to the generated, CI-drift-gated
  `docs/adr/DIGEST.md` — the same anti-drift principle (generated SSOT over
  hand-maintained duplicate) applied here rather than recorded as its own ADR,
  since it is an application of the existing ADR-0104 digest decision.
