//! Taming module — encounter triggering, weighted species selection,
//! and recruit-chance arithmetic (M8a). All pure and deterministic (ADR-0003).

pub mod rules;
pub mod types;

#[cfg(test)]
pub mod m8a_gating_tests;

pub use rules::{
    attempt_recruit, encounter_triggers, recruit_chance, roll_encounter, MISSING_HP_FACTOR,
};
pub use types::{EncounterEntry, EncounterTable};
