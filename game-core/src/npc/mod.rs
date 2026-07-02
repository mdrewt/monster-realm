//! NPC wander module — pure, seeded, deterministic (ADR-0068).

pub mod rules;

#[cfg(test)]
pub mod m12a_gating_tests;

pub use rules::npc_decide;
