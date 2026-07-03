# 0068. NPC/dialogue/quest — pure game-core rule module (M12a)
- Status: accepted
- Date: 2026-07-02
- Milestone: M12a

## Context and problem statement

M12 adds NPCs, data-driven dialogue, and a quest/flag system. The M12a slice is the
pure-game-core foundation: the `npc_decide` wander rule (closing the M1/M2 deferral), the
dialogue-tree data model + evaluation, and the flag-based quest-advance rules. All must be
pure/deterministic (ADR-0003), data-driven (ADR-0021), and server-evaluation-ready. The
server module (M12b) will import and call these from reducers; the content pipeline (M12c)
will load RON into these types.

Key decisions:

1. **`npc_decide` signature** — what does the NPC wander decision function look like?
2. **Dialogue state type** — how is per-player dialogue/flag state represented in game-core?
3. **Quest advance API** — how does the pure quest module model "process a trigger"?
4. **Shared `Condition` type** — dialogue and quest conditions are the same enum (shared vs. duplicated).

## Considered alternatives

### 1. `npc_decide` — returning a direction vs. a MoveInput

- **Return `Option<Direction>` (chosen):** The server constructs a `MoveInput` from it and passes it
  to the existing `apply_move`. Responsibility: `apply_move` handles walls/collisions as it does for
  players. Consistent with the single-SSOT movement rule (ADR-0003). Simple to test.
- **Return `MoveInput` or `CharacterState` directly:** Couples NPC wander to the move-queue plumbing;
  the NPC wander rule has no reason to know about queue caps or coded directions. Rejected (YAGNI).
- **Return a new `NpcAction` enum with multiple variants:** Would be needed if NPCs could do more than
  move (talk, attack). Deferred — wander is the M12a scope; a richer action enum can be added additively.

### 2. Dialogue player state — single `PlayerDialogueState` vs. separate flag/quest types

- **Single `PlayerDialogueState { flags, active_quests, done_quests }` (chosen):** The dialogue
  evaluation only needs to know what flags are set and which quests are active/done — these three sets
  cover every `Condition` variant. Keeps the pure rule interface narrow.
- **Separate `PlayerFlags` + `QuestProgress` types:** Would need to pass two arguments everywhere. The
  server's `player_quest` table stores quests and flags together per ADR-0021; a single lightweight
  view type mirrors that.

### 3. Quest trigger event vs. passing all fields as parameters

- **`TriggerEvent` enum (chosen):** Pattern-matches cleanly against `StepTrigger`. New event types
  (e.g. `Warp`, `Crafted`) can be added additively. Exhaustive `match` ensures every new event type
  is handled at every call site.
- **Separate function per trigger type** (`process_talk`, `process_collect`, `process_defeat`):
  Explodes the API surface; callers must dispatch themselves. Rejected.

### 4. Shared `Condition` type across dialogue and quest modules

- **Single `Condition` enum in `dialogue::model`, re-exported (chosen):** Dialogue choices and quest
  steps share the exact same condition semantics (`HasFlag`, `NotFlag`, `QuestActive`, `QuestDone`).
  Duplicating the type would create two `evaluate_condition` implementations that could drift.
- **Module-local copies:** Would require two implementations of `evaluate_condition` with identical
  semantics — a guaranteed source of desync. Rejected (ADR-0003 SSOT).

## Decision outcomes

- **`npc_decide(current, home, radius, npc_id, tick) -> Option<Direction>`**: pure, seeded with
  `tick_seed(npc_id, tick, NPC_DECIDE_SALT)`. "None" means stay this tick (**1-in-5** probability:
  seed % 5 == 0). Within Manhattan radius → random direction from seed. Outside radius → deterministic
  toward-home along whichever axis has larger separation (tie-break: x-axis). `apply_move` handles
  wall collisions (no wallcheck here). Known-answer vectors pin the SALT constant.
- **`PlayerDialogueState { flags: BTreeSet<String>, active_quests: BTreeSet<String>, done_quests: BTreeSet<String> }`**:
  the lightweight pure-layer view of per-player state. `BTreeSet` for deterministic iteration order.
  No `pub type FlagId = String` alias exported — a naked alias provides no enforcement; use bare `String`.
- **`DialogueTree { id: String, root_node_id: String, nodes: Vec<DialogueNode> }`**: `root_node_id`
  is kept as an informational field for M12b restart/navigation (re-entering dialogue after mid-tree
  choices). `find_entry_node` performs a linear scan over `nodes` in declaration order regardless —
  the first node whose `entry_conditions` all pass is the entry point. `root_node_id` is NOT used by
  any game-core rule; M12c `validate_content` must verify it references a valid node id.
- **`Condition` in `dialogue::model`, re-exported from `quest`**: single evaluate function
  `evaluate_condition(cond, state) -> bool` is the SSOT for all condition checks.
- **Currency rewards deferred to M13** per spec §2: `QuestReward` has `xp: u32` + `items: Vec<RewardItem>`;
  no `currency` field until M13 adds it additively.

## Consequences

- M12b (server) imports `npc_decide`, calls it in `movement_tick` for NPC entities. When `npc_decide`
  returns `Some(dir)`, M12b pushes `MoveInput::Step(dir)` onto the NPC's `move_queue` column —
  the same path as player input, drained one entry per tick by the existing `movement_tick` loop.
  When `None` is returned, no entry is pushed (NPC stays this tick). `apply_move` is already the
  single rule; M12b does not call it directly — movement_tick does.
- M12b can import `DialogueTree`, `PlayerDialogueState`, `find_entry_node`, `available_choices`,
  `apply_choice`, `apply_effects`, `QuestDef`, `PlayerQuestProgress`, `can_start_quest`,
  `process_trigger`, and `TriggerEvent` from `game_core::{dialogue, quest}`.
- M12c loads RON into these types via the existing content pipeline pattern (new loaders, validated
  by `validate_content`).
- Currency quest rewards can be added to `QuestReward` at M13 without changing any quest-rule function
  signatures — additive per ADR-0006.
