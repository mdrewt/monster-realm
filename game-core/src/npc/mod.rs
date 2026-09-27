//! NPC wander module — pure, seeded, deterministic.

pub mod rules;

#[cfg(test)]
pub mod m12a_gating_tests;

pub use rules::npc_decide;
