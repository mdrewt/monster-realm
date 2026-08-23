# 0203 — Nightly red-response policy: one machine-checked file, key-set-equal to the wired workflow, cited back from every job

**Status:** Accepted
**Date:** 2026-08-23
**Slice:** 16r-h (`specs/monster-realm-v2/M-postgate-sixteenth-review-residuals.spec.md` §16r-h)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, tooling-docs
**Decision:** Record the nightly red-response policy in one operational file, `docs/nightly-red-response-policy.md`, whose job-response matrix must be key-set-EQUAL (never merely containment-compatible) to the job keys derived from `.github/workflows/nightly.yml` and which every declared job's comment preamble must cite back, gated by `evals/nightly-smoke-wiring.eval.mjs`.

---

- Status: accepted
- Date: 2026-08-23
- Milestone: `M-postgate-sixteenth-review-residuals` §16r-h

## Context and problem statement

Decision-hook `mdrewt/claude-harness#14` asked for two things: a notification channel for
nightly failures, and a documented insertion policy for the mutation/coverage gates mirroring
the `smoke-republish` precedent. lp-03 (ADR-0200) delivered the first half — a `notify` job
that opens one GitHub issue per non-success job. This slice delivers the second.

The motivating incident is 14r-a's: `mutation-server` was RED for **five consecutive nights**
with nobody reacting. ADR-0200 correctly diagnosed the missing *voice* and fixed it. But a
voice that says *which* job failed is not a policy: it does not say what the required response
is, who owes it, or what the escalation path looks like when the ordinary response does not
apply. That knowledge existed only as prose scattered across six comment preambles in
`nightly.yml` and three ADRs (0050, 0079, 0088, 0118, 0183, 0196, 0200) — discoverable if you
already knew where to look, which is precisely the condition a 3 a.m. red night does not
satisfy.

`jobHasFailurePolicyComment` (14r-a) already forces each guarded job to carry an attributed
`Failure policy for <job>:` line with a routing keyword. That gate proves a policy *exists*.
It cannot prove the policy is *complete* (a seventh job added tomorrow is governed only if
someone remembers to add the comment AND to add it to the predicate's hardcoded guarded set),
nor that a reader standing at the failing artefact can reach an authoritative statement of
who owns the response.

## Decision

### D1 — an operational file, not an ADR and not an ADR-0050/0079 amendment

The policy lives at `docs/nightly-red-response-policy.md`. An ADR is a dated decision record;
this document changes whenever a nightly job is added or its response changes, which is an
operational cadence, not a decision cadence. `docs/observability-dr-runbook.md` and
`docs/playtest-ops.md` are the existing in-repo precedent for that class. Amending ADR-0079
was rejected: it would put the response policy for six jobs inside an ADR titled "nightly
republish smoke", and would place a machine-parsed table inside the corpus that
`scripts/adr-digest.mjs` scans, adding a second consumer for no benefit.

### D2 — the owner column is a closed two-member enum, matched by exact equality

`POLICY_OWNERS = ['build-loop supervisor', 'operator (Drew)']`.

Both members name an actor with an already-mechanised action in this repo:

- **`build-loop supervisor`** — ADR-0079:42-45 already assigns nightly reds to it ("The
  supervisor picks it up as a priority target on the next supervision tick"), and queue
  insertion into the milestone spec is an action it can take unaided.
- **`operator (Drew)`** — required because two responses are provably outside supervisor
  authority. A `mutate-server` cap re-baseline needs an ADR-0050 A2 dated amendment plus a
  lockstep cap+ceiling move (ADR-0118 §4, ADR-0183 D6) — an ADR amendment is an
  operator-visible ceremony by construction. And a red `notify` job means the loop's own
  feedback path is down, so only a human watching the Actions tab closes that loop.

Exact enum membership rather than "non-empty string", because a non-empty check passes `TBD`,
`TODO`, `the team`, `-`. The gate additionally asserts **both** enum members appear at least
once in the real matrix: an owner column whose every cell holds the same value is a constant,
and a constant column carries no information — it would satisfy a per-cell check while
re-creating the unowned-job failure this ADR exists to prevent.

### D3 — `jobHasFailurePolicyComment` is NOT widened; the back-edge is a separate predicate

The workflow→doc citation is enforced by a new `jobPreambleCitesPolicyDoc`, deliberately
duplicating ~20 lines of the preamble walk rather than adding a sixth clause to the existing
predicate. `jobHasFailurePolicyComment`'s five clauses are pinned by teeth M1-M10 and by
ADR-0183:212; widening it would require re-proving all of them, and this repo has already
measured that "additive, and the signature is byte-equivalent" covers the signature, not the
semantics. Duplication is cheaper here than the regression risk, and both copies are
independently toothed.

The citation match is **boundary-aware**, not a bare substring: a red-team prototype measured
that `indexOf` alone accepts `# notdocs/nightly-red-response-policy.md is unrelated`, so a
match whose immediately-preceding character is `[A-Za-z0-9_/.-]` is rejected. A *negated*
citation (`do NOT read <path>, it is stale`) still passes — that is an accepted limitation,
recorded in Consequences rather than left implicit.

### D4 — the policy names RECIPES, never numbers

The document must not contain a cap, a coverage threshold, or a survival rate. `just
mutate-server`'s cap is already a three-way coupled constant (`justfile` recipe default /
`MUTATE_SERVER_CAP_BASELINE` / `justfileCapEqualsCeiling`); a fourth coupled site would be
actively harmful, and 15r-tst-i — which replaces the absolute-count ratchet with a rate-based
one — would then have to unpick it. The `## Measurement substrate` section therefore *points
at* `just mutate-core` / `just mutate-server` / `just coverage`, and the gate asserts each
named recipe actually exists as a recipe in the committed `justfile` — so a renamed recipe
reds the doc, while the numbers stay owned by ADR-0050 and 15r-tst-i.

### D5 — coverage is every DECLARED job, not the three the EARS names

The seeded criterion names "a mutation or coverage nightly job". The gate is driven over
`declaredJobKeys(nightly.yml)` instead, so the matrix must cover all six jobs and every job
must cite the policy file. Reason: a hardcoded job list is exactly the failure mode
`nightlyJobStructureIsUnambiguous` and `nightlyNotifyIsWired` were both written to avoid — the
seventh job added tomorrow ships unowned and silent. The wider set costs one comment line per
job and no additional predicate.

### D6 — the checks APPEND as 31+, they do not interleave

The eval returns on first failure, so appending means the new policy ratchet can never mask an
existing wiring regression, and Checks 1-30's numbering — referenced by the eval's own header
block, ADR-0196 and ADR-0183 — stays valid. There is also a hard ordering dependency: Check 24
(`nightlyJobStructureIsUnambiguous`) must run before anything that trusts `declaredJobKeys`,
because a duplicated job key makes the derived set first-wins while GitHub is last-wins.

### D7 — the parser fails loud; nothing is fence-stripped

Slice 12r-b measured four false-green shapes for a doc-gated-against-a-code-SSOT. All four are
designed out rather than patched: exact set equality in both directions (never containment);
the whole document is scanned for a second matrix header, not just the table region; every
parse ambiguity (missing anchor, a second anchor, a malformed or pipe-less separator, a wrong
cell count, zero data rows) is a loud failure rather than an empty result; and **no fence
stripping happens anywhere**, so the decoy-inside-a-stray-fence shape that scored a verified
22/22 GREEN in 12r-b is unreachable by construction instead of guarded against.

Two clauses exist only because a red-team prototype measured the bypass rather than reasoning
about it. **No stray pipe-table may exist anywhere in the document** outside the one recognised
table: the real 6-row matrix followed by a blank line, a line reading "supersedes the table
above", and a second table whose header cells are merely *re-cased* passed every other clause
while being the more prominent of the two to a human reader — for exactly the two jobs
(`mutation-server`, `notify`) whose silence motivated this ADR. And an Escalation cell's ADR id
must exist in `docs/adr/`, because `ADR-9999` satisfies a syntactic `ADR-\d{4}` check.

The parser strips a leading BOM and normalises CRLF to LF before any comparison. That is
orthogonal to the no-fence-stripping decision: CRLF, unlike a fence, cannot hide a decoy — it
merely produced a confusing false RED on legitimately-authored content.

## Consequences

- **Positive:** a red night is a lookup, not a re-derivation. Adding a nightly job now
  mechanically forces both a policy row and a back-edge citation, so the set of governed jobs
  cannot silently fall behind the set of running jobs. The two directions of drift — a job
  with no row, and a row for a job that no longer exists — are separately named in the failure
  reason, so the fix is obvious from the eval output alone.
- **Negative / accepted — three limitations, each measured, none left implicit:**
  1. **A well-formed but semantically wrong Response cell is undetectable.** The gate checks
     vocabulary and structure, not meaning — the same limitation `jobHasFailurePolicyComment`
     already concedes at `evals/nightly-smoke-wiring.eval.mjs:1933-1937`.
  2. **Six byte-identical boilerplate rows pass every clause.** The owner column cannot
     degenerate (D2 requires both enum members to appear), but the Response and Escalation
     prose may repeat across jobs. The gate proves attribution and format, never per-job
     semantic distinctness.
  3. **A negated back-edge citation passes.** `do NOT read <path>, it is stale` contains the
     bounded path token and satisfies the citation clause.
  The doc also cannot contain an illustrative copy of its own matrix — the whole-document
  second-header rule and the stray-pipe-table rule both correctly reject it; the file says so
  in its own "This file is gated" section so an author meets the constraint before CI does.
- **Follow-ups (recorded residuals, deliberately not actioned here):**
  1. Extending `jobHasFailurePolicyComment`'s guarded-job set to `smoke-republish` and
     `notify`. Both carry preambles today, but `smoke-republish`'s reads `# Failure policy:`
     rather than the anchored ``Failure policy for `smoke-republish`:`` form clause 4 demands,
     so adding it would force a rewrite of prose ADR-0079 quotes. Check 35 already gives those
     two jobs a policy gate by another route.
  2. Anything touching the cap/rate measurement substrate belongs to 15r-tst-i; this document
     is a named downstream consumer of that slice and must be re-read when it lands.
