# ADR-0135 — In-client help overlay (`?`) + tester runbook (pt-c2b)

**Status:** Accepted
**Date:** 2026-07-20
**Slice:** pt-c2b
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, movement-netcode

**Decision:** Add a display-only in-client **help overlay** — a controls (key→action) + session-goals
list opened by **`?`** (`e.key === '?'`) — plus a tester-facing **`docs/PLAYTEST.md`** onboarding
runbook. The overlay is functional-core/imperative-shell (pure `helpModel.buildHelpViewModel()` over a
typed SSOT const → fully happy-dom-covered `textContent`-only `HelpView`), joins the full overlay
mutual-exclusion fan-out in `main.ts` **exactly as its read-only siblings do**, with ONE deliberate,
justified deviation: it is **NOT hidden on `onReconnect`**. First-join auto-show and trade item-offer
rows are parked to **pt-c2c**.

---

## Context

M-playtest-c's onboarding gap: a tester who joins sees zero in-client guidance, and there is no
tester-facing doc. pt-c2 shipped the trade-propose entry point (closing H3) but explicitly parked the
help overlay + `docs/PLAYTEST.md` to pt-c2b (see ADR-0134 tail).

## Decision detail

### Help key = `?` via `e.key === '?'`
The full `e.code` keymap is taken (B/I/E/Q/H/G/U/P/L/N/O/T + WASD/arrows + Space + F8/F9); `Slash`/`?`
is unclaimed (no handler reads it, `KEY_DIR` has no `Slash`). We match on `e.key` (the produced glyph),
NOT `e.code` (physical position): movement is about physical position (WASD), but a help affordance is
about the `?` character the user intends — `e.key` is robust across keyboard layouts where `?` sits on
different physical keys. This is the **sole `e.key` branch** in an otherwise-`e.code` handler; it is
commented as such. `F1` was rejected: browsers commonly intercept `F1` for their own help (hard to
`preventDefault` reliably across engines) and it is far less discoverable than an on-screen / PLAYTEST.md
"press `?`" hint. `?` = Shift+Slash on US layouts; the resulting keydown carries `shiftKey` but collides
with nothing. The `e.repeat` early-return (main.ts) precedes the branch, so holding `?` toggles once.

### Display-only shell (simpler than rename/tradePropose)
No text input, no submit, no `#pending` lock, no callbacks (zero-arg construction, `leaderboardView`
precedent), no server reducer. The XSS-firewall discipline (`textContent` only, never `innerHTML`) is
retained even though content is static, and the view rebuilds authoritatively on each `render()`.
Content stays a typed TS const (SSOT) — NOT a RON data file (YAGNI: this is client chrome, not game
content). `held.clear()` on open is kept for consistency with sibling overlays but is not strictly
required (help does not capture focus, so a held-key's keyup still bubbles); it is not pinned by a tooth.

### The `onReconnect` asymmetry (the one deviation — load-bearing)
Every OTHER overlay is hidden in `onReconnect` (main.ts), for one of two reasons:
1. **An in-flight `#pending` reducer lock that never settles on a dropped link** (ADR-0085): rename,
   tradePropose, shop, trade. Without the hide, the submit/spend button is dead forever.
2. **Store-derived content that goes stale when the store is reset**: leaderboard is hidden *despite
   holding no lock* precisely so a stale/empty board does not linger; pvp for stale challenge state.

The help overlay has **neither** property: it holds no lock (display-only) **and** its content is a
static const, not derived from any reconnect-mutable store state. Both conditions that force every
sibling to hide are absent, so surviving a reconnect is the correct behavior — a gratuitous hide would
be a UX interruption. (Note the leaderboard contrast explicitly: "no lock" alone does NOT exempt an
overlay from the reconnect hide — *static content* is the discriminator.) This omission is pinned by a
negative source-scan tooth `W-HELP-NO-RECONNECT-HIDE` that bounds the `onReconnect` region by BOTH
endpoints (`onReconnect:` … `onOwnWarp`) and asserts it does not contain `helpView?.hide`, so a future
"consistency" edit cannot silently add one. Additionally `resetPredictionState()` already calls
`held.clear()`, so no held-movement key leaks even if help is open across a reconnect.

### Mutual exclusion — help matches its siblings exactly
Help is added to every fan-out site its read-only siblings use — 12 sibling open-guards
(`&& !helpView?.visible`), its own `?` toggle self-branch, its own Escape branch, the 3 movement-
suppression OR-blocks (reconcile-diverge, keydown, rAF held-key re-issue), the PvP `anyOverlayVisible`
aggregate, and the `refreshBattle` battle-supersession force-hide. The literal `helpView?.visible`
therefore appears **19 times** (structurally identical to `leaderboardView?.visible`, which is also 19;
tradePropose's 21 includes 2 sites help cannot have — reducer-response feedback + an Identity-guarded
self-branch — so the count-floor tooth is pegged to 19, NOT 21).

**Known symmetric limitation (deferred, NOT a pt-c2b regression):** the dialogue auto-show
(`dialogueView.render` on a `player_conversation` batch) force-shows the dialogue overlay without
hiding any sibling — so a conversation row arriving on a batch can stack over an open overlay. This
already affects rename/tradePropose/leaderboard identically; help is no worse. The systematic fix
(an overlay registry) is ptc5c (M-playtest-c.5 §3 Decision B); help matches its siblings here rather
than adding an asymmetric special-case.

### Pre-existing KeyB/KeyI/KeyE guard omission — NOT fixed here
KeyB/KeyI/KeyE currently omit `dialogue`/`questLog`/`heal` from their open-guards (a known bug owned by
ptc5c). pt-c2b adds `!helpView?.visible` to their existing (incomplete) lists but does NOT fix the
dialogue/questLog/heal omission — that is ptc5c's scope on the SERIAL `main.ts`, and touching it here
would collide.

## Parked → pt-c2c
- **First-join auto-show** ("shown once, store-flagged") — requires a NEW localStorage/persistence seam
  the client does not have today (zero localStorage in `client/src/`); needs an injected-storage seam for
  testability. `docs/PLAYTEST.md` closes the discovery gap by naming the `?` key, so auto-show is a UX
  enhancement, not gate-blocking.
- **Trade-propose item-offer rows** + counterparty monster/item selection (the counterparty side is
  RLS-impossible from the client — ADR-0015).

## Consequences
- A discoverable, layout-robust help affordance + a tester runbook — the last onboarding gap before the
  playtest gate. The e2e layer is intentionally omitted (a display-only overlay with no server round-trip
  is fully covered by unit + happy-dom + source-scan teeth; an e2e would add flake/`just eval` wasm-clobber
  surface for no distinct defect class). Mutual-exclusion correctness is enforced mechanically by the
  source-scan teeth rather than a runtime e2e.
- The `onReconnect` asymmetry is a documented, tooth-pinned deviation — the first overlay that deliberately
  survives a reconnect.
