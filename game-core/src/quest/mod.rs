//! Quest flag-advance module — pure, deterministic (ADR-0021, ADR-0068).

pub mod model;
pub mod rules;

#[cfg(test)]
pub mod m12a_gating_tests;

pub use model::{
    PlayerQuestProgress, QuestAdvance, QuestDef, QuestReward, QuestStep, RewardItem, StepTrigger,
    TriggerEvent,
};
pub use rules::{can_start_quest, process_trigger, trigger_matches};
