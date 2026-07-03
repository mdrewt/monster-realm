# ADR-0070 — M12c: Content RON loading for NPC/dialogue/quest/heal, NPC zone policy, RT-ADV-01 fix

**Date:** 2026-07-03
**Status:** Accepted
**Authors:** Supervisor, Claude Sonnet 4.6

## Context

M12b shipped hardcoded loaders for NPC definitions, dialogue trees, quest definitions, and heal
locations directly as Rust functions. Three gaps remained from M12b's deferred scope:

- **F5 (deferred):** NPCs could warp through warp tiles; movement.rs `apply_state` would teleport
  an NPC to another zone because `unwrap_or(false)` treated NPC characters (no player row) as
  "not in battle" and applied the warp path.
- **RT-ADV-01:** `advance_dialogue` had no zone/proximity re-check. A player who initiated dialogue,
  then walked away or warped, could still call `advance_dialogue` and receive quest/item effects.
- **Content maintainability:** Hardcoded loaders mean content changes require Rust edits, rebuilds,
  and are not auditable as data.

## Decision

### 1. RON content loading extended to NPC/dialogue/quest/heal_locations (ADR-0056 continuation)

Four new glob-loaded registries follow the `parse_parts` / `*_RON_PARTS` pattern established by
M8.9e (ADR-0056). `build.rs` generates `NPCS_RON_PARTS`, `DIALOGUE_TREES_RON_PARTS`,
`QUESTS_RON_PARTS`, `HEAL_LOCATIONS_RON_PARTS` from `content/<reg>/*.ron` files in sorted
filename order (deterministic, OS-readdir-order-independent).

Loaders return `Result<Vec<T>, String>` instead of bare `Vec<T>` — callers handle failures via
match/log/return (consistent with other registries).

### 2. validate_npc_content (12-point integrity check)

A new `validate_npc_content(npcs, dialogue_trees, quests, zones, items, heal_locations)` pure
function in `game-core/src/content.rs` (additive sibling to `validate_content` and
`validate_evolution_fusion`) enforces:

1. Unique NPC ids
2. NPC zone_id references existing zone
3. NPC dialogue_tree_id references existing tree
4. Each DialogueTree has ≥1 node AND root_node_id exists in that tree
5. Unique dialogue tree ids
6. StartQuest effects reference existing quest ids
7. Each QuestDef has ≥1 step
8. Quest Collect step item_id references existing item
9. Quest reward item_id references existing item
10. Unique heal location ids
11. Heal location zone_id references existing zone
12. Heal location cost_item_id (when Some) references existing item

`sync_content_inner` calls `validate_npc_content` **before** `seed_npc_entities_from` and
`seed_heal_locations_from`, consistent with the validate-before-write invariant established by
other registries.

### 3. NPC zone policy: NPCs skip warp tiles (F5 fix)

Changed `unwrap_or(false)` → `unwrap_or(true)` at the warp battle-guard in `movement_tick`.

Rationale: a character with no player row is an NPC. NPCs must not be warped — they have a home
zone, a home position, and a wander radius. If an NPC wanders onto a warp tile, it should stay
on that tile in its home zone (same as if it were "in battle"). The warp-source tile position is
what `apply_state` writes — the NPC ends up correctly positioned on the warp tile in the original
zone, not warped to another zone.

### 4. RT-ADV-01 fix: advance_dialogue zone + proximity re-check

`advance_dialogue` now re-checks zone membership and Manhattan proximity (≤ `TALK_RANGE`) after
loading the `player_conversation` row. If either check fails:
- The `player_conversation` row is deleted (conversation auto-dismissed)
- A `"advance_dialogue_dismissed"` JSON log event is emitted
- An Err is returned

This closes the session-persistent exploit: a player who talks, then warps or walks away, can no
longer receive dialogue effects from `advance_dialogue`.

## Consequences

- Content authors add NPCs/quests/dialogue/heal locations as `.ron` files in the appropriate
  `content/<reg>/` directory — no Rust code changes required.
- `validate_npc_content` is called at content sync time; a misconfigured content file aborts
  sync loudly before any DB writes (validate-before-write invariant).
- NPCs are permanently zone-local; warp tiles are player-only mechanics.
- `advance_dialogue` security: active conversation state is no longer exploitable across zone
  boundaries or walk-away.
