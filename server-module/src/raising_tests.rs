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
//!   - Max bond is NOT a reject any more — EG2-5 / ADR-0175 D2 remaps
//!     `CareError::AtMaxBond` to a bond-unchanged continuation so the Trust
//!     credit keeps flowing; the cooldown still gates unconditionally. (This
//!     supersedes the M9 bullet "max bond rejects before burning cooldown" —
//!     see `care_at_max_bond_still_succeeds_and_increments_trust` below.)
//!   - Care raises bond by exactly min(CARE_BOND_AMOUNT, 255 - bond).
//!   - Safe-direction clock: future last_care_at_ms only over-rejects (no bypass).
//!   - Elapsed from nonzero base works correctly.
//!
//! EG2 (ADR-0175) adds, at the bottom of this file, the essence-graph raising
//! layer: `apply_quality_time_credit`, `grant_essence`, `evaluate_essence_train`,
//! `evaluate_consume_crystalized`, the revised `care` semantics, and the
//! source-scan pins for the two new reducers' guard/tail discipline.
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
// Max bond: REVISED by EG2-5 / ADR-0175 D2 (was: "rejects even with cooldown
// elapsed"). See the doc comment on the first test below for why the old pin is
// gone — the change is spec-driven, not implementation-driven.
// ---------------------------------------------------------------------------

/// **REVISION (EG2-5, ADR-0175 D2 — supersedes the M9b pin
/// `max_bond_rejects_even_with_cooldown_elapsed`).**
///
/// The deleted pin asserted `evaluate_care(255, 0, CARE_COOLDOWN_MS)` is `Err`,
/// encoding M9b's "a maxed-bond monster has nothing left to gain, so reject
/// before burning the cooldown". EG2-5 makes `care` the Trust-favorable writer
/// (`trust_favorable_count`), and `bond` is a FROZEN dead column until Migration
/// B (EG5-6). Keeping the old reject would mean the live gate (Trust) is
/// permanently starved by the dead column: after ~51 cares (~13 days of routine
/// play at the 6 h cooldown) `care` would reject forever and Trust could never
/// grow again. So `CareError::AtMaxBond` now maps to a bond-UNCHANGED
/// continuation and the reducer proceeds to the Trust credit.
///
/// The revision is written from the spec (EG2-5 + ADR-0175 D2), not to match any
/// implementation; the cooldown half of the old pin is NOT relaxed — it is
/// re-asserted, harder, by `care_at_max_bond_still_cooldown_gated` below.
///
/// kills: an impl that keeps propagating `AtMaxBond` as `Err` (Trust growth
///        silently dies at bond 255); an impl that "fixes" it by returning a
///        bumped bond (256 is unrepresentable — the value must stay 255).
///
/// The Trust increment itself lives in `care`'s body (not in this pure seam) and
/// is pinned by `care_body_has_trust_increment_and_tails`.
#[test]
fn care_at_max_bond_still_succeeds_and_increments_trust() {
    // bond = 255 (max), cooldown fully elapsed.
    let result = evaluate_care(255, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            assert_eq!(
                new_bond, 255,
                "evaluate_care(bond=255, cooldown elapsed) must return the bond \
                 UNCHANGED at 255 (AtMaxBond ⇒ bond-unchanged continuation, \
                 ADR-0175 D2) — never a wrapped or clamped-down value"
            );
        }
        Err(e) => {
            panic!(
                "TEETH (EG2-5, ADR-0175 D2): evaluate_care(bond=255, last=0, \
                 now=CARE_COOLDOWN_MS) must now be Ok(255), NOT Err. A maxed-bond \
                 monster must keep earning Trust through `care`; rejecting here \
                 lets a FROZEN dead column (bond) permanently starve a LIVE \
                 evolution gate (Trust). Got Err: {e:?}"
            );
        }
    }
}

/// **EG2-5 / ADR-0175 D2, second half — the remap must NOT open a rate hole.**
///
/// A maxed-bond monster earns Trust at exactly the same cooldown-limited rate as
/// every other monster. This is the reason D2 says the `AtMaxBond` remap must be
/// REORDERED inside `evaluate_care` rather than bolted on: if the impl keeps
/// `apply_care(..)?`-first shape and merely turns the error into an early
/// `return Ok(bond)`, the early return jumps straight over the cooldown gate and
/// a bond-255 monster can be cared — and Trust-credited — in an unbounded loop.
///
/// kills: `match apply_care(..) { Err(AtMaxBond) => return Ok(bond), .. }` placed
///        BEFORE the `is_cooldown_ready` check (rate-unlimited Trust farming on
///        any monster the player has already maxed) — the exact wrong shape the
///        naive reading of D2 produces.
#[test]
fn care_at_max_bond_still_cooldown_gated() {
    // bond = 255 (max), ONE ms short of the cooldown boundary.
    let result = evaluate_care(255, 0, CARE_COOLDOWN_MS - 1);
    assert!(
        result.is_err(),
        "TEETH (EG2-5, ADR-0175 D2): evaluate_care(bond=255, last=0, \
         now=CARE_COOLDOWN_MS-1) must be Err — the AtMaxBond remap must not \
         short-circuit past the cooldown gate. A maxed-bond monster earns Trust \
         at the SAME rate as any other, never faster. Got Ok: {:?}",
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

// ###########################################################################
// EG2 (spec M-evolution-essence-graph §2 EG2-3/4/5/6/8/10, ADR-0175) —
// the essence-graph raising layer.
//
// RED STATE, and WHY. Every test below references a production symbol that does
// not exist yet, so this whole file is RED BY COMPILE ERROR until the specialist
// lands, in `server-module/src/raising.rs`:
//
//   pub(crate) const ESSENCE_TRAIN_COOLDOWN_MS: i64;   // 5 h
//   pub(crate) const ESSENCE_TRAIN_AMOUNT: u32;        // 5
//   pub(crate) const ESSENCE_SOFT_CAP: u32;            // 999
//   pub(crate) const QT_TICK_MS / QT_IDLE_GAP_MS
//                  / QT_MIN_WRITE_GAP_MS / QT_DAILY_CAP_MS: i64;
//   pub(crate) fn grant_essence(m: &mut Monster, affinity: Affinity, amount: u32);
//   pub(crate) fn apply_quality_time_credit(m: &mut Monster, now: i64) -> bool;
//   pub(crate) fn accrue_quality_time(ctx: &ReducerContext, monster_id: u64);
//   pub(crate) fn evaluate_essence_train(last_train_ms: i64, now: i64)
//                  -> Result<(), String>;
//   pub(crate) fn evaluate_consume_crystalized(
//                    item: &game_core::ItemDef, last_train_ms: i64, now: i64,
//                  ) -> Result<(game_core::Affinity, u32), String>;
//   #[spacetimedb::reducer] pub fn essence_train(..) / consume_crystalized_essence(..)
//
// After it compiles, the source-scan block at the bottom stays RED until the two
// new reducers carry the full guard set and the accrue/check_and_evolve tails.
//
// SHAPE OF THE SUITE. The ms-level accrual rule is exercised DIRECTLY on the pure
// `apply_quality_time_credit(&mut Monster, now)` seam with hand-built rows — the
// pattern this file already uses for `evaluate_care`/`evaluate_train`/
// `evaluate_heal`, and the only pattern available: this crate has NO
// reducer-executing harness (ADR-0156 P7, restated at
// `heal_party_reads_the_cached_heal_location_registry`'s honest-limit note), so
// the ctx shells are pinned structurally instead.
//
// NOTE ON THE CONSTANTS. ADR-0175 calls all five pacing magnitudes playtest
// placeholders and the SHAPE the decision. The hand-computed expectations below
// are written against the placeholder values, so each value is pinned exactly
// ONCE, in the test whose arithmetic depends on it, with a `RETUNE` note —
// retuning is then a deliberate two-line edit (constant + its one pin), never a
// silent behaviour change. Everything else references the consts symbolically.
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
        bond: 40,
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
        evolves_to: None,
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
// EG2-8 / ADR-0175 D1 — `apply_quality_time_credit`: bounded-gap active-playtime
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

/// EG2-8: a gap inside the idle window credits, converts whole ticks, and
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
/// This is the unit-level proof-of-teeth for the whole no-idle-accrual gate:
/// `evals/no-idle-accrual.eval.mjs` proves nothing SCHEDULED can call the growth
/// writers, and this proves that even a genuine player call cannot launder
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

/// EG2-8: the first-ever call on a fresh monster (anchor 0) only anchors.
///
/// A brand-new row carries `quality_time_window_start_ms = 0`, so the gap is the
/// whole Unix epoch — it lands in the idle branch BY CONSTRUCTION (ADR-0175 D1).
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

/// EG2-8: a backwards server clock re-anchors and credits nothing.
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

/// EG2-8: credit accumulates across calls and converts to whole ticks, keeping
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

/// EG2-8: a sub-threshold gap is a PURE no-op that returns false — and the kept
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
    assert!(wrote2, "a 10 s gap is above the write threshold — must return true");
    assert_eq!(
        qt_state(&m),
        (now2, 14_000, 13_000, 2),
        "TEETH (EG2-8, ADR-0175 D1): the follow-up call must credit the FULL \
         10_000 ms measured from the ORIGINAL anchor (window 4_000+10_000, accum \
         3_000+10_000). An impl that re-anchored on the skipped call would credit \
         only 7_000 ms here — 3 s of real playtime lost per sub-threshold call."
    );
}

/// EG2-8: once the day window is full, further gaps credit nothing (but still
/// re-anchor).
///
/// Defense in depth per ADR-0175 D1: one marathon session must not walk the whole
/// tier ladder.
///
/// kills: an impl with no daily cap (the 60 s gap would credit another tick); an
///        impl that returns false / keeps the old anchor when capped — the stale
///        anchor makes the next call look IDLE, so the first post-midnight gap
///        would be dropped instead of credited.
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
    let mut m = qt_monster(QT_ANCHOR, cap, 0, 120);
    let wrote = apply_quality_time_credit(&mut m, now);

    assert!(
        wrote,
        "a capped call must still persist the fresh anchor (true) — otherwise \
         the next call reads a stale anchor and mis-classifies live play as idle"
    );
    assert_eq!(
        qt_state(&m),
        (now, cap, 0, 120),
        "TEETH (EG2-8, ADR-0175 D1): with the day window already at \
         QT_DAILY_CAP_MS the creditable amount is 0 — anchor moves, ticks and \
         accum do not."
    );
}

/// EG2-8: crossing into a new UTC day resets the day window, so credit flows
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

/// EG2-8: `quality_time_ticks_total` saturates instead of wrapping or panicking.
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

/// EG2-8: when the day window is PARTLY full, exactly the remaining headroom is
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
// EG2-3 / EG1-1 / ADR-0175 D5 — `grant_essence`: clamp, never reject
// ===========================================================================

/// EG2-3: `grant_essence` writes the ONE column matching the affinity and leaves
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

/// EG2-3 / EG1-1: the soft cap CLAMPS — it never rejects, and never overshoots.
///
/// kills: an impl that returns/propagates an error at the cap (EG1-1 says
///        "saturating_add on grant, soft cap, never reject" — a reject would let
///        a battle win fail wholesale on a maxed pool); an impl with no cap at
///        all (1_010 here); an impl that clamps to the wrong bound.
#[test]
fn clamps_at_soft_cap_999_without_reject() {
    // RETUNE: the only pin of ESSENCE_SOFT_CAP's value (ADR-0175 D5 / EG1-1).
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

/// EG2-3: the add SATURATES before the clamp — a near-u32::MAX pool cannot panic.
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
// EG2-3 — `evaluate_essence_train`: the shared 5 h cooldown seam
// ===========================================================================

/// EG2-3: a call inside the cooldown is rejected.
///
/// kills: a missing cooldown gate entirely (essence_train would be spammable and
///        the 999 cap reachable in one session, collapsing evolution pacing);
///        an off-by-one that admits the last millisecond.
#[test]
fn rejects_within_cooldown() {
    // RETUNE: the only pin of ESSENCE_TRAIN_COOLDOWN_MS's value (5 h, ADR-0175 D5).
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

/// EG2-3: elapsed EXACTLY equal to the cooldown is allowed.
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

/// EG2-3: a monster that has never essence-trained (anchor 0) may train now.
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
// EG2-4 / EG2-10 — `evaluate_consume_crystalized`: the decision that runs
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

/// EG2-4: consumption shares `essence_train`'s cooldown clock.
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

/// EG2-4: the accepted case returns the ITEM's affinity and the ITEM's amount.
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

/// EG2-4: the consumption boundary is the SAME instant as `essence_train`'s —
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
// EG2-5 — the revised `care` seam (the other two cases live beside the
// superseded max-bond pin above)
// ===========================================================================

/// EG2-5 / ADR-0175 D2 regression fence: the AtMaxBond remap must not disturb the
/// ordinary path.
///
/// kills: a remap implemented by making `apply_care` infallible-by-clamping in
///        the shell (e.g. `Ok(bond.saturating_add(CARE_BOND_AMOUNT))` computed
///        inline), which would drop the `game_core::apply_care` SSOT delegation
///        the raising-reducer-security gate requires; and any drift in the
///        magnitude while the surrounding code is being edited.
#[test]
fn evaluate_care_normal_path_unchanged() {
    let result = evaluate_care(100, 0, CARE_COOLDOWN_MS);
    match result {
        Ok(new_bond) => {
            let expected = 100u8.saturating_add(CARE_BOND_AMOUNT);
            assert_eq!(
                new_bond, expected,
                "TEETH (EG2-5): a normal care must still raise bond by exactly \
                 CARE_BOND_AMOUNT ({CARE_BOND_AMOUNT}): 100 ⇒ {expected}"
            );
        }
        Err(e) => panic!(
            "evaluate_care(bond=100, last=0, now=CARE_COOLDOWN_MS) must be Ok; \
             got Err: {e:?}"
        ),
    }
}

// ===========================================================================
// EG2 SOURCE SCANS on `raising.rs` (production, NOT this file).
//
// HONEST LIMIT, stated once for the whole block: these are source scans, not
// executions — this crate has no reducer-executing harness (ADR-0156 P7). They
// pin the guard set, the decision-before-consume order and the tail discipline
// that no pure seam can observe. `evals/evolution-reducer-security.eval.mjs`
// (EG5-2) remains the authoritative gate; these are the fast local canaries that
// run in the same `cargo test` as the implementation.
//
// Every scan below runs on a view with COMMENTS AND STRING LITERALS BLANKED
// (`blank_heal_scan_strings ∘ strip_raising_comments`, this file's existing
// helpers) and then whitespace-collapsed, so (a) a rustfmt line split can never
// cause a false RED and (b) a dead `let _decoy = "<needle>";` cannot satisfy a
// positive needle — only executable code can. Needles are assembled from
// fragments (house rule) so an eval that concatenates every source file in this
// crate is never satisfied by this test file's own text.
// ===========================================================================

/// Comment-stripped, string-blanked, whitespace-collapsed body of a `raising.rs`
/// function. Panics loudly (RED) if the function does not exist yet.
fn eg2_scan_body(fn_needle: &str) -> String {
    assert_no_heal_scan_landmines(RAISING_SOURCE);
    let stripped = blank_heal_scan_strings(&strip_raising_comments(RAISING_SOURCE));
    let body = reducer_body(&stripped, fn_needle);
    let collapsed: String = body.split_whitespace().collect();
    assert!(
        !collapsed.is_empty(),
        "VACUITY GUARD: the extracted body for {fn_needle:?} is EMPTY — the \
         scanner has rotted and every verdict in this block would be meaningless"
    );
    collapsed
}

/// Assert a needle is present in a collapsed body, with the reason attached.
fn assert_body_has(collapsed: &str, label: &str, needle: &str, why: &str) {
    assert!(
        collapsed.contains(needle),
        "TEETH (EG2, ADR-0175): {label} must contain `{needle}` (whitespace- \
         collapsed; comments and string literals are blanked first, so only \
         executable code can satisfy this). {why}"
    );
}

/// Assert a needle appears EXACTLY once — the duplicated-site hazard this file's
/// H-3 fence already records (`movement_tests.rs` E1 layer-3).
fn assert_body_has_exactly_one(collapsed: &str, label: &str, needle: &str, why: &str) {
    let n = collapsed.matches(needle).count();
    assert_eq!(
        n, 1,
        "TEETH (EG2, ADR-0175): {label} must contain `{needle}` EXACTLY once; \
         found {n}. Zero means the step is missing; two means a second, \
         unguarded copy runs elsewhere in the same body. {why}"
    );
}

/// The `raising.rs` fn-declaration needles, assembled from fragments and
/// deliberately WITHOUT the `(ctx:` suffix the older ptc5a needles carry: two of
/// these signatures are past rustfmt's width limit and are broken across lines,
/// where `(ctx:` would never match.
fn care_decl() -> String {
    ["fn care", "("].concat()
}
fn train_decl() -> String {
    ["fn train", "("].concat()
}
fn essence_train_decl() -> String {
    ["fn essence", "_train("].concat()
}
fn consume_decl() -> String {
    ["fn consume_crystalized", "_essence("].concat()
}
fn accrue_decl() -> String {
    ["fn accrue_quality", "_time("].concat()
}

/// EG2-3: `essence_train` carries the full `care`-shaped guard set, delegates its
/// decision and magnitude, and ends with both tails.
///
/// kills: a new reducer that forgets ANY guard — each omission is a distinct live
///        vulnerability: no ownership check ⇒ train a stranger's monster; no
///        battle guard ⇒ mid-battle mutation (the ADR-0136 class); no trade-escrow
///        guard ⇒ mutate a monster already locked in an offer (TR-6); no
///        `evaluate_essence_train` ⇒ an ungated cooldown; a hardcoded grant
///        amount instead of `ESSENCE_TRAIN_AMOUNT` ⇒ silent pacing drift.
/// The `if ...{` shape on the battle guard additionally kills a dead-code
/// `let _ = is_in_ongoing_battle(..);` evasion, exactly as ptc5a Test 1 does.
#[test]
fn essence_train_body_has_full_guard_set() {
    // RETUNE: the only pin of ESSENCE_TRAIN_AMOUNT's value (ADR-0175 D9).
    assert_eq!(
        ESSENCE_TRAIN_AMOUNT, 5,
        "fixture precondition: one essence_train grants a flat 5 (EG2-3)"
    );

    let body = eg2_scan_body(&essence_train_decl());
    let label = "the `essence_train` reducer body";

    assert_body_has(
        &body,
        label,
        &["require", "_owner(ctx,"].concat(),
        "EG2-3 mirrors `care`: no ownership check means any caller can train any \
         monster in the database.",
    );
    assert_body_has(
        &body,
        label,
        &["ifis_in_ongoing", "_battle(ctx,ctx.sender){"].concat(),
        "EG2-3 mirrors `care`'s both-role battle guard (ADR-0136).",
    );
    assert_body_has(
        &body,
        label,
        &["reject_if_monster", "_in_trade("].concat(),
        "TR-6 (ADR-0106): a monster locked in an active trade offer must not be \
         mutated out from under the counterparty.",
    );
    assert_body_has(
        &body,
        label,
        &["evaluate_essence", "_train("].concat(),
        "the cooldown decision must come from the pure seam this file tests, not \
         from a second open-coded copy that can drift.",
    );
    assert_body_has(
        &body,
        label,
        &["grant", "_essence("].concat(),
        "EG1-1's clamp-never-reject rule lives in ONE helper; an inline \
         `m.essence_fire += amount` bypasses both the saturation and the cap.",
    );
    assert_body_has(
        &body,
        label,
        &["ESSENCE_TRAIN", "_AMOUNT"].concat(),
        "the granted magnitude must reference the named constant, so retuning it \
         is one edit and not a hunt for literals.",
    );
    assert_body_has(
        &body,
        label,
        &["accrue_quality", "_time("].concat(),
        "EG2-8 lists essence_train as a Quality-Time call site.",
    );
    assert_body_has(
        &body,
        label,
        &["check_and", "_evolve("].concat(),
        "EG2-12: essence_train mutates a gate value (essence), so it must give \
         auto-evolution its chance to fire.",
    );
}

/// EG2-4 / EG2-10: `consume_crystalized_essence` carries the ITEM-escrow guard,
/// reads the content registry, and decides BEFORE it consumes.
///
/// The ordering assertion is the load-bearing one: it is the textual proof of
/// EG2-10's "the item is NOT consumed on either reject". `consume_one` is the
/// irreversible step; every reject must be upstream of it.
///
/// kills: a reducer that consumes first and validates after (a wrong-item call
///        would burn the player's item and only then reject — the reject-burns
///        bug ADR-0058/0059 exist to prevent, and the exact shape EG2-10 pins);
///        a missing `escrowed_item_qty` check (spend an item already promised in
///        a trade offer — the double-spend-shaped gap EG2-4 calls non-optional);
///        an impl that reads item defs from the DB `item_row` instead of the
///        content registry, where the essence fields do not exist at all
///        (ADR-0175 consequence note).
#[test]
fn consume_body_has_item_escrow_and_decision_before_consume() {
    let body = eg2_scan_body(&consume_decl());
    let label = "the `consume_crystalized_essence` reducer body";

    assert_body_has(
        &body,
        label,
        &["require", "_owner(ctx,"].concat(),
        "EG2-10 requires the unowned-monster reject.",
    );
    assert_body_has(
        &body,
        label,
        &["ifis_in_ongoing", "_battle(ctx,ctx.sender){"].concat(),
        "EG2-4 specifies the both-role battle guard.",
    );
    assert_body_has(
        &body,
        label,
        &["reject_if_monster", "_in_trade("].concat(),
        "EG2-4 specifies the monster trade-escrow guard.",
    );
    assert_body_has(
        &body,
        label,
        &["escrowed_item", "_qty("].concat(),
        "EG2-4: the ITEM-escrow guard is non-optional — it closes the \
         double-spend-shaped gap where an item pledged in an open trade offer is \
         consumed anyway (the same block `train` carries).",
    );
    assert_body_has(
        &body,
        label,
        &["cached_", "items("].concat(),
        "ItemRow carries no essence columns; the essence fields exist only on the \
         compile-time content registry (ADR-0175 D5).",
    );

    let decide = ["evaluate_consume", "_crystalized("].concat();
    let consume = ["consume", "_one("].concat();
    assert_body_has_exactly_one(&body, label, &decide, "one decision, one place.");
    assert_body_has_exactly_one(
        &body,
        label,
        &consume,
        "a second consume would burn a second item per call.",
    );

    let decide_at = body
        .find(decide.as_str())
        .expect("EG2-10: the decision seam call must exist in the body");
    let consume_at = body
        .find(consume.as_str())
        .expect("EG2-10: consume_one must exist in the body");
    assert!(
        decide_at < consume_at,
        "TEETH (EG2-4/EG2-10, decision-before-consume): the decision seam is at \
         collapsed byte {decide_at} but `consume_one` is at {consume_at} — the \
         DECISION MUST COME FIRST. Consuming before deciding burns the player's \
         item on a wrong-item or on-cooldown call, which is precisely the \
         behaviour EG2-10 forbids."
    );
}

/// EG2-8 / EG2-12 + ADR-0175 D3: `consume_crystalized_essence` is the SIXTH
/// accrue/auto-evolve call site, and `check_and_evolve` is LAST.
///
/// The spec's "exactly five" completeness argument omits EG2-4, which mutates
/// essence — the one gate value a crystal feed changes. Without the tail, a
/// full-bar feed would not evolve until some unrelated later action, contradicting
/// EG2-1's "evolves automatically the instant it becomes eligible" and EG3-8's
/// one-shot-unlock intent. Recorded as a spec correction in ADR-0175 D3.
///
/// kills: an implementation that follows the spec's literal five-site list and
///        leaves the crystal path un-evolved.
#[test]
fn consume_body_tails() {
    let body = eg2_scan_body(&consume_decl());
    let label = "the `consume_crystalized_essence` reducer body";
    let accrue = ["accrue_quality", "_time("].concat();
    let evolve = ["check_and", "_evolve("].concat();

    assert_body_has_exactly_one(
        &body,
        label,
        &accrue,
        "ADR-0175 D3 makes this the sixth Quality-Time call site.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &evolve,
        "ADR-0175 D3: a full-bar crystal feed must be able to evolve immediately.",
    );

    let accrue_at = body.find(accrue.as_str()).expect("accrue call must exist");
    let evolve_at = body.find(evolve.as_str()).expect("evolve call must exist");
    assert!(
        accrue_at < evolve_at,
        "TEETH (EG2-12): `check_and_evolve` must be the LAST step — it is at \
         collapsed byte {evolve_at} but `accrue_quality_time` is at {accrue_at}. \
         Quality Time is itself one of the five evolution gates, so evolving \
         before crediting it evaluates a stale gate set and misses an evolution \
         that this very call made eligible."
    );
}

/// EG2-5: `care` writes the Trust-favorable counter and carries both tails.
///
/// kills: the D2 half-implementation that remaps AtMaxBond but never adds the
///        Trust write (the whole point of the remap — Trust would still never
///        grow); a raw `+= 1` on a u32 counter (overflow-panics inside a reducer
///        in a debug build); a `care` that mutates a gate value and then skips
///        `check_and_evolve`, leaving the monster un-evolved until an unrelated
///        later action.
#[test]
fn care_body_has_trust_increment_and_tails() {
    let body = eg2_scan_body(&care_decl());
    let label = "the `care` reducer body";

    assert_body_has(
        &body,
        label,
        &["trust_favorable", "_count"].concat(),
        "EG2-5 makes `care` the Trust-favorable writer, REPLACING the frozen \
         bond write's role.",
    );
    assert_body_has(
        &body,
        label,
        &[".saturating", "_add(1"].concat(),
        "the counter is a u32 lifetime total — a raw `+= 1` panics on overflow \
         inside the reducer transaction.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &["accrue_quality", "_time("].concat(),
        "EG2-8 lists `care` as a Quality-Time call site; two calls would \
         double-credit.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &["check_and", "_evolve("].concat(),
        "EG2-12 lists `care` as an auto-evolution call site.",
    );
}

/// EG2-6: `train` gains ONLY the two tails — its EV logic is untouched.
///
/// kills: a tail-adding edit that also disturbs the EV path (the fence asserts
///        the `evaluate_train` decision and the single `consume_one` spend are
///        both still exactly where EG2-6's "MECHANICALLY UNCHANGED" requires);
///        a `train` that credits Quality Time but never checks evolution.
#[test]
fn train_body_has_tails() {
    let body = eg2_scan_body(&train_decl());
    let label = "the `train` reducer body";

    assert_body_has_exactly_one(
        &body,
        label,
        &["accrue_quality", "_time("].concat(),
        "EG2-8 lists `train` as a Quality-Time call site.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &["check_and", "_evolve("].concat(),
        "EG2-12 lists `train` as an auto-evolution call site.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &["evaluate", "_train("].concat(),
        "EG2-6: the EV path stays MECHANICALLY UNCHANGED — one decision seam.",
    );
    assert_body_has_exactly_one(
        &body,
        label,
        &["consume", "_one("].concat(),
        "EG2-6: exactly one food is spent per train, as today.",
    );
}

/// EG2-12 (fresh-find tail discipline): in EVERY raising call site, the caller's
/// own dual-write comes first, THEN `accrue_quality_time`, THEN
/// `check_and_evolve` last.
///
/// Why the order is load-bearing: both tails re-FIND the monster row rather than
/// taking the caller's stale local copy. If a tail ran before the caller's own
/// `update`, it would read pre-mutation state and then the caller's write would
/// clobber whatever the tail wrote — silently discarding the Quality-Time credit,
/// or worse, un-doing an evolution that had just been applied.
///
/// kills: a tail hoisted above the dual-write (lost credit / clobbered
///        evolution); `check_and_evolve` called before `accrue_quality_time`
///        (evaluates a stale Quality-Time gate and misses the evolution this very
///        call unlocked).
#[test]
fn tails_ordering() {
    let update = ["monster_pub().monster_id()", ".update("].concat();
    let accrue = ["accrue_quality", "_time("].concat();
    let evolve = ["check_and", "_evolve("].concat();

    for decl in [care_decl(), train_decl(), essence_train_decl(), consume_decl()] {
        let body = eg2_scan_body(&decl);

        let last_update = body.rfind(update.as_str()).unwrap_or_else(|| {
            panic!(
                "TEETH (EG2-12): no `monster_pub` dual-write found in {decl:?}'s \
                 body — every one of these reducers mutates the monster and must \
                 dual-write its public projection before the tails run"
            )
        });
        let accrue_at = body.find(accrue.as_str()).unwrap_or_else(|| {
            panic!("TEETH (EG2-8): `accrue_quality_time` missing from {decl:?}'s body")
        });
        let evolve_at = body.find(evolve.as_str()).unwrap_or_else(|| {
            panic!("TEETH (EG2-12): `check_and_evolve` missing from {decl:?}'s body")
        });

        assert!(
            last_update < accrue_at,
            "TEETH (EG2-12, fresh-find): in {decl:?}'s body the LAST monster_pub \
             dual-write is at collapsed byte {last_update} but \
             `accrue_quality_time` is at {accrue_at} — the tails must come AFTER \
             the caller's own write, or the caller's update clobbers the tail's."
        );
        assert!(
            accrue_at < evolve_at,
            "TEETH (EG2-12): in {decl:?}'s body `check_and_evolve` (byte \
             {evolve_at}) must be the LAST step, after `accrue_quality_time` \
             (byte {accrue_at}) — Quality Time is one of the five evolution \
             gates, so evolving first evaluates a stale gate set."
        );
    }
}

/// EG2-8 / ADR-0175 D1+D3: the `accrue_quality_time` shell delegates to the pure
/// seam, re-projects the public row only on a TIER CHANGE, and NEVER fabricates
/// a tier.
///
/// kills: (a) an inline re-implementation of the accrual rule in the ctx shell,
///        where none of this file's ten unit tests can see it — the delegation
///        needle is what keeps those tests load-bearing; (b) an unconditional
///        `monster_pub` write on the movement hot path (public-row churn for
///        every party monster on every tile step); (c) a missing `monster_pub`
///        row papered over with `unwrap_or(0)` — a fabricated tier of 0 would
///        publish a WRONG public projection (ADR-0174 D7/A3's fail-loud rule,
///        which every other write site in this file already follows).
#[test]
fn accrue_quality_time_body_never_fabricates_tier() {
    let body = eg2_scan_body(&accrue_decl());
    let label = "the `accrue_quality_time` body";

    assert_body_has(
        &body,
        label,
        &["apply_quality_time", "_credit("].concat(),
        "the ms-level rule must live in the PURE seam (the one this file's ten \
         accrual tests exercise); an inline copy in the shell is untested by \
         construction.",
    );
    assert_body_has(
        &body,
        label,
        &["pub_from", "_monster("].concat(),
        "the public projection is derived, never hand-assembled.",
    );

    let ne = ["quality_time_tier", "!="].concat();
    let eq = ["quality_time_tier", "=="].concat();
    assert!(
        body.contains(ne.as_str()) || body.contains(eq.as_str()),
        "TEETH (ADR-0175 D1/D3): `accrue_quality_time` must COMPARE the freshly \
         projected `quality_time_tier` against the existing public row and write \
         `monster_pub` only when it actually changed. Neither \
         `quality_time_tier!=` nor `quality_time_tier==` appears in the collapsed \
         body, so no comparison is being made — the write is either unconditional \
         (public-row churn on the movement hot path for every party monster on \
         every step) or absent (the tier never becomes visible to the client)."
    );

    let fabricate = ["unwrap", "_or(0"].concat();
    let n = body.matches(fabricate.as_str()).count();
    assert_eq!(
        n, 0,
        "TEETH (ADR-0174 D7/A3): `accrue_quality_time`'s body contains {n} \
         `unwrap_or(0…)` default(s) and must contain ZERO. A missing `monster_pub` \
         row is a fail-loud (log and return, write nothing) condition — defaulting \
         a tier to 0 publishes a projection the private row does not support, and \
         is exactly the fabrication ADR-0174 forbids at every other write site in \
         this file."
    );
}

/// EG2-5 (reject-never-burns, ADR-0059 §3 carried into the D2 remap): `care`'s
/// decision seam runs BEFORE every mutation in the body, and its `Result` is
/// never swallowed.
///
/// kills: (a) `let _ = evaluate_care(..)` — the shape the D2 remap invites, since
///        "AtMaxBond is no longer an error" reads a step away from "the seam's
///        error no longer matters"; it would make `care` unrejectable, cooldown
///        and all; (b) a body that bumps `trust_favorable_count` or stamps
///        `last_care_at_ms` above the decision, which puts the growth write on
///        the same side of the seam as the reject and breaks the house ordering
///        the reducer-security gate reads.
#[test]
fn care_reject_still_never_burns() {
    let body = eg2_scan_body(&care_decl());
    let label = "the `care` reducer body";
    let decide = ["evaluate", "_care("].concat();

    assert_body_has_exactly_one(
        &body,
        label,
        &decide,
        "one decision, one place — a second call could be reached with different \
         arguments after the first has already been checked.",
    );
    let swallowed = ["let_=evaluate", "_care("].concat();
    assert!(
        !body.contains(swallowed.as_str()),
        "TEETH (EG2-5, reject-never-burns): `care` must PROPAGATE the decision \
         seam's Result (`evaluate_care(..)?`), never discard it with \
         `let _ = ..`. Discarding it makes every reject — cooldown included — \
         silently succeed."
    );

    let decide_at = body
        .find(decide.as_str())
        .expect("the decision seam call must exist in `care`'s body");

    for (what, needle) in [
        ("the cooldown stamp", ["last_care_at", "_ms="].concat()),
        ("the Trust credit", ["trust_favorable", "_count"].concat()),
        ("the first row write", [".update", "("].concat()),
    ] {
        let at = body.find(needle.as_str()).unwrap_or_else(|| {
            panic!("FENCE PRECONDITION: {what} (`{needle}`) not found in `care`'s body")
        });
        assert!(
            decide_at < at,
            "TEETH (EG2-5, ADR-0059 §3 reject-never-burns): {what} is at collapsed \
             byte {at} but the `evaluate_care` decision is at {decide_at} — the \
             DECISION MUST COME FIRST. Hoisting a growth write above the seam puts \
             it on the reject side of the gate."
        );
    }
}
