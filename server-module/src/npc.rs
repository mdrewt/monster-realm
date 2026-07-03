//! `npc` — server-module domain submodule (M12b, ADR-0056/0068).
//!
//! NPC wander tick, dialogue/conversation reducers (`talk`, `advance_dialogue`),
//! quest trigger application (`apply_quest_trigger`), and party heal (`heal_party`).
//!
//! RED STUB: this file exists only to wire `npc_tests.rs` into the test harness
//! (pattern: M8.9c `#[path]` declaration from the domain file). The implementation
//! is the implementer's responsibility.
//!
//! The three pure marshal helpers that `npc_tests.rs` calls must be added here:
//!   pub(crate) fn dialogue_state_from_db(
//!       flags_vec: Vec<String>,
//!       done_quests_vec: Vec<String>,
//!       active_quest_ids: Vec<String>,
//!   ) -> game_core::PlayerDialogueState
//!
//!   pub(crate) fn dialogue_state_flags_to_vec(
//!       state: &game_core::PlayerDialogueState,
//!   ) -> Vec<String>
//!
//!   pub(crate) fn dialogue_state_done_to_vec(
//!       state: &game_core::PlayerDialogueState,
//!   ) -> Vec<String>
//!
//! `evaluate_heal` and `HEAL_COOLDOWN_MS` live in `raising.rs` (same crate),
//! not here. `heal_party` calls them cross-module.

#[cfg(test)]
#[path = "npc_tests.rs"]
mod npc_tests;
