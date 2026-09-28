//! `raising_tests` — unit tests for the pure `evaluate_care` seam
//! (server-module/src/raising.rs).
//!
//! Declared from `raising.rs` as:
//!   `#[cfg(test)] #[path = "raising_tests.rs"] mod raising_tests;`
//! so `super` resolves to the `raising` module — giving access to
//! `evaluate_care` and `CARE_COOLDOWN_MS` by name.
//!
//! EARS criteria covered:
//!   - Care cooldown: boundary is `<`, not `<=` (equal-to-cooldown is ALLOWED).
//!   - Safe-direction clock: future last_care_at_ms only over-rejects (no bypass).
//!   - Elapsed from nonzero base works correctly.
//!
//! EG2 adds, at the bottom of this file, the essence-graph raising
//! layer: `apply_quality_time_credit`, `grant_essence`, `evaluate_essence_train`,
//! `evaluate_consume_crystalized`, the revised `care` semantics, and the
//! source-scan pins for the two new reducers' guard/tail discipline.
//!
//! Each test carries a `// kills:` comment naming which wrong implementation it
//! catches. Reference consts symbolically so they survive tuning.

use super::*;

// ---------------------------------------------------------------------------
// evaluate_train seam unit tests
//
// EARS criteria covered:
//   - WHEN train_stat is None THEN Err containing "not a training food".
//   - WHEN train_stat is Some(stat) THEN delegate to focus_train and return
//     equivalent result (same evs + same derived_stats).
//   - WHEN focus_train returns StatAtCap THEN evaluate_train returns Err.
//   - WHEN focus_train returns BudgetExhausted THEN evaluate_train returns Err.
//   - WHEN focus_train returns NoEffect (amount==0) THEN evaluate_train returns Err.
//   - Red-team F1: simultaneous per-stat and budget headroom of exactly 1 each —
//     must not panic (the .expect() in focus_train's top-off).
//   - Property: seam is a faithful pass-through for all valid (Some(stat), amount) pairs.
// ---------------------------------------------------------------------------

use game_core::focus_train;
use game_core::{EVs, IVs, Level, Nature, NatureKind, StatBlock, StatKind};
use proptest::prelude::*;

/// Bulbasaur-like base stats fixture (matches the game-core `raising::rules_tests` canonical fixture).
fn train_base() -> StatBlock {
    StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    }
}

fn train_ivs() -> IVs {
    IVs::new(15, 15, 15, 15, 15, 15).unwrap()
}

fn train_hardy() -> Nature {
    Nature::new(NatureKind::Hardy)
}

fn train_lv50() -> Level {
    Level::new(50).unwrap()
}

// ---------------------------------------------------------------------------
// evaluate_train — example-based
// ---------------------------------------------------------------------------

/// evaluate_train with train_stat=None returns Err whose message
/// contains "not a training food".
/// kills: an impl that unwraps None / treats a no-stat item as trainable
///        (would panic or return a misleading error variant).
#[test]
fn evaluate_train_rejects_non_training_food() {
    let base = train_base();
    let ivs = train_ivs();
    let evs = EVs::zero();
    let nature = train_hardy();
    let level = train_lv50();

    let result = evaluate_train(&base, &ivs, &evs, &nature, level, None, 10);
    assert!(
        result.is_err(),
        "evaluate_train with train_stat=None must return Err (item is not a training food)"
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("not a training food"),
        "error message must contain \"not a training food\"; got: {:?}",
        msg
    );
}

/// evaluate_train(Some(Attack), amount=10, fresh EVs) must return
/// a FocusTrainResult equal to calling focus_train directly (delegation parity).
/// kills: an inline EV/stat computation instead of delegating to focus_train
///        (any formula divergence surfaces as a value mismatch).
#[test]
fn evaluate_train_delegates_to_focus_train() {
    let base = train_base();
    let ivs = train_ivs();
    let evs = EVs::zero();
    let nature = train_hardy();
    let level = train_lv50();

    let seam_result = evaluate_train(
        &base,
        &ivs,
        &evs,
        &nature,
        level,
        Some(StatKind::Attack),
        10,
    );

    let oracle = focus_train(&base, &ivs, &evs, &nature, level, StatKind::Attack, 10)
        .expect("direct focus_train must succeed for fresh EVs, Attack, amount=10");

    match seam_result {
        Ok(r) => {
            assert_eq!(
                r, oracle,
                "evaluate_train(Some(Attack), 10) must return the SAME FocusTrainResult as \
                 focus_train(Attack, 10) — delegation parity; seam must not fork the math"
            );
        }
        Err(e) => {
            panic!(
                "evaluate_train(Some(Attack), 10) must be Ok (fresh EVs, plenty of headroom); \
                 got Err: {:?}",
                e
            );
        }
    }
}

/// evaluate_train surfaces StatAtCap as Err when Attack EV is already 252.
/// kills: failure to map FocusTrainError::StatAtCap to Err (would let a maxed stat
///        consume food — the reducer would burn the item for zero effect).
#[test]
fn evaluate_train_maps_stat_at_cap() {
    let base = train_base();
    let ivs = train_ivs();
    // Attack is at 252 (per-stat cap).
    let evs = EVs::new(0, 252, 0, 0, 0, 0).unwrap();
    let nature = train_hardy();
    let level = train_lv50();

    let result = evaluate_train(
        &base,
        &ivs,
        &evs,
        &nature,
        level,
        Some(StatKind::Attack),
        10,
    );
    assert!(
        result.is_err(),
        "evaluate_train must return Err when Attack EV is at cap (252); \
         a passing Ok would let the reducer consume the food for zero EV gain"
    );
}

/// evaluate_train surfaces BudgetExhausted as Err when total EVs == 510
/// but Attack is below per-stat cap.
/// kills: failure to map FocusTrainError::BudgetExhausted (would let a budget-
///        exhausted monster consume food without gaining EVs).
#[test]
fn evaluate_train_maps_budget_exhausted() {
    let base = train_base();
    let ivs = train_ivs();
    // total = 252 + 6 + 252 = 510, Attack < 252.
    let evs = EVs::new(252, 6, 252, 0, 0, 0).unwrap();
    assert_eq!(evs.total(), 510, "fixture sanity: total must be 510");
    assert!(
        evs.get(StatKind::Attack) < 252,
        "fixture sanity: Attack must be below per-stat cap"
    );
    let nature = train_hardy();
    let level = train_lv50();

    let result = evaluate_train(
        &base,
        &ivs,
        &evs,
        &nature,
        level,
        Some(StatKind::Attack),
        10,
    );
    assert!(
        result.is_err(),
        "evaluate_train must return Err when total EVs is 510 (BudgetExhausted); \
         a passing Ok would let a fully-trained monster consume food without effect"
    );
}

/// evaluate_train surfaces NoEffect as Err when train_amount==0.
/// kills: a 0-amount that silently succeeds as a no-op (would consume the food
///        without changing any EV, a silent money-sink for the player).
#[test]
fn evaluate_train_maps_no_effect() {
    let base = train_base();
    let ivs = train_ivs();
    let evs = EVs::zero();
    let nature = train_hardy();
    let level = train_lv50();

    let result = evaluate_train(&base, &ivs, &evs, &nature, level, Some(StatKind::Attack), 0);
    assert!(
        result.is_err(),
        "evaluate_train(Some(Attack), amount=0) must return Err (NoEffect); \
         an Ok here would let the reducer consume a food item for literally zero benefit"
    );
}

/// simultaneous per-stat and budget headroom of exactly 1.
/// EVs: hp=251 (headroom 1), attack=252 (at cap), defense=6 (total=509, budget headroom 1).
/// Training Hp with amount=10: grant = min(10, 252-251, 510-509) = min(10, 1, 1) = 1.
/// After: hp=252, total=510 — both constraints hit simultaneously. Must not panic.
/// Also asserts: Hp==252, total==510, Attack==252 unchanged, Defense==6 unchanged.
/// kills: a focus_train .expect("by construction") that panics when BOTH headrooms are
///        exactly 1 at the same time.
#[test]
fn evaluate_train_double_cap_simultaneous_topoff() {
    let base = train_base();
    let ivs = train_ivs();
    // hp=251, attack=252, defense=6 → total=509, per-stat Hp headroom=1, budget headroom=1.
    let evs = EVs::new(251, 252, 6, 0, 0, 0).unwrap();
    assert_eq!(evs.total(), 509, "fixture sanity: total must be 509");
    assert_eq!(evs.get(StatKind::Hp), 251, "fixture sanity: Hp must be 251");
    assert_eq!(
        evs.get(StatKind::Attack),
        252,
        "fixture sanity: Attack must be at cap"
    );
    let nature = train_hardy();
    let level = train_lv50();

    let result = evaluate_train(&base, &ivs, &evs, &nature, level, Some(StatKind::Hp), 10);

    // Must succeed (Hp has headroom of 1, budget has headroom of 1 → grant=1).
    let r = result.expect(
        "evaluate_train(Some(Hp), 10) with simultaneous per-stat+budget headroom of 1 \
         must not panic and must return Ok (grant=1)",
    );

    // Hp topped off to 252.
    assert_eq!(
        r.evs.get(StatKind::Hp),
        252,
        "Hp EV must be exactly 252 after top-off (was 251, grant=1)"
    );
    // Total at 510.
    assert_eq!(
        r.evs.total(),
        510,
        "total EVs must be exactly 510 after simultaneous top-off"
    );
    // Non-target EVs unchanged.
    assert_eq!(
        r.evs.get(StatKind::Attack),
        252,
        "Attack EV must be unchanged at 252"
    );
    assert_eq!(
        r.evs.get(StatKind::Defense),
        6,
        "Defense EV must be unchanged at 6"
    );
}

// ---------------------------------------------------------------------------
// evaluate_train — property-based (delegation parity)
// ---------------------------------------------------------------------------

/// Strategy for valid EVs (each ≤ 252, total ≤ 510).
fn arb_evs_for_train() -> impl Strategy<Value = EVs> {
    (
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
    )
        .prop_filter("total must be <= 510", |(a, b, c, d, e, f)| {
            a + b + c + d + e + f <= 510
        })
        .prop_map(|(hp, atk, def, spd, spa, spd2)| EVs::new(hp, atk, def, spd, spa, spd2).unwrap())
}

/// Strategy for any StatKind (all six variants).
fn arb_statkind_for_train() -> impl Strategy<Value = StatKind> {
    prop_oneof![
        Just(StatKind::Hp),
        Just(StatKind::Attack),
        Just(StatKind::Defense),
        Just(StatKind::Speed),
        Just(StatKind::SpAttack),
        Just(StatKind::SpDefense),
    ]
}

proptest! {
    /// evaluate_train(Some(stat), amount) is a faithful pass-through for
    /// focus_train — for every valid EV state, stat, and amount in 0..=300, the seam
    /// returns exactly the same Ok/Err as focus_train (with error mapped to String).
    /// kills: any divergence between evaluate_train and the SSOT rule, including an
    ///        impl that performs its own EV arithmetic instead of delegating.
    #[test]
    fn evaluate_train_delegation_property(
        evs in arb_evs_for_train(),
        stat in arb_statkind_for_train(),
        amount in 0u16..=300u16,
    ) {
        let base = train_base();
        let ivs = train_ivs();
        let nature = train_hardy();
        let level = train_lv50();

        let seam = evaluate_train(&base, &ivs, &evs, &nature, level, Some(stat), amount);
        let oracle = focus_train(&base, &ivs, &evs, &nature, level, stat, amount);

        match (seam, oracle) {
            (Ok(s), Ok(o)) => {
                prop_assert_eq!(
                    s,
                    o,
                    "evaluate_train(Some(stat), amount) Ok must equal focus_train Ok — \
                     seam must be a faithful pass-through, not fork the math"
                );
            }
            (Err(_seam_e), Err(_oracle_e)) => {
                // Both Err: parity is satisfied (the seam correctly surfaces the focus_train error).
                // We do NOT compare the string to the FocusTrainError enum repr because the
                // mapping is impl-defined; we only require that Ok/Err agree.
            }
            (Ok(s), Err(e)) => {
                prop_assert!(
                    false,
                    "evaluate_train returned Ok({:?}) but focus_train returned Err({:?}) — seam is too lenient",
                    s,
                    e
                );
            }
            (Err(seam_e), Ok(o)) => {
                prop_assert!(
                    false,
                    "evaluate_train returned Err({:?}) but focus_train returned Ok({:?}) — seam is too strict",
                    seam_e,
                    o
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Cooldown boundary — spec: `<` not `<=`
// ---------------------------------------------------------------------------

/// Cooldown exactly elapsed (== CARE_COOLDOWN_MS) MUST be Ok.
/// kills: an impl that uses `<=` (strict-greater-than) instead of `<` for the
/// cooldown gate — `<=` would reject at exactly the boundary, producing Err
/// where the spec requires Ok.
/// Spec: "IF the cooldown has not elapsed THEN reject" — at exactly the boundary
/// the cooldown HAS elapsed, so Ok is required.
#[test]
fn cooldown_boundary_exact_is_ok() {
    // last_care_at_ms = 0, now_ms = CARE_COOLDOWN_MS: elapsed == CARE_COOLDOWN_MS.
    // With `<` in the gate: elapsed < CARE_COOLDOWN_MS is FALSE → allowed → Ok.
    // With `<=` in the gate: elapsed <= CARE_COOLDOWN_MS is TRUE → rejected → Err (WRONG).
    let result = evaluate_care(0, CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(last=0, now=CARE_COOLDOWN_MS) must be Ok \
         (elapsed == CARE_COOLDOWN_MS is exactly at the boundary — operator must be < not <=); \
         got Err: {:?}",
        result.err()
    );
}

/// One millisecond before the boundary MUST be Err (cooldown not yet elapsed).
/// kills: an impl that uses `<` correctly for the >= comparison but has an
/// off-by-one in the subtraction (e.g. `now - last < COOLDOWN - 1`).
#[test]
fn cooldown_boundary_one_ms_before_is_err() {
    // last_care_at_ms = 0, now_ms = CARE_COOLDOWN_MS - 1: elapsed = CARE_COOLDOWN_MS - 1.
    // With correct `<`: elapsed < CARE_COOLDOWN_MS is TRUE → rejected → Err.
    let result = evaluate_care(0, CARE_COOLDOWN_MS - 1);
    assert!(
        result.is_err(),
        "evaluate_care(last=0, now=CARE_COOLDOWN_MS-1) must be Err \
         (cooldown not yet elapsed — exactly one ms short of the boundary); \
         got Ok: {:?}",
        result.ok()
    );
}

// ---------------------------------------------------------------------------
// Elapsed from a nonzero base
// ---------------------------------------------------------------------------

/// Elapsed from a nonzero last_care_at_ms baseline must compute correctly.
/// kills: an impl that hardcodes `now_ms < CARE_COOLDOWN_MS` (ignoring the
/// base) instead of `now_ms.saturating_sub(last_care_at_ms) < CARE_COOLDOWN_MS`.
#[test]
fn cooldown_elapsed_from_nonzero_base_is_ok() {
    // last_care_at_ms = 1000, now_ms = 1000 + CARE_COOLDOWN_MS.
    // elapsed = CARE_COOLDOWN_MS → allowed.
    let result = evaluate_care(1000, 1000 + CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(last=1000, now=1000+CARE_COOLDOWN_MS) must be Ok \
         (elapsed == CARE_COOLDOWN_MS from nonzero base); \
         got Err: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Safe-direction clock: future last_care_at_ms only over-rejects
// ---------------------------------------------------------------------------

/// A last_care_at_ms in the future (relative to now_ms) only over-rejects —
/// it never bypasses the cooldown.
/// kills: an impl where a future last_care_at_ms wraps around and produces a
/// spuriously large elapsed (e.g. using wrapping subtraction instead of
/// saturating_sub) — a wrap could make elapsed appear huge, bypassing the gate.
/// With saturating_sub: saturating_sub(0, 10_000) = 0 < CARE_COOLDOWN_MS → Err.
#[test]
fn future_last_care_at_ms_only_over_rejects() {
    // now_ms = 0, last_care_at_ms = 10_000 (last care is "in the future").
    // Correct: saturating_sub(0, 10_000) = 0, which is < CARE_COOLDOWN_MS → Err.
    // Wrong:   wrapping sub on i64: 0i64.wrapping_sub(10_000) = -10_000 < CARE_COOLDOWN_MS → Err
    //          (coincidentally also Err, but the semantics are wrong — do NOT rely on this).
    // The invariant: this call must be Err (never Ok — a future timestamp must not bypass gate).
    let result = evaluate_care(10_000, 0);
    assert!(
        result.is_err(),
        "evaluate_care(last=10_000, now=0) must be Err \
         (last_care_at_ms is in the future relative to now — safe-direction: \
         over-reject is fine, but the gate must never be bypassed); \
         got Ok: {:?}",
        result.ok()
    );
}

// ---------------------------------------------------------------------------
// evaluate_heal pure seam unit tests
//
// The function checks only the cooldown gate (no bond/hp arithmetic).
// Pattern mirrors evaluate_care: strict `<`, saturating_sub, safe-direction clock.
//
// EARS criteria covered:
//   - Boundary is `<` not `<=` (elapsed == cooldown is ALLOWED).
//   - One ms before boundary is REJECTED (cooldown check present and correct).
//   - Future last_heal_at_ms only over-rejects, never bypasses the gate.
// ---------------------------------------------------------------------------

/// evaluate_heal allows the heal action when elapsed == cooldown exactly.
/// kills: an impl that uses `<=` instead of `<` — `<=` would reject at exactly
/// the boundary where the spec requires the action to be ALLOWED.
/// Spec: "IF the heal cooldown has not elapsed THEN reject" — at elapsed ==
/// HEAL_COOLDOWN_MS the cooldown HAS elapsed, so Ok is required.
#[test]
fn evaluate_heal_passes_when_cooldown_elapsed() {
    // last_heal_at_ms = 0, now = HEAL_COOLDOWN_MS → elapsed == HEAL_COOLDOWN_MS.
    // With strict `<`: elapsed < HEAL_COOLDOWN_MS is FALSE → allowed → Ok.
    // With `<=`:        elapsed <= HEAL_COOLDOWN_MS is TRUE  → rejected → Err (WRONG).
    let result = evaluate_heal(0, HEAL_COOLDOWN_MS, HEAL_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_heal(last=0, now=HEAL_COOLDOWN_MS, cooldown=HEAL_COOLDOWN_MS) must be Ok \
         (elapsed == cooldown is exactly at the boundary — operator must be < not <=); \
         got Err: {:?}",
        result.err()
    );
}

/// evaluate_heal rejects when one ms remains on the cooldown.
/// kills: missing cooldown check entirely (always returns Ok), or an off-by-one
/// where the impl uses `< cooldown - 1` instead of `< cooldown`.
#[test]
fn evaluate_heal_rejects_when_within_cooldown() {
    // elapsed = HEAL_COOLDOWN_MS - 1 → one ms short of the boundary → must reject.
    let result = evaluate_heal(0, HEAL_COOLDOWN_MS - 1, HEAL_COOLDOWN_MS);
    assert!(
        result.is_err(),
        "evaluate_heal(last=0, now=HEAL_COOLDOWN_MS-1, cooldown=HEAL_COOLDOWN_MS) must be Err \
         (cooldown not yet elapsed — exactly one ms short of the boundary); \
         got Ok: {:?}",
        result.ok()
    );
}

/// a last_heal_at_ms in the future (relative to now) only over-rejects —
/// it never wraps around to produce a spuriously large elapsed that bypasses the gate.
/// kills: an impl using wrapping/unchecked subtraction on i64; `0i64 - 10_000`
/// would yield -10_000 which is less than HEAL_COOLDOWN_MS, so the gate would
/// reject, but the safe invariant must be upheld even for signed overflow edge cases.
/// saturating_sub(0, 10_000) = 0 < HEAL_COOLDOWN_MS → Err (safe-direction, correct).
#[test]
fn evaluate_heal_rejects_future_last_heal() {
    // now = 0, last_heal_at_ms = 10_000 (last heal is "in the future" relative to now).
    // Correct with saturating_sub: saturating_sub(0, 10_000) = 0 < HEAL_COOLDOWN_MS → Err.
    // Safe direction: over-reject acceptable; gate bypass by a future timestamp is never OK.
    let result = evaluate_heal(10_000, 0, HEAL_COOLDOWN_MS);
    assert!(
        result.is_err(),
        "evaluate_heal(last=10_000, now=0, cooldown=HEAL_COOLDOWN_MS) must be Err \
         (last_heal_at_ms is in the future relative to now — safe-direction: \
         over-reject is fine, but the gate must never be bypassed); \
         got Ok: {:?}",
        result.ok()
    );
}

/// CARE_COOLDOWN_MS must equal exactly 6 hours in milliseconds (21_600_000).
///
/// Kills all 6 mutations at line 37 (positions 44, 49, 54):
///   - replace `*` with `+`: 6 + 60 * 60 * 1000 = 60066 (wrong)
///   - replace `*` with `/`: 6 / 60 * 60 * 1000 = 0 (wrong, int division)
///
/// Behavioral assertion: the cooldown policy is exactly 6 hours (21_600_000 ms).
/// A wrong constant means players can care every few milliseconds or effectively never.
#[test]
fn care_cooldown_ms_is_six_hours_in_milliseconds() {
    assert_eq!(
        CARE_COOLDOWN_MS, 21_600_000i64,
        "CARE_COOLDOWN_MS must be exactly 6 hours (21,600,000 ms); \
         any mutation of the `*` operators in `6 * 60 * 60 * 1000` produces a wrong value. \
         Kills: replace * with + (→ 60066 ms ≈ 1 min), replace * with / (→ 0 ms — always free). \
         The cooldown policy is 6h = 6 * 60 * 60 * 1000 ms."
    );
}

// ===========================================================================
// Care and train must be blocked mid-battle
//
// EARS criterion: WHEN a player calls `care` or `train` WHILE they are in an
// Ongoing battle in EITHER role (side-A wild/PvP or side-B PvP), THE SYSTEM
// SHALL reject with Err("cannot care/train during an ongoing battle").
//
// Rationale: a mid-battle `train` raises ev_hp → the level-up heal formula
// `level_up_healed_hp(current_hp, snapshot_old_max, live_new_max)` grants
// extra HP proportional to the EV bump, creating a bounded HP-laundering path
// (see ADR-0136 §2 and Test 4 differential below).
//
// ===========================================================================

/// Minimal Battle row builder.
/// Only `state.outcome` and `opponent_identity` are read by
/// `is_in_ongoing_battle_either_role`; teams can be empty.
fn ongoing_battle(
    player: spacetimedb::Identity,
    opponent: spacetimedb::Identity,
) -> crate::schema::Battle {
    crate::schema::Battle {
        battle_id: 1,
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
            outcome: game_core::BattleOutcome::Ongoing,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: vec![],
        opponent_monster_ids: vec![],
        created_at_ms: 0,
    }
}

/// both-role predicate scenarios: pins the semantics that the
/// guard relies on.
///
/// Four sub-assertions covering:
///   (a) Wild side-A: player arm fires on an Ongoing wild battle → true.
///   (b) PvP side-B: opponent arm fires when `me` is non-WILD opponent → true.
///   (c) No battle: both arms empty → false.
///   (d) Wild sentinel as opponent: opponent arm skips WILD_IDENTITY → false.
///
/// Kills any regression to `is_in_ongoing_battle_either_role` that:
///   - drops the opponent arm (b fails → false instead of true).
///   - drops the `!= WILD_IDENTITY` refinement (d fails → true instead of false).
///   - returns always-true (c fails).
///   - returns always-false (a fails).
#[test]
fn both_role_predicate_scenarios() {
    let me = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let other = spacetimedb::Identity::from_byte_array([3u8; 32]);
    let wild = crate::WILD_IDENTITY;

    // (a) Wild side-A: `me` is player_identity of an Ongoing wild battle.
    // Player arm fires; opponent arm empty.
    let row_a = ongoing_battle(me, wild);
    assert!(
        crate::guards::is_in_ongoing_battle_either_role(
            std::iter::once(&row_a),
            std::iter::empty::<&crate::schema::Battle>(),
        ),
        "ptc5a Test 3(a) FAIL: player arm with Ongoing wild battle must return true; \
         kills: dropped-player-arm impl"
    );

    // (b) PvP side-B: `me` is opponent_identity of an Ongoing PvP battle (non-WILD opponent).
    // Player arm empty; opponent arm fires because `me` != WILD_IDENTITY.
    let row_b = ongoing_battle(other, me);
    assert!(
        crate::guards::is_in_ongoing_battle_either_role(
            std::iter::empty::<&crate::schema::Battle>(),
            std::iter::once(&row_b),
        ),
        "ptc5a Test 3(b) FAIL: opponent arm with Ongoing battle where opponent==me (non-WILD) \
         must return true; kills: dropped-opponent-arm impl (the ADR-0122 gap)"
    );

    // (c) No battle: both arms empty → false.
    assert!(
        !crate::guards::is_in_ongoing_battle_either_role(
            std::iter::empty::<&crate::schema::Battle>(),
            std::iter::empty::<&crate::schema::Battle>(),
        ),
        "ptc5a Test 3(c) FAIL: empty both arms must return false; kills: always-true impl"
    );

    // (d) Wild sentinel as opponent: opponent arm has row with opponent==WILD_IDENTITY.
    // The `!= WILD_IDENTITY` refinement must skip this row → false.
    let row_d = ongoing_battle(other, wild);
    assert!(
        !crate::guards::is_in_ongoing_battle_either_role(
            std::iter::empty::<&crate::schema::Battle>(),
            std::iter::once(&row_d),
        ),
        "ptc5a Test 3(d) FAIL: opponent arm with opponent==WILD_IDENTITY must return false; \
         pins the != WILD_IDENTITY refinement (ADR-0122 D1); \
         kills: impl that drops the wild-sentinel exclusion"
    );
}

/// differential level-up-heal: documents the magnitude of the
/// HP-laundering vector that the guard closes.
///
/// A mid-battle `train` bumps ev_hp by 64 EV. When the monster then levels up
/// inside the battle, `level_up_healed_hp(current_hp, snapshot_old_max, live_new_max)`
/// uses the LIVE (post-train) new_max rather than the snapshot (pre-train) new_max —
/// granting extra HP beyond what an unmodified level-up would provide.
///
/// Assertion 1: `healed_laundered > healed_baseline` — the mid-battle EV bump
/// WOULD inflate the in-battle level-up heal (the vector is real and bounded).
///
/// Assertion 2: `is_in_ongoing_battle_either_role` returns true for a wild-battle
/// scenario — the guard REJECTS care/train mid-battle, so the laundered value
/// is unreachable and post-level-up current_hp cannot exceed `healed_baseline`.
#[test]
fn differential_level_up_heal_documents_laundering_vector() {
    use game_core::combat::xp::level_up_healed_hp;
    use game_core::derive_stats;

    let base = train_base(); // Bulbasaur-like: hp=45
    let ivs = train_ivs(); // all 15
    let nature = train_hardy(); // neutral (no modifier)
    let lv50 = train_lv50(); // Level 50
    let lv51 = game_core::Level::new(51).unwrap();

    let untrained = game_core::EVs::zero();
    // 64 EV in HP — the amount a single training session grants (common food amount).
    let trained = game_core::EVs::new(64, 0, 0, 0, 0, 0).unwrap();

    // HP at battle start (level 50, no EVs yet — the snapshot the server should use).
    let snapshot_old_max = derive_stats(&base, &ivs, &untrained, &nature, lv50).hp;

    // Level-up HP WITHOUT mid-battle train (the legitimate path).
    let baseline_new_max = derive_stats(&base, &ivs, &untrained, &nature, lv51).hp;

    // Level-up HP WITH mid-battle train applied (the illegitimate laundering path).
    let laundered_new_max = derive_stats(&base, &ivs, &trained, &nature, lv51).hp;

    let current_hp: u16 = 20; // low HP — monster took damage in battle

    let healed_baseline = level_up_healed_hp(current_hp, snapshot_old_max, baseline_new_max);
    let healed_laundered = level_up_healed_hp(current_hp, snapshot_old_max, laundered_new_max);

    // Assertion 1: the laundering path grants strictly MORE HP — the vector is real.
    assert!(
        healed_laundered > healed_baseline,
        "ptc5a Test 4 assertion 1 FAIL: expected healed_laundered ({}) > healed_baseline ({}); \
         with ev_hp bumped from 0 to 64 before level-up, derive_stats produces a larger stat_hp \
         → level_up_healed_hp grants extra HP proportional to the EV delta. \
         This quantifies the laundering vector (ADR-0136 §2). \
         [snapshot_old_max={}, baseline_new_max={}, laundered_new_max={}]",
        healed_laundered,
        healed_baseline,
        snapshot_old_max,
        baseline_new_max,
        laundered_new_max,
    );

    // Assertion 2: the guard rejects the caller mid-battle (closure).
    // A player in a wild Ongoing battle cannot invoke care/train, so `laundered_new_max`
    // is unreachable and in-battle current_hp cannot exceed `healed_baseline` after level-up.
    let me = spacetimedb::Identity::from_byte_array([7u8; 32]);
    let wild_row = ongoing_battle(me, crate::WILD_IDENTITY);
    assert!(
        crate::guards::is_in_ongoing_battle_either_role(
            std::iter::once(&wild_row),
            std::iter::empty::<&crate::schema::Battle>(),
        ),
        "ptc5a Test 4 assertion 2 FAIL: is_in_ongoing_battle_either_role must return true \
         for a player in an Ongoing wild battle — the guard REJECTS care/train mid-battle \
         (ADR-0136 closure), ensuring the laundered HP value ({}) is unreachable and \
         post-level-up current_hp cannot exceed the no-mid-train baseline ({}). \
         ptc5a-2 differential: extra heal = {} HP.",
        healed_laundered,
        healed_baseline,
        healed_laundered.saturating_sub(healed_baseline),
    );
}

// ###########################################################################
// EG2 — the essence-graph raising layer.
//
// SHAPE OF THE SUITE. The ms-level accrual rule is exercised DIRECTLY on the pure
// `apply_quality_time_credit(&mut Monster, now)` seam with hand-built rows.
//
// NOTE ON THE CONSTANTS. ADR-0175 calls all five pacing magnitudes playtest
// placeholders and the SHAPE the decision. The hand-computed expectations below
// are written against the placeholder values, so each value is pinned exactly
// ONCE, in the test whose arithmetic depends on it, with a `RETUNE` note —
// retuning is then a deliberate two-line edit (constant + its one pin), never a
// silent behaviour change. Everything else references the consts symbolically.
// Exception: ESSENCE_SOFT_CAP is game-core SSOT and is pinned there
// too; the RETUNE note in its soft-cap clamp test below names those pins.
// ###########################################################################

use crate::schema::Monster;
use game_core::Affinity;

/// One UTC day in ms — the `day(ms) = ms / 86_400_000` bucket ADR-0175 D1 uses
/// for the Quality-Time daily window. Spelled locally so the fixtures below can
/// straddle a day boundary on purpose.
const EG2_DAY_MS: i64 = 86_400_000;

/// A Quality-Time anchor sitting 1 h into UTC day 10 — far enough from both day
/// edges that every "same day" fixture below genuinely stays inside one day.
const QT_ANCHOR: i64 = 10 * EG2_DAY_MS + 3_600_000;

/// A `Monster` row with boring, known values in every column.
///
/// Distinct nonzero stats mean an accidental write to the wrong column shows up
/// as a value mismatch rather than a silent pass. Mirrors the shape
/// `marshal_tests.rs::m7b_test_monster_row` uses; kept local because that one is
/// private to its own module.
fn eg2_monster() -> Monster {
    Monster {
        monster_id: 77,
        owner_identity: spacetimedb::Identity::from_byte_array([9u8; 32]),
        species_id: 1,
        nickname: "Quill".to_string(),
        level: 12,
        xp: 340,
        iv_hp: 11,
        iv_attack: 12,
        iv_defense: 13,
        iv_speed: 14,
        iv_sp_attack: 15,
        iv_sp_defense: 16,
        nature_kind: NatureKind::Hardy,
        ev_hp: 4,
        ev_attack: 8,
        ev_defense: 12,
        ev_speed: 16,
        ev_sp_attack: 20,
        ev_sp_defense: 24,
        stat_hp: 120,
        stat_attack: 55,
        stat_defense: 45,
        stat_speed: 70,
        stat_sp_attack: 50,
        stat_sp_defense: 40,
        current_hp: 90,
        party_slot: 0,
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

/// A `Monster` row whose four Quality-Time columns carry exactly the given
/// state: `(anchor, window_ms, accum_ms, ticks_total)`.
fn qt_monster(anchor: i64, window_ms: u32, accum_ms: u32, ticks_total: u32) -> Monster {
    let mut m = eg2_monster();
    m.quality_time_window_start_ms = anchor;
    m.quality_time_window_ms = window_ms;
    m.quality_time_accum_ms = accum_ms;
    m.quality_time_ticks_total = ticks_total;
    m
}

/// The four Quality-Time columns as one tuple, for whole-state assertions:
/// `(window_start_ms, window_ms, accum_ms, ticks_total)`.
///
/// Asserting the WHOLE tuple (not one field at a time) is what makes the
/// "nothing else moved" claims in the tests below real teeth: an impl that
/// credits the right ticks while also clobbering the day window fails.
fn qt_state(m: &Monster) -> (i64, u32, u32, u32) {
    (
        m.quality_time_window_start_ms,
        m.quality_time_window_ms,
        m.quality_time_accum_ms,
        m.quality_time_ticks_total,
    )
}

/// The 8 flat essence columns in `Affinity::ALL` order (Fire..Dark).
fn essence_columns(m: &Monster) -> [u32; 8] {
    [
        m.essence_fire,
        m.essence_water,
        m.essence_plant,
        m.essence_electric,
        m.essence_earth,
        m.essence_wind,
        m.essence_light,
        m.essence_dark,
    ]
}

/// A crystalized-essence `ItemDef` (the EG3-6 shape: essence fields set, both
/// other roles `None` per validation rule R9).
fn essence_item(affinity: Affinity, amount: u32) -> game_core::ItemDef {
    game_core::ItemDef {
        id: 4,
        name: "Tidewell Shard".to_string(),
        description: "A crystalized shard humming with essence.".to_string(),
        recruit_bonus: 0,
        train_stat: None,
        train_amount: 0,
        sell_price: 200,
        cure_status: None,
        essence_affinity: Some(affinity),
        essence_amount: amount,
    }
}

/// A TRAINING-food `ItemDef` — a perfectly valid item that is NOT crystalized
/// essence (`essence_affinity: None`). The EG2-10 wrong-item fixture.
fn training_food_item() -> game_core::ItemDef {
    game_core::ItemDef {
        id: 2,
        name: "Protein Cube".to_string(),
        description: "Focus-training food.".to_string(),
        recruit_bonus: 0,
        train_stat: Some(StatKind::Attack),
        train_amount: 64,
        sell_price: 40,
        cure_status: None,
        essence_affinity: None,
        essence_amount: 0,
    }
}

// ===========================================================================
// `apply_quality_time_credit`: bounded-gap active-playtime
//
// The rule, restated from ADR-0175 D1 (this is the contract the 10 tests below
// encode, in the order the impl must evaluate it):
//   anchor = quality_time_window_start_ms; gap = now.saturating_sub(anchor)
//   now < anchor                 → re-anchor only, no credit, true
//   gap < QT_MIN_WRITE_GAP_MS    → NOTHING mutated (anchor KEPT), false
//   gap > QT_IDLE_GAP_MS         → re-anchor only, no credit, true
//   else: day(now) != day(anchor) ⇒ window_ms = 0
//         creditable = min(gap, QT_DAILY_CAP_MS - window_ms), floored at 0
//         creditable == 0 ⇒ re-anchor only, true
//         window_ms += c; accum_ms += c;
//         ticks_total = ticks_total.saturating_add(accum_ms / QT_TICK_MS);
//         accum_ms %= QT_TICK_MS; anchor = now; true
// ===========================================================================

/// A call at EXACTLY the anchor is the zero-gap no-op, not the backwards-clock
/// branch: nothing is mutated and it reports `false` (no row write).
///
/// kills: the backwards-clock test widened from `<` to `<=` (a same-instant
/// call reports a write).
#[test]
fn a_call_at_the_anchor_is_a_no_op() {
    let mut m = qt_monster(QT_ANCHOR, 1_000, 17_000, 7);
    assert!(
        !apply_quality_time_credit(&mut m, QT_ANCHOR),
        "a zero gap writes nothing"
    );
    assert_eq!(qt_state(&m), (QT_ANCHOR, 1_000, 17_000, 7));
}

/// A gap inside the idle window credits, converts whole ticks, and
/// re-anchors.
///
/// kills: an impl that never advances the anchor (every later call would
///        re-credit the same elapsed span — unbounded free ticks); an impl that
///        converts ms to ticks with the wrong divisor; an impl that banks the
///        credit in `accum_ms` but never converts it to a tick.
#[test]
fn credits_gap_within_idle_window() {
    // RETUNE: this fixture's "60 s ⇒ exactly 1 tick" arithmetic is the ONLY
    // place QT_TICK_MS's value is pinned. Change both together, deliberately.
    assert_eq!(
        QT_TICK_MS, 60_000,
        "fixture precondition (ADR-0175 D1): 1 tick == 1 active minute"
    );

    let now = QT_ANCHOR + 60_000;
    let mut m = qt_monster(QT_ANCHOR, 0, 0, 0);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(
        wrote,
        "a credited call must return true so the ctx shell writes the row back"
    );
    assert_eq!(
        qt_state(&m),
        (now, 60_000, 0, 1),
        "TEETH (EG2-8, ADR-0175 D1): a 60 s gap inside the idle window must \
         credit 60 s to the day window, convert to exactly 1 tick, leave a 0 ms \
         remainder, and RE-ANCHOR to `now`. Expected \
         (anchor, window_ms, accum_ms, ticks) = (now, 60_000, 0, 1)."
    );
}

/// EG2-8 / EG2-9 (the no-idle-accrual invariant at the unit level): a gap LONGER
/// than `QT_IDLE_GAP_MS` credits NOTHING — the player was away.
///
/// This is the unit-level half of the no-idle-accrual invariant: the `nh`
/// time-skip test at the end of this file proves the SCHEDULED tick grows
/// nothing, and this proves that even a genuine player call cannot launder
/// away-from-keyboard time into Quality Time.
///
/// kills: an impl with no idle bound at all (10 idle minutes would credit 10
///        ticks — leave the game running overnight and the top Quality-Time tier
///        arrives free); an impl that clamps the gap to the idle bound instead of
///        dropping it (would still credit 2 ticks here).
#[test]
fn reanchors_without_credit_beyond_idle_gap() {
    // RETUNE: the only pin of QT_IDLE_GAP_MS's value (see credits_gap... above).
    assert_eq!(
        QT_IDLE_GAP_MS, 120_000,
        "fixture precondition (ADR-0175 D1): 2 min of silence means 'away'"
    );

    let now = QT_ANCHOR + 600_000; // 10 minutes — far beyond the idle bound.
    let mut m = qt_monster(QT_ANCHOR, 1_000, 17_000, 7);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(
        wrote,
        "the re-anchor must be persisted (true) — otherwise the stale anchor \
         makes the NEXT call look idle too, and an idle bound that never resets \
         locks the monster out of Quality Time forever"
    );
    assert_eq!(
        qt_state(&m),
        (now, 1_000, 17_000, 7),
        "TEETH (EG2-8/EG2-9, ADR-0175 D1): a gap beyond QT_IDLE_GAP_MS must move \
         the anchor to `now` and change NOTHING else — no window, no accum, no \
         ticks. Idle time NEVER credits."
    );
}

/// The first-ever call on a fresh monster (anchor 0) only anchors.
///
/// A brand-new row carries `quality_time_window_start_ms = 0`, so the gap is the
/// whole Unix epoch — it lands in the idle branch BY CONSTRUCTION.
///
/// kills: an impl that special-cases anchor 0 by crediting the elapsed span —
///        `now / QT_TICK_MS` is ~29 million ticks, so the very first `care` would
///        saturate `quality_time_ticks_total` and hand out the top Quality-Time
///        tier to a monster that has never been played with.
#[test]
fn first_call_only_anchors() {
    let now = 1_700_000_000_000i64; // a realistic wall clock, ~2023-11.
    let mut m = qt_monster(0, 0, 0, 0);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(wrote, "the first call must persist its fresh anchor");
    assert_eq!(
        qt_state(&m),
        (now, 0, 0, 0),
        "TEETH (EG2-8, ADR-0175 D1): the first-ever call must ONLY anchor — zero \
         window, zero accum, zero ticks. The epoch-sized gap is idle by \
         construction, not a jackpot."
    );
}

/// A backwards server clock re-anchors and credits nothing.
///
/// The `now < anchor` test must be evaluated FIRST — before the min-write-gap
/// test — because `saturating_sub` collapses a backwards gap to 0, which would
/// otherwise be read as "sub-threshold, keep the anchor".
///
/// kills: (a) an impl that orders the min-write-gap check first — the anchor
///        stays in the FUTURE, so every later call keeps saturating to gap 0 and
///        the monster silently stops earning Quality Time until wall-clock time
///        catches up; (b) an impl using wrapping/unchecked subtraction, where a
///        backwards clock produces a huge positive gap and a credit windfall.
#[test]
fn reanchors_on_backwards_clock() {
    let now = QT_ANCHOR - 10_000; // the server clock stepped backwards.
    let mut m = qt_monster(QT_ANCHOR, 500, 1_234, 3);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(
        wrote,
        "the backwards-clock re-anchor must be persisted (true) — leaving a \
         future anchor in the row is the lockout described above"
    );
    assert_eq!(
        qt_state(&m),
        (now, 500, 1_234, 3),
        "TEETH (EG2-8, ADR-0175 D1): `now < anchor` must re-anchor to `now` and \
         change NOTHING else. Expected the anchor to move BACK to now={now}."
    );
}

/// Credit accumulates across calls and converts to whole ticks, keeping
/// the sub-tick remainder.
///
/// Two sub-cases: one that lands exactly on a tick boundary, and one that must
/// leave a nonzero remainder behind.
///
/// kills: an impl that zeroes `accum_ms` after conversion instead of taking the
///        remainder (sub-case B would lose 50 s of real playtime EVERY call —
///        a monster played in short bursts could never tick); an impl that
///        converts the GAP alone and ignores the banked accumulator (sub-case A
///        would produce 1 tick, not 2).
#[test]
fn converts_whole_ticks_and_keeps_remainder() {
    // A: 50 s banked + a 70 s gap = 120 s ⇒ exactly 2 ticks, remainder 0.
    let now_a = QT_ANCHOR + 70_000;
    let mut a = qt_monster(QT_ANCHOR, 0, 50_000, 0);
    assert!(apply_quality_time_credit(&mut a, now_a));
    assert_eq!(
        qt_state(&a),
        (now_a, 70_000, 0, 2),
        "TEETH (EG2-8): 50_000 ms banked + a 70_000 ms gap is 120_000 ms of \
         active time — exactly 2 ticks with a 0 ms remainder. An impl that \
         converts only the gap would report 1."
    );

    // B: 10 s banked + a 100 s gap = 110 s ⇒ 1 tick, remainder 50 s.
    let now_b = QT_ANCHOR + 100_000;
    let mut b = qt_monster(QT_ANCHOR, 0, 10_000, 4);
    assert!(apply_quality_time_credit(&mut b, now_b));
    assert_eq!(
        qt_state(&b),
        (now_b, 100_000, 50_000, 5),
        "TEETH (EG2-8): 10_000 + 100_000 = 110_000 ms is 1 whole tick with a \
         50_000 ms REMAINDER that must be carried, not discarded. An impl that \
         resets accum_ms to 0 silently burns 50 s of real playtime here."
    );
}

/// A sub-threshold gap is a PURE no-op that returns false — and the kept
/// anchor means the batched time is credited in full by the next call.
///
/// The hot path is `enqueue_move`, which fires roughly once per tile-step for
/// EVERY party monster; without this gate each step would write up to 6 monster
/// rows plus their public projections. Returning false is what lets the ctx shell
/// skip the DB write entirely.
///
/// kills: (a) an impl that re-anchors on the sub-threshold call (it would return
///        the right `false` but silently DISCARD 3 s of real playtime per call —
///        under sustained movement almost all Quality Time would evaporate);
///        (b) an impl that returns true (a DB write on every single step, the
///        exact churn the threshold exists to prevent).
#[test]
fn below_min_write_gap_is_a_pure_noop_returning_false() {
    // RETUNE: the only pin of QT_MIN_WRITE_GAP_MS's value.
    assert_eq!(
        QT_MIN_WRITE_GAP_MS, 5_000,
        "fixture precondition (ADR-0175 D1): sub-5 s calls batch, never write"
    );

    let mut m = qt_monster(QT_ANCHOR, 4_000, 3_000, 2);

    // Call 1 — 3 s after the anchor: below the write threshold.
    let wrote = apply_quality_time_credit(&mut m, QT_ANCHOR + 3_000);
    assert!(
        !wrote,
        "TEETH (EG2-8, ADR-0175 D1): a sub-QT_MIN_WRITE_GAP_MS call must return \
         FALSE so the caller performs no DB write at all"
    );
    assert_eq!(
        qt_state(&m),
        (QT_ANCHOR, 4_000, 3_000, 2),
        "TEETH (EG2-8, ADR-0175 D1): the sub-threshold call must mutate NOTHING \
         — the ANCHOR ESPECIALLY must stay at its old value so the skipped time \
         batches instead of being lost"
    );

    // Call 2 — 10 s after the ORIGINAL anchor: the full 10 s must credit.
    let now2 = QT_ANCHOR + 10_000;
    let wrote2 = apply_quality_time_credit(&mut m, now2);
    assert!(
        wrote2,
        "a 10 s gap is above the write threshold — must return true"
    );
    assert_eq!(
        qt_state(&m),
        (now2, 14_000, 13_000, 2),
        "TEETH (EG2-8, ADR-0175 D1): the follow-up call must credit the FULL \
         10_000 ms measured from the ORIGINAL anchor (window 4_000+10_000, accum \
         3_000+10_000). An impl that re-anchored on the skipped call would credit \
         only 7_000 ms here — 3 s of real playtime lost per sub-threshold call."
    );
}

/// A gap of EXACTLY `QT_MIN_WRITE_GAP_MS` CREDITS — the no-write rule is
/// strict `<`, so the threshold value itself is on the crediting side.
///
/// Deliberately the same starting row as
/// `below_min_write_gap_is_a_pure_noop_returning_false` so the pair brackets the
/// boundary: at +3_000 ms nothing happens at all, at +5_000 ms the full 5 s
/// credits. Both directions of the comparison are now pinned, exactly as
/// `cooldown_boundary_exact_is_ok` / `cooldown_boundary_one_ms_before_is_err`
/// bracket the care cooldown.
///
/// kills: a `<=` written where ADR-0175 D1 specifies `<` — the sub-threshold
///        branch would swallow this call, returning false and dropping 5 s of
///        real playtime on a call that is supposed to be a normal credit. That
///        mutant is invisible to every other test in this file: the sibling test
///        below the threshold and the crediting tests well above it both pass
///        under it.
#[test]
fn min_write_gap_boundary_exactly_credits() {
    let now = QT_ANCHOR + QT_MIN_WRITE_GAP_MS;
    let mut m = qt_monster(QT_ANCHOR, 4_000, 3_000, 2);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(
        wrote,
        "TEETH (EG2-8, ADR-0175 D1): a gap of EXACTLY QT_MIN_WRITE_GAP_MS is NOT \
         below the threshold (the rule is `gap < QT_MIN_WRITE_GAP_MS`), so this \
         call must credit and return true"
    );
    assert_eq!(
        qt_state(&m),
        (now, 9_000, 8_000, 2),
        "TEETH (EG2-8, ADR-0175 D1): the boundary gap must credit the FULL \
         5_000 ms (window 4_000+5_000, accum 3_000+5_000, still short of a tick) \
         and re-anchor. A `<=` in the threshold test leaves the row untouched at \
         (QT_ANCHOR, 4_000, 3_000, 2)."
    );
}

/// once the day window is full, a further gap credits
/// nothing AND writes nothing: `apply_quality_time_credit` must return `false`
/// with the row completely untouched.
///
/// THE DEFECT THIS NOW GATES. The capped branch re-anchors
/// and returns `true`, so `accrue_quality_time` performs an
/// unconditional private-row update whose ONLY change is an invisible clock
/// anchor — no tick, no window, no accum, nothing a player or a gate can
/// observe. On the hottest reducer in the game, roughly one
/// call per tile-step per party monster — that is a wasted row write every ~5 s
/// per party monster for the whole remainder of the UTC day, for every capped
/// monster. THE FIX: `return false` in that branch, and do NOT re-anchor.
///
/// THE OLD `kills:` RATIONALE, AND WHY IT DOES NOT BLOCK THE FIX. It read: an
/// impl that keeps the old anchor when capped leaves a stale anchor that "makes
/// the next call look IDLE, so the first post-midnight gap would be dropped
/// instead of credited". That is NOT refuted — it is BOUNDED, and the bound is
/// what makes the trade sound:
///
///   1. MUTUAL EXCLUSION (independently re-verified in the hardening round over
///      ~500M call evaluations, never once violated). `creditable ==
///      gap.min(headroom)` and `gap >= QT_MIN_WRITE_GAP_MS = 5_000 > 0` at this
///      point, so `creditable == 0` iff `headroom == 0` iff `window_ms >= CAP`.
///      The day-rollover branch (`raising.rs:513-515`) sets `window_ms = 0`, which
///      forces `headroom == CAP` and therefore `creditable > 0`. The two branches
///      can NEVER both be taken on one call, so `return false` here drops exactly
///      ONE mutation — the re-anchor — and can never suppress a day reset.
///   2. THE RESIDUAL IS BOUNDED AT <= 4 QT TICKS, IN EITHER DIRECTION, PER UTC
///      ROLLOVER.
///      An independent Python port
///      searching ~500M call evaluations found divergence up to +/-4. Minimised
///      witness: 44 calls across one UTC rollover with `anchor = 83_466_084`,
///      `accum = 34_456`, `window = QT_DAILY_CAP_MS` — old behaviour credits 0
///      ticks, new credits 3. Four ticks, both directions, per rollover, against
///      an unconditional hot-path row write per party monster per ~5 s for the
///      rest of every capped day.
///   3. THE SURVIVING ROLLOVER PATH IS INDEPENDENTLY TESTED.
///      [`daily_cap_resets_on_next_utc_day`] (below) exercises a real
///      day-straddling credit and is UNCHANGED by this slice, as is
///      [`daily_cap_resets_after_an_idle_overnight_gap`], which owns the common
///      "capped, gone overnight, back the next day" shape.
///
/// Anchor staleness is separately bounded by the idle branch — see
/// [`capped_and_active_still_reanchors_at_the_idle_bound`], which brackets that
/// bound exactly.
///
/// kills: (a) an impl with no daily cap at all (the 60 s gap would credit another
///        tick); (b) the SHIPPED capped branch, which re-anchors and returns
///        `true` — a pure hot-path row write with no observable effect; (c) a
///        half fix that returns `false` but still re-anchors (the caller skips the
///        write, so the in-memory re-anchor is silently discarded and the two
///        disagree about the row's state — the anchor assertion catches it).
#[test]
fn daily_cap_stops_credit() {
    // RETUNE: the only pin of QT_DAILY_CAP_MS's value.
    assert_eq!(
        QT_DAILY_CAP_MS, 7_200_000,
        "fixture precondition (ADR-0175 D1): 2 h of credit per UTC day"
    );
    let cap = u32::try_from(QT_DAILY_CAP_MS)
        .expect("QT_DAILY_CAP_MS must fit the u32 quality_time_window_ms column");

    let now = QT_ANCHOR + 60_000; // same UTC day as the anchor.
    assert_eq!(
        QT_ANCHOR / EG2_DAY_MS,
        now / EG2_DAY_MS,
        "fixture sanity (12r-e E3): the call must stay INSIDE the anchor's UTC day \
         — a rollover would reset the window and make `creditable` positive, so \
         this fixture would never reach the capped branch at all"
    );
    assert!(
        now - QT_ANCHOR <= QT_IDLE_GAP_MS,
        "fixture sanity (12r-e E3): the gap must stay within the idle bound, or the \
         idle branch would return before the capped branch is ever evaluated"
    );

    let mut m = qt_monster(QT_ANCHOR, cap, 0, 120);
    let wrote = apply_quality_time_credit(&mut m, now);

    let row_write_marker = ["ctx.db.monster().monster_id()", ".update(m)"].concat();

    assert!(
        !wrote,
        "TEETH (12r-e E3): a call whose creditable amount is 0 (day window already \
         at QT_DAILY_CAP_MS) must return FALSE so `accrue_quality_time` performs NO \
         DB write. RED at HEAD: it returns true, and the ctx shell then runs an \
         unconditional `{row_write_marker}` that changes only the invisible clock \
         anchor — on `movement.rs:181`, the hottest reducer in the game, that is \
         one wasted row write per party monster per ~5 s for the rest of the UTC \
         day. The re-anchor it persists buys at most 4 QT ticks in either \
         direction across a single UTC rollover (measured over ~500M call \
         evaluations; an earlier estimate of 2 was wrong), and the day-reset branch \
         is mutually exclusive with this one, so nothing else is lost — see this \
         test's doc block for the proof and the minimised witness."
    );
    assert_eq!(
        qt_state(&m),
        (QT_ANCHOR, cap, 0, 120),
        "TEETH (12r-e E3): the capped call must mutate NOTHING — the ANCHOR \
         ESPECIALLY must stay at its old value. Returning `false` while still \
         re-anchoring in place is the worst of both worlds: the caller skips the \
         write, so the mutation is discarded anyway, and the next reader of this \
         `&mut Monster` sees an anchor the database never received. RED at HEAD, \
         which reads (QT_ANCHOR + 60_000, cap, 0, 120). (EG2-8 still holds too: \
         with the window at QT_DAILY_CAP_MS, ticks and accum must not move — one \
         marathon session must not walk the whole tier ladder.)"
    );
}

/// a capped monster's anchor staleness is bounded by
/// the IDLE branch, and the bound is EXACTLY `QT_IDLE_GAP_MS`.
///
/// This is what replaces the property [`daily_cap_stops_credit`]'s old
/// `assert!(wrote)` was reaching for. That assertion tried to guarantee "a capped
/// row's anchor never goes stale"; it bought that with an unconditional hot-path
/// row write. The real guarantee — the one that costs nothing — is that staleness
/// is CAPPED: once the gap exceeds `QT_IDLE_GAP_MS` the idle branch
/// re-anchors and returns `true`, entirely independently of
/// the daily cap. So a capped monster's anchor can never lag `now` by more than
/// `QT_IDLE_GAP_MS` while the player is still playing.
///
/// The test BRACKETS the bound with two calls on identical fresh capped rows, so
/// it pins the comparator's strictness rather than merely observing a re-anchor:
///
/// - `gap == QT_IDLE_GAP_MS` — NOT idle (the rule is strict `>`), so it falls
///   through to the capped branch: `false`, nothing moves at all, staleness
///   still growing.
/// - `gap == QT_IDLE_GAP_MS + 1` — idle: `true`, the anchor moves to `now`, and
///   still no credit, because idle time never credits.
///
/// kills: (a) a fix that also swallows the IDLE branch's re-anchor for capped
///        rows — the anchor would then never advance while capped, staleness
///        would be unbounded, and after midnight the row would look idle forever;
///        (b) an idle comparator written `>=`, which would make the bound
///        `QT_IDLE_GAP_MS - 1` and is invisible to the second half alone;
///        (c) an idle branch that credits (the window/accum/ticks equality).
#[test]
fn capped_and_active_still_reanchors_at_the_idle_bound() {
    let cap = u32::try_from(QT_DAILY_CAP_MS)
        .expect("QT_DAILY_CAP_MS must fit the u32 quality_time_window_ms column");

    let at_bound = QT_ANCHOR + QT_IDLE_GAP_MS;
    let past_bound = QT_ANCHOR + QT_IDLE_GAP_MS + 1;
    assert_eq!(
        QT_ANCHOR / EG2_DAY_MS,
        past_bound / EG2_DAY_MS,
        "fixture sanity (12r-e E3): both calls must stay inside the anchor's UTC \
         day — a rollover would zero the window and neither call would be capped"
    );

    // --- Exactly AT the bound: not idle, capped ⇒ no write, nothing moves ----
    let mut at = qt_monster(QT_ANCHOR, cap, 0, 120);
    let wrote_at = apply_quality_time_credit(&mut at, at_bound);
    assert!(
        !wrote_at,
        "TEETH (12r-e E3, lower bracket): a gap of EXACTLY QT_IDLE_GAP_MS is NOT \
         idle (the rule is strict `gap > QT_IDLE_GAP_MS`), so a capped row falls \
         through to the daily-cap branch and must return FALSE — no DB write. RED \
         at HEAD: it returns true after re-anchoring. This half is what makes the \
         bound TIGHT: without it, `capped rows re-anchor` would be satisfied by an \
         impl that re-anchors everywhere and the second half would prove nothing \
         about the boundary."
    );
    assert_eq!(
        qt_state(&at),
        (QT_ANCHOR, cap, 0, 120),
        "TEETH (12r-e E3, lower bracket): at exactly the idle bound a capped row \
         must be untouched — anchor included. RED at HEAD, which reads \
         (QT_ANCHOR + QT_IDLE_GAP_MS, cap, 0, 120)."
    );

    // --- One ms PAST the bound: idle ⇒ re-anchor, still no credit ------------
    let mut past = qt_monster(QT_ANCHOR, cap, 0, 120);
    let wrote_past = apply_quality_time_credit(&mut past, past_bound);
    assert!(
        wrote_past,
        "TEETH (12r-e E3, upper bracket / FENCE): one ms PAST QT_IDLE_GAP_MS the \
         idle branch must still fire for a CAPPED row and persist the re-anchor \
         (true). This is the fence on the 12r-e fix: the daily-cap branch returning \
         `false` must not be generalised into `capped rows never write`. If the \
         idle re-anchor were also suppressed, a capped row's anchor would never \
         advance — staleness would be unbounded instead of bounded by \
         QT_IDLE_GAP_MS, and after the next midnight every call would still \
         classify as idle, so the monster would never credit again."
    );
    assert_eq!(
        qt_state(&past),
        (past_bound, cap, 0, 120),
        "TEETH (12r-e E3, upper bracket): the idle re-anchor moves the anchor to \
         `now` and changes NOTHING else — idle time never credits, and a capped \
         window must not be reset by the idle branch either (only a UTC-day \
         rollover resets it). Together with the lower bracket this pins the bound \
         on anchor staleness at EXACTLY QT_IDLE_GAP_MS."
    );
}

/// Crossing into a new UTC day resets the day window, so credit flows
/// again.
///
/// The fixture straddles the day-10/day-11 boundary with a gap still inside the
/// idle window: 60 s before midnight to 30 s after.
///
/// kills: an impl that never resets `quality_time_window_ms` (a monster that hit
///        the cap once would be capped FOREVER — Quality Time would stop
///        accruing permanently); an impl that resets the window but forgets to
///        add the new credit to it (window would read 0 and the cap would be
///        unenforceable for the rest of the day).
#[test]
fn daily_cap_resets_on_next_utc_day() {
    let cap = u32::try_from(QT_DAILY_CAP_MS)
        .expect("QT_DAILY_CAP_MS must fit the u32 quality_time_window_ms column");

    let anchor = 11 * EG2_DAY_MS - 60_000; // 60 s before the day-11 boundary.
    let now = 11 * EG2_DAY_MS + 30_000; // 30 s after it — a 90 s gap.
    assert_ne!(
        anchor / EG2_DAY_MS,
        now / EG2_DAY_MS,
        "fixture sanity: the anchor and now must fall in DIFFERENT UTC days"
    );

    let mut m = qt_monster(anchor, cap, 0, 120);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(wrote, "a credited call must return true");
    assert_eq!(
        qt_state(&m),
        (now, 90_000, 30_000, 121),
        "TEETH (EG2-8, ADR-0175 D1): day(now) != day(anchor) must RESET the day \
         window to 0 before crediting, so the full 90_000 ms gap credits: window \
         = 90_000 (not cap, not 0), accum 90_000 ⇒ 1 tick with a 30_000 ms \
         remainder."
    );
}

/// **the realistic rollover: an IDLE overnight gap must
/// still reset the day window.** A capped day plus a night away must not become a
/// permanent lifetime cap.
///
/// THE BUG THIS GATES: the day-rollover reset sits BELOW the idle-branch early
/// return. The overwhelmingly common rollover is not a 90-second straddle of
/// midnight — it is "play until the 2 h cap on day N, log off, come back on day
/// N+1". That path takes the idle branch, which re-anchors into day N+1 and returns
/// WITHOUT touching `quality_time_window_ms`. From then on `day(now) ==
/// day(anchor)` on every subsequent call, so the reset condition can never fire
/// again: the 2 h daily cap silently degrades into a permanent LIFETIME cap and
/// Quality-Time tiers 3 and 4 become unreachable for that monster, forever.
///
/// THE FIX: hoist the day-rollover reset ABOVE the idle branch — and BELOW the
/// min-write-gap short-circuit, which must keep mutating nothing at all (pinned by
/// `below_min_write_gap_is_a_pure_noop_returning_false`).
///
/// WHAT IS ASSERTED: only the observable contract. Step 2 credits NOTHING (an idle
/// gap never credits — that rule is not being relaxed) and re-anchors;
/// `quality_time_window_ms` is deliberately NOT asserted there, because whether the
/// reset lands eagerly during step 2 or lazily at step 3 is implementation detail.
/// Step 3 is where the contract bites: a normal 60 s active gap on the new day must
/// credit normally, ending with `window_ms` at exactly 60_000.
///
/// kills: the shipped ordering (day reset below the idle branch) — the permanent
///        cap lockout. Neither existing day-window pin sees it:
///        `reanchors_without_credit_beyond_idle_gap` uses a SAME-day idle gap, and
///        `daily_cap_resets_on_next_utc_day` uses a 90 s crediting straddle — the
///        one rollover shape the buggy ordering happens to handle. Both stay green
///        under the fix.
#[test]
fn daily_cap_resets_after_an_idle_overnight_gap() {
    let cap = u32::try_from(QT_DAILY_CAP_MS)
        .expect("QT_DAILY_CAP_MS must fit the u32 quality_time_window_ms column");

    let anchor = 10 * EG2_DAY_MS + 79_200_000; // 22:00 UTC, day 10 — cap reached.
    let now_idle = anchor + 12 * 3_600_000; // 10:00 UTC, day 11 — a 12 h gap.
    let now_active = now_idle + 60_000; // one active minute later, same day 11.

    assert_ne!(
        anchor / EG2_DAY_MS,
        now_idle / EG2_DAY_MS,
        "fixture sanity: the overnight gap must cross a UTC day boundary"
    );
    assert_eq!(
        now_idle / EG2_DAY_MS,
        now_active / EG2_DAY_MS,
        "fixture sanity: steps 2 and 3 must fall on the SAME UTC day, so only a \
         reset performed at (or before) step 2 can let step 3 credit"
    );
    assert!(
        now_idle - anchor > QT_IDLE_GAP_MS,
        "fixture sanity: the overnight gap must land in the IDLE branch"
    );

    // Day 10 ended with the window at the cap and 15 s banked toward the next tick.
    let mut m = qt_monster(anchor, cap, 15_000, 120);

    // Step 2 — the player returns the next morning. Idle time never credits.
    let wrote_idle = apply_quality_time_credit(&mut m, now_idle);
    assert!(
        wrote_idle,
        "the overnight re-anchor must be persisted (true) — this is the write \
         that carries the day rollover into the row"
    );
    assert_eq!(
        m.quality_time_window_start_ms, now_idle,
        "TEETH (EG2-8): the idle overnight gap must re-anchor to `now`"
    );
    assert_eq!(
        m.quality_time_accum_ms, 15_000,
        "TEETH (EG2-9): idle time must credit NOTHING — the banked remainder is \
         untouched"
    );
    assert_eq!(
        m.quality_time_ticks_total, 120,
        "TEETH (EG2-9): idle time must credit NOTHING — no new ticks overnight"
    );
    // `quality_time_window_ms` is intentionally NOT asserted here: eager reset
    // (0 now) and lazy reset (still `cap`, cleared at step 3) are both acceptable
    // shapes. Step 3 asserts the behaviour they must share.

    // Step 3 — one ordinary active minute on the NEW day. This must credit.
    let wrote_active = apply_quality_time_credit(&mut m, now_active);
    assert!(
        wrote_active,
        "a 60 s active gap on the new day is a normal credited call"
    );
    assert_eq!(
        qt_state(&m),
        (now_active, 60_000, 15_000, 121),
        "TEETH (ADR-0175 D1, day-reset-above-the-idle-branch): after an IDLE \
         overnight gap the day window must be reset, so this ordinary 60 s active \
         gap credits in full — window_ms exactly 60_000 (a FRESH day's window, not \
         the carried-over cap), one new tick (120 ⇒ 121), the 15_000 ms remainder \
         carried. With the reset below the idle branch the window is still at \
         QT_DAILY_CAP_MS here, creditable computes to 0, and this reads \
         (now, cap, 15_000, 120): the 2 h DAILY cap has silently become a \
         permanent LIFETIME cap and tiers 3-4 are unreachable for this monster."
    );
}

/// `quality_time_ticks_total` saturates instead of wrapping or panicking.
///
/// The fixture also sits EXACTLY on the idle bound (`gap == QT_IDLE_GAP_MS`),
/// which ADR-0175 D1 specifies as still-credited (the idle test is strictly
/// greater-than).
///
/// kills: (a) a plain `+` on the tick counter — `cargo test` builds with
///        overflow checks on, so a near-max counter would PANIC inside a reducer
///        and abort the transaction; (b) an idle test written as `>=`, which
///        would drop this exactly-at-the-bound gap and leave the counter at
///        u32::MAX - 1.
#[test]
fn saturates_ticks_total() {
    let now = QT_ANCHOR + QT_IDLE_GAP_MS; // exactly at the bound ⇒ still credits.
    let mut m = qt_monster(QT_ANCHOR, 0, 0, u32::MAX - 1);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(wrote, "a credited call must return true");
    assert_eq!(
        qt_state(&m),
        (now, 120_000, 0, u32::MAX),
        "TEETH (EG2-8, ADR-0175 D1): 120_000 ms is 2 ticks, but the counter has \
         room for 1 — it must SATURATE at u32::MAX, never wrap and never panic. \
         A ticks_total of u32::MAX - 1 here instead means the idle bound was \
         written as `>=` and this exactly-at-the-bound gap was wrongly dropped."
    );
}

/// When the day window is PARTLY full, exactly the remaining headroom is
/// credited — not the whole gap, and not zero.
///
/// kills: an impl that credits `min(gap, cap)` instead of
///        `min(gap, cap - window_ms)` (the 100 s gap would credit in full and the
///        day would run 70 s over its cap, every time — the cap would leak);
///        an impl that treats "window non-empty" as "capped" and credits 0.
#[test]
fn partial_cap_credit() {
    let cap = u32::try_from(QT_DAILY_CAP_MS)
        .expect("QT_DAILY_CAP_MS must fit the u32 quality_time_window_ms column");
    let window = cap - 30_000; // exactly 30 s of headroom left today.

    let now = QT_ANCHOR + 100_000; // a 100 s gap — more than the headroom.
    let mut m = qt_monster(QT_ANCHOR, window, 0, 50);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(wrote, "a credited call must return true");
    assert_eq!(
        qt_state(&m),
        (now, cap, 30_000, 50),
        "TEETH (EG2-8, ADR-0175 D1): creditable = min(gap, cap - window) = \
         min(100_000, 30_000) = 30_000 — the window lands EXACTLY on the cap, \
         accum takes 30_000 (short of a tick, so ticks stay 50)."
    );
}

// ===========================================================================
// `grant_essence`: clamp, never reject
// ===========================================================================

/// `grant_essence` writes the ONE column matching the affinity and leaves
/// the other seven untouched — exercised for all 8 affinities.
///
/// kills: a mis-wired match arm (e.g. `Light => essence_dark`) — the whole-array
///        assertion pins the exact column per affinity, which a single-affinity
///        smoke test would miss; a `for` loop over all columns; a non-exhaustive
///        match with a catch-all no-op arm (that affinity's grant would vanish).
#[test]
fn adds_to_the_matching_affinity_only() {
    for (idx, affinity) in Affinity::ALL.iter().enumerate() {
        let mut m = eg2_monster();
        grant_essence(&mut m, *affinity, 7);

        let mut expected = [0u32; 8];
        expected[idx] = 7;

        assert_eq!(
            essence_columns(&m),
            expected,
            "TEETH (EG2-3, EG1-1): grant_essence(.., {affinity:?}, 7) must add 7 \
             to index {idx} of the Fire..Dark column order and leave the other \
             seven at 0. A wrong match arm shows up here as a shifted array."
        );
    }
}

/// The soft cap CLAMPS — it never rejects, and never overshoots.
///
/// kills: an impl that returns/propagates an error at the cap (EG1-1 says
///        "saturating_add on grant, soft cap, never reject" — a reject would let
///        a battle win fail wholesale on a maxed pool); an impl with no cap at
///        all (1_010 here); an impl that clamps to the wrong bound.
#[test]
fn clamps_at_soft_cap_999_without_reject() {
    // RETUNE: a LOCAL pin of ESSENCE_SOFT_CAP's value,
    // re-exported from game-core. The SSOT pins live there:
    // `essence_soft_cap_is_999` (game-core/src/currency.rs) and the R14 boundary
    // fixtures, `r14_essence_amount_999_accepted` / `r14_essence_amount_1000_rejected`
    // among them (game-core/src/content.rs). Retune order per currency.rs: content
    // first, then the constant, then the pins, this one and the 990 + 20 below included.
    assert_eq!(
        ESSENCE_SOFT_CAP, 999,
        "fixture precondition: the essence soft cap is 999 per pool"
    );

    let mut m = eg2_monster();
    m.essence_fire = 990;
    grant_essence(&mut m, Affinity::Fire, 20);

    assert_eq!(
        m.essence_fire, 999,
        "TEETH (EG2-3, EG1-1): 990 + 20 must CLAMP to ESSENCE_SOFT_CAP (999), \
         not reject and not land on 1_010"
    );
    assert_eq!(
        essence_columns(&m),
        [999, 0, 0, 0, 0, 0, 0, 0],
        "the clamp must not spill into any other pool"
    );
}

/// The add SATURATES before the clamp — a near-u32::MAX pool cannot panic.
///
/// Integer overflow checks are ON in a debug build (which is what `cargo test`
/// builds), so a plain `+` here would panic and abort the whole reducer
/// transaction rather than clamping.
///
/// kills: `m.essence_x = (m.essence_x + amount).min(CAP)` — the inner add
///        overflows and PANICS in a debug build (and wraps to a tiny value in
///        release, silently DELETING a nearly-full pool).
#[test]
fn saturates_before_clamp() {
    let mut m = eg2_monster();
    m.essence_water = u32::MAX - 3;
    grant_essence(&mut m, Affinity::Water, 100);

    assert_eq!(
        m.essence_water, 999,
        "TEETH (EG2-3): the grant must saturating_add THEN clamp — result 999, \
         with no overflow panic and no wrap-around to a near-zero pool"
    );
}

// ===========================================================================
// `evaluate_essence_train`: the shared 5 h cooldown seam
// ===========================================================================

/// A call inside the cooldown is rejected.
///
/// kills: a missing cooldown gate entirely (essence_train would be spammable and
///        the 999 cap reachable in one session, collapsing evolution pacing);
///        an off-by-one that admits the last millisecond.
#[test]
fn rejects_within_cooldown() {
    // RETUNE: the only pin of ESSENCE_TRAIN_COOLDOWN_MS's value (5 h).
    assert_eq!(
        ESSENCE_TRAIN_COOLDOWN_MS, 18_000_000,
        "fixture precondition: the essence-training cooldown is 5 h in ms"
    );

    let msg = match evaluate_essence_train(0, ESSENCE_TRAIN_COOLDOWN_MS - 1) {
        Ok(()) => panic!(
            "TEETH (EG2-3): evaluate_essence_train(last=0, now=cooldown-1) must \
             be Err — one ms short of the boundary is still on cooldown"
        ),
        Err(e) => e,
    };
    assert!(
        msg.contains("cooldown"),
        "the rejection must name the cooldown so the client can explain the \
         refusal; got: {msg:?}"
    );
}

/// Elapsed EXACTLY equal to the cooldown is allowed.
///
/// This is `game_core::is_cooldown_ready`'s documented `>=` boundary — the same
/// SSOT predicate `care` and `heal_party` use.
///
/// kills: an open-coded `elapsed > COOLDOWN` (or `<=` reject) that re-derives the
///        boundary instead of delegating, silently making every essence-training
///        cooldown 1 ms longer than the shared predicate says.
#[test]
fn allows_at_exact_boundary() {
    let result = evaluate_essence_train(1_000, 1_000 + ESSENCE_TRAIN_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "TEETH (EG2-3): elapsed == ESSENCE_TRAIN_COOLDOWN_MS (from a NONZERO \
         base) must be Ok — the boundary is `>=`, per game_core::is_cooldown_ready. \
         Got Err: {:?}",
        result.err()
    );
}

/// A monster that has never essence-trained (anchor 0) may train now.
///
/// `last_essence_train_at_ms` defaults to 0 exactly like `last_care_at_ms`
/// (schema.rs: "0 = epoch, cooldown elapsed, first train allowed").
///
/// kills: an impl that treats a 0 anchor as "no record ⇒ reject" (no monster
///        could EVER essence-train — the feature would be dead on arrival); an
///        impl that compares `now < COOLDOWN` instead of the elapsed span.
#[test]
fn zero_anchor_first_train_allowed() {
    let result = evaluate_essence_train(0, 1_700_000_000_000);
    assert!(
        result.is_ok(),
        "TEETH (EG2-3): a fresh monster (last_essence_train_at_ms = 0) must be \
         allowed to train. Got Err: {:?}",
        result.err()
    );
}

// ===========================================================================
// `evaluate_consume_crystalized`: the decision that runs
// BEFORE `consume_one`
// ===========================================================================

/// EG2-10 (proof-of-teeth, half 1): a wrong item — a perfectly valid TRAINING
/// food, `essence_affinity: None` — is rejected.
///
/// Because this decision seam runs BEFORE `consume_one` (pinned textually by
/// `consume_body_has_item_escrow_and_decision_before_consume`), an `Err` here is
/// exactly the "item NOT consumed" half of EG2-10.
///
/// kills: an impl that unwraps `essence_affinity` (panics, aborting the reducer);
///        an impl that defaults a missing affinity to Fire (feeding any item
///        would grant essence); an impl that grants `essence_amount` of 0 and
///        returns Ok — which BURNS the player's training food for nothing.
#[test]
fn rejects_item_without_essence_affinity() {
    let item = training_food_item();
    // Cooldown fully elapsed, so the ONLY possible reason to reject is the item.
    let result = evaluate_consume_crystalized(&item, 0, ESSENCE_TRAIN_COOLDOWN_MS);

    assert!(
        result.is_err(),
        "TEETH (EG2-10): an item with essence_affinity = None must be REJECTED \
         even with the cooldown fully elapsed — it is not crystalized essence. \
         Got Ok: {:?}",
        result.ok()
    );
}

/// Consumption shares `essence_train`'s cooldown clock.
///
/// kills: an impl that skips the cooldown for items (a player could chain-consume
///        every purchased crystal in one transaction burst — the exact
///        zero-time-gating hole EG2-4 calls out by name).
#[test]
fn rejects_within_shared_cooldown() {
    let item = essence_item(Affinity::Water, 100);
    let msg = match evaluate_consume_crystalized(&item, 0, ESSENCE_TRAIN_COOLDOWN_MS - 1) {
        Ok(granted) => panic!(
            "TEETH (EG2-4): a valid crystal inside the shared cooldown must be \
             rejected; got Ok({granted:?})"
        ),
        Err(e) => e,
    };
    assert!(
        msg.contains("cooldown"),
        "the rejection must name the cooldown, not the item; got: {msg:?}"
    );
}

/// The accepted case returns the ITEM's affinity and the ITEM's amount.
///
/// kills: an impl that returns `ESSENCE_TRAIN_AMOUNT` (5) instead of the item's
///        `essence_amount` (100) — EG3-8 sizes a crystal to fully clear an
///        authored gate in one feed, so a 5-point grant would quietly break the
///        item's whole "one-shot unlock" purpose; an impl that returns the
///        monster's own affinity, or a hardcoded one.
#[test]
fn ok_returns_affinity_and_amount() {
    let item = essence_item(Affinity::Water, 100);
    let result = evaluate_consume_crystalized(&item, 0, ESSENCE_TRAIN_COOLDOWN_MS);

    match result {
        Ok(pair) => {
            assert_eq!(
                pair,
                (Affinity::Water, 100),
                "TEETH (EG2-4): the seam must hand back the ITEM's affinity and \
                 the ITEM's essence_amount verbatim"
            );
        }
        Err(e) => panic!(
            "TEETH (EG2-4): a crystalized-essence item with the cooldown elapsed \
             must be accepted; got Err: {e:?}"
        ),
    }
}

/// The consumption boundary is the SAME instant as `essence_train`'s —
/// one clock, one constant, asserted side by side.
///
/// kills: an impl that gives `consume_crystalized_essence` its own private
///        cooldown constant (or its own open-coded predicate). The two calls
///        below share `last`/`now`, so any divergence in the constant or the
///        boundary operator makes exactly one of them disagree.
#[test]
fn shared_cooldown_boundary_allowed() {
    let item = essence_item(Affinity::Fire, 100);
    let last = 1_000i64;
    let now = last + ESSENCE_TRAIN_COOLDOWN_MS;

    let consume = evaluate_consume_crystalized(&item, last, now);
    assert!(
        consume.is_ok(),
        "TEETH (EG2-4): elapsed == ESSENCE_TRAIN_COOLDOWN_MS must be allowed for \
         consumption too. Got Err: {:?}",
        consume.err()
    );
    assert!(
        evaluate_essence_train(last, now).is_ok(),
        "TEETH (EG2-4): at the SAME (last, now) the training seam must agree — \
         item-consumption and training share ONE clock and ONE constant"
    );
}

// ===========================================================================
// the REKEY exists-predicate for `heal_cooldown`, exercised
// against REAL rows instead of against its own source text.
//
// The test below runs the shipped predicate against the in-memory host
// (native_host_tests) and pins its answer to the rows that actually exist,
// which no source scan can do.
// ===========================================================================

/// `raising::has_heal_cooldown` must answer from the CURRENT
/// rows of `heal_cooldown`, for the ASKED owner — false with no row, false
/// while only a stranger owns one, true once the owner owns one, false again
/// once the owner's row is gone (while the stranger's row survives). The paired
/// `accounts::account_has_game_data` assertions pin the `heal_cooldown`
/// disjunct of the six-way `||` chain that decides whether a guest holds game
/// data.
///
/// kills:
///   - `{ let _ = <the cooldown read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the cooldown read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a body that reads the anchor VALUE instead of row presence (for example
///     last_heal_at_ms greater than zero): the owner row seeded below carries a
///     zero anchor, so that reading goes red on the owner-row assertion.
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the `heal_cooldown` disjunct from
///     `accounts::account_has_game_data`: the paired account assertion goes red
///     while the direct predicate assertion stays green.
#[test]
fn rb41_has_heal_cooldown_tracks_real_cooldown_rows() {
    let fx = crate::native_host_tests::fixture();
    let t = fx.table::<HealCooldown>("heal_cooldown", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([15u8; 32]);
    let stranger = Identity::from_byte_array([16u8; 32]);

    assert!(
        !crate::raising::has_heal_cooldown(&ctx, owner),
        "has_heal_cooldown must be false for an owner with no cooldown row: the table is empty \
         here, so a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&HealCooldown {
        owner_identity: stranger,
        last_heal_at_ms: 0,
    });
    assert!(
        !crate::raising::has_heal_cooldown(&ctx, owner),
        "has_heal_cooldown must stay false when the ONLY cooldown row belongs to a different \
         owner: the predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    // A zero anchor is a legal cooldown row (epoch = cooldown elapsed). Row
    // PRESENCE is the whole predicate, so this row must count.
    t.seed(&HealCooldown {
        owner_identity: owner,
        last_heal_at_ms: 0,
    });
    assert!(
        crate::raising::has_heal_cooldown(&ctx, owner),
        "has_heal_cooldown must report true while the owner holds a cooldown row, whatever the \
         anchor value; a body that reads the table and then returns a constant false (the \
         ADR-0222 known-limit hollow) fails exactly here. Indexes the generated code asked the \
         host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its heal_cooldown disjunct while the owner \
         holds a cooldown row and nothing else; a deleted disjunct fails exactly here. Indexes \
         the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one cooldown row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::raising::has_heal_cooldown(&ctx, owner),
        "has_heal_cooldown must return to false once the owner's cooldown row is gone: the \
         answer tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::raising::has_heal_cooldown(&ctx, stranger),
        "removing the owner's row must leave the stranger's row untouched: without this the \
         negative above could be explained by an emptied table rather than by owner scoping. \
         Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

// ===========================================================================
// the para-4.7 deletion gate on `heal_party`.
//
// E1: WHEN `raising::heal_party` writes an ERASE-policy table
// for a mid-grace or terminal caller THE SYSTEM SHALL refuse BEFORE the write.
// `heal_party` debits `player_wallet` through the shop's own `spend_currency`
// (raising.rs:364), consumes `inventory`, writes `monster` /
// `monster_pub` and `heal_cooldown` — four ERASE-policy
// tables the cascade is about to erase, so §4.7's trigger predicate selects it
// exactly as it selected `buy` / `sell` ("the builder does not get to re-decide
// this").
//
// THREE WITNESSES, ONE CRITERION:
//   * the EXECUTED five-state matrix — the verdict really does change with the
//     CALLER's own account row;
//   * the SOURCE pins — the facts execution cannot see: the fully-qualified
//     spelling, `?;`, brace depth zero, the statement boundary, the FROZEN
//     prefix above the gate, the ordering against the first write, the tag;
//   * the FILE census — what this slice deliberately leaves open, mechanically.
//     nothing in this file is left open: the four
//     raising writers carry their own first-statement gates (pinned and executed
//     in `guards_tests.rs`), and the census counts all five gates.
//
// SCAN SUBSTRATE. Every scan reuses THIS file's existing helpers only
// (`RAISING_SOURCE`, `strip_raising_comments`, `blank_heal_scan_strings`,
// `assert_no_heal_scan_landmines`, `reducer_body`, `eg2_scan_body`) — no third
// stripper.
//
// HONEST LIMITS, stated once for the block. The source pins read text, never
// behaviour. The executed matrix reads behaviour but stops at the first guard
// PAST the gate: `Fixture::table` keys rows by the indexed column, so the
// `u64`-keyed `character` index is never seeded, an unregistered index yields
// no rows in this host, and every write syscall ABORTS the process (uncatchable,
// so `#[should_panic]` is not available). What it proves is that a
// deletion-gated caller is REFUSED exactly where an admitted one is let
// through — not that a wallet moved.
// ===========================================================================

/// Seed the one `player` row `heal_party`'s Step 1 joined check needs.
///
/// The handle is registered against the SAME fixture the caller's account handle
/// comes from — rows live in the host store, not in the handle. The row is a
/// plain struct literal, the house pattern for `Player`: unlike `Account` it has
/// no pure constructor to route through and carries no legal-state invariant.
fn rb80_seed_player(fx: &crate::native_host_tests::Fixture, me: Identity) {
    let players = fx.table::<crate::schema::Player>("player", "identity", |r| r.identity);
    players.seed(&crate::schema::Player {
        identity: me,
        entity_id: 7,
        name: String::new(),
        online: true,
        last_input_seq: 0,
    });
}

/// A mid-grace account row for somebody who is NOT the caller.
///
/// Seeded once and never removed, so the account table is never empty of
/// deleting rows. Without it a TABLE-keyed gate — refuse if ANYBODY is deleting
/// — is observationally identical to the caller-keyed one in all five states.
/// `remove` and `find` are `Identity`-keyed, so this row never disturbs the
/// per-state `remove(me) == 1` assertions.
fn rb80_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
) {
    let stranger = Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));
}

/// `heal_party` refuses a deletion-gated caller, ADMITS
/// everybody else, and answers from the CALLER's own row.
///
/// The shipped reducer runs through five account
/// states with the exact verdict pinned in each: no row, `Active`,
/// `PendingDeletion`, `PendingDeletion` + the terminal marker, and row removed.
/// The three admitted states are the positive control and they are what make
/// the two refused states mean anything. A mid-grace STRANGER row is present in
/// all five, so the admitted states additionally prove the gate keys on
/// `ctx.sender()`.
///
/// WHY THE ADMITTED STATES ERR, and why that is the honest claim. `Fixture::table`
/// keys rows by the indexed column, so the `u64`-keyed `character` index is
/// never registered; an unregistered index yields no rows in this host, so the
/// character lookup finds nothing and the reducer stops there — ONE guard past
/// the gate and well before the heal-location read, the spend, the consume and
/// the cooldown upsert. Every write syscall ABORTS the process (uncatchable, so
/// `#[should_panic]` is unavailable), which is exactly why this test can assert
/// REFUSALS and admissions and nothing deeper. The ordinary error is pinned
/// EXACTLY rather than as any-error: otherwise a regression in the joined check
/// (which returns a different error) would masquerade as a pass in all three
/// admitted states and the whole positive control would go quietly vacuous.
/// Ordering relative to the spend is owned by the source pin above.
///
/// kills: M1 (the dropped gate) · M5 (a discarded verdict) · M8 (an unreachable
/// placement) · M11 (a constant reject in `guards` — the three admitted states)
/// · M12 (inverted polarity, invisible to every source pin here — the `Active`
/// and no-row states would return the deletion reject, a total heal outage for
/// every honest player) · a row-EXISTS-keyed fake (`is_some()` instead of the
/// status test — the `Active` state) · a TABLE-WIDE or any-row-pending fake (the
/// three admitted states, while the stranger is mid-grace; written as a real
/// iteration it aborts the process on the unmodelled scan syscall instead — also
/// a failure, and a louder one) · a latched or memoised answer (the removed-row
/// state).
#[test]
fn rb80_heal_party_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    rb80_seed_player(&fx, me);

    let call = || crate::raising::heal_party(&ctx, 1);

    let ordinary: Result<(), String> = Err("character not found".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    rb80_seed_deleting_stranger(&acct);

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-80 E1 FAIL (admitted state, no account row): `heal_party` returned {got:?} for a \
         joined caller with NO account row, while a STRANGER's row is mid-grace. A caller who \
         never authenticated is not inside the deletion gate and must be admitted into the \
         ordinary guard chain; the expected error is the character lookup's, and pinning it \
         EXACTLY is what stops a regression in the joined check from masquerading as a pass. A \
         deletion reject here means the gate answers from the TABLE rather than from the \
         caller's own row. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, Active account): `heal_party` returned {got:?} for a \
         caller whose account row is `Active` (a stranger's row is mid-grace). This is the \
         ordinary player, and refusing them is a TOTAL HEAL OUTAGE that every source pin in this \
         slice would report as correctly gated — the call text is byte-identical whichever way \
         the decision runs. It is also exactly what a row-EXISTS-keyed fake produces, what an \
         any-row-pending TABLE scan produces, and what an inverted branch produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `Active` account row was seeded for the CALLER and must be \
         removed before the next state is pushed — `seed` appends rather than upserting, so a \
         miscount would leave two rows for one identity and the unique-index lookup would assert \
         instead of answering. `remove` is Identity-keyed, so the stranger's row is deliberately \
         untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, mid-grace): `heal_party` returned {got:?} for a caller \
         whose account is `PendingDeletion`; it must return the module's single static deletion \
         reject. THIS IS THE RED STATE AT HEAD — at HEAD `heal_party` carries no deletion gate, \
         so a mid-grace account still spends currency and burns items into and out of tables the \
         cascade is about to erase. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client ever \
         receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER and \
         must be removed before the terminal row is pushed (`seed` appends, it never upserts; \
         the stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, terminal): `heal_party` returned {got:?} for a caller \
         whose account carries the M22 terminal marker. An already-erased account has no wallet, \
         no inventory and no monsters left — the cascade deleted them — so a heal here would \
         recreate rows the deletion just removed. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even on \
         the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one terminal account row was seeded for the CALLER and must be \
         removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, row removed): `heal_party` returned {got:?} once the \
         caller's account row was gone again (the stranger's mid-grace row is still there). The \
         verdict must track LIVE rows FOR THE CALLER: an answer that latches on a row it has \
         already seen — a memoised predicate, a cached decision, a process-wide flag — would keep \
         refusing this identity forever, and an any-row-pending answer would refuse it because of \
         somebody else. No state above can distinguish either of those from a correct gate on \
         its own."
    );
}

// ===========================================================================
// Native-host behavioural suite.
//
// The SHIPPED reducers run through `Fixture::run_as(_at)` with a real sender and
// clock. HOST LIMIT: no transaction rollback, so every rejection is asserted as
// refusal BEFORE any write (the store byte-identical).
//
// heal_party's authorization is the sender-scoped player lookup + spend (every row it
// touches is keyed by `ctx.sender()`, so there is no separate ownership guard); these
// tests pin that.
//
// Not asserted, on purpose:
// * heal_party's currency-cost branch — live code, but unreachable with shipped
//   content (the only heal location costs 0 currency in the RON cache); residual.
// ===========================================================================
mod nh {
    use crate::marshal::pub_from_monster;
    use crate::movement::{movement_tick, MovementTickSchedule};
    use crate::native_host_tests::{fixture, Fixture, Handle, DEFAULT_DATABASE_IDENTITY};
    use crate::raising::{
        accrue_quality_time, care, consume_crystalized_essence, essence_train, evaluate_train,
        heal_party, train, CARE_COOLDOWN_MS, ESSENCE_SOFT_CAP, ESSENCE_TRAIN_COOLDOWN_MS,
        QT_IDLE_GAP_MS, QT_TICK_MS,
    };
    use crate::schema::{
        Battle, Character, HealCooldown, HealLocationRow, Inventory, ItemRow, Monster, MonsterPub,
        Player, SpeciesRow, TradeOffer,
    };
    use crate::PARTY_SLOT_NONE;
    use game_core::{
        ActionState, Affinity, BattleOutcome, Direction, StatKind, TradeItem, TradeStatus,
    };
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{Identity, ReducerContext, ScheduleAt, Timestamp};

    const T0: i64 = 1_750_000_000_000;
    /// Content item ids (game-core/content/items): 1 bait, 2 Attack food,
    /// 4 crystalized Water essence (+100).
    const BAIT: u32 = 1;
    const FOOD: u32 = 2;
    const NOT_FOOD: u32 = 3;
    const WATER_ESSENCE: u32 = 4;

    fn a() -> Identity {
        Identity::from_byte_array([0xA1; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0xB2; 32])
    }
    fn c() -> Identity {
        Identity::from_byte_array([0xC3; 32])
    }
    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn monster(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
        Monster {
            monster_id,
            owner_identity: owner,
            species_id: 1,
            nickname: format!("m{monster_id}"),
            level: 7,
            xp: 120,
            iv_hp: 10,
            iv_attack: 11,
            iv_defense: 12,
            iv_speed: 13,
            iv_sp_attack: 14,
            iv_sp_defense: 15,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 4,
            ev_attack: 5,
            ev_defense: 6,
            ev_speed: 7,
            ev_sp_attack: 8,
            ev_sp_defense: 9,
            stat_hp: 40,
            stat_attack: 20,
            stat_defense: 20,
            stat_speed: 20,
            stat_sp_attack: 20,
            stat_sp_defense: 20,
            current_hp: 5,
            party_slot,
            last_care_at_ms: 0,
            essence_fire: 10,
            essence_water: 3,
            essence_plant: 0,
            essence_electric: 1,
            essence_earth: 0,
            essence_wind: 0,
            essence_light: 2,
            essence_dark: 0,
            trust_favorable_count: 9,
            trust_unfavorable_count: 1,
            trust_favorable_battle_day_epoch: 3,
            quality_time_ticks_total: 44,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: 0,
            last_essence_train_at_ms: 0,
        }
    }

    fn item(id: u32, train_stat: Option<StatKind>) -> ItemRow {
        ItemRow {
            id,
            name: format!("i{id}"),
            description: String::new(),
            recruit_bonus: 0,
            train_stat,
            train_amount: 10,
            sell_price: 0,
            cure_status: None,
        }
    }

    fn species1() -> SpeciesRow {
        SpeciesRow {
            id: 1,
            name: "s1".to_string(),
            base_hp: 30,
            base_attack: 31,
            base_defense: 32,
            base_speed: 33,
            base_sp_attack: 34,
            base_sp_defense: 35,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 0,
        }
    }

    fn battle(player: Identity, opponent: Identity) -> Battle {
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: Affinity::Fire,
            level: 7,
            current_hp: 30,
            max_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        Battle {
            battle_id: 1,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![lead.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![lead],
                },
                outcome: BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        }
    }

    fn offer(initiator: Identity, counterparty: Identity) -> TradeOffer {
        TradeOffer {
            trade_id: 1,
            initiator,
            counterparty,
            initiator_monster_ids: vec![],
            initiator_items: vec![],
            initiator_currency: 0,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: TradeStatus::Pending,
            created_at_ms: T0,
        }
    }

    struct World<'a> {
        monsters: Handle<'a, Monster, u64>,
        pubs: Handle<'a, MonsterPub, u64>,
        stacks: Handle<'a, Inventory>,
        items: Handle<'a, ItemRow, u32>,
        battles: Handle<'a, Battle>,
        offers: Handle<'a, TradeOffer>,
        players: Handle<'a, Player>,
        chars: Handle<'a, Character, u64>,
        locs: Handle<'a, HealLocationRow, u32>,
        cooldowns: Handle<'a, HealCooldown>,
    }

    /// Every table the growth reducers + heal_party touch. `writable = false`
    /// walls the monster rows: a write reached there aborts the test process.
    fn world(fx: &Fixture, writable: bool) -> World<'_> {
        let monsters = fx.table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id);
        let pubs = fx.table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id);
        let (monsters, pubs) = if writable {
            (monsters.writable().unique(), pubs.writable().unique())
        } else {
            (monsters, pubs)
        };
        let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
        let _ = fx
            .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
            .writable()
            .unique();
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
        species.seed(&species1());
        World {
            monsters,
            pubs,
            stacks: fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity),
            items: fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id),
            battles: fx.table::<Battle>("battle", "player_identity", |r| r.player_identity),
            offers: fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator),
            players: fx.table::<Player>("player", "identity", |r| r.identity),
            chars: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable()
                .unique(),
            locs: fx.table_keyed::<HealLocationRow, u32>("heal_location_row", "location_id", |r| {
                r.location_id
            }),
            cooldowns: fx
                .table::<HealCooldown>("heal_cooldown", "owner_identity", |r| r.owner_identity)
                .writable()
                .unique(),
        }
    }

    impl World<'_> {
        fn seed_monster(&self, m: &Monster) {
            self.pubs.seed(&pub_from_monster(m, 1));
            self.monsters.seed(m);
        }
        fn monster(&self, id: u64) -> Monster {
            self.monsters
                .rows()
                .into_iter()
                .find(|m| m.monster_id == id)
                .expect("monster row")
        }
        fn assert_pub_consistent(&self, id: u64) {
            let p = self
                .pubs
                .rows()
                .into_iter()
                .find(|m| m.monster_id == id)
                .expect("monster_pub row");
            assert_eq!(
                to_vec(&p).unwrap(),
                to_vec(&pub_from_monster(&self.monster(id), p.tier)).unwrap(),
                "monster_pub must equal pub_from_monster(monster) for {id}"
            );
        }
        /// Seeded stack ids start at 1000 so a host auto-inc never collides.
        fn stack(&self, owner: Identity, item_id: u32, count: u32) {
            self.stacks.seed(&Inventory {
                inv_id: 1000 + u64::from(owner.to_byte_array()[0]) * 100 + u64::from(item_id),
                owner_identity: owner,
                item_id,
                count,
            });
        }
        fn count(&self, owner: Identity, item_id: u32) -> u32 {
            self.stacks
                .rows()
                .iter()
                .filter(|r| r.owner_identity == owner && r.item_id == item_id)
                .map(|r| r.count)
                .sum()
        }
        fn join(&self, who: Identity, entity_id: u64, zone_id: u32) {
            self.players.seed(&Player {
                identity: who,
                entity_id,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
            self.chars.seed(&Character {
                entity_id,
                zone_id,
                tile_x: 1,
                tile_y: 1,
                facing: Direction::South,
                action: ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        }
        fn snapshot(&self) -> Vec<Vec<u8>> {
            vec![
                to_vec(&self.monsters.rows()).unwrap(),
                to_vec(&self.pubs.rows()).unwrap(),
                to_vec(&self.stacks.rows()).unwrap(),
                to_vec(&self.cooldowns.rows()).unwrap(),
            ]
        }
    }

    type Call = fn(&ReducerContext) -> Result<(), String>;

    fn call_care(ctx: &ReducerContext) -> Result<(), String> {
        care(ctx, 11)
    }
    fn call_train(ctx: &ReducerContext) -> Result<(), String> {
        train(ctx, 11, FOOD)
    }
    fn call_essence(ctx: &ReducerContext) -> Result<(), String> {
        essence_train(ctx, 11, Affinity::Water)
    }
    fn call_consume(ctx: &ReducerContext) -> Result<(), String> {
        consume_crystalized_essence(ctx, 11, WATER_ESSENCE)
    }

    /// A world where every growth reducer would SUCCEED for A on monster 11.
    fn growth_world(fx: &Fixture) -> World<'_> {
        let w = world(fx, true);
        w.seed_monster(&monster(11, a(), 0));
        w.items.seed(&item(FOOD, Some(StatKind::Attack)));
        w.items.seed(&item(NOT_FOOD, None));
        w.stack(a(), FOOD, 3);
        w.stack(a(), WATER_ESSENCE, 2);
        w
    }

    /// Ownership, both-role battle and monster-escrow refusals for all four
    /// growth reducers — each refused with the store byte-identical — plus the
    /// same world's success control (so a guard that refused EVERYTHING fails).
    #[test]
    fn nh_growth_reducers_refuse_before_any_write() {
        let reducers: [(&str, Call, &str); 4] = [
            ("care", call_care, "cannot care during an ongoing battle"),
            ("train", call_train, "cannot train during an ongoing battle"),
            (
                "essence_train",
                call_essence,
                "cannot essence-train during an ongoing battle",
            ),
            (
                "consume_crystalized_essence",
                call_consume,
                "cannot consume essence during an ongoing battle",
            ),
        ];
        type Setup = fn(&World<'_>);
        for (name, call, battle_msg) in reducers {
            let cases: [(&str, Identity, Setup, &str); 5] = [
                ("non-owner", b(), |_| {}, "not owner"),
                (
                    "unknown monster",
                    a(),
                    |w| {
                        w.monsters.remove(11);
                        w.pubs.remove(11);
                    },
                    "monster not found",
                ),
                (
                    "in battle as player",
                    a(),
                    |w| w.battles.seed(&battle(a(), crate::WILD_IDENTITY)),
                    "",
                ),
                (
                    "in battle as PvP side B",
                    a(),
                    |w| w.battles.seed(&battle(b(), a())),
                    "",
                ),
                (
                    "monster escrowed",
                    a(),
                    |w| {
                        let mut o = offer(b(), a());
                        o.counterparty_monster_ids = vec![11];
                        w.offers.seed(&o);
                    },
                    "monster is in an active trade",
                ),
            ];
            for (label, caller, setup, want) in cases {
                let fx = fixture();
                let w = growth_world(&fx);
                setup(&w);
                let want = if want.is_empty() { battle_msg } else { want };
                let before = w.snapshot();
                let got = fx.run_as_at(caller, at(T0), call);
                assert_eq!(got, Err(want.to_string()), "{name} / {label}");
                assert_eq!(w.snapshot(), before, "{name} / {label}: nothing written");
            }
            let fx = fixture();
            let w = growth_world(&fx);
            w.battles.seed(&{
                let mut done = battle(b(), a());
                done.state.outcome = BattleOutcome::SideAWins;
                done
            });
            assert_eq!(
                fx.run_as_at(a(), at(T0), call),
                Ok(()),
                "{name}: control (completed battle only) must succeed"
            );
            w.assert_pub_consistent(11);
        }
    }

    /// care: the server-clock cooldown refuses one ms early (nothing written)
    /// and admits exactly at CARE_COOLDOWN_MS; success stamps the clock, adds one
    /// saturating Trust credit and dual-writes.
    #[test]
    fn nh_care_cooldown_boundary_and_success() {
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.last_care_at_ms = T0;
        w.seed_monster(&m);
        let before = w.snapshot();
        assert_eq!(
            fx.run_as_at(a(), at(T0 + CARE_COOLDOWN_MS - 1), |ctx| care(ctx, 11)),
            Err("care cooldown not yet elapsed".to_string())
        );
        assert_eq!(w.snapshot(), before);

        let now = T0 + CARE_COOLDOWN_MS;
        assert_eq!(fx.run_as_at(a(), at(now), |ctx| care(ctx, 11)), Ok(()));
        let after = w.monster(11);
        assert_eq!(
            (after.last_care_at_ms, after.trust_favorable_count),
            (now, 10)
        );
        assert_eq!(after.current_hp, 5, "care is not a heal");
        w.assert_pub_consistent(11);

        drop(fx);
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.trust_favorable_count = u32::MAX;
        w.seed_monster(&m);
        assert_eq!(fx.run_as_at(a(), at(T0), |ctx| care(ctx, 11)), Ok(()));
        assert_eq!(w.monster(11).trust_favorable_count, u32::MAX, "saturating");
    }

    /// train: exactly one food leaves the CALLER's stack (a stranger's identical
    /// stack is untouched), EVs + stats take the focus_train result, current_hp
    /// is unchanged, and monster_pub follows.
    #[test]
    fn nh_train_spends_exactly_one_own_food() {
        let fx = fixture();
        let w = growth_world(&fx);
        w.stack(b(), FOOD, 5);
        let m = w.monster(11);
        let s = species1();
        let expected = evaluate_train(
            &game_core::StatBlock {
                hp: s.base_hp,
                attack: s.base_attack,
                defense: s.base_defense,
                speed: s.base_speed,
                sp_attack: s.base_sp_attack,
                sp_defense: s.base_sp_defense,
            },
            &game_core::IVs::new(10, 11, 12, 13, 14, 15).unwrap(),
            &game_core::EVs::new(4, 5, 6, 7, 8, 9).unwrap(),
            &game_core::Nature::new(m.nature_kind),
            game_core::Level::new(7).unwrap(),
            Some(StatKind::Attack),
            10,
        )
        .unwrap();

        assert_eq!(
            fx.run_as_at(a(), at(T0), |ctx| train(ctx, 11, FOOD)),
            Ok(())
        );
        assert_eq!((w.count(a(), FOOD), w.count(b(), FOOD)), (2, 5));
        let after = w.monster(11);
        assert_eq!(after.ev_attack, expected.evs.get(StatKind::Attack));
        assert!(after.ev_attack > 5, "the food granted EVs");
        assert_eq!(after.stat_attack, expected.derived_stats.attack);
        assert_eq!(after.stat_hp, expected.derived_stats.hp);
        assert_eq!(after.current_hp, 5, "training is not a heal");
        w.assert_pub_consistent(11);
    }

    /// train refusals keep the food: a non-food item, a food stack fully
    /// reserved by an active offer, and a caller who owns none (only a stranger
    /// does) — each refused before any write.
    #[test]
    fn nh_train_refusals_never_burn_food() {
        type Setup = fn(&World<'_>);
        let cases: [(&str, u32, Setup, &str); 3] = [
            (
                "not a food",
                NOT_FOOD,
                |w| w.stack(a(), NOT_FOOD, 2),
                "item is not a training food",
            ),
            (
                "food escrowed",
                FOOD,
                |w| {
                    let mut o = offer(a(), b());
                    o.initiator_items = vec![TradeItem {
                        item_id: FOOD,
                        qty: 3,
                    }];
                    w.offers.seed(&o);
                },
                "item is in an active trade",
            ),
            (
                "only a stranger owns the food",
                FOOD,
                |w| {
                    w.stacks.remove(a());
                    w.stack(b(), FOOD, 5);
                },
                "item is in an active trade",
            ),
        ];
        for (label, food, setup, want) in cases {
            let fx = fixture();
            let w = growth_world(&fx);
            setup(&w);
            let before = w.snapshot();
            let got = fx.run_as_at(a(), at(T0), |ctx| train(ctx, 11, food));
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert_eq!(
                w.snapshot(),
                before,
                "{label}: nothing written, nothing burned"
            );
        }
    }

    /// essence_train: one ms early refuses; exactly at the 5 h cooldown +5 lands
    /// on the chosen pool ONLY; a pool near the soft cap clamps, never rejects.
    #[test]
    fn nh_essence_train_cooldown_pool_and_clamp() {
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.last_essence_train_at_ms = T0;
        w.seed_monster(&m);
        let before = w.snapshot();
        let early = T0 + ESSENCE_TRAIN_COOLDOWN_MS - 1;
        assert_eq!(
            fx.run_as_at(a(), at(early), |ctx| essence_train(
                ctx,
                11,
                Affinity::Water
            )),
            Err("essence training cooldown not yet elapsed".to_string())
        );
        assert_eq!(w.snapshot(), before);
        let now = T0 + ESSENCE_TRAIN_COOLDOWN_MS;
        assert_eq!(
            fx.run_as_at(a(), at(now), |ctx| essence_train(ctx, 11, Affinity::Water)),
            Ok(())
        );
        let after = w.monster(11);
        assert_eq!(
            after.essence_water,
            3 + crate::raising::ESSENCE_TRAIN_AMOUNT
        );
        assert_eq!(
            (
                after.essence_fire,
                after.essence_electric,
                after.essence_light
            ),
            (10, 1, 2),
            "only the chosen pool moves"
        );
        assert_eq!(after.last_essence_train_at_ms, now);
        w.assert_pub_consistent(11);

        drop(fx);
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.essence_water = ESSENCE_SOFT_CAP - 2;
        w.seed_monster(&m);
        assert_eq!(
            fx.run_as_at(a(), at(T0), |ctx| essence_train(ctx, 11, Affinity::Water)),
            Ok(())
        );
        assert_eq!(w.monster(11).essence_water, ESSENCE_SOFT_CAP);
    }

    /// consume_crystalized_essence: success burns exactly one item and grants the
    /// ITEM's affinity/amount; it shares essence_train's clock (a train one ms
    /// before the cooldown is refused); a non-essence item is refused unburnt.
    #[test]
    fn nh_consume_crystalized_essence_grants_item_and_shares_the_clock() {
        let fx = fixture();
        let w = growth_world(&fx);
        assert_eq!(
            fx.run_as_at(a(), at(T0), |ctx| consume_crystalized_essence(
                ctx,
                11,
                WATER_ESSENCE
            )),
            Ok(())
        );
        assert_eq!(w.count(a(), WATER_ESSENCE), 1);
        let after = w.monster(11);
        assert_eq!(
            (after.essence_water, after.last_essence_train_at_ms),
            (103, T0)
        );
        w.assert_pub_consistent(11);
        let before = w.snapshot();
        let early = T0 + ESSENCE_TRAIN_COOLDOWN_MS - 1;
        assert_eq!(
            fx.run_as_at(a(), at(early), |ctx| essence_train(ctx, 11, Affinity::Fire)),
            Err("essence training cooldown not yet elapsed".to_string()),
            "one shared clock"
        );
        assert_eq!(w.snapshot(), before);

        drop(fx);
        let fx = fixture();
        let w = growth_world(&fx);
        w.stack(a(), BAIT, 2);
        let before = w.snapshot();
        assert_eq!(
            fx.run_as_at(a(), at(T0), |ctx| consume_crystalized_essence(
                ctx, 11, BAIT
            )),
            Err("item is not crystalized essence".to_string())
        );
        assert_eq!(w.snapshot(), before, "a wrong item is never burnt");
    }

    /// Heal location 1 (zone 0) re-seeded with an ITEM cost so the spend is
    /// observable; the RON cache still prices it at 0 currency.
    fn heal_world(fx: &Fixture) -> World<'_> {
        let w = world(fx, true);
        w.locs.seed(&HealLocationRow {
            location_id: 1,
            zone_id: 0,
            tile_x: 8,
            tile_y: 3,
            cost_item_id: Some(NOT_FOOD),
            cost_qty: 1,
            cooldown_ms: 30_000,
            cost_currency: 0,
        });
        w.join(a(), 1, 0);
        w.join(b(), 2, 0);
        w.seed_monster(&monster(11, a(), 0));
        w.seed_monster(&monster(12, a(), PARTY_SLOT_NONE));
        w.seed_monster(&monster(21, b(), 0));
        w.stack(a(), NOT_FOOD, 2);
        w.stack(b(), NOT_FOOD, 2);
        w
    }

    /// Success heals ONLY the caller's party (boxed and stranger monsters keep
    /// their HP), spends the cost from the caller's own stack, dual-writes, and
    /// upserts the caller's cooldown row.
    #[test]
    fn nh_heal_party_heals_only_the_callers_party() {
        let fx = fixture();
        let w = heal_world(&fx);
        assert_eq!(fx.run_as_at(a(), at(T0), |ctx| heal_party(ctx, 1)), Ok(()));
        assert_eq!(
            w.monster(11).current_hp,
            40,
            "party monster healed to stat_hp"
        );
        assert_eq!(w.monster(12).current_hp, 5, "boxed monster untouched");
        assert_eq!(w.monster(21).current_hp, 5, "stranger's party untouched");
        w.assert_pub_consistent(11);
        assert_eq!((w.count(a(), NOT_FOOD), w.count(b(), NOT_FOOD)), (1, 2));
        let cd: Vec<(Identity, i64)> = w
            .cooldowns
            .rows()
            .iter()
            .map(|r| (r.owner_identity, r.last_heal_at_ms))
            .collect();
        assert_eq!(cd, vec![(a(), T0)]);

        assert_eq!(
            fx.run_as_at(a(), at(T0 + 30_000), |ctx| heal_party(ctx, 1)),
            Ok(()),
            "exactly at cooldown_ms the heal is admitted"
        );
        assert_eq!(w.cooldowns.rows().len(), 1, "upsert, not a second row");
        assert_eq!(w.cooldowns.rows()[0].last_heal_at_ms, T0 + 30_000);
    }

    /// heal_party refusals, each before any write: unjoined caller, wrong zone,
    /// in battle (PvP side B), one ms inside the location cooldown, and a caller
    /// without the cost item (a stranger's stack is never spent).
    #[test]
    fn nh_heal_party_refusals_write_nothing() {
        type Setup = fn(&World<'_>);
        let cases: [(&str, Identity, i64, Setup, &str); 5] = [
            ("unjoined", c(), T0, |_| {}, "not joined"),
            (
                "wrong zone",
                a(),
                T0,
                |w| {
                    w.chars.remove(1);
                    w.join_char_only(1, 5);
                },
                "not in heal location zone",
            ),
            (
                "in battle as PvP side B",
                a(),
                T0,
                |w| w.battles.seed(&battle(b(), a())),
                "cannot heal during an ongoing battle",
            ),
            (
                "inside cooldown",
                a(),
                T0 + 29_999,
                |w| {
                    w.cooldowns.seed(&HealCooldown {
                        owner_identity: a(),
                        last_heal_at_ms: T0,
                    })
                },
                "heal cooldown not yet elapsed",
            ),
            (
                "no cost item",
                a(),
                T0,
                |w| {
                    w.stacks.remove(a());
                },
                "item not in inventory",
            ),
        ];
        for (label, caller, now, setup, want) in cases {
            let fx = fixture();
            let w = heal_world(&fx);
            setup(&w);
            let before = w.snapshot();
            let got = fx.run_as_at(caller, at(now), |ctx| heal_party(ctx, 1));
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert_eq!(w.snapshot(), before, "{label}: nothing written");
        }
    }

    impl World<'_> {
        fn join_char_only(&self, entity_id: u64, zone_id: u32) {
            self.chars.seed(&Character {
                entity_id,
                zone_id,
                tile_x: 1,
                tile_y: 1,
                facing: Direction::South,
                action: ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        }
    }

    /// EV-no-idle-accrual (M9: growth comes from ACTIVE play only), on the
    /// shipped ctx shell: an intent 60 s after the last one mints a Quality-Time
    /// tick; an intent after an idle gap longer than QT_IDLE_GAP_MS credits
    /// NOTHING (re-anchor only) and leaves monster_pub alone.
    #[test]
    fn nh_quality_time_accrues_only_under_active_play() {
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.quality_time_window_start_ms = T0;
        w.seed_monster(&m);

        let t1 = T0 + QT_TICK_MS;
        assert!(
            accrue_quality_time(&fx.ctx_at(at(t1)), 11),
            "active gap ticks"
        );
        assert_eq!(w.monster(11).quality_time_ticks_total, 45);
        w.assert_pub_consistent(11);

        let pubs_before = to_vec(&w.pubs.rows()).unwrap();
        let t2 = t1 + QT_IDLE_GAP_MS + 1;
        assert!(
            !accrue_quality_time(&fx.ctx_at(at(t2)), 11),
            "idle gap never ticks"
        );
        let after = w.monster(11);
        assert_eq!(after.quality_time_ticks_total, 45, "no idle credit");
        assert_eq!(
            after.quality_time_window_ms, 60_000,
            "window unchanged by idle time"
        );
        assert_eq!(after.quality_time_window_start_ms, t2, "re-anchored");
        assert_eq!(to_vec(&w.pubs.rows()).unwrap(), pubs_before);
    }

    /// EV-no-idle-accrual time-skip: with the monster rows WRITE-WALLED (any
    /// growth write aborts the process), the scheduled movement_tick runs as the
    /// module identity every hour for 48 simulated hours over a party whose
    /// owner sends no intent — it does its own work (normalises the character
    /// to Idle) and every monster / monster_pub row stays byte-identical. A
    /// non-scheduler caller is refused. Queue-draining moves reach the grass /
    /// encounter path, which the movement suite owns.
    #[test]
    fn nh_movement_tick_time_skip_never_grows_monsters() {
        let fx = fixture();
        let w = world(&fx, false);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        w.join(a(), 1, 0);
        w.chars.remove(1);
        w.chars.seed(&Character {
            entity_id: 1,
            zone_id: 0,
            tile_x: 1,
            tile_y: 1,
            facing: Direction::South,
            action: ActionState::Walking,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
        });
        let mut m = monster(11, a(), 0);
        m.quality_time_window_start_ms = T0;
        w.seed_monster(&m);
        w.seed_monster(&monster(12, a(), 1));
        let growth_before = (
            to_vec(&w.monsters.rows()).unwrap(),
            to_vec(&w.pubs.rows()).unwrap(),
        );
        let sched = || MovementTickSchedule {
            id: 1,
            zone_id: 0,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        assert_eq!(
            fx.run_as_at(a(), at(T0), |ctx| movement_tick(ctx, sched())),
            Err("movement_tick is scheduler-only".to_string())
        );
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        for hour in 1..=48 {
            let now = T0 + hour * 3_600_000;
            assert_eq!(
                fx.run_as_at(module, at(now), |ctx| movement_tick(ctx, sched())),
                Ok(()),
                "hour {hour}"
            );
        }
        assert_eq!(
            w.chars.rows()[0].action,
            ActionState::Idle,
            "the tick ran its body (normalised the idle character)"
        );
        assert_eq!(
            (
                to_vec(&w.monsters.rows()).unwrap(),
                to_vec(&w.pubs.rows()).unwrap()
            ),
            growth_before,
            "48 h of scheduler ticks with no intent must not move any growth field"
        );
    }

    /// A Quality-Time credit that CROSSES a public tier band (49 -> 50 ticks)
    /// re-projects monster_pub; the unchanged-tier skip must never swallow a
    /// real tier change (the public row would advertise a stale tier).
    #[test]
    fn nh_quality_time_tier_crossing_reprojects_monster_pub() {
        let fx = fixture();
        let w = world(&fx, true);
        let mut m = monster(11, a(), 0);
        m.quality_time_ticks_total = 49;
        m.quality_time_window_start_ms = T0;
        w.seed_monster(&m);
        let tier_before = game_core::quality_time_tier_of(49);
        assert!(accrue_quality_time(&fx.ctx_at(at(T0 + QT_TICK_MS)), 11));
        assert_eq!(w.monster(11).quality_time_ticks_total, 50);
        let p = w
            .pubs
            .rows()
            .into_iter()
            .find(|p| p.monster_id == 11)
            .unwrap();
        assert_ne!(
            p.quality_time_tier, tier_before,
            "fixture must cross a band"
        );
        assert_eq!(p.quality_time_tier, game_core::quality_time_tier_of(50));
        w.assert_pub_consistent(11);
    }

    /// Claim re-key moves the caller's heal cooldown anchor verbatim (so a
    /// claim cannot reset the heal cooldown); erase removes it, owner-scoped.
    #[test]
    fn nh_heal_cooldown_rekey_and_erase() {
        let fx = fixture();
        let w = world(&fx, true);
        w.cooldowns.seed(&HealCooldown {
            owner_identity: a(),
            last_heal_at_ms: T0,
        });
        w.cooldowns.seed(&HealCooldown {
            owner_identity: b(),
            last_heal_at_ms: T0 + 1,
        });
        let rows = |w: &World<'_>| {
            let mut r: Vec<(Identity, i64)> = w
                .cooldowns
                .rows()
                .iter()
                .map(|r| (r.owner_identity, r.last_heal_at_ms))
                .collect();
            r.sort_by_key(|x| x.1);
            r
        };
        let ctx = fx.ctx();
        crate::raising::rekey_heal_cooldown(&ctx, a(), c());
        assert_eq!(rows(&w), vec![(c(), T0), (b(), T0 + 1)]);
        crate::raising::erase_heal_cooldown(&ctx, c());
        assert_eq!(rows(&w), vec![(b(), T0 + 1)]);
    }
}
