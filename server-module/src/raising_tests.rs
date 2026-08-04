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

// =========================================================================
// EG1 (ADR-0174 D2): the two M12.5b-4 structural tests
// (`care_reducer_assigns_evolves_to` and `care_reducer_calls_compute_evolves_to`)
// were DELETED here — their subject, the care-path `evolves_to` recompute via
// `compute_evolves_to`, is removed outright: the helper's parameter type
// (`EvolutionCondition`) no longer exists in game-core, so the pinned
// implementation is compile-impossible and `evolves_to` is a frozen dead
// column until Migration B. The bond write in `care` itself is unchanged and
// stays covered by the behavioral tests above. Removal is the mechanical
// consequence of the deleted subject, not a weakened assertion. The shared
// RAISING_SOURCE / strip_raising_comments helpers below survive — the other
// structural scans in this file still use them.
// =========================================================================

/// Include raising.rs source for structural inspection.
const RAISING_SOURCE: &str = include_str!("raising.rs");

/// Minimal strip_rust_comments (not available from super here — reproduce locally).
fn strip_raising_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("stripped source must be valid UTF-8")
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
// ptc5a (ADR-0136): care and train must be blocked mid-battle
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
// Tests 1+2 are SOURCE-SCAN RED until the implementer adds:
//   if is_in_ongoing_battle(ctx, ctx.sender) {
//       return Err("cannot care/train during an ongoing battle".to_string());
//   }
// immediately after `require_owner(ctx, …)?` in each reducer.
//
// Test 3 is GREEN (pins the semantics of the pre-existing helper).
// Test 4 is GREEN (pins the pure math magnitude of the laundering vector).
// ===========================================================================

/// Brace-walk helper: given `stripped` source and a `fn_needle` that locates
/// a reducer, return the slice of `stripped` that is the reducer body
/// (content between the outermost `{` and its matching `}`).
///
/// This is the DRY core shared by `care_battle_guard_wired` and
/// `train_battle_guard_wired`. Mirrors the walk in `care_reducer_calls_compute_evolves_to`
/// (line ~749) exactly — same strip-then-find-then-walk pattern.
fn reducer_body<'a>(stripped: &'a str, fn_needle: &str) -> &'a str {
    let fn_pos = stripped
        .find(fn_needle)
        .unwrap_or_else(|| panic!("reducer '{}' not found in raising.rs source", fn_needle));
    let after = &stripped[fn_pos..];
    let brace = after.find('{').expect("reducer must have an opening brace");
    let body_start = fn_pos + brace + 1;

    let mut depth: usize = 1;
    let chars: Vec<char> = stripped[body_start..].chars().collect();
    let mut char_i = 0;
    let mut byte_off = 0;
    while char_i < chars.len() && depth > 0 {
        match chars[char_i] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        byte_off += chars[char_i].len_utf8();
        char_i += 1;
    }
    &stripped[body_start..body_start + byte_off]
}

/// ptc5a Test 1 — care reducer source-scan: the `care` body must contain
/// `if is_in_ongoing_battle(ctx, ctx.sender)` in its conditional form.
///
/// TEETH(ptc5a-1): the care reducer body must contain
/// `if is_in_ongoing_battle(ctx, ctx.sender)` after `require_owner`.
///
/// Kills:
///   - deleting the guard entirely (needle absent → RED).
///   - a dead-code evasion `let _ = is_in_ongoing_battle(ctx, ctx.sender);`
///     (no `if` prefix → whitespace-collapsed needle `ifis_in_ongoing_battle(ctx,ctx.sender)`
///     is absent → RED).
///
/// MUST START RED until the implementer adds the guard.
#[test]
fn care_battle_guard_wired() {
    let stripped = strip_raising_comments(RAISING_SOURCE);
    let fn_needle = ["pub fn care", "(ctx:"].concat();
    let body = reducer_body(&stripped, &fn_needle);

    // Whitespace-collapse the body so rustfmt line splits never cause false RED.
    let collapsed: String = body.split_whitespace().collect();

    // Needle assembled from parts to prevent self-match in the included source text.
    // The trailing `{` (the opening brace of the if-block) is load-bearing: it
    // rejects a string-literal fake like `log::info!("if is_in_ongoing_battle(ctx,
    // ctx.sender)")` (which collapses to `..."ifis_in_ongoing_battle(ctx,ctx.sender)"`
    // — no `){`) while matching any real guard body shape. The eval
    // (battle-reducer-security C1) additionally strips string literals and is the
    // authoritative gate; this Rust layer is the fast first check (red-team ptc5a F2).
    let needle = ["ifis_in_ongoing", "_battle(ctx,ctx.sender){"].concat();

    assert!(
        collapsed.contains(needle.as_str()),
        "TEETH(ptc5a-1): the `care` reducer body must contain \
         `if is_in_ongoing_battle(ctx, ctx.sender) {{` (whitespace-collapsed: \
         `ifis_in_ongoing_battle(ctx,ctx.sender){{`) immediately after `require_owner`. \
         This guard blocks mid-battle bond-raising that would feed the HP-laundering \
         vector (ADR-0136). \
         Kills: deleting the guard (needle absent) AND a dead-code `let _ = ...` \
         evasion (no `if` prefix → needle absent). \
         RED until implementer adds: \
         `if is_in_ongoing_battle(ctx, ctx.sender) {{ \
             return Err(\"cannot care during an ongoing battle\".to_string()); \
         }}`"
    );
}

/// ptc5a Test 2 — train reducer source-scan: the `train` body must contain
/// `if is_in_ongoing_battle(ctx, ctx.sender)` in its conditional form.
///
/// TEETH(ptc5a-1): same needle as Test 1 but scoped to the `train` reducer body.
///
/// Kills:
///   - deleting the guard from `train` (needle absent → RED).
///   - a dead-code `let _ = is_in_ongoing_battle(ctx, ctx.sender);` evasion
///     (no `if` prefix → whitespace-collapsed needle absent → RED).
///
/// MUST START RED until the implementer adds the guard.
#[test]
fn train_battle_guard_wired() {
    let stripped = strip_raising_comments(RAISING_SOURCE);
    let fn_needle = ["pub fn train", "(ctx:"].concat();
    let body = reducer_body(&stripped, &fn_needle);

    // Whitespace-collapse so rustfmt line splits never produce false RED.
    let collapsed: String = body.split_whitespace().collect();

    // Same needle as care: both reducers use ctx.sender as the identity token.
    // The trailing `{` rejects a string-literal fake (see care_battle_guard_wired);
    // the eval (battle-reducer-security C1) is the authoritative string-stripped gate.
    let needle = ["ifis_in_ongoing", "_battle(ctx,ctx.sender){"].concat();

    assert!(
        collapsed.contains(needle.as_str()),
        "TEETH(ptc5a-1): the `train` reducer body must contain \
         `if is_in_ongoing_battle(ctx, ctx.sender)` (whitespace-collapsed: \
         `ifis_in_ongoing_battle(ctx,ctx.sender)`) immediately after `require_owner`. \
         This guard blocks mid-battle EV training that enables HP laundering via the \
         level-up heal formula (ADR-0136). \
         Kills: deleting the guard (needle absent) AND a dead-code `let _ = ...` \
         evasion (no `if` prefix → needle absent). \
         RED until implementer adds: \
         `if is_in_ongoing_battle(ctx, ctx.sender) {{ \
             return Err(\"cannot train during an ongoing battle\".to_string()); \
         }}`"
    );
}

/// Minimal Battle row builder for ptc5a tests 3+4.
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

/// ptc5a Test 3 — both-role predicate scenarios: pins the semantics that the
/// guard relies on (GREEN against current code; the helper already exists).
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

/// ptc5a Test 4 — differential level-up-heal: documents the magnitude of the
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
///
/// This is a documentation+regression test for the ptc5a vulnerability closure
/// (ptc5a-2 differential, ADR-0136 §2).
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

// ===========================================================================
// 11r-g (ADR-0170 D3) — `heal_party` reads the CACHED heal-location registry
//
// EARS criteria covered by this section:
//
//   H-2  `heal_party` SHALL read the heal-location registry through
//        `content_cache::cached_heal_locations` (the eighth LazyLock) instead of
//        re-parsing the embedded RON on every call, with the currency-cost
//        semantics UNCHANGED: find by `location_id`, read `cost_currency`,
//        default to 0.
//   H-3  The swap SHALL NOT reorder the ownership / escrow / spend sequence that
//        `economy-sinks-sources.eval.mjs` pins (ADR-0170 D3 says so in as many
//        words: "the owner-first/spend ordering ... is not reordered").
//
// RED STATE. H-2 is ASSERTION-RED at HEAD: `heal_party` (raising.rs:324) calls
// the uncached loader. H-3 is a GREEN-AT-HEAD fence, and a SEPARATE `#[test]`
// for the reason the house records elsewhere (`movement_tests.rs:917-921`):
// behind a failing assertion it could never be observed passing, so it would
// prove nothing about the swap it exists to constrain.
//
// Both scans reuse this file's existing helpers verbatim — `RAISING_SOURCE`
// (line ~656), `strip_raising_comments` (line ~659) and `reducer_body`
// (line ~840) — and whitespace-collapse the extracted body the same way
// `care_battle_guard_wired` does, so a rustfmt line split can never cause a
// false RED. Needles are assembled from fragments (house rule) so no eval that
// concatenates every source file under this crate can be satisfied by this
// test's own text.
// ===========================================================================

/// Blank the CONTENT and delimiters of every `"…"` string literal, preserving
/// byte length by substituting spaces.
///
/// A LOCAL, ADDITIVE companion to this file's shared `strip_raising_comments`
/// (which stays comment-only): used ONLY by
/// [`heal_party_reads_the_cached_heal_location_registry`], so the pre-existing
/// ptc5a `care` / `train` needles keep the exact view they were written against.
/// Apply AFTER comment stripping, never before.
///
/// Handles `"…"` with `\` escapes only; [`assert_no_heal_scan_landmines`] fails
/// loudly on the two constructs that would misalign it.
fn blank_heal_scan_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if bytes[i] == 0x22 {
            i += 1;
            while i < len {
                if bytes[i] == b'\\' {
                    i += 2;
                } else if bytes[i] == 0x22 {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("string-blanked source must be valid UTF-8")
}

/// Loud preconditions for [`blank_heal_scan_strings`]'s two blind spots: raw
/// strings and a double quote spelled as a char literal. A silently misaligned
/// blanker would blank the wrong byte range and turn the gate below vacuous, so
/// each fails with an explicit message instead (the discipline
/// `guards_tests.rs`'s `assert_stripper_preconditions` established).
fn assert_no_heal_scan_landmines(raw: &str) {
    let raw_opener = ["r", "#"].concat();
    assert!(
        !raw.contains(raw_opener.as_str()),
        "SCAN PRECONDITION (11r-g H-2): `raising.rs` contains a raw-string / \
         raw-identifier opener, which this file's minimal string blanker does not \
         handle — it would blank the wrong byte range and hollow out the gate below. \
         Extend the blanker before adding such a literal."
    );
    let sq = char::from(0x27u8).to_string();
    let dq = char::from(0x22u8).to_string();
    let char_literal_quote = [sq.as_str(), dq.as_str(), sq.as_str()].concat();
    assert!(
        !raw.contains(char_literal_quote.as_str()),
        "SCAN PRECONDITION (11r-g H-2): `raising.rs` spells a double quote as a CHAR \
         literal. This blanker has no char-literal lexer, so that quote reads as a \
         string OPENER and inverts string/code polarity for the rest of the file. \
         Spell it with a Unicode escape inside the char literal."
    );
}

/// **H-2** (ADR-0170 D3) — `heal_party` reads the CACHED heal-location registry.
///
/// ASSERTION-RED at HEAD: raising.rs:324 calls the uncached loader, re-parsing
/// the embedded heal-location RON on every single `heal_party` call.
///
/// WHAT EACH NEEDLE KILLS.
///   * Positive, module-QUALIFIED `content_cache::cached_heal_locations(` —
///     kills the false green where a file-local helper named
///     `load_cached_heal_locations()` satisfies a bare substring while still
///     re-parsing internally (the same qualification reasoning
///     `content_cache_tests.rs`'s M14.5e gate records). The trailing open paren
///     pins a CALL rather than a mention.
///   * Negative `load_heal_locations(` — kills the belt-and-braces shell that
///     adds the cached call and leaves the uncached one, so the re-parse
///     survives. The open paren is deliberate: it targets the CALL and
///     deliberately ignores the accessor's name appearing inside the `map_err`
///     message text, which this file's comment-only stripper leaves visible.
///     (Renaming that message is good hygiene but is not gated here — a false
///     RED on a message would be a fence with no defect behind it.)
///   * `cost_currency` — kills a swap that reaches the cache but then reads the
///     wrong field or drops the currency lookup entirely. ADR-0083 puts the heal
///     price on `HealLocationDef`, not on the DB row, so this field IS the price.
///   * `unwrap_or(0)` at least twice — pins BOTH defaults that make `heal_party`
///     total: the missing-cooldown-row default (raising.rs:320) and the
///     unknown-location cost default (:329). Dropping the cost default turns an
///     unlisted `location_id` into an error or a panic on a path that today is
///     simply free, and ADR-0170 D3 requires the semantics to be unchanged.
///
/// COMMENTS **AND** STRING LITERALS ARE BLANKED before any needle is evaluated.
/// This file's shared `strip_raising_comments` is comment-only, which is fine for
/// the pre-existing tests but NOT for a gate whose teeth are a POSITIVE needle: a
/// dead `let _decoy = "content_cache::cached_heal_locations()";` in the body would
/// satisfy the positive needle while `heal_party` still calls the uncached loader,
/// and the negative needle would never fire because the decoy does not spell it.
/// That is the red-team hole `movement_tests.rs:45-52` records for this crate.
/// [`blank_heal_scan_strings`] is a local, additive step — the shared helper and
/// the ptc5a tests are untouched.
///
/// HONEST LIMIT: a source scan, not an execution — this crate has no
/// reducer-executing harness (ADR-0156 P7). That the cached accessor returns the
/// same data as the loader is proven separately and behaviourally by
/// `content_cache_tests.rs::cached_heal_locations_matches_load`.
#[test]
fn heal_party_reads_the_cached_heal_location_registry() {
    assert_no_heal_scan_landmines(RAISING_SOURCE);
    let stripped = blank_heal_scan_strings(&strip_raising_comments(RAISING_SOURCE));
    let fn_needle = ["pub fn heal", "_party(ctx:"].concat();
    let body = reducer_body(&stripped, &fn_needle);
    let collapsed: String = body.split_whitespace().collect();

    let cached = ["content_cache::cached_heal", "_locations("].concat();
    assert!(
        collapsed.contains(cached.as_str()),
        "TEETH (11r-g H-2, ADR-0170 D3): `heal_party` must read the heal-location \
         registry through `content_cache::cached_heal_locations(..)` — the eighth \
         LazyLock this slice adds. RED at HEAD: raising.rs:324 calls the uncached \
         loader and re-parses the embedded RON on EVERY heal. The needle is \
         module-QUALIFIED and keeps its opening paren so a file-local \
         `load_cached_heal_locations()` shim cannot satisfy it, and comments AND \
         string literals are blanked before matching so a dead \
         `let _decoy = <the needle text>;` cannot satisfy it either — only an \
         executable call can."
    );

    let banned = ["load_heal", "_locations("].concat();
    let n_banned = collapsed.matches(banned.as_str()).count();
    assert_eq!(
        n_banned, 0,
        "TEETH (11r-g H-2, ADR-0170 D3): `heal_party`'s body makes {n_banned} direct \
         call(s) to the uncached heal-location loader and must make ZERO. HEAD has 1. \
         Adding the cached accessor while leaving this call in place is the \
         belt-and-braces shell that passes the positive needle above with the \
         per-call RON re-parse fully intact. String literals are blanked before \
         matching, so the accessor name inside the existing `map_err` message cannot \
         trip this — only an executable call can. (Renaming that message when the \
         call moves is still good hygiene; it is deliberately not gated.)"
    );

    let cost_field = ["cost", "_currency"].concat();
    assert!(
        collapsed.contains(cost_field.as_str()),
        "TEETH (11r-g H-2, ADR-0170 D3): `heal_party` must still read `cost_currency` \
         from the heal-location definition. ADR-0083 §A puts the heal price on \
         `HealLocationDef` (content), NOT on the DB row, so this field IS the price — \
         a swap that reaches the cache but drops the field makes every paid heal free."
    );

    let default_zero = ["unwrap_or(", "0)"].concat();
    let n_default = collapsed.matches(default_zero.as_str()).count();
    assert!(
        n_default >= 2,
        "TEETH (11r-g H-2, ADR-0170 D3): `heal_party` must keep BOTH of its \
         zero-defaults; the body has {n_default} `unwrap_or(0)` and needs at least 2. \
         The two are raising.rs:320 (no `heal_cooldown` row yet ⇒ last heal at 0) and \
         :329 (the `location_id` is absent from the registry ⇒ the heal is FREE). \
         ADR-0170 D3 requires the semantics to be unchanged by the cache swap: \
         dropping the cost default turns an unlisted location from a free heal into \
         an error or a panic, on a path a content edit can reach."
    );
}

/// **H-3** (ADR-0170 D3, ADR-0083 / ADR-0106 consequence fence) — the cache swap
/// must not reorder `heal_party`'s ownership / escrow / spend sequence.
///
/// GREEN AT HEAD and green after the slice; RED if the currency block is
/// restructured while the cost lookup above it is being rewritten.
///
/// WHY THIS FENCE EXISTS HERE. H-2 rewrites the statement DIRECTLY ABOVE this
/// sequence (`let currency_cost = ...`). Editing the head of a block is the
/// classic way to accidentally re-flow the rest of it, and every property below
/// is invisible to H-2's needles:
///
///   1. **`if currency_cost > 0 {` still gates the whole spend.** A content edit
///      that sets a heal price is only safe because a zero price skips the block
///      entirely. Without the gate, `spend_currency(ctx, me, 0)` runs on every
///      free heal — a write, a wallet row touch, and a broadcast to every
///      subscriber, on the most-called reducer in the raising domain.
///   2. **`require_owner` precedes the escrow check, which precedes the spend.**
///      This is the ordering `economy-sinks-sources.eval.mjs` pins. Spending
///      before the escrow check lets a player pay for a heal with currency that
///      is already locked in an active trade offer (TR-10, ADR-0106) — the
///      double-spend the escrow guard exists to close. Spending before
///      `require_owner` is the reject-never-burns violation ADR-0083 names: the
///      currency is gone before the call is known to be legitimate.
///   3. **Each of the three appears EXACTLY ONCE.** With two `spend_currency`
///      calls the index comparison below is satisfiable while a second, unguarded
///      spend runs later — the same reasoning `movement_tests.rs`'s E1 layer-3
///      precondition records for a duplicated drain site.
///
/// HONEST LIMIT: it pins textual ORDER within one reducer body, which is a sound
/// proxy here because these three are straight-line statements in a single block.
/// It says nothing about the ordering eval itself — that gate stays the SSOT; this
/// is the fast local canary that runs in the same `cargo test` as the swap.
#[test]
fn heal_party_keeps_owner_and_escrow_checks_before_the_spend() {
    let stripped = strip_raising_comments(RAISING_SOURCE);
    let fn_needle = ["pub fn heal", "_party(ctx:"].concat();
    let body = reducer_body(&stripped, &fn_needle);
    let collapsed: String = body.split_whitespace().collect();

    let gate = ["ifcurrency_cost", ">0{"].concat();
    assert!(
        collapsed.contains(gate.as_str()),
        "TEETH (11r-g H-3, ADR-0083): `heal_party` must keep `if currency_cost > 0 {{` \
         as the gate on the whole currency block. Without it a FREE heal still runs \
         `spend_currency(ctx, me, 0)` — a wallet write and a subscriber broadcast on \
         the most-called reducer in this domain — and the zero-price content path \
         stops being a no-op."
    );

    let owner = ["require", "_owner(ctx,"].concat();
    let escrow = ["escrowed_currency", "_amount("].concat();
    let spend = ["spend", "_currency(ctx,"].concat();

    for (label, needle) in [
        ("the ownership guard", owner.as_str()),
        ("the trade-escrow check", escrow.as_str()),
        ("the currency spend", spend.as_str()),
    ] {
        let n = collapsed.matches(needle).count();
        assert_eq!(
            n, 1,
            "FENCE PRECONDITION (11r-g H-3): {label} must appear EXACTLY ONCE in \
             `heal_party`'s body; found {n}. With zero the step was deleted; with two \
             the index comparison below is satisfiable while a SECOND, unguarded copy \
             runs later in the same block (the duplicated-site hazard \
             `movement_tests.rs`'s E1 layer-3 precondition records)."
        );
    }

    let owner_at = collapsed
        .find(owner.as_str())
        .expect("11r-g H-3: the ownership guard was not found in heal_party's body");
    let escrow_at = collapsed
        .find(escrow.as_str())
        .expect("11r-g H-3: the trade-escrow check was not found in heal_party's body");
    let spend_at = collapsed
        .find(spend.as_str())
        .expect("11r-g H-3: the currency spend was not found in heal_party's body");

    assert!(
        owner_at < escrow_at,
        "TEETH (11r-g H-3, ADR-0083 reject-never-burns): the ownership guard is at \
         collapsed byte {owner_at} but the trade-escrow check is at {escrow_at} — the \
         guard must come FIRST. Green at HEAD; if this fires, the currency block was \
         re-flowed while the cost lookup above it was being swapped to the cache."
    );
    assert!(
        escrow_at < spend_at,
        "TEETH (11r-g H-3, ADR-0106 TR-10): the trade-escrow check is at collapsed \
         byte {escrow_at} but the spend is at {spend_at} — the escrow check must come \
         FIRST. Spending before it lets a player pay for a heal with currency already \
         locked in an active trade offer, which is the double-spend \
         `escrowed_currency_amount` exists to close and which \
         `economy-sinks-sources.eval.mjs` pins from outside this crate. Green at HEAD."
    );
}
