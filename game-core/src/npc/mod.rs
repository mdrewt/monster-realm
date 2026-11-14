//! NPC wander module — pure, seeded, deterministic.

pub mod rules;

#[cfg(test)]
pub mod rules_tests;

pub use rules::npc_decide;

/// Maximum Manhattan distance (tiles, INCLUSIVE) between a player and an NPC for
/// the `talk` / `advance_dialogue` reducers, which the server checks on every
/// call. client-wasm exports the same value as `talk_range()`. The client does
/// not use it to pick a target: it offers the tile in front, then its own tile
/// (`interact_candidates`).
pub const TALK_RANGE: i64 = 2;
