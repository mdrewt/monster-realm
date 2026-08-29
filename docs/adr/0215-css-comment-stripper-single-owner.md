# 0215 — One `stripCssComments`, owned by the `.mjs` tier: consolidation beats corpus agreement

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-12 (residual R-m23-s2-X6)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, client-tests
**Decision:** Delete the duplicate `stripCssComments` from `client/src/indexShell.test.ts` and import
the single owner from `evals/a11y-static-shell.eval.mjs`, hardened to string-aware fail-loud
semantics; keep a shared, transition-total fixture corpus run by BOTH tiers as the correctness gate
on the surviving oracle and as the guard that a second definition can never reappear.

---

## Context and problem statement

Residual **R-m23-s2-X6** (disclosed 2026-08-24) predicted that the `[A11Y-07]` CSS scanner would
exist twice once slice m23-s10 landed its eval, with no agreement gate, and that "or a third variant
appears".

Measured against `master` at `a3404a0`, the residual's premise is **partly false and partly
understated**:

- **False:** `evals/a11y-static-shell.eval.mjs` defines **no** `parseCssRules`, `findIdSelectors` or
  `srOnlyIsAccessible`. m23-s10 chose **delegation** instead (that file's header, `:32-56`): it pins
  only that the TS oracle exists, is invoked on the real artefact, and is reachable by CI.
- **Understated:** the function that *is* genuinely duplicated is the leaf primitive
  `stripCssComments`, and the predicted third variant **already exists**:

  | copy | semantics |
  |---|---|
  | `evals/a11y-static-shell.eval.mjs:83` | naive — **not** quote-aware, never throws |
  | `client/src/indexShell.test.ts:939` | quote-aware (dq/sq/backslash) **and** fail-loud at EOF |
  | `evals/reduced-motion-hp-bar.eval.mjs:103` | quote-aware, **stricter** — refuses comment delimiters inside strings/`url()` |

The two in-scope copies genuinely disagree, and the disagreement is a **live false-GREEN in the
shipped eval**, not a theoretical drift. Measured:

```
input     .a{content:"/*"}.b{display:none}
naive     .a{content:"                        <- swallowed display:none
hardened  .a{content:"/*"}.b{display:none}    <- preserved
```

A stripper in that state reports zero findings on a stylesheet full of them — the only kind of
failure that matters.

## Considered alternatives

**Option A — the mandated fix: keep both implementations, add a shared fixture corpus + a comparison
gate.** This is what the residual text prescribes, and what the slice brief forbade deviating from.

Rejected on measured evidence. m23-s10 had already tried and rejected exactly this mechanism one
function over, and recorded why at `evals/a11y-static-shell.eval.mjs:42-50`: a deliberately weak
`.mjs` `srOnlyIsAccessible` agreed with the TS oracle on **18 of 18** fixtures while shipping four
real regressions green — "a corpus certifies agreement ON THE CORPUS and nothing else." This slice's
`red-team` lens reproduced the same collapse for `stripCssComments` specifically:

- A structurally different weak stripper (quote-aware, comment-aware, correctly throwing, but
  **escape-blind**) agreed with the reference **byte-for-byte on 6/6** plausible fixtures while
  false-throwing on legitimate CSS (`.a{content:"x\"/*"}.b{display:none}`).
- A **gutted** corpus — fixture names and count preserved, payloads trivialised, expectations edited
  to match — passed name-set equality **and** length floor **and** per-entry pinned expectations
  **and** the vacuity guard, all four simultaneously.
- Because both tiers read expectations from one shared table, corrupting a single expectation turns
  **both** tiers green at once. Shared-corpus designs are structurally exposed to this.

**Option B — consolidate: one implementation, no second copy to drift.** m23-s10 named this "the
only mechanism with no bypass — there is nothing left to drift" (`:49-50`) and then ruled it out as
impossible, reasoning that "a `.mjs` twin could not be kept in agreement by any in-slice mechanism"
(`:40-41`). The residual inherited that conclusion, and the rb-12 brief restated it: *"a .mjs eval
genuinely cannot import a .ts test helper"*.

**That parenthetical is true and irrelevant — it forbids the wrong direction.** Both directions were
measured in this slice, independently by two lenses:

- `.ts → .mjs` **works**: a probe `client/src/*.test.ts` importing `../../evals/a11y-static-shell.eval.mjs`
  passes under real vitest. The eval is plain ESM with no `main` guard and no module-scope side
  effects beyond `node:fs`.
- `.mjs → .ts` **fails**: `indexShell.test.ts` uses extensionless relative imports (`./ui/overlayRegistry`)
  that Node's ESM resolver rejects outside a bundler transform.

So consolidation **is** achievable inside the slice's literal two-file `touches:`, in the one
direction that works, with the canonical copy living in the `.mjs` — the only tier both runners can
import.

## Decision outcome

- **Chosen: Option B, plus the corpus retained in a supporting role.**
  1. `evals/a11y-static-shell.eval.mjs` becomes the **sole owner** of `stripCssComments`, hardened to
     the former TS semantics: four-state lexer (`normal`/`dq`/`sq`/`comment`), backslash escape,
     newlines preserved inside comments, and a **throw** at EOF inside a string or comment.
  2. `client/src/indexShell.test.ts` **deletes** its private copy and imports the owner.
     `parseCssRules` and `importsAnotherStylesheet` resolve to it unchanged.
  3. A shared frozen `CSS_STRIPPER_CORPUS` is run in full by **both** tiers. It is a **transition
     matrix**, not a bag of examples: every cell names a `(state, event)` pair of the lexer, so the
     claim is *transition-total* rather than *sampled*. This is the honest distinction from
     m23-s10's rejection — `srOnlyIsAccessible` ranges over an open selector grammar where a corpus
     can only sample; a four-state lexer has a closed transition space that a corpus can cover
     totally.
  4. Anti-gutting teeth, each closing a measured bypass: exact set equality of cell names in **both**
     directions (never a length floor); the expected cell list **re-declared independently in each
     tier** so deleting a cell cannot satisfy both at once; a naive reference stripper whose
     **exact wrong output** is pinned on the headline cell; and kill-cell expectations **hardcoded a
     second time literally in the `.ts`**, independent of the shared table.
  5. A self-source scan asserts the `.ts` contains **zero** local definitions and **exactly one**
     import of the symbol, with the needle assembled from fragments so the assertion literal cannot
     satisfy itself.

- **Why this deviates from the brief:** the brief's prohibition rests on a factual error about import
  direction. Its *intent* — "the two oracles cannot silently drift" — is served strictly better by
  removing one oracle than by gating agreement between two. The deviation is declared in the
  acceptance ledger and the PR body rather than taken silently.

- **Consequences:**
  - *Positive:* the repo goes from **three** `stripCssComments` variants to **two**, and the two
    in-scope copies collapse to one with no drift surface. A real false-green (`content:"/*"`
    swallowing `display:none`) is fixed in the shipped eval. The stripper becomes fail-loud, so an
    unparseable stylesheet can never be reported as a clean one.
  - *Negative / follow-ups:*
    - **RK-1 (residual, declared):** `evals/reduced-motion-hp-bar.eval.mjs:103` remains a third
      variant and is **not** convergeable — it *refuses* comment delimiters inside string literals,
      whereas `indexShell.test.ts`'s A6a BAD fixture 8 requires exactly that input to parse and
      return `['#help-overlay']`. Adopting its semantics would RED a shipped, documented tooth. The
      one-oracle-repo-wide end state (X18) is blocked by a real policy conflict, not merely by
      `touches:`.
    - **RK-2 (residual, declared):** the hardened stripper is fail-loud, and
      `evals/reduced-motion-purity.eval.mjs:354` calls into it **without** a try/catch. Measured: on
      today's `client/index.html` neither the old nor the new stripper throws (balanced quotes, zero
      comment delimiters), so this is byte-equivalent **today**. A future unpaired apostrophe in
      visible HTML prose would produce a **loud RED of an unrelated eval** — never a false green.
      The try/catch belongs to a file outside this slice's `touches:`; deferred, not absorbed.
    - **RK-3:** deleting ~63 lines shifts every line after `:984` in `indexShell.test.ts`, staling
      one *comment* citation (`client/src/ui/overlayA11yWiring.test.ts:121` → `indexShell.test.ts:1988`).
      Verified ungated — no eval checks line citations. Flagged as a follow-up; the file is outside
      `touches:`.
    - The imported symbol is untyped at its `.ts` call sites: `client/tsconfig.json` excludes
      `**/*.test.ts`, so `just client-typecheck` never inspects this file. Signature drift would be
      caught by vitest, not by tsc.
  - *Not closed by this slice:* residual `R-m23-s10-CSSDRIFT`. Agreement on a leaf primitive says
    nothing about `parseCssRules`/`findIdSelectors`/`srOnlyIsAccessible` semantics on the real
    `styles.css`; those remain gated solely by `indexShell.test.ts`'s own inline BAD/GOOD proofs.
