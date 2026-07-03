//! Dialogue data model — serde-ready, SpacetimeType-free (M12b adds derives).
//!
//! All types derive `Debug`, `Clone`, `PartialEq`, `Eq`, `Serialize`,
//! `Deserialize`. No `SpacetimeType` here — that is M12b's job (ADR-0068).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Conditions evaluated against player state for entry nodes and choice gating.
/// ALL conditions in a list must hold (AND semantics).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Condition {
    /// Player has this flag set in `state.flags`.
    HasFlag(String),
    /// Player does NOT have this flag set.
    NotFlag(String),
    /// Quest is in progress (`state.active_quests`).
    QuestActive(String),
    /// Quest is completed (`state.done_quests`).
    QuestDone(String),
}

/// Effects applied when a player makes a dialogue choice.
///
/// `GrantXp` and `GrantItem` are **server-side only** — `apply_effects` treats
/// them as explicit no-ops; the server extracts them from `ChoiceResult.effects`
/// and routes them through the M9 inventory/XP helpers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DialogueEffect {
    /// Add a flag to `state.flags`.
    SetFlag(String),
    /// Remove a flag from `state.flags` (no-op if absent).
    ClearFlag(String),
    /// Begin a quest: add to `state.active_quests`.
    StartQuest(String),
    /// Grant XP (server-side only; `apply_effects` is a no-op for this).
    GrantXp(u32),
    /// Grant items: `(item_id, qty)` (server-side only; `apply_effects` no-op).
    GrantItem(u32, u32),
}

/// A player-visible choice in a dialogue node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DialogueChoice {
    /// Displayed text for this choice.
    pub text: String,
    /// All must hold for this choice to be available.
    pub conditions: Vec<Condition>,
    /// Applied when this choice is selected.
    pub effects: Vec<DialogueEffect>,
    /// Next node id, or `None` to end the dialogue.
    pub next_node: Option<String>,
}

/// A dialogue node — NPC speech + player choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DialogueNode {
    /// Unique id within its `DialogueTree`.
    pub id: String,
    /// NPC speech text shown to the player.
    pub text: String,
    /// All must hold for `find_entry_node` to return this node.
    pub entry_conditions: Vec<Condition>,
    /// Applied automatically when entering this node (before choices are shown).
    pub auto_effects: Vec<DialogueEffect>,
    /// Player choices for this node.
    pub choices: Vec<DialogueChoice>,
}

/// The complete dialogue tree for one NPC conversation.
///
/// `root_node_id` is kept for M12b restart/navigation; `find_entry_node`
/// performs a linear scan over `nodes` in declaration order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DialogueTree {
    /// Unique id for this tree.
    pub id: String,
    /// Kept for M12b restart navigation; `find_entry_node` scans `nodes` order.
    pub root_node_id: String,
    /// All nodes in declaration order. First matching entry conditions wins.
    pub nodes: Vec<DialogueNode>,
}

/// Player-side dialogue state passed to evaluation functions.
///
/// The server table owns the real data; this struct is a pure input to the
/// rule functions (no mutable global state involved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerDialogueState {
    /// Active flags (set via `SetFlag`, cleared via `ClearFlag`).
    pub flags: BTreeSet<String>,
    /// Quests currently in progress.
    pub active_quests: BTreeSet<String>,
    /// Quests that have been completed.
    pub done_quests: BTreeSet<String>,
}

impl PlayerDialogueState {
    /// Create a fresh empty state with no flags or quests.
    #[must_use]
    pub fn new() -> Self {
        Self {
            flags: BTreeSet::new(),
            active_quests: BTreeSet::new(),
            done_quests: BTreeSet::new(),
        }
    }
}

impl Default for PlayerDialogueState {
    fn default() -> Self {
        Self::new()
    }
}
