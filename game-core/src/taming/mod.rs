//! Taming module — encounter triggering, weighted species selection,
//! and recruit-chance arithmetic (M8a). All pure and deterministic.

pub mod rules;
pub mod types;

#[cfg(test)]
pub mod rules_tests;

pub use rules::{
    attempt_recruit, encounter_triggers, recruit_chance, resolve_encounter, roll_encounter,
    MISSING_HP_FACTOR, RECRUIT_BASE_RATE,
};
pub use types::{EncounterEntry, EncounterTable, WildSpawn};
