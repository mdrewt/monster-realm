# ADR-0069 — M12b Server: NPC Entity/Wander, Dialogue/Quest Reducers, Healing

**Date:** 2026-07-03  
**Status:** Accepted  
**Deciders:** Build loop (autonomous)  
**Related:** ADR-0007 (zoned), ADR-0011 (tick), ADR-0015 (RLS), ADR-0021 (dialogue+quest system),
ADR-0056 (server-module split), ADR-0068 (M12a game-core dialogue/quest rules)

---

## Context

M12a (ADR-0068) delivered the pure game-core rule layer:
- `npc_decide` — seeded, deterministic NPC wander decision
- Dialogue evaluation (`find_entry_node`, `apply_choice`, `apply_effects`, `apply_node_auto_effects`)
- Quest rules (`can_start_quest`, `process_trigger`, `trigger_matches`)

M12b wires these rules into the SpacetimeDB server module, adding:
- NPC entities (character + npc role row) with per-zone deterministic wander
- `player_dialogue_state` (PRIVATE) + `player_quest` (public) + `player_conversation` (public) tables
- `talk` / `advance_dialogue` / `dismiss_dialogue` reducers
- Quest trigger evaluation on talk/defeat/collect events
- Real `heal_party(location_id)` replacing the M7 free placeholder
- `heal_location_row` (public content) + `heal_cooldown` (PRIVATE) tables

---

## Decisions

### Decision 1: Entity/component split for NPCs

**Decision:** An NPC is a `character` row (position, zone, sprite, move_queue) PLUS an `npc`
role row (entity_id FK, npc_id string, home, wander_radius, dialogue_tree_id).

**Rationale:**
- NPCs reuse all character movement infrastructure (apply_move, warp detection, zone routing)
- The `npc` role row is additive (ADR-0006 — no change to the `character` table)
- NPCs are distinguishable from players by the absence of a `player` row (existing guard in
  movement_tick already skips grass encounters for non-player characters)
- `npc.zone_id` is denormalized from `character.zone_id` for efficient zone-indexed NPC queries;
  the wander loop keeps them in sync on warp

**Alternatives considered:**
- Single NPC table (position + home + dialogue): rejected — would duplicate character position
  management and break the existing movement infrastructure

### Decision 2: `player_dialogue_state` is PRIVATE (ADR-0015 must-never-leak)

**Decision:** The `player_dialogue_state` table (flags, done_quests) is PRIVATE (no `public`
attribute). Only the server reads/writes it; no client can subscribe.

**Rationale:**
- Flags gate content (a flag controls which dialogue branch a player can access) — reading
  another player's flags reveals which quests/branches they haven't unlocked (minor spoiler)
- More importantly: flags gate rewards — a malicious client that can read another player's flags
  could predict/exploit the branch logic
- ADR-0015 "stakes-classified RLS" → must-never-leak data goes in private tables
- M12d (client dialogue UI) will derive needed state from `player_conversation` (PUBLIC) and
  `player_quest` (PUBLIC), not from the private flag table

**Transport RLS note:** SpacetimeDB 2.6 has no per-row transport RLS. Private tables are the
only guaranteed server-side enforcement (ADR-0015 / ADR-0040).

**Alternatives considered:**
- Public with client-side filter: rejected — another client can still subscribe and read all flags
- Private with public projection: deferred — a public "observable" projection (which quests are
  active) is already provided by `player_quest`; flags do not need a public projection

### Decision 3: `player_quest` is PUBLIC (like `inventory`)

**Decision:** The `player_quest` table (active quest step progress) is PUBLIC. Client subscribes
for the quest log UI (M12d). Owner filtering is the client's responsibility (same pattern as
`inventory`, ADR-0046; full transport RLS deferred to M16).

**Rationale:**
- Step progress (quest_id, step_index) is significantly less sensitive than flags
- The client needs this data for the quest log without a round-trip
- Consistent with the inventory precedent

### Decision 4: Dialogue trees are loaded at call-time from game-core, not stored in DB

**Decision:** `game_core::load_dialogue_trees()` is called in-process at request time. Dialogue
trees are NOT stored as SpacetimeDB rows.

**Rationale:**
- Dialogue trees contain nested, recursive types (DialogueNode, DialogueChoice, Condition, Effect)
  that would each require `SpacetimeType` derives — substantial coupling between game-core types
  and SpacetimeDB macros
- Trees are immutable content (not player state) — storing them in the DB adds write-path
  complexity for no query benefit (they're never queried by field, only by tree_id)
- The server accesses them via a direct function call — same as `load_encounters()` for encounter
  tables (established pattern, ADR-0040)
- M12c will add RON file loading for dialogue trees, replacing the hardcoded stubs

**Alternatives considered:**
- Store DialogueTree in SpacetimeDB table with JSON blob column: rejected — no SpacetimeDB JSON
  blob type; serialization complexity; unqueryable interior
- Store as nested SpacetimeType structs: rejected — requires SpacetimeType on all nested types
  (Condition, DialogueEffect, etc.), coupling game-core types to SpacetimeDB macros (ADR-0003
  requires game-core to be pure/server-agnostic)

### Decision 5: `heal_party` moves to `raising.rs` from `battle.rs`

**Decision:** The M7 placeholder `heal_party()` (free, no args) in `battle.rs` is removed. The
real `heal_party(location_id: u32)` is added to `raising.rs`.

**Rationale:**
- "Heal at a town location" is a raising/care action, not a battle action
- The M8.9 ADR-0056 module vocabulary assigns `raising.rs` to monster care and recovery
- The new signature takes a `location_id` (required parameter) — different arity, so it's a
  clean replacement, not a behavioral breaking change at the schema level
- The battle-reducer-security eval only checks the reducer NAME exists (which it does, in a
  different module); the eval passes unchanged

### Decision 6: `grant_item` ungated for production use

**Decision:** Remove the `#[cfg(feature = "dev_reducers")]` gate from `grant_item` and
`MAX_ITEM_STACK` in `inventory.rs`. The `grant_bait` DEV reducer retains its gate.

**Rationale:**
- M12b introduces the first production caller: `apply_effects_to_db` routes `GrantItem` effects
  through `grant_item` as quest rewards
- The inventory.rs comment explicitly anticipated this: "A production grant path (M12 quest /
  M13 shop / training food) will introduce a non-dev caller; drop the gate then"
- `grant_item` has always been a production-ready function (zero-qty guard, cap enforcement,
  monotone-up behavior) — the gate was only to avoid a dead-code warning

### Decision 7: NPC tick counter = `now_ms / STEP_MS` (stable across ticks)

**Decision:** The `tick` argument to `npc_decide` is computed as `now.0.unsigned_abs() / STEP_MS.unsigned_abs()`, yielding a monotone-increasing integer that increments by 1 per step.

**Rationale:**
- `npc_decide` is deterministic given `(entity_id, tick)` — using raw ms would produce
  different outputs within the same tick if clock jitter shifts the call time
- Integer division gives the same value for all calls within a 200ms STEP_MS window
- This matches the ADR-0068 spec: "seeded deterministic wander per tick"

### Decision 8: `apply_node_auto_effects` is called in `talk`, before writing player_conversation

**Decision:** `apply_node_auto_effects(node, &mut state)` is called immediately after
`find_entry_node` returns `Some(node)`, before any DB write.

**Rationale:**
- ADR-0068 requires this: "M12b MUST call this immediately after find_entry_node returns
  Some(node), before displaying choices"
- Omitting this call silently discards all auto_effects (flags set on node entry, quests started)
- The proof-of-teeth for this is: a talk that has a StartQuest auto_effect MUST create a
  player_quest row even without the player making a choice

### Decision 9: game-core content type widening (NpcDef, HealLocationDef)

**Decision:** Add `NpcDef` and `HealLocationDef` structs to `game-core/src/content.rs`. Add
hardcoded `load_npc_defs()`, `load_dialogue_trees()`, `load_quest_defs()`, `load_heal_locations()`
stubs. Re-export from `game-core/src/lib.rs`.

**Rationale:**
- These types logically belong in `game-core` alongside `Species`, `ItemDef`, etc.
- M12b is declared serial (no concurrent siblings) → widening the touches set is safe
- M12c will replace the hardcoded stubs with RON file loading — the function signatures remain stable

---

## Consequences

**Positive:**
- NPCs wander deterministically; the existing movement infrastructure is reused without duplication
- Dialogue/quest logic is server-authoritative (clients can't bypass conditions or grant rewards)
- `player_dialogue_state` is PRIVATE → flags cannot be datamined by other clients
- `heal_party` now requires a real location (cost + cooldown), resolving the M7 placeholder
- `grant_item` is production-ready; the dev gate served its purpose

**Negative / risks:**
- Dialogue trees loaded at call-time from game-core: if the game-core wasm binary is large, this
  adds latency per `talk`. Acceptable for M12b; RON streaming (M12c) is the long-term path.
- NpcDef hardcoded inline: "content is data" principle is temporarily violated (M12c resolves it)
- `player_quest` is PUBLIC: all players can read all quest progress. Acceptable (same as inventory);
  full transport RLS deferred to M16.

---

## Considered alternatives

- Store dialogue trees in SpacetimeDB tables → rejected (nested SpacetimeType coupling; see Decision 4)
- Keep heal_party in battle.rs → rejected (wrong domain module; see Decision 5)
- Make player_quest PRIVATE → rejected (client can't subscribe for quest log; M12d needs it)
- Add SpacetimeType to Condition/DialogueEffect for DB storage → rejected (ADR-0003 purity; game-core must stay server-agnostic)
