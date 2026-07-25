# 0151 — ux1 help affordance: a zero-JS persistent hint, and the viewport-anchoring of the overlay it advertises

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** ux1 (M-postgate-ux-hardening — persistent on-screen hint advertising the `?` help overlay + a battle-result continue hint; EARS ux1-1..ux1-3)
**Supersedes:** —
**Amends:** 0135
**Subsystems:** client-ui
**Decision:** Ship the "Press ? for controls & help" hint as static zero-JS markup in `index.html`, and in the same edit give `#help-overlay` `position:fixed;inset:0;z-index:100` — the overlay it advertises rendered below the fold.

## Context

The 2026-07-25 playtest gate found that most UX complaints were **discoverability gaps around
features that already exist**, not missing features (`playtest-gate-decision-2026-07-25.md` §7-8).
The `?`-bound help overlay shipped at pt-c2b (ADR-0135) with real content, but nothing on screen
advertises it: Drew's report says *"there is no help text or instructions of any kind"*
(`PlaytestReport.md:41`). Separately he got stuck on the battle-result screen not knowing Escape
dismisses it — *"I thought I'd have to restart the game"* (`:51`). Spec §ux1 asks for two persistent
affordances: a corner hint for `?` (ux1-1) and a "Press Esc to continue" hint on victory/flee/defeat
(ux1-2), each proof-of-teeth tested (ux1-3).

### The finding that reshaped the slice

Planning-phase red-team established, and the orchestrator independently confirmed, that
**`#help-overlay` does not render inside the viewport at all.**

`client/index.html` ships it as a static, in-flow `<div>` carrying only `style="display:none"` — no
`position`, no `z-index` — placed *after* `#app`, which holds a `window.innerHeight`-tall PixiJS
canvas (`client/src/render/world.ts:57-63`). There is no CSS file anywhere in the repo, and
`HelpView` only ever reads/writes `style.display` (`client/src/ui/helpView.ts:36-51`). So
`HelpView.show()` paints the overlay at `y ≈ innerHeight`: below the fold, in default black text on
the `#0b0d12` body background. Measured in real Chromium at 1280×720: `help-overlay.top = 724`,
`inViewport = false`.

Three independent corroborations that this is the live behaviour, not a fixture artifact:

- in-tree, from nh1/ADR-0146 (`client/src/main.ts:502-504`): *"an open overlay makes the document
  taller than the viewport-sized canvas, so those defaults scroll the game out from under the
  player."*
- `PlaytestReport.md:85`, on the structurally-identical `#shop-overlay`: *"opens a shopping menu **at
  the bottom of the page** … its placement is awkward, and doesn't use an overlay structure like the
  fusion menu does."*
- `PlaytestReport.md:41`: Drew never found the `?` overlay at all. Spec §ux1's evidence paragraph
  ("Drew found the overlay only by pressing random keys") conflates this with the separate
  battle-result complaint at `:51`.

Shipping ux1-1's hint **alone** would therefore have advertised an affordance that appears to do
nothing when followed — a net-negative change that passes 100% of its own static-markup teeth.

## Decision

### D1 — ux1-1 is delivered as two parts, and the extension is disclosed

`#help-overlay` gains `position:fixed;inset:0;z-index:100;overflow:auto` plus a readable
background/padding/colour, mirroring the four JS-created modal roots (`boxView.ts:32`,
`raisingView.ts:29`, `evolutionView.ts:39` are all `position:fixed;inset:0;z-index:100`) and staying
below `battleView`'s `z-index:110` (`battleView.ts:51`) so a battle auto-show still supersedes it.
`HelpView.show()` sets `style.display = ''`, which removes only that one declaration and leaves the
rest of the inline style intact — so no view-class change is needed and `show`/`hide`/`visible` are
byte-unchanged.

This is an **extension of ux1-1 beyond the spec's literal text**, disclosed here rather than
smuggled in (nh1/ADR-0146 `e.repeat` precedent). Without it the criterion's stated purpose — *"so a
new player can self-serve without key-mashing"* — is unmet by construction.

### D2 — the hint is static markup, not a view class

`<div id="help-hint">Press ? for controls &amp; help</div>`, inline-styled
`position:fixed;bottom:16px;left:6px;…;pointer-events:none;z-index:50`, sibling to the `#build-stamp`
provenance div (pt-a1/ADR-0128) — the existing idiom for a non-intrusive persistent corner element.
Zero JS: no module, no lifecycle, no reconnect path, nothing to reset, and the hint is present even
when the client fails to boot — precisely when a confused player needs it.

The rejected alternatives are recorded because both are traps a future "cleanup" would walk into:

- **A `client/src/ui/hintView.ts` shell** — premature abstraction (a `render()` that never varies)
  *and* a hard gate conflict: `evals/dom-shell-coverage-exclusion.eval.mjs`
  (`findUnsanctionedExclusions`) exact-set-guards `client/vite.config.ts` `coverage.exclude`, so a
  new `src/ui/*.ts` shell lands in the 96% coverage denominator with no legal way out unless the
  eval's hardcoded `DOM_SHELLS` list is edited in the same change.
- **Rendering it from `main.ts`** — `main.ts` is coverage-excluded, so the hint would be reachable
  by source-scan teeth only.

`bottom:16px` (not `2px`) stacks the hint **above** `#build-stamp` rather than beside it: both are
bottom-anchored fixed elements, and at 360 px width they were measured overlapping horizontally.
`pointer-events:none` is load-bearing — a fixed element over the game canvas must not eat clicks.

### D3 — the continue hint rides the existing outcome branch, with no `isPvp` special case

A dedicated `#continueHintEl` is created in `BattleView`'s constructor after `#outcomeEl`
(`data-testid="battle-continue-hint"`, text set once, `display:none`), toggled inside the **existing**
`#renderOutcome`, which already branches on exactly `vm.outcome === 'Ongoing'`. A separate render
method would duplicate the predicate and create a seam where the outcome banner and its hint can
disagree.

It is **not** appended into `#outcomeEl`'s text (`client/e2e/recruit.spec.ts:753,779,931` use
`getByText('Victory!', { exact: true })`, and that element is 18 px bold gold — wrong styling for a
hint), and **not** a child of `#outcomeEl` (whose `textContent` write would wipe it every render).
The `refresh(null)` branch resets it alongside `#weatherEl`/`#pvpStatusEl`, matching that branch's
own precedent: the element otherwise retains `display:block` across `refresh(null)` and
`hide()/show()` — latent today, since `show()` is only reachable from inside `refresh(vm)`.

### D4 — "Press Esc to continue" is truthful, with one recorded limit

Five adversarial routes were tried and all failed. The three Escape branches above battle in the
ladder — rename (`main.ts:943`), tradePropose (`:952`), help (`:958`) — cannot be open over a battle
overlay: all three are force-hidden by the battle auto-show path (`main.ts:1127-1139`) and their
open-guards all contain `!battleView?.visible`. The battle Escape branch is a pure local `hide()`
with no `sendGuarded`, so a frozen link cannot deaden it. `dismissedBattleId` sticks
(`battleModel.ts:379-381`) and reconnect pre-dismisses rather than re-pops. The terminal frame
renders zero action buttons (`bench` is populated only inside `if (ongoing)`,
`battleModel.ts:257-270`).

**Recorded limit (pre-existing, not this slice's to fix):** a PvP battle is ONE row with
`player_identity = challenger` (`server-module/src/pvp.rs:291`) and `store.latestPlayerBattle`
filters `playerIdentity === identity` (`store.ts:718-726`), so the **challenged** player never
receives the battle overlay through the production path at all (`main.ts:1581` documents this for
the `__mrPvp` test hook). The PvP terminal test case is therefore a **decision-pin for D3's
no-`isPvp`-branch call** and must not be cited as evidence of both-sides PvP truthfulness.

### D5 — the teeth are named for what they can actually prove

happy-dom performs no layout, so a test over static markup can assert *present, body-anchored, and
not obviously invisible* — **never** *visible*. Twenty-six wrong implementations were run through the
assertion set: `opacity:0`, `visibility:hidden`, `font-size:0`, `left:-9999px`, `transform:scale(0)`,
`clip-path:inset(100%)`, `content-visibility:hidden`, the `hidden` attribute and a zero-size ancestor
**all pass** a static-markup test, and `getComputedStyle` returns `visibility: ""` on a parsed
document. The tests are named accordingly, carry a deny-list for the cheap cases, and this limit is
recorded as a residual rather than papered over.

Structural teeth exist because existence checks alone were proven insufficient. The z-index is
asserted `>= 1` and **below `#help-overlay`'s own parsed z-index in the same document** (a raw
`/^\d+$/` guard first, because `parseInt` accepts the CSS-invalid `5e1`/`1e2` that a browser drops
outright, and `z-index:-1` would paint the hint behind in-flow boxes).

The malformed-markup tooth was **corrected by mutation probe, and the correction is worth recording
because the first version was subtly ordering-dependent.** An unclosed `</div>` on the hint makes the
parser adopt whatever *follows* it. The tooth was first written as "`#build-stamp`'s parent is
`<body>`", from an analysis that assumed the hint preceded the stamp. The hint actually ships **last**
in `<body>`, after `#build-stamp` and before the module `<script>` — so the probe measured
`{hintParent: "BODY", hintChildren: ["SCRIPT"], stampParent: "BODY"}` and **the mutant survived all
seven original assertions**. The invariant belongs on the hint, not on a presumed victim: `#help-hint`
must have **no element children** (it is a leaf text badge), which is placement-independent and kills
the whole class — including the future case where an element inserted between the hint and the script
is swallowed *and* inherits the hint's `pointer-events:none` and 11 px dim styling, vanishing from the
UI while `querySelector` still finds it. The `#build-stamp` parent assertion is retained as an
independent anchor guard on the pt-a1/ADR-0128 provenance surface (it kills a future wrapper div
re-parenting the stamp), no longer credited with the unclosed-tag kill.

## Consequences

**Positive.** The `?` overlay becomes reachable-by-eye for the first time, and is advertised. The
battle-result panic moment gets an explicit exit. Zero runtime code is added for ux1-1 — no new
module, no coverage-denominator change, no new failure mode. The `#help-overlay` fix also removes one
of the ten overlays that make the document taller than the viewport (the ADR-0146 scroll mechanism).

**Negative / residual.**

1. **Nine sibling overlays still render below the fold** — `dialogue`, `quest-log`, `heal`, `shop`,
   `trade`, `pvp-challenge`, `leaderboard`, `rename`, `tradepropose` all have the identical defect
   and are the direct cause of `PlaytestReport.md:81`, `:85` and `:97`. Deliberately **not** fixed
   here (touch-set + blast-radius discipline); this is the strongest available evidence for
   prioritising the parked `M-postgate-overlay-registry` slice, and the first thing a reader of this
   ADR should act on.
2. **No test in this slice proves the hint is *visibly* rendered** (D5). A real check needs
   `client/e2e/**` + `toBeInViewport()`, which is out of this slice's touch-set.
3. The z-index tooth reads inline style only; moving these declarations to a stylesheet would make
   it a false negative. Acceptable while the repo has zero CSS files.
4. The `W-UX1-ESCAPE-BATTLE` pin is textual and green-before-and-after by design (a regression pin,
   `W-HELP-NO-RECONNECT-HIDE` precedent); a benign reformat of `main.ts:964` would false-RED it. It
   is justified because that branch is otherwise wholly untested — `main.ts` is coverage-excluded
   and no e2e presses Escape against a battle-result overlay.

## Considered alternatives

- **Ship ux1-1's hint without repositioning `#help-overlay`.** Rejected: measurably advertises a
  no-op, and is strictly worse than shipping nothing.
- **Reposition all ten in-flow overlays.** Correct eventually, wrong here: ten behaviour-sensitive
  shells, out of proportion to a MEDIUM discoverability slice, and it is exactly the parked
  `M-postgate-overlay-registry` work.
- **Reuse `#build-stamp` for the hint.** Rejected: `main.ts:1681-1682` overwrites its `textContent`
  from `BUILD_INFO`, and it would conflate provenance with help.
- **Append "(Press Esc to continue)" to the existing outcome string.** Fewer lines, but inherits
  18 px bold gold styling and breaks three `getByText(..., { exact: true })` e2e assertions.
