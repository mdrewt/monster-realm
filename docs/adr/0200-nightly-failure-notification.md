# 0200 — Nightly failure notification: an issue per failing job, and a step-scoped carve-out for the neuter gate

**Status:** Accepted
**Date:** 2026-08-17
**Slice:** lp-03 (M-loop-infrastructure §lp-03)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, tooling-docs
**Decision:** A `notify` job fans in over all five nightly jobs and opens one issue per non-success job via `gh` under a job-scoped `issues: write` grant; `jobIsNotNeutered` gains a step-scoped carve-out for `if: always()` on an upload step.

## Context

Measured at `67fbff8`/`3a00ad6`: `.github/workflows/nightly.yml` ran five independent jobs
(`mutation`, `mutation-server`, `coverage`, `smoke-republish`, `changelog-freshness`) with no
`needs:` anywhere, no notification job and no issue-opening step. Failure handling existed only as
a prose comment describing human triage. That is why `mutation-server` was RED for five consecutive
nights with nobody reacting — the gate had teeth and no voice.

ADR-0183 D5 recorded the absence deliberately: decision-hook `mdrewt/claude-harness#14`
(notification channel) was UNANSWERED, so the slice shipped the documented reversible default —
a failure-policy comment per job — instead of a notification Action. **lp-03 exercises that
recorded reversibility**; it does not contradict ADR-0183, so this ADR carries no `**Amends:**`
relation (and `docs/adr/0183-*.md` is outside lp-03's declared `touches:` set, so the reciprocal
back-link `evals/adr-backlink-integrity.eval.mjs` would demand cannot be written here anyway). The
three in-repo comments in `evals/nightly-smoke-wiring.eval.mjs` that asserted the hook was still
open ARE updated in this slice's diff — a comment that instructs "do NOT add a notification Action"
sitting next to the Action would be a live doc-vs-code lie.

Two facts shaped the design:

1. **A notification step under `contents: read` fails at the API call, not at the gate.** The repo's
   `default_workflow_permissions` is `read`. A grant that lands in a later commit than the step is
   the same false-green shape this milestone exists to eliminate, so the grant and the step land in
   one diff and a committed eval predicate keeps them coupled.
2. **`jobIsNotNeutered` is a deliberate flat line scan** that REDs on ANY line beginning `if:` at
   any indent across `mutation`/`mutation-server`/`coverage`. The `if: always()` an
   upload-on-a-RED-night artifact step requires is exactly such a line, so the artifact half of
   W0-8 is not free — it costs a predicate change, in the same commit, with its own teeth.

## Decision

**D1 — `gh` CLI, not `actions/github-script`.** The notify step is `run: |` bash with
`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `set -euo pipefail`. `gh` is preinstalled on
`ubuntu-latest`, so no third-party action needs pinning, trusting or renovating, and a 403 exits
non-zero and REDs the job loudly. Cost: shell-quoting discipline. Every `${{ }}` value is passed
through `env:` and referenced as `$VAR` — never interpolated into the script body.

**D2 — the failing set is enumerated from `toJSON(needs)`, never hardcoded.** The step selects
`.value.result != "success"` over the `needs` map with `jq`, and the issue title carries the
enumerated job name and the run id. Five hardcoded `needs.<job>.result` branches would silently
drop the sixth job the day someone adds one — the very drift this slice exists to kill. Selecting
*non-success* (rather than `== "failure"`) also reports a `skipped` job, which is what a successful
job-level neuter looks like at runtime.

**D2a — the job condition must admit `skipped`, not just `failure()`.** A plain `if: failure()`
makes D2's skipped-job clause dead code: GitHub evaluates `failure()` true only when a needed job
actually *failed*, so a job neutered into `skipped` leaves `notify` skipped too — the original bug
(a gate that is red and silent) reproduced one level up. The condition is therefore

    if: ${{ !cancelled() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'skipped') || contains(needs.*.result, 'cancelled')) }}

which stays quiet on a fully green night (so D6's zero-guard cannot misfire) and fires on a
failure, a skip OR a per-job cancellation. No nightly job carries an `if:`, so `skipped` can only
mean someone neutered one. The third term is not hypothetical: a `timeout-minutes` expiry concludes
a job as `cancelled`, `smoke-republish` carries a 20-minute timeout, and the mutation jobs run
1.5–2.5 h against the 6 h hosted-runner cap — a night that ended that way would have been red and
silent. The leading `!cancelled()` is a different predicate: it is true only when the WHOLE RUN was
cancelled (a human action, or a superseding run), which needs no issue.

**D3 — the grant is job-scoped, not workflow-scoped.** Top-level `permissions:` stays
`contents: read`; the `notify` job carries `permissions: { contents: read, issues: write }`. The
spec's CRITICAL clause is satisfied in substance — the grant ships in the same diff as the step —
while the mutation jobs, which compile third-party build scripts under `cargo-mutants`, never hold
issue-write. A committed predicate asserts the negative space: no other job and no top-level block
carries `issues: write`. A job-level `permissions:` block REPLACES the workflow-level one, so the
predicate treats a notify job with its own block that omits `issues:` as ineffective even when the
top level grants it.

**D4 — no labels.** `gh issue create --label X` fails the API call when `X` does not exist in the
repo, and label creation is out-of-band repo admin. That would convert a notification into a new
silent-failure surface — the exact class this slice removes. The issue title carries the job name
and the run id instead.

**D5 — one issue per failing job per run; NO cross-night dedupe.** This is the literal EARS
("open exactly one issue naming the failing job and linking the run" / "SHALL NOT open more than
one issue per job"). Cross-night dedupe (reuse an open issue, comment instead of create) was
designed, red-teamed and dropped: its marker matching is prefix-ambiguous (`nightly-failure:mutation`
is a substring of the `mutation-server` title), `gh issue list --limit 100` silently loses the
target once the repo passes 100 open issues, and — decisively — the dedupe branch cannot be given a
permanent in-repo test without moving the logic to a committed script, which is outside this slice's
`touches:` set. Untested branching inside YAML-embedded bash is what RF-1..4 warn about. A red job
therefore opens one issue per night until it is fixed; noise reduction is a named follow-up
(`lp-03b`), not silent scope.

**D6 — the step fails loudly when it enumerates nothing.** If the job condition fired and the loop
opened zero issues, the step exits 1. A notification path that runs and quietly creates nothing is
indistinguishable from a green night, which is the failure mode being fixed.

**D7 — the artifact step carries `if: always()`, distinct names, and `if-no-files-found: warn`.**
Both mutation jobs upload `mutants.out/` (`actions/upload-artifact@v4`, 40-hex pinned per the M8.5d
convention). Without `if: always()` the default is `success()` and the artifact is uploaded only on
the nights it is worthless. The two jobs use distinct artifact names because upload-artifact v4
hard-errors on a duplicate name in one run, and a committed check asserts they differ. `if-no-files-found: warn` is pinned
explicitly — it is already the action's default, so this is a ratchet against someone raising it to
`error`, not an override: a job that died in the toolchain install, before `cargo-mutants` ever ran,
must report its REAL failure rather than be masked by a failing upload step.

**D8 — the carve-out is step-scoped and value-restricted, and everything else fails closed.**
`jobIsNotNeutered` now segments the job block into steps and admits `if:` on a step whose own
`uses:` value equals `actions/upload-artifact` (exact equality after stripping the inline comment
and the `@<ref>` tail, and only when the step has no `run:` key) — and only when the `if:` value is
exactly `always()` or `${{ always() }}`. Everything else REDs, including `if:` on any other step,
`if:` at job level, and `if: false` / `if: success()` on the upload step itself. Four hardening
changes ride along because the flat scan they replace was bypassable by string tricks:

- **own block extraction.** A comment at 2-space indent inside a job block truncates the shared
  `extractJobBlock` (its `indent === 2` terminator), which let a neuter hide below a decoy comment.
  `jobIsNotNeutered` now uses an in-file `strictJobBlock` that terminates only at a non-blank,
  NON-comment line at indent ≤ 2. `extractJobBlock` itself is untouched — it has ten callers across
  four evals and lives outside this slice's `touches:` set.
- **anchored key matching.** `"if": false` and `if : false` are valid YAML that
  `trim().startsWith('if:')` never sees.
- **`continue-on-error` is an allowlist.** Only the literal `false` is accepted. The old truthy
  blacklist admitted `continue-on-error: ${{ github.event_name == 'schedule' }}` — false under the
  `workflow_dispatch` a drill uses and true on every real cron night, i.e. a neuter calibrated to
  hide from its own verification.
- **the recipe must be the FIRST `run:` step in a guarded job**, and no `env:` mapping in such a job
  may carry a `PATH` key. A step running BEFORE the gate can write a shim `just` onto
  `$GITHUB_PATH` and nothing else notices: the exact `- run: just mutate-core` text is still there,
  there is no `if:` and no `continue-on-error`, and the job reports success having tested nothing.
  A red-team pass demonstrated exactly that against this slice's own first implementation and kept
  the whole eval green. (A `uses:` step ahead of the gate can still alter `PATH` — that is what
  `setup-just` and `rust-toolchain` legitimately do — so this closes the shell-step class, not
  every route; the remaining route requires adding a new pinned action, which is visible in review.)
- **fail closed on unparseable shapes.** Flow-style steps (`- { run: …, if: false }`), a flow
  `steps:` sequence, YAML aliases/merge keys, a missing `steps:` key and a missing step dash all
  return not-ok rather than a confident `ok: true` over text the scanner cannot read.

## Consequences

- A red nightly job now produces a GitHub issue naming the job and linking the run, every night it
  is red. Triage is unchanged (ADR-0050: insert as the next slice); only the delivery is new.
- `jobIsNotNeutered` is a stricter gate than before on every axis except the one carve-out, so an
  existing legitimate pattern that used a non-`false` `continue-on-error` expression in a guarded
  job would now RED. None exists today.
- The wiring predicate gates the enumeration itself, not merely the presence of a create call: a
  single hardcoded `gh issue create` with no `toJSON(needs)`, no per-job title, no run link or no
  zero-enumerated guard REDs. A notification that always opens one generic issue would satisfy
  "a step exists" while failing every EARS clause about attribution.
- **Accepted gaps (named, not silent):** `smoke-republish` and `changelog-freshness` are in the
  fan-in but are still not covered by `jobIsNotNeutered` (unchanged from before this slice —
  `smoke-republish` legitimately carries `if: failure()`); a run cancelled OUTRIGHT cancels `notify`
  with it, so a whole-run cancellation is not notified (a per-job cancellation IS — D2a); and the
  notify job has no meta-monitor — if it breaks,
  the nightly run is red and nothing announces it, which is one level better than before but not
  self-healing.

## Evidence

The forced-red drill (ADR-0010 — assert the ISSUE EXISTS, not that a step exited 0) was RUN, on a
throwaway `drill/lp-03-forced-red` branch whose gate jobs were stubbed so the fan-in completed in
minutes. Both arms behaved exactly as designed:

**Arm A — negative control, grant reverted** (run
[32088740459](https://github.com/mdrewt/monster-realm/actions/runs/32088740459)): `mutation` RED,
`notify` fired, and `gh issue create` failed with `GraphQL: Resource not accessible by integration
(createIssue)`; the step exited 1 and `notify` concluded **failure**. `gh issue list` was unchanged.
This is the empirical proof of the premise this slice is built on: a notification step under
`contents: read` fails AT THE API CALL, and it fails LOUDLY only because there is no `|| true`.

**Arm B — grant restored, two jobs RED** (run
[32088793844](https://github.com/mdrewt/monster-realm/actions/runs/32088793844)): `mutation` and
`mutation-server` both failed; `notify` concluded **success** while the run concluded failure, and
exactly TWO issues were opened — `nightly failure: mutation (run 32088793844)` and `nightly
failure: mutation-server (run 32088793844)` — each body naming its own job and linking that run.
No issue was opened for `coverage`, `smoke-republish` or `changelog-freshness` (attribution proof),
and the `mutants-out-core` artifact was present on the failing path (EARS: upload on the RED night).

Cleanup: both drill issues closed with a synthetic-failure note, the drill branch deleted local and
remote, and `gh issue list --state open` diffed back to its pre-drill baseline (`[313]`).
