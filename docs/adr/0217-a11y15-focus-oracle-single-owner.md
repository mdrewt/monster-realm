# 0217 — A11Y-15's focus oracle is the readdir-derived eval; the hand-kept per-slice lists are retired, except the one that is not subsumed

**Status:** Accepted
**Date:** 2026-08-30
**Slice:** rb-16 (residual R-m23-s10-X19)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-ui
**Decision:** Retire the two hand-kept `.focus(` file lists that `evals/overlay-a11y-manifest.eval.mjs` provably subsumes, and KEEP the third — `MV-NO-FOCUS-CALL` — because a measured axis of it is not subsumed; queue its retirement as its own decision rather than folding it into a cleanup.

---

## Context and problem statement

Criterion **A11Y-15** — "the single deferred focus lives only in `client/src/ui/overlayA11y.ts`; no
`*View.ts` may call `.focus()`" — was enforced for most of M23 by three hand-kept file lists, each
written by the slice that happened to be touching the views at the time:

| id | file | scope |
|---|---|---|
| `S3-NO-VIEW-LOCAL-FOCUS` | `client/src/ui/renameView.test.ts:501` | 10 view files |
| `S4-VIEW-LOCAL-FOCUS-5` | `client/src/ui/renameView.test.ts:1300` | 5 view files |
| `MV-NO-FOCUS-CALL` | `client/src/ui/menuView.test.ts:1755` | `menuView.ts` only |

Hand-kept rosters have the failure mode hand-kept rosters always have: `client/src/ui/` holds
**18** `*View.ts` files, and the union of the three lists is **16** — `errorOverlayView.ts` and
`sessionView.ts` were governed by nothing. `S3-NO-VIEW-LOCAL-FOCUS`'s own `it()` title said in
words that it was provisional and should be deleted once slice m23-s10 shipped its eval.

m23-s10 then shipped `evals/overlay-a11y-manifest.eval.mjs` (criteria X1/X2) but could not delete
the lists — both host files were outside its declared `touches:` — and deferred the cleanup as
residual **R-m23-s10-X19**.

## Decision drivers

- Two oracles for one criterion drift invisibly; each keeps passing against its own idea of the file.
- A deletion slice's whole risk is *silently losing coverage*. The burden of proof is on the
  deletion, and it must be discharged by measurement, not by reading the code.
- "Superseded" is a claim about a *set of axes*, not a vibe. It has to be checked axis by axis.

## Considered options

1. Delete all three lists, on the residual's stated premise that the eval subsumes them.
2. Delete the two that are provably subsumed; keep the one that is not; queue its retirement.
3. Keep all three and let the eval run alongside them.
4. Generalise the non-subsumed axis into the eval behind an allowlist of the five views that
   legitimately name `.focus()` in prose.

## Decision

**Option 2.**

Axis-by-axis, `evals/overlay-a11y-manifest.eval.mjs` is a strict strengthening of `S3` and `S4`:

| axis | S3 / S4 | eval |
|---|---|---|
| roster | hand-kept 10 / 5 | `readdir`-derived, recursive, **18**; two-way ratcheted (missing-from-disk REDs, on-disk-but-unsanctioned REDs) plus an anti-vacuity floor |
| spellings | the literal `.focus(` | **8**, incl. `el?.focus?.()`, `el['focus']()`, `el . focus()`, `prototype.focus.call`, `autofocus`, `'foc'+'us'` and a bare `'focus'` string; `/\.\s*focus\b/` strictly contains `.focus(` |
| string literals | stripped (so a `.focus(` hidden in a string is invisible) | left **intact**, and separately banned |
| divergence tooth | comment-stripped vs comment+string-stripped counts must agree | same tooth, same real files |
| anti-vacuity | class-declaration must survive stripping | same, per file, plus a scan-root floor |

`MV-NO-FOCUS-CALL` is subsumed on every one of those axes too — but it carries one the eval
deliberately does not. It scans **raw** source: a `.focus(` appearing only inside a *comment* in
`menuView.ts` REDs it. The eval comment-strips, and must, because five shipped views
(`battleView.ts:26`, `boxView.ts:26`, `raisingView.ts:27`, `evolutionView.ts:37`,
`claimView.ts:27`) each name `.focus()` in a header comment explaining where the call went — a raw
scan false-REDs on all five.

This was **measured, not argued**: planting
`// NOTE: do not call this.#listboxEl.focus() here — see overlayA11y.ts` into
`client/src/ui/menuView.ts` REDs `MV-NO-FOCUS-CALL` and leaves the eval fully green
(`pass:true … hits=0 … teeth=19/19`).

So `MV-NO-FOCUS-CALL` stays. Whether the raw/comment axis is a policy worth generalising to all 18
views, or an authoring artefact worth dropping deliberately, is a genuine decision with arguments
on both sides — and a *cleanup slice is the wrong place to settle it*. It is queued as its own work
(residual `R-rb16-COMMENTBAN` → backlog).

Option 4 is rejected on its own terms: an allowlist of the five views that may name `.focus()` in
prose is precisely the hand-kept file list this ADR retires, rebuilt one directory over.

Option 3 is rejected because it is the status quo the residual exists to end: `S3`'s and `S4`'s
rosters cannot see two of the eighteen views, and every future view file added to `client/src/ui/`
would need three separate hand edits to stay governed.

## Consequences

**Positive**

- One oracle for A11Y-15's call axis, derived from the directory rather than transcribed from it.
  A new view is scanned the day it lands; a renamed or deleted one REDs.
- `renameView.test.ts` loses ~180 lines of scanner that duplicated a shipped eval, including a
  second implementation of comment/string stripping.
- Net *strengthening* on `menuView.ts`: seven focus spellings that `MV-NO-FOCUS-CALL`'s literal
  matcher never saw are now caught, while its comment axis is retained.

**Negative / accepted**

- The developer inner loop changes: `cd client && npm test` alone no longer catches a view-local
  focus in the 15 views S3/S4 covered — `just eval` does. Both run in the same CI job
  (`justfile:595`; `.github/workflows/ci.yml:73,79`), so no CI surface loses coverage, but a
  developer running only the vitest suite gets a later signal. Stated rather than hidden.
- The eval is fail-fast: it reports the first offending file per run, not all of them. `S3`
  accumulated. This is a reporting-completeness difference, not a coverage one.
- Three already-closed acceptance ledgers in the harness repo (`m23-s3` X5, `m23-s4` X5) name the
  deleted test ids in their `CHECK:` lines and go stale. Nothing re-executes closed ledgers, so
  this is record hygiene; the replacement CHECK is rb-16's X2 (the eval), surfaced to the
  supervisor in the PR body rather than edited across repos from here.

## Verification

The deletion's evidence is a bite probe run against the **unmodified** tree first — the replacement
must be proven to bite *before* anything is removed. It extracts `HEAD` to `/tmp` (no git command
touches a live tree), asserts the roster from two independent sources, then for each of the 18
views plants a real focus call one at a time — the eval is fail-fast, so one file per iteration —
verifies the mutation actually applied, requires a RED naming that file, restores, and requires
GREEN again. It additionally reds all 8 spellings on `menuView.ts` and records the comment-axis
blindness as a printed measurement rather than an assumption.

`memory/projects/rb-16.bite-probe.mjs` (harness repo), ledger gate X3.
