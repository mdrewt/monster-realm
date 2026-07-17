//! `ranking` domain-submodule tests — m17a (ADR-0119).
//!
//! Declared from `server-module/src/ranking.rs` as:
//!   `#[path = "ranking_tests.rs"] mod ranking_tests;`
//! so `super::` resolves to `ranking.rs`.
//!
//! Design: server-module/src/ranking.rs contains no ctx-free pure functions
//! (all logic delegates to game_core::apply_elo / compute_rating_update, which
//! are fully tested in game-core/src/ranking.rs). The active behavioral tests
//! for RL-7 module invariants live in pvp_tests.rs (m17a section (e)), where
//! the file is read via std::fs and the teeth are already engaged.
//!
//! This file therefore contains one lightweight test that:
//!   - Pins the RL-4 seed constant via game_core::INITIAL_RATING (SSOT).
//!   - References `super` to make the module declaration non-dormant once
//!     ranking.rs exists (the declaration itself acts as a compile gate).
//!
//! Active behavioral teeth for RL-7:
//!   See pvp_tests.rs — m17a_rl7_server_ranking_module_invariants() (runtime
//!   std::fs read, RED until ranking.rs is created).

// ---------------------------------------------------------------------------
// RL-4 seed constant pin
//
// game_core::INITIAL_RATING is the SSOT for the starting rating (ADR-0119 D1).
// get_or_init_profile must use this constant, not the literal 1000 (which is
// enforced by the pvp_tests.rs (e-iii) SSOT scan on the stripped source).
//
// This test pins the value one more time from the server-module perspective,
// confirming the game-core dependency delivers 1000.
// ---------------------------------------------------------------------------

/// RL-4 pin: game_core::INITIAL_RATING must be 1000 as seen from server-module.
///
/// Kills: a game-core change that silently redefines INITIAL_RATING to a
/// different value without triggering a review — this test catches it at the
/// server-module boundary.
#[test]
fn rl4_initial_rating_ssot_pin() {
    assert_eq!(
        game_core::INITIAL_RATING,
        1000_i32,
        "RL-4: game_core::INITIAL_RATING must be 1000 as seen from server-module. \
         get_or_init_profile seeds new profiles with this constant (ADR-0119 D1). \
         If this value changed, update the ADR and all dependent tests."
    );
}
