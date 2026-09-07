# ADR-0244 — Criterion A11Y-12 is enforced by a computed-cascade differential oracle in vitest, not by matching the `#` character

**Status:** Accepted
**Date:** 2026-09-07
**Slice:** rb-9 (residual R-m23-s2-X3, `M-residual-backlog.spec.md#rb-9`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0224 (scanner-script gates retire into ordinary tests; this is a migration under its delete-on-touch rule), ADR-0205 (the a11y metadata `client/src/styles.css` serves), ADR-0215 (the sole-owner CSS comment stripper this leaves untouched), ADR-0151 D1 (the below-the-fold regression this re-closes), ADR-0213 (the `.hp-fill` reduced-motion guard whose rules the oracle must tolerate)
**Subsystems:** client-ui, ci-gates
**Decision:** "No rule in the shipped stylesheet may alter the reachability or the styling contract of a pinned shell id" is enforced by rendering the real `client/index.html` with the real `client/src/styles.css` in happy-dom and diffing fully-enumerated `getComputedStyle` output against a sheet-absent render, over `html`/`body` plus the five pinned ids, in two render states. The selector-shape blacklist it replaces is deleted in the same slice.

## Context and problem statement

Criterion A11Y-12 (M23 §2.7) is written as "`client/src/styles.css` declares zero `#id` selectors", and it was
enforced by matching the literal `#` character (`findIdSelectors`). The criterion's *literal text* is not the
*property* it exists to protect. `client/src/indexShell.test.ts` and `client/src/main.wiring.test.ts` pin the
inline `style` attribute of `#help-overlay`, `#help-hint` and `#build-stamp` BY TEXT, on the premise that the
inline attribute is their complete styling contract; `#a11y-live` must stay in the accessibility tree. A rule
that reaches any of those ids can satisfy or defeat those pins without changing a character of the markup they
read.

Red-team measured six biome-clean, `#`-free stylesheets that leave every gate green while, in Chromium, hiding
`#help-overlay`, blanking `#help-hint` and removing `#a11y-live` from the accessibility tree — re-creating
ADR-0151 D1's below-the-fold regression undetected:
`[id="help-overlay"]{visibility:hidden}`, `[id^="help-"]`, `div[id*=help]`, `:where([id='help-hint'])`,
`body>div:nth-child(11){position:static!important}`, `*{position:static!important}`.

m23-s2 responded with `findCascadeReachingSelectors`, a *shape* blacklist: ban naming a pinned id in any
spelling, plus `*` and the positional pseudos. It closed the six measured spellings and declared its own
inadequacy in writing — "a sufficiently indirect selector still escapes it". That is the general property of a
blacklist: it closes by enumeration, never by construction, so each new spelling is a new slice. This is the
tail ADR-0224 was written to end.

## Considered alternatives

- **Widen the shape blacklist** (add `~`, `:last-of-type`, tag selectors, …) — rejected. It is the retired
  vehicle, ADR-0224 forbids patching a scanner further, and the measurement below shows enumeration does not
  converge: two selectors that name no id, are not `*`, and are not positional (`body > div:last-of-type`,
  reaching `#a11y-live`; `body > button`, reaching `#help-hint` as the only `<body>` button child) escape the
  shipped blacklist today.
- **Playwright / real Chromium**, which m23-s2's docblock predicted would be required — rejected as the
  default. `client/e2e/**` needs a browser and a live SpacetimeDB, which puts the check in the nightly tier
  only, off the gate that actually blocks a merge. It was also predicated on a measured-false premise: happy-dom
  20.10.6 *does* implement the cascade for every technique in the bypass set, including `!important` beating an
  inline declaration. Retained as the escape hatch for anything needing real layout, which this is not.
- **Move the cascade oracle into `evals/a11y-static-shell.eval.mjs`** — impossible, not merely undesirable.
  There is no repo-root `package.json`; `happy-dom` is a `client/` devDependency and does not resolve from
  `evals/`, which run from the repo root under plain node.
- **A frozen baseline of expected computed values** (5 ids × ~17 properties × 2 states) — rejected. It is
  ~170 hand-transcribed cells whose only realistic authoring procedure is "run it and paste the output", which
  is the tautology this repo has repeatedly measured as a green-but-meaningless gate. It also charges every
  future stylesheet slice a re-transcription in which a wrong cell is indistinguishable from a right one, and
  it forces a property roster, which is itself a blacklist with the same convergence problem one level down.
- **A sheet-absent vs sheet-present differential (chosen)** — no frozen expectation for four of the five ids,
  no property roster, and the criterion stated directly rather than by proxy.

## Decision outcome

`client/src/indexShellCascade.test.ts` renders the real `client/index.html` in a detached happy-dom `Window`
twice per state — once with no author sheet, once with the candidate sheet injected as a `<style>` — and reports
every `(state, target, property)` whose fully-enumerated computed value differs.

- **Targets:** `html`, `body`, `#help-overlay`, `#menu-overlay`, `#help-hint`, `#build-stamp`, `#a11y-live`.
  `html` and `body` are in the set because `display` is **not** inherited: measured, `html{display:none}`
  produces **no offender at all** against a roster of the five ids alone, in happy-dom and in a real browser
  equally. An ancestor rule hides everything while every descendant's own computed `display` is untouched.
- **States:** AS-SHIPPED, and SHOWN. SHOWN is produced by `el.style.display = ''` on the two overlay shells —
  never by writing an explicit value — because that is what `HelpView.show()` (`client/src/ui/helpView.ts`) and
  `MenuView.show()` (`client/src/ui/menuView.ts`) do. Writing `'block'` would restore an inline declaration that
  beats every non-`!important` author rule and blind the oracle to exactly the regression class it exists to
  catch. Measured: `[id="help-overlay"]{display:none!important}` is invisible in AS-SHIPPED (both sides
  compute `none`) and is caught only in SHOWN.
- **Expectation:** the diff must be empty for every target except `#a11y-live`, whose diff must equal the
  `.sr-only` effect exactly. That equality doubles as the liveness control: a sheet that never renders produces
  an empty diff, which is `≠` the expected non-empty map, so it REDs rather than greening everything.
- **Custom properties are skipped.** Measured, `:root{--x:1px}` otherwise registers as an offender, and M23 §4
  slice S9 lands `:root` colour tokens in this exact file — the gate would have false-RED a planned sibling
  slice. Skipping them costs nothing: a `var()`-consumer attack (`:root{--h:none}` plus
  `[id="help-hint"]{display:var(--h)}`) is still caught, because the *consumer's* own longhand moves.
- **`@import` is a precondition, not residue.** A sheet consisting only of `@import url(…)` yields a completely
  empty diff under `disableCSSFileLoading:true` — the oracle's own hermeticity settings create the hole — so the
  `@import` ban is asserted in the real-artefact arm, where the assumption it guards lives.

`findCascadeReachingSelectors` and its tooth arm are **deleted** in the same slice, per ADR-0224's delete-on-touch
rule. Its declared residue ("a rule reaching a pinned id through a property outside the probed set") was an
artefact of the property roster the chosen design does not have: measured, `[id="a11y-live"]{color:red}` and
`{content-visibility:hidden}` are both caught by the differential, and the docblock's own worked escape-hatch
example matches zero elements in the real markup. `findIdSelectors` and its tooth arm **stay** — they are shared
with the eval's fixture corpus and are the cheap statement of the file's documented single-file legibility
contract, which is a different claim from reachability.

### Consequences

- The per-PR gate strengthens: a text scan over one file becomes a computed-cascade oracle over the real markup,
  and the criterion is stated as the property rather than as a proxy for it.
- **The eval's `T-REAL2` is retained, against ADR-0224's default.** `just a11y-e2e` runs three evals plus eight
  *named* spec files, and neither `indexShell.test.ts` nor the new cascade test is among them — so `T-REAL2` is
  the only *executing* A11Y-12 check in the nightly tier. Deleting it would drop coverage with no replacement,
  which ADR-0224 forbids just as firmly as it forbids keeping both. Restoring it properly needs the new file
  added to the `justfile` roster, which is outside this slice's `touches:` and byte-pinned in lockstep by
  `evals/ci-gate-wiring.eval.mjs`. Registered as a residual rather than widened into silently.
  `T-LIVE1` is retained for the same class of reason and a stronger one: it is not an A11Y-12 clause at all, but
  the probe that `findIdSelectors` reads its input and walks *inside* `@media` — a property nothing else tests,
  and one S9's `prefers-contrast` rules make newly relevant.
- **Declared blind spots.** (a) The oracle judges five ids plus two ancestors; a rule reaching some *other*
  element (`#app{display:none}`) is not its subject and remains `findIdSelectors`' business. (b) It reads
  computed style, not layout — happy-dom performs no layout, so an off-viewport push via a property whose
  computed value is unchanged is out of reach, as `indexShell.test.ts`'s own HONEST SCOPE LIMIT already records
  for its sibling teeth. (c) Custom properties are skipped, bounded as measured above.
- A deliberate future change to `#a11y-live`'s hiding contract becomes a two-place edit: `client/src/styles.css`
  and the expected `.sr-only` map. That is the "complete styling contract" claim being enforced, not friction.
  Slice S9 is the first caller and should budget for it; its `:root` tokens and `prefers-contrast` rules
  themselves cost nothing, by construction and by measurement.
