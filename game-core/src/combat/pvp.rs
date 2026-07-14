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
