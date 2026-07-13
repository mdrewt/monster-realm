# ADR-0096 — M14e: Status-Curing Items + Client Battle-Event Display

**Status:** Accepted
**Date:** 2026-07-11
**Slice:** m14e
**Supersedes:** —
**Amends:** —
**Subsystems:** battle, client-ui
**Decision:** Status-curing items: applies_status on SkillDef, cure_status on ItemDef, use_battle_item reducer with 6-guard validation; client renders active monster status badge.


**Status:** Accepted  
**Deciders:** Drew Teter  
**Date:** 2026-07-11  
**Slice:** M14e (serial after M14b + M14c + M14d)

---

## Context

M14b (ADR-0093) added `StatusEffect` persistence to `BattleMonster.status` and a
`BattleStatusStore` in-turn scratchpad. M14c (ADR-0094) added passive ability hooks.
M14d (ADR-0095) added weather field-state. M14e closes the loop by wiring:

1. **Skill-applied status** — a skill can now inflict a status condition on a hit target.
2. **Item-cured status** — a player can use an item (`use_battle_item`) to clear a status
   from their active monster during an ongoing battle.
3. **Client display** — the active monster's status badge is rendered on the battle card.

---

## Decisions

### D1 — `StatusApplied` is deferred to the FOLLOWING turn (Phase 4.5 placement)

`resolve_one_attack` emits `BattleEvent::StatusApplied { side, status }` for eligible hits.
`resolve_full_turn` applies it to `BattleStatusStore` in **Phase 4.5** — after DoT (Phase 3)
and status tick (Phase 4). Consequence: a monster poisoned on turn N does not take Poison DoT
until turn N+1. This matches established game-design convention (newly-applied status is not
punishing on the same turn as the hit) and avoids retroactive DoT that would confuse players.

### D2 — No `slot` field on `StatusApplied`

`StatusApplied` carries only `side: SideId` and `status: StatusEffect` — no slot. Rationale:
`StatusApplied` is only emitted when the target did NOT faint (`!fainted` guard in
`resolve_one_attack`). Because no auto-switch fires for a non-fainted target, `state.side_X.active`
is stable between Phase 2 (emit) and Phase 4.5 (apply), so the slot can be looked up at apply
time. Contrast with `StatusCured`, which carries an explicit slot for bench-aware cure semantics.

### D3 — Phase 1.5 store→`BattleMonster` sync in `resolve_full_turn`

`resolve_one_attack` checks `defender.status` (a `BattleMonster` field) for the "no stacking"
guard. Without an explicit sync, a status already in `BattleStatusStore` (set by Phase 4.5 of
a prior call or by a test fixture) would be invisible to the guard. Phase 1.5 syncs
`BattleMonster.status ← BattleStatusStore` before Phase 2. In normal server flow this is a
no-op (the server builds the store from `BattleMonster.status` immediately before calling
`resolve_full_turn`). In tests it ensures the guard sees the authoritative status.

### D4 — `StatusApplied` conditions: no immune, no KO, no stacking

A `StatusApplied` event is emitted only when ALL hold:
- The attack HIT (past the Miss early-return).
- The effectiveness is NOT Immune (past the Immune early-return — `Effectiveness::Immune` returns before the status block).
- The target did NOT faint from this attack (`!fainted` check).
- The target had NO existing status entering the attack (`defender.status.is_none()` from the Phase 1.5-synced BattleMonster).

### D5 — `use_battle_item` is between-turn passive (no turn advance)

Using a battle item is an out-of-turn action: it does NOT advance `turn_number`, does NOT call
`resolve_full_turn`, and does NOT trigger enemy retaliation. The player consummates their item
use between turns (e.g. after a turn ends and before choosing the next action). Guard order
(reject-not-clamp):
1. `require_owner` — owner only.
2. `outcome == Ongoing` — no items in terminal battles.
3. Load `ItemDef` from content cache — `cure_status` lives on game-core content, NOT on the
   `item_row` DB schema (consistent with `train_stat`, `sets_weather` — content fields
   not projected into DB schema by design).
4. Item must have `cure_status.is_some()` — reject non-cure items.
5. Active monster's status must match `cure_kind` — reject if no matching status (item not wasted).
6. `consume_one` — irreversible spend only after all guards pass.
7. Clear `BattleMonster.status = None` on the active slot; update battle row.

### D6 — Content shape: `applies_status` on `SkillDef`, `cure_status` on `ItemDef`

Both fields use `#[serde(default)]` (ADR-0006 — additive) and reference `StatusKind` (the
payload-free discriminant from `combat/ability.rs`, distinct from `StatusEffect` which carries
the Sleep `turns_remaining` payload). `validate_content` gains an exhaustive `match` on both
fields (no `_` wildcard) so a new `StatusKind` variant is a compile error at the validation
site — same OCP gate as the `WeatherKind` gate added in ADR-0095.

---

## Residuals

### R1 — `swap_active` drops enemy `StatusApplied` during swap-retaliation

`swap_active` calls `resolve_player_swap → resolve_enemy_turn → resolve_one_attack`. If the
wild uses a status-applying skill during its swap-retaliation, `StatusApplied` is emitted but
not collected — no `BattleStatusStore` is built, no write-back occurs. The status is silently
lost until the next `submit_attack`. This parallels the `attempt_recruit` gap for `sets_weather`
(ADR-0095 R1, marshal.rs). Deferred to M14f.

### R2 — Bench-monster status cannot be cleared mid-battle

`use_battle_item` cures only `side_a.active_monster().status`. A bench monster that accumulated
a status in a prior turn cannot have it cleared by an item — there is no item-targeting-slot
path. When the bench monster re-enters battle (on swap or after a faint), it re-enters with
the status intact. `tick_status` and `apply_post_turn_effects` operate on all store slots
(including bench), so DoT and expiry work correctly for bench slots via the store; the gap is
only in player-initiated cure paths. Deferred.

### R3 — `attempt_recruit` retaliation status gap (inherits from ADR-0095)

`resolve_recruit_failure → resolve_enemy_turn → resolve_one_attack` is the same path as R1.
Both are documented residuals from the event-discarding pattern in `attempt_recruit`. Deferred
to M14f together with R1.

---

## Content

- Skill 11 "Toxic Sting": `affinity: Dark, power: 20, accuracy: 100, applies_status: Poison`
- Item 3 "Antidote": `cure_status: Poison, sell_price: 60`
- `CONTENT_VERSION`: 9 → 10

---

## ADR next-free: 0097
