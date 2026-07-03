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
1. `require_player(ctx)` → player must be joined
2. Look up `npc` row by `entity_id` → Err("npc not found") if absent
3. Look up player's `character` row → Err("character not found") if absent
4. Zone check: `player.character.zone_id == npc.zone_id` → Err("npc not in same zone") if not
5. Range check: `manhattan_distance(player_pos, npc_pos) <= TALK_RANGE` (TALK_RANGE = 2) → Err("too far away")
6. Enforce single-conversation: if `player_conversation` row exists for this player, reject or replace (policy: replace — a new talk supersedes old)
7. Load dialogue tree: `game_core::load_dialogue_trees()` → find by `npc_row.dialogue_tree_id` → Err if not found
8. Load player dialogue state: `load_player_dialogue_state(ctx, me)`
9. `find_entry_node(tree, &state)` → Err("no dialogue available") if None
10. `apply_node_auto_effects(node, &mut state)` — MUST call before writing state (ADR-0068)
11. Apply effects to DB: `apply_effects_to_db(ctx, me, &node.auto_effects)`
12. Write/update `player_conversation` row: `{owner_identity: me, npc_entity_id, current_node_id: node.id.clone()}`
13. Fire quest trigger: `apply_quest_trigger(ctx, me, TriggerEvent::Talked { npc_id: npc_row.npc_id.clone() })`
14. Log: `{"evt":"talk","sender":me,"npc":npc_entity_id}`
15. Return Ok(())

### `advance_dialogue(ctx, choice_idx: u32) -> Result<(), String>`
1. Look up active `player_conversation` row → Err("no active conversation")
2. Load dialogue tree for the NPC (same as talk step 7)
3. Find current node by `conversation.current_node_id` in tree.nodes → Err("node not found")
4. Load player dialogue state
5. **`apply_choice(node, choice_idx as usize, &state)`** — the security gate (re-checks conditions internally) → Err if InvalidChoice or ChoiceUnavailable
6. Extract server-side effects from `result.effects`
7. Apply effects to DB: `apply_effects_to_db(ctx, me, result.effects)`
8. Fire quest trigger for GrantXp/GrantItem extraction
9. If `result.next_node_id` is Some(next) → update `player_conversation.current_node_id = next`; else → delete `player_conversation` row
10. Log: `{"evt":"advance_dialogue","sender":me,"choice":choice_idx}`

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
9. Update cooldown: upsert `heal_cooldown` row with `last_heal_at_ms = now_ms`
10. Log: `{"evt":"heal_party","sender":me,"location":location_id}`

**Pure seam:** `evaluate_heal(last_heal_at_ms: i64, now: i64, cooldown_ms: i64) -> Result<(), String>` — testable without DB; just checks cooldown.

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
    let input = MoveInput { direction: dir, stop_after: true };
    let next_state = apply_move(&char_state(&ch), input, &map, now);
    apply_state(&mut ch, &next_state);
    // Sync npc.zone_id if character crossed a warp
    if ch.zone_id != npc_row.zone_id {
        let updated_npc = Npc { zone_id: ch.zone_id, ..npc_row };
        ctx.db.npc().entity_id().update(updated_npc);
    }
    ctx.db.character().entity_id().update(ch);
    // No grass encounter for NPCs (no player row → already handled by the player-loop guard)
}
```

**Anti-pattern note:** NPCs do NOT use move_queue; wander is applied directly by the tick. The existing player-loop `move_queue.is_empty()` guard correctly skips NPCs (their queue is always empty).

---

## 8. inventory.rs ungating

M12b introduces the first production `grant_item` caller (quest rewards via `apply_effects_to_db`). Drop the `dev_reducers` feature gate from:
- `MAX_ITEM_STACK` constant
- `grant_item` function (and its `Inventory` / `Table` imports)

Keep the gate on `grant_bait` REDUCER (the dev-only reducer, not the helper).

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
- `T-ADV-01`: advance_dialogue applies effects + moves to next_node
- `T-ADV-02`: advance_dialogue deletes player_conversation on end (next_node = None)
- `T-ADV-03`: advance_dialogue REJECTS choice with unmet conditions (proof-of-teeth: `apply_choice` internal gate)
- `T-ADV-04`: advance_dialogue rejects when no active conversation
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
- `POT-9`: `require_owner` absent from talk → MUST FAIL (spoofed identity test)

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
