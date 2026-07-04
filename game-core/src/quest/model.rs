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

/// Reward granted on quest completion (M13c adds currency, ADR-0083).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestReward {
    pub xp: u32,
    pub items: Vec<RewardItem>,
    /// Currency reward granted via `grant_currency` on completion (ADR-0083).
    /// Defaults to 0 so existing RON quest definitions that omit this field remain valid.
    #[serde(default)]
    pub currency: u64,
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

// ===========================================================================
// M13c: QuestReward.currency tests (ADR-0083)
//
// These tests are RED until the implementer adds `currency: u64` with
// `#[serde(default)]` to `QuestReward` in this file.
//
// EARS criteria:
//   - EARS-QUEST-CONTENT-1: currency defaults to 0 when absent from RON
//     (the field carries `#[serde(default)]` so existing quest RON files that
//     omit currency continue to parse correctly — no breakage).
//   - EARS-QUEST-CONTENT-2: currency round-trips when present in RON.
//
// The tests deserialize QuestReward directly using ron::from_str (no DB
// context required — pure serde). This matches the existing model.rs pattern
// of testing at the serde boundary.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// M13c (EARS-QUEST-CONTENT-1): deserializing a QuestReward without the
    /// `currency` field must succeed and produce `currency == 0`.
    ///
    /// kills: an impl that adds `currency` to `QuestReward` WITHOUT
    ///        `#[serde(default)]`, which would break deserialization of all
    ///        existing quest RON files that don't include a currency reward.
    #[test]
    fn quest_reward_currency_defaults_to_zero() {
        // Minimal QuestReward RON — existing fields only, NO currency.
        // This is the shape every existing quest file uses. If currency is
        // added without #[serde(default)], this parse will return Err.
        let ron_str = r#"(xp: 100, items: [])"#;
        let reward: QuestReward = ron::from_str(ron_str).expect(
            "QuestReward without currency must parse — currency must carry \
                 #[serde(default)]. \
                 TEETH: impl that adds currency without #[serde(default)] breaks \
                 every existing quest RON file that omits the field.",
        );
        assert_eq!(
            reward.currency, 0,
            "TEETH(M13c EARS-QUEST-CONTENT-1): currency must default to 0 when absent \
             from RON (#[serde(default)] required on the field). \
             kills: impl that defaults to a non-zero sentinel value, or one that \
             omits the default entirely (would fail at the parse step above)."
        );
        // Verify other fields are unaffected.
        assert_eq!(
            reward.xp, 100,
            "xp field must be unaffected by adding currency"
        );
        assert!(
            reward.items.is_empty(),
            "items field must be unaffected by adding currency"
        );
    }

    /// M13c (EARS-QUEST-CONTENT-2): deserializing a QuestReward WITH
    /// `currency: 100` must produce `currency == 100`.
    ///
    /// kills: an impl that parses the currency field but writes it to a wrong
    ///        field, or one that ignores the value and always returns 0,
    ///        or one that uses a different field name (e.g. `gold` instead of
    ///        `currency`).
    #[test]
    fn quest_reward_currency_round_trips() {
        let ron_str = r#"(xp: 250, items: [], currency: 100)"#;
        let reward: QuestReward =
            ron::from_str(ron_str).expect("QuestReward with currency: 100 must parse successfully");
        assert_eq!(
            reward.currency, 100,
            "TEETH(M13c EARS-QUEST-CONTENT-2): currency must round-trip through RON serde; \
             got {} expected 100. \
             kills: impl that parses the field but stores it incorrectly, or one that \
             ignores the parsed value and always returns 0.",
            reward.currency
        );
        // Verify other fields carry through correctly alongside currency.
        assert_eq!(
            reward.xp, 250,
            "xp must not be disturbed by the currency field"
        );
    }
}
