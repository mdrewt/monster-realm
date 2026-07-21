# ADR-0139 — Overlay mutual-exclusion symmetry: fix KeyB/I/E open-guards + a guard-OR-hide fan-out gate (registry parked)

**Status:** Accepted
**Date:** 2026-07-21
**Slice:** ptc5c
**Supersedes:** —
**Amends:** — (supersedes the literal "hide those overlays" wording of spec M-playtest-c.5 §2 ptc5c-1; see Decision detail)
**Subsystems:** client-ui

**Decision:** Close the overlay mutual-exclusion asymmetry in `client/src/main.ts`: the three oldest
overlay-open handlers — `KeyB` (box), `KeyI` (raising), `KeyE` (evolution) — omitted
`dialogueView`/`questLogView`/`healView` from their open-guards while every newer handler already guards
the full sibling set, so pressing B/I/E while a dialogue/quest-log/heal overlay was open stacked a second
overlay. **(1)** Add `!dialogueView?.visible && !questLogView?.visible && !healView?.visible` to those
three guards — **guard-only, not hide**. **(2)** Turn the whole bug class into a mechanically-enforced
invariant with a new source-scan gate `W-OVERLAY-FANOUT-MUTEX` that asserts every one of the **13**
overlay-open handlers accounts for every other mutual-exclusion overlay. **(3)** **Park** the open-coded-
lists→registry root-cause refactor (spec ptc5c-2) as a named post-gate slice — the gate holds the
correctness line without it.

---

## Context

Eleventh-review finding (M-playtest-c.5 §2.3, verified @ `0421f2c`): overlay mutual-exclusion was
one-directional. `KeyB` (main.ts:499), `KeyI` (:520), `KeyE` (:541) gated on
battle/shop/trade/pvp/leaderboard/rename/tradePropose/help (and hide-and-switch raising/evolution/box)
but never referenced `dialogueView`/`questLogView`/`healView` in any form — while all 9 newer handlers
(KeyQ/H/G/U/P/L/N/O + the `?` help handler) guard the full sibling set. Root cause: overlay visibility is
open-coded across ~6 sites (keydown open-guards, Escape ladder, movement-suppress, reconcile-diverge,
rAF loop, pvp aggregate) with 6–14 overlays each and no shared registry, so every new overlay requires
~15 lockstep edits and the B/I/E omission is exactly a missed edit. This is a visible UX break a solo
tester will hit at the imminent playtest gate.

The 14 mutual-exclusion overlays (SSOT, `main.ts` decls 164–184): `battleView, boxView, raisingView,
evolutionView, dialogueView, questLogView, healView, shopView, tradeView, pvpView, leaderboardView,
renameView, tradeProposeView, helpView`. `errorOverlayView` (main.ts:231, the F8 error overlay) is
NOT in the set — it is `pointer-events:none`, non-blocking, and off the movement-suppression list.

## Considered alternatives

- **A — guard-only patch, no gate.** Rejected: the review named the open-coded duplication as the *root
  cause of this very bug*, and overlays are actively proliferating (help just landed in pt-c2b). A one-off
  patch leaves the next omission undefended. Mechanical enforcement is this project's practice (ADR-0010).
- **B — full registry refactor now (spec ptc5c-2).** Rejected for THIS slice (parked, not abandoned; see
  Decision detail). The registry is a behavior-sensitive refactor on a 2085-line SERIAL `main.ts` right
  before the playtest gate.
- **C — patch + gate now, registry parked as a named post-gate slice.** **Chosen.** Directly authorized by
  spec §3 Decision B ("gate + patch now — non-negotiable; registry adopted but sequenced… a post-gate
  client-hardening slice is acceptable, the gate already holds the line").

## Decision detail

### (1) The fix — guard-only, NOT hide (a deliberate divergence from the spec's parenthetical)
Add the three modal guards to KeyB/I/E, matching the modal treatment all 9 newer handlers already give
these overlays (e.g. KeyQ guards `!dialogueView?.visible && !healView?.visible`). Guard-only is the
minimal *correct* fix: once the guard blocks the handler while dialogue/questLog/heal is visible, the
toggle body never runs, so there is nothing to hide — the modal overlay stays as-is and no second overlay
stacks. The spec's ptc5c-1 parenthetical "(and hide those overlays alongside the others they already
hide)" is **superseded here**: hiding dialogue/questLog/heal on a B/I/E press would *close an active
dialogue/quest/heal*, breaking the modal semantics those overlays enjoy under every other handler (and the
Escape ladder already closes them independently at main.ts:940/962/967). Post-fix, each of KeyB/I/E
accounts for all 13 other overlays: battleView via `shouldToggleBox(battleView?.visible ?? false)`;
raising/evolution via the existing hide-and-switch; box/trade/shop/pvp/leaderboard/rename/tradePropose/help
via the existing guards; and dialogue/questLog/heal via the new guards.

### (2) The gate — `W-OVERLAY-FANOUT-MUTEX` (the primary, non-negotiable deliverable)
A `main.wiring`-style `readFileSync` source-scan (NO `new RegExp` — Semgrep-banned; `indexOf`/`includes`/
`split` only). For each of the **13 overlay-open handlers** it slices the handler's source block and
asserts the block *accounts for* every mutual-exclusion overlay except the handler's own toggle target:

- **Roster (pinned as an explicit constant — no off-by-one):** 12 toggle-handlers with a self-overlay
  {KeyB→box, KeyI→raising, KeyE→evolution, KeyQ→questLog, KeyH→heal, KeyG→shop, KeyU→trade, KeyP→pvp,
  KeyL→leaderboard, KeyN→rename, KeyO→tradePropose, `?`→help} plus KeyT (talk) which toggles **no** overlay
  and must therefore account for **all 14**. The `?` handler uses `e.key === '?'` (not `e.code`), so it is
  NOT one of the 12 `SIBLING_KEYS` of the existing help test — it is included here explicitly so the 13th
  handler is not a permanent blind spot (red-team Finding 2 / reviewer MAJOR-3).
- **"Accounts for overlay Y" — form matters (reviewer MAJOR-1):**
  - `battleView` → the **bare token** `battleView?.visible` (covers both `!battleView?.visible` and the
    `shouldToggleBox(battleView?.visible …)` call form).
  - the three genuine hide-and-switch siblings {`boxView`,`raisingView`,`evolutionView`} → **guard OR
    hide** (`!Y?.visible` **or** `Y?.hide()`/`Y.hide()`), because KeyB/I/E legitimately hide-and-switch
    them (a "switch overlays" UX we preserve).
  - every other (modal) overlay {dialogue, questLog, heal, shop, trade, pvp, leaderboard, rename,
    tradePropose, help} → **guard-form only** (`!Y?.visible`). This is load-bearing: it forbids a future
    "consistency" edit that adds `dialogueView?.hide()` to KeyB from false-satisfying the invariant while
    reintroducing the modal-closing bug.
- **Block-slicing:** reuse the proven `W-HELP-FANOUT-OPENGUARDS` algorithm — from a handler's anchor to
  the minimum start-index of any *other* handler anchor after it. Anchors are the 12 `e.code === 'KeyX'`
  strings, the `e.key === '?'` string, and a trailing `e.code === 'Escape'` sentinel. Each anchor occurs
  exactly once; the `?` anchor (char ~36534) bounds KeyT's block before the movement-suppression block
  (char ~40954), and the Escape sentinel bounds the `?` handler's block — so no block can false-credit a
  bare `battleView?.visible ||` from the movement-suppress OR-list (red-team Finding 4, mitigated).
- **Anti-vacuity:** every anchor must be found (`>= 0`) and every sliced block non-empty; a renamed/removed
  handler fails loud rather than passing silently.

`W-HELP-FANOUT-OPENGUARDS` is **kept, not subsumed** — it pins the *specific* `!helpView?.visible`
guard-form in each of the 12 code-handlers, producing a named, targeted failure on a help-specific
regression that the general gate would report only as a generic "handler N missing overlay". The two
express different intents and are cheaply complementary.

### (3) The registry — parked as `M-postgate-overlay-registry` (Decision B, sequenced)
The open-coded lists → single overlay registry (`anyOtherVisible(except)` / `hideAll(except)`) is adopted
in principle but **not shipped here**. It is a behavior-sensitive refactor: KeyB/I/E's hybrid guard-vs-
hide-and-switch semantics would be *flattened* by a naive `anyOtherVisible()` guard (press I while box is
open would then *block* instead of switching to raising — a behavior change), and it touches ~6 sites on
the SERIAL `main.ts` immediately before the fun-hypothesis playtest. Per Decision B the gate already holds
the correctness line, so the registry becomes a code-tidiness win, not a correctness dependency. Booked as
a **named** post-gate slice `M-postgate-overlay-registry` (matching the Decision D/E naming discipline —
no floating "opportunistic" deferral). Recorded here + in the supervisor handoff for PLAN §9 post-gate
booking (PLAN.md is outside this slice's touch-set).

## Consequences

- **Positive:** the B/I/E overlay-stacking UX break is fixed, and the *entire class* (any open-handler
  omitting any sibling) is now a gated, fail-loud invariant across all 13 open-handlers — the ptc5c-1 bug
  cannot silently recur. `W-HELP-FANOUT-OPENGUARDS` retained.
- **Scope boundary (reviewer MINOR-2):** the gate covers the keydown **open-guards** — where the ptc5c-1
  bug class lives. The other overlay-list sites (Escape ladder, the 3 movement-suppression OR-blocks, the
  pvp `anyOverlayVisible` aggregate) are not covered by this gate; helpView's presence at those sites is
  already pinned by the existing `W-HELP-FANOUT-{KEYDOWN,RECONCILE,RAF,PVP}` teeth, and the parked registry
  would unify all sites behind one checked helper.
- **Known false-FAIL, not false-PASS (red-team Finding 3):** if a future refactor replaces
  `shouldToggleBox(battleView?.visible …)` with e.g. `shouldToggleBox(isBattleActive())`, the bare
  `battleView?.visible` token disappears from KeyB/I/E and the gate *false-fails* (noisy, safe) — it never
  false-passes. That is the desired failure direction (it flags that the battle-guard representation
  changed and the gate needs a one-line update).
- **Still deferred (pre-existing, not a ptc5c regression):** the ADR-0135 "known symmetric limitation" —
  `dialogueView.render(...)` auto-shows a conversation over an already-open overlay on a batch push — is a
  *different* direction (server-push, not a keypress) and is out of scope; the registry's `hideAll` is its
  systematic fix.
- Adding a future 15th overlay requires updating the handler guard **and** the gate roster constant — the
  gate makes the handler-side omission fail loud.

## Proof-of-teeth
`W-OVERLAY-FANOUT-MUTEX` fails RED on pre-fix `main.ts` with nine assertions (KeyB/KeyI/KeyE ×
dialogue/questLog/heal, guard-form absent in all three accepted forms — verified: no stray comment in
those blocks matches the precise token); goes GREEN after the three-guard fix. Anti-vacuity: anchor-found
+ non-empty-block asserts. `W-HELP-FANOUT-OPENGUARDS` stays GREEN throughout. `main.ts` is non-importable
in vitest (DOM/wasm side effects), so the behavioral proof is the source-scan — consistent with the
pt-c2b precedent (overlay mutual-exclusion proven by source-scan teeth, no e2e).
