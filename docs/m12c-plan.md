# M12c Plan — Content RON Loading + validate_content + NPC Zone Fix + RT-ADV-01

**Branch:** `feat/m12c-content-ron-loading`
**ADR:** 0070 (reserved)
**Dependencies:** M12b merged (a9f1866)

## Scope

Four coherent sub-tasks shipped as one mergeable slice:

1. **Content RON loading** — replace hardcoded `load_npc_defs()`, `load_dialogue_trees()`, `load_quest_defs()`, `load_heal_locations()` in `game-core/src/content.rs` with glob-loaded RON registries following the M8.9e pattern (`build.rs` + `content/<reg>/*.ron` dirs).
2. **`validate_npc_content`** — additive sibling to `validate_content` that catches dangling refs: NPC→dialogue_tree, dialogue_tree→quest ids (StartQuest effects), quest→items (reward + Collect step triggers), heal_location→zones; enforces unique NPC + dialogue_tree ids.
3. **NPC zone crossings (F5 fix)** — `movement.rs` warp guard: NPCs have no player row → `unwrap_or(false)` (warp them) → `unwrap_or(true)` (skip warp, stay in zone). Prevents an NPC from warping to another zone and becoming stranded outside its home radius.
4. **RT-ADV-01 within-session fix** — `advance_dialogue` re-checks zone + Manhattan proximity (≤ `TALK_RANGE`) after loading the conversation row. Walking away mid-dialogue ends the conversation and clears the `player_conversation` row. Updates `npc_tests.rs` source guard to assert the check IS present.

## Functional-core / imperative-shell split

- All parsing + validation lives in `game-core/src/content.rs` (pure, no I/O).
- `game-core/build.rs` embeds the RON files (compile-time, no runtime I/O).
- `server-module/src/content.rs` calls `validate_npc_content` from `sync_content_inner` (imperative shell — DB writes).
- `server-module/src/npc.rs` owns the RT-ADV-01 proximity re-check (imperative shell — DB reads).
- `server-module/src/movement.rs` owns the NPC warp guard (imperative shell — DB reads).

## Additive schema discipline (ADR-0006)

No schema changes — this slice is content + reducer behavior only. The 4 new RON registries live entirely in `game-core/content/` and are embedded at compile time.

## Tasks

### T1: build.rs — add 4 registries
Add `"npcs"`, `"dialogue_trees"`, `"quests"`, `"heal_locations"` to `REGISTRIES` const.

### T2: RON content files
Create `game-core/content/{npcs,dialogue_trees,quests,heal_locations}/000-core.ron` with the M12b hardcoded data verbatim-migrated to RON:

**`npcs/000-core.ron`**: elder_oak NPC def (id=1, zone_id=0, spawn/home=(5,5), wander_radius=2, dialogue_tree_id="elder_oak_talk", sprite_id=10)

**`dialogue_trees/000-core.ron`**: elder_oak_talk tree (greeting node → SetFlag("met_elder_oak"), choice "I seek a quest." → StartQuest("quest_001"))

**`quests/000-core.ron`**: quest_001 (name "Find the Elder", step Talk{npc_id:"elder_oak"})

**`heal_locations/000-core.ron`**: location_id=1, zone_id=0, tile=(8,3), cost_item_id=None, cost_qty=0, cooldown_ms=30000

### T3: content.rs — RON loaders replace hardcoded fns
For each of the 4 registries, add:
- `parse_X(ron_str: &str) -> Result<Vec<X>, String>` — parse from string
- `parse_X_parts(parts: &[(&str, &str)]) -> Result<Vec<X>, String>` — concatenating multi-file loader
- `load_X() -> Result<Vec<X>, String>` — delegates to `parse_X_parts(X_RON_PARTS)`

The hardcoded fns are REPLACED (same name, new body using RON). Return type changes from `Vec<X>` to `Result<Vec<X>, String>` for load_npc_defs / load_dialogue_trees / load_quest_defs / load_heal_locations (currently return bare Vec, callers need updating to handle Result).

Wait — check callers: `server-module/src/npc.rs` calls `load_dialogue_trees()` and `load_quest_defs()` as bare Vec returns. `server-module/src/content.rs` calls `load_npc_defs()` and `load_heal_locations()`. Callers must be updated to `?`-propagate or match the Result.

Actually the server callers already handle Err for other `load_*` calls (see content.rs pattern). Npc.rs reducers should match or unwrap with logging.

### T4: `validate_npc_content` pure fn
```rust
pub fn validate_npc_content(
    npcs: &[NpcDef],
    dialogue_trees: &[DialogueTree],
    quests: &[QuestDef],
    zones: &[ZoneDef],
    items: &[ItemDef],
) -> Result<(), String>
```

Checks (in deterministic order for proof-of-teeth isolation):
1. Unique NPC ids (u32)
2. Each NPC's `zone_id` references an existing zone (H2 from review)
3. Each NPC's `dialogue_tree_id` references an existing tree
4. Each `DialogueTree` has at least one node AND its `root_node_id` matches an existing node id (H1 from review)
5. Unique dialogue tree ids (string)
6. Each `StartQuest` effect in any tree references an existing quest id
7. Each `QuestDef` has at least one step (H4 from review)
8. Each quest's `Collect` step's `item_id` references an existing item
9. Each quest reward's `item_id` references an existing item
10. Unique heal location ids
11. Each heal location's `zone_id` references an existing zone
12. Each heal location's `cost_item_id` (when `Some(id)`) references an existing item id (RT-M12C-03)

### T5: server-module `sync_content_inner` update
After seeding NPC entities + heal locations, call `validate_npc_content` with the loaded registries. On Err: log and return (same pattern as other validators).

Also update `game_core` import in `content.rs` to include `validate_npc_content`, `load_dialogue_trees`, `load_quest_defs`.

### T6: NPC zone crossing fix (movement.rs)
In `movement_tick`, change:
```rust
.unwrap_or(false); // NPCs have no player row → treat as not in battle → warp them
```
to:
```rust
.unwrap_or(true); // NPCs have no player row → skip warp (stay in home zone, ADR-0070)
```

### T7: RT-ADV-01 fix (npc.rs)
In `advance_dialogue`, after Step 1 (load conversation row), add:

```rust
// Step 1.5 zone + proximity re-check (RT-ADV-01 fix, M12c, ADR-0070)
let Some(p) = ctx.db.player().identity().find(me) else {
    return Err("not joined".to_string());
};
let Some(player_char) = ctx.db.character().entity_id().find(p.entity_id) else {
    return Err("character not found".to_string());
};
let Some(npc_row_check) = ctx.db.npc().entity_id().find(conv.npc_entity_id) else {
    ctx.db.player_conversation().owner_identity().delete(me);
    return Err("npc not found".to_string());
};
let Some(npc_char) = ctx.db.character().entity_id().find(npc_row_check.entity_id) else {
    ctx.db.player_conversation().owner_identity().delete(me);
    return Err("npc character not found".to_string());
};
if player_char.zone_id != npc_char.zone_id {
    ctx.db.player_conversation().owner_identity().delete(me);
    return Err("no longer in same zone".to_string());
}
let dx = (i64::from(player_char.tile_x) - i64::from(npc_char.tile_x)).abs();
let dy = (i64::from(player_char.tile_y) - i64::from(npc_char.tile_y)).abs();
if dx + dy > TALK_RANGE {
    ctx.db.player_conversation().owner_identity().delete(me);
    return Err("walked too far away".to_string());
}
```

Update `npc_tests.rs` source guard: delete `advance_dialogue_source_has_no_proximity_recheck_rt_adv_01`, add `advance_dialogue_has_proximity_recheck_rt_adv_01_fixed` that asserts `zone_id` and `TALK_RANGE` ARE in the body.

### T8: ADR-0070
Document:
- Content RON pattern extended to NPC/dialogue/quest/heal_locations
- NPC zone policy: NPCs skip warp tiles (stay in home zone)
- RT-ADV-01 fix: advance_dialogue now enforces zone+proximity (conversation auto-dismissed)

### T9: Evals
Add C11 to `npc-dialogue-quest-security.eval.mjs`: `advance_dialogue` body must contain `zone_id` AND `TALK_RANGE` (the RT-ADV-01 proximity re-check is present and cannot be silently removed).

Add M12c content-integrity eval: `npc-content-integrity.eval.mjs` — checks that `validate_npc_content` in `content.rs` references all 8 integrity checks (structural source scan + proof-of-teeth that a dangling-dialogue-tree-id in a bad fixture is flagged).

## EARS criteria coverage

| Criterion | Test location |
|-----------|--------------|
| NPCs parse from RON (not hardcoded) | `content.rs` tests: `embedded_npc_defs_parse` |
| Dialogue trees parse from RON | `content.rs` tests: `embedded_dialogue_trees_parse` |
| Quest defs parse from RON | `content.rs` tests: `embedded_quest_defs_parse` |
| Heal locations parse from RON | `content.rs` tests: `embedded_heal_locations_parse` |
| validate_npc_content: unique NPC ids | `content.rs` tests: `validate_npc_teeth_dup_npc_id` |
| validate_npc_content: dangling dialogue tree | `content.rs` tests: `validate_npc_teeth_dangling_tree` |
| validate_npc_content: dangling quest in effect | `content.rs` tests: `validate_npc_teeth_dangling_quest_effect` |
| validate_npc_content: dangling item in reward | `content.rs` tests: `validate_npc_teeth_dangling_item` |
| validate_npc_content: dangling zone in heal location | `content.rs` tests: `validate_npc_teeth_dangling_zone` |
| NPCs don't warp through warp tiles | `npc_tests.rs` source guard: warp comment updated |
| advance_dialogue rejects out-of-zone | `npc_tests.rs`: `advance_dialogue_has_proximity_recheck_rt_adv_01_fixed` |
| advance_dialogue auto-dismisses on walk-away | Eval C11 in `npc-dialogue-quest-security.eval.mjs` |

## Anti-patterns to avoid

- Don't edit `docs/adr/README.md` (supervisor-owned)
- Don't touch `CHANGELOG.md` (git-cliff generated)
- Don't grow `lib.rs` or `npc.rs` into monoliths — keep files focused
- Don't change `validate_content` signature (external callers in tests + server)
- Don't evaluate quest logic client-side
- Don't use `new RegExp(non-literal)` in eval — use `indexOf` or literal `/regex/`
- Semgrep bans unsafe `console.error` string interpolation — use `String(val)` or `${String(val)}`

## Touches: path-set declaration

```
game-core/src/content.rs
game-core/src/lib.rs  (if new pub re-exports needed)
game-core/build.rs
game-core/content/npcs/**
game-core/content/dialogue_trees/**
game-core/content/quests/**
game-core/content/heal_locations/**
server-module/src/content.rs
server-module/src/npc.rs
server-module/src/npc_tests.rs
server-module/src/movement.rs
server-module/src/lib.rs  (if re-exports change)
evals/npc-dialogue-quest-security.eval.mjs  (add C11)
evals/npc-content-integrity.eval.mjs  (new eval)
docs/m12c-plan.md  (this file)
docs/adr/0070-*.md
ARCHITECTURE.md  (minimal M12c entry)
```

**Fan-out-ineligible**: this slice edits `ARCHITECTURE.md` and a shared eval + ADR. Must run serially.
