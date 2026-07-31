# 0162 — A pure `canOpen` modality core and a registry-backed two-level main menu

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** uxd3-a (M-postgate-ux-design — unified overlay IA)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui
**Decision:** Overlay modality moves into a pure `canOpen` reducer over a 15-member tier manifest, and a `KeyM` two-level menu makes the hotkeys discoverable; the fan-out collapse and gate retirement defer to uxd3-b.

## Context

Drew's 2026-07-25 playtest: *"I'd expect one main menu with submenus"* — the client had ~15
memorized hotkeys and no discoverable entry point. The spec (`M-postgate-ux-design.spec.md`
§uxd3) folds in the parked `M-postgate-overlay-registry`, which was never built, so this
milestone owns BOTH the registry substrate and the menu IA.

The substrate matters because overlay mutual exclusion is currently fourteen hand-maintained
guard lists in `main.ts`, enforced only by a source-scanning test. ptc5c (ADR-0139) already
had to repair one directional gap in that scheme by hand.

## Decision detail

### D1 — An explicit `canOpen` reducer, not a blind `hideAll()`

The gate is not uniform, and collapsing it would regress ADR-0139. Three tiers, taken from
the behaviour that actually shipped:

| tier | members | meaning |
|---|---|---|
| `EXCLUSIVE_TOP` | `battleView` | outranks all; force-hides exactly `BATTLE_FORCE_HIDE` |
| `HIDE_SWITCH` | `boxView`, `raisingView`, `evolutionView` | a trio sibling may replace it |
| `GUARD_ONLY` | the other 11, incl. `menuView` | deny over it, **never** force-hide it |

Force-hiding `dialogueView` would strand the server `player_conversation` row (its visibility
is store-derived; its close routes through the `dismissDialogue` reducer). `NEVER_FORCE_HIDE`
makes that unrepresentable across every target × blocker-set pair, which is strictly stronger
than narrowing `forceHide`'s element type — the EXCLUSIVE_TOP row legitimately force-hides
GUARD_ONLY ids (help/leaderboard/rename/tradePropose), so the narrow type would be unsound.

### D2 — The cut line, and why it is where it is

uxd3-a ships the pure core + the menu. **Deferred to uxd3-b:** collapsing the five `main.ts`
fan-out surfaces, migrating the hotkey handlers to registry thunks, retiring the source-scan
`W-OVERLAY-FANOUT-MUTEX`, and the click launcher.

The driver is measured, not stylistic: a **17-test cluster** (`W-RN-FANOUT-*`,
`W-TP-FANOUT-*`, `W-HELP-FANOUT-*`) source-scans those exact OR-list regions, and two of them
pin literal forms (`W-HELP-FANOUT-PVP` anchors on `const anyOverlayVisible =`;
`W-HELP-FANOUT-BATTLE` pins `if (helpView?.visible) helpView.hide()`). Collapsing the surfaces
is therefore a 17-test rewrite in a 4,200-line file for **zero** user-visible change. Adding
`menuView` additively instead costs one token per list and leaves all 17 teeth green — and
strengthens them, since their region slices now cover the menu too.

The replacement gate (manifest completeness + the `canOpen` invariant) **lands and is proven
green here**; only the deletion of the old gate defers. Running both for one slice is
add-prove-then-remove, deliberately, not a half-migration.

### D3 — `KeyM`, and no click launcher in this slice

`KeyM` was verified unbound (no `KEY_DIR`/letter/`?` collision, no browser default). Escape is
deliberately NOT overloaded to open the menu — it stays a pure close/back key.

The click launcher is **blocked, not forgotten**: the spec allows exactly one persistent corner
affordance, ux1 already shipped `#help-hint`, and `client/src/indexShell.test.ts` H4 pins that
element to `pointer-events:none`. Making it clickable requires editing a file outside this
slice's declared touch-set — a hidden dependency. `KeyM` is the spec's zero-DOM front door
precisely so this can never block. Discovery still ships: the hint's **text node** was relabelled
to `Press ? for controls & help · M for menu`, which every H-tooth on that element survives
(H2b forbids element children; H3 is a substring check for `?` and "help"; H4/H5/H6 read only
the style attribute) and which keeps `W-UX1-HINT-NO-JS-OWNER` green.

### D4 — Backpack and Journal are leaf TITLES, not categories

Drew asked that both be discoverable. Neither is a new screen: `raisingView` **is** the
inventory (`refreshRaising` feeds it `store.ownInventory`) and `questLogView` **is** the quest
log. A top-level Backpack category would be a single leaf pointing at the same overlay as
Raise — a menu promising a screen the game does not have, which is the worst possible outcome
for a discoverability surface. So the words ship as titles ("Backpack & Raising",
"Journal (Quests)") at zero cost, and Backpack splits in place if an items-only overlay lands.

### D5 — Shop and Heal are deliberately NOT menu leaves

uxd2 (ADR-0161 D5) deleted the global `KeyG`/`KeyH` on Drew's explicit instruction; both are
world-contextual and reached through Interact. A "first shop" leaf would resurrect exactly
what was removed. The spec's "Shop & Trade" category is therefore "Trade".

### D6 — Label SSOT is scoped to the key TOKEN

Leaf glyphs must appear in `helpModel`'s CONTROLS SSOT (which gains `M — Open the main menu`),
but the action prose is not pulled. This is the spec's own residual: the SSOT copy says
"a nearby player" for P and O, while availability is online-player **existence** — no reducer
has a proximity rule for challenge or trade-propose, so a distance check would grey both
leaves out permanently. `W-MENU-AVAILABILITY-SOURCES` bans `Math.abs`/`CLIENT_INTERACT_RANGE`
at that site to keep the trap shut. PvP availability is deliberately widened to
`challengeablePlayers.length > 0 || incoming !== null` — answering an incoming challenge is
also a valid reason for the leaf to be live.

### D7 — One open path per overlay (the duplication was designed out, not time-boxed)

The plan initially accepted ~40–70 duplicated lines in `activateMenuLeaf`, on the argument that
extracting the open bodies would break `W-OVERLAY-FANOUT-MUTEX`. That is true **only** for
KeyB/I/E, whose `.hide()` calls are their block's sole gate credit for the trio. The seven
non-trio handlers carry no sibling `.hide()`, so their else-arms extracted cleanly into
`openQuestLog/openTrade/openPvp/openLeaderboard/openRename/openPropose/openHelp`. The trio
arms need no hides at all from the menu route: `menuView` is GUARD_ONLY, so `canOpen` denies
the menu over any trio member and none can be visible at activation time.

`held.clear()` stayed in the KeyN/KeyO **handlers**, not the extracted bodies — it belongs to
the keypress, and the menu route provably cannot leave a key held (KeyM clears, and movement
is suppressed while the menu is visible).

### D8 — `interactAtNearest()` extraction re-anchored two uxd2 gating tests

The Interact leaf must not duplicate `switch (target.kind)`; that switch is the single site a
4th `NpcInteraction` variant compiler-flags (ADR-0161). So the dispatch body moved into
`interactAtNearest()`, called by both the hotkey and the menu. This moved it out of the region
`W-INTERACT-KEYT-DISPATCH` and `W-INTERACT-KEYT-SWITCH` scan. Both were re-anchored onto the
function, **content unchanged**, plus a new assertion that the KeyT block still routes through
it — so an inlined second copy of the switch now fails where the old form would have passed.
Disclosed as an implementer-side gating-test edit.

### D9 — `openMenu()` is the single reset point

Four paths hide the menu without going through `menuStep` (the `KeyM` toggle-close,
`refreshBattle`, the dialogue preempt, `onReconnect`), so resetting on close would miss them.
Repro this closes: `M` → `Enter` → `M` → `M` re-opening *inside* the submenu.

### D10 — Menu nav does not key-repeat (accepted)

The `e.repeat` gate is the keydown listener's first statement, before the menu intercept, so
holding ArrowDown moves one row. Fixing it means editing nh1's (ADR-0146) block. Accepted:
the lists are ≤ 5 rows with wrap-around, and hover/click work.

## Consequences

- Modality decisions are one pure, node-testable table instead of fourteen guard lists.
- `menuView` is the 15th mutual-exclusion overlay; the manifest test fails if a 16th
  `ui/*View.ts` appears without an entry (`errorOverlayView` excluded by name).
- The manifest scan is `readdirSync` + `/View\.ts$/` and non-recursive, so the completeness
  claim is naming-convention-dependent — `ui/settings/settingsView.ts` would be invisible.
- Two gates now cover mutual exclusion simultaneously. uxd3-b removes the older one.
- `M-postgate-overlay-registry` is subsumed; it is **not** fully retired until uxd3-b lands.

## Residuals / follow-ups (flagged, deliberately not done here)

- **uxd3-b**: collapse the 5 fan-out surfaces, thunk-migrate the hotkeys, retire
  `W-OVERLAY-FANOUT-MUTEX`, ship `#menu-launcher` (that slice owns `indexShell.test.ts`), and
  delete KeyB/I/E's provably-dead `tradeView?.hide()`.
- Three teeth (`W-RN-ESCAPE` +2000, `W-TP-ESCAPE` +2500, `W-HELP-ESCAPE` +2500) use
  `indexOf("e.code === 'Escape'")` + a fixed window. `W-UXD3-ESCAPE-ANCHOR-FIRST` now guards
  the hazard; re-anchoring them on their real branches is a uxd3-b Boy-Scout item.
- `onReconnect` has ~22 characters of headroom against `W-TP-RECONNECT`'s window. The next
  insertion there will break it and the failure will name tradePropose, not the culprit.
- No test proves the menu is *visibly* rendered — happy-dom does no layout. Needs
  `client/e2e/**`, out of touch-set.
