//! Pure PvP orchestration rules (M16, ADR-0109).
//!
//! All logic here is deterministic and I/O-free — only the imperative shell
//! in `server-module/src/pvp.rs` touches tables or the scheduler. The server
//! calls `resolve_full_turn` (already symmetric) once it has both players'
//! `PvpAction` choices; these helpers determine forfeit outcomes and deadline
//! tie-breaks so those rules live exactly once in the functional core.

use crate::combat::types::{BattleOutcome, SideId, TurnChoice};

// ===========================================================================
// PvpAction — the client-submitted choice (converts to TurnChoice)
// ===========================================================================

/// A PvP player action submitted to the server via `submit_pvp_action`.
///
/// Intentionally a strict subset of `TurnChoice` — `Pass` is server-generated
/// (e.g. when a status effect blocks the intended action) and is NEVER a valid
/// client submission.  Convert to `TurnChoice` via `into_turn_choice` before
/// passing to `resolve_full_turn`.
///
/// `SpacetimeType` is cfg-gated: the type is stored in the private `battle_action`
/// table (must-never-leak — ADR-0015, ADR-0109).  Outside the server module the
/// type is pure data for tests and the rule functions below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum PvpAction {
    /// Use a skill from the active monster's moveset.
    Attack { skill_id: u32 },
    /// Swap the active monster to a team-index slot.
    Swap { team_index: u32 },
}

impl PvpAction {
    /// Convert to the `TurnChoice` accepted by `resolve_full_turn`.
    #[must_use]
    pub fn into_turn_choice(self) -> TurnChoice {
        match self {
            PvpAction::Attack { skill_id } => TurnChoice::Attack { skill_id },
            PvpAction::Swap { team_index } => TurnChoice::Swap { team_index },
        }
    }
}

// ===========================================================================
// Forfeit rules — pure, no I/O
// ===========================================================================

/// Return the winning `BattleOutcome` when `forfeited_side` concedes.
///
/// SideA (challenger) forfeits → `SideBWins`; SideB (opponent) forfeits →
/// `SideAWins`.  No new enum variants are introduced — `Forfeited` can be
/// added additively in M17 when ranked Elo tracking requires distinguishing
/// forfeits from natural wins.
#[must_use]
pub fn pvp_forfeit_outcome(forfeited_side: SideId) -> BattleOutcome {
    match forfeited_side {
        SideId::SideA => BattleOutcome::SideBWins,
        SideId::SideB => BattleOutcome::SideAWins,
    }
}

/// Determine which side should forfeit when the turn deadline fires.
///
/// Rules (ADR-0109 D5 — challenger-first tie-break):
/// - `a_submitted` false  → side A forfeits (hasn't acted).
/// - `b_submitted` false  → side B forfeits (hasn't acted).
/// - Both false           → side A forfeits (challenger gets the tie-break
///   disadvantage so there is no incentive to not submit first).
///
/// Both true is not a valid input — the deadline should never fire when both
/// have already submitted (the resolution happens inline when the second pick
/// lands).  The caller is responsible for this invariant; passing `true, true`
/// returns `SideA` as a safe no-op (the reaper will find the battle already
/// terminal and exit cleanly).
#[must_use]
pub fn pvp_deadline_forfeit_side(a_submitted: bool, b_submitted: bool) -> SideId {
    if !a_submitted {
        SideId::SideA
    } else if !b_submitted {
        SideId::SideB
    } else {
        // Both submitted: the caller should have resolved inline; reaching here
        // is a caller-invariant violation. Return SideA as a safe no-op — the
        // reaper will find the battle already terminal and exit cleanly.
        SideId::SideA
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod pvp_tests {
    use super::*;

    // --- PvpAction::into_turn_choice ------------------------------------------

    #[test]
    fn attack_maps_to_turn_choice_attack() {
        let a = PvpAction::Attack { skill_id: 7 };
        assert_eq!(a.into_turn_choice(), TurnChoice::Attack { skill_id: 7 });
    }

    #[test]
    fn swap_maps_to_turn_choice_swap() {
        let a = PvpAction::Swap { team_index: 2 };
        assert_eq!(a.into_turn_choice(), TurnChoice::Swap { team_index: 2 });
    }

    // --- pvp_forfeit_outcome --------------------------------------------------

    #[test]
    fn side_a_forfeit_yields_side_b_wins() {
        assert_eq!(pvp_forfeit_outcome(SideId::SideA), BattleOutcome::SideBWins);
    }

    #[test]
    fn side_b_forfeit_yields_side_a_wins() {
        assert_eq!(pvp_forfeit_outcome(SideId::SideB), BattleOutcome::SideAWins);
    }

    // --- pvp_deadline_forfeit_side --------------------------------------------

    #[test]
    fn a_not_submitted_forfeits_a() {
        assert_eq!(
            pvp_deadline_forfeit_side(false, true),
            SideId::SideA,
            "a did not submit → a forfeits"
        );
    }

    #[test]
    fn b_not_submitted_forfeits_b() {
        assert_eq!(
            pvp_deadline_forfeit_side(true, false),
            SideId::SideB,
            "b did not submit → b forfeits"
        );
    }

    #[test]
    fn neither_submitted_forfeits_a_challenger_first() {
        assert_eq!(
            pvp_deadline_forfeit_side(false, false),
            SideId::SideA,
            "neither submitted → challenger (side A) forfeits (tie-break, ADR-0109 D5)"
        );
    }

    // proof-of-teeth: the function must NOT always return SideA
    #[test]
    fn teeth_b_not_submitted_does_not_return_side_a() {
        let result = pvp_deadline_forfeit_side(true, false);
        assert_ne!(
            result,
            SideId::SideA,
            "TEETH: when only B hasn't submitted, must forfeit B not A"
        );
    }

    // proof-of-teeth: pvp_forfeit_outcome must be anti-symmetric
    #[test]
    fn teeth_forfeit_outcome_anti_symmetric() {
        let a_result = pvp_forfeit_outcome(SideId::SideA);
        let b_result = pvp_forfeit_outcome(SideId::SideB);
        assert_ne!(
            a_result, b_result,
            "TEETH: forfeiting A and forfeiting B must produce different outcomes"
        );
    }

    // -------------------------------------------------------------------------
    // RT-M16-06: pvp_deadline_forfeit_side ignores b_submitted parameter.
    //
    // Finding: the implementation signature is `(a_submitted: bool, _b_submitted: bool)`
    // — the `_` prefix marks the second parameter intentionally unused. The body
    // decides purely based on `a_submitted`:
    //   if !a_submitted → SideA
    //   else             → SideB
    //
    // This works correctly for the three documented cases (A-not-submitted,
    // B-not-submitted, neither-submitted) because the caller guarantees the
    // both-submitted case never reaches the reaper. HOWEVER, the function will
    // silently return SideB for `(true, true)` instead of signalling an error,
    // and any future call site that passes `b_submitted` expecting it to be read
    // will silently get wrong results.
    //
    // This gating test documents the invariant: the function MUST behave as if
    // it reads b_submitted (i.e. the outcome for (true, false) must differ from
    // (true, true)) — once the implementation is corrected to actually inspect
    // b_submitted. Currently both of these return SideB, which means passing
    // `true, true` does NOT produce a different result from `true, false` — an
    // observable bug when the reaper fires on a race where both submitted.
    //
    // Proof-of-teeth: after the fix, `pvp_deadline_forfeit_side(true, true)`
    // should return SideA (safe no-op — neither side should be forfeited when
    // both submitted; the caller already guards this, but the function should
    // not silently forfeit B on a both-submitted call).
    // -------------------------------------------------------------------------

    #[test]
    fn rt_m16_06_both_submitted_returns_side_a_safe_noop() {
        // (true, true) — both submitted (caller-invariant violation) → SideA safe no-op.
        // (true, false) — only A submitted → SideB forfeits.
        // The results must differ: the function reads b_submitted.
        let both_submitted = pvp_deadline_forfeit_side(true, true);
        let only_a_submitted = pvp_deadline_forfeit_side(true, false);
        assert_ne!(
            both_submitted, only_a_submitted,
            "RT-M16-06: pvp_deadline_forfeit_side must read b_submitted — \
             (true, true) must return SideA (safe no-op) while (true, false) \
             returns SideB. If they are equal, b_submitted is being ignored."
        );
        assert_eq!(
            both_submitted,
            SideId::SideA,
            "RT-M16-06: (true, true) must return SideA as the safe no-op sentinel"
        );
    }
}

// ===========================================================================
// m17.5e (ADR-0126): CHALLENGE_TTL_MS + is_challenge_stale boundary suite
// (RED until the implementation is added ABOVE this test module)
//
// These tests reference `CHALLENGE_TTL_MS` and `is_challenge_stale`, which do
// NOT yet exist in this module.  The TEST BINARY will not compile until the
// implementer adds them — that is intentional (RED phase, m17.5e; the m16.5f
// trading/rules.rs precedent).  `cargo build` stays green: this module is
// #[cfg(test)]-gated and nothing outside it references the new symbols.
//
// EARS criterion 17.5e-1: a Pending battle_challenge whose age reaches
// CHALLENGE_TTL_MS SHALL be considered stale (>= boundary, saturating
// arithmetic — mirrors the is_offer_stale suite in trading/rules.rs).
//
// N2 (deliberate): these tests are VALUE-INVARIANT — they reference
// CHALLENGE_TTL_MS by name and never assert its numeric value.  Retuning the
// TTL (plan D1: tunable) must not break this suite; a constant-value mutant is
// therefore NOT killed here, by design.
// ===========================================================================

#[cfg(test)]
mod challenge_ttl_tests {
    use super::{is_challenge_stale, CHALLENGE_TTL_MS};

    /// 17.5e-1 BOUNDARY: (created=0, now=CHALLENGE_TTL_MS - 1) → false (fresh).
    ///
    /// kills: impl that uses > instead of >= flipped the other way (off-by-one
    ///        marking a challenge stale 1 ms early), or one that hardcodes a
    ///        different literal than the named constant.
    #[test]
    fn is_challenge_stale_false_one_ms_before_ttl() {
        assert!(
            !is_challenge_stale(0, CHALLENGE_TTL_MS - 1),
            "now = CHALLENGE_TTL_MS - 1 ms since creation: challenge is fresh, must return false"
        );
    }

    /// 17.5e-1 BOUNDARY: (created=0, now=CHALLENGE_TTL_MS) → true (exactly at TTL).
    ///
    /// kills: impl that uses > instead of >= — the spec says elapsed >= TTL is
    ///        stale, so at exactly TTL the challenge IS stale (plan D1).
    #[test]
    fn is_challenge_stale_true_at_exact_ttl() {
        assert!(
            is_challenge_stale(0, CHALLENGE_TTL_MS),
            "now = CHALLENGE_TTL_MS ms since creation: challenge is stale at exactly the TTL \
             boundary (>= semantics), must return true"
        );
    }

    /// 17.5e-1 BOUNDARY: (created=0, now=CHALLENGE_TTL_MS + 1) → true (past TTL).
    ///
    /// kills: impl that uses == instead of >= (accepts only the exact boundary).
    #[test]
    fn is_challenge_stale_true_past_ttl() {
        assert!(
            is_challenge_stale(0, CHALLENGE_TTL_MS + 1),
            "now = CHALLENGE_TTL_MS + 1 ms since creation: challenge is past TTL, must return true"
        );
    }

    /// 17.5e-1 CLOCK SKEW: (created=100, now=50) → false (created_at in the future).
    ///
    /// kills: impl that subtracts in the wrong direction (created - now would be
    ///        +50 here — still fresh, but the extremes tests below separate the
    ///        direction mutant), or one that treats a negative elapsed as stale.
    ///        For i64, `now.saturating_sub(created)` = -50 (NOT saturated to 0 —
    ///        i64 subtraction only saturates at the type extremes; plan F10);
    ///        a negative elapsed simply compares fresh (-50 < TTL).
    #[test]
    fn is_challenge_stale_false_on_clock_skew() {
        assert!(
            !is_challenge_stale(100, 50),
            "now (50) < created_at (100): elapsed is negative (-50), which is < TTL — \
             clock skew must never mark a fresh challenge as stale"
        );
    }

    /// 17.5e-1 EXTREMES: (i64::MIN, i64::MAX) must not panic (saturating arithmetic).
    ///
    /// kills: impl that uses unchecked `now - created` — i64::MAX - i64::MIN
    ///        overflows and panics in debug builds. With saturating_sub the
    ///        elapsed saturates at i64::MAX (>= TTL → true), but the property
    ///        pinned here is: MUST NOT PANIC.
    #[test]
    fn is_challenge_stale_no_panic_on_extreme_min_max() {
        let _ = is_challenge_stale(i64::MIN, i64::MAX);
    }

    /// 17.5e-1 EXTREMES: (i64::MAX, i64::MIN) must not panic AND must be false.
    ///
    /// kills: impl with unchecked raw subtraction (`now - created` without any
    ///        saturation or wrapping annotation) — in a debug build this panics on
    ///        overflow; in a release build it produces undefined behaviour.
    ///        Note: `i64::MIN.wrapping_sub(i64::MAX) == 1` (wrapping arithmetic
    ///        gives 1, a small positive value, not the "large positive" one might
    ///        expect), so a `wrapping_sub` impl passes this assertion and that is
    ///        ACCEPTABLE — wrapping_sub is functionally equivalent to saturating_sub
    ///        for all realistic timestamps; the raw-unchecked subtraction is the
    ///        only dangerous case and a `#[test]` env panic is what this fixture
    ///        kills (plan F10).  With saturating_sub, elapsed saturates at i64::MIN
    ///        (a huge NEGATIVE, not 0 — plan F10), which is < TTL → false.
    #[test]
    fn is_challenge_stale_no_panic_on_extreme_max_min() {
        let result = is_challenge_stale(i64::MAX, i64::MIN);
        assert!(
            !result,
            "is_challenge_stale(i64::MAX, i64::MIN): elapsed saturates at i64::MIN (negative), \
             which is < CHALLENGE_TTL_MS, must be false"
        );
    }

    /// 17.5e-1 TEETH: staleness is monotone across the boundary — the three
    /// boundary probes must not all agree (kills a constant-true / constant-false
    /// body replacement in one assertion).
    #[test]
    fn teeth_boundary_is_a_real_transition() {
        let before = is_challenge_stale(0, CHALLENGE_TTL_MS - 1);
        let at = is_challenge_stale(0, CHALLENGE_TTL_MS);
        assert_ne!(
            before, at,
            "TEETH: crossing the TTL boundary must flip the result (fresh→stale); \
             a constant-body impl returns the same value on both sides"
        );
    }
}
