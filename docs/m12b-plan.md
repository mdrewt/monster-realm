# M12b — Server NPC/Dialogue/Quest/Healing (build plan)

**Slice:** M12b · **Branch:** feat/m12b-server-npc-dialogue-quest  
**ADR reserved:** 0069  
**Preceding:** M12a (dcef9e6) — pure game-core rule module (npc_decide, dialogue eval, quest rules)  
**Following:** M12c (RON content loading), M12d (client dialogue/quest UI)

---

## 1. Scope

### Touches set (widened from brief — M12b is serial, no concurrent siblings)

| Path | Change |
|------|--------|
| `server-module/src/schema.rs` | additive: 6 new tables |
| `server-module/src/npc.rs` | NEW: talk/advance_dialogue/dismiss_dialogue reducers + helpers |
| `server-module/src/npc_tests.rs` | NEW: tests for all M12b reducers |
| `server-module/src/raising.rs` | add heal_party(location_id) reducer + evaluate_heal seam; REMOVE placeholder |
| `server-module/src/raising_tests.rs` | add heal_party tests |
| `server-module/src/movement.rs` | additive: NPC wander loop in movement_tick |
| `server-module/src/content.rs` | additive: seed NPC entities + heal locations |
| `server-module/src/inventory.rs` | ungating grant_item (first production caller = quest rewards) |
| `server-module/src/battle.rs` | REMOVE placeholder heal_party (superseded by raising.rs) |
| `server-module/src/lib.rs` | add `mod npc;`; bump CONTENT_VERSION 3→4 |
| `game-core/src/content.rs` | additive: NpcDef, HealLocationDef structs + hardcoded load fns |
| `game-core/src/lib.rs` | additive: re-export new types |
| `client/src/module_bindings/**` | regenerated (bindings-drift=0) |
| `evals/baselines/table-schemas.json` | refresh after schema additions |
| `evals/npc-dialogue-quest-security.eval.mjs` | NEW: security proof-of-teeth |
| `docs/m12b-plan.md` | this file |
| `docs/adr/0069-npc-dialogue-quest-server.md` | ADR |
| `ARCHITECTURE.md` | minimal targeted addition |

**Widening justification:** `game-core/src/content.rs` and `game-core/src/lib.rs` need `NpcDef` and `HealLocationDef` content type structs. These types naturally belong in `game-core` alongside `Species`, `ItemDef`, etc. The changes are additive-only. M12b is declared serial (no concurrent siblings), so widening is safe. M12c will replace the hardcoded `load_npc_defs()` / `load_heal_locations()` with RON-file loading.

---

## 2. New tables (schema.rs, additive ADR-0006)

### `npc` (public) — NPC entity role row
Entity/component split: an NPC is a `character` row + this role row.

```rust
#[spacetimedb::table(name = npc, public)]
pub struct Npc {
    #[primary_key]
    pub entity_id: u64,       // FK → character.entity_id
    pub npc_id: String,       // content-system id (used by quest StepTrigger::Talk)
    #[index(btree)]
    pub zone_id: u32,         // mirrors character.zone_id; kept in sync on warp
    pub home_x: i32,
    pub home_y: i32,
    pub wander_radius: u8,
    pub dialogue_tree_id: String,
}
```

### `player_dialogue_state` (PRIVATE) — flags + done-quest history
PRIVATE per ADR-0015 must-never-leak: flags gate content; a client that can read another
player's flags can derive which quests/branches that player hasn't unlocked.

```rust
#[spacetimedb::table(name = player_dialogue_state)]
pub struct PlayerDialogueStateRow {
    #[primary_key]
    pub owner_identity: Identity,
    pub flags: Vec<String>,
    pub done_quests: Vec<String>,
}
```

### `player_quest` (public) — active quest step progress
Less sensitive than flags (step_index reveals progress, not flags). Client subscribes for quest log (M12d). Owner-filter is a client responsibility (no transport RLS, same pattern as `inventory`, tracked for M16).

```rust
#[spacetimedb::table(name = player_quest, public)]
pub struct PlayerQuestRow {
    #[primary_key]
    #[auto_inc]
    pub pq_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub quest_id: String,
    pub step_index: u32,
}
```

### `player_conversation` (public) — in-progress dialogue node
Public: conversation state is not secret (client subscribes to know which node to display). Single row per player (PK = owner_identity enforces at-most-one active conversation).

```rust
#[spacetimedb::table(name = player_conversation, public)]
pub struct PlayerConversation {
    #[primary_key]
    pub owner_identity: Identity,
    pub npc_entity_id: u64,
    pub current_node_id: String,
}
```

### `heal_location_row` (public) — healing location content
Content-seeded by `sync_content_inner`. Public (world-readable, like other content tables).

```rust
#[spacetimedb::table(name = heal_location_row, public)]
pub struct HealLocationRow {
    #[primary_key]
    pub location_id: u32,
    #[index(btree)]
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub cost_item_id: Option<u32>,
    pub cost_qty: u32,
    pub cooldown_ms: i64,
}
```

### `heal_cooldown` (PRIVATE) — per-player heal cooldown anchor
PRIVATE: cooldown timestamps should not be readable by other clients.

```rust
#[spacetimedb::table(name = heal_cooldown)]
pub struct HealCooldown {
    #[primary_key]
    pub owner_identity: Identity,
    pub last_heal_at_ms: i64,
}
```

---

## 3. game-core additions (additive, content.rs + lib.rs)

### NpcDef struct
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NpcDef {
    pub id: u32,
    pub npc_id: String,
    pub zone_id: u32,
    pub spawn_x: i32,
    pub spawn_y: i32,
    pub home_x: i32,
    pub home_y: i32,
    pub wander_radius: u8,
    pub dialogue_tree_id: String,
    pub sprite_id: u32,
}
```

### HealLocationDef struct
```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealLocationDef {
    pub location_id: u32,
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub cost_item_id: Option<u32>,
    pub cost_qty: u32,
    pub cooldown_ms: i64,
}
```

### Hardcoded load functions (M12b; M12c replaces with RON loading)
```rust
pub fn load_npc_defs() -> Vec<NpcDef>         // 1 NPC: "elder_oak" in zone 0
pub fn load_dialogue_trees() -> Vec<DialogueTree>  // 1 tree: "elder_oak_talk"
pub fn load_quest_defs() -> Vec<QuestDef>     // 1 quest: "quest_find_elder"
pub fn load_heal_locations() -> Vec<HealLocationDef> // 1 location in zone 0
```

Minimal content spec (hardcoded for M12b):
- NPC "elder_oak": zone 0, spawn (5,5), home (5,5), wander_radius 2, sprite_id 10
- Dialogue tree "elder_oak_talk": one node "greeting" with entry_conditions [], auto_effects [StartQuest("quest_find_elder")], one choice (no-conditions, effects [], next_node None)
- Quest "quest_find_elder": start_conditions [], one step Talk{npc_id: "elder_oak"}, reward {xp: 10, items: []}
- Heal location 1: zone 0, tile (8,3), no cost, cooldown 30_000 ms

---

## 4. Vertical implementation order

### Slice A: game-core additions (additive; prerequisite for server seeding)
1. Add `NpcDef` + `HealLocationDef` to `game-core/src/content.rs`
2. Add `load_npc_defs()`, `load_dialogue_trees()`, `load_quest_defs()`, `load_heal_locations()` (hardcoded stubs)
3. Re-export from `game-core/src/lib.rs`

### Slice B: schema additions (server-module/src/schema.rs)
1. Add all 6 tables
2. Update `use` imports in lib.rs / other modules that reference new table accessor traits

### Slice C: inventory.rs ungating
Remove `#[cfg(feature = "dev_reducers")]` from `MAX_ITEM_STACK` and `grant_item`.
Keep the gate on the `grant_bait` dev-only REDUCER (not the helper).

### Slice D: battle.rs placeholder removal
Remove the free `heal_party(ctx)` reducer from battle.rs (superseded by raising.rs).

### Slice E: content.rs seeding additions
Add `seed_npc_entities(ctx)` and `seed_heal_locations(ctx)` helpers.
Call them from `sync_content_inner` after the existing seeding blocks.
Bump `CONTENT_VERSION` in lib.rs from 3 to 4.

### Slice F: npc.rs — new domain module
Reducers:
- `talk(ctx, npc_entity_id: u64)` (see §5)
- `advance_dialogue(ctx, choice_idx: u32)` (see §5)
- `dismiss_dialogue(ctx)` — deletes player_conversation row

Private helpers:
- `load_player_dialogue_state(ctx, identity) -> game_core::PlayerDialogueState` — reconstructs from `player_dialogue_state` + `player_quest` tables
- `write_player_dialogue_state(ctx, identity, state: &game_core::PlayerDialogueState)` — writes flags + done_quests back; creates row if absent
- `apply_effects_to_db(ctx, owner, effects: &[game_core::DialogueEffect])` — routes SetFlag/ClearFlag/StartQuest to `player_dialogue_state`; routes GrantXp/GrantItem to server helpers
- `apply_quest_trigger(ctx, owner, event: game_core::TriggerEvent)` — iterates active quests, calls `process_trigger`, applies advance/complete

### Slice G: raising.rs — heal_party
Add:
- `pub(crate) fn evaluate_heal(last_heal_at_ms: i64, now: i64, cooldown_ms: i64) -> Result<(), String>` pure seam
- `heal_party(ctx, location_id: u32)` reducer (see §6)
Add `#[cfg(test)] #[path = "raising_tests.rs"] mod raising_tests;` additions

### Slice H: movement.rs — NPC wander loop
After the player character loop, add NPC wander. See §7.

### Slice I: lib.rs — mod npc + CONTENT_VERSION
Add `mod npc;` to the domain module list.
Bump `CONTENT_VERSION` to 4.

---

## 5. `talk` and `advance_dialogue` reducer contracts

### `talk(ctx, npc_entity_id: u64) -> Result<(), String>`
1. `let me = ctx.sender`; `require_player(ctx)` → player must be joined
2. Look up `npc` row by `entity_id` → Err("npc not found") if absent
3. Look up player's `character` row → Err("character not found") if absent
4. **Look up NPC's `character` row** by `npc_row.entity_id` → Err("npc character not found") if absent.  
   **Use `npc_char.tile_x / npc_char.tile_y` as `npc_pos` for range check.** NEVER use `npc_row.home_x / npc_row.home_y` — those are home coordinates, not current wandered position (F7).
5. Zone check: `player_char.zone_id == npc_char.zone_id` → Err("npc not in same zone") if not  
   (use NPC's character zone, which mirrors `npc.zone_id` but is authoritative)
6. Range check: `manhattan_distance(player_pos, npc_char_pos) <= TALK_RANGE` (TALK_RANGE = 2) → Err("too far away")
7. Enforce single-conversation: if `player_conversation` row exists for `me`, replace it (new talk supersedes old)
8. Load dialogue tree: `game_core::load_dialogue_trees()` → find by `npc_row.dialogue_tree_id` → Err if not found
9. Load player dialogue state: `load_player_dialogue_state(ctx, me)`
10. `find_entry_node(tree, &state)` → Err("no dialogue available") if None
11. `apply_node_auto_effects(node, &mut state)` — MUST call before writing state (ADR-0068)
12. Apply effects to DB: `apply_effects_to_db(ctx, me, &mut state, &node.auto_effects)` — routes SetFlag/ClearFlag (updates `state` flags in-memory), StartQuest → inserts `player_quest` row, GrantItem → `grant_item`
13. Write/update `player_conversation` row: `{owner_identity: me, npc_entity_id, current_node_id: node.id.clone()}`
14. Fire quest trigger: `apply_quest_trigger(ctx, me, TriggerEvent::Talked { npc_id: npc_row.npc_id.clone() }, &mut state)`  
    `apply_quest_trigger` signature MUST accept `state: &mut PlayerDialogueState`. MUST NOT call `load_player_dialogue_state` internally — it uses the caller's in-memory state. On `QuestComplete`: updates `state.done_quests`, removes from `player_quest`, grants reward (F2).
15. **Write state to DB ONCE**: `write_player_dialogue_state(ctx, me, &state)` — persists flags (from step 11) + done_quests (from any quest completions in step 14). This is the single authoritative write for `player_dialogue_state` per reducer invocation (F2).
16. Log: `{"evt":"talk","sender":me,"npc":npc_entity_id}`
17. Return Ok(())

### `advance_dialogue(ctx, choice_idx: u32) -> Result<(), String>`
1. `let me = ctx.sender`; look up `player_conversation` SCOPED TO `me`:  
   `ctx.db.player_conversation().owner_identity().find(me)` → Err("no active conversation") if absent.  
   **NEVER look up by npc_entity_id** — the PK is `owner_identity`. Without this explicit scoping, Player A can advance Player B's open conversation (F1).
2. Load NPC row by `conversation.npc_entity_id`; load dialogue tree by `npc.dialogue_tree_id`
3. Find current node by `conversation.current_node_id` in tree.nodes → Err("node not found")
4. Load player dialogue state via `load_player_dialogue_state_full(ctx, me)`
5. **`apply_choice(node, choice_idx as usize, &state)`** — the security gate (re-checks conditions internally — NEVER bypass this) → Err if InvalidChoice or ChoiceUnavailable
6. **Mutate in-memory state**: `apply_effects(result.effects, &mut state)` — mutates flags/active_quests/done_quests in-memory; `GrantXp`/`GrantItem` are no-ops here (by design, see dialogue/rules.rs:152-153)
7. **Persist state to DB BEFORE updating player_conversation** (ordering: state write must precede conversation update to avoid inconsistency on crash): `write_player_dialogue_state(ctx, me, &state)` + `reconcile_active_quests(ctx, me, &state)` (inserts missing player_quest rows for newly-active quests from `StartQuest` effects)
8. **Extract and route server-side effects** (separately from apply_effects): iterate `result.effects`, collect owned values; for `GrantItem(item_id, qty)` → `grant_item(ctx, me, item_id, qty)`; for `GrantXp(amount)` → deferred per D-4
9. Update conversation: if `result.next_node_id` is Some(next) → update `player_conversation.current_node_id = next`; if None → delete `player_conversation` row (end of dialogue)
10. Log: `{"evt":"advance_dialogue","sender":me,"choice":choice_idx}`

**Note (C-1 fix):** Step 6-7 are the critical write-back path. If omitted, flag/StartQuest effects from choices are silently discarded and flag-gated follow-up conversations break. Step 8 routes only server-side effects (`GrantXp`/`GrantItem`) — do NOT call `apply_quest_trigger` from `advance_dialogue` (quest triggers are `TriggerEvent`-based, not effect-type-based; `GrantXp`/`GrantItem` are not `TriggerEvent` variants) (H-4/F8 fix).

**Note (F2 — state integrity):** `write_player_dialogue_state` is called EXACTLY ONCE per reducer (step 7 in advance_dialogue, step 15 in talk). `apply_quest_trigger` receives `state: &mut PlayerDialogueState` and MUST NOT re-load from DB. Two independent state loads would diverge if the first load saw stale done_quests — producing a double-start or missed completion guard.

### `dismiss_dialogue(ctx) -> Result<(), String>`
Delete `player_conversation` row for `ctx.sender`. No-op if absent (idempotent).

---

## 6. `heal_party(ctx, location_id: u32) -> Result<(), String>` contracts

Moves to `raising.rs`. Replaces the placeholder in `battle.rs`.

1. `me = ctx.sender`
2. `player` row → Err("not joined") if absent
3. Look up `heal_location_row` by `location_id` → Err("heal location not found") if absent
4. Zone check: `character.zone_id == location.zone_id` → Err("not in heal location zone")
5. In-battle check: any `battle` row for `me` with `outcome == Ongoing` → Err("cannot heal during an ongoing battle")
6. Cooldown check: look up `heal_cooldown` row; elapsed = `now_ms - last_heal_at_ms`; if elapsed < `location.cooldown_ms` → Err("heal cooldown active")
7. Cost check + consume: if `location.cost_item_id` is Some(item_id) AND `location.cost_qty > 0`:
   - Consume `cost_qty` units of `item_id` using `consume_one` (repeated `cost_qty` times or a batch consume)
   - Err("insufficient items for healing") if consume fails
8. Heal: for each party monster (filter: party_slot != PARTY_SLOT_NONE), set `current_hp = stat_hp`; dual-write monster + monster_pub
9. Update cooldown: upsert `heal_cooldown` row — pattern (F10: bare `.update()` is a silent no-op on absent rows → every heal would be treated as first-use → no cooldown ever applied):
   ```rust
   if let Some(existing) = ctx.db.heal_cooldown().owner_identity().find(me) {
       ctx.db.heal_cooldown().owner_identity().update(HealCooldown { last_heal_at_ms: now_ms, ..existing });
   } else {
       ctx.db.heal_cooldown().insert(HealCooldown { owner_identity: me, last_heal_at_ms: now_ms });
   }
   ```
10. Log: `{"evt":"heal_party","sender":me,"location":location_id}`

**Pure seam:** `evaluate_heal(last_heal_at_ms: i64, now: i64, cooldown_ms: i64) -> Result<(), String>` — testable without DB; just checks cooldown.

**Content integrity (F4):** `seed_heal_locations` MUST validate: if `location.cost_item_id.is_some()` then `cost_qty >= 1`. A location with `cost_item_id=Some(x)` and `cost_qty=0` would silently bypass the consume step (heal_party step 7: `if cost_qty > 0`) and give free heals despite a nominal cost item. Log-reject and skip such rows during seeding.

---

## 7. NPC wander in movement_tick

Add AFTER the existing character processing loop (not before, to avoid mutual-move-queue interference):

```rust
// NPC wander (M12b, ADR-0069): per-tick deterministic wander
// Compute a stable tick counter from server clock (ms / STEP_MS = tick index).
let tick_counter: u64 = now.0.unsigned_abs() / STEP_MS.unsigned_abs();
let npc_entity_ids: Vec<u64> = ctx.db.npc().zone_id().filter(zone)
    .map(|n| n.entity_id).collect();
for entity_id in npc_entity_ids {
    let Some(npc_row) = ctx.db.npc().entity_id().find(entity_id) else { continue; };
    let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else { continue; };
    let current = TilePos { x: ch.tile_x, y: ch.tile_y };
    let home = TilePos { x: npc_row.home_x, y: npc_row.home_y };
    let Some(dir) = npc_decide(current, home, npc_row.wander_radius, entity_id, tick_counter)
    else { continue; };
    // MoveInput is an enum: Step(Direction) | Jump  (NOT a struct)
    let next_state = apply_move(&char_state(&ch), MoveInput::Step(dir), &map, now);
    apply_state(&mut ch, &next_state);
    // NOTE (F5): apply_state writes ONLY pos/facing/action/move_started_at — NOT zone_id.
    // NPC zone crossings (warp tiles) are NOT handled in M12b; NPCs are confined to their
    // spawn zone. A zone-sync + warp-handling block (mirroring movement.rs:200-229) is
    // a named deferral to M12c. DO NOT add `if ch.zone_id != npc_row.zone_id { ... }` —
    // it would be dead code that never fires (apply_state cannot change zone_id).
    ctx.db.character().entity_id().update(ch);
    // No grass encounter for NPCs (no player row → already handled by the player-loop guard)
}
```

**Anti-pattern note:** NPCs do NOT use move_queue; wander is applied directly by the tick. The existing player-loop `move_queue.is_empty()` guard correctly skips NPCs (their queue is always empty).

**Deferral — NPC zone crossings (F5):** `apply_state` in marshal.rs only writes `tile_x/tile_y/facing/action/move_started_at` — it does NOT write `zone_id`. If an NPC steps onto a warp tile, the warp is NOT followed in M12b (the NPC stays at the warp tile position in the same zone, effectively bouncing next tick). Full NPC zone-crossing support requires replicating the warp-detection block from the player loop (movement.rs:200-229) and is deferred to M12c.

---

## 8. inventory.rs ungating

M12b introduces the first production `grant_item` caller (quest rewards via `apply_effects_to_db`). Drop the `#[cfg(feature = "dev_reducers")]` attribute from **all four** items in the gated block (F6 — dropping only the function/constant while leaving the imports gated causes `unresolved import` compile errors on non-dev builds, which `-D warnings` promotes to E0):
1. `use crate::schema::Inventory` (import)
2. `use spacetimedb::Table` (trait import)
3. `MAX_ITEM_STACK` constant
4. `grant_item` function

Keep the gate ONLY on the `grant_bait` REDUCER (the dev-only reducer, not the helper).

---

## 9. Cross-boundary contracts

| Contract | Table/Type | Producer | Consumer |
|----------|-----------|----------|---------|
| `npc.entity_id` → `character.entity_id` | FK (logical) | `seed_npc_entities` (sync_content) | movement_tick wander loop, talk reducer |
| `npc.npc_id` | String | NPC content (game-core) | quest trigger StepTrigger::Talk |
| `player_dialogue_state` | PRIVATE table | npc.rs (talk/advance) | npc.rs (load_player_dialogue_state) |
| `player_quest` | PUBLIC table | npc.rs (quest start/advance) | client M12d (quest log subscription) |
| `player_conversation` | PUBLIC table | npc.rs (talk/advance) | client M12d (dialogue display) |
| `heal_location_row` | PUBLIC content | content.rs seeding | heal_party reducer |
| `heal_cooldown` | PRIVATE | raising.rs heal_party | raising.rs heal_party (read on entry) |
| `game_core::load_dialogue_trees()` | in-memory | game-core content | npc.rs (talk, advance_dialogue) |
| `game_core::load_quest_defs()` | in-memory | game-core content | npc.rs (can_start_quest, process_trigger) |
| `grant_item` (ungated) | helper | inventory.rs | npc.rs apply_effects_to_db (GrantItem) |
| CONTENT_VERSION 4 | constant | lib.rs | sync_content_inner (early-return gate) |

---

## 10. Security posture

| Threat | Mitigation |
|--------|-----------|
| Client bypass `advance_dialogue` condition check | `apply_choice` re-checks internally (security gate, ADR-0068) |
| Talk to NPC in different zone | Zone check in `talk` reducer (step 4) |
| Talk to NPC far away | Range check `manhattan_distance ≤ TALK_RANGE` (step 5) |
| Player reads another player's dialogue flags | `player_dialogue_state` is PRIVATE (no public) |
| Heal during battle | In-battle check in `heal_party` (step 5) |
| Heal cooldown bypass | `heal_cooldown` is PRIVATE + strict `<` comparison |
| Quest reward without completion | `apply_quest_trigger` only grants reward on `QuestAdvance::QuestComplete` |
| Grant item to wrong owner | `require_owner` in `talk` (player owned dialogue state); `grant_item` uses `owner: Identity` from `ctx.sender` |
| `advance_dialogue` without active conversation | `player_conversation` lookup → Err if absent |
| Player A hijacks Player B's conversation in `advance_dialogue` | Lookup MUST be `player_conversation().owner_identity().find(ctx.sender)` — PK enforces per-caller scope (F1) |
| Quest reward double-grant via stale `done_quests` | `apply_quest_trigger` receives caller's `state: &mut PlayerDialogueState`, never re-loads; `write_player_dialogue_state` called ONCE at end (F2) |
| Duplicate active quests | `can_start_quest` checks `active_quests` contains check before start |

---

## 11. Test plan (for tester agent)

### Unit tests — `server-module/src/npc_tests.rs`
- `T-NW-01`: npc_decide drives NPC in movement_tick (deterministic, same seed → same direction)
- `T-NW-02`: NPC zone_id synced when character warps (npc.zone_id updated)
- `T-TALK-01`: talk creates player_conversation row with correct node_id
- `T-TALK-02`: talk fires auto_effects (StartQuest effect → player_quest row created)
- `T-TALK-03`: talk rejects if NPC in different zone
- `T-TALK-04`: talk rejects if NPC not found
- `T-TALK-05`: talk rejects if player too far (distance > TALK_RANGE)
- `T-TALK-06`: NPC has wandered 3 tiles from home — talk rejects when player is within TALK_RANGE of NPC's HOME but NOT within TALK_RANGE of NPC's CURRENT position (F7 regression guard)
- `T-ADV-01`: advance_dialogue applies effects + moves to next_node
- `T-ADV-02`: advance_dialogue deletes player_conversation on end (next_node = None)
- `T-ADV-03`: advance_dialogue REJECTS choice with unmet conditions (proof-of-teeth: `apply_choice` internal gate)
- `T-ADV-04`: advance_dialogue rejects when no active conversation
- `T-ADV-05`: Player A calls advance_dialogue while ONLY Player B has an active `player_conversation` — Player A MUST get Err("no active conversation"), NOT apply B's conversation effects (F1 regression guard; PK-scoped lookup proof)
- `T-QUEST-01`: talk trigger advances quest step
- `T-QUEST-02`: last step → quest_id removed from player_quest, added to done_quests, reward granted
- `T-QUEST-03`: quest reward grants XP (future M13 currency deferred)

### Unit tests — `server-module/src/raising_tests.rs` additions
- `T-HEAL-01`: evaluate_heal passes when cooldown elapsed
- `T-HEAL-02`: evaluate_heal rejects when within cooldown
- `T-HEAL-03`: heal_party restores all party monster HP to stat_hp
- `T-HEAL-04`: heal_party rejects in-battle
- `T-HEAL-05`: heal_party rejects in wrong zone
- `T-HEAL-06`: heal_party rejects when cooldown active
- `T-HEAL-07`: heal_party consumes cost item when location requires one
- `T-HEAL-08`: heal_party rejects when cost item missing

### Proof-of-teeth eval — `evals/npc-dialogue-quest-security.eval.mjs`
- `POT-1`: Drop condition check in advance_dialogue → MUST FAIL T-ADV-03
- `POT-2`: Remove zone check from talk → MUST FAIL T-TALK-03
- `POT-3`: player_dialogue_state has `public` keyword → MUST FAIL (schema)
- `POT-4`: heal_cooldown has `public` keyword → MUST FAIL (schema)
- `POT-5`: Grant quest reward without QuestComplete check → MUST FAIL T-QUEST-03 (would grant on step)
- `POT-6`: heal_party has no in-battle check → MUST FAIL T-HEAL-04
- `POT-7`: heal_party has no cooldown check → MUST FAIL T-HEAL-06
- `POT-8`: advance_dialogue proceeds without checking player_conversation → MUST FAIL T-ADV-04
- `POT-9`: `advance_dialogue` looks up `player_conversation` by NPC entity_id instead of `ctx.sender` → MUST FAIL T-ADV-05 (Player A advances Player B's conversation; F1 identity guard)
- `POT-10`: NPC range check uses `npc.home_x/home_y` instead of NPC's character row pos → MUST FAIL T-TALK-06 (F7 position guard)

---

## 12. Proof-of-teeth obligations (summary)

Each gate must have a fixture that FAILS when the invariant is violated:
1. **apply_choice internal re-check** → T-ADV-03 + eval POT-1
2. **player_dialogue_state PRIVATE** → POT-3 (schema check)
3. **heal_cooldown PRIVATE** → POT-4 (schema check)
4. **no battle heal** → T-HEAL-04 + POT-6
5. **cooldown gate** → T-HEAL-06 + POT-7
6. **quest reward only on completion** → T-QUEST-02/03 + POT-5
7. **zone/range check on talk** → T-TALK-03/05 + POT-2

---

## 13. Named deferrals

| Deferred | Milestone |
|----------|-----------|
| RON dialogue/quest/NPC/heal-location content loading (load_npc_defs via RON file) | M12c |
| validate_content for dangling dialogue/quest refs, append-only id check | M12c |
| Client dialogue screen + quest log view | M12d |
| Per-owner transport RLS on player_quest (currently all-public like inventory) | M16 |
| Currency rewards in quests (QuestReward.currency) | M13 |
| Batch item consume (cost_qty > 1 requires multiple consume_one calls) | M13 |
| bait-recruit wiring via quest/talk | M12b residual (needs module_bindings) |
| NPC zone crossings (warp tile support in wander loop) | M12c — `apply_state` does not write `zone_id`; NPC warp-handling block requires replicating player loop warp logic (F5) |
| `validate_content` checks for `Collect{qty:0}` quest steps | M12c — runtime guard; gating tests (T18/T19 in m12a_gating_tests.rs) document current behaviour (F9) |
| Quest XP grant (D-4): applying GrantXp/quest reward XP requires derive-stats + dual-write monster path; defer to M12b-tail or later — seeded quest_001 reward is item-only (xp=0) | M12b-tail |

## 14. Critical implementation notes (from planner verification)

1. **`MoveInput` is an ENUM** — `MoveInput::Step(Direction)` NOT `MoveInput { direction, stop_after }`. Using the struct form is a compile error. The NPC wander loop MUST use `MoveInput::Step(dir)`.
2. **Vec↔BTreeSet marshal** — `game_core::PlayerDialogueState` uses `BTreeSet<String>` for flags/active_quests/done_quests; the `player_dialogue_state` table uses `Vec<String>`. `active_quests` is NOT stored in the table — it is DERIVED from `player_quest` rows at reconstruction time.
3. **`apply_node_auto_effects` MUST be called** — in `talk`, immediately after `find_entry_node` returns `Some(node)`, before any DB write. Omitting this silently discards all auto_effects.
4. **Content design for quest_001**: Entry node auto_effects = `[SetFlag("met_elder_oak")]` only. The choice effects = `[StartQuest("quest_001")]`. This makes `talk` → set flag and `advance_dialogue` → start quest two independently testable events.
5. **`apply_choice` is the security gate** — `advance_dialogue` MUST call `apply_choice`, never `available_choices` + direct index. `apply_choice` re-checks conditions internally (dialogue/rules.rs:104). A reducer bypassing this check is a security vulnerability.

---

## 14. Definition of done

- [ ] `just ci` green and meaningful on the worktree
- [ ] `bindings-drift = 0` (eval passes)
- [ ] Schema snapshot updated (`evals/baselines/table-schemas.json`)
- [ ] All EARS criteria tested (T-NW-*, T-TALK-*, T-ADV-*, T-QUEST-*, T-HEAL-*)
- [ ] Proof-of-teeth eval passes (POT-1 through POT-9)
- [ ] reviewer + /simplify + red-team + reducer-security-auditor + desync-guard green
- [ ] verifier confirms no gating tests weakened (no deletes/skips/xit/only)
- [ ] ADR-0069 written
- [ ] ARCHITECTURE.md M12b row added
- [ ] Conventional Commit: `feat(M12b): server NPC entity/wander + dialogue/quest reducers + heal_party`
