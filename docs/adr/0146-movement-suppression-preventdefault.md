# 0146 — nh1: movement-suppression must cancel the browser's native key defaults, target-aware, on both the overlay and the key-repeat return paths

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** nh1 (M-postgate-netcode-hardening — movement input responsiveness; EARS nh1-1, nh1-2)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, movement-netcode
**Decision:** Both early-return paths in the keydown handler delegate to one `main.ts`-local `suppressNativeMovementDefault(e)`, which calls `preventDefault()` for movement/Space keys unless the event target owns that key's native action.

## Context

Drew's 2026-07-25 closed playtest reported that "the controls stopped working" and the arrow
keys started scrolling the page instead of moving the character. Grounding that against live
code found a concrete defect at `client/src/main.ts:1006-1023`: the movement-suppression
branch of the single `keydown` handler tests 14 overlay `?.visible` flags and bare-`return`s
**without** calling `e.preventDefault()` — unlike every other branch in the same handler.

Why the page can scroll at all: the Pixi canvas is sized to the full viewport
(`client/src/render/world.ts` — `window.innerWidth/innerHeight`), and **10 of the 14
suppressed overlays are plain block-level `<div>` shells declared in `client/index.html`**
(dialogue, quest-log, heal, shop, trade, pvp-challenge, leaderboard, rename, tradepropose,
help) — normal document flow, no positioning. Showing one appends content *below* a
viewport-height canvas, so the document outgrows the window and the page becomes scrollable.
The reported triggers (quest log via `KeyQ`, trade via `KeyU`) are both in this set.

The other **4 overlays build their own `position: fixed; inset: 0` roots in JS** (`boxView`,
`raisingView`, `evolutionView`, `battleView`) — those are viewport-bound and scroll internally
(`overflow-y: auto`), so they do *not* grow the document and do not exhibit the bug by this
mechanism. The fix is applied uniformly at the branch rather than per-overlay: the branch
cannot cheaply know which shell is open, uniform suppression is correct for all of them
anyway, and a future overlay added as a normal-flow shell inherits the fix automatically.

`KeyW/A/S/D` have no native scroll action, so they silently no-op instead; consistent with the
report naming the arrow keys specifically.

Two facts about the surrounding code shaped the fix beyond the literal EARS text:

1. **The `e.repeat` early-out has the same defect.** `main.ts:483` (`if (e.repeat) return;`)
   fires before *any* branch and never calls `preventDefault()`. Each OS key-repeat keydown is
   an independent event with its own default action, so fixing only the non-repeat path leaves
   *holding* an arrow key under an open overlay scrolling the page on every repeat tick —
   and holding is how players actually move. A first-keydown-only fix would not have fixed the
   reported symptom.
2. **A blanket `preventDefault()` would trade this bug for a keyboard regression.** Only
   `renameView.ts` and `tradeProposeView.ts` `stopPropagation()` their focusables. Eight other
   overlays (`battleView`, `boxView`, `dialogueView`, `pvpView`, `tradeView`, `raisingView`,
   `shopView`, `evolutionView`) build native `<button>`/`<select>` elements whose keydowns
   bubble straight to this window listener — including `battleView`'s two user-facing
   `<select>`s (`bait-selector`, `cure-item-selector`). Cancelling a keydown cancels the
   element's native action regardless of which listener cancelled it, so an unconditional
   `preventDefault()` would break arrow-key selection on those `<select>`s and Space-activation
   of every focused overlay button. Today's bug is what has been masking that.

## Considered alternatives

- **A — spec-literal, unconditional within the branch:** `if (KEY_DIR[e.code] !== undefined || e.code === 'Space') e.preventDefault();`. Smallest possible diff, satisfies nh1-1 verbatim. **Rejected:** ships the confirmed keyboard regression above, and leaves held keys scrolling.
- **B — target-aware, tag-blind:** as A, but skip whenever the target is any form control (`INPUT`/`TEXTAREA`/`SELECT`/`BUTTON`/`A`/`contentEditable`). **Rejected:** a focused overlay `<button>` is the *most likely* focus state (it retains focus after a click), and buttons do not consume arrow keys — skipping them wholesale would leave the reported arrow-scroll bug unfixed in the commonest case.
- **C — extract the predicate to a shared module** (`inputGuards.ts`-style), enabling a real unit test. **Rejected for this slice:** outside the declared `touches:` set (a concurrent sibling slice may own that file); recorded as a follow-up option below.
- **D — chosen: target-aware *and* key-aware, applied at both return paths** via one local helper.

## Decision outcome

- **Chosen: D.** One non-exported `main.ts`-local pair of helpers sits next to `KEY_DIR`:
  - `targetOwnsKey(e)` — true when the target's own native handling of *this* key must be
    preserved: `INPUT`/`TEXTAREA`/`SELECT`/`contentEditable` (consume arrows *and* Space), or
    `Space` on a `BUTTON`/`A` (activation). Arrows on a button/link are **not** owned, so the
    scroll fix still applies in the common "button retains focus" state.
  - `suppressNativeMovementDefault(e)` — `preventDefault()` when the key is in `KEY_DIR` or is
    `Space`, and the target does not own it.
- Called at **both** `main.ts:483` (`e.repeat`) and the overlay-suppression branch. A single
  predicate at two call sites (rather than a copy-pasted boolean) is deliberate: this handler's
  history shows guard expressions drifting between sites once duplicated.
- **`e.repeat` is a disclosed extension of nh1-1**, not scope creep: nh1-1's intent ("arrow
  keys must not scroll the page while an overlay is open") is unreachable without it. Recorded
  here and reconciled into the spec rather than silently widened. It is defensive in the
  no-overlay case — with all overlays hidden the document has no overflow, so nothing scrolls
  today; the fix costs nothing and holds if a future layout adds overflow.
- **Consequences (positive):** the reported freeze/scroll symptom is fixed for taps *and*
  holds; keyboard operability of overlay selects/buttons is preserved (and is now pinned by a
  gate, where before it was unpinned and accidentally preserved by the bug itself).
- **Consequences (negative / disclosed):** `main.ts` is not importable under vitest (module-scope
  DOM/PIXI/wasm side effects), so nh1-2's "simulate a keydown" is satisfied by **source-scan**
  teeth in the sibling `main.wiring.test.ts`, the established pattern for this file
  (`W-RN-PREVENT`, `W-OVERLAY-FANOUT-MUTEX`). A red-team pass mutation-probed those teeth and
  they were hardened in response: they now pin the guard expression contiguously (killing both
  an `&&`-for-`||` swap and an outer negation of the whole condition — the latter passed lint,
  typecheck *and* every other tooth) and strip line **and block** comments before matching.
  **Residual, accepted:** dead-code wrappers (`if (false) { … }`, an unconditional early
  `return true` in `targetOwnsKey`) still satisfy the source scan and are caught only
  downstream by `just lint` (biome `noConstantCondition`) or `tsc`. Fully closing that needs
  alternative C or a Playwright e2e keyboard test (`client/e2e/**`) — both outside this slice's
  touch-set. Named as follow-up, not pretended away.
- **Residual — other native scroll keys (disclosed, deliberately out of scope):** `PageUp`,
  `PageDown`, `Home` and `End` also carry native page-scroll defaults and are *not* suppressed,
  so they can still scroll a normal-flow overlay's page. They are outside nh1-1's stated key set
  (`KEY_DIR` ∪ `Space`), are not part of the reported symptom, and the four `position: fixed`
  overlays legitimately scroll internally — a future slice that widens the key set should decide
  that per-overlay rather than blanket-suppressing here.
- **Residual — modifier chords (disclosed, accepted):** the helper is modifier-blind, so
  `Alt`/`Cmd`+Arrow (browser back-navigation) is now suppressed while an overlay is open. This
  makes the overlay path *consistent* with the pre-existing movement branch, which has always
  been modifier-blind and already suppressed those chords during normal play; introducing a
  modifier check on only one of the two paths would be a new inconsistency, so it is left alone.
- **Follow-up (not owed by this slice):** the eight overlays that never `stopPropagation()`
  their focusables remain asymmetric with `renameView`/`tradeProposeView`. This ADR's
  `targetOwnsKey` compensates from the window side; making the views symmetric belongs with
  `M-postgate-overlay-registry`/`uxd3`, which already owns overlay-wide input policy.
