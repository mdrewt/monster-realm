# 0213 — The battle HP bar's reduced-motion guard: `transition: none` in the stylesheet, after the base rule, gated by two oracles

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-10 (residual R-m23-s2-X4)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** Move only the HP-bar `transition` into `.hp-fill` in `client/src/styles.css`, neutralise it with `transition: none` in a `prefers-reduced-motion: reduce` block placed AFTER the base rule, gated by a source-text eval plus a Chromium probe.

---

## Context and problem statement

M23 §2.5 requires the battle HP bar's width animation to be suppressed under
`prefers-reduced-motion: reduce`, via a stylesheet guard with no JS dependency. Before this slice
the animation was an inline declaration in `client/src/ui/battleView.ts` `#renderMonsterCard`
(`hpFill.style.cssText`), which no selector can reach at any specificity — the guard was therefore
unimplementable and `client/src/styles.css`'s header recorded it as deliberately absent.

Two properties of this repo shape every decision below:

- **Nothing in `just ci` evaluates the CSS cascade.** There is no client build step, vitest never
  applies CSS, and there is no e2e console-error gate. A declaration moved into the stylesheet is
  invisible-if-broken surface.
- **`client/src/styles.css` held exactly one rule** (`.sr-only`) and carries a live `.hp-fill`
  mention inside a comment (`styles.css:29` pre-slice) — a decoy any presence-only gate would
  false-GREEN on.

The `reviewer` and `red-team` plan lenses transcribed the draft gate and ran 17 biome-formatted
stylesheets and 4 hostile `battleView.ts` variants against a real Chromium
(`~/.cache/ms-playwright/chromium-1228`) under both motion preferences. **Nine of them were
gate-GREEN, `just ci`-clean, and MEASURED animating under `prefers-reduced-motion: reduce`;** all 17
also passed the existing `indexShell.test.ts` teeth 19/19. Those nine measurements are what settle
the decisions below.

## Considered alternatives

Each alternative is recorded against the decision it lost to; D1–D6 in *Decision outcome* state the
choice.

- **D1 — the guard's value.** `transition-duration: 0.01ms` · `transition: width 0s` ·
  `transition-property: none` · `transition: none`.
- **D2 — how much of the inline style migrates.** All of `width`/`height`/`background`/`transition`
  · only `transition`.
- **D3 — where the guard block goes.** Before the base rule · after it (and whether source order is
  gated at all).
- **D4 — the gate's architecture.** A single CI source-text eval · a single browser probe · both.
- **D5 — a custom property (`--*`) in either `.hp-fill` rule.** Allowed · banned here.
- **D6 — the criterion id.** Mint a new `A11Y-N` · reuse the residual's own id.

## Decision outcome

### D1 — `transition: none`, not `0.01ms`, not `width 0s`, not `transition-property: none`

**Chosen: `transition: none`.**

- `transition-duration: 0.01ms` — **rejected.** That idiom exists solely to keep `transitionend`
  firing for JS that awaits it. This repo has **zero** `transitionend`/`animationend` listeners
  (grepped repo-wide), so the idiom buys nothing here while still scheduling a transition and
  introducing a magic number.
- `transition: width 0s` — **rejected.** It is still a transition in computed style, and it is
  scoped to `width`, so a second animated property added to the base rule later escapes the guard.
- `transition-property: none` — **rejected.** It leaves a stale duration in the cascade.
- `transition: none` — **chosen.** It is TOTAL: it neutralises any property a later edit adds to the
  base rule, which `width 0s` would not.

### D2 — only `transition` migrates to the stylesheet

**Chosen: move exactly one declaration.** `width` and `background` are computed per render and stay
inline; `height: 100%` is static but stays inline too.

Rationale is the second bullet of *Context*: nothing in `just ci` evaluates the cascade, so every
declaration moved into CSS becomes invisible-if-broken surface. `transition` is the only one that
cannot work inline (an inline animation declaration wins over every stylesheet rule at every
specificity, which is the whole reason the guard was previously unimplementable). Move that one and
nothing else.

### D3 — source order is load-bearing, and it is gated

**Chosen: the guard block is appended AFTER the base rule, and `[A11Y-RM3/order]` pins it.**

Both rules have specificity (0,1,0) and a media query adds no specificity, so a guard written
BEFORE the base rule is completely inert — the later equal-specificity rule wins. Red-team MEASURED
exactly this in Chromium: `transitionDuration = 0.3s`, a live animation, mid-flight width 861/1264 px,
**while all thirteen teeth of the draft gate stayed green** (bypass S1). `[A11Y-RM3/order]` asserts
`guard.startIndex > base.endIndex` — the guard follows EVERY `.hp-fill`-matching transition rule —
and M13 (swap the two blocks) is its mutant in the proof-of-teeth probe.

### D4 — the gate is TWO oracles, and the split is deliberate

**Chosen: a CI-resident source-text eval plus a ledger-time real-Chromium probe.**

Six of the nine measured bypasses are cascade-resolution facts that **no source-text oracle can
see**: source order (S1), `!important` (S2), selector specificity via `div.hp-fill` /
`[class~="hp-fill"]` / `.hp-bar > .hp-fill` (S3), `@media screen` (S3), a nested media block (S8),
and the Web Animations API (S4, which ignores `prefers-reduced-motion` entirely and is not stopped
by `transition: none !important`). A single source-text eval therefore cannot be the whole gate; a
single browser probe cannot run in `just ci` today.

- **CI-resident** — `evals/reduced-motion-hp-bar.eval.mjs` (auto-discovered by `evals/run.mjs`) plus
  the `RM3-HP-FILL` describe in `client/src/ui/battleView.test.ts`. Clauses
  `[A11Y-RM3/vacuity|inline|set|base|guard|order|body|delegate]`. This closes the source-text half
  of every bypass above and protects the repo forever.
- **Ledger-resident** — `rb-10.cascade-probe.mjs`, a real Chromium oracle beside the acceptance
  ledger. Under `reduce` it asserts `getComputedStyle(fill).transitionDuration === '0s'` **and**
  `fill.getAnimations().length === 0` (the `getAnimations` half is the only signal that catches the
  WAAPI class); under `no-preference` it asserts `0.3s`, proving the base rule is live and the guard
  is not a blanket kill.

**Honest limit:** the browser probe is **ledger-time, not CI-time**, because `client/e2e/` is
outside this slice's `touches:` and `a11y-e2e` is a separate recipe outside `just ci`. Recorded as
residual **R-rb-10-CASCADE** below.

### D5 — no custom property in either rule

**Chosen: neither `.hp-fill` rule declares a `--*`, asserted by `[A11Y-RM3/body]`.**

A `--*` declared in a stylesheet and read back through `getComputedStyle(...).getPropertyValue` is
the **R-m23-s10-RMCSS** purity escape: `evals/reduced-motion-purity.eval.mjs` walks `.ts` files only
(`.css` is not in `listClientSourceFiles`' extension list) and structurally cannot see a stylesheet.
We close that escape for the two `.hp-fill` rules. The repo-wide ban stays open **by design** and
belongs to M23 S9, which already owns `styles.css` in its `touches:`.

### D6 — the criterion id is the residual's own id

**Chosen: `R-m23-s2-X4`, tag `[A11Y-RM3]`; no new `A11Y-N` is minted.**

`A11Y-29` is already taken by a different criterion
(`specs/monster-realm-v2/M23-accessibility.spec.md:593`) and the whole `A11Y-1..36` range is
allocated (`PLAN.md:800`). The spec is outside this slice's `touches:`, so minting a number there is
not available. `[A11Y-RM3]` was verified free (only `[A11Y-RM2]` exists).

## Constraints discovered

- **`client/src/ui/battleView.ts` must never contain the literal strings `prefers-reduced-motion` or
  `matchMedia` — in code OR in comments.** `evals/reduced-motion-purity.eval.mjs:319` runs
  `findMotionReaders` over **RAW** file text and permits exactly one owner module
  (`render/motionPreference.ts`); a hit anywhere else REDs `[A11Y-RM2a]` with a resolver-purity
  message that has nothing to do with this slice. The shipped comment says "the reduced-motion media
  query in `client/src/styles.css`" instead. `styles.css` and `*.test.ts` are outside that walk.
- **biome's `noImportantStyles` is only a WARNING and `biome check` exits 0**, so CI does not catch
  an `!important` on the base rule (measured bypass S2). `[A11Y-RM3/base]` is what must catch it: it
  asserts no declaration in the base rule carries `!important`.
- **The eval re-implements a quote-aware CSS comment stripper rather than importing
  `stripCssComments` from `evals/a11y-static-shell.eval.mjs:83`.** Red-team MEASURED that the shared
  stripper is not quote-aware: `[data-hp-marker="/*"] … [data-hp-end="*/"]` deletes a whole rule from
  the gate's view while leaving braces balanced, so the fail-loud walker never throws (bypass S7).
  The local stripper additionally rejects any CSS string literal containing a comment delimiter,
  which is the carrier itself.
- The rule walker returns the FULL at-rule stack, never "outermost" or "nearest" — a nested
  `@media (prefers-reduced-motion: reduce){@media (min-width:99999px){…}}` is green under an
  outermost reading (S8) — and the guard-prelude check is an equivalent-prelude allow-list, because
  `@media not (prefers-reduced-motion: no-preference)`, `@media (prefers-reduced-motion)` and
  `@media (prefers-reduced-motion: reduce), print` are all Chromium-correct (`dur=0s`) and would
  otherwise false-RED. `no-preference` as a positive value is rejected: it is a perfect inversion
  (only the player who asked for reduced motion gets the animation).
- `[A11Y-RM3/delegate]` is a delegation pin on `battleView.test.ts` and `client/vite.config.ts`'s
  `test.include`. Without it, the eval's inline ratchet is the only thing standing between a gutted
  DOM tooth and a green ledger.

## Residuals

- **R-rb-10-CASCADE — the real-cascade oracle is ledger-time, not CI-time.** `rb-10.cascade-probe.mjs`
  runs beside the acceptance ledger as this slice's acceptance evidence; nothing inside `just ci`
  resolves the CSS cascade. A future slice should promote it into `client/e2e/` and the `a11y-e2e`
  recipe. This is a NARROWER residual than the draft's, because the CI-resident eval closes the
  source-text half of every measured bypass.
- **R-m23-s10-RMCSS stays open repo-wide.** D5 closes the custom-property escape only for the two
  `.hp-fill` rules. Widening `evals/reduced-motion-purity.eval.mjs` to walk `.css` is M23 S9's work,
  and was a declared STOP condition for this slice.
