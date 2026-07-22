# Monster Realm M14e: Status-Curing Items + Client Battle-Event Display

**Slice:** M14e (serial: M14b + M14c + M14d)  
**ADR:** ADR-0096  
**PR:** #TBD  
**Status:** DONE

## StatusApplied Event

- **Definition:** `BattleEvent::StatusApplied { side: SideId, status: StatusEffect }` (no slot field)
- **Phase placement:** 4.5 (after DoT Phase 3 and status tick Phase 4)
- **Invariant:** Active slot is stable between emit (Phase 2 during `resolve_one_attack`) and apply (Phase 4.5 during `resolve_full_turn`) because no auto-switch fires for non-fainted targets
- **Conditions for emission:** Hit + NOT Immune + target NOT fainted + no existing status on target
- **Rationale:** Newly-applied status does not punish on same turn; lookup slot at apply-time rather than carry it in event

## Phase 1.5 Store→BattleMonster Sync

- `resolve_full_turn` syncs `BattleMonster.status ← BattleStatusStore` before Phase 2
- **Server flow:** No-op (store built from `BattleMonster.status` immediately before call)
- **Test flow:** Ensures guard sees authoritative status set by prior fixture or Phase 4.5 prior-turn apply
- **Rationale:** Visibility into "no stacking" guard in `resolve_one_attack`

## use_battle_item Reducer (6-Guard Ladder)

1. `require_owner` — ownership guard
2. `outcome == Ongoing` — no items in terminal battles
3. Load `ItemDef` from content cache — `cure_status` is game-core content (not DB schema), like `train_stat` and `sets_weather`
4. Item must have `cure_status.is_some()` — reject non-cure items
5. Active monster's status matches `cure_kind` — reject if no matching status (item not wasted)
6. `consume_one` — irreversible spend only after all guards pass
7. Clear `BattleMonster.status = None` on active slot; update battle row

- **Between-turn action:** No turn advance, no `resolve_full_turn`, no enemy retaliation
- **Reject-not-clamp:** All guards reject early; no partial application

## Single-Role Item Invariant (RT-CV-01 Fix)

- Item carries exactly one curative role: `cure_status` is `Option<StatusKind>` (no dual cure + effect payload)
- Contrast with `WeatherKind` + `FieldState` system (ADR-0095), which separates kind (enum) from state (data)

## Content Tick Slot (RT-BS-01)

- `tick_status` bench-slot tick is intentional behavior (not a bug)
- Bench monsters' DoT and expiry ticks via store before active-monster apply
- Cure path operates on active-monster-only; bench-cure gap deferred (R2)

## Residuals

- **R1** — `swap_active` drops enemy `StatusApplied` during swap-retaliation (no store built in that path; deferred M14f)
- **R2** — Bench-monster status cannot be cleared mid-battle (no item-targeting-slot path; deferred)
- **R3** — `attempt_recruit` retaliation status gap (same event-discard pattern as R1; deferred M14f together)

## Content Additions

| Type | ID | Name | Key field(s) |
|------|----|----|---|
| Skill | 11 | Toxic Sting | `affinity: Dark, power: 20, accuracy: 100, applies_status: Poison` |
| Item | 3 | Antidote | `cure_status: Poison, sell_price: 60` |

- **CONTENT_VERSION:** 9 → 10

## Client

- Status badge renders on active monster's battle card (uses `BattleMonster.status`)
- No new ADR (display-only, follows ADR-0014 pure-core/shell split)

## ADR next-free

0097
