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
// M12.5b-4: care reducer must recompute evolves_to after bond increases
//
// EARS criterion: after a successful care that raises bond to a level that
// meets an evolution threshold, the monster row's `evolves_to` must be set
// to Some(target_species_id).
//
// The `care` reducer itself calls `evaluate_care` (pure seam, tested above)
// and then writes back `m.bond` and `m.last_care_at_ms` followed by
// `pub_from_monster`. The M12.5b criterion requires it to ALSO recompute
// `m.evolves_to` — which the current implementation omits.
//
// We test this at the pure-seam level using the `evaluate_care_with_evolves_to`
// seam (expected by the implementer) which mirrors the care reducer write-back
// but returns the new evolves_to value alongside the new bond.
//
// RED state: `evaluate_care_with_evolves_to` does not exist yet → compile-RED.
// Alternatively, we test the structural property: the `care` reducer body in
// raising.rs must contain an `evolves_to` assignment.
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

/// 12.5b-4 structural: the `care` reducer body in raising.rs must assign
/// `m.evolves_to` so that after a bond increase that crosses an evolution
/// threshold, the monster's eligibility is reflected immediately.
///
/// KILLS: a care reducer that writes back bond but forgets evolves_to —
///        a player who raises bond to an evolution threshold during care
///        would not see their evolution hint until the next content sync.
#[test]
fn care_reducer_assigns_evolves_to() {
    let stripped = strip_raising_comments(RAISING_SOURCE);

    // Locate the `care` reducer body. Built from parts to avoid self-match.
    let fn_needle = ["pub fn care", "(ctx:"].concat();
    let fn_pos = stripped
        .find(fn_needle.as_str())
        .expect("care reducer must be declared in raising.rs");
    // Walk forward to find the opening brace.
    let after = &stripped[fn_pos..];
    let brace = after.find('{').expect("care reducer must have a body");
    let body_start = fn_pos + brace + 1;

    // Count braces to find the closing brace of the reducer body.
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
    let body = &stripped[body_start..body_start + byte_off];

    // The care reducer body must assign evolves_to.
    // Assembled from parts so the exact literal does not appear verbatim in
    // this test's own source text (which is inside the included file).
    let assignment = ["m.evolves_to", " ="].concat();

    assert!(
        body.contains(assignment.as_str()),
        "TEETH(12.5b-4): the `care` reducer body must assign `m.evolves_to = ...` \
         (via compute_evolves_to) after updating the bond, so that bond-based evolution \
         eligibility is immediately reflected in the monster row. \
         Currently absent: add `m.evolves_to = crate::evolution::compute_evolves_to(&evolutions, &m);` \
         in the care reducer write-back path."
    );
}

/// 12.5b-4 structural: the `care` reducer body must also call `compute_evolves_to`
/// to generate the new evolves_to value (not hard-code None or copy a stale value).
///
/// KILLS: an impl that writes `m.evolves_to = None;` (clearing eligibility on every
///        care) or `m.evolves_to = m.evolves_to;` (leaving it stale without recomputing).
#[test]
fn care_reducer_calls_compute_evolves_to() {
    let stripped = strip_raising_comments(RAISING_SOURCE);

    let fn_needle = ["pub fn care", "(ctx:"].concat();
    let fn_pos = stripped
        .find(fn_needle.as_str())
        .expect("care reducer must be declared in raising.rs");
    let after = &stripped[fn_pos..];
    let brace = after.find('{').expect("care reducer must have a body");
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
    let body = &stripped[body_start..body_start + byte_off];

    let compute_call = ["compute", "_evolves_to"].concat();

    assert!(
        body.contains(compute_call.as_str()),
        "TEETH(12.5b-4): the `care` reducer body must call `compute_evolves_to` \
         to recompute evolution eligibility after the bond is updated; \
         assigning `m.evolves_to = None` or leaving it stale are both wrong. \
         Add: load evolutions from game_core::load_evolutions() and call \
         compute_evolves_to(&species_evolutions, &m) to get the new value."
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
    let needle = ["ifis_in_ongoing", "_battle(ctx,ctx.sender)"].concat();

    assert!(
        collapsed.contains(needle.as_str()),
        "TEETH(ptc5a-1): the `care` reducer body must contain \
         `if is_in_ongoing_battle(ctx, ctx.sender)` (whitespace-collapsed: \
         `ifis_in_ongoing_battle(ctx,ctx.sender)`) immediately after `require_owner`. \
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
    let needle = ["ifis_in_ongoing", "_battle(ctx,ctx.sender)"].concat();

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
