# M12a Build Plan — pure game-core NPC/dialogue/quest module

## Slice summary
- **Milestone:** M12 (NPCs, dialogue & quests)
- **Slice:** M12a — pure game-core rule module
- **ADR:** 0068 (reserved)
- **Branch:** `feat/m12a-game-core-npc-dialogue-quest`
- **Serial spine gate:** this slice gates M12b (server reducers/schema), which gates M12c (content RON), which gates M12d (client)

## Scope (exactly what M12a touches)

```
touches:
  game-core/src/npc/       (new)
  game-core/src/dialogue/  (new)
  game-core/src/quest/     (new)
  game-core/src/lib.rs     (add 3 module declarations + pub use)
  docs/m12a-plan.md        (this file)
  docs/adr/0068-*.md       (new ADR)
  ARCHITECTURE.md          (minimal targeted addition)
```

**Not touching:** server-module, client, content RON, schema, evals, module_bindings, Cargo.lock.

## New modules

### 1. `game-core/src/npc/`

**Purpose:** `npc_decide` — the pure, seeded NPC-wander decision rule deferred from M1/M2.

Files:
- `mod.rs` — module declarations + pub use
- `types.rs` — `NpcKind` enum (Wanderer, Stationary, PathFollower-deferred)
- `rules.rs` — `npc_decide(current, home, radius, npc_id, tick) -> Option<Direction>`
- `m12a_gating_tests.rs` — unit + property + determinism tests

Key design:
- Returns `Option<Direction>` — `None` means stay (no-op tick)
- Uses `crate::tick_seed(npc_id, tick, NPC_DECIDE_SALT)` for deterministic randomness
- "Within wander radius" → random direction from seed
- "Outside wander radius" → deterministic toward-home direction
- Wall-collision is NOT handled here — `apply_move` handles bumps (consistent with player movement)
- Manhattan distance for radius check (L1, consistent with tile movement)

NPC stays put with probability 1-in-5: seeded hash **mod 5**, stay if 0. This avoids robotic constant movement.
(ADR-0068 is the SSOT; "1-in-5" and "mod 5" must be consistent — a prior "1-in-4" label was a typo.)

### 2. `game-core/src/dialogue/`

**Purpose:** Data-driven dialogue tree model + pure evaluation rules (ADR-0021).

Files:
- `mod.rs`
- `model.rs` — all data types (serde-ready, SpacetimeType-free)
- `rules.rs` — pure evaluation functions
- `m12a_gating_tests.rs`

Data model:

```rust
// Do NOT export `pub type FlagId = String` — a naked type alias gives false
// confidence without enforcement. Use bare `String` throughout.

// Conditions evaluated against player state
pub enum Condition {
    HasFlag(String),       // player has this flag set
    NotFlag(String),       // player does NOT have this flag
    QuestActive(String),   // quest is in progress
    QuestDone(String),     // quest is complete
}

// Effects applied to player state (server applies them to actual tables)
pub enum DialogueEffect {
    SetFlag(String),
    ClearFlag(String),
    StartQuest(String),    // begins quest by ID
    GrantXp(u32),          // server routes through XP helper
    GrantItem(u32, u32),   // (item_id, qty) — server routes through inventory helper
    // Currency: deferred to M13
}

// A player-visible choice
pub struct DialogueChoice {
    pub text: String,
    pub conditions: Vec<Condition>,   // ALL must hold to show this choice
    pub effects: Vec<DialogueEffect>, // applied on selection
    pub next_node: Option<String>,    // None = end dialogue
}

// A dialogue node (NPC speech + player choices)
pub struct DialogueNode {
    pub id: String,
    pub text: String,
    pub entry_conditions: Vec<Condition>, // used when evaluating which root node to show
    pub auto_effects: Vec<DialogueEffect>, // applied on entering this node (before choices)
    pub choices: Vec<DialogueChoice>,
}

// The complete tree (loaded from RON in M12c, but structurally defined here)
// No `root_node_id`: find_entry_node does a linear scan over all nodes; the first
// node with all entry_conditions passing is the entry point. A fixed root_node_id
// would be redundant with this scan and create an SSOT split.
pub struct DialogueTree {
    pub id: String,
    pub nodes: Vec<DialogueNode>,
}
```

Player state (passed to dialogue evaluation — the server table owns the real data):
```rust
pub struct PlayerDialogueState {
    pub flags: BTreeSet<String>,        // active flags
    pub active_quests: BTreeSet<String>, // in-progress quest IDs
    pub done_quests: BTreeSet<String>,  // completed quest IDs
}
```

Rules:
```rust
// Find the right entry node given player state (first node whose entry_conditions all pass)
pub fn find_entry_node<'a>(tree: &'a DialogueTree, state: &PlayerDialogueState)
    -> Option<&'a DialogueNode>

// Which choice indices are available to the player?
pub fn available_choices(node: &DialogueNode, state: &PlayerDialogueState) -> Vec<usize>

// Apply a choice: returns effects + next node id.
// CONTRACT (security-load-bearing): apply_choice checks availability INTERNALLY:
//   - Err(DialogueError::InvalidChoice) if choice_idx >= node.choices.len()
//   - Err(DialogueError::ChoiceNotAvailable) if the choice's conditions are not met
// Does NOT trust the caller to pre-filter via available_choices. This makes it
// safe to call directly from M12b reducers without a separate pre-check.
// Proof-of-teeth: an impl that skips condition check bypasses flag gates.
#[must_use]
pub fn apply_choice<'a>(
    node: &'a DialogueNode,
    choice_idx: usize,
    state: &PlayerDialogueState,
) -> Result<ChoiceResult<'a>, DialogueError>

pub struct ChoiceResult<'a> {
    pub effects: &'a [DialogueEffect],
    pub next_node_id: Option<&'a str>,
}

pub fn evaluate_condition(cond: &Condition, state: &PlayerDialogueState) -> bool

pub fn apply_effects(effects: &[DialogueEffect], state: &mut PlayerDialogueState)
// CONTRACT: apply_effects uses an EXHAUSTIVE match over DialogueEffect variants:
//   SetFlag → insert into state.flags
//   ClearFlag → remove from state.flags
//   StartQuest → insert into state.active_quests
//   GrantXp | GrantItem → explicit no-op arms (comment: "server-side only")
// The exhaustive match ensures future effect variants force a deliberate decision.
// GrantXp + GrantItem reach the server via ChoiceResult.effects (the slice from
// apply_choice) — the server extracts them and routes through M9 helpers.
// add test: apply_effects_does_not_mutate_state_for_grant_effects
```

### 3. `game-core/src/quest/`

**Purpose:** Flag-based quest system data model + pure advance rules (ADR-0021 §"flag-based").

Files:
- `mod.rs`
- `model.rs` — `QuestDef`, `QuestStep`, `StepTrigger`, `QuestReward`, `PlayerQuestProgress`
- `rules.rs` — advance rules
- `m12a_gating_tests.rs`

Data model:

```rust
// How a quest step is completed
// Collect qty semantics: event.qty >= step.qty (at-least, not exact equality).
// Rationale: a player collecting 5 herbs satisfies a "collect 3 herbs" step.
// The M12b reducer sends a Collected event with however many were collected.
pub enum StepTrigger {
    Talk { npc_id: String },
    Collect { item_id: u32, qty: u32 },   // step requires >= qty of this item
    Defeat { species_id: u32 },
}

// Reward on quest completion (currency deferred to M13 per spec §2)
pub struct QuestReward {
    pub xp: u32,
    pub items: Vec<RewardItem>,
}

pub struct RewardItem {
    pub item_id: u32,
    pub qty: u32,
}

// A single step in a quest
pub struct QuestStep {
    pub trigger: StepTrigger,
    // extra conditions that must hold for this step to be progressable
    pub conditions: Vec<Condition>,  // reuses dialogue Condition type
}

// A quest definition (loaded from RON in M12c)
pub struct QuestDef {
    pub id: String,
    pub name: String,
    pub start_conditions: Vec<Condition>, // must hold to start the quest
    pub steps: Vec<QuestStep>,
    pub reward: QuestReward,
}

// Per-player quest state (held in server's player_quest table in M12b)
pub struct PlayerQuestProgress {
    pub quest_id: String,
    pub step_index: u32,  // which step we're on (0-based)
}

// The event that happened (passed to process_trigger)
pub enum TriggerEvent {
    Talked { npc_id: String },
    Collected { item_id: u32, qty: u32 },
    Defeated { species_id: u32 },
}
```

Rules:
```rust
// Can this player start the quest? (not already active/done + start_conditions met)
pub fn can_start_quest(
    def: &QuestDef,
    dialogue_state: &PlayerDialogueState,
    progress: &[PlayerQuestProgress],
) -> bool

// Does an event complete the current step of an active quest?
// CONTRACT:
//   1. Bounds-check: if progress.step_index >= def.steps.len() → None (already done)
//   2. trigger_matches(current_step.trigger, event) must be true
//   3. ALL current_step.conditions must pass (evaluate_condition against dialogue_state)
//      — step conditions are evaluated HERE, not only at can_start_quest
//   4. If all pass: if this was the last step → QuestAdvance::QuestComplete { reward }
//      else → QuestAdvance::StepComplete { new_step: progress.step_index + 1 }
// #[must_use] — a reducer that drops this return value silently skips the advance
#[must_use]
pub fn process_trigger(
    def: &QuestDef,
    progress: &PlayerQuestProgress,
    dialogue_state: &PlayerDialogueState,
    event: &TriggerEvent,
) -> Option<QuestAdvance>

pub enum QuestAdvance {
    StepComplete { new_step: u32 },     // advanced to next step
    QuestComplete { reward: QuestReward }, // all steps done, here's reward
}

// Check if a step trigger matches a trigger event
pub fn trigger_matches(trigger: &StepTrigger, event: &TriggerEvent) -> bool
```

## EARS criteria → tests

### NPC wander

| EARS criterion | Test |
|---|---|
| deterministic: same seed → same result | `npc_decide_is_deterministic` (unit + property) |
| within radius → random direction | `npc_decide_within_radius_is_random` (varies over different ticks) |
| outside radius → toward home | `npc_decide_outside_radius_moves_toward_home` |
| at exact radius → random (not return-to-home) | `npc_decide_at_boundary` |
| home == current → random | `npc_decide_at_home` |
| stay probability works | `npc_decide_stay_probability` |
| no unwalkable-wall logic (apply_move's job) | (no test — design decision, documented) |

### Dialogue

| EARS criterion | Test |
|---|---|
| condition HasFlag/NotFlag | `evaluate_condition_has_flag`, `evaluate_condition_not_flag` |
| condition QuestActive/QuestDone | `evaluate_condition_quest_active_done` |
| entry node selection | `find_entry_node_first_match`, `find_entry_node_no_conditions_matches`, `find_entry_node_none_when_all_blocked` |
| available choices filtering | `available_choices_filters_by_conditions` |
| apply_choice out-of-range → error | `apply_choice_out_of_range_error` |
| apply_choice unavailable → error | `apply_choice_unavailable_error` |
| auto_effects returned | `find_entry_node_returns_auto_effects` |
| apply_effects updates flags | `apply_effects_set_clear_flag` |
| apply_effects starts quest | `apply_effects_start_quest` |
| GrantXp/GrantItem in effects list (server handles) | `apply_choice_grant_effects_preserved` |
| determinism | `dialogue_evaluation_is_deterministic` |
| proof-of-teeth: remove NotFlag condition, gain access | test fixture with sabotage |

### Quest

| EARS criterion | Test |
|---|---|
| can_start requires start_conditions | `can_start_quest_requires_conditions` |
| can_start false if already active | `can_start_quest_false_if_active` |
| can_start false if already done | `can_start_quest_false_if_done` |
| process_trigger Talk match | `process_trigger_talk_matches` |
| process_trigger Collect match | `process_trigger_collect_matches` |
| process_trigger Defeat match | `process_trigger_defeat_matches` |
| process_trigger wrong type → None | `process_trigger_wrong_type_none` |
| process_trigger last step → QuestComplete | `process_trigger_completes_quest` |
| process_trigger reward correct | `quest_complete_reward_correct` |
| trigger_matches exact type match | `trigger_matches_exact` |
| proof-of-teeth: missing `can_start` check lets quest start twice | sabotage test |

## Anti-patterns to avoid

1. **No RNG in game-core without injection** — `npc_decide` must take `npc_id + tick` and hash them, never call `rand::rng()` or `OsRng`.
2. **No duplicated rule logic** — dialogue condition evaluation is ONE function `evaluate_condition`; every caller uses it.
3. **No SpacetimeType derives in M12a** — these types go in the server module in M12b.
4. **No RON parsing in M12a** — content loading is M12c.
5. **No `unwrap()`-as-assumed-valid on user input** — all public functions take valid typed inputs; reject via `Err` for invalid runtime state.
6. **`Currency` is M13** — quest rewards have XP + items only.

## Proof-of-teeth obligations

Per ADR-0010, each gate must have a known-bad fixture that makes it fail:

1. **NPC determinism** — sabotage: modify salt constant → known-answer vector changes → test fails
2. **Dialogue condition evaluation** — sabotage: `HasFlag` always returns `true` → gate-filtered choice becomes available when it shouldn't → `available_choices_filters_by_conditions` fails
3. **Quest advance** — sabotage: skip step completion check → `process_trigger` returns `None` for a matching trigger → step-advance test fails

Each sabotage is a comment in the test ("proof-of-teeth: an impl that X would fail this because Y").

## Files to create

```
game-core/src/npc/mod.rs
game-core/src/npc/types.rs
game-core/src/npc/rules.rs
game-core/src/npc/m12a_gating_tests.rs
game-core/src/dialogue/mod.rs
game-core/src/dialogue/model.rs
game-core/src/dialogue/rules.rs
game-core/src/dialogue/m12a_gating_tests.rs
game-core/src/quest/mod.rs
game-core/src/quest/model.rs
game-core/src/quest/rules.rs
game-core/src/quest/m12a_gating_tests.rs
game-core/src/lib.rs (update: add 3 pub mod + pub use)
docs/adr/0068-npc-dialogue-quest-game-core.md
docs/m12a-plan.md (this file)
ARCHITECTURE.md (one targeted row)
```

## Definition of done

- `cargo clippy -p game-core --all-targets -- -D warnings` clean
- `cargo nextest run -p game-core` green (all tests pass, including RED → GREEN)
- All EARS criteria covered by tests
- Every proof-of-teeth fixture would catch a specified wrong implementation
- Determinism tests: `npc_decide` + dialogue/quest rules are purely functional
- ADR-0068 written + indexed
- `wip:` commits pushed on each phase boundary
