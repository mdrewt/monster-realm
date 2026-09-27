//! NPC wander module — pure, seeded, deterministic.

pub mod rules;

#[cfg(test)]
pub mod rules_tests;

pub use rules::npc_decide;
