# 0163 — One overlay probe table behind all five fan-out surfaces, and the AC-12 click front door

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** uxd3-b (M-postgate-ux-design — unified overlay IA)
**Supersedes:** —
**Amends:** 0151, 0162
**Amended-by:** ADR-0164
**Subsystems:** client-ui
**Decision:** The five overlay OR-lists in `main.ts` collapse onto one probe table read via `anyVisible()`, and `#help-hint` becomes the menu's click door via attribute delegation; the hotkey→`canOpen` migration and the gate retirement defer to uxd3-c.

## Context

uxd3-a (ADR-0162) shipped the pure modality core — `OVERLAY_TIERS`, `OVERLAY_IDS`, `canOpen`,
`BATTLE_FORCE_HIDE`, `hideAllExceptPlan` — and added `menuView` to `main.ts` **additively**: one
extra token in each of the five fan-out OR-lists, one extra `!menuView?.visible` in each of the
eleven existing guard lists. The collapse was deferred because it detonates a source-scan cluster
for zero user-visible change. uxd3-b is that deferred work.

Two facts set this slice's shape, and both were measured rather than assumed.

**(1) `main.ts` is coverage-excluded** (`client/vite.config.ts`), and `just ci` does not run
`client/e2e/**`. For everything in this diff the source-scan teeth are the *only* gate. That is
why the new teeth pin exact literal shapes rather than token presence — a presence check was
measured green against a one-character inversion that kills all movement.

**(2) `W-OVERLAY-FANOUT-MUTEX` has no substitute yet.** It is the only executable guard that
KeyB's open-guard contains `!dialogueView?.visible`. Verified during plan review: no count tooth
covers `dialogueView?.visible`; `main.ts` imported nothing from `ui/overlayRegistry` before this
slice, so `OR-CANOPEN-GUARDONLY-9/-ALL` constrained a function with **no production caller**; and
no e2e presses a hotkey while `dialogueView` is visible.

## Decision detail

### D1 — The shell is one type and one function. No factory, no handle object, no write API.

`ui/overlayRegistry.ts` gains exactly:

```ts
export type OverlayProbes = Readonly<Record<OverlayId, () => boolean>>;
export function anyVisible(probes: OverlayProbes, exempt?: OverlayId): boolean;
```

The slice brief asked for `OverlayHandle` / `OverlayHandles` / `createOverlayRegistry` with
`anyVisible` / `anyVisibleExcept` / `open` / `hide` / `hideAllExcept`. **We shipped less, deliberately.**
`open`/`hide`/`hideAllExcept` have zero consumers until uxd3-c migrates the hotkeys; `visibleIds()`
and `isVisible(id)` have zero consumers here at all; `anyVisibleExcept` has exactly one caller and
is better expressed as an optional parameter. This is the same call ADR-0162's amendment A7 made
one slice ago in this same module, when it deleted the `createOverlayVisibility` / `OverlayProbes` /
`OverlayVisibility` shell for having one consumer — and A15 made when it deleted `RECONNECT_HIDE`
for having none. Shipping the write half now would have re-introduced precisely what A7 removed.

A one-member `OverlayHandle` object was rejected for the same reason plus a concrete cost: it is
`OverlayProbes` wrapped in a box, its only justification is uxd3-c forward-compat, and it makes the
Part B source-scan brace-match instead of matching a flat literal. uxd3-c does **not** pay for this
choice — per-id open thunks are a *separate* table with different contents (the view contract is
non-uniform: `render`-only, `show/hide/refresh`, `show/hide/toggle/refresh`, and
`pvpView.refresh(vm, forceVisible)`), so the probe table is authored once, not twice.

`anyVisible` carries **no try/catch**, stated in the module header: swallowing a throwing probe
would silently return `false`, i.e. a mutual-exclusion breach that looks like working code.

### D2 — The cut: uxd3-b takes the READ surfaces; uxd3-c takes the WRITE surfaces and the gate.

Shipped here: the 15-entry probe table, all five read-surface collapses (`anyOverlayVisible()`, the
nh2 reconcile emitter, the keydown movement suppression, the pvp auto-show aggregate, the rAF
held-dir re-issue), and the deletion of three dead `tradeView?.hide()` lines.

Deferred to **uxd3-c**: per-id `open`/`hide` thunks, `hideAllExcept`, the `refreshBattle` and
`onReconnect` collapses, routing the 12 hotkeys through `canOpen`, and the retirement of
`W-OVERLAY-FANOUT-MUTEX` / `W-HELP-FANOUT-OPENGUARDS` / `W-HELP-FANOUT-BATTLE`.

**This is a correctness cut, not a budget cut.** Per Context (2), deleting the source scan while the
guard lists remain inline leaves the repo strictly weaker than before: removing
`!dialogueView?.visible` from KeyB would then be caught by nothing. The hotkey→`canOpen` migration
and that deletion are one atomic unit. Two alternatives were evaluated and rejected: "migrate only
the hotkeys first" is *more* expensive (it needs the open+hide thunks immediately, walks into D6's
blocker, and detonates five further teeth), and "do everything, drop AC-12" trades away the only
user-visible deliverable to buy an invisible refactor with two unsolved design problems.

**AC-20 erratum.** AC-20 says the source scan "SHALL be replaced by a manifest-completeness test +
a node-level `canOpen` invariant". Read literally, uxd3-a already satisfied that clause and uxd3-b
would be free to delete. The EARS never required a **caller**. `W-OVERLAY-FANOUT-MUTEX`'s retention
is recorded here as a positive decision with the evidence above, so uxd3-c cannot delete it on the
strength of AC-20's literal wording. **A third deferral is not acceptable** — uxd3-c should be the
immediate next slice.

**What was retired, stated honestly.** 21 tests were deleted (never skipped): the twelve
per-surface `W-RN-/W-TP-/W-HELP-FANOUT-{RECONCILE,KEYDOWN,RAF,PVP}` teeth, `W-HELP-FANOUT-COUNT`,
the leaderboard exact-count parity self-check, the two `W-*-FANOUT-COUNT` floors, and uxd3-a's five
`W-MENU-FANOUT-*` anti-collapse teeth. Three qualifications the merge audit should have:

- The twelve per-surface teeth and `W-MENU-FANOUT-*` are genuinely subsumed: with no id lists left
  in the surfaces, "an id missing from surface N" is *structurally unrepresentable* — Part B pins
  the table against the imported `OVERLAY_IDS`, and `Record<OverlayId, _>` makes an omission a
  compile error. `W-MENU-FANOUT-KEYDOWN`'s nh1/ADR-0146 half was carried into Part A surface 3
  character-for-character.
- **The two COUNT floors were NOT detonated — they would have stayed green** (floors of ≥17;
  post-collapse counts are 18). Their deletion is a *deliberate removal of live coverage*, justified
  because `W-OVERLAY-FANOUT-MUTEX` (retained) is strictly stronger on the hotkey axis and the
  Escape / reconnect / battle-force-hide teeth cover the rest. Verified by replaying each floor's
  named wrong implementation against the current suite: every one still reds.
- **One genuine net loss:** the leaderboard exact-count parity self-check was this file's only exact
  *ceiling* on an overlay token, and Part C does not replace it (Part C's needle is
  `View?.visible ||`; a new guard-form `!leaderboardView?.visible &&` site is invisible to it).
  Demonstrated concretely: a hand-rolled de-Morgan `&&` sixth surface passes the whole suite.
- Also worth recording, precisely (an earlier draft of this bullet said "all four" and the verifier
  caught it): **two** of the four `*-FANOUT-PVP` teeth — `W-RN-FANOUT-PVP` and `W-TP-FANOUT-PVP` —
  sliced a bare `indexOf('anyOverlayVisible') + 1000/1200`, and the first occurrence of that
  identifier on master is the **shared predicate**, not the pvp aggregate ~1300 lines later. Those
  two were measuring the wrong region and were already vacuous before this slice. The other two were
  **not**: `W-HELP-FANOUT-PVP` anchored on the unique `const anyOverlayVisible =` and
  `W-MENU-FANOUT-PVP` used the two-endpoint bounded region, so both really did read the aggregate.
  Their coverage is not lost — surface 4's needle pins the whole collapsed statement and is the
  first assertion in this repo's history that the exempt id is `'pvpView'` (measured: dropping the
  exempt argument reds).

### D3 — Part C is a ceiling where the retired teeth were floors, with a named exemption and an honest scope limit.

`W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY-NO-HAND-ROLLED-OR-LIST` excises the named idiom
`?.visible || identity === ''` (six refresh-listener early-outs that this slice does not touch) and
then requires **zero** residual `View?.visible ||` in the whole file, with a ≥6 anti-vacuity floor
on the excised idiom. Excising by name rather than pinning a magic `6` keeps it stable as overlays
are added — a bare count would need recalibrating the day a 16th overlay gets a batch listener,
which is the recalibration burden this tooth exists to end.

**Scope limit, recorded rather than glossed:** the ceiling sees only the `||` spelling. A de-Morgan
`&&` chain, `[a, b].some(v => v?.visible)`, a `||=` accumulator, an aliased local, or a ternary
chain are all invisible to it — and the `&&` form is what all twelve hotkey guard lists already use,
so it is the shape a future author is most likely to reach for. Measured: a hand-rolled 13-term
de-Morgan sixth surface passes the entire suite. This is the same gap as the retired parity ceiling
(above); closing it generically is a uxd3-c item.

### D4 — AC-12 ships by attribute delegation, and amends ADR-0151 D2.

`#help-hint` gains `data-menu-launcher`, `pointer-events:auto`, `cursor:pointer` and
`width:max-content`; `main.ts` matches `closest('[data-menu-launcher]')` inside the **pre-existing**
document click listener — the house idiom there (`[data-shop-id]`, `[data-choice-idx]`).

Delegation over `getElementById('help-hint')` is not needle-dodging. ADR-0151 D2's guarantee is that
nothing **owns** the badge — no reference, no lifecycle, so no code path can hide, re-render or drop
it. A delegated branch acquires neither, so `W-UX1-HINT-NO-JS-OWNER` stays green **verbatim** and
that guarantee is untouched. Its new companion on the mutation axis,
`W-UXD3B-LAUNCHER-BRANCH-IS-READ-ONLY`, allow-lists the calls the branch may make (both dotted and
bare — a method-only allow-list was measured one indirection from useless) and pins
`data-menu-launcher` to exactly one binding site in `main.ts`.

**`indexShell.test.ts` H4 → H4b is a real trade and is recorded as an amendment, not a silent test
edit.** H4 forbade the badge from consuming *any* click; AC-12 makes that blanket ban unsatisfiable.
H4b instead **bounds** the surface — explicit `pointer-events:auto`, `width:max-content`, at most one
horizontal edge, and a CSS **property allow-list** — and adds the launcher-attribute pin. The
allow-list replaced a growth deny-list because the deny-list was measured unclosable: `zoom:40`,
`border:50vw solid transparent` and `scale:40` (the individual transform property, which the
`transform` shorthand needle does not match) all survived it.

**Residual, stated precisely.** Two distinct exposures. (a) Bare canvas clicks are genuinely latent —
nothing in the client handles one today; it goes live the day click-to-move ships. (b) Overlay
buttons are live *in principle*: nine overlay shells are unpositioned in-flow divs below the
viewport-tall canvas (the below-the-fold defect ADR-0151 already disclosed), so when one is shown
the page scrolls and this fixed badge floats over the bottom-left band — and the launcher branch's
unconditional `return;` swallows the click even when its guard denies. **Measured: `just e2e` is
green against this markup (44 passed / 1 skipped)**, so no shipped flow hits it; that is a
measurement, not a proof. Escape routes reserved for uxd3-c: move the badge to a corner no in-flow
shell occupies, or give those shells the `position:fixed` treatment `#help-overlay` already has.

The label was also shortened to `Press ? for help · click or M for menu`. `width:max-content`
forbids wrapping, and uxd3-a's 49-character label measures ~323px at 11px monospace, which overflows
a 320px viewport from `left:6px` and would produce a document-level horizontal scrollbar.

### D5 — Deleting the three `tradeView?.hide()` lines is safe, and the proof is two-step.

`KeyB`/`KeyI`/`KeyE` each called `tradeView?.hide()` while also guarding `!tradeView?.visible`, so
the hide only ever ran while the view was already hidden. That alone is not a proof, because
`TradeView.hide()` is **not** a pure display setter — it also clears the double-send lock `#pending`
(ADR-0107 depends on that on reconnect), the feedback text, and `#lastRenderKey`. The second step:
*hidden ∧ `#pending === true`* is unreachable, because `#pending` is set only in a click handler on
a visible view and is cleared in that handler's `.finally()`. `W-OVERLAY-FANOUT-MUTEX` credits
`tradeView` in those blocks by guard-form only (it refuses a `.hide()` as satisfying mutual exclusion
for a modal), so the deletion is invisible to it — verified green. One acknowledged cosmetic residue:
feedback text written while hidden is no longer cleared by a stray B/I/E press and survives into the
next open until the render key changes.

### D6 — AC-12's mechanism is deferred, exactly as AC-11's was.

The click gates on `anyOverlayVisible()`, not on `canOpen('menuView')`. These are **not** equivalent:
`canOpen` exempts self, so it allows when only `menuView` is visible, while `anyOverlayVisible()`
includes `menuView`. The divergence is unreachable rather than designed-around — `#menu-overlay` is
`inset:0;z-index:100` over a `z-index:50` badge, so the click never reaches the badge while the menu
is open. Routing both front doors through `canOpen` is uxd3-c, alongside the hotkeys.

### D7 — Pre-specified blocker for uxd3-c: `dialogueView` must never get a `hide` thunk.

`W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE` is a whole-file zero-count on `dialogueView?.hide` /
`dialogueView.hide` in `main.ts`, so a total `Record<OverlayId, { hide }>` **cannot compile**. The
only shape consistent with both that tooth and `NEVER_FORCE_HIDE = ['dialogueView']` is an
**optional** `hide` member with `dialogueView` as the sole omitter, pinned by a new
`OR-HANDLES-DIALOGUE-HAS-NO-HIDE`. Recorded now so uxd3-c does not rediscover it against a red suite.
uxd3-c must also re-author `W-TP-RECONNECT` on two endpoints before touching `onReconnect` — its
fixed `+1000` window has ~22 characters of headroom and fails naming *tradePropose*, not the culprit.

### D8 — The Escape-tooth re-anchoring boy-scout is deferred, with reason.

ADR-0162's A17 scheduled re-anchoring `W-RN-ESCAPE` / `W-TP-ESCAPE` / `W-HELP-ESCAPE` off their
fixed `indexOf + 2000/2500` windows here. It is dropped: ~70 lines across 4 hunks against this
loop's ~40-line / ≤3-hunk boy-scout cap, and it is atomic (retiring
`W-UXD3-ESCAPE-ANCHOR-FIRST` is only sound once all three land), so it cannot be trimmed to fit.
`W-UXD3-ESCAPE-ANCHOR-FIRST` is holding that line correctly in the meantime, and uxd3-c edits the
KeyB/I/E guard lists those teeth would re-anchor onto — so doing it there is strictly better
informed.

## Consequences

- All fifteen overlays are read through **one** table. Adding a sixteenth is a compile error in
  `overlayProbes` rather than five silent omissions, which is the class of defect ptc5c/ADR-0139
  had to repair by hand.
- **`M-postgate-overlay-registry` is still NOT retired.** uxd3-a + uxd3-b + uxd3-c together close
  it; uxd3-c is the last piece.
- The teeth are now the whole gate for an uncovered file, so they are correspondingly exact. Eight
  survivor mutations found by an adversarial pass over the shipped code were closed and each was
  re-measured red: a dead-code prefix inside `anyOverlayVisible()` (`.includes` → exact equality on
  the body); a type-only import plus a local `anyVisible` decoy (pin the value import, ban a local
  declaration — the `W-CARE-IMPORT` pattern, previously not applied here); `Reflect.set` poisoning
  the table one line past the END marker (`Readonly` is erased at runtime — whole-file ceiling of 3
  on the identifier); an appended conjunct on the reconcile gate (close-paren-bounded needle); the
  inverted deferred shop-open gate (`W-INTERACT-DEFERRED-OPEN` strengthened from presence to
  contiguous shape — the collapse made it the sixth consumer of a shared predicate); a bare-call DOM
  escape in the launcher branch; and two CSS growth knobs. Costs: raising the `overlayProbes`
  occurrence ceiling now requires adding a surface assertion to Part A in the same edit.
- The `#help-hint` badge is no longer purely decorative markup. Any future edit to its inline style
  must keep the property set inside H4b's allow-list.
