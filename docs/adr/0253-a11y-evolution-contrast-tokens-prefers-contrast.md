# ADR-0253 — A11Y-30/31 for the evolution overlay: `:root` `--mr-evo-*` tokens consumed as inline `var()`, a trailing AAA `prefers-contrast: more` override, and DOM-computed contrast oracles in place of the §5.3 eval

**Status:** Accepted
**Date:** 2026-09-18
**Slice:** m23-s9 (M23 §2.7 — contrast remediation, text scaling, em/px normalisation; criteria A11Y-30/A11Y-31)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** Nine `:root` `--mr-evo-*` tokens consumed as inline `var()` in evolutionView; a trailing `prefers-contrast: more` block lifts them to AAA; vitest DOM oracles (m23s9 X1–X4) replace the §5.3 eval + baseline ratchet.

Numbering note: the supervisor assigned no ADR number ("None"). **0253 is self-assigned** (0252 is the highest on disk and `DIGEST.md` names 0253 next-free at drafting time); renumber at merge if a sibling takes it first.

---

## Context and problem statement

M23 §2.7 requires contrast remediation for `client/src/ui/evolutionView.ts`, the only view that sized text in `em`
while its twelve siblings use `px`, and §6 A11Y-30/31 say a resolved foreground/background pair below 4.5:1 (3.0:1 for
large text) fails CI, with an "unresolved pairs" count ratcheted against a checked-in baseline. Hand-computed WCAG
ratios on the shipped view found three real failures: `#666` "No monsters yet." on the worst-case composited backdrop
(`rgba(0,0,0,0.8)` over a white page = `#333`) is **2.20:1**; `#666` "No evolution paths." on the card `#1e1e2e` is
**2.86:1**; `#fff` on the `#059669` Evolve button is **3.77:1**.

Three constraints shaped the fix. **(C1)** The spec's mechanism, `evals/contrast-ratio.eval.mjs` +
`evals/baselines/contrast-unresolved.json` (§5.3), does not exist: S10's ledger DEFERred it (X16) and ADR-0224
(Accepted 2026-09-01) bans new `evals/*.eval.mjs`. **(C2)** Every sibling view styles inline via `cssText`, and an
inline literal is unreachable by any media query; a stylesheet class rule would need `!important` to beat an inline
declaration. **(C3)** The oracle runs in happy-dom, which preserves `var(--x)` in inline `cssText` and reads it back
through the LONGHAND (`style.backgroundColor`) but does not populate that longhand from the `background` shorthand
(measured), and which silently drops unparseable declarations.

## Considered alternatives

- **A — CSS classes in `styles.css` carrying the colours.** Rejected: happy-dom applies no stylesheet, so the
  colours would not be DOM-readable by the oracle, and beating the views' inline styles needs `!important`.
- **B — a global namespace (`--mr-fg`, as the purity eval's own GOOD fixture e8 anticipated) vs a per-view
  `--mr-evo-*` namespace.** Either passes every gate; `--mr-evo-` is chosen because only this view consumes the
  tokens and a global name would imply a cross-view contract nothing yet enforces.
- **C — keep `#999` as a separate faint token.** Rejected: 4.43:1 on `#333`, below the 4.5:1 floor.
- **D — a separate `--mr-evo-title` token.** Rejected: it never changes between scopes, so it is a decoy; the title
  uses `--mr-evo-fg`.
- **E — resolve the two scopes by text-slicing `styles.css` at the `@media` substring.** Rejected: an unconditional
  `:root` written after an empty media block would pass. The test uses the parser's `atStack` instead.
- **F — the §5.3 eval + monotonic baseline (spec-literal).** Rejected on C1.
- **G (CHOSEN) — `:root` tokens + inline `var()` + a trailing `prefers-contrast: more` override, gated by vitest DOM
  oracles.**

## Decision

- **D1 — A11Y-30/31 are satisfied by DOM-side vitest oracles, not the §5.3 eval.** `client/src/ui/evolutionView.test.ts`
  (`m23s9 X1..X4`) renders the view in happy-dom, composites the translucent backdrop over a white AND a black page,
  computes WCAG relative luminance from the rendered DOM, and requires ≥ 4.5:1 for every text pair in the default
  scope and ≥ 7:1 under `prefers-contrast: more`. Consequence: **"unresolved pairs" is not a concept here** — every
  pair MUST resolve or the test throws (zero-unresolved replaces the monotonic baseline), which is what A11Y-31 was
  protecting against. The §5.3 premise "hex pairs extracted from inline `cssText` literals" no longer holds for this
  view: a future scanner must resolve `var()` through `styles.css`.
- **D2 — the consumption seam is `:root` custom properties + inline `var()` in the view's existing `cssText` idiom,
  NOT CSS classes.** The media query reaches the TOKEN, so no class is needed; the repo's only class rule that a
  media query targets, `.hp-fill`, exists because the query must reach an ANIMATION (ADR-0213). Every colour in
  `evolutionView.ts` is a `var(--mr-evo-*)`; surfaces use the `background-color` LONGHAND, mandated by C3. Nine
  tokens: `backdrop`, `card`, `row`, `border`, `fg`, `muted`, `ok`, `warn`, `button`.
- **D3 — `prefers-contrast: more` is the AAA tier:** ≥ 7:1 for every text pair, an OPAQUE backdrop (`#000`), and
  ≥ 3:1 card/row borders — a checkable, non-decoy criterion. **The override block MUST be the last rule in
  `styles.css`:** it has the same specificity as the default `:root` block, so source order decides, and a block
  written first is inert while every value still parses (rb-10/ADR-0213 learned this for `.hp-fill`). X2 pins the
  ordering by parse index.
- **D4 — the 3:1 large-text tier is not used.** WCAG "large" is 18pt (24px) or 14pt bold (18.67px); nothing in this
  view qualifies, so 4.5:1 applies uniformly. Spec erratum: §2.7's "≥18px, or bold ≥14px" conflates pt with px.
- **D5 — `em` → `px`:** `0.85em/0.8em/0.75em` → `14px/13px/12px`, matching the twelve sibling views (11/12px) and
  letting 1.4.3 apply without unit conversion. Trade-off: px drops the user-default-font-size affordance; browser
  zoom (the §3.1 1.4.4 mechanism) scales both units equally.
- **D6 — cross-boundary import.** `evolutionView.test.ts` imports `parseCssStyleRules`, `stripCssComments`,
  `declarations` and `normaliseMediaPrelude` from `evals/reduced-motion-hp-bar.eval.mjs` (precedent:
  `indexShell.test.ts:89,94` → `a11y-static-shell.eval.mjs` under ADR-0215). Those four exports are now a shared
  contract; renaming one reds this test.

Shipped ratios (default scope): fg `#e0e0e0` on `#333` **9.57:1**; muted `#aaa` on `#333` **5.44:1**; fg on the
`#065f46` button **5.82:1**. `more` scope: every pair ≥ 13:1 on `#000`/`#101018`.

Token hygiene enforced by X3/X4: all inline colours are tokens; the same token set is declared in both scopes, each
exactly once; every token is consumed by an evaluated pair (border: a dedicated ≥ 3:1 assertion in the `more` scope);
a fixed inline-declaration allow-list; no class/id on any element; no element/attribute selectors or `!important`
in the sheet; a raw-vs-serialised style-write survival check closes happy-dom's silent drop of unparseable
declarations; every inline `font-size` is 12, 13 or 14 px and the layout containers declare none.

## Consequences

- **Positive:** the three measured AA failures are closed and cannot silently regress — any colour edit in either
  file is re-measured from the rendered DOM. A `prefers-contrast: more` user gets an AAA overlay on an opaque
  backdrop with visible card boundaries. The view's font sizes are in the same unit as every sibling.
- **Negative / accepted:** the §5.3 eval and baseline are permanently displaced for this view, and a future
  repo-wide contrast scanner must understand `var()`. The `evals/` → test import direction adds a second
  cross-boundary contract (D6). The `background-color` longhand rule is a happy-dom accommodation a reader could
  mistake for style.
- **Visual changes shipped (R4):** title `#fff` → `#e0e0e0`; button `#059669` → `#065f46`; unmet heading `#ccc` →
  `#e0e0e0`; unmet gate `#999` → `#aaa`; met gate `#8fbc8f` → `#34d399`; unmet row border `#555` → `#333`.

## Residuals

- **R1 — non-text contrast (WCAG 1.4.11) is out of scope** per spec §3.1. The borderless Evolve button measures
  1.39:1 against the `more` backdrop and 1.64:1 default; the card border is 1.3:1 by default and reaches 3:1 only
  under `more`.
- **R2 — happy-dom oracle:** no UA stylesheet, no layout. The tests prove declared colours, not painted pixels; the
  real-browser check is the S11 manual protocol.
- **R3 — `prefers-contrast: more` is exercised by no e2e.**
- **R4 — visual changes** listed under Consequences; no design sign-off was sought.

## Related

ADR-0205 (overlay a11y metadata SSOT), ADR-0213 (`.hp-fill` reduced-motion guard — ordering lesson), ADR-0215
(CSS comment stripper single owner — import precedent), ADR-0224 (retire scanner-script gates), ADR-0233 (A11Y-29
colour independence; its S9 note is honoured — no HP palette hex was moved into `:root`).
