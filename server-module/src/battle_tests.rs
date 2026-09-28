//! `battle` test module — extracted from `battle.rs`.
//!
//! Behavior-preserving relocation of the inline `#[cfg(test)] mod tests` into a
//! sibling file (matching the game-core `*_tests.rs` convention) so the
//! production module stays lean.

// the `battle` table's PRIVACY and the exact body of the
// participant-scoped `my_battle` view are pinned in
// `evolution_tests.rs::e15r_sec_a_battle_is_private_and_its_view_is_participant_scoped`,
// NOT here.
// Nothing in this file scans schema.rs; look there before adding one.

// ===========================================================================
//
// resolve_wild_battle_on_disconnect — when a player disconnects while
// in an Ongoing WILD battle, the battle must be cleaned up automatically so
// the player is not soft-locked (re-entry blocked) on reconnect.
//
// ===========================================================================

/// Minimal `Battle` row builder — mirrors `ongoing_battle` in
/// raising_tests.rs (same field set, same convention).  The `battle_id` is
/// supplied by the caller so each fixture is distinct.
fn battle_fixture(
    id: u64,
    player: spacetimedb::Identity,
    opponent: spacetimedb::Identity,
    outcome: game_core::BattleOutcome,
) -> crate::schema::Battle {
    crate::schema::Battle {
        battle_id: id,
        player_identity: player,
        opponent_identity: opponent,
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: vec![],
            },
            outcome,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: vec![],
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

// ---------------------------------------------------------------------------
// T1 — pure-core selection
//
// Proof-of-teeth: asserts is_ongoing_wild_battle returns true ONLY for the
// exact combination (player==P, opponent==WILD_IDENTITY, outcome==Ongoing).
//
// Each of the four fixture rows exercises a different rejection axis:
//   (a) true  — all three conditions met
//   (b) false — wrong opponent (PvP, not WILD)
//   (c) false — wrong outcome (terminal)
//   (d) false — wrong owner (different player Q)
//
// Kills:
//   - An impl that ignores opponent_identity (b would become true)
//   - An impl that ignores outcome (c would become true)
//   - An impl that ignores player_identity (d would become true)
//   - An always-true impl (all b/c/d assertions would fail)
//   - An always-false impl (assertion a would fail)
//   - An idempotency regression: iterating zero rows must yield no matches
//     (the empty-set arm at the end).
// ---------------------------------------------------------------------------

// EARS ptc5b-2
// PROOF-OF-TEETH: kills wrong-opponent / wrong-outcome / wrong-owner / always-true /
//                 always-false mutants of is_ongoing_wild_battle.
#[test]
fn ptc5b_1_selection_is_ongoing_wild_battle_predicate() {
    let p = spacetimedb::Identity::from_byte_array([1u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([2u8; 32]);
    let pvp_opponent = spacetimedb::Identity::from_byte_array([3u8; 32]);
    let wild = crate::WILD_IDENTITY;

    // (a) Ongoing WILD battle owned by P → must be true.
    let row_a = battle_fixture(1, p, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_ongoing_wild_battle(&row_a, p),
        "ptc5b-T1(a) FAIL: Ongoing wild battle owned by P must return true. \
         TEETH: kills any impl that ignores any of the three conditions."
    );

    // (b) Ongoing PvP battle owned by P (opponent is real identity, NOT WILD) → false.
    // Kills: an impl that ignores opponent_identity (accepts any Ongoing battle for P).
    let row_b = battle_fixture(2, p, pvp_opponent, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_ongoing_wild_battle(&row_b, p),
        "ptc5b-T1(b) FAIL: Ongoing PvP battle (non-WILD opponent) must return false. \
         TEETH: kills an impl that drops the opponent==WILD_IDENTITY check."
    );

    // (c) Terminal (Fled) WILD battle owned by P → false.
    // Kills: an impl that ignores outcome and accepts any wild battle for P.
    let row_c = battle_fixture(3, p, wild, game_core::BattleOutcome::Fled);
    assert!(
        !super::is_ongoing_wild_battle(&row_c, p),
        "ptc5b-T1(c) FAIL: Terminal (Fled) wild battle must return false. \
         TEETH: kills an impl that drops the outcome==Ongoing check."
    );

    // (d) Ongoing WILD battle owned by Q (not P) → false for P.
    // Kills: an impl that ignores player_identity and counts all wild Ongoing rows.
    let row_d = battle_fixture(4, q, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_ongoing_wild_battle(&row_d, p),
        "ptc5b-T1(d) FAIL: Ongoing wild battle owned by Q must return false for P. \
         TEETH: kills an impl that drops the player_identity check."
    );

    // Idempotency: an empty set yields no matches — the no-op / no-wild-battle case.
    // Kills: an impl that returns true from empty input (always-true).
    let empty: [crate::schema::Battle; 0] = [];
    let any_match = empty.iter().any(|b| super::is_ongoing_wild_battle(b, p));
    assert!(
        !any_match,
        "ptc5b-T1(e) FAIL: empty battle set must yield no wild matches. \
         TEETH: kills an always-true impl and documents the no-op idempotency case."
    );

    // Idempotency: a set containing only non-wild rows also yields no matches.
    let non_wild = [row_b, row_c, row_d];
    let any_non_wild = non_wild.iter().any(|b| super::is_ongoing_wild_battle(b, p));
    assert!(
        !any_non_wild,
        "ptc5b-T1(f) FAIL: set with no qualifying wild rows must yield no matches. \
         TEETH: documents idempotency — no-op when there are no wild Ongoing rows for P."
    );
}

// ---------------------------------------------------------------------------
// T2 — re-entry flip + mutation tooth
//
// This is the critical regression test.  The scenario:
//   1. Player P has an Ongoing WILD battle in the set → is_in_ongoing_battle_either_role
//      returns true (P is soft-locked from starting a new battle).
//   2. `is_ongoing_wild_battle` identifies P's wild battle ids to resolve.
//   3. The resolved rows are removed from the set (simulating the GC delete).
//   4. With those rows gone, is_in_ongoing_battle_either_role returns false (P unblocked).
//
// MUTATION TOOTH (explicit): if `is_ongoing_wild_battle` were replaced by an
// implementation that always returns false (the removed-branch mutant), then
// `to_resolve` would be empty, `remaining` would still contain P's wild row,
// and step 4's assertion (!is_locked_after) would FAIL — this test re-fails
// under that mutant.  The assertion is not tautological: it depends on the
// predicate correctly identifying P's row.
//
// Kills:
//   - The always-false predicate mutant (step 2 collects nothing → step 4 fails)
//   - An impl that resolves Q's row instead of P's (Q unblocked, P still locked)
//   - An impl that resolves only terminal rows (step 2 skips Ongoing → step 4 fails)
// ---------------------------------------------------------------------------

// EARS ptc5b-3
// PROOF-OF-TEETH: kills the removed-branch (always-false) mutant of
//                 is_ongoing_wild_battle — remaining still has P's wild row and
//                 the step-4 assertion catches the lingering soft-lock.
#[test]
fn ptc5b_2_reentry_flip_soft_lock_proof() {
    let p = spacetimedb::Identity::from_byte_array([5u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([6u8; 32]);
    let wild = crate::WILD_IDENTITY;

    // Build a mixed set: P's Ongoing wild battle + Q's Ongoing wild + a terminal.
    let row_p_wild = battle_fixture(10, p, wild, game_core::BattleOutcome::Ongoing);
    let row_q_wild = battle_fixture(11, q, wild, game_core::BattleOutcome::Ongoing);
    let row_p_terminal = battle_fixture(12, p, wild, game_core::BattleOutcome::SideAWins);

    let all_battles = [
        row_p_wild.clone(),
        row_q_wild.clone(),
        row_p_terminal.clone(),
    ];

    // Step 1: confirm P is soft-locked before resolution.
    // as_player iterator: all rows where player_identity == P.
    let is_locked_before = crate::guards::is_in_ongoing_battle_either_role(
        all_battles.iter().filter(|b| b.player_identity == p),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        is_locked_before,
        "ptc5b-T2 precondition FAIL: P must be soft-locked before disconnect resolution. \
         The player arm should fire on P's Ongoing wild battle row."
    );

    // Step 2: collect the ids to resolve using is_ongoing_wild_battle.
    // MUTATION TOOTH: if is_ongoing_wild_battle always returned false, to_resolve
    // would be empty, remaining == all_battles, and step 4 would fail.
    let to_resolve: Vec<u64> = all_battles
        .iter()
        .filter(|b| super::is_ongoing_wild_battle(b, p))
        .map(|b| b.battle_id)
        .collect();

    // Structural assertion: exactly one row is resolved (P's Ongoing wild battle).
    // Kills: an impl that resolves 0 rows (always-false) or resolves too many rows.
    assert_eq!(
        to_resolve.len(),
        1,
        "ptc5b-T2 FAIL: exactly one battle should be resolved for P (the Ongoing wild row, \
         id=10); found {} ids: {:?}. \
         TEETH: kills always-false impl (0 resolved) and over-broad impl (>1 resolved).",
        to_resolve.len(),
        to_resolve
    );
    assert_eq!(
        to_resolve[0], 10,
        "ptc5b-T2 FAIL: the resolved id must be 10 (P's Ongoing wild battle), not {}. \
         TEETH: kills an impl that resolves the wrong row (e.g. Q's row or the terminal).",
        to_resolve[0]
    );

    // Step 3: build `remaining` — the set as it would look after the GC delete.
    let remaining: Vec<_> = all_battles
        .iter()
        .filter(|b| !to_resolve.contains(&b.battle_id))
        .collect();

    // Step 4: confirm P is no longer soft-locked after removal.
    // MUTATION TOOTH (the key bite): if is_ongoing_wild_battle was always-false,
    // to_resolve would be empty, remaining would contain row_p_wild, and the
    // is_in_ongoing_battle_either_role call below would return true, failing this assertion.
    let is_locked_after = crate::guards::is_in_ongoing_battle_either_role(
        remaining.iter().filter(|b| b.player_identity == p).copied(),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        !is_locked_after,
        "ptc5b-T2 FAIL: P must NOT be soft-locked after the wild battle GC. \
         If is_ongoing_wild_battle returned false (removed-branch mutant), to_resolve \
         is empty, remaining still has P's wild row, and this assertion FAILS. \
         TEETH: this is the primary mutation kill for the predicate."
    );

    // Bonus: Q's wild row is still in remaining (only P's rows were resolved).
    let q_still_locked = crate::guards::is_in_ongoing_battle_either_role(
        remaining.iter().filter(|b| b.player_identity == q).copied(),
        std::iter::empty::<&crate::schema::Battle>(),
    );
    assert!(
        q_still_locked,
        "ptc5b-T2 FAIL: Q's Ongoing wild battle must remain after resolving P's battle — \
         the resolution must be caller-scoped to P, not a global GC of all wild battles."
    );
}

// ===========================================================================
// battle-side essence / Trust / Quality-Time credits
//
// The pure rules (`essence_battle_reward`, `day_epoch_utc`, `is_wild_battle`) are
// asserted BY VALUE here; the reducer-level behaviour (wild-only credits, the
// daily trust cap, faint penalty, evolution tail) is executed against the
// in-memory host by the `bn_` native suite at the end of this file.
// ===========================================================================

/// the essence reward FLOORS at 1, so a low-BST wild win is
/// never a zero-essence win.
///
/// kills: `bst / 30` written without the `max(1, ..)` floor — every species below
/// BST 30 would award nothing at all, making those encounters silently
/// evolution-inert.
/// Also kills a `saturating_sub`-flavoured mis-transcription that returns 0.
///
/// Values are HARDCODED, never derived from `ESSENCE_BST_DIVISOR` — a test that
/// recomputes the formula from the same constant the implementation uses proves
/// nothing about either.
#[test]
fn essence_battle_reward_floors_at_one() {
    assert_eq!(
        super::essence_battle_reward(0),
        1,
        "EG2-7: a BST of 0 must still award the floor of 1 essence, not 0. \
         TEETH: kills a bare `bst / 30` with no `max(1, ..)`."
    );
    assert_eq!(
        super::essence_battle_reward(20),
        1,
        "EG2-7: BST 20 -> 20/30 = 0, which must be floored to 1. \
         TEETH: kills a bare `bst / 30` with no `max(1, ..)`."
    );
    assert_eq!(
        super::essence_battle_reward(29),
        1,
        "EG2-7: BST 29 is the last value below the divisor and must still award 1. \
         TEETH: kills an off-by-one floor such as `max(1, ..)` applied to the wrong side."
    );
    assert_eq!(
        super::essence_battle_reward(30),
        1,
        "EG2-7: BST 30 -> exactly 1 (30/30). TEETH: kills a `+ 1` fudge that would \
         make the divisor boundary award 2, and kills a `max(1, ..)` that clamps \
         everything to 1."
    );
}

/// the essence reward SCALES with the defeated species' BST at
/// the deliberately steeper divisor, three times steeper than currency's.
///
/// kills: reusing `battle_currency_reward`'s `loser_bst / 10` rate for essence.
/// at /10 a BST-300 win yields 30, which cleared
/// every authored essence threshold in 3-5 wins (a real undertuning risk). The
/// assertions below are 10, not 30 — an aliased or copy-pasted currency formula
/// fails all three. Also kills a rounding-up variant: 318/30 is 10.6 and must
/// truncate to 10, not 11.
#[test]
fn essence_battle_reward_scales() {
    assert_eq!(
        super::essence_battle_reward(300),
        10,
        "EG2-7: BST 300 must award 10 essence (300/30). A value of 30 here means the \
         implementation reused `battle_currency_reward`'s /10 rate, which EG2-7 \
         explicitly rejects as a 3x undertuning."
    );
    assert_eq!(
        super::essence_battle_reward(318),
        10,
        "EG2-7: BST 318 (the lowest BST in shipped content) must award 10 — integer \
         division TRUNCATES 10.6 down. TEETH: kills a round-half-up or ceiling variant."
    );
    assert_eq!(
        super::essence_battle_reward(450),
        15,
        "EG2-7: BST 450 must award 15 essence (450/30). TEETH: kills a constant \
         reward that ignores the loser's BST entirely — with the two assertions \
         above, only a genuinely BST-proportional formula passes all three."
    );
}

/// the day epoch is the UTC-day index of a server timestamp,
/// and it SATURATES instead of panicking on an out-of-range clock.
///
/// `trust_favorable_battle_day_epoch` column is a `u32` and cannot hold a rolling
/// millisecond timestamp.
///
/// kills: (a) a seconds- or minutes-based divisor (86_399_999 would no longer
/// share day 0 with 0, so the once-per-day cap would fire many times per day);
/// (b) an off-by-one boundary — 86_400_000 ms is the FIRST millisecond of day 1,
/// not the last of day 0; (c) an `as u32` cast or a bare `unwrap()` on the
/// conversion, which would wrap or PANIC the whole write-back on an absurd clock
/// value instead of saturating to a day epoch no future day can exceed (a bounded
/// credit lockout — never a double credit).
#[test]
fn day_epoch_utc_maps_ms_to_day() {
    assert_eq!(super::day_epoch_utc(0), 0, "EG2-7/D4: epoch 0 ms is day 0.");
    assert_eq!(
        super::day_epoch_utc(86_399_999),
        0,
        "EG2-7/D4: the last millisecond of the first UTC day is still day 0. \
         TEETH: kills a divisor that is not 86_400_000 ms — with a seconds or \
         minutes divisor this lands in a different bucket from 0 and the \
         once-per-day Trust cap fires repeatedly within one day."
    );
    assert_eq!(
        super::day_epoch_utc(86_400_000),
        1,
        "EG2-7/D4: the first millisecond of the second UTC day is day 1. \
         TEETH: kills an off-by-one boundary (`>=` vs `>` inside the division, or a \
         `- 1` correction) that would merge two calendar days into one epoch."
    );
    assert_eq!(
        super::day_epoch_utc(172_800_000),
        2,
        "EG2-7/D4: two whole days of milliseconds is day 2 — a second scale point so \
         a constant-returning implementation cannot pass."
    );
    // Saturation, not panic. `i64::MAX / 86_400_000` is ~1.07e11, far beyond u32.
    assert_eq!(
        super::day_epoch_utc(i64::MAX),
        u32::MAX,
        "EG2-7/D4: an absurd forward clock must SATURATE to u32::MAX, not wrap and \
         not panic. `i64::MAX / 86_400_000` is about 1.07e11, well past u32::MAX; \
         an `as u32` cast wraps to an arbitrary small day (re-enabling repeat \
         credits) and a bare `unwrap()` panics the entire battle write-back. \
         TEETH: this assertion is the one that distinguishes \
         `u32::try_from(..).unwrap_or(u32::MAX)` from both."
    );
    // A backwards clock is representable (`now_ms` is server-injected).
    assert_eq!(
        super::day_epoch_utc(-1),
        0,
        "EG2-7/D4: -1 ms truncates toward zero, so it is still day 0 — no panic."
    );
    assert_eq!(
        super::day_epoch_utc(-86_400_000),
        u32::MAX,
        "EG2-7/D4: a negative day index has no u32 representation and must saturate \
         to u32::MAX — the MAXIMUM epoch, so `day > stored` is false and a rewound \
         clock produces a bounded lockout rather than a credit. TEETH: kills an \
         `unwrap_or(0)` default, which would make every monster instantly \
         re-creditable after a clock rewind (and kills `unwrap()`, which panics)."
    );
}

/// `is_wild_battle` is TRUE for wild battles and for nothing
/// else: it is the single predicate that exempts BOTH practice and PvP.
///
/// kills:
///   * an `opponent_identity != player_identity` formulation (practice would be
///     correctly false, but a PvP battle — a genuine third identity — would read
///     as WILD and two colluding accounts could farm essence + Trust through
///     repeated `challenge_pvp` rematches,
///     and there is no rematch cooldown in `pvp.rs`);
///   * an always-true impl (the practice and PvP cases below fail);
///   * an always-false impl (the wild cases fail);
///   * copying `is_ongoing_wild_battle`'s shape, which ALSO requires
///     `outcome == Ongoing` and takes a player argument. That predicate is right
///     for disconnect GC and WRONG here: the faint penalty must credit on ANY
///     wild outcome — a loss, a flee, and the disconnect write-back path — so the
///     terminal-outcome rows below must still read as wild.
#[test]
fn is_wild_battle_true_only_for_wild_identity() {
    let p = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let q = spacetimedb::Identity::from_byte_array([8u8; 32]);
    let wild = crate::WILD_IDENTITY;

    let wild_row = battle_fixture(20, p, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_wild_battle(&wild_row),
        "EG2-7: a battle whose opponent is WILD_IDENTITY IS a wild battle. \
         TEETH: kills an always-false impl."
    );

    // Practice = the self-vs-self sandbox: player == opponent.
    let practice_row = battle_fixture(21, p, p, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_wild_battle(&practice_row),
        "EG2-7: a PRACTICE battle (player_identity == opponent_identity) must NOT be \
         wild — practice is exempt from essence, Trust and Quality-Time credit, \
         mirroring the existing practice-XP exemption."
    );

    // PvP = a genuine third identity.
    let pvp_row = battle_fixture(22, p, q, game_core::BattleOutcome::Ongoing);
    assert!(
        !super::is_wild_battle(&pvp_row),
        "EG2-7: a PvP battle (opponent is another player's identity) must NOT be \
         wild. TEETH: this is the assertion an `opponent != player` implementation \
         fails — that spelling exempts practice but hands two colluding accounts \
         unlimited essence and Trust through repeated PvP rematches (no rematch \
         cooldown exists in pvp.rs)."
    );

    // Outcome-independence: the faint penalty credits on ANY wild outcome.
    for outcome in [
        game_core::BattleOutcome::SideAWins,
        game_core::BattleOutcome::SideBWins,
        game_core::BattleOutcome::Fled,
    ] {
        let terminal = battle_fixture(23, p, wild, outcome);
        assert!(
            super::is_wild_battle(&terminal),
            "EG2-7: a TERMINAL wild battle is still a wild battle. \
             TEETH: kills an implementation copied from `is_ongoing_wild_battle`, \
             which also demands `outcome == Ongoing`. The faint penalty must apply \
             on a loss, on a flee, and on the disconnect write-back path — all of \
             which reach this function with a non-Ongoing outcome."
        );
    }

    // Owner-independence: unlike `is_ongoing_wild_battle`, there is no player arg.
    let other_owner = battle_fixture(24, q, wild, game_core::BattleOutcome::Ongoing);
    assert!(
        super::is_wild_battle(&other_owner),
        "EG2-7: wildness is a property of the ROW, not of who is asking — the \
         predicate takes no player argument. TEETH: documents the deliberate \
         difference from `is_ongoing_wild_battle`."
    );
}

// ===========================================================================
// THE `battle` ANONYMIZE STEP.
//
// WHY `battle` IS THE ONE GENUINE IDENTITY-SWAP CASE: unlike
// `trade_offer` and `battle_challenge`, terminal `battle` rows demonstrably
// PERSIST — settle updates the row, it never deletes it, and the GC is lazy — so
// a surviving opponent's `my_battle` view can still resolve a row naming the
// deleted party months later.
//
// WHY THE TOMBSTONE MUST NOT BE ZERO: `WILD_IDENTITY` is the all-zero identity,
// and `guards.rs` classifies a battle as WILD by `opponent_identity !=
// WILD_IDENTITY`. A zero-valued tombstone would silently reclassify every
// anonymized PvP battle as a wild one. The value therefore comes from
// game-core's `TOMBSTONE_IDENTITY_BYTES` and is pinned distinct from
// `WILD_IDENTITY` here as well as at its declaration.
//
// ===========================================================================

/// A `battle` row with DISTINCT mechanical fields, so a constructor that
/// rebuilt the row instead of swapping one column is visible.
///
/// `battle_fixture` (this file) supplies the empty-team `BattleState`;
/// the spread adds party ids, opponent ids and a creation stamp that a
/// field-by-field comparison can actually catch a change in.
fn m22s3b_battle_row(
    id: u64,
    player: spacetimedb::Identity,
    opponent: spacetimedb::Identity,
) -> crate::schema::Battle {
    crate::schema::Battle {
        party_monster_ids: vec![11, 22, 33],
        opponent_monster_ids: vec![44],
        created_at_ms: 1_700_000_000_123,
        ..battle_fixture(id, player, opponent, game_core::BattleOutcome::SideAWins)
    }
}

/// Assert that every field of a swapped `battle` row EXCEPT the two identity
/// columns is byte-identical to the row that went in.
///
/// Factored out because it is asserted on FIVE rows and a copy-paste of ten
/// clauses five times is where one of them quietly goes missing. `Battle` derives
/// no `PartialEq`, so the comparison is field by field on purpose — and that is
/// the better shape anyway: a whole-struct compare names only the first
/// divergence, while these clauses name WHICH mechanical fact the anonymize
/// destroyed.
fn m22s3b_assert_mechanical_fields_intact(
    label: &str,
    before: &crate::schema::Battle,
    after: &crate::schema::Battle,
) {
    assert_eq!(
        after.battle_id, before.battle_id,
        "[m22s3b/battle-pk] {label}: the PRIMARY KEY must not move. The anonymize is a \
         PK-keyed update of a SURVIVING row (spec §3), not a delete-and-reinsert: a new \
         battle_id orphans `battle_wild` and every `battle_action` keyed to the old one, and \
         the surviving opponent's `my_battle` subscription sees the terminal row vanish."
    );
    assert_eq!(
        after.party_monster_ids, before.party_monster_ids,
        "[m22s3b/battle-party-ids] {label}: `party_monster_ids` is a MECHANICAL field and must \
         survive verbatim. Spec §3 says to swap the identity column and leave every \
         mechanical field untouched — the surviving opponent's record of what was fought is \
         not the deleted player's personal data to remove."
    );
    assert_eq!(
        after.opponent_monster_ids, before.opponent_monster_ids,
        "[m22s3b/battle-opponent-ids] {label}: `opponent_monster_ids` must survive verbatim — \
         and on a side-B swap these are the SURVIVING player's own monsters."
    );
    assert_eq!(
        after.created_at_ms, before.created_at_ms,
        "[m22s3b/battle-created] {label}: `created_at_ms` must survive verbatim."
    );
    assert_eq!(
        after.state.outcome, before.state.outcome,
        "[m22s3b/battle-outcome] {label}: the settled OUTCOME must survive. Rewriting it \
         would silently rewrite ranked history for the surviving opponent, whose profile \
         rating was computed from it."
    );
    assert_eq!(
        after.state.turn_number, before.state.turn_number,
        "[m22s3b/battle-turn] {label}: `turn_number` must survive verbatim."
    );
    assert_eq!(
        after.state.side_a.active, before.state.side_a.active,
        "[m22s3b/battle-side-a-active] {label}: side A's lead index must survive verbatim."
    );
    assert_eq!(
        after.state.side_b.active, before.state.side_b.active,
        "[m22s3b/battle-side-b-active] {label}: side B's lead index must survive verbatim."
    );
    assert_eq!(
        after.state.side_a.team.len(),
        before.state.side_a.team.len(),
        "[m22s3b/battle-side-a-team] {label}: side A's team must survive verbatim."
    );
    assert_eq!(
        after.state.side_b.team.len(),
        before.state.side_b.team.len(),
        "[m22s3b/battle-side-b-team] {label}: side B's team must survive verbatim."
    );
}

/// `battle_with_tombstoned_party` swaps EVERY side that names the deleting
/// identity, and nothing else.
///
/// FIVE ROWS, EACH KILLING A DIFFERENT WRONG IMPLEMENTATION:
///   1. side A only — the deleting player is `player_identity`.
///   2. side B only — the deleting player is `opponent_identity`. A helper that
///      only ever rewrites `player_identity` passes row 1 and leaves every
///      battle the deleted player was CHALLENGED INTO naming them forever.
///   3. PRACTICE, both sides — `player_identity == opponent_identity`. This is
///      the row is collected ONCE (the caller dedups by construction)
///      and this pure seam swaps BOTH sides in that single visit. A helper that
///      swaps only the first matching side leaves the practice battle
///      half-tombstoned, and one that relies on being called twice re-writes a
///      row the caller only collected once.
///   4. WILD — the opponent is `WILD_IDENTITY`, which must NOT be touched. It is
///      the all-zero sentinel that marks the row as a wild battle; overwriting
///      it with the tombstone reclassifies a settled wild battle as PvP.
///   5. NON-PARTICIPANT — neither side is the deleting identity, so nothing
///      moves. This is what kills an unconditional `player_identity = tombstone`
///      body, which passes rows 1 and 3 and destroys every other player's row.
///
/// THE SENTINEL IS DISTINCT FROM `WILD_IDENTITY`, asserted here as a
/// precondition rather than assumed: if the two were ever equal, row 4's
/// assertion would be satisfied by the wrong reason and the whole
/// wild-reclassification argument would be vacuous.
///
/// Kills: a `player_identity`-only swap; an `opponent_identity`-only swap; a
///        practice row visited half-way; a swap that clobbers `WILD_IDENTITY`;
///        an unconditional overwrite that ignores `deleting`; any mechanical
///        field rewritten (ten separate clauses, each naming what it destroys).
#[test]
fn m22s3b_battle_tombstone_truth_table() {
    let deleting = spacetimedb::Identity::from_byte_array([61u8; 32]);
    let survivor = spacetimedb::Identity::from_byte_array([62u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tombstone = crate::TOMBSTONE_IDENTITY;

    assert_ne!(
        tombstone, wild,
        "[m22s3b/battle-sentinel-distinct] TOMBSTONE_IDENTITY must NOT equal WILD_IDENTITY. \
         `guards.rs` classifies a battle as WILD by `opponent_identity != WILD_IDENTITY`, so \
         a zero-valued tombstone reclassifies every anonymized PvP battle as a wild one and \
         silently rewrites settled ranked history. If these two are equal, row 4 below passes \
         for the wrong reason and proves nothing."
    );
    assert_ne!(
        tombstone, deleting,
        "[m22s3b/battle-sentinel-fixture] the sentinel must differ from the fixture's \
         deleting identity, or the swap assertions could not tell a swap from a no-op."
    );

    // --- ROW 1: side A ------------------------------------------------------
    let before = m22s3b_battle_row(101, deleting, survivor);
    let after = super::battle_with_tombstoned_party(before.clone(), deleting, tombstone);
    assert_eq!(
        after.player_identity, tombstone,
        "[m22s3b/battle-side-a] the deleting party on side A must be swapped to the tombstone."
    );
    assert_eq!(
        after.opponent_identity, survivor,
        "[m22s3b/battle-side-a-survivor] the SURVIVING opponent's identity must be left \
         alone. Spec §3 is explicit: swap the deleting party's column, leave the opponent's \
         side and every mechanical field untouched — the row belongs to the survivor too."
    );
    m22s3b_assert_mechanical_fields_intact("side-A swap", &before, &after);

    // --- ROW 2: side B ------------------------------------------------------
    let before = m22s3b_battle_row(102, survivor, deleting);
    let after = super::battle_with_tombstoned_party(before.clone(), deleting, tombstone);
    assert_eq!(
        after.opponent_identity, tombstone,
        "[m22s3b/battle-side-b] the deleting party on side B must be swapped too. A helper \
         that only ever rewrites `player_identity` passes row 1 and leaves every battle the \
         deleted player was CHALLENGED INTO naming them forever — and `battle` has TWO \
         indexed identity columns precisely because both roles are real."
    );
    assert_eq!(
        after.player_identity, survivor,
        "[m22s3b/battle-side-b-survivor] the surviving challenger's identity must be left \
         alone."
    );
    m22s3b_assert_mechanical_fields_intact("side-B swap", &before, &after);

    // --- ROW 3: PRACTICE, both sides, ONE call --------------------
    let before = m22s3b_battle_row(103, deleting, deleting);
    let after = super::battle_with_tombstoned_party(before.clone(), deleting, tombstone);
    assert_eq!(
        after.player_identity, tombstone,
        "[m22s3b/battle-practice-a] PRV1-19: in a PRACTICE battle both sides are the deleting \
         identity, and BOTH must be swapped in the ONE visit the caller makes. The caller \
         dedups by construction (`player_identity` filter, then `opponent_identity` filter \
         excluding rows already matched — the `my_battle` idiom), so this row is collected \
         exactly once and a seam that swaps only the first matching side leaves it \
         half-tombstoned forever."
    );
    assert_eq!(
        after.opponent_identity, tombstone,
        "[m22s3b/battle-practice-b] PRV1-19: the second side of the practice battle must be \
         swapped in the SAME call. A seam that relies on being invoked twice cannot work — \
         the caller only visits the row once, and visiting it twice is the double-visit \
         PRV1-19 forbids by name."
    );
    m22s3b_assert_mechanical_fields_intact("practice both-sides swap", &before, &after);

    // --- ROW 4: WILD opponent stays WILD ------------------------------------
    let before = m22s3b_battle_row(104, deleting, wild);
    let after = super::battle_with_tombstoned_party(before.clone(), deleting, tombstone);
    assert_eq!(
        after.player_identity, tombstone,
        "[m22s3b/battle-wild-player] the player side of a wild battle is still swapped."
    );
    assert_eq!(
        after.opponent_identity, wild,
        "[m22s3b/battle-wild-opponent] the WILD sentinel must survive untouched. It is the \
         all-zero identity that marks the row as a wild battle, and `guards.rs` tests \
         `opponent_identity != WILD_IDENTITY` in two places; overwriting it with the \
         tombstone turns a settled wild battle into a settled PvP battle against a \
         non-existent player. The seam must swap only sides that MATCH `deleting`."
    );
    m22s3b_assert_mechanical_fields_intact("wild-row player swap", &before, &after);

    // --- ROW 5: NON-PARTICIPANT is untouched --------------------------------
    let other = spacetimedb::Identity::from_byte_array([63u8; 32]);
    let before = m22s3b_battle_row(105, survivor, other);
    let after = super::battle_with_tombstoned_party(before.clone(), deleting, tombstone);
    assert_eq!(
        after.player_identity, survivor,
        "[m22s3b/battle-bystander-a] a battle the deleting identity is not part of must be \
         returned UNCHANGED. This row is what kills an unconditional \
         `player_identity = tombstone` body: it passes rows 1 and 3 and quietly rewrites \
         every other player's settled history."
    );
    assert_eq!(
        after.opponent_identity, other,
        "[m22s3b/battle-bystander-b] the bystander's opponent column is untouched too."
    );
    m22s3b_assert_mechanical_fields_intact("non-participant", &before, &after);
}

// ===========================================================================
// the deletion cascade forces a still-Ongoing battle terminal against the
// erased side.
//
// The `rb129_*` tests execute the seam `battle_with_forced_terminal`, the
// tombstone seam and the SSOT wild predicate by value over constructed rows: a
// deterministic totality matrix plus a seeded property test. The shell
// `anonymize_battles` itself runs against the in-memory host in
// `bn_anonymize_battles_scrubs_both_roles`.
// ===========================================================================

// ---------------------------------------------------------------------------
// pure seam tests. These call `super::battle_with_forced_terminal`
// directly.
// ---------------------------------------------------------------------------

/// A combatant for the fixtures, with distinct non-default stats so a
/// seam that rebuilt a team instead of passing it through is visible to the
/// whole-state comparison. A `current_hp` of 0 makes it fainted.
fn rb129_mon(species_id: u32, current_hp: u16) -> game_core::BattleMonster {
    game_core::BattleMonster {
        species_id,
        affinity: game_core::Affinity::Water,
        level: 12,
        current_hp,
        max_hp: 40,
        stats: game_core::StatBlock {
            hp: 40,
            attack: 21,
            defense: 19,
            speed: 17,
            sp_attack: 23,
            sp_defense: 18,
        },
        known_skill_ids: vec![1, 2],
        status: None,
    }
}

/// `rb129_mon` carrying a status condition: the member a seam keyed on
/// `status.is_some()` would skip, and the field a tombstone seam that clears
/// statuses would destroy.
fn rb129_mon_with(
    species_id: u32,
    current_hp: u16,
    status: game_core::StatusEffect,
) -> game_core::BattleMonster {
    game_core::BattleMonster {
        status: Some(status),
        ..rb129_mon(species_id, current_hp)
    }
}

/// The six team shapes the totality matrix crosses on EACH side, one per lead
/// or roster fact a wrong seam could key a skip on:
/// - `empty`: no members, `active` 0;
/// - `solo`: one conscious member at `active` 0;
/// - `pending-swap`: the lead at `active` 0 FAINTED while index 1 is conscious
///   (the state a side sits in between a faint and its swap);
/// - `one-living`: a conscious lead at `active` 1 behind a fainted member;
/// - `all-fainted`: every member fainted, `active` 1;
/// - `status-bearing`: every member carrying a status condition (sleep with
///   turns left, burn, poison), the last of them fainted.
fn rb129_team_shapes() -> [(&'static str, game_core::BattleSide); 6] {
    let sleep = game_core::StatusEffect::Sleep { turns_remaining: 2 };
    [
        (
            "empty",
            game_core::BattleSide {
                active: 0,
                team: vec![],
            },
        ),
        (
            "solo",
            game_core::BattleSide {
                active: 0,
                team: vec![rb129_mon(105, 30)],
            },
        ),
        (
            "pending-swap",
            game_core::BattleSide {
                active: 0,
                team: vec![rb129_mon(106, 0), rb129_mon(107, 30)],
            },
        ),
        (
            "one-living",
            game_core::BattleSide {
                active: 1,
                team: vec![rb129_mon(101, 0), rb129_mon(102, 30)],
            },
        ),
        (
            "all-fainted",
            game_core::BattleSide {
                active: 1,
                team: vec![rb129_mon(103, 0), rb129_mon(104, 0)],
            },
        ),
        (
            "status-bearing",
            game_core::BattleSide {
                active: 0,
                team: vec![
                    rb129_mon_with(108, 30, sleep),
                    rb129_mon_with(109, 12, game_core::StatusEffect::Burn),
                    rb129_mon_with(110, 0, game_core::StatusEffect::Poison),
                ],
            },
        ),
    ]
}

/// the `m22s3b_battle_row` shape (distinct party ids, opponent
/// ids and creation stamp) PLUS non-default mechanical fields — turn 7, active
/// weather, non-empty teams and a non-zero `active` on both sides — so a seam
/// that rewrote anything but `state.outcome` shows up in the whole-state
/// comparison.
fn rb129_row(
    id: u64,
    player: spacetimedb::Identity,
    opponent: spacetimedb::Identity,
    outcome: game_core::BattleOutcome,
) -> crate::schema::Battle {
    crate::schema::Battle {
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 1,
                team: vec![rb129_mon(1, 0), rb129_mon(2, 30)],
            },
            side_b: game_core::BattleSide {
                active: 2,
                team: vec![rb129_mon(3, 25), rb129_mon(4, 0), rb129_mon(5, 40)],
            },
            outcome,
            turn_number: 7,
            weather: Some(game_core::combat::WeatherEffect::Rain { turns_remaining: 3 }),
        },
        ..m22s3b_battle_row(id, player, opponent)
    }
}

/// Assert the forced-terminal seam's verdict on ONE row: the outcome is `want`,
/// and EVERYTHING else — both identity columns, every mechanical field, the
/// weather and the team contents — is exactly what went in.
///
/// Composes the existing `m22s3b_assert_mechanical_fields_intact` (against the
/// input row with only its outcome replaced) rather than re-listing fields, and
/// adds the whole-`BattleState` equality that helper does not make: it compares
/// team LENGTHS only and never reads the weather. `why` says what a wrong
/// outcome on this row means, so each failure names its wrong implementation.
fn rb129_assert_row(
    label: &str,
    why: &str,
    before: &crate::schema::Battle,
    after: &crate::schema::Battle,
    want: game_core::BattleOutcome,
) {
    let got = after.state.outcome;
    assert_eq!(
        got, want,
        "rb-129 E1 FAIL (outcome) {label}: the forced-terminal seam returned {got:?}; this \
         row must come back {want:?}. {why}"
    );
    let expected = crate::schema::Battle {
        state: game_core::BattleState {
            outcome: want,
            ..before.state.clone()
        },
        ..before.clone()
    };
    m22s3b_assert_mechanical_fields_intact(label, &expected, after);
    assert_eq!(
        after.state, expected.state,
        "rb-129 E1 FAIL (state intact) {label}: the seam rewrote part of the battle state \
         other than its outcome. ADR-0274 D1 lets it write `state.outcome` and NOTHING \
         else: the weather, both teams (members, HP, stats, status) and both lead indices \
         are the survivor's record of the fight. The mechanical-field helper compares team \
         LENGTHS only and never reads the weather, which is why this clause exists."
    );
    assert_eq!(
        after.player_identity, before.player_identity,
        "rb-129 E1 FAIL (identities untouched) {label}: the seam moved `player_identity`. \
         It must never touch an identity column: the swap is the tombstone seam's job, runs \
         AFTER this one, and needs the original identities to find the owner's side. A seam \
         that also tombstones breaks the every-field-survives contract of both seams."
    );
    assert_eq!(
        after.opponent_identity, before.opponent_identity,
        "rb-129 E1 FAIL (identities untouched) {label}: the seam moved `opponent_identity` \
         — on a wild row that is the all-zero sentinel that classifies the row as wild."
    );
}

/// the forced-terminal seam ends EVERY Ongoing row that names the erased
/// identity, with that side's forfeit (or, for a wild row, an auto-flee), and
/// touches nothing else.
///
/// - side A names the erased identity: side A forfeits, side B wins;
/// - side B names it: side B forfeits, side A wins;
/// - PRACTICE, both sides name it: side A's forfeit, because
///   `forfeit_on_disconnect` runs its side-A pass first;
/// - an Ongoing WILD row: `Fled` recognised by the
///   SSOT predicate and checked before the player column;
/// - the counterparty is the TOMBSTONE (a player erased earlier): still a real
///   PvP side, so the erased side forfeits exactly as against a live survivor.
///
/// (a) PRECONDITIONS, asserted rather than assumed: the four identities are
/// pairwise distinct (otherwise a forced row and an untouched one, or a swapped
/// identity and an intact one, are indistinguishable), and game-core's forfeit
/// rule maps side A to a side-B win and side B to a side-A win — the literals
/// below are that rule's output, not a second copy of it.
///
/// (b) BASELINE: the six sides (turn 7, rain, non-empty
/// teams, non-zero `active`), with every mechanical field, the whole
/// `BattleState` bar its outcome, and both identity columns asserted unchanged.
/// The wild row is production-shaped: a party on side A and NO opponent ids,
/// because a wild opponent has no `monster` row.
///
/// (c) THE TOTALITY MATRIX each of the six sides is crossed with, independently:
/// turn number 0, 1, 7 and `u16::MAX`; each side's team as one of the six
/// `rb129_team_shapes`; a creation stamp of zero or real; party ids empty or
/// some AND opponent ids empty or some, as two separate axes; no weather or each
/// of the four weather variants (one with zero turns left); and a battle id of
/// 1, 1290 or `u64::MAX`. That is 6 x 4 x 36 x 2 x 2 x 2 x 5 x 3 = 103680 rows,
/// the count asserted at the end, each failure labelled with its parameters.
///
/// Kills:
/// - a skip keyed on turn 0, a zero creation stamp, or empty ids;
/// - A1: a skip keyed on a pending swap (lead fainted, bench conscious);
/// - A2: a skip keyed on any member carrying a status condition;
/// - A3a / A3b: a tombstone counterparty answered with `Fled`, or with an early
///   return that leaves a row naming the erased identity Ongoing;
/// - A4: a skip keyed on a small battle id;
/// - A5: a wild test widened to fire on any row with a party and no opponent
///   ids, which answers a PvP row with `Fled`;
/// - A6: a skip keyed on one weather variant;
/// - a uniform forfeit that ignores the wild case (the wild row reads a win);
/// - `Fled` for every row (the PvP survivor is told they fled);
/// - side A and side B swapped;
/// - practice resolved opponent-column-first (it reads a side-A win);
/// - a seam that also tombstones, or otherwise rewrites an identity column;
/// - a seam that rewrites any field on the axes above, or the teams' contents.
///
/// NOT CLAIMED: a skip keyed on a value no axis above takes (a particular
/// species, HP value or lead index); the seeded property test samples those.
#[test]
fn rb129_forced_terminal_ends_every_ongoing_row_naming_the_erased_identity() {
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;
    let ongoing = game_core::BattleOutcome::Ongoing;

    // --- (a) preconditions, asserted rather than assumed --------------------
    let named = [("d", d), ("s", s), ("WILD", wild), ("TOMBSTONE", tomb)];
    for (i, (name_a, id_a)) in named.iter().enumerate() {
        for (name_b, id_b) in &named[i + 1..] {
            assert_ne!(
                id_a, id_b,
                "rb-129 E1 FAIL (precondition): the fixture identities {name_a} and \
                 {name_b} are equal. Every verdict below depends on them differing — a \
                 forced row and an untouched one, or a swapped identity and an intact \
                 one, would otherwise be indistinguishable."
            );
        }
    }
    let forfeits = (
        game_core::pvp_forfeit_outcome(game_core::SideId::SideA),
        game_core::pvp_forfeit_outcome(game_core::SideId::SideB),
    );
    assert_eq!(
        forfeits,
        (
            game_core::BattleOutcome::SideBWins,
            game_core::BattleOutcome::SideAWins,
        ),
        "rb-129 E1 FAIL (precondition): game-core's forfeit rule no longer maps a side-A \
         forfeit to a side-B win and a side-B forfeit to a side-A win. The expected \
         outcomes below are that rule's output written out; if the rule changed \
         deliberately, re-derive them from ADR-0109 D8 and ADR-0274 D1 in the same change."
    );

    // --- (b) the six baseline rows --------------------
    let sides = [
        (
            "side A (d vs s)",
            d,
            s,
            game_core::BattleOutcome::SideBWins,
            "Side A names the erased identity, so side A forfeits and side B wins \
             (ADR-0109 D8). A side-A win here is the A/B swap; Fled tells a PvP survivor \
             they fled; Ongoing is the retired skip.",
        ),
        (
            "side B (s vs d)",
            s,
            d,
            game_core::BattleOutcome::SideAWins,
            "Side B names the erased identity, so side B forfeits and side A wins. A \
             side-B win here is the A/B swap, or a uniform side-A forfeit that ignores \
             which column holds the erased identity.",
        ),
        (
            "practice (d vs d)",
            d,
            d,
            game_core::BattleOutcome::SideBWins,
            "A PRACTICE row names the erased identity on BOTH sides. The side-A pass runs \
             first, exactly as in the disconnect forfeit, so it is side A's forfeit and \
             side B wins. A side-A win here is a seam that tests the opponent column \
             before the player column.",
        ),
        (
            "wild (d vs WILD)",
            d,
            wild,
            game_core::BattleOutcome::Fled,
            "An Ongoing WILD row is auto-fled (ADR-0138 D2 parity) through the SSOT \
             predicate, checked FIRST. A side-B win here is a uniform forfeit that treats \
             the wild sentinel as a PvP survivor, or a player-column check placed before \
             the wild check.",
        ),
        (
            "tombstone B (d vs TOMBSTONE)",
            d,
            tomb,
            game_core::BattleOutcome::SideBWins,
            "Side A names the erased identity and side B is the TOMBSTONE, a player erased \
             earlier and still a real PvP side, so side A forfeits and side B wins. Fled \
             here treats the tombstone as a wild sentinel (A3a); Ongoing is an early return \
             on a tombstone counterparty (A3b), which leaves a live row naming the erased \
             identity.",
        ),
        (
            "tombstone A (TOMBSTONE vs d)",
            tomb,
            d,
            game_core::BattleOutcome::SideAWins,
            "Side B names the erased identity and side A is the TOMBSTONE, so side B \
             forfeits and side A wins. Fled here is A3a; Ongoing is A3b.",
        ),
    ];
    for (i, (side, player, opponent, want, why)) in sides.iter().enumerate() {
        let label = format!("[baseline {side}]");
        let mut before = rb129_row(1290 + i as u64, *player, *opponent, ongoing);
        if *opponent == wild {
            // Production-shaped: a wild opponent has no `monster` row, so a wild
            // battle stores a party and NO opponent ids (the A5 blind spot).
            before.opponent_monster_ids = Vec::new();
        }
        let after = super::battle_with_forced_terminal(before.clone(), d);
        rb129_assert_row(&label, why, &before, &after, *want);
    }

    // --- (c) THE TOTALITY MATRIX ---
    let shapes = rb129_team_shapes();
    let mut team_pairs = Vec::new();
    for (label_a, side_a) in &shapes {
        for (label_b, side_b) in &shapes {
            let label = format!("team_a={label_a} team_b={label_b}");
            team_pairs.push((label, side_a.clone(), side_b.clone()));
        }
    }
    let weathers = [
        None,
        Some(game_core::combat::WeatherEffect::Rain { turns_remaining: 3 }),
        Some(game_core::combat::WeatherEffect::Sun { turns_remaining: 1 }),
        Some(game_core::combat::WeatherEffect::Sandstorm { turns_remaining: 5 }),
        Some(game_core::combat::WeatherEffect::Hail { turns_remaining: 0 }),
    ];
    let party_sets: [Vec<u64>; 2] = [Vec::new(), vec![11, 22, 33]];
    let opponent_sets: [Vec<u64>; 2] = [Vec::new(), vec![44]];
    let mut field_sets = Vec::new();
    for created_at_ms in [0i64, 1_700_000_000_123] {
        for party in &party_sets {
            for opp in &opponent_sets {
                for weather in weathers {
                    for battle_id in [1u64, 1290, u64::MAX] {
                        let label = format!(
                            "created_at_ms={created_at_ms} party_ids={party:?} \
                             opponent_ids={opp:?} weather={weather:?} battle_id={battle_id}"
                        );
                        field_sets.push((
                            label,
                            created_at_ms,
                            party.clone(),
                            opp.clone(),
                            weather,
                            battle_id,
                        ));
                    }
                }
            }
        }
    }
    assert_eq!(
        (sides.len(), team_pairs.len(), field_sets.len()),
        (6, 36, 120),
        "rb-129 E1 FAIL (matrix non-vacuity): the matrix axes must hold 6 sides, 36 team \
         pairs and 120 field sets; a collapsed axis silently drops the rows a skip could \
         hide in."
    );
    let why_matrix = "The matrix varies ONLY fields the forced-terminal rule does not read — \
                      turn number, both teams, creation stamp, party ids, opponent ids, \
                      weather and battle id — on every side. A wrong outcome on ONE \
                      combination is a seam that keys a skip, or a different verdict, on \
                      that combination.";
    let mut n_rows = 0usize;
    for (side, player, opponent, want, _) in &sides {
        for turn in [0u16, 1, 7, u16::MAX] {
            for (teams, side_a, side_b) in &team_pairs {
                for (fields, created_at_ms, party, opp, weather, battle_id) in &field_sets {
                    n_rows += 1;
                    let label = format!("[matrix side={side} turn={turn} {teams} {fields}]");
                    let before = crate::schema::Battle {
                        battle_id: *battle_id,
                        player_identity: *player,
                        opponent_identity: *opponent,
                        state: game_core::BattleState {
                            side_a: side_a.clone(),
                            side_b: side_b.clone(),
                            outcome: ongoing,
                            turn_number: turn,
                            weather: *weather,
                        },
                        party_monster_ids: party.clone(),
                        opponent_monster_ids: opp.clone(),
                        created_at_ms: *created_at_ms,
                    };
                    let after = super::battle_with_forced_terminal(before.clone(), d);
                    assert_ne!(
                        after.state.outcome, ongoing,
                        "rb-129 E1 FAIL (totality) {label}: the seam left an Ongoing row \
                         that names the erased identity Ongoing. EVERY such row must come \
                         back terminal whatever its mechanical fields: a wrong seam that \
                         skipped turn-0 rows was MEASURED passing the whole suite before \
                         this matrix existed. A row left Ongoing survives the cascade \
                         settleable by the erased identity — its wallet and \
                         evolution-notice rows re-minted by a PvP action, or the win and \
                         a ranking profile handed to it by the kept deadline reaper."
                    );
                    rb129_assert_row(&label, why_matrix, &before, &after, *want);
                }
            }
        }
    }
    assert_eq!(
        n_rows, 103_680,
        "rb-129 E1 FAIL (matrix non-vacuity): the matrix ran {n_rows} rows; its axes \
         multiply to 6 sides x 4 turns x 36 team pairs x 120 field sets = 103680. A loop \
         that exits early is a matrix that looked nowhere."
    );
}

/// the forced-terminal seam returns settled rows, and live rows the erased
/// identity is not part of, UNCHANGED.
///
/// Settled history is never rewritten: the survivor's rating and record were
/// computed from it. A bystander's live battle is not the erased identity's to
/// end.
///
/// TEN ROWS, the erased identity is `d` throughout:
/// - U1 side-A win (d vs s), U2 side-B win (s vs d), U3 `Fled` (d vs WILD) and
///   U4 `Fled` (d vs s) — settled rows that DO name `d`;
/// - U10 side-A win (s vs o) — a settled row that does not name `d`;
/// - U5 Ongoing (s vs o), U6 Ongoing (s vs WILD), U7 Ongoing (TOMBSTONE vs s),
///   U8 Ongoing PRACTICE (s vs s) and U9 Ongoing (s vs TOMBSTONE) — live rows
///   that do NOT name `d`.
///
/// Kills:
/// - the outcome guard inverted: U1-U4 and U10 get forced (and the forced rows
///   of the sibling test stay Ongoing);
/// - a force applied regardless of outcome: U1, U2 and U4 get a new winner;
/// - a force of ANY Ongoing row, whoever it names: U5-U9;
/// - a wild check missing its player conjunct: U6 reads `Fled`;
/// - a seam that treats the tombstone as the erased identity: U7 and U9;
/// - a practice shortcut keyed on the two identity columns being EQUAL rather
///   than on either of them naming `d`: U8 reads a side-B win;
/// - a seam that rewrites a settled outcome without consulting the identities
///   at all: U10.
#[test]
fn rb129_forced_terminal_leaves_settled_and_bystander_rows_untouched() {
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let o = spacetimedb::Identity::from_byte_array([0x83u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;

    let named = [
        ("d", d),
        ("s", s),
        ("o", o),
        ("WILD", wild),
        ("TOMBSTONE", tomb),
    ];
    for (i, (name_a, id_a)) in named.iter().enumerate() {
        for (name_b, id_b) in &named[i + 1..] {
            assert_ne!(
                id_a, id_b,
                "rb-129 E1 FAIL (precondition): the fixture identities {name_a} and \
                 {name_b} are equal, so a bystander row could secretly name the erased \
                 identity and the verdicts below would prove nothing."
            );
        }
    }

    let settled = "Settled history is never rewritten: the survivor's rating and record were \
                   computed from this outcome, and the forced-terminal seam exists only for \
                   rows the cascade would otherwise leave LIVE. A changed outcome here is the \
                   outcome guard inverted, or a force applied regardless of outcome.";
    let bystander = "The erased identity is not part of this live battle, so it is not the \
                     cascade's to end. A changed outcome here is a seam that forces ANY \
                     Ongoing row, a wild check missing its player conjunct (U6), a seam that \
                     treats the tombstone as the erased identity (U7, U9), or a practice \
                     shortcut that forfeits any row whose two sides are EQUAL instead of \
                     asking whether either names the erased identity (U8).";
    let rows = [
        (
            "[U1 settled side-A win (d vs s)]",
            d,
            s,
            game_core::BattleOutcome::SideAWins,
            settled,
        ),
        (
            "[U2 settled side-B win (s vs d)]",
            s,
            d,
            game_core::BattleOutcome::SideBWins,
            settled,
        ),
        (
            "[U3 settled Fled (d vs WILD)]",
            d,
            wild,
            game_core::BattleOutcome::Fled,
            settled,
        ),
        (
            "[U4 settled Fled (d vs s)]",
            d,
            s,
            game_core::BattleOutcome::Fled,
            settled,
        ),
        (
            "[U5 bystander Ongoing (s vs o)]",
            s,
            o,
            game_core::BattleOutcome::Ongoing,
            bystander,
        ),
        (
            "[U6 bystander Ongoing (s vs WILD)]",
            s,
            wild,
            game_core::BattleOutcome::Ongoing,
            bystander,
        ),
        (
            "[U7 bystander Ongoing (TOMBSTONE vs s)]",
            tomb,
            s,
            game_core::BattleOutcome::Ongoing,
            bystander,
        ),
        (
            "[U8 bystander Ongoing practice (s vs s)]",
            s,
            s,
            game_core::BattleOutcome::Ongoing,
            bystander,
        ),
        (
            "[U9 bystander Ongoing (s vs TOMBSTONE)]",
            s,
            tomb,
            game_core::BattleOutcome::Ongoing,
            bystander,
        ),
        (
            "[U10 settled side-A win (s vs o)]",
            s,
            o,
            game_core::BattleOutcome::SideAWins,
            settled,
        ),
    ];
    for (i, (label, player, opponent, outcome, why)) in rows.iter().enumerate() {
        let before = rb129_row(1300 + i as u64, *player, *opponent, *outcome);
        let after = super::battle_with_forced_terminal(before.clone(), d);
        rb129_assert_row(label, why, &before, &after, *outcome);
    }
}

/// the shell's two seams, composed, leave the erased identity in no Ongoing
/// battle.
///
/// For each of the SIX forced rows — side A, side B, practice, wild, and a
/// tombstone counterparty on either side — the swept result is terminal, names
/// the erased identity on NEITHER side, keeps the survivor (the wild sentinel,
/// or the earlier tombstone) where it was, and carries the forced row's whole
/// battle state through the swap. That is the EARS postcondition: with no
/// Ongoing row naming the erased identity, the PvP action reducer's participant
/// and Ongoing guards both refuse it, the deadline reaper finds nothing live,
/// and the survivor's own ongoing-battle test reads false.
///
/// THE ORDER IS LOAD-BEARING, proven rather than asserted: composed the other
/// way round, the swap runs first, the row stops naming the erased identity,
/// and the forced-terminal seam correctly treats it as a bystander — so the row
/// stays Ongoing under a tombstone. This test is the witness that makes the
/// order meaningful; `bn_anonymize_battles_scrubs_both_roles` runs the shell
/// against the in-memory host and holds it to force-then-tombstone.
///
/// Kills: a forced-terminal seam keyed on the TOMBSTONE rather than the erased
/// identity (the forward composition stays Ongoing); A3a and A3b on the two
/// tombstone-counterparty rows (a `Fled`, or a row left Ongoing under two
/// tombstones); a tombstone seam that stops carrying the outcome through, or
/// that resets the weather or heals the fainted members on the way (B4, B5 —
/// the status half, B6, is `rb129_tombstone_seam_preserves_state_on_rich_rows`);
/// a composition that leaves either side naming the erased identity.
#[test]
fn rb129_composed_sweep_leaves_the_erased_identity_in_no_ongoing_battle() {
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;
    let ongoing = game_core::BattleOutcome::Ongoing;

    let rows = [
        (
            "[composed side A (d vs s)]",
            d,
            s,
            (tomb, s),
            game_core::BattleOutcome::SideBWins,
        ),
        (
            "[composed side B (s vs d)]",
            s,
            d,
            (s, tomb),
            game_core::BattleOutcome::SideAWins,
        ),
        (
            "[composed practice (d vs d)]",
            d,
            d,
            (tomb, tomb),
            game_core::BattleOutcome::SideBWins,
        ),
        (
            "[composed wild (d vs WILD)]",
            d,
            wild,
            (tomb, wild),
            game_core::BattleOutcome::Fled,
        ),
        (
            "[composed tombstone B (d vs TOMBSTONE)]",
            d,
            tomb,
            (tomb, tomb),
            game_core::BattleOutcome::SideBWins,
        ),
        (
            "[composed tombstone A (TOMBSTONE vs d)]",
            tomb,
            d,
            (tomb, tomb),
            game_core::BattleOutcome::SideAWins,
        ),
    ];
    for (i, (label, player, opponent, want_sides, want)) in rows.iter().enumerate() {
        let forced = super::battle_with_forced_terminal(
            rb129_row(1310 + i as u64, *player, *opponent, ongoing),
            d,
        );
        let swept = super::battle_with_tombstoned_party(forced.clone(), d, tomb);
        let got = swept.state.outcome;
        assert_ne!(
            got, ongoing,
            "rb-129 E1 FAIL (composed, terminal) {label}: the swept row is still Ongoing. \
             After the cascade's per-row sequence — force, then tombstone — no battle the \
             erased identity was part of may stay live: a live row keeps the survivor \
             locked in a battle nobody can finish, settleable by an identity that no longer \
             exists."
        );
        assert_eq!(
            got, *want,
            "rb-129 E1 FAIL (composed, outcome) {label}: the swept row reads {got:?}; the \
             forced outcome {want:?} must survive the tombstone swap, which carries every \
             field but the two identity columns through untouched."
        );
        assert_ne!(
            swept.player_identity, d,
            "rb-129 E1 FAIL (composed, erased) {label}: side A of the swept row still names \
             the erased identity."
        );
        assert_ne!(
            swept.opponent_identity, d,
            "rb-129 E1 FAIL (composed, erased) {label}: side B of the swept row still names \
             the erased identity."
        );
        let got_sides = (swept.player_identity, swept.opponent_identity);
        assert_eq!(
            got_sides, *want_sides,
            "rb-129 E1 FAIL (composed, survivor) {label}: the erased side must become the \
             tombstone and the survivor, or the wild sentinel, must stay exactly where it \
             was."
        );
        assert_eq!(
            swept.state, forced.state,
            "rb-129 E1 FAIL (composed, state carried) {label}: the tombstone swap rewrote the \
             battle state of the row the force had just settled. It may move the two identity \
             columns and nothing else: the verdict, the weather, both teams and both lead \
             indices must reach the committed row exactly as the force left them (B4 weather \
             reset and B5 heal-all die here; B6 status clear is the rich-row test's)."
        );
    }

    // --- The reversed composition: tombstone first, then force --------------
    let reversed = super::battle_with_forced_terminal(
        super::battle_with_tombstoned_party(rb129_row(1319, d, s, ongoing), d, tomb),
        d,
    );
    let got = reversed.state.outcome;
    assert_eq!(
        got, ongoing,
        "rb-129 E1 FAIL (order matters): composed the OTHER way round — tombstone first, \
         then force — the side-A row came back {got:?}; it must stay Ongoing. After the \
         swap the row no longer names the erased identity, so a correct forced-terminal \
         seam treats it as a bystander. This is the witness that the shell's order is \
         load-bearing: `bn_anonymize_battles_scrubs_both_roles` holds the shell to \
         force-then-tombstone because the reverse leaves exactly this live, tombstoned row \
         behind. A failure here means the seam is not keyed on the erased identity."
    );
    let got_sides = (reversed.player_identity, reversed.opponent_identity);
    assert_eq!(
        got_sides,
        (tomb, s),
        "rb-129 E1 FAIL (order matters, identities): the reversed composition must still \
         leave the tombstone on side A and the survivor on side B."
    );
}

/// the tombstone seam moves the two identity columns and NOTHING else, on rows
/// that carry every mechanical fact a wrong seam could destroy.
///
/// `m22s3b_battle_tombstone_truth_table` drives the seam over empty-team rows
/// with no weather every row carries rain, a fainted member on each side, a
/// status on each side and non-zero lead indices, across ALL FOUR outcomes and
/// four sides, and the WHOLE `BattleState` is compared.
///
/// Kills: B4 (weather reset inside the tombstone seam), B5 (every combatant
/// healed), B6 (statuses cleared), and any other state rewrite; a swap that
/// clobbers the wild sentinel or the survivor; a battle id, id list or
/// creation stamp rebuilt rather than carried.
#[test]
fn rb129_tombstone_seam_preserves_state_on_rich_rows() {
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;
    let sleep = game_core::StatusEffect::Sleep { turns_remaining: 2 };
    let sides = [
        ("side A (d vs s)", d, s, (tomb, s)),
        ("side B (s vs d)", s, d, (s, tomb)),
        ("practice (d vs d)", d, d, (tomb, tomb)),
        ("wild (d vs WILD)", d, wild, (tomb, wild)),
    ];
    let outcomes = [
        game_core::BattleOutcome::Ongoing,
        game_core::BattleOutcome::SideAWins,
        game_core::BattleOutcome::SideBWins,
        game_core::BattleOutcome::Fled,
    ];
    for (i, (side, player, opponent, want_sides)) in sides.iter().enumerate() {
        for (j, outcome) in outcomes.into_iter().enumerate() {
            let label = format!("[tombstone rich row: {side}, outcome {outcome:?}]");
            let mut before = rb129_row(1330 + (4 * i + j) as u64, *player, *opponent, outcome);
            before.state.side_a.team[1].status = Some(game_core::StatusEffect::Burn);
            before.state.side_b.team[0].status = Some(sleep);
            let after = super::battle_with_tombstoned_party(before.clone(), d, tomb);
            assert_eq!(
                after.state, before.state,
                "rb-129 E1 FAIL (tombstone seam, state intact) {label}: the tombstone seam \
                 rewrote the battle state. It may move the two identity columns and nothing \
                 else: every field of the state is the survivor's record of the fight. KILLS \
                 the weather reset (B4), every combatant healed (B5) and every status cleared \
                 (B6) inside the seam, each of which passed the whole suite before this test, \
                 because the truth table's rows have empty teams and no weather."
            );
            assert_eq!(
                (after.battle_id, after.created_at_ms),
                (before.battle_id, before.created_at_ms),
                "rb-129 E1 FAIL (tombstone seam, key and stamp) {label}: the battle id or the \
                 creation stamp moved; the swap is a PK-keyed update of a SURVIVING row."
            );
            assert_eq!(
                after.party_monster_ids, before.party_monster_ids,
                "rb-129 E1 FAIL (tombstone seam, party ids) {label}: side A's ids moved."
            );
            assert_eq!(
                after.opponent_monster_ids, before.opponent_monster_ids,
                "rb-129 E1 FAIL (tombstone seam, opponent ids) {label}: side B's ids moved."
            );
            let got_sides = (after.player_identity, after.opponent_identity);
            assert_eq!(
                got_sides, *want_sides,
                "rb-129 E1 FAIL (tombstone seam, identities) {label}: every side naming the \
                 erased identity must become the tombstone, and the survivor or the wild \
                 sentinel must stay exactly where it was."
            );
        }
    }
}

/// the SSOT wild predicate the forced-terminal seam checks FIRST admits an
/// Ongoing row owned by the erased identity whose opponent is the wild
/// sentinel, and nothing else.
///
/// The seam answers every row this predicate admits with `Fled`. A predicate
/// that also admitted a TOMBSTONE counterparty tells the survivor of an earlier
/// deletion that they fled, and makes the disconnect resolver that shares the
/// predicate auto-flee and DELETE a PvP row against the tombstone. `ptc5b_1`
/// offers a live PvP opponent, a settled row and another owner; it never offers
/// the tombstone, the owner itself, or a query about a different player.
///
/// Kills: B3 (the tombstone counted as wild); a predicate reduced to the
/// opponent not being a live player; a predicate satisfied by a practice row;
/// a predicate that drops its outcome conjunct or either identity conjunct.
#[test]
fn rb129_wild_predicate_rejects_non_wild_opponents() {
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;
    let ongoing = game_core::BattleOutcome::Ongoing;

    for (label, opponent) in [
        ("the TOMBSTONE", tomb),
        ("a live player", s),
        ("the owner itself", d),
    ] {
        assert!(
            !super::is_ongoing_wild_battle(&rb129_row(1350, d, opponent, ongoing), d),
            "rb-129 E1 FAIL (wild predicate, opponent is {label}): the SSOT wild predicate \
             admitted an Ongoing row owned by the erased identity whose opponent is \
             {label}. Only the all-zero wild sentinel makes a row wild; the forced-terminal \
             seam answers an admitted row with `Fled`, so a PvP survivor would be told they \
             fled, and the disconnect resolver sharing this predicate would DELETE the row."
        );
    }
    assert!(
        super::is_ongoing_wild_battle(&rb129_row(1351, d, wild, ongoing), d),
        "rb-129 E1 FAIL (wild predicate, positive control): the SSOT wild predicate rejected \
         an Ongoing row owned by the erased identity against the wild sentinel — the one row \
         class it exists to admit. Every rejection above is vacuous without this."
    );
    for settled in [
        game_core::BattleOutcome::SideAWins,
        game_core::BattleOutcome::SideBWins,
        game_core::BattleOutcome::Fled,
    ] {
        assert!(
            !super::is_ongoing_wild_battle(&rb129_row(1352, d, wild, settled), d),
            "rb-129 E1 FAIL (wild predicate, settled {settled:?}): the SSOT wild predicate \
             admitted a SETTLED wild row. It selects Ongoing rows only; admitting a settled \
             one would let the disconnect resolver delete finished history."
        );
    }
    assert!(
        !super::is_ongoing_wild_battle(&rb129_row(1353, s, wild, ongoing), d),
        "rb-129 E1 FAIL (wild predicate, another owner): the SSOT wild predicate admitted \
         ANOTHER player's Ongoing wild row when asked about the erased identity."
    );
    assert!(
        !super::is_ongoing_wild_battle(&rb129_row(1354, d, wild, ongoing), s),
        "rb-129 E1 FAIL (wild predicate, asked about another player): the SSOT wild predicate \
         admitted the erased identity's Ongoing wild row when asked about a DIFFERENT player."
    );
}

/// The raw draw for one property-test combatant, by position: 0 species, 1 max
/// HP, 2 an HP edge selector (0 fainted, 1 full, else anywhere in range), 3 a
/// raw HP, 4 a status selector (0 none, 1 to 5 one status each), 5 the sleep
/// turns left.
type Rb129RawMon = (u32, u16, u8, u16, u8, u8);

/// The strategy behind `Rb129RawMon`: max HP 1 to 500, every other part over
/// its whole range.
fn rb129_raw_mon() -> impl proptest::strategy::Strategy<Value = Rb129RawMon> {
    use proptest::prelude::*;
    (
        any::<u32>(),
        1u16..=500,
        0u8..3,
        any::<u16>(),
        0u8..6,
        any::<u8>(),
    )
}

/// A combatant built from one raw draw: `current_hp` always in `0..=max_hp`
/// (the fainted and full edges each drawn a third of the time), and no status
/// or any one of the five.
fn rb129_mon_from_raw(raw: Rb129RawMon) -> game_core::BattleMonster {
    use game_core::StatusEffect::{Burn, Freeze, Paralysis, Poison, Sleep};
    let (species_id, max_hp, turns_remaining) = (raw.0, raw.1, raw.5);
    let current_hp = match raw.2 {
        0 => 0,
        1 => max_hp,
        _ => raw.3 % max_hp.saturating_add(1),
    };
    let status = match raw.4 {
        0 => None,
        1 => Some(Poison),
        2 => Some(Burn),
        3 => Some(Paralysis),
        4 => Some(Sleep { turns_remaining }),
        _ => Some(Freeze),
    };
    game_core::BattleMonster {
        species_id,
        current_hp,
        max_hp,
        status,
        ..rb129_mon(1, 0)
    }
}

/// A side built from raw draws: 0 to 6 combatants and a lead index IN RANGE
/// (0 for an empty team), so a pending swap (a fainted lead with a conscious
/// bench) is drawn as often as any other lead state.
fn rb129_side_from_raw(raw: &[Rb129RawMon], raw_active: u32) -> game_core::BattleSide {
    let team: Vec<_> = raw.iter().copied().map(rb129_mon_from_raw).collect();
    let active = if team.is_empty() {
        0
    } else {
        raw_active % team.len() as u32
    };
    game_core::BattleSide { active, team }
}

/// No weather (kind 0) or one of the four variants with the drawn turns left.
fn rb129_weather_from_raw(
    kind: u8,
    turns_remaining: u8,
) -> Option<game_core::combat::WeatherEffect> {
    use game_core::combat::WeatherEffect::{Hail, Rain, Sandstorm, Sun};
    match kind {
        0 => None,
        1 => Some(Rain { turns_remaining }),
        2 => Some(Sun { turns_remaining }),
        3 => Some(Sandstorm { turns_remaining }),
        _ => Some(Hail { turns_remaining }),
    }
}

/// over 512 seeded random rows, the forced-terminal seam agrees with the and
/// touches nothing but the outcome.
///
/// The deterministic matrix beside this one enumerates chosen values; this
/// samples the rest. Each case draws BOTH identity columns independently from
/// the pool d, s, o, WILD, TOMBSTONE (the erased identity `d` a third of the
/// time), any of the four outcomes (Ongoing half the time), any turn number,
/// creation stamp and battle id, party and opponent id lists of 0 to 6 entries
/// each, no weather or any variant with any turns left, and two teams of 0 to
/// 6 combatants with any species, HP anywhere in `0..=max_hp` (fainted and full
/// drawn often), any status or none, and a lead index in range.
///
/// THE ORACLE IS THE D1 TABLE never computed by
/// calling the seam: a settled row comes back unchanged; an Ongoing row owned
/// by `d` against the wild sentinel comes back `Fled`; else an Ongoing row
/// whose side A is `d` takes side A's game-core forfeit; else one whose side B
/// is `d` takes side B's; else it comes back unchanged. In EVERY case the
/// identities, the id lists, the battle id, the creation stamp and the whole
/// state bar its outcome are unchanged, and a row naming `d` never comes back
/// Ongoing.
///
/// DETERMINISTIC: `proptest!` in its closure form inside a plain test, with the
/// RNG seed fixed (129) and 512 cases, so a run is reproducible; a failure is
/// shrunk to a minimal row and persisted by proptest. The run must also DRAW
/// every verdict class of the table at least once, or it proves nothing about
/// the class it missed.
///
/// Kills (sampled, not enumerated): A1, A2, A3a, A3b, A5 and A6, and any skip
/// or verdict keyed on a value the matrix never takes — a species, an HP or max
/// HP value, a status or its turn count, a team of four to six, a lead index
/// past 2; the settled guard inverted; a bystander forced. It does NOT reliably
/// kill A4 (battle ids below 1024 are practically never drawn from the full
/// 64-bit range); the matrix does.
#[test]
fn rb129_forced_terminal_property_over_random_rows() {
    use proptest::prelude::*;
    let d = spacetimedb::Identity::from_byte_array([0x81u8; 32]);
    let s = spacetimedb::Identity::from_byte_array([0x82u8; 32]);
    let o = spacetimedb::Identity::from_byte_array([0x83u8; 32]);
    let wild = crate::WILD_IDENTITY;
    let tomb = crate::TOMBSTONE_IDENTITY;
    // `d` twice: the erased identity fills each column a third of the time.
    let pool = [d, d, s, o, wild, tomb];
    let ongoing = game_core::BattleOutcome::Ongoing;
    let forfeit_a = game_core::pvp_forfeit_outcome(game_core::SideId::SideA);
    let forfeit_b = game_core::pvp_forfeit_outcome(game_core::SideId::SideB);
    let hits: [std::cell::Cell<usize>; 5] = Default::default();
    let config = ProptestConfig {
        cases: 512,
        rng_seed: proptest::test_runner::RngSeed::Fixed(129),
        ..ProptestConfig::default()
    };
    proptest!(config, |(
        pcode in 0u8..6,
        ocode in 0u8..6,
        outcome_code in 0u8..6,
        turn_number in any::<u16>(),
        created_at_ms in any::<i64>(),
        battle_id in any::<u64>(),
        party in prop::collection::vec(any::<u64>(), 0..=6),
        opponent_ids in prop::collection::vec(any::<u64>(), 0..=6),
        (weather_kind, weather_turns) in (0u8..5, any::<u8>()),
        team_a in prop::collection::vec(rb129_raw_mon(), 0..=6),
        team_b in prop::collection::vec(rb129_raw_mon(), 0..=6),
        (active_a, active_b) in (any::<u32>(), any::<u32>()),
    )| {
        let player = pool[usize::from(pcode)];
        let opponent = pool[usize::from(ocode)];
        let outcome = match outcome_code {
            0..=2 => ongoing,
            3 => game_core::BattleOutcome::SideAWins,
            4 => game_core::BattleOutcome::SideBWins,
            _ => game_core::BattleOutcome::Fled,
        };
        let before = crate::schema::Battle {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: rb129_side_from_raw(&team_a, active_a),
                side_b: rb129_side_from_raw(&team_b, active_b),
                outcome,
                turn_number,
                weather: rb129_weather_from_raw(weather_kind, weather_turns),
            },
            party_monster_ids: party,
            opponent_monster_ids: opponent_ids,
            created_at_ms,
        };

        // THE ORACLE:
        let (want, class) = if outcome != ongoing {
            (outcome, 0)
        } else if player == d && opponent == wild {
            (game_core::BattleOutcome::Fled, 1)
        } else if player == d {
            (forfeit_a, 2)
        } else if opponent == d {
            (forfeit_b, 3)
        } else {
            (ongoing, 4)
        };

        let after = super::battle_with_forced_terminal(before.clone(), d);
        let got = after.state.outcome;
        prop_assert!(
            got == want,
            "rb-129 E1 FAIL (property, verdict): the forced-terminal seam returned {got:?}; \
             the ADR-0274 D1 table says {want:?} for this row (verdict class {class}: 0 \
             settled, 1 wild auto-flee, 2 side-A forfeit, 3 side-B forfeit, 4 bystander)."
        );
        let rest = game_core::BattleState {
            outcome,
            ..after.state.clone()
        };
        prop_assert!(
            rest == before.state,
            "rb-129 E1 FAIL (property, state intact): the seam rewrote part of the battle \
             state other than its outcome (weather, a team member, a lead index or the \
             turn). ADR-0274 D1 lets it write `state.outcome` and nothing else."
        );
        prop_assert!(
            (after.player_identity, after.opponent_identity) == (player, opponent),
            "rb-129 E1 FAIL (property, identities): the seam moved an identity column; the \
             swap is the tombstone seam's job and needs the original identities."
        );
        prop_assert!(
            after.battle_id == battle_id
                && after.created_at_ms == created_at_ms
                && after.party_monster_ids == before.party_monster_ids
                && after.opponent_monster_ids == before.opponent_monster_ids,
            "rb-129 E1 FAIL (property, row fields): the seam moved the battle id, the \
             creation stamp or an id list."
        );
        let names_d = player == d || opponent == d;
        prop_assert!(
            !names_d || got != ongoing,
            "rb-129 E1 FAIL (property, postcondition): a row naming the erased identity \
             came back Ongoing — settleable later by an identity that no longer exists."
        );
        hits[class].set(hits[class].get() + 1);
    });

    let classes = [
        "a settled row returned unchanged",
        "an Ongoing wild row owned by the erased identity, auto-fled",
        "an Ongoing row whose side A is the erased identity, side A's forfeit",
        "an Ongoing row whose side B alone is the erased identity, side B's forfeit",
        "an Ongoing bystander row returned unchanged",
    ];
    for (class, hit) in classes.iter().zip(&hits) {
        let n = hit.get();
        assert!(
            n >= 1,
            "rb-129 E1 FAIL (property non-vacuity): the verdict class `{class}` was drawn \
             {n} time(s) in the seeded run; every class of the ADR-0274 D1 table must be \
             drawn at least once, or the property proves nothing about it. If the strategy, \
             the seed or the case count changed, re-derive the weights; never drop a class."
        );
    }
}

// ===========================================================================
// the caller-only deletion gate on PvE battle start.
//
// EXECUTION (`rb46_start_battle_is_refused_only_while_the_caller_is_deletion_gated`)
// runs the SHIPPED reducer (`native_host_tests`)
// against real `account` rows: the gate refuses the two deleting states, ADMITS
// the three others, and answers from the CALLER's row rather than from the table
// (a stranger stays mid-grace throughout). The dev-only `start_wild_battle` is
// compiled in no default test build.
// ===========================================================================

/// `start_battle` refuses a deletion-gated caller,
/// ADMITS everybody else, and answers from the CALLER's row.
///
/// The shipped reducer runs through five account
/// states, with the exact verdict pinned in each: no row, `Active`,
/// `PendingDeletion`, `PendingDeletion` + the terminal marker, and row removed.
/// The three admitted states are the positive control, and they are what make the
/// two refused states mean something.
///
/// A STRANGER'S `PendingDeletion` ROW IS SEEDED FIRST AND NEVER REMOVED. Without
/// it the account table only ever holds the sender's row, so a TABLE-keyed gate —
/// refuse if ANYBODY is deleting — is observationally identical to the
/// caller-keyed one in all five states. With it, the three admitted states are
/// only reachable by a gate that keys on `ctx.sender()`.
///
/// WHY THE ADMITTED STATES ERR AT ALL, and why that is the honest claim. The
/// fixture can seed only `Identity`-keyed rows, so the `monster` content lookup
/// finds nothing: an unregistered index yields no rows in this host,
/// which is exactly why every pre-gate read — the two ongoing-battle filters, the
/// party lookup — is a no-op instead of an abort, and why the reducer stops at
/// content lookup rather than at a write.
/// Every write syscall ABORTS the process (uncatchable, so `#[should_panic]`
/// cannot be used here). The RED this test proves is therefore: a deletion-gated
/// caller is ADMITTED past every caller-standing check into content lookup — not
/// that the battle row was written. No table is opened writable, so a write
/// reached before the gate would abort this process.
///
/// THE DUMMY SENDER is the all-zero identity, which is also `WILD_IDENTITY`
/// (lib.rs). That is harmless here: `start_battle`'s provenance rule
/// admits an opponent equal to the caller, and this test passes the caller's own
/// identity as the opponent, so the provenance check passes on both of its arms.
/// It does mean this test cannot distinguish a caller gate from an opponent-keyed
/// one — that is what the bare-name clause of the source pin is for.
///
/// Rows are built with the shipped pure constructors only, so this test can never
/// assemble a state the module itself cannot; `terminal_account` debug-asserts
/// legality, which is why the illegal `Active` + marker shape is not reachable
/// here and is left to `accounts_tests`' truth table. `seed` PUSHES
/// rather than upserting, so each state removes the previous row and asserts that
/// exactly one row went — and because `remove` is `Identity`-keyed, the stranger's
/// row never affects that count.
///
/// kills:
///   - the dropped gate (and any later deletion of it).
///   - a discarded verdict — `let _ = ..`, `.ok();` — which leaves the reducer
///     admitting both deleting states.
///   - `if false`-wrapped or otherwise unreachable gate: same failure.
///   - INVERTED POLARITY, which no source scan in this slice can see: the
///     `Active` and no-row states would start returning the deletion reject, and
///     the two admitted-state assertions fail. Inverted, this gate would refuse
///     EVERY caller — a total outage of battle start — while every text pin stays
///     byte-identical.
///   - a constant reject at the call site: the three admitted states fail.
///   - a row-exists-keyed fake (`is_some()` instead of the status test): the
///     `Active` state fails.
///   - A TABLE-WIDE SCAN OR ANY-ROW-PENDING FAKE: the three admitted states fail
///     while the stranger is mid-grace. (If such a fake is written as a full-table
///     iteration it aborts the process on the unmodelled scan syscall instead —
///     also a failure, and a louder one.)
///   - a sender-keyed fake (any rule that answers from the identity rather than
///     from the row): the `Active` and the removed states disagree with the
///     `PendingDeletion` one on the SAME identity, so at least one fails.
///   - a latched or memoised answer that never returns to admitting: the final
///     removed-row state fails.
///   - a gate that keys on `PendingDeletion` alone and ignores the terminal
///     marker: the fourth state still passes today (the marker implies
///     `PendingDeletion` on a legal row) — recorded honestly, this row is a
///     fail-closed regression fence, not an independent kill.
#[test]
fn rb46_start_battle_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    // The party and opponent ids differ so the dedup scan cannot reject first.
    let call = || crate::battle::start_battle(&ctx, me, vec![1], vec![2]);

    let ordinary: Result<(), String> = Err("party monster 1 not found".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    // A mid-grace STRANGER, seeded once and never removed: the account table is
    // never empty of deleting rows, so an any-row-pending gate cannot masquerade
    // as a caller-keyed one in the three admitted states below.
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, no account row): `start_battle` returned \
         {got:?} for a caller with NO account row, while a STRANGER's row is mid-grace. A \
         caller who never authenticated is not inside the deletion gate and must be admitted \
         past it into the ordinary guard chain; the error above is the next guard's, and \
         pinning it EXACTLY is what stops a `not joined`-style regression from masquerading \
         as a pass. A deletion reject here means the gate answers from the TABLE (or from \
         something else that is not the caller's own row) rather than from `ctx.sender()`."
    );

    // --- State 2: an Active account row -------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, Active account): `start_battle` returned \
         {got:?} for a caller whose account row is `Active` (a stranger's row is mid-grace). \
         This is the ordinary player, and refusing them is a TOTAL OUTAGE of battle start \
         that every source pin in this slice would report as correctly gated — the call text \
         is byte-identical whichever way the decision runs. It is also what a row-EXISTS-keyed \
         fake produces, what an any-row-pending TABLE scan produces, and what an inverted \
         branch produces. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `Active` account row was seeded for the CALLER and must \
         be removed before the next state is pushed — `seed` appends rather than upserting, \
         so a miscount would leave two rows for one identity and the unique-index lookup \
         would assert instead of answering. `remove` is Identity-keyed, so the stranger's \
         row is deliberately untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got,
        gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, mid-grace): `start_battle` returned {got:?} \
         for a caller whose account is `PendingDeletion`; it must return the module's single \
         static deletion reject. THIS IS THE RED STATE AT HEAD — at HEAD `start_battle` \
         carries no deletion gate at all, so a mid-grace account walks past every \
         caller-standing check and opens a new battle commitment the deletion cascade will \
         then have to unwind. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client \
         ever receives. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER \
         and must be removed before the terminal row is pushed (`seed` appends, it never \
         upserts; the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-46 R-m22-s5-X12 FAIL (refused state, terminal): `start_battle` returned {got:?} \
         for a caller whose account carries the M22 terminal marker. An already-erased \
         account must never open a new commitment: its game data is gone, so the battle \
         would be created against rows the cascade has already deleted. The pure decision \
         is an explicit disjunction (`accounts::should_reject_for_deletion`) precisely so \
         this state is fail-closed even on the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-46 fixture: exactly one terminal account row was seeded for the CALLER and must \
         be removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-46 R-m22-s5-X12 FAIL (admitted state, row removed): `start_battle` returned \
         {got:?} once the caller's account row was gone again (the stranger's mid-grace row \
         is still there). The verdict must track LIVE rows FOR THE CALLER: an answer that \
         latches on a row it has already seen — a memoised predicate, a cached decision, a \
         process-wide flag — would keep refusing this identity forever, and an any-row-pending \
         answer would refuse it because of somebody else. No state above can distinguish \
         either of those from a correct gate on its own."
    );
}

// ===========================================================================
// the scheduler-opened grass-path wild encounter is a gated commitment, refused
// at the SHARED choke point.
//
// WHY THE GATE GOES HERE AND NOT IN `movement_tick`. Both wild
// encounter openers funnel through `begin_encounter`: the scheduled grass path
// and the dev-only `start_wild_battle`. Gating the funnel gates both, once.
// Gating `movement_tick` instead would put account-state vocabulary in
// `movement.rs` (a second consumer of a wrapper this slice contains to one), and
// — decisively — a pre-roll `continue` there CHANGES the per-tick `ctx.random()`
// draw count, so one walker's account state would shift the encounter seeds of
// every character rolled after them in the same tick.
//
// EXECUTION (`rb76_begin_encounter_refuses_only_a_deletion_gated_walker`) runs
// the SHIPPED helper against real `account` rows: the
// gate refuses the two deleting states, ADMITS the three others, and answers from
// the WALKER's row rather than from the table or the sender.
// ===========================================================================

/// `begin_encounter` refuses a deletion-gated WALKER, ADMITS everybody else, and answers from the
/// `player_identity` ARGUMENT.
///
/// The shipped helper runs through five walker
/// states, with the exact verdict pinned in each: no row, `Active`,
/// mid-grace, mid-grace plus the terminal marker, and row removed. The three
/// admitted states are the positive control, and they are what make the two
/// refused states mean something.
///
/// A STRANGER'S MID-GRACE ROW IS SEEDED FIRST AND NEVER REMOVED. Without it the
/// account table only ever holds the walker's row, so a TABLE-keyed gate —
/// refuse if ANYBODY is deleting — is observationally identical to the
/// subject-keyed one in all five states.
///
/// `ctx.sender()` under this host is the all-zero identity,
/// and on the REAL grass path it is the MODULE identity — never the walker. So:
///   (i) the SENDER's own row is driven mid-grace while the WALKER is `Active`,
///       and the call must still be ADMITTED. A caller-keyed gate — the obvious
///       copy of `start_battle`'s, and the one that compiles most easily here —
///       refuses, and on the scheduler path it would refuse or admit every
///       walker in the zone together according to an account no player owns.
///   (ii) the SENDER's own row is driven `Active` while the WALKER is mid-grace,
///       and the call must still be REFUSED. This is the sharper half: a
///       caller-keyed gate ADMITS here, so the feature looks present, passes
///       every source pin, and gates nothing on the path it was written for.
///
/// WHY THE ADMITTED STATES ERR AT ALL, and why that is the honest claim. The
/// fixture registers only the `account` table, so the `monster` point read finds
/// nothing: an unregistered index yields no rows in this host,
/// which is exactly why every pre-gate read — the two ongoing-battle filters, the party lookup — is
/// a no-op instead of an abort, and why the helper stops at the party lookup rather than at a
/// write.
/// Every write syscall ABORTS the process (uncatchable, so `#[should_panic]`
/// cannot be used here). The RED this test proves is therefore: a deletion-gated
/// walker is ADMITTED past every standing check INTO THE PARTY LOOKUP — not that
/// a battle row was written. No table is opened writable, so a write reached
/// before the gate would abort this process.
///
/// THE DUMMY SENDER is the all-zero identity, which is also `WILD_IDENTITY`
/// (lib.rs). Nothing in `begin_encounter` compares the caller against that
/// sentinel, so it is inert here — but it does mean a constant-keyed gate
/// (`if player_identity == WILD_IDENTITY`) could not be distinguished from a
/// correct one by this test. That class belongs to the equality pins in the
/// source test beside this one.
///
/// Rows are built with the shipped pure constructors only, so this test can
/// never assemble a state the module itself cannot; `terminal_account`
/// debug-asserts legality, which is why the illegal `Active`-plus-marker shape
/// is not reachable here and is left to `accounts_tests`' truth table. `seed`
/// PUSHES rather than upserting, so each state removes the previous row and
/// asserts that exactly one row went — and because `remove` is `Identity`-keyed,
/// neither the stranger's row nor the sender's affects that count.
///
/// kills:
///   - the dropped gate (and any later deletion of it);
///   - a discarded verdict — `let _ = ..`, `.ok();` — which leaves the helper
///     admitting both deleting states;
///   - an `if false`-wrapped or otherwise unreachable gate: same failure;
///   - INVERTED POLARITY, which no source scan in this slice can see: the
///     `Active` and no-row states would start returning the deletion reject.
///     Inverted, this gate refuses EVERY walker — a total outage of wild
///     encounters, PvE progression included — while every text pin stays
///     byte-identical;
///   - a CALLER-KEYED gate, in either direction, through the two sender
///     controls. the shape
///     `start_battle`'s gate has, it is one line away in the same file, and it
///     is correct THERE and wrong HERE;
///   - a table-wide or any-row-pending fake: the three admitted states fail
///     while the stranger is mid-grace;
///   - a row-EXISTS-keyed fake (`is_some()` instead of the status test): the
///     `Active` state fails;
///   - a latched or memoised answer that never returns to admitting: the final
///     removed-row state fails;
///   - a gate keyed on the mid-grace status alone that ignores the terminal
///     marker: that state still passes today (the marker implies the status on a
///     legal row) — recorded honestly, a fail-closed regression fence rather
///     than an independent kill.
#[test]
fn rb76_begin_encounter_refuses_only_a_deletion_gated_walker() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let sender = ctx.sender();
    let walker = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);

    // One party id, so the dedup scan above the gate cannot reject first.
    let call = || crate::battle::begin_encounter(&ctx, walker, vec![1], 1, 1, 1);

    let ordinary: Result<u64, String> = Err("party monster 1 not found".to_string());
    let gated: Result<u64, String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let walker_active = crate::accounts::new_account_row(walker, String::new(), 0);
    let walker_pending = crate::accounts::requested_deletion(walker_active.clone(), 1);
    let walker_terminal = crate::accounts::terminal_account(walker_pending.clone(), 2);
    let sender_active = crate::accounts::new_account_row(sender, String::new(), 0);
    let sender_pending = crate::accounts::requested_deletion(sender_active.clone(), 1);

    // A mid-grace STRANGER, seeded once and never removed.
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));

    // --- State 1: the walker has no account row (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-76 R-rb-46-GRASSPATH FAIL (admitted, no walker row): `begin_encounter` returned \
         {got:?} for a walker with NO account row, while a STRANGER's row is mid-grace. A \
         player who never authenticated is not inside the para-4.7 deletion gate and must be \
         admitted past it into the ordinary guard chain; the expected error is the next \
         guard's (the party lookup), and pinning it EXACTLY is what stops an unrelated \
         regression from masquerading as a pass. A deletion reject here means the gate \
         answers from the TABLE rather than from the walker's own row. Indexes the generated \
         code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: the walker's row is Active --------------------------------
    acct.seed(&walker_active);
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-76 R-rb-46-GRASSPATH FAIL (admitted, Active walker): `begin_encounter` returned \
         {got:?} for a walker whose account row is `Active` (a stranger's row is mid-grace). \
         This is the ordinary player stepping onto grass, and refusing them is a TOTAL \
         OUTAGE of wild encounters — PvE progression itself — that every source pin in this \
         slice would report as correctly gated, because the call text is byte-identical \
         whichever way the decision runs. It is also what a row-EXISTS-keyed fake produces, \
         what an any-row-pending table scan produces, and what an inverted branch produces. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- Control (i): the SENDER is mid-grace while the walker is Active ----
    acct.seed(&sender_pending);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-76 R-rb-46-GRASSPATH FAIL (subject-keyed, sender mid-grace): `begin_encounter` \
         returned {got:?} while the WALKER's row is `Active` and the CONTEXT SENDER's own \
         row is mid-grace. The gate must answer about `player_identity`, the \
         SERVER-DERIVED walker read from the character's own `player` row — never about \
         `ctx.sender()`. THE MUTANT THIS KILLS is the whole reason this slice exists: \
         `start_battle`, one screen above in this same file, is gated by the CALLER-ONLY \
         wrapper, and copying that line here compiles, reads naturally and is wrong. On the \
         scheduled grass path `ctx.sender()` is the MODULE identity, so a caller-keyed gate \
         asks about an account no player owns and decides for every walker in the zone at \
         once."
    );
    assert_eq!(
        acct.remove(sender),
        1,
        "rb-76 fixture: exactly one mid-grace row was seeded for the CONTEXT SENDER and must \
         be removed before the next state — `seed` appends rather than upserting, so a \
         miscount would leave two rows for one identity and the unique-index lookup would \
         assert instead of answering. `remove` is Identity-keyed, so the stranger's and the \
         walker's rows are deliberately untouched and must never be counted here."
    );

    // --- State 3: the walker is mid-grace -----------------------------------
    assert_eq!(
        acct.remove(walker),
        1,
        "rb-76 fixture: exactly one `Active` row was seeded for the WALKER and must be \
         removed before the mid-grace row is pushed (`seed` appends, it never upserts)."
    );
    acct.seed(&walker_pending);
    let got = call();
    assert_eq!(
        got,
        gated,
        "rb-76 R-rb-46-GRASSPATH FAIL (refused, walker mid-grace): `begin_encounter` \
         returned {got:?} for a walker whose account is inside the deletion grace window; it \
         must return the module's single static deletion reject. THIS IS THE RED STATE AT \
         HEAD — at HEAD `begin_encounter` carries no deletion gate at all, so a mid-grace \
         walker walks past every standing check and opens a new wild-battle commitment that \
         the para-4.4 cascade will then have to boot. The expected value is compared against \
         the CONSTANT, never a re-typed literal, so a reworded reason cannot drift silently \
         into text no client ever receives. Indexes the generated code asked the host for: \
         {:?}",
        fx.requested_indexes()
    );

    // --- Control (ii): the SENDER is Active while the walker is mid-grace ---
    acct.seed(&sender_active);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-76 R-rb-46-GRASSPATH FAIL (subject-keyed, sender Active): `begin_encounter` \
         returned {got:?} while the WALKER is mid-grace and the CONTEXT SENDER's own row is \
         `Active`. This is the mirror of the control above and the sharper half: a \
         caller-keyed gate ADMITS here, so the encounter is opened, the feature looks \
         present in review, every source pin in this slice passes, and nothing at all is \
         gated on the scheduled path the criterion is about."
    );
    assert_eq!(
        acct.remove(sender),
        1,
        "rb-76 fixture: exactly one `Active` row was seeded for the CONTEXT SENDER and must \
         be removable; the stranger's and the walker's rows stay."
    );

    // --- State 4: the walker carries the terminal marker --------------------
    assert_eq!(
        acct.remove(walker),
        1,
        "rb-76 fixture: exactly one mid-grace row was seeded for the WALKER and must be \
         removed before the terminal row is pushed."
    );
    acct.seed(&walker_terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-76 R-rb-46-GRASSPATH FAIL (refused, walker terminal): `begin_encounter` returned \
         {got:?} for a walker whose account carries the M22 terminal marker. An \
         already-erased account must never open a new commitment: its game data is gone, so \
         the battle would be created against rows the cascade has already deleted, and side \
         A's party ids would point at monsters that no longer exist. The pure decision is an \
         explicit disjunction precisely so this state is fail-closed even on the illegal \
         `Active`-plus-marker shape."
    );

    // --- State 5: the walker's row is gone again ----------------------------
    assert_eq!(
        acct.remove(walker),
        1,
        "rb-76 fixture: exactly one terminal row was seeded for the WALKER and must be \
         removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-76 R-rb-46-GRASSPATH FAIL (admitted, walker row removed): `begin_encounter` \
         returned {got:?} once the walker's account row was gone again (the stranger's \
         mid-grace row is still there). The verdict must track LIVE rows FOR THE WALKER: an \
         answer that latches on a row it has already seen — a memoised predicate, a cached \
         decision, a process-wide flag — would keep refusing this identity forever, and an \
         any-row-pending answer would refuse it because of somebody else. No state above can \
         distinguish either of those from a correct gate on its own."
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-battle-reducer-security,
// EV-battle-lifecycle-gc, EV-ranking-pve-exclusion, EV-wild-individuality-privacy,
// EV-practice-xp, ST-battle_tests#reducer-guards, ST-battle_tests#writeback-economy).
//
// Every reducer runs through `Fixture::run_as(_at)` with a real sender against its
// tables' real indexes. HOST LIMIT: no transaction rollback, so a rejection is
// asserted as refusal BEFORE any write (the whole battle store byte-identical);
// rollback semantics stay with the two-identity e2e specs (my-battle-privacy,
// monster-privacy). Wins are driven by calling `write_back_battle_results`
// directly: a turn's damage is `ctx.random()`-driven, so the reducer tests assert
// guards and state CHANGES only, never a damage number.
// ===========================================================================

use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Battle, BattleWild, Inventory, Monster, MonsterPub, Player, PlayerWallet, SkillRow, SpeciesRow,
};
use game_core::BattleOutcome;
use spacetimedb::{Identity, Timestamp};

const BN_T0: i64 = 1_750_000_000_000;
const BN_DAY: i64 = 86_400_000;
const BN_BATTLE: u64 = 900;

fn bn_a() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
fn bn_b() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
fn bn_c() -> Identity {
    Identity::from_byte_array([0xC3; 32])
}
fn bn_at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// A private monster row (species 1, level 7) whose GENES are distinct per id.
fn bn_monster(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
    let g = (monster_id % 29) as u8 + 1;
    let e = u16::from(g);
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 1,
        nickname: format!("m{monster_id}"),
        level: 7,
        xp: 0,
        iv_hp: g,
        iv_attack: g + 1,
        iv_defense: g + 2,
        iv_speed: g + 3,
        iv_sp_attack: g + 4,
        iv_sp_defense: g + 5,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: e,
        ev_attack: e + 1,
        ev_defense: e + 2,
        ev_speed: e + 3,
        ev_sp_attack: e + 4,
        ev_sp_defense: e + 5,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 40,
        party_slot,
        last_care_at_ms: 0,
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
}

/// A battle-side monster: species `species_id`, level 7, `hp` of 200 max, skill 1.
fn bn_mon(species_id: u32, hp: u16) -> game_core::BattleMonster {
    game_core::BattleMonster {
        species_id,
        affinity: game_core::Affinity::Fire,
        level: 7,
        current_hp: hp,
        max_hp: 200,
        stats: game_core::StatBlock {
            hp: 200,
            attack: 20,
            defense: 20,
            speed: 20,
            sp_attack: 20,
            sp_defense: 20,
        },
        known_skill_ids: vec![1],
        status: None,
    }
}

/// A battle with one side-A team member per `party` id (HP 150 each) and a single
/// species-2 opponent at full HP; `battle_id` = [`BN_BATTLE`] unless overridden.
fn bn_battle(
    player: Identity,
    opponent: Identity,
    party: &[u64],
    opponent_ids: &[u64],
    outcome: BattleOutcome,
) -> Battle {
    Battle {
        battle_id: BN_BATTLE,
        player_identity: player,
        opponent_identity: opponent,
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: party.iter().map(|_| bn_mon(1, 150)).collect(),
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: vec![bn_mon(2, 200)],
            },
            outcome,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: party.to_vec(),
        opponent_monster_ids: opponent_ids.to_vec(),
        created_at_ms: 0,
    }
}

/// Every table the battle reducers and `write_back_battle_results` touch, all
/// writable (a write reached on a refusal path shows in [`BnWorld::snapshot`]).
struct BnWorld<'a> {
    battles: Handle<'a, Battle, u64>,
    wild: Handle<'a, BattleWild, u64>,
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
    wallets: Handle<'a, PlayerWallet>,
    players: Handle<'a, Player>,
}

fn bn_world(fx: &Fixture) -> BnWorld<'_> {
    let battles = fx
        .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
        .writable()
        .unique()
        .auto_inc(|r| r.battle_id, |r, id| r.battle_id = id);
    let _ = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    let wild = fx
        .table_keyed::<BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
        .writable()
        .unique();
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let pubs = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    for (id, affinity) in [
        (1, game_core::Affinity::Fire),
        (2, game_core::Affinity::Water),
    ] {
        species.seed(&SpeciesRow {
            id,
            name: format!("sp{id}"),
            base_hp: 50,
            base_attack: 50,
            base_defense: 50,
            base_speed: 50,
            base_sp_attack: 50,
            base_sp_defense: 50,
            affinity,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 0,
        });
    }
    fx.table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
        .scannable()
        .seed(&SkillRow {
            id: 1,
            name: "Ember".to_string(),
            affinity: game_core::Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
        });
    let _ = fx
        .table_keyed::<crate::schema::TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
        .scannable();
    let _ = fx
        .table_keyed::<crate::playtest::PlaytestEvent, u64>("playtest_event", "event_id", |r| {
            r.event_id
        })
        .writable()
        .unique()
        .auto_inc(|r| r.event_id, |r, id| r.event_id = id);
    BnWorld {
        battles,
        wild,
        monsters,
        pubs,
        stacks,
        wallets,
        players: fx.table::<Player>("player", "identity", |r| r.identity),
    }
}

impl BnWorld<'_> {
    /// A monster row plus its projection (tier 2, so a fabricated tier is visible).
    fn monster(&self, id: u64, owner: Identity, party_slot: u8) {
        let m = bn_monster(id, owner, party_slot);
        self.pubs.seed(&crate::marshal::pub_from_monster(&m, 2));
        self.monsters.seed(&m);
    }
    fn stack(&self, owner: Identity, item_id: u32, count: u32) {
        self.stacks.seed(&Inventory {
            inv_id: 1000 + u64::from(item_id) + u64::from(owner.to_byte_array()[0]) * 100,
            owner_identity: owner,
            item_id,
            count,
        });
    }
    fn wild_row(&self, battle_id: u64) {
        self.wild.seed(&BattleWild {
            battle_id,
            wild_species_id: 2,
            wild_level: 7,
            individuality_seed: 0xC0FFEE,
        });
    }
    fn battle(&self, id: u64) -> Option<Battle> {
        self.battles.rows().into_iter().find(|b| b.battle_id == id)
    }
    fn mon(&self, id: u64) -> Monster {
        self.monsters
            .rows()
            .into_iter()
            .find(|m| m.monster_id == id)
            .expect("monster row")
    }
    fn count(&self, owner: Identity, item_id: u32) -> u32 {
        self.stacks
            .rows()
            .iter()
            .filter(|r| r.owner_identity == owner && r.item_id == item_id)
            .map(|r| r.count)
            .sum()
    }
    fn balance(&self, owner: Identity) -> u64 {
        self.wallets
            .rows()
            .iter()
            .filter(|r| r.owner_identity == owner)
            .map(|r| r.balance)
            .sum()
    }
    /// The whole battle-relevant store as bytes: a refusal must leave it identical.
    fn snapshot(&self) -> Vec<Vec<u8>> {
        use spacetimedb::sats::bsatn::to_vec;
        vec![
            to_vec(&self.battles.rows()).unwrap(),
            to_vec(&self.wild.rows()).unwrap(),
            to_vec(&self.monsters.rows()).unwrap(),
            to_vec(&self.pubs.rows()).unwrap(),
            to_vec(&self.stacks.rows()).unwrap(),
            to_vec(&self.wallets.rows()).unwrap(),
        ]
    }
    /// EV-monster-dual-write oracle: the projection set equals the private set and
    /// every projection is exactly `pub_from_monster(private, its tier)`.
    fn assert_mirrored(&self, label: &str) {
        bn_assert_mirrored(label, &self.monsters.rows(), &self.pubs.rows());
    }
}

/// Shared dual-write oracle (also used by the monster_mgmt roster's spirit): same id
/// set, and each `monster_pub` row is the full-row projection of its private row.
pub(crate) fn bn_assert_mirrored(label: &str, monsters: &[Monster], pubs: &[MonsterPub]) {
    let mut ids: Vec<u64> = monsters.iter().map(|m| m.monster_id).collect();
    let mut pub_ids: Vec<u64> = pubs.iter().map(|p| p.monster_id).collect();
    ids.sort_unstable();
    pub_ids.sort_unstable();
    assert_eq!(
        ids, pub_ids,
        "{label}: monster and monster_pub must hold the same id set"
    );
    for m in monsters {
        let p = pubs
            .iter()
            .find(|p| p.monster_id == m.monster_id)
            .expect("paired projection");
        assert_eq!(
            bn_bytes(p),
            bn_bytes(&crate::marshal::pub_from_monster(m, p.tier)),
            "{label}: monster_pub {} diverged from its private row",
            m.monster_id
        );
    }
}

/// BSATN bytes: row types carry no `PartialEq`/`Debug`; canonical bytes ARE equality.
fn bn_bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
    spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
}

type BnCall = fn(&spacetimedb::ReducerContext) -> Result<(), String>;

/// The four in-battle PvE action reducers against [`BN_BATTLE`].
fn bn_actions() -> Vec<(&'static str, BnCall)> {
    vec![
        ("submit_attack", |ctx| {
            super::submit_attack(ctx, BN_BATTLE, 1)
        }),
        ("swap_active", |ctx| super::swap_active(ctx, BN_BATTLE, 1)),
        ("flee", |ctx| super::flee(ctx, BN_BATTLE)),
        ("use_battle_item", |ctx| {
            super::use_battle_item(ctx, BN_BATTLE, 3)
        }),
    ]
}

/// A wild battle for A with party [11, 12], active poisoned, an Antidote (item 3) held.
fn bn_wild_setup(w: &BnWorld<'_>, outcome: BattleOutcome) {
    w.monster(11, bn_a(), 0);
    w.monster(12, bn_a(), 1);
    let mut b = bn_battle(bn_a(), crate::WILD_IDENTITY, &[11, 12], &[], outcome);
    b.state.side_a.team[0].status = Some(game_core::StatusEffect::Poison);
    w.battles.seed(&b);
    w.wild_row(BN_BATTLE);
    w.stack(bn_a(), 3, 2);
}

/// EV-battle-reducer-security (ownership) + ST-battle_tests#reducer-guards: a STRANGER
/// gets the exact owner reject from every action reducer with the store untouched;
/// the OWNER's call runs and visibly changes the battle.
/// kills: each reducer -> Ok(()), the Ongoing comparators flipped (owner refused).
#[test]
fn bn_battle_actions_refuse_a_stranger_and_admit_the_owner() {
    for (label, call) in bn_actions() {
        let fx = fixture();
        let w = bn_world(&fx);
        bn_wild_setup(&w, BattleOutcome::Ongoing);
        let before = w.snapshot();
        let got = fx.run_as_at(bn_b(), bn_at(BN_T0), call);
        assert_eq!(got, Err("not owner".to_string()), "{label}: stranger");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");

        let state_before = w.battle(BN_BATTLE).unwrap().state;
        let got = fx.run_as_at(bn_a(), bn_at(BN_T0), call);
        assert_eq!(
            got,
            Ok(()),
            "{label}: owner; asked {:?}",
            fx.requested_indexes()
        );
        let after = w.battle(BN_BATTLE).expect("battle row kept");
        assert_ne!(
            after.state, state_before,
            "{label}: the owner's call changed nothing"
        );
        match label {
            "flee" => {
                assert_eq!(after.state.outcome, BattleOutcome::Fled);
                assert!(w.wild.rows().is_empty(), "flee: battle_wild row deleted");
            }
            "swap_active" => assert_eq!(after.state.side_a.active, 1),
            "use_battle_item" => {
                assert_eq!(after.state.side_a.team[0].status, None);
                assert_eq!(w.count(bn_a(), 3), 1, "exactly one Antidote consumed");
            }
            _ => assert!(after.state.turn_number > state_before.turn_number),
        }
        w.assert_mirrored(label);
    }
}

/// every action reducer refuses a terminal battle with no XP, currency, item or row
/// change.
#[test]
fn bn_battle_actions_refuse_a_terminal_battle() {
    for outcome in [
        BattleOutcome::Fled,
        BattleOutcome::SideAWins,
        BattleOutcome::SideBWins,
    ] {
        for (label, call) in bn_actions() {
            let fx = fixture();
            let w = bn_world(&fx);
            bn_wild_setup(&w, outcome);
            let before = w.snapshot();
            let got = fx.run_as_at(bn_a(), bn_at(BN_T0), call);
            assert_eq!(
                got,
                Err("battle is not ongoing".to_string()),
                "{label} on {outcome:?}"
            );
            assert_eq!(w.snapshot(), before, "{label} on {outcome:?}: untouched");
        }
    }
}

/// EV-ranking-pve-exclusion: the four PvE reducers refuse a RANKED PvP battle (two
/// distinct real players) with the row unchanged, whoever of the two calls (side B
/// is not the row's owner). Control: a practice self-battle is not ranked and runs.
#[test]
fn bn_pve_actions_refuse_a_ranked_pvp_battle() {
    for (label, call) in bn_actions() {
        let fx = fixture();
        let w = bn_world(&fx);
        w.monster(11, bn_a(), 0);
        w.monster(12, bn_a(), 1);
        w.monster(21, bn_b(), 0);
        let mut b = bn_battle(bn_a(), bn_b(), &[11, 12], &[21], BattleOutcome::Ongoing);
        b.state.side_a.team[0].status = Some(game_core::StatusEffect::Poison);
        w.battles.seed(&b);
        w.stack(bn_a(), 3, 2);
        let before = w.snapshot();
        assert_eq!(
            fx.run_as_at(bn_a(), bn_at(BN_T0), call),
            Err("not available in PvP battles".to_string()),
            "{label}: side A of a ranked battle"
        );
        assert_eq!(
            fx.run_as_at(bn_b(), bn_at(BN_T0), call),
            Err("not owner".to_string()),
            "{label}: side B of a ranked battle"
        );
        assert_eq!(w.snapshot(), before, "{label}: ranked battle untouched");

        // Practice control: the same shape with A on both sides.
        drop(fx);
        let fx = fixture();
        let w = bn_world(&fx);
        w.monster(11, bn_a(), 0);
        w.monster(12, bn_a(), 1);
        w.monster(13, bn_a(), 2);
        let mut b = bn_battle(bn_a(), bn_a(), &[11, 12], &[13], BattleOutcome::Ongoing);
        b.state.side_a.team[0].status = Some(game_core::StatusEffect::Poison);
        w.battles.seed(&b);
        w.stack(bn_a(), 3, 2);
        assert_eq!(
            fx.run_as_at(bn_a(), bn_at(BN_T0), call),
            Ok(()),
            "{label}: a practice battle is not ranked"
        );
    }
}

/// ST-battle_tests#reducer-guards (fainted rules): submit_attack refuses a fainted
/// active and an unknown skill; swap_active refuses a fainted target, an
/// out-of-range index and the current active; flee deliberately has no fainted
/// guard. Status bookkeeping: a sleeping opponent's counter advances on the row.
#[test]
fn bn_fainted_and_move_legality_guards() {
    let seed = |w: &BnWorld<'_>, active_hp: u16, target_hp: u16| {
        w.monster(11, bn_a(), 0);
        w.monster(12, bn_a(), 1);
        let mut b = bn_battle(
            bn_a(),
            crate::WILD_IDENTITY,
            &[11, 12],
            &[],
            BattleOutcome::Ongoing,
        );
        b.state.side_a.team[0].current_hp = active_hp;
        b.state.side_a.team[1].current_hp = target_hp;
        b.state.side_b.team[0].status = Some(game_core::StatusEffect::Sleep { turns_remaining: 3 });
        w.battles.seed(&b);
        w.wild_row(BN_BATTLE);
    };
    type Case = (&'static str, u16, u16, BnCall, Result<(), String>);
    let cases: Vec<Case> = vec![
        (
            "attack with a fainted active",
            0,
            150,
            |ctx| super::submit_attack(ctx, BN_BATTLE, 1),
            Err("your active monster has fainted — swap to another monster or flee".to_string()),
        ),
        (
            "attack with an unknown skill",
            150,
            150,
            |ctx| super::submit_attack(ctx, BN_BATTLE, 99),
            Err("skill 99 not in active monster's moveset".to_string()),
        ),
        (
            "swap to a fainted monster",
            150,
            0,
            |ctx| super::swap_active(ctx, BN_BATTLE, 1),
            Err("monster at index 1 is fainted".to_string()),
        ),
        (
            "swap out of range",
            150,
            150,
            |ctx| super::swap_active(ctx, BN_BATTLE, 2),
            Err("team_index 2 out of bounds".to_string()),
        ),
        (
            "swap to the active",
            150,
            150,
            |ctx| super::swap_active(ctx, BN_BATTLE, 0),
            Err("already the active monster".to_string()),
        ),
    ];
    for (label, active_hp, target_hp, call, want) in cases {
        let fx = fixture();
        let w = bn_world(&fx);
        seed(&w, active_hp, target_hp);
        let before = w.snapshot();
        assert_eq!(fx.run_as_at(bn_a(), bn_at(BN_T0), call), want, "{label}");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    // flee with a fainted active is allowed (the escape hatch).
    {
        let fx = fixture();
        let w = bn_world(&fx);
        seed(&w, 0, 150);
        assert_eq!(
            fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::flee(ctx, BN_BATTLE)),
            Ok(())
        );
        assert_eq!(
            w.battle(BN_BATTLE).unwrap().state.outcome,
            BattleOutcome::Fled
        );
    }
    // A legal attack and a legal swap write the advanced status store back while Ongoing.
    for (label, call) in [
        (
            "attack",
            (|ctx| super::submit_attack(ctx, BN_BATTLE, 1)) as BnCall,
        ),
        ("swap", |ctx| super::swap_active(ctx, BN_BATTLE, 1)),
    ] {
        let fx = fixture();
        let w = bn_world(&fx);
        seed(&w, 150, 150);
        assert_eq!(fx.run_as_at(bn_a(), bn_at(BN_T0), call), Ok(()), "{label}");
        let b = w.battle(BN_BATTLE).unwrap();
        assert_eq!(b.state.outcome, BattleOutcome::Ongoing, "{label}");
        assert_ne!(
            b.state.side_b.team[0].status,
            Some(game_core::StatusEffect::Sleep { turns_remaining: 3 }),
            "{label}: the turn's status bookkeeping must land on the row"
        );
    }
}

/// ST-battle_tests#reducer-guards (cure item): a non-cure item, an unknown item, a
/// cure that does not match the status, and a cure item not held are all refused
/// with nothing consumed; the matching held cure consumes exactly one and clears it.
#[test]
fn bn_use_battle_item_consumes_only_a_matching_held_cure() {
    type Case = (&'static str, u32, bool, u32, Result<(), String>);
    let cases: Vec<Case> = vec![
        (
            "not a cure",
            1,
            true,
            2,
            Err("item 1 is not a cure item".to_string()),
        ),
        (
            "unknown item",
            999,
            true,
            2,
            Err("item 999 not found".to_string()),
        ),
        (
            "status not matched",
            3,
            false,
            2,
            Err("active monster does not have status cured by item 3".to_string()),
        ),
        (
            "not held",
            3,
            true,
            0,
            Err("item is in an active trade".to_string()),
        ),
    ];
    for (label, item, poisoned, held, want) in cases {
        let fx = fixture();
        let w = bn_world(&fx);
        bn_wild_setup(&w, BattleOutcome::Ongoing);
        // A decoy stack of another item: a wrong-row count lookup would read it.
        w.stack(bn_a(), 1, 5);
        if held != 2 {
            w.stacks.remove(bn_a());
            w.stack(bn_a(), 1, 5);
        }
        if !poisoned {
            let mut b = w.battle(BN_BATTLE).unwrap();
            w.battles.remove(BN_BATTLE);
            b.state.side_a.team[0].status = Some(game_core::StatusEffect::Burn);
            w.battles.seed(&b);
        }
        let before = w.snapshot();
        assert_eq!(
            fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| {
                super::use_battle_item(ctx, BN_BATTLE, item)
            }),
            want,
            "{label}"
        );
        assert_eq!(w.snapshot(), before, "{label}: nothing consumed");
    }
}

/// EV-battle-reducer-security (provenance + ownership): start_battle refuses a
/// third-party opponent, a foreign side-A monster, a side-B monster the
/// named opponent does not own, a boxed monster, duplicates across the two lists and
/// an empty party — each before any write. Controls: a self battle and a WILD battle
/// insert exactly one Ongoing row naming the caller and the opponent as given.
#[test]
fn bn_start_battle_enforces_provenance_and_ownership() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(12, bn_a(), 1);
    w.monster(13, bn_a(), crate::PARTY_SLOT_NONE);
    w.monster(21, bn_b(), 0);
    w.monster(50, crate::WILD_IDENTITY, 0);
    let me = bn_a();
    type Case = (&'static str, Identity, Vec<u64>, Vec<u64>, &'static str);
    let cases: Vec<Case> = vec![
        (
            "third-party opponent",
            bn_b(),
            vec![11],
            vec![21],
            "opponent must be self or server-authored (PvP unsupported)",
        ),
        (
            "dup in party",
            me,
            vec![11, 11],
            vec![12],
            "duplicate monster_id 11 in party_monster_ids",
        ),
        (
            "dup across sides",
            me,
            vec![11],
            vec![11],
            "duplicate monster_id 11 in opponent_monster_ids",
        ),
        (
            "foreign party monster",
            me,
            vec![21],
            vec![12],
            "monster 21 not owned by caller",
        ),
        (
            "opponent monster not the opponent's",
            me,
            vec![11],
            vec![21],
            "monster 21 not owned by opponent",
        ),
        (
            "wild opponent with the caller's monster",
            crate::WILD_IDENTITY,
            vec![11],
            vec![12],
            "monster 12 not owned by opponent",
        ),
    ];
    for (label, opp, party, opps, want) in cases {
        let before = w.snapshot();
        let got = fx.run_as_at(me, bn_at(BN_T0), |ctx| {
            super::start_battle(ctx, opp, party.clone(), opps.clone())
        });
        assert_eq!(got, Err(want.to_string()), "{label}");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    let before = w.snapshot();
    let got = fx.run_as_at(me, bn_at(BN_T0), |ctx| {
        super::start_battle(ctx, me, vec![13], vec![12])
    });
    assert!(got.is_err(), "boxed monster must be refused: {got:?}");
    assert!(
        fx.run_as_at(me, bn_at(BN_T0), |ctx| super::start_battle(
            ctx,
            me,
            vec![],
            vec![12]
        ))
        .is_err(),
        "empty party"
    );
    assert_eq!(w.snapshot(), before, "boxed/empty refused before any write");

    // Controls.
    assert_eq!(
        fx.run_as_at(me, bn_at(BN_T0), |ctx| {
            super::start_battle(ctx, me, vec![11], vec![12])
        }),
        Ok(())
    );
    let rows = w.battles.rows();
    assert_eq!(rows.len(), 1, "exactly one battle row");
    let b = &rows[0];
    assert_eq!(
        (b.player_identity, b.opponent_identity, b.state.outcome),
        (me, me, BattleOutcome::Ongoing)
    );
    assert_eq!(
        (
            b.party_monster_ids.clone(),
            b.opponent_monster_ids.clone(),
            b.created_at_ms
        ),
        (vec![11], vec![12], BN_T0)
    );
    assert_eq!(
        fx.run_as_at(me, bn_at(BN_T0), |ctx| {
            super::start_battle(ctx, me, vec![11], vec![12])
        }),
        Err("already in an ongoing battle".to_string()),
        "a second concurrent battle"
    );
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(50, crate::WILD_IDENTITY, 0);
    assert_eq!(
        fx.run_as_at(me, bn_at(BN_T0), |ctx| {
            super::start_battle(ctx, crate::WILD_IDENTITY, vec![11], vec![50])
        }),
        Ok(())
    );
    let rows = w.battles.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].player_identity, rows[0].opponent_identity),
        (me, crate::WILD_IDENTITY)
    );
}

/// a player seated as SIDE B of an ongoing PvP battle cannot open or act outside it
/// — start_battle, begin_encounter, heal_party, care, train and evolve all refuse,
/// before any write.
/// Control: once that battle is terminal, start_battle and begin_encounter run.
#[test]
fn bn_side_b_of_an_ongoing_pvp_battle_is_blocked_everywhere() {
    use crate::schema::{Character, HealLocationRow};
    fn setup(fx: &Fixture, outcome: BattleOutcome) -> BnWorld<'_> {
        let w = bn_world(fx);
        w.monster(11, bn_a(), 0);
        w.monster(12, bn_a(), 1);
        w.monster(31, bn_c(), 0);
        let mut b = bn_battle(bn_c(), bn_a(), &[31], &[11], outcome);
        b.battle_id = 700;
        w.battles.seed(&b);
        w.players.seed(&Player {
            identity: bn_a(),
            entity_id: 5,
            name: String::new(),
            online: true,
            last_input_seq: 0,
        });
        fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .seed(&Character {
                entity_id: 5,
                zone_id: 0,
                tile_x: 0,
                tile_y: 0,
                facing: game_core::Direction::South,
                action: game_core::ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        fx.table_keyed::<HealLocationRow, u32>("heal_location_row", "location_id", |r| {
            r.location_id
        })
        .seed(&HealLocationRow {
            location_id: 999,
            zone_id: 0,
            tile_x: 0,
            tile_y: 0,
            cost_item_id: None,
            cost_qty: 0,
            cooldown_ms: 0,
            cost_currency: 0,
        });
        w
    }
    let cases: Vec<(&str, BnCall, &str)> = vec![
        (
            "start_battle",
            |ctx| super::start_battle(ctx, ctx.sender(), vec![11], vec![12]),
            "already in an ongoing battle",
        ),
        (
            "begin_encounter",
            |ctx| super::begin_encounter(ctx, ctx.sender(), vec![11], 2, 5, 7).map(|_| ()),
            "already in an ongoing battle",
        ),
        (
            "heal_party",
            |ctx| crate::raising::heal_party(ctx, 999),
            "cannot heal during an ongoing battle",
        ),
        (
            "care",
            |ctx| crate::raising::care(ctx, 12),
            "cannot care during an ongoing battle",
        ),
        (
            "train",
            |ctx| crate::raising::train(ctx, 12, 2),
            "cannot train during an ongoing battle",
        ),
        (
            "evolve",
            |ctx| crate::evolution::evolve(ctx, 11, 2),
            "monster is in an ongoing battle",
        ),
    ];
    for (label, call, want) in &cases {
        let fx = fixture();
        let w = setup(&fx, BattleOutcome::Ongoing);
        let before = w.snapshot();
        assert_eq!(
            fx.run_as_at(bn_a(), bn_at(BN_T0), call),
            Err(want.to_string()),
            "{label}; asked {:?}",
            fx.requested_indexes()
        );
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    for (label, call, _) in cases.iter().take(2) {
        let fx = fixture();
        let w = setup(&fx, BattleOutcome::SideAWins);
        let got = fx.run_as_at(bn_a(), bn_at(BN_T0), call);
        assert_eq!(got, Ok(()), "{label}: a finished PvP battle does not block");
        assert_eq!(w.battles.rows().len(), 2, "{label}: one new battle row");
    }
}

/// EV-wild-individuality-privacy (behavioural side) + EV-battle-reducer-security C4:
/// begin_encounter returns the INSERTED battle's id, writes a battle row naming the
/// player and the WILD sentinel, and keeps the individuality seed only in the
/// private battle_wild row keyed by that id; ending the battle (flee) deletes the
/// battle_wild row so no seed outlives its encounter. Refusals before any write:
/// a foreign monster, duplicates, an already-battling player.
#[test]
fn bn_begin_encounter_keeps_the_seed_private_and_short_lived() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(12, bn_a(), 1);
    w.monster(21, bn_b(), 0);
    // C opens an encounter first, so A's battle id is 2, never a constant 0 or 1.
    w.monster(31, bn_c(), 0);
    assert_eq!(
        fx.run_as_at(bn_c(), bn_at(BN_T0), |ctx| {
            super::begin_encounter(ctx, bn_c(), vec![31], 2, 5, 1)
        }),
        Ok(1)
    );
    w.wild.remove(1);
    let before = w.snapshot();
    for (label, party, want) in [
        ("foreign", vec![21], "monster 21 not owned by player"),
        (
            "dup",
            vec![11, 11],
            "duplicate monster_id 11 in party_monster_ids",
        ),
    ] {
        let got = fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| {
            super::begin_encounter(ctx, bn_a(), party.clone(), 2, 5, 0xBEEF)
        });
        assert_eq!(got, Err(want.to_string()), "{label}");
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
    let id = fx
        .run_as_at(bn_a(), bn_at(BN_T0), |ctx| {
            super::begin_encounter(ctx, bn_a(), vec![11, 12], 2, 5, 0xBEEF)
        })
        .expect("encounter opens");
    assert_eq!(id, 2, "the returned id is the INSERTED row's auto-inc id");
    let b = w.battle(id).expect("battle row under the returned id");
    assert_eq!(
        (b.player_identity, b.opponent_identity, b.state.outcome),
        (bn_a(), crate::WILD_IDENTITY, BattleOutcome::Ongoing)
    );
    assert_eq!(b.party_monster_ids, vec![11, 12]);
    assert_eq!(
        bn_bytes(&w.wild.rows()),
        bn_bytes(&vec![BattleWild {
            battle_id: id,
            wild_species_id: 2,
            wild_level: 5,
            individuality_seed: 0xBEEF,
        }]),
        "the seed lives only in battle_wild, keyed by the battle id"
    );
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| {
            super::begin_encounter(ctx, bn_a(), vec![11], 2, 5, 1).map(|_| ())
        }),
        Err("already in an ongoing battle".to_string())
    );
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::flee(ctx, id)),
        Ok(())
    );
    assert!(
        w.wild.rows().is_empty(),
        "the seed does not outlive the encounter"
    );
}

/// EV-battle-lifecycle-gc (its new_home): finishing a battle GCs the player's OLDER
/// terminal battles, keeping exactly one terminal row — the latest — while another
/// player's terminal row and the player's own ongoing row are untouched; on a PvP
/// write-back the OPPONENT's old terminal rows (as opponent) are GC'd too.
#[test]
fn bn_write_back_gcs_old_terminal_battles() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    for (id, player, opp, outcome) in [
        (1, bn_a(), crate::WILD_IDENTITY, BattleOutcome::Fled),
        (2, bn_a(), crate::WILD_IDENTITY, BattleOutcome::SideBWins),
        (3, bn_c(), crate::WILD_IDENTITY, BattleOutcome::Fled),
        (4, bn_c(), bn_b(), BattleOutcome::SideAWins),
        (5, bn_c(), bn_b(), BattleOutcome::Ongoing),
    ] {
        let mut b = bn_battle(player, opp, &[], &[], outcome);
        b.battle_id = id;
        w.battles.seed(&b);
    }
    w.battles.seed(&bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Ongoing,
    ));
    w.wild_row(BN_BATTLE);
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::flee(ctx, BN_BATTLE)),
        Ok(())
    );
    let mut ids: Vec<u64> = w.battles.rows().iter().map(|b| b.battle_id).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![3, 4, 5, BN_BATTLE],
        "A's two older terminal rows are GC'd; C's rows and the latest stay"
    );
    assert_eq!(
        w.battle(BN_BATTLE).unwrap().state.outcome,
        BattleOutcome::Fled
    );

    // PvP write-back: B's old terminal row (B as opponent) goes, B's ongoing stays.
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(21, bn_b(), 0);
    for (id, player, opp, outcome) in [
        (4, bn_c(), bn_b(), BattleOutcome::SideAWins),
        (5, bn_c(), bn_b(), BattleOutcome::Ongoing),
        (6, bn_b(), bn_c(), BattleOutcome::Fled),
    ] {
        let mut b = bn_battle(player, opp, &[], &[], outcome);
        b.battle_id = id;
        w.battles.seed(&b);
    }
    // The DB row is still Ongoing while write-back runs (settle commits after it).
    w.battles.seed(&bn_battle(
        bn_a(),
        bn_b(),
        &[11],
        &[21],
        BattleOutcome::Ongoing,
    ));
    let fin = bn_battle(bn_a(), bn_b(), &[11], &[21], BattleOutcome::SideBWins);
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_battle_results(&ctx, &fin), Ok(()));
    let mut ids: Vec<u64> = w.battles.rows().iter().map(|b| b.battle_id).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![5, 6, BN_BATTLE],
        "only B's terminal row AS OPPONENT is GC'd (the opponent_identity sweep)"
    );
}

/// ST-battle_tests#writeback-economy (wild win): currency = loser BST / 10, essence of
/// the DEFEATED species' affinity, XP from the SSOT formula, QT accrual, and trust
/// once per UTC day (strictly-greater day cap); every write mirrored to monster_pub.
#[test]
fn bn_wild_win_grants_rewards_with_a_daily_trust_cap() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(12, bn_a(), 1);
    let mut win = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11, 12],
        &[],
        BattleOutcome::SideAWins,
    );
    win.state.side_a.team[1].current_hp = 0; // a fainted member earns nothing
    let bst: u16 = 300;
    let base_xp = game_core::battle_xp_reward(
        game_core::Level::new(7).unwrap(),
        bst,
        game_core::Level::new(7).unwrap(),
    );
    let (xp1, lvl1, _) = game_core::apply_xp_gain(game_core::Xp::new(0), base_xp);
    let day0 = super::day_epoch_utc(BN_T0);

    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    let m = w.mon(11);
    assert_eq!(w.balance(bn_a()), game_core::battle_currency_reward(bst));
    assert_eq!(
        (m.essence_water, m.essence_fire),
        (game_core::currency::essence_battle_reward(bst), 0),
        "essence goes to the defeated species' affinity (Water), not the winner's"
    );
    assert_eq!((m.xp, m.level), (xp1.value(), lvl1.as_u8()));
    assert_eq!(
        (m.trust_favorable_count, m.trust_favorable_battle_day_epoch),
        (1, day0)
    );
    assert_eq!(
        m.quality_time_window_start_ms, BN_T0,
        "QT accrued on a wild win"
    );
    let fainted = w.mon(12);
    assert_eq!(
        (
            fainted.xp,
            fainted.essence_water,
            fainted.trust_favorable_count
        ),
        (0, 0, 0),
        "a fainted member earns nothing"
    );
    assert_eq!(
        fainted.trust_unfavorable_count, 1,
        "…and takes the faint penalty"
    );
    w.assert_mirrored("wild win");

    // Same UTC day: no second trust increment.
    let ctx = fx.ctx_at(bn_at(BN_T0 + 1000));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    assert_eq!(w.mon(11).trust_favorable_count, 1, "same day: capped");
    // Next UTC day: exactly one more.
    let ctx = fx.ctx_at(bn_at(BN_T0 + BN_DAY));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    assert_eq!(
        (
            w.mon(11).trust_favorable_count,
            w.mon(11).trust_favorable_battle_day_epoch
        ),
        (2, day0 + 1)
    );
    w.assert_mirrored("wild win, day 2");
}

/// EV-practice-xp + ST-battle_tests#writeback-economy + EV-battle-reducer-security
/// (side_b never mutated). USER RULING 2026-09-27 (BUG-practice-xp-doc-predicate-drift):
/// the 1/10 practice multiplier applies IFF `player_identity == opponent_identity`
/// (a self-practice battle against the player's OWN monsters); a PvP win against a
/// different real player earns FULL base XP, exactly like a wild win. A PvP or
/// practice win pays currency but no wild-only reward (essence, trust, QT), and
/// leaves every side-B row byte-identical.
#[test]
fn bn_xp_is_one_tenth_iff_player_is_the_opponent() {
    let bst: u16 = 300;
    let lvl = game_core::Level::new(7).unwrap();
    let base = game_core::battle_xp_reward(lvl, bst, lvl);
    assert!(
        base.value() >= 10,
        "the fixture must make 1/10 distinguishable"
    );
    for (label, opponent, want_xp) in [
        ("wild", crate::WILD_IDENTITY, base.value()),
        ("pvp vs another player", bn_b(), base.value()),
        ("self practice", bn_a(), base.value() / 10),
    ] {
        let fx = fixture();
        let w = bn_world(&fx);
        w.monster(11, bn_a(), 0);
        w.monster(21, opponent, 1);
        let opp_ids: &[u64] = if opponent == crate::WILD_IDENTITY {
            &[]
        } else {
            &[21]
        };
        let mut win = bn_battle(bn_a(), opponent, &[11], opp_ids, BattleOutcome::SideAWins);
        win.state.side_a.team[0].current_hp = 25;
        let side_b = |w: &BnWorld<'_>| {
            bn_bytes(&(
                w.monsters.rows().into_iter().find(|m| m.monster_id == 21),
                w.pubs.rows().into_iter().find(|m| m.monster_id == 21),
            ))
        };
        let side_b_before = side_b(&w);
        let ctx = fx.ctx_at(bn_at(BN_T0));
        assert_eq!(
            super::write_back_battle_results(&ctx, &win),
            Ok(()),
            "{label}"
        );
        let m = w.mon(11);
        let (xp, level, _) =
            game_core::apply_xp_gain(game_core::Xp::new(0), game_core::Xp::new(want_xp));
        assert_eq!((m.xp, m.level), (xp.value(), level.as_u8()), "{label}: XP");
        assert_eq!(m.current_hp, 25, "{label}: HP written back");
        assert_eq!(
            w.balance(bn_a()),
            game_core::battle_currency_reward(bst),
            "{label}: currency"
        );
        if opponent != crate::WILD_IDENTITY {
            assert_eq!(
                (
                    m.essence_water,
                    m.trust_favorable_count,
                    m.quality_time_window_start_ms
                ),
                (0, 0, 0),
                "{label}: no wild-only reward"
            );
        }
        if opponent == bn_b() {
            assert_eq!(side_b(&w), side_b_before, "{label}: side B untouched");
        }
        w.assert_mirrored(label);
    }
}

/// ST-battle_tests#writeback-economy (faint penalty): wild-only and saturating — a
/// fainted member at u32::MAX stays there (no overflow panic that would soft-lock the
/// battle Ongoing); a PvP loss applies no penalty.
#[test]
fn bn_faint_penalty_is_wild_only_and_saturating() {
    for (label, opponent, start, want) in [
        ("wild", crate::WILD_IDENTITY, 5u32, 6u32),
        ("wild at max", crate::WILD_IDENTITY, u32::MAX, u32::MAX),
        ("pvp", bn_b(), 5, 5),
    ] {
        let fx = fixture();
        let w = bn_world(&fx);
        let mut m = bn_monster(11, bn_a(), 0);
        m.trust_unfavorable_count = start;
        w.pubs.seed(&crate::marshal::pub_from_monster(&m, 2));
        w.monsters.seed(&m);
        w.monster(12, bn_a(), 1);
        let mut loss = bn_battle(bn_a(), opponent, &[11, 12], &[], BattleOutcome::SideBWins);
        loss.state.side_a.team[0].current_hp = 0;
        let ctx = fx.ctx_at(bn_at(BN_T0));
        assert_eq!(
            super::write_back_battle_results(&ctx, &loss),
            Ok(()),
            "{label}"
        );
        assert_eq!(w.mon(11).trust_unfavorable_count, want, "{label}");
        assert_eq!(
            w.mon(12).trust_unfavorable_count,
            0,
            "{label}: the conscious member is not penalised"
        );
        assert_eq!(
            w.mon(11).current_hp,
            0,
            "{label}: the faint is written back"
        );
        w.assert_mirrored(label);
    }
}

/// ST-battle_tests#writeback-economy (log-and-continue + settle-on-error): a missing
/// loser species or an unparseable loser level ends the credit pass with Ok and HP
/// still written; an unparseable WINNER level still pays currency; a missing
/// projection is a loud Err — and a reducer that meets it still commits the battle's
/// terminal outcome (the write-back error is logged, not propagated).
#[test]
fn bn_write_back_log_and_continue_paths() {
    // Missing loser species (id 77) -> Ok, HP written, no currency or XP.
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let mut win = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::SideAWins,
    );
    win.state.side_b.team[0].species_id = 77;
    win.state.side_a.team[0].current_hp = 28;
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    assert_eq!((w.mon(11).current_hp, w.mon(11).xp), (28, 0));
    assert_eq!(w.balance(bn_a()), 0);

    // Unparseable loser level -> Ok after the currency credit, no XP.
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let mut win = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::SideAWins,
    );
    win.state.side_b.team[0].level = 0;
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    assert_eq!(w.mon(11).xp, 0);
    assert_eq!(w.balance(bn_a()), 30);

    // Unparseable winner level -> currency and essence still paid, XP skipped.
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let mut win = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::SideAWins,
    );
    win.state.side_a.team[0].level = 0;
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_battle_results(&ctx, &win), Ok(()));
    assert_eq!(
        (w.balance(bn_a()), w.mon(11).xp, w.mon(11).essence_water),
        (30, 0, 10)
    );
    w.assert_mirrored("winner level unparseable");

    // Missing projection -> loud Err; flee still commits Fled.
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monsters.seed(&bn_monster(11, bn_a(), 0));
    w.battles.seed(&bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Ongoing,
    ));
    let fin = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Fled,
    );
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(
        super::write_back_battle_results(&ctx, &fin),
        Err("monster_pub row missing for monster 11".to_string())
    );
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::flee(ctx, BN_BATTLE)),
        Ok(()),
        "settle-on-error: the reducer still succeeds"
    );
    assert_eq!(
        w.battle(BN_BATTLE).unwrap().state.outcome,
        BattleOutcome::Fled,
        "…and commits the terminal outcome"
    );
}

/// write_back_party_hp refuses a party monster whose owner changed mid-battle (a
/// trade landed): Err, and that monster's HP is not written.
#[test]
fn bn_write_back_refuses_an_ownership_change() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_b(), 0);
    let mut fin = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Fled,
    );
    fin.state.side_a.team[0].current_hp = 3;
    let before = w.snapshot();
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(
        super::write_back_party_hp(&ctx, &fin),
        Err(
            "write_back_party_hp: ownership changed mid-battle for monster 11 — aborted"
                .to_string()
        )
    );
    assert_eq!(w.snapshot(), before);
    // The owner's own row IS written.
    drop(fx);
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::write_back_party_hp(&ctx, &fin), Ok(()));
    assert_eq!(w.mon(11).current_hp, 3);
    w.assert_mirrored("hp write-back");
}

/// ST-battle_tests#reducer-guards (disconnect clause): resolving a disconnect deletes
/// ONLY the caller's ongoing WILD battle and its battle_wild row, writing HP back;
/// the caller's PvP battle, a terminal row and another player's wild battle stay.
#[test]
fn bn_disconnect_resolves_only_the_callers_ongoing_wild_battle() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let mut mine = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Ongoing,
    );
    mine.state.side_a.team[0].current_hp = 17;
    w.battles.seed(&mine);
    w.wild_row(BN_BATTLE);
    for (id, player, opp, outcome) in [
        (1, bn_a(), bn_b(), BattleOutcome::Ongoing),
        (2, bn_c(), crate::WILD_IDENTITY, BattleOutcome::Ongoing),
        (3, bn_b(), bn_a(), BattleOutcome::Ongoing),
    ] {
        let mut b = bn_battle(player, opp, &[], &[], outcome);
        b.battle_id = id;
        w.battles.seed(&b);
    }
    w.wild_row(2);
    let ctx = fx.ctx_at(bn_at(BN_T0));
    super::resolve_wild_battle_on_disconnect(&ctx, bn_a());
    let mut ids: Vec<u64> = w.battles.rows().iter().map(|b| b.battle_id).collect();
    ids.sort_unstable();
    assert_eq!(
        ids,
        vec![1, 2, 3],
        "only the caller's ongoing wild battle goes"
    );
    assert_eq!(
        w.wild
            .rows()
            .iter()
            .map(|r| r.battle_id)
            .collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(
        w.mon(11).current_hp,
        17,
        "HP written back before the delete"
    );
    w.assert_mirrored("disconnect");
}

/// anonymize_battles replaces the erased identity in BOTH roles of every battle naming
/// it, and touches no other row.
#[test]
fn bn_anonymize_battles_scrubs_both_roles() {
    let fx = fixture();
    let w = bn_world(&fx);
    let _ = fx
        .table_keyed::<crate::pvp::PvpDeadlineSchedule, u64>(
            "pvp_deadline_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .scannable();
    for (id, player, opp, outcome) in [
        (1, bn_a(), crate::WILD_IDENTITY, BattleOutcome::Fled),
        (2, bn_b(), bn_a(), BattleOutcome::Fled),
        (3, bn_b(), bn_c(), BattleOutcome::Ongoing),
        (4, bn_b(), bn_a(), BattleOutcome::Ongoing),
    ] {
        let mut b = bn_battle(player, opp, &[], &[], outcome);
        b.battle_id = id;
        w.battles.seed(&b);
    }
    let bystander = w.battle(3).unwrap();
    let ctx = fx.ctx_at(bn_at(BN_T0));
    super::anonymize_battles(&ctx, bn_a());
    let rows = w.battles.rows();
    assert_eq!(rows.len(), 4);
    for b in &rows {
        assert!(
            b.player_identity != bn_a() && b.opponent_identity != bn_a(),
            "battle {} still names the erased identity",
            b.battle_id
        );
    }
    assert_eq!(w.battle(2).unwrap().player_identity, bn_b());
    // Force-then-tombstone: the still-Ongoing battle naming A is forced terminal
    // (against A) before A's column is swapped; the reverse order leaves it live.
    assert_eq!(
        w.battle(4).unwrap().state.outcome,
        game_core::pvp_forfeit_outcome(game_core::SideId::SideB),
        "an Ongoing battle naming the erased identity is forced terminal against it"
    );
    assert_eq!(w.battle(1).unwrap().opponent_identity, crate::WILD_IDENTITY);
    assert_eq!(
        spacetimedb::sats::bsatn::to_vec(&w.battle(3).unwrap()).unwrap(),
        spacetimedb::sats::bsatn::to_vec(&bystander).unwrap()
    );
}

/// the party is the owner's slotted monsters ordered by slot (boxed
/// and foreign monsters excluded), `None` iff there is none; a corrupt LEAD level
/// disables only `lead_party`, never the level-free id list.
#[test]
fn bn_lead_party_ids_orders_the_slotted_party_and_ignores_levels() {
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(12, bn_a(), 2);
    w.monster(11, bn_a(), 0);
    w.monster(13, bn_a(), crate::PARTY_SLOT_NONE);
    w.monster(21, bn_b(), 1);
    let ctx = fx.ctx_at(bn_at(BN_T0));
    assert_eq!(super::lead_party_ids(&ctx, bn_a()), Some(vec![11, 12]));
    assert_eq!(super::lead_party_ids(&ctx, bn_c()), None, "no party at all");
    assert_eq!(
        super::lead_party(&ctx, bn_a()).map(|(ids, lvl)| (ids, lvl.as_u8())),
        Some((vec![11, 12], 7))
    );
    // Corrupt the lead's level: the id list survives, only lead_party goes None.
    let mut lead = w.mon(11);
    w.monsters.remove(11);
    lead.level = 0;
    w.monsters.seed(&lead);
    assert_eq!(super::lead_party_ids(&ctx, bn_a()), Some(vec![11, 12]));
    assert_eq!(super::lead_party(&ctx, bn_a()).map(|(ids, _)| ids), None);
}

/// Survivors of the AFTER probe (submit_attack :757, swap_active :908): the battle
/// write-back runs EXACTLY when the turn ends the battle. A KO by attack settles a
/// wild win (currency paid, battle_wild gone); a swap into a lone 1-HP monster that
/// is knocked out settles a loss (faint penalty written, battle_wild gone).
/// The Ongoing direction (write-back must NOT run) is the `battle_wild` row that
/// survives a non-final turn, asserted here too.
#[test]
fn bn_a_battle_ending_turn_settles_and_a_non_final_turn_does_not() {
    // Attack KO -> SideAWins -> write-back.
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    let mut b = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11],
        &[],
        BattleOutcome::Ongoing,
    );
    b.state.side_b.team[0].current_hp = 1;
    b.state.side_b.team[0].status = Some(game_core::StatusEffect::Sleep { turns_remaining: 3 });
    w.battles.seed(&b);
    w.wild_row(BN_BATTLE);
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::submit_attack(
            ctx, BN_BATTLE, 1
        )),
        Ok(())
    );
    assert_eq!(
        w.battle(BN_BATTLE).unwrap().state.outcome,
        BattleOutcome::SideAWins
    );
    assert!(w.wild.rows().is_empty(), "attack KO: the write-back ran");
    assert_eq!(w.balance(bn_a()), 30, "attack KO: the win was paid");
    drop(fx);

    // Swap into a 1-HP monster that the awake opponent knocks out -> SideBWins.
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.monster(12, bn_a(), 1);
    let mut b = bn_battle(
        bn_a(),
        crate::WILD_IDENTITY,
        &[11, 12],
        &[],
        BattleOutcome::Ongoing,
    );
    b.state.side_a.team[0].current_hp = 0;
    b.state.side_a.team[1].current_hp = 1;
    w.battles.seed(&b);
    w.wild_row(BN_BATTLE);
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::swap_active(
            ctx, BN_BATTLE, 1
        )),
        Ok(())
    );
    assert_eq!(
        w.battle(BN_BATTLE).unwrap().state.outcome,
        BattleOutcome::SideBWins
    );
    assert!(w.wild.rows().is_empty(), "swap KO: the write-back ran");
    assert_eq!(
        (
            w.mon(11).trust_unfavorable_count,
            w.mon(12).trust_unfavorable_count
        ),
        (1, 1),
        "swap KO: both fainted members took the wild faint penalty"
    );
    drop(fx);

    // Non-final turns: the battle_wild row (deleted only by write-back) survives.
    for (label, call) in [
        (
            "attack",
            (|ctx| super::submit_attack(ctx, BN_BATTLE, 1)) as BnCall,
        ),
        ("swap", |ctx| super::swap_active(ctx, BN_BATTLE, 1)),
    ] {
        let fx = fixture();
        let w = bn_world(&fx);
        w.monster(11, bn_a(), 0);
        w.monster(12, bn_a(), 1);
        let mut b = bn_battle(
            bn_a(),
            crate::WILD_IDENTITY,
            &[11, 12],
            &[],
            BattleOutcome::Ongoing,
        );
        b.state.side_b.team[0].status = Some(game_core::StatusEffect::Sleep { turns_remaining: 3 });
        w.battles.seed(&b);
        w.wild_row(BN_BATTLE);
        assert_eq!(fx.run_as_at(bn_a(), bn_at(BN_T0), call), Ok(()), "{label}");
        assert_eq!(
            w.battle(BN_BATTLE).unwrap().state.outcome,
            BattleOutcome::Ongoing,
            "{label}"
        );
        assert_eq!(
            w.wild.rows().len(),
            1,
            "{label}: no write-back on a non-final turn"
        );
        assert_eq!(w.balance(bn_a()), 0, "{label}: nothing paid");
    }
}

/// Captures `log` records for this test PROCESS (nextest isolates each test).
struct BnLogSink(std::sync::Mutex<Vec<String>>);
impl log::Log for BnLogSink {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(record.args().to_string());
    }
    fn flush(&self) {}
}
static BN_LOGS: BnLogSink = BnLogSink(std::sync::Mutex::new(Vec::new()));

/// Survivor of the AFTER probe (anonymize_battles :1640): the deletion cascade logs
/// `deletion_cascade_forced_battle_terminal` for EXACTLY the battles whose outcome
/// it forced — the still-Ongoing one — and not for rows that were already terminal.
#[test]
fn bn_anonymize_logs_only_the_battles_it_forced_terminal() {
    log::set_logger(&BN_LOGS).expect("no logger installed in the native test binary");
    log::set_max_level(log::LevelFilter::Info);
    let fx = fixture();
    let w = bn_world(&fx);
    let _ = fx
        .table_keyed::<crate::pvp::PvpDeadlineSchedule, u64>(
            "pvp_deadline_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .scannable();
    for (id, outcome) in [(41, BattleOutcome::Fled), (42, BattleOutcome::Ongoing)] {
        let mut b = bn_battle(bn_b(), bn_a(), &[], &[], outcome);
        b.battle_id = id;
        w.battles.seed(&b);
    }
    let ctx = fx.ctx_at(bn_at(BN_T0));
    super::anonymize_battles(&ctx, bn_a());
    let forced: Vec<String> = BN_LOGS
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains("deletion_cascade_forced_battle_terminal"))
        .cloned()
        .collect();
    // Filtered by id, not counted: plain `cargo test` shares one process (and this
    // logger) across tests, and other anonymize tests force their own rows.
    let lines_for = |id: u64| {
        let needle = format!("\"battle_id\":{id}");
        forced.iter().filter(|l| l.contains(&needle)).count()
    };
    assert_eq!(lines_for(42), 1, "the forced battle logs once: {forced:?}");
    assert_eq!(
        lines_for(41),
        0,
        "an already-terminal battle logs nothing: {forced:?}"
    );
}

/// Dev-only `start_wild_battle` (compiled only with `--features dev_reducers`, so the
/// default suite never builds it): the zone argument must equal the caller's
/// character zone; a matching zone proceeds to the encounter-table lookup.
#[cfg(feature = "dev_reducers")]
#[test]
fn bn_start_wild_battle_checks_the_zone_argument() {
    use crate::schema::Character;
    let fx = fixture();
    let w = bn_world(&fx);
    w.monster(11, bn_a(), 0);
    w.players.seed(&Player {
        identity: bn_a(),
        entity_id: 5,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
    fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
        .seed(&Character {
            entity_id: 5,
            zone_id: 0,
            tile_x: 0,
            tile_y: 0,
            facing: game_core::Direction::South,
            action: game_core::ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
        });
    let before = w.snapshot();
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::start_wild_battle(ctx, 3)),
        Err("zone mismatch: arg 3 != character zone 0".to_string())
    );
    assert_eq!(
        fx.run_as_at(bn_a(), bn_at(BN_T0), |ctx| super::start_wild_battle(ctx, 0)),
        Err("no encounter table for zone 0".to_string())
    );
    assert_eq!(w.snapshot(), before);
}
