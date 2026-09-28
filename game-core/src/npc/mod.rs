//! NPC wander module — pure, seeded, deterministic.

pub mod rules;

#[cfg(test)]
pub mod rules_tests;

pub use rules::npc_decide;

/// Maximum Manhattan distance (tiles, INCLUSIVE) between a player and an NPC for
/// the `talk` / `advance_dialogue` reducers. The client reads the same value
/// through the `talk_range()` client-wasm export for its interact prompt; that
/// copy is latency hygiene only, the server re-validates.
pub const TALK_RANGE: i64 = 2;
