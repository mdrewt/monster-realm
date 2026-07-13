# 0069. NPC/dialogue/quest — server reducers and entity management (M12b)

**Status:** Accepted
**Date:** 2026-07-02
**Slice:** m12b
**Supersedes:** —
**Amends:** —
**Subsystems:** economy-quests, schema-persistence
**Decision:** NPC entity loop, talk/advance_dialogue/dismiss_dialogue/heal_party reducers, and six new tables (npc, dialogue state, quest, conversation, heal) in server-module.
**Amended-by:** ADR-0087

- Status: accepted
- Date: 2026-07-02
- Milestone: M12b

## Context and problem statement

M12b implements the server-side runtime for NPCs, dialogue, and quests: the database tables,
the reducer endpoints for player interactions, the NPC wander loop integration, and the
healing subsystem. The M12a pure rules (ADR-0068) are the SSOT; M12b is a thin effectful
shell that validates input, delegates to game-core, and writes results to tables.

Key decisions:

1. **Table schema** — what tables do NPC state, dialogue progress, and quest state require?
2. **Dialogue reducer guards** — how are F1 (identity), F2 (single-write), and F7 (range)
   enforced in `talk`, `advance_dialogue`, `dismiss_dialogue`?
3. **Quest integration** — where does `process_trigger` get called from?
4. **NPC wander loop** — how is `npc_decide` driven from `movement_tick`?
5. **Healing subsystem** — what are the cooldown rules and in-battle guards for `heal_party`?

## Considered alternatives

### 1. Player dialogue state — single table vs. one per dialogue tree

- **Single `player_dialogue_state` table (chosen):** Per-player, per-npc-or-tree keyed.
  Tracks {flags, active_quests, done_quests} as flat vectors. Deterministic storage
  for a lightweight game-core `PlayerDialogueState` view.
- **Separate tables per content id:** Would explode the table count and require per-npc
  reducer generation. Schema-inflexible. Rejected.

### 2. Dialogue reducer design — is `advance_dialogue` allowed to skip the `apply_choice` security gate?

- **`apply_choice` is the mandatory security gate (chosen):** The reducer calls
  `apply_choice`, which internally re-checks conditions via `evaluate_condition`.
  M12b cannot bypass it even by mistake; the pure rule owns the check.
- **Reducer re-checks conditions itself:** Duplicates the condition logic (ADR-0003
  violation). Deferred to M12b is a footgun. Rejected.

### 3. NPC wander driving — is it part of the existing `movement_tick`, or a separate scheduled task?

- **Integrated into `movement_tick` (chosen):** For each character, if it's an NPC,
  call `npc_decide` and push the result onto its `move_queue`. Reuses the existing
  queue-drain loop. Simple to test with existing movement tests.
- **Separate `npc_tick` scheduled reducer:** Would require a separate clock + tuning
  to match player ticks. Adds complexity. Rejected.

### 4. Healing cooldown representation — is it per-npc, per-player, or global?

- **Per-location, per-player (chosen):** `heal_cooldown` table keyed by
  (location_id, player_identity). One upsert per `heal_party` call. Cooldown value is
  checked against `ctx.timestamp` with a strict `<` guard (reject if not elapsed).
- **Global per-player:** Would limit healing to one location per player. Inflexible.
  Rejected.

### 5. Heal effect on HP — full restore or graduated amounts?

- **Full restore to max HP (chosen):** Per spec §2.7; matching the battle `heal_party`
  reducer. Simple, deterministic, no arithmetic.
- **Item-driven heal amounts:** Deferred to M13. Rejected.

## Decision outcomes

### Tables (6 new)

- **`npc` (public):** Entity row for NPC state. Keyed by `npc_id` with `#[unique]`
  index. Columns: `npc_id: u32`, `home_x: i32`, `home_y: i32`, `wander_radius: i32`,
  `zone_id: u32`, plus serialized `move_queue: Vec<MoveInput>` (ticked by `movement_tick`).
  The NPC starts at `home_x/home_y` and wanders within the radius.

- **`player_dialogue_state` (PRIVATE, no `public` attribute):** Per-player, per-dialogue-tree state.
  Keyed by (player_identity, dialogue_id). Columns: `player_identity`, `dialogue_id`,
  `node_id: String`, `flags: Vec<String>`, `active_quests: Vec<String>`,
  `done_quests: Vec<String>`. Marshaled to/from game-core `PlayerDialogueState` by
  `load_player_dialogue_state` and `write_player_dialogue_state` helpers (ADR-0015,
  no client accessor for dialogue progress).

- **`player_quest` (public):** Per-player quest state. Keyed by (player_identity,
  quest_id). Tracks {step_index, quest_state} for integration with dialogue via
  shared `Condition` (ADR-0068). `quest_state` field discriminant: Active/Done.

- **`player_conversation` (public):** Transient conversation row, keyed by
  (player_identity, npc_id, dialogue_id). Holds the current NPC dialogue session
  (player is talking to NPC X, in dialogue tree Y). Used by `talk`/`advance_dialogue`/
  `dismiss_dialogue` to lock out multi-NPC chatter and track which tree is active.
  > **AMENDED (M13.5c, D-13.5-3, ADR-0087):** the table is now PRIVATE. A
  > world-readable `current_node_id` was an inference channel into the private
  > `player_dialogue_state` flags (nodes are flag-gated, so observing another
  > player's node id revealed their flags); that channel is closed for client
  > subscriptions. Owners read their own row via the public owner-scoped
  > `my_conversation` `#[view]` — mechanism, evidence, and rollout notes in
  > ADR-0087.

- **`heal_location_row` (public):** Content-seeded NPC healing locations. Keyed by
  location_id. Columns: `location_id: u32`, `zone_id: u32`, `tile_x: i32`, `tile_y: i32`.
  Paired with the existing `npc` table — some NPCs may offer healing at their location.

- **`heal_cooldown` (PRIVATE, no `public` attribute):** Per-player, per-location cooldown
  state. Keyed by (player_identity, location_id). Tracks `last_healed_at_ms: i64` —
  checked with strict `<` against `ctx.timestamp` (ADR-0015, cooldown is server-authoritative).

### Reducers in `server-module/src/npc.rs`

- **`talk(ctx, npc_id: u32) -> Result<(), String>`**: Initiates a dialogue with an NPC.
  Guard F1 (identity): `ctx.sender`. Guard F7 (position): retrieve NPC row, check
  tile_x/tile_y against player's character zone/position (range TBD by content). Rejects
  if NPC not found, player not in range, or already in conversation. Creates or reuses
  `player_conversation` row, calls `find_entry_node` to load the dialogue tree, and
  calls `apply_node_auto_effects` to apply entry effects (SetFlag, StartQuest on approach).

- **`advance_dialogue(ctx, choice_index: u32) -> Result<(), String>`**: Picks a choice
  and advances the dialogue tree. Guard F1 (identity): `ctx.sender`. Guard F2 (single-write):
  reads `player_conversation` PK-scoped, re-loads `player_dialogue_state` and `dialogue_tree`,
  and updates both tables in a single transaction. Calls `available_choices` → validate
  choice_index, call `apply_choice` (the security gate re-checks all conditions),
  call `apply_effects` to process side-effects (StartQuest, SetFlag), call
  `apply_node_auto_effects` for the new node's entry effects. Writes back
  `player_dialogue_state` and `player_conversation` (or deletes if dialogue ended).

- **`dismiss_dialogue(ctx) -> Result<(), String>`**: Ends the active conversation.
  Guard F1 (identity): `ctx.sender`. Guard F2: deletes `player_conversation` row only
  (leaves `player_dialogue_state` intact for resume on next `talk`).

### Helpers

- **`dialogue_state_from_db(row) -> PlayerDialogueState`**: Deserialize the three `Vec`
  columns into the lightweight game-core view type. Deterministic iteration.

- **`flags_to_vec(BTreeSet<String>) -> Vec<String>`**: Serialize flags for table storage.

- **`done_to_vec(BTreeSet<String>) -> Vec<String>`**: Serialize done_quests for storage.

- **`load_player_dialogue_state(ctx, player_id, dialogue_id) -> Option<PlayerDialogueState>`**:
  Query the table, deserialize if found. Used by `talk` (load to re-enter) and
  `advance_dialogue` (load for choice evaluation).

- **`write_player_dialogue_state(ctx, player_id, dialogue_id, state)`**: Upsert the
  table row. Deterministic serialization of BTreeSets to Vec.

- **`apply_effects_to_db(ctx, effects, player_id, dialogue_state)`**: Side-effect handler
  for all dialogue/quest side-effects (SetFlag, StartQuest, GrantItem, QuestProgress).
  Calls `player_quest` insert/update as needed. Mutates `dialogue_state` in-place and
  returns it for write-back.

- **`apply_quest_trigger(ctx, event: TriggerEvent, player_id)`**: Dispatch quest step
  triggers. Iterates all active quests, calls `process_trigger` for each, collects
  `QuestAdvance::StepComplete` or `::QuestComplete` returns, and updates or deletes
  `player_quest` rows accordingly. This is where quest steps advance via in-game events
  (Talk, Collect, Defeat from M12c content).

### NPC wander integration

In `server-module/src/movement.rs` inside `movement_tick`, for each character:

```rust
if let Some(npc) = ctx.db.npc().read(character.npc_id) {
  if let Some(dir) = npc_decide(
    (npc.tile_x, npc.tile_y),
    (npc.home_x, npc.home_y),
    npc.wander_radius,
    npc.npc_id,
    tick_count
  ) {
    // Push MoveInput::Step(dir) onto npc.move_queue
    let mut npc = npc.clone();
    npc.move_queue.push(MoveInput::Step(dir));
    ctx.db.npc().update(npc);
  }
}
```

The existing queue-drain loop processes the move unchanged.

### Healing subsystem

In `server-module/src/raising.rs` (or merged with `battle.rs` where `heal_party` already
lives — M9b), add `evaluate_heal` pure seam + `heal_party` reducer:

- **`evaluate_heal(ctx, location_id, player_identity) -> Result<(), String>`**: Pure
  game-core seam for future cooldown/eligibility logic (M13+). Today: only checks
  `ctx.timestamp > last_healed_at_ms`.

- **`heal_party(ctx, location_id: u32) -> Result<(), String>`**: Reducer. Guard F7
  (position): check player at heal_location_row tile. Guard in-battle: rejects if
  `player_battle().outcome != SideAWins && != SideBWins` (must have won, not ongoing).
  Guard zone: player must be in location's zone_id. Delegate to `evaluate_heal` (game-core
  seam for eligibility). Consume cost (item or currency — deferred to M13). Call
  `apply_full_heal` on player's party (in-place, from existing `heal_party` battle
  logic). Upsert `heal_cooldown` row with `ctx.timestamp`. Rejects with `Err` if any
  check fails (never clamp).

### Content integration

- **`npc_entity` content in `content/npc/*.ron`:** Seed `npc` table via `seed_npc_entities`
  helper (idempotent upsert by npc_id). Columns map to table schema.

- **`heal_location_def` content in `content/heal_locations/*.ron`:** Seed `heal_location_row`
  table via `seed_heal_locations` helper. Same pattern.

- **Dialogue + quest content (M12c):** M12c loads RON, calls loaders, validates,
  and upserts `dialogue_tree` and `quest_def` tables (awaiting M12c implementation).
  `sync_content` calls `validate_content` which includes dialogue tree root-node-id
  validation and quest step-index bounds checking.

### CONTENT_VERSION increment

`CONTENT_VERSION: 3 → 4` (adding 6 new tables, NPC definitions, healing locations).

### Client bindings

Regenerated via `just gen` (M12b branch); new table accessors for `npc`, `player_quest`,
`player_conversation`, `heal_location_row` (public only). `player_dialogue_state` and
`heal_cooldown` are private (no codegen entry). The `module_bindings/index.ts` reflects
the new `#[unique]` npc_id accessor.

### Evals

- **`npc-dialogue-quest-security.eval.mjs`** — 10 checks (C1–C10):
  - C1: Every `player_dialogue_state` row has a corresponding (valid) `dialogue_id` in content.
  - C2: Every `player_conversation` (NPC session) row is transient (created/deleted same
    reduce call, not persisted across session). *(Residual: M12c to define transience.*
  - C3: `advance_dialogue` rejects out-of-bounds choice_index (no crash).
  - C4: `talk` rejects already-in-conversation case (no multi-NPC chatter).
  - C5: `dismiss_dialogue` cleans up `player_conversation` (no stale sessions).
  - C6: `heal_party` rejects in-battle (Ongoing), rejects out-of-zone, rejects non-owner.
  - C7: `heal_cooldown` upsert uses `.update()` with find-else-insert, never silent no-op.
  - C8: NPC wander radius==0 → npc_decide early-returns None (no infinite loop risk).
  - C9: All `player_quest` rows remain keyed by quest_id (quest deletion doesn't orphan
    progress rows; follow-up M12c validates).
  - C10: `apply_effects_to_db` mutates `dialogue_state` in-place (F2 single-write discipline).

### Tests

- **`server-module/src/npc_tests.rs` (5 tests):**
  - Marshal roundtrips: `dialogue_state_from_db` / `flags_to_vec` / `done_to_vec`
  - NPC wander: `npc_decide` determinism within radius
  - Wander radius==0 early return (no move generated)

## Consequences

- M12b is the thin shell for dialogue/quest/NPC runtime. All pure logic lives in
  ADR-0068 game-core rules; M12b delegates without re-implementing.

- `player_dialogue_state` and `heal_cooldown` are PRIVATE (ADR-0015); clients have
  no accessor. Dialogue progress is UI-driven via the `talk` / `advance_dialogue` /
  `dismiss_dialogue` reducers alone.

- Healing is guarded by in-battle status, zone, and position (F7). Future M13 can add
  item cost + character-specific healing amounts (additive). The `evaluate_heal` seam
  is ready for parametric extensibility.

- NPC wander is driven by the existing `movement_tick` loop once per server tick,
  with the same collision/queue semantics as player movement. No separate NPC clock.

- Quest triggers are fired from application code (M12d: battle ends → call `apply_quest_trigger`;
  item collected → call `apply_quest_trigger`, etc.). The reducer surface (`talk`,
  `advance_dialogue`) is dialogue-only.

- M12c will load dialogue/quest content, validate tree structure, and call `validate_content`
  to gate the schema + integrity at publish time.
