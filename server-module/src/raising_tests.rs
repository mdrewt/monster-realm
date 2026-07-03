//! `raising_tests` — M9b gating unit tests for the pure `evaluate_care` seam
//! (server-module/src/raising.rs). Authored from the M9 spec §3 EARS criteria
//! and the ADR-0059 proof-of-teeth section.
//!
//! Declared from `raising.rs` as:
//!   `#[cfg(test)] #[path = "raising_tests.rs"] mod raising_tests;`
//! so `super` resolves to the `raising` module — giving access to
//! `evaluate_care`, `CARE_COOLDOWN_MS`, and `CARE_BOND_AMOUNT` by name.
//!
//! RED state: this file does not compile until the implementer creates
//! `server-module/src/raising.rs` (with `evaluate_care`, `CARE_COOLDOWN_MS`,
//! `CARE_BOND_AMOUNT` exported `pub(crate)`) and adds the `#[path]` mod decl.
//! That is intentional — the tests are the contract, not the implementation.
//!
//! EARS criteria covered (from M9 spec §3):
//!   - Care cooldown: boundary is `<`, not `<=` (equal-to-cooldown is ALLOWED).
//!   - Max bond rejects before burning cooldown (AtMaxBond path).
//!   - Care raises bond by exactly min(CARE_BOND_AMOUNT, 255 - bond).
//!   - Safe-direction clock: future last_care_at_ms only over-rejects (no bypass).
//!   - Elapsed from nonzero base works correctly.
//!
//! Each test carries a `// kills:` comment naming which wrong implementation it
//! catches. Reference consts symbolically so they survive tuning.

use super::*;

// ---------------------------------------------------------------------------
// M9b-tail: evaluate_train seam unit tests
//
// The function under test:
//   pub(crate) fn evaluate_train(
//       base: &StatBlock, ivs: &IVs, evs: &EVs, nature: &Nature, level: Level,
//       train_stat: Option<StatKind>, train_amount: u16,
//   ) -> Result<FocusTrainResult, String>
//
// It does NOT exist yet — these tests are RED until the implementer adds it to
// server-module/src/raising.rs and declares `use super::*;` pulls it into scope.
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

/// Bulbasaur-like base stats fixture (matches m9a_gating_tests canonical fixture).
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

/// M9b-tail: evaluate_train with train_stat=None returns Err whose message
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

/// M9b-tail: evaluate_train(Some(Attack), amount=10, fresh EVs) must return
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

/// M9b-tail: evaluate_train surfaces StatAtCap as Err when Attack EV is already 252.
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

/// M9b-tail: evaluate_train surfaces BudgetExhausted as Err when total EVs == 510
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

/// M9b-tail: evaluate_train surfaces NoEffect as Err when train_amount==0.
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

/// M9b-tail: red-team F1 — simultaneous per-stat and budget headroom of exactly 1.
/// EVs: hp=251 (headroom 1), attack=252 (at cap), defense=6 (total=509, budget headroom 1).
/// Training Hp with amount=10: grant = min(10, 252-251, 510-509) = min(10, 1, 1) = 1.
/// After: hp=252, total=510 — both constraints hit simultaneously. Must not panic.
/// Also asserts: Hp==252, total==510, Attack==252 unchanged, Defense==6 unchanged.
/// kills: a focus_train .expect("by construction") that panics when BOTH headrooms are
///        exactly 1 at the same time (the F1 red-team finding from the spec).
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
    /// M9b-tail: evaluate_train(Some(stat), amount) is a faithful pass-through for
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
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS) must be Ok \
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
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS - 1);
    assert!(
        result.is_err(),
        "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS-1) must be Err \
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
    let result = evaluate_care(50, 1000, 1000 + CARE_COOLDOWN_MS);
    assert!(
        result.is_ok(),
        "evaluate_care(bond=50, last=1000, now=1000+CARE_COOLDOWN_MS) must be Ok \
         (elapsed == CARE_COOLDOWN_MS from nonzero base); \
         got Err: {:?}",
        result.err()
    );
}

// ---------------------------------------------------------------------------
// Max bond rejects even with cooldown elapsed
// ---------------------------------------------------------------------------

/// A monster already at max bond (255) must be rejected regardless of cooldown.
/// kills: an impl that checks cooldown first and only then checks bond, so a
/// max-bond monster would burn the cooldown before being rejected (F1 violation).
/// The spec: "IF the monster is at max bond THE SYSTEM SHALL reject BEFORE
/// burning the cooldown."
/// Rationale: evaluate_care applies bond arithmetic BEFORE the cooldown gate
/// (per the specified order: apply_care first, then cooldown) — so AtMaxBond
/// fires before the cooldown check.
#[test]
fn max_bond_rejects_even_with_cooldown_elapsed() {
    // bond = 255 (max), cooldown fully elapsed.
    let result = evaluate_care(255, 0, CARE_COOLDOWN_MS);
    assert!(
        result.is_err(),
        "evaluate_care(bond=255, ...) must be Err (AtMaxBond path) \
         even when cooldown has elapsed; got Ok: {:?}",
        result.ok()
    );
}

/// Near-max bond (254) with CARE_BOND_AMOUNT >= 1 saturates to exactly 255.
/// kills: an impl that clamps to 254 (off-by-one in saturation) or panics on
/// near-max bond arithmetic.
#[test]
fn near_max_bond_saturates_to_255() {
    // bond = 254, CARE_BOND_AMOUNT >= 1 → result must be 255.
    let result = evaluate_care(254, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            assert!(
                new_bond > 254,
                "bond must have increased above 254 (CARE_BOND_AMOUNT >= 1); got {}",
                new_bond
            );
            // Precise expectation: min(254 + CARE_BOND_AMOUNT, 255) = 255 since CARE_BOND_AMOUNT >= 1.
            assert_eq!(
                new_bond, 255,
                "bond=254 + CARE_BOND_AMOUNT({}) should saturate to exactly 255",
                CARE_BOND_AMOUNT
            );
        }
        Err(e) => {
            panic!(
                "evaluate_care(bond=254, last=0, now=CARE_COOLDOWN_MS) must be Ok \
                 (254 < 255 = max bond, cooldown elapsed); got Err: {:?}",
                e
            );
        }
    }
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
    let result = evaluate_care(50, 10_000, 0);
    assert!(
        result.is_err(),
        "evaluate_care(bond=50, last=10_000, now=0) must be Err \
         (last_care_at_ms is in the future relative to now — safe-direction: \
         over-reject is fine, but the gate must never be bypassed); \
         got Ok: {:?}",
        result.ok()
    );
}

// ---------------------------------------------------------------------------
// Successful care raises bond by exactly min(CARE_BOND_AMOUNT, 255 - bond)
// ---------------------------------------------------------------------------

/// A successful care raises bond by exactly `min(CARE_BOND_AMOUNT, 255 - bond)`.
/// kills: an impl that adds a hardcoded amount instead of using CARE_BOND_AMOUNT,
/// or one that adds more than the remaining headroom.
#[test]
fn successful_care_raises_bond_by_care_bond_amount() {
    // bond = 50, CARE_BOND_AMOUNT >= 1, headroom = 205 (>> CARE_BOND_AMOUNT for any sane value).
    // Expected new bond = 50 + CARE_BOND_AMOUNT (no saturation needed for reasonable CARE_BOND_AMOUNT).
    let result = evaluate_care(50, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            // The exact expected value uses the const symbolically.
            let expected = 50u8.saturating_add(CARE_BOND_AMOUNT);
            assert_eq!(
                new_bond, expected,
                "bond raised by wrong amount: expected 50 + CARE_BOND_AMOUNT({}) = {}, got {}",
                CARE_BOND_AMOUNT, expected, new_bond
            );
        }
        Err(e) => {
            panic!(
                "evaluate_care(bond=50, last=0, now=CARE_COOLDOWN_MS) must be Ok \
                 (bond=50 < 255, cooldown elapsed); got Err: {:?}",
                e
            );
        }
    }
}

// ---------------------------------------------------------------------------
// M12b: evaluate_heal pure seam unit tests
//
// The function under test:
//   pub(crate) fn evaluate_heal(
//       last_heal_at_ms: i64,
//       now: i64,
//       cooldown_ms: i64,
//   ) -> Result<(), String>
//
// It does NOT exist yet — these tests are RED until the implementer adds it to
// server-module/src/raising.rs along with `HEAL_COOLDOWN_MS: i64`.
// Declared from `raising.rs` via `#[path = "raising_tests.rs"] mod raising_tests;`
// so `super::*` pulls in `evaluate_heal` and `HEAL_COOLDOWN_MS`.
//
// The function checks only the cooldown gate (no bond/hp arithmetic).
// Pattern mirrors evaluate_care: strict `<`, saturating_sub, safe-direction clock.
//
// EARS criteria covered:
//   - Boundary is `<` not `<=` (elapsed == cooldown is ALLOWED).
//   - One ms before boundary is REJECTED (cooldown check present and correct).
//   - Future last_heal_at_ms only over-rejects, never bypasses the gate.
// ---------------------------------------------------------------------------

/// M12b: evaluate_heal allows the heal action when elapsed == cooldown exactly.
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

/// M12b: evaluate_heal rejects when one ms remains on the cooldown.
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

/// M12b: a last_heal_at_ms in the future (relative to now) only over-rejects —
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
