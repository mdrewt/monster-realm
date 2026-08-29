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

### D7 — the guarded transition cannot currently fire, and that is disclosed rather than fixed here

**This is the most important fact in the slice, and it was found by a post-ship red-team pass.**
`#renderMonsterCard` opens with `el.replaceChildren()` and `document.createElement`s a **new** fill
element on every `refresh()`. A CSS transition needs a previous computed value on the *same* node,
so the base rule `.hp-fill { transition: width 0.3s }` is computed but unreachable.

MEASURED in real Chromium against the shipped code, driving the real render loop: 120 ms after a
90% → 10% HP drop the fill is already at its final width under **both** motion preferences,
`getAnimations().length === 0`. Under `no-preference` the bar **snaps**.

This is **not a regression introduced here**: the pre-slice inline `transition:width 0.3s` was
equally unreachable, for the same reason and on the same freshly-created node. What this slice
changes is that the declaration is now in a stylesheet where a media query *can* reach it, which is
exactly what residual R-m23-s2-X4 asked for. What it does **not** do is make the HP bar animate —
that is a product change, outside this slice.

The honest consequence, recorded because it is load-bearing for the next author: the guard is
**correct and currently latent**. The first person who notices the bar snapping and sets out to
"make the smooth HP bar work" will either reuse the fill node (at which point the guard becomes
live, and correct) or reach for `element.animate(...)` — which ignores `prefers-reduced-motion`
outright. That second path is the measured R1 escape below, and it is why `[A11Y-RM3/inline]` is
enforced over the whole of `client/src`, not just this file.

Rejected: making `#renderMonsterCard` reuse the fill node inside this slice. It is a behavioural
change to the battle view with its own netcode-adjacent review surface, it is not what the residual
asked for, and shipping it here would mean the slice's own gate had never seen the code it gates.

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

### Post-ship red-team hardening (all MEASURED against the shipped gate)

The first shipped gate was attacked again after it was green. Seven findings; five changed the gate.

- **R1 — the inline ban was file-local.** A sibling `client/src/ui/hpFillMotion.ts` exporting a
  feature-detected `target.animate([...], 300)`, called once from `#renderMonsterCard`, was GREEN on
  the eval, 51/51 on `battleView.test.ts`, clean on `tsc` and the pinned biome, PASSING on the
  Chromium probe — and visibly animating under `reduce`. happy-dom implements no `Element.animate`,
  so the feature detect returns early and the DOM tooth sees a byte-clean element; the probe renders
  a static page and runs none of the app's JS. **Fix:** `[A11Y-RM3/inline]` now scans every non-test
  module under `client/src` (measured population 92, floor 60, zero hits), not just this one file.
- **R3 — the selector policy was fail-OPEN.** Five carriers reached the fill without naming the
  class token and were each Chromium-measured animating under `reduce`: `[class^="hp-"]`,
  `[class*="hp-fil"]`, `[class~="HP-FILL" i]`, `[style*="height:100%"]` (the fill's inline style is
  a stable handle) and `.hp\-fill` (a CSS escape of the hyphen). A sixth came from the reviewer:
  `div.hp-fill` as the BASE rule is specificity (0,1,1) against the guard's (0,1,0) and wins
  regardless of source order. **Fix:** the policy is inverted to fail-CLOSED — a motion rule is
  admissible only if it is exactly `.hp-fill`, or is a plain selector with no attribute selector, no
  universal selector, no escape, and no mention of the class token. An unrelated future
  `.tooltip { transition: opacity }` is still accepted, and a tooth pins that non-regression.
- **R4 — the new stripper had no `url()` state.** `url(/*)` is not a comment opener in CSS, but the
  stripper treated it as one and swallowed everything to the next real `*/`, deleting a whole
  `div.hp-fill` rule from the gate's view with braces *and* parens balanced. Measured biome-clean
  and `indexShell.test.ts`-clean. **Fix:** unquoted `url()` is consumed raw and refuses embedded
  comment delimiters, matching the existing string-literal policy.
- **R5 — the suspension list missed the conditional spellings.** `it.skipIf(TRUE)(...)` left the
  delegate at `50 passed | 1 skipped` **with the pre-fix defect restored** while the gate stayed
  green. **Fix:** `skipIf`/`runIf` added for `it`/`test`/`describe`.
- **R6 — no mutant could produce `[A11Y-RM3/delegate]`.** All twelve wrote `styles.css` or
  `battleView.ts`, so the delegation clause was proven only by its own synthetic fixtures; a
  one-line hollowing of its needle list kept `teeth=` green with the runtime oracle physically
  deleted. **Fix:** mutants M17 (needle gutted) and M18 (conditionally suspended) now pin that tag.
- **R7 — a false RED, accepted as a known limit.** The CSS-nesting spelling (`@media` nested inside
  the base rule) is correct CSS, is Chromium-correct, and this parser does not model nesting, so it
  reads as "guard missing". Not fixed: teaching `parseCssStyleRules` nesting is a real change with
  its own risk, landed late. Instead the failure message now says so explicitly and names un-nesting
  as the repair, because the documented failure mode is a false RED being "fixed" by loosening the
  clause it fired on.

Not closed, and stated plainly: the delegation pin is a PRESENCE pin. A tautological rewrite of the
`RM3-HP-FILL` body — one that keeps the needles but asserts them about a locally constructed probe
element — is green on every clause and was measured to survive the original defect being restored.
No text pin can close that; the ledger's X2 pass-count floor and the vitest-adjudicated mutant M2
catch it at ship time only.

## Residuals

- **R-rb-10-CASCADE — the real-cascade oracle is ledger-time, not CI-time.** `rb-10.cascade-probe.mjs`
  runs beside the acceptance ledger as this slice's acceptance evidence; nothing inside `just ci`
  resolves the CSS cascade. A future slice should promote it into `client/e2e/` and the `a11y-e2e`
  recipe. This is a NARROWER residual than the draft's, because the CI-resident eval closes the
  source-text half of every measured bypass.
- **R-rb-10-INERT — the guarded transition cannot fire (D7).** The fill element is recreated on every
  render, so the base rule is latent. Closing it means reusing the fill node in `#renderMonsterCard`,
  which is a product change outside this residual's scope. Until then the HP bar snaps for everyone
  and the guard is correct-but-dormant.
- **R-rb-10-DELEGATE-STRENGTH — the delegation pin is presence-only.** A tautological rewrite of the
  `RM3-HP-FILL` body passes every clause; no text pin can close it. The X2 pass-count floor and the
  vitest-adjudicated mutant M2 catch it at ship time only.
- **R-m23-s10-RMCSS stays open repo-wide.** D5 closes the custom-property escape only for the two
  `.hp-fill` rules. Widening `evals/reduced-motion-purity.eval.mjs` to walk `.css` is M23 S9's work,
  and was a declared STOP condition for this slice.
