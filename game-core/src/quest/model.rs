//! Quest data model — serde-ready, SpacetimeType-free (M12b adds derives).
//!
//! Re-uses `crate::dialogue::Condition` for step-level gating; this avoids
//! duplicating the condition type while keeping modules decoupled.

use serde::{Deserialize, Serialize};

use crate::dialogue::Condition;

/// How a quest step is completed.
///
/// `Collect` qty semantics: `event.qty >= step.qty` (at-least, not exact).
/// A player collecting 5 herbs satisfies a "collect 3 herbs" step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepTrigger {
    /// Player talks to this NPC.
    Talk { npc_id: String },
    /// Player collects at least `qty` of `item_id`.
    Collect { item_id: u32, qty: u32 },
    /// Player defeats a monster of this species.
    Defeat { species_id: u32 },
}

/// A single item reward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewardItem {
    pub item_id: u32,
    pub qty: u32,
}

/// Reward granted on quest completion (currency deferred to M13).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestReward {
    pub xp: u32,
    pub items: Vec<RewardItem>,
}

/// A single step in a quest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestStep {
    /// The trigger event that completes this step.
    pub trigger: StepTrigger,
    /// Extra conditions that must hold for this step to be progressable.
    /// Re-uses `crate::dialogue::Condition` (evaluated against `PlayerDialogueState`).
    pub conditions: Vec<Condition>,
}

/// A quest definition (loaded from RON in M12c).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestDef {
    /// Unique quest identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// All must hold for `can_start_quest` to return true.
    pub start_conditions: Vec<Condition>,
    /// Steps in order; `step_index` is 0-based.
    pub steps: Vec<QuestStep>,
    /// Reward granted when all steps are completed.
    pub reward: QuestReward,
}

/// Per-player quest progress (backed by `player_quest` table in M12b).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerQuestProgress {
    pub quest_id: String,
    /// Which step we're currently on (0-based).
    pub step_index: u32,
}

/// A trigger event passed to `process_trigger`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TriggerEvent {
    Talked { npc_id: String },
    Collected { item_id: u32, qty: u32 },
    Defeated { species_id: u32 },
}

/// The outcome of `process_trigger` when a step or quest completes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum QuestAdvance {
    /// Intermediate step completed; player is now on `new_step`.
    StepComplete { new_step: u32 },
    /// All steps done; here is the reward.
    QuestComplete { reward: QuestReward },
}
