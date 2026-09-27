//! Quest flag-advance module — pure, deterministic.

pub mod model;
pub mod rules;

#[cfg(test)]
pub mod rules_tests;

pub use model::{
    PlayerQuestProgress, QuestAdvance, QuestDef, QuestReward, QuestStep, RewardItem, StepTrigger,
    TriggerEvent,
};
pub use rules::{can_start_quest, process_trigger, trigger_matches};
