# 0164 — Overlay registry write substrate and `canOpen` migration

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** uxd3-c (M-postgate-ux-design — unified overlay IA)
**Supersedes:** —
**Amends:** 0162, 0163
**Subsystems:** client-ui
**Decision:** Overlay write substrate: `visibleIds()`/`OverlayHandles` (optional thunks; `dialogueView` guarded); 12 hotkeys routed to `canOpen`; retire 4 guard-scan teeth; unify AC-12; decline `onReconnect`; defer Escape re-anchor.

## Context

uxd3-a (`ADR-0162`) shipped the pure `canOpen` modality core. uxd3-b (`ADR-0163`) collapsed the five `main.ts` fan-out OR-lists onto one probe table read via `anyVisible()`, but deferred both the write-substrate export and the hotkey handler migration to `canOpen` verdicts because the deletion of the old source-scan gate would leave the repo strictly weaker: removing `!dialogueView?.visible` from KeyB would then be caught by nothing. That atomic unit lands here.

Two measurements matter. **(1) The probes are measured reprobes.** `main.ts` builds `overlayProbes` at module scope while all fifteen view bindings are still `undefined` (lines 249–267 vs the probes declared at 197–219), so a cached `visibleIds` would be permanently empty and mutual exclusion would never engage. (2) The hotkey handlers are measured to be correct today.** The twelve guard lists exactly match the blockers `canOpen` would return (verified by red-team re-implementation and by the fact that `canOpen` has had zero production callers until this slice — it therefore had no opportunity to diverge).

## Decision detail

### D1 — The write-substrate API, with YAGNI justification per export

`ui/overlayRegistry.ts` gains:

```ts
export function visibleIds(probes: OverlayProbes): readonly OverlayId[] {
  return OVERLAY_IDS.filter((id) => probes[id]());
}

export type OverlayHandles = Readonly<Record<OverlayId, (() => void) | undefined>>;
```

**`visibleIds` reverses ADR-0162 A7's deletion, explicitly recorded as YAGNI working as designed, not churn.** A7 deleted `visibleIds()` for zero consumers; it now has two production callers here — `overlayVerdict()` in main.ts (feeds all eleven `canOpen` sites) and `refreshBattle`'s force-hide loop — plus one for the `visibleIds` reprobe invariant test. The reversal is clean.

**`OverlayHandles` ships as a bare optional-thunk table, not a wrapped object.** The brief asked for `OverlayHandle` and `open` thunks. We shipped less. `open` thunks have zero consumers: every open path is already a named `openX()` (`main.ts:308–352`, `openMenu:413`) called directly by its handler; `activateMenuLeaf` (`:421–469`) dispatches through an exhaustive switch whose compiler-flag ADR-0161 depends on; nothing iterates ids to *open*. `hideAllExcept` has zero consumers here (main.ts consumes the existing pure `hideAllExceptPlan`; KeyB/I/E consume `verdict.forceHide`). This is the same call A7 made when it deleted `OverlayProbes`'s wrapper — shipping only what is called, adding the rest in the slice that calls it. **Deviation from the brief is flagged prominently in the PR body.**

**DO NOT SHIP:** `isVisible(id)`, `anyVisibleExcept`, `canOpenNow` (all unchanged from D1's call). `open` thunks and `hideAllExcept` (zero consumers, A7 precedent). `OverlayOpeners` type (unnecessary once open thunks are cut).

### D2 — `dialogueView` cannot be force-hidden: the type-check–runtime division of labour

`main.ts` must contain zero `dialogueView?.hide` / `dialogueView.hide` occurrences (`W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE`, ADR-0162 AC-9), because a client-side hide strands the server `player_conversation` row — the hide must not exist to be called. A total `Record<OverlayId, { hide: () => void }>` therefore cannot compile in this codebase.

**The type check is the load-bearing half; the runtime half is guarded by a second tooth.** `OverlayHandles = Readonly<Record<OverlayId, (() => void) | undefined>>` makes `hide` optional, so the table compiles only if `dialogueView: undefined` — the type system enforces it. `Partial<Record<OverlayId, _>>` would let ANY id go missing, defeating the type check, and `@ts-expect-error` appears **zero times** in `client/src` and is not house style. Such a loosening is caught instead by `W-UXD3C-HANDLE-TABLE`, a bidirectional per-id loop that asserts all fourteen non-dialogue ids carry `function` thunks and dialogueView carries `undefined`. State this division of labour; do not claim the runtime tooth closes the type-check gap.

### D3 — Four scan teeth retired; two reconnect hazards retired

All genuinely RED on the migrated source (red-team ran the full migration and captured receipts):
- **`W-OVERLAY-FANOUT-MUTEX`** (`:1415`) — claimed each handler accounts for all 14 siblings. Post-migration each handler asks `canOpen(<own id>)`, and the 15×15 decision table is proven by execution in five `OR-CANOPEN-*` tests (subsumes both the old tooth's guard-form claim and the tier-assignment claim). Replacement is stronger: strips comments (old tooth read RAW source; a rationale comment containing `!dialogueView?.visible` satisfied it) and pins contiguous shapes instead of inline positions.
- **`W-HELP-FANOUT-OPENGUARDS`** (`:1194`) — `helpView ∈ OVERLAY_IDS` with tier `GUARD_ONLY`, so `canOpen(x, V)` denies for every `x ≠ helpView` when help is visible. Structural, proven by the tier table (`OR-TIERS-PARTITION`).
- **`W-HELP-FANOUT-BATTLE`** (`:1121`) — `helpView` is member #1 of `BATTLE_FORCE_HIDE`, which now DRIVES the loop in `refreshBattle` (measured by `OR-FORCEHIDE-EXACT`). If E17 is cut, this tooth STAYS.
- **`W-TP-FANOUT-KEYN-GUARD`** (`:928`) — asserted KeyN's block names `tradeProposeView`. Post-migration KeyN asks `canOpen('renameView', …)`, which denies over `tradeProposeView` (GUARD_ONLY). No coverage lost.
- **`W-RECONNECT-HIDES-MENU` clause 2b** (`:4470–4480`) — existed to re-state `W-TP-RECONNECT`'s fixed `+1000` window so an over-long insertion fails with the real cause. Retired once H1 is re-anchored to two endpoints (no fixed window left to protect).

**One genuine net loss.** The guard-form-vs-`.hide()` distinction for modals is no longer stated in `main.ts` and now lives only in the tier table. A future author reading KeyB sees `overlayVerdict('boxView')` and cannot see that dialogue is *guarded*, not dismissed — the distinction between "denies over it" and "force-hides it". Mitigated by an added comment on the E5 handler, not a tooth.

### D4 — AC-12 click front door unification, closing ADR-0163 D6

The AC-12 click branch moved from `!anyOverlayVisible()` to `overlayVerdict('menuView').kind === 'allow'`, the same predicate KeyM uses. Both predicates now route through `canOpen`.

**Reachability measured.** `#menu-overlay` is `position:fixed;inset:0;z-index:100` (`client/index.html:97`), `#help-hint` is `z-index:50` (`:123`), they are sibling direct children of `<body>` with no transformed ancestor, and `MenuView.show()/.hide()` toggle only `style.display` — so while the menu is visible a click lands on the overlay and `closest('[data-menu-launcher]')` cannot resolve to the badge.

**One behavioural difference.** `canOpen` exempts self, so with *only* `menuView` visible the click branch would now `openMenu()` (resetting `menuState` to `MENU_INITIAL`) where it previously dead-clicked. The measurement above proves it unreachable; routing both front doors through the same predicate closes ADR-0163 D6's forward commitment.

### D5 — The `onReconnect` collapse is DECLINED, not deferred

Collapsing `:2384–2426` through the write substrate requires a `RECONNECT_HIDE` manifest — precisely the constant ADR-0162 A15 deleted — and costs four teeth for six lines:
- `W-RECONNECT-HIDES-MENU` names this refactor as **WRONG IMPL KILLED (3)** in its own comment.
- `W-HELP-NO-RECONNECT-HIDE` loses its positive control AND becomes structurally blind: with a manifest-driven loop, `helpView?.hide` would never appear in the region even if `helpView` were added to the manifest — ADR-0135 PTC2B-9's asymmetry would become unguarded.
- `W-RN-FANOUT-RECONNECT` and `W-TP-RECONNECT` both die.
- Seven per-site rationale comments (the `#pending` double-send lock, ADR-0107's reconnect dependency, the stale-draft guard) are erased.

**D7's mandatory half — re-authoring `W-TP-RECONNECT` on two endpoints — WAS done** (it and `W-RN-FANOUT-RECONNECT` now slice `onReconnect:` → `indexOf('onOwnWarp', …)` and assert the `?.hide()` call form). "Before touching `onReconnect`" is conditional; we decline the touch with reasons, recorded here so uxd3-d does not re-litigate.

### D6 — The ADR-0163 D3 de-Morgan `&&` landmine, CLOSED

`W-UXD3C-NO-DEMORGAN-FANOUT` is a whole-file zero-count on `?.visible &&`, over the comment-stripped, whitespace-squashed source. Both candidate needles were measured on the migrated tree: the looser `?.visible && !` goes **148 → 0**, the stricter `?.visible &&` goes **151 → 0**. The stricter form shipped, because it additionally kills a single-term guard like `!x?.visible && identity !== ''` — which `&& !` structurally cannot see, there being no second negated term for the `!` to glue onto, and which is exactly how a fan-out grows back one overlay at a time beside a `canOpen` verdict.

**Honest residual.** Together with Part C's `View?.visible ||` ceiling this closes both the `||` and de-Morgan `&&` spellings ADR-0163 D3 named as most likely. It still does NOT see `[a,b].some(v => v?.visible)`, a `||=` accumulator, an aliased local, or a ternary chain. Claim that and no more.

### D7 — Escape re-anchoring boy-scout DEFERRED A THIRD TIME, explicitly

Re-measured at **~73 changed lines across 4 hunks** against this loop's ~40-line / ≤3-hunk cap. It is **atomic** (retiring `W-UXD3-ESCAPE-ANCHOR-FIRST` is only sound once all three land), so it cannot be trimmed, and **will not be hunk-split to dodge the cap.**

**New mitigating fact:** post-migration, KeyB/I/E no longer contain the `renameView`/`tradeProposeView`/`helpView` tokens, so a mis-anchored `+2000/+2500` window now fails **LOUDLY** instead of staying falsely green forever. The hazard is materially reduced, not eliminated. Parked as **uxd3-d**.

### D8 — `client/src/inputGuards.ts` is orphaned but deliberately untouched

`shouldToggleBox` has zero production callers after the migration; E2 deletes only the import line in `main.ts` (required — `noUnusedImports` would fail). The file is outside this slice's declared `touches:` set, so it stays dead-but-tested and green (own unit test passes; 1-line fn at 100% branch coverage from that test). Disclosed as a follow-up flag.

## Consequences

- All twelve hotkey handlers and the AC-12 click gate now demand `canOpen`'s verdict on their target overlay. The gate is uniform: no more hand-maintained divergence, and adding a sixteenth overlay is a compile error in the mutual-exclusion manifests rather than a silent omission in any handler.
- **`M-postgate-overlay-registry` is now CLOSED by uxd3-a + uxd3-b + uxd3-c.** All three milestones of the original parked work have shipped.
- The teeth are now the whole gate for an uncovered file (`main.ts`), so they are correspondingly exact. An adversarial pass over the SHIPPED code found two CI-green survivors; both were closed and each mutation was re-measured RED.
  1. **The `dialogueView` alias bypass — a genuinely novel technique, and the more serious of the two.** `W-ESCAPE-DIALOGUE-NEVER-BARE-HIDE` is a whole-file substring count of `dialogueView?.hide` / `dialogueView.hide`, and one line of indirection defeats it entirely: `const dialogueHandle = dialogueView; dialogueHandle?.hide();` — placed in the per-frame render loop, so it hid a live conversation *every frame* — made neither literal appear anywhere, left both counts at 0, and passed the full 1742-test suite with `tsc` clean. That is the ptc5c/ADR-0139 desync shipping under a green gate. The hole **predates this slice** (it has existed since uxd3-a authored the tooth), but uxd3-c owns the never-hide invariant, so it closes it here: an **enumerated whole-file ceiling** on the `dialogueView` identifier itself, listing all nine legitimate occurrences with their exact counts. Any new use — alias or otherwise, by any spelling — pushes the total past the ceiling and reds.
  2. **The `OverlayHandles` `Partial<>` loosening.** `OR-HANDLES-DIALOGUE-HAS-NO-HIDE` states in its own comment that its runtime half cannot see this, and nominates `W-UXD3C-HANDLE-TABLE` to catch it — but as first written that tooth read only `main.ts`'s literal, which the loosening does not touch. Rewriting the alias to `Partial<Readonly<Record<OverlayId, () => void>>>` therefore type-checked and kept the whole suite green while silently erasing the totality guarantee (with `Partial<>`, *any* id may go missing, not just the one `NEVER_FORCE_HIDE` member, so a sixteenth overlay stops being a compile error). Closed with an exact-shape pin on the declaration line in `ui/overlayRegistry.ts` itself.
- The enumerated `dialogueView` ceiling imposes a real cost: any new use of that binding now requires a deliberate edit to both the enumeration and the ceiling, together. That is the same recalibration tradeoff ADR-0163's consequences recorded for the `overlayProbes` ceiling, accepted for the same reason — it forces the review conversation the invariant deserves. **Honest scope:** it bounds *uses of the binding*, not reachability; a hide performed through `document.getElementById('dialogue-overlay')` or through a `DialogueView` instance obtained some other way is outside it entirely.
- Four layers of teeth are now mutually constraining on the same region boundaries: `OR-VISIBLEIDS-*` (reprobe + domain completeness), `OR-HANDLES-DIALOGUE-HAS-NO-HIDE` (optional member shape), `W-UXD3C-HANDLE-TABLE` (per-id contiguous literal), and `W-UXD3C-OPENGUARDS-ROUTE-THROUGH-CANOPEN` (handler block exact equality). Costs: raising the `overlayProbes` or `overlayHandles` occurrence ceiling now requires adding a surface assertion to Part A in the same edit.
