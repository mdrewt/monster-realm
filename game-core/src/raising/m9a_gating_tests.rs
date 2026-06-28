//! M9a gating tests — proof-of-teeth for the raising rules, authored from the
//! M9 spec §3 EARS criteria (ADR-0058 §"Proof-of-teeth"). Populated by the tester.
//!
//! EARS criteria covered:
//!   Criterion A — focus_train (EV top-off → re-derive; reject precedence)
//!   Criterion B — apply_care (saturating bond raise; reject precedence)
//!
//! Each test carries a `/// kills:` comment naming which wrong implementation it
//! catches, so the verifier can match failing assertion → eliminated bug class.
//!
//! Red state: every test will PANIC on the `todo!()` stubs in `rules.rs`
//! (for `focus_train` and `apply_care`).
//!
//! Run: cargo test m9a_gating -- --nocapture

use crate::monster::rules::derive_stats;
use crate::monster::types::{Bond, EVs, IVs, Level, Nature, NatureKind, StatBlock, StatKind};
use crate::raising::{apply_care, focus_train, CareError, FocusTrainError};

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/// Bulbasaur-like base stats, the canonical test fixture across raising tests.
fn base_bulba() -> StatBlock {
    StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    }
}

/// IVs all set to 15 — the canonical mid-point fixture.
fn ivs_all_15() -> IVs {
    IVs::new(15, 15, 15, 15, 15, 15).unwrap()
}

fn lv50() -> Level {
    Level::new(50).unwrap()
}

fn adamant() -> Nature {
    Nature::new(NatureKind::Adamant)
}

fn hardy() -> Nature {
    Nature::new(NatureKind::Hardy)
}

// ---------------------------------------------------------------------------
// CRITERION A — focus_train (example-based)
// ---------------------------------------------------------------------------

// Test 1
/// Top-off exact-to-cap, not off-by-one.
/// kills: an impl that adds `amount` unconditionally (252+5=257), or one that
/// grants 0 instead of clamping to the per-stat headroom.
#[test]
fn focus_train_topoff_exact_to_per_stat_cap() {
    // EVs: attack=251, total=251 — lots of budget headroom, only 1 per-stat gap.
    let evs = EVs::new(0, 251, 0, 0, 0, 0).unwrap();
    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        5, // ask for 5, only 1 fits
    )
    .expect("should succeed: stat has 1 EV gap");

    // Grant clamped to min(5, 252-251, 510-251) = min(5, 1, 259) = 1.
    assert_eq!(
        result.evs.get(StatKind::Attack),
        252,
        "attack EV must be exactly 252 (not 256 or 251)"
    );
}

// Test 2
/// Per-stat headroom limits grant when it is tighter than budget headroom.
/// kills: an impl that uses only total-budget headroom (ignoring per-stat cap).
#[test]
fn focus_train_per_stat_headroom_limits_grant() {
    // EVs: attack=250, total=250 — per-stat gap = 2, budget gap = 260.
    let evs = EVs::new(0, 250, 0, 0, 0, 0).unwrap();
    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        10, // ask for 10, only 2 fit per-stat
    )
    .expect("should succeed: stat has 2 EV gap");

    // Grant = min(10, 252-250, 510-250) = min(10, 2, 260) = 2.
    assert_eq!(
        result.evs.get(StatKind::Attack),
        252,
        "attack EV must be exactly 252"
    );
}

// Test 3
/// Budget headroom is the binding constraint, not per-stat headroom.
/// kills: a per-stat-only impl that computes grant=100 → new EVs total 609 → invalid.
/// This fixture is THE critical one: a per-stat-only impl would produce invalid EVs.
#[test]
fn focus_train_budget_headroom_limits_grant() {
    // EVs: hp=100, attack=252, defense=157, total=509.
    // Per-stat gap for Hp = 252-100 = 152. Budget gap = 510-509 = 1.
    // Therefore grant = min(100, 152, 1) = 1.
    let evs = EVs::new(100, 252, 157, 0, 0, 0).unwrap();
    assert_eq!(evs.total(), 509, "fixture sanity: total must be 509");

    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Hp,
        100,
    )
    .expect("should succeed: budget has 1 gap");

    assert_eq!(
        result.evs.get(StatKind::Hp),
        101,
        "Hp EV must be exactly 101 (budget was the binding constraint, grant=1)"
    );
    assert_eq!(
        result.evs.total(),
        510,
        "total EVs must be exactly 510 after grant"
    );
}

// Test 4
/// Budget near-cap with gap of 2: expect regression for `.expect()` callers.
/// kills: an impl that panics on near-full budgets, or one that grants 0 when 2 fit.
#[test]
fn focus_train_near_cap_budget_gap_two() {
    // EVs: attack=252, defense=252, speed=4, total=508; Hp gap = 252, budget gap = 2.
    let evs = EVs::new(0, 252, 252, 4, 0, 0).unwrap();
    assert_eq!(evs.total(), 508, "fixture sanity: total must be 508");

    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Hp,
        2,
    )
    .expect("should succeed: budget has 2 gap");

    assert_eq!(result.evs.total(), 510, "total must reach exactly 510");
    assert_eq!(
        result.evs.get(StatKind::Hp),
        2,
        "Hp EV must be exactly 2 (grant=min(2,252,2)=2)"
    );
}

// Test 5
/// Non-target EVs are all left unchanged by focus_train.
/// kills: an impl that accidentally zeroes or recalculates sibling EVs.
#[test]
fn focus_train_nontarget_evs_unchanged() {
    // EVs: hp=10, attack=20, defense=30, speed=40, sp_attack=50, sp_defense=60 — total=210.
    let evs = EVs::new(10, 20, 30, 40, 50, 60).unwrap();
    assert_eq!(evs.total(), 210, "fixture sanity: total must be 210");

    // Train Attack by 5 (grant=min(5,252-20,510-210)=5).
    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        5,
    )
    .expect("should succeed");

    assert_eq!(result.evs.get(StatKind::Attack), 25, "attack EV must be 25");
    assert_eq!(
        result.evs.get(StatKind::Hp),
        10,
        "hp EV must be unchanged at 10"
    );
    assert_eq!(
        result.evs.get(StatKind::Defense),
        30,
        "defense EV must be unchanged at 30"
    );
    assert_eq!(
        result.evs.get(StatKind::Speed),
        40,
        "speed EV must be unchanged at 40"
    );
    assert_eq!(
        result.evs.get(StatKind::SpAttack),
        50,
        "sp_attack EV must be unchanged at 50"
    );
    assert_eq!(
        result.evs.get(StatKind::SpDefense),
        60,
        "sp_defense EV must be unchanged at 60"
    );
}

// Test 6
/// StatAtCap is returned when the target stat is already at 252.
/// kills: an impl that returns BudgetExhausted or Ok when per-stat cap is hit.
#[test]
fn focus_train_rejects_stat_at_cap() {
    // EVs: attack=252, total=252 — attack already maxed.
    let evs = EVs::new(0, 252, 0, 0, 0, 0).unwrap();

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        1,
    )
    .expect_err("should fail: attack EV is at cap");

    assert_eq!(
        err,
        FocusTrainError::StatAtCap,
        "must be StatAtCap, not BudgetExhausted or NoEffect"
    );
}

// Test 7
/// BudgetExhausted is returned when total is 510 but target stat is below 252.
/// kills: an impl that returns StatAtCap when per-stat has headroom but budget is full.
#[test]
fn focus_train_rejects_budget_exhausted() {
    // EVs: attack=252, defense=252, speed=6, total=510; Hp=0 (below per-stat cap).
    let evs = EVs::new(0, 252, 252, 6, 0, 0).unwrap();
    assert_eq!(evs.total(), 510, "fixture sanity: total must be 510");
    assert!(
        evs.get(StatKind::Hp) < 252,
        "fixture sanity: Hp has per-stat headroom"
    );

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Hp,
        1,
    )
    .expect_err("should fail: budget is at 510");

    assert_eq!(
        err,
        FocusTrainError::BudgetExhausted,
        "must be BudgetExhausted (not StatAtCap — Hp has per-stat headroom)"
    );
}

// Test 8
/// NoEffect is returned when amount is 0, even with valid EVs.
/// kills: an impl that returns Ok for amount=0 (grant=0 → no-op writes).
#[test]
fn focus_train_rejects_no_effect_amount_zero() {
    let evs = EVs::new(0, 100, 0, 0, 0, 0).unwrap();

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        0,
    )
    .expect_err("should fail: amount is 0");

    assert_eq!(
        err,
        FocusTrainError::NoEffect,
        "must be NoEffect for amount=0"
    );
}

// Test 9
/// Precedence: amount=0 wins over StatAtCap (NoEffect is checked FIRST).
/// kills: an impl that checks StatAtCap before NoEffect, returning StatAtCap for amount=0.
#[test]
fn focus_train_noeffect_precedes_stat_at_cap() {
    // Attack is at cap (252) AND amount is 0 — NoEffect must win.
    let evs = EVs::new(0, 252, 0, 0, 0, 0).unwrap();

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack,
        0, // amount=0 — NoEffect guard fires first per ADR-0058 §2
    )
    .expect_err("should fail");

    assert_eq!(
        err,
        FocusTrainError::NoEffect,
        "amount=0 must produce NoEffect even when stat is also at cap (NoEffect checked first)"
    );
}

// ---------------------------------------------------------------------------
// CRITERION A — focus_train SSOT (re-derive oracle tests)
// ---------------------------------------------------------------------------

// Test 10
/// Nature-raised target exact value: derive_stats is the SSOT oracle.
/// Adamant raises Attack (×1.1). Training Attack from EV=0 to EV=4 crosses the EV/4
/// boundary (4/4=1 vs 0/4=0), so derived Attack must increase.
/// kills: an impl that forks the stat formula instead of delegating to derive_stats,
/// or one that forgets to apply the nature modifier to the newly trained stat.
///
/// Hand-computed oracle (base_bulba, ivs_all_15, adamant, lv50):
///   Attack with EV=0: (((2*49 + 15 + 0) * 50 / 100) + 5) * 11/10
///     = ((113 * 50 / 100) + 5) * 11/10
///     = (56 + 5) * 11/10 = 61 * 11/10 = 671/10 = 67
///   Attack with EV=4: (((2*49 + 15 + 1) * 50 / 100) + 5) * 11/10
///     = ((114 * 50 / 100) + 5) * 11/10
///     = (57 + 5) * 11/10 = 62 * 11/10 = 682/10 = 68
/// So 68 > 67 (non-vacuous).
#[test]
fn focus_train_ssot_nature_raised_target_exact_value() {
    let base = base_bulba();
    let ivs = ivs_all_15();
    let nature = adamant();
    let level = lv50();

    let pre_evs = EVs::zero();
    let pre_attack = derive_stats(&base, &ivs, &pre_evs, &nature, level).get(StatKind::Attack);

    let result = focus_train(
        &base,
        &ivs,
        &pre_evs,
        &nature,
        level,
        StatKind::Attack,
        4, // EV/4 boundary: 4/4=1, crossing from 0/4=0
    )
    .expect("should succeed: Attack has full headroom");

    assert_eq!(
        result.evs.get(StatKind::Attack),
        4,
        "attack EV must be exactly 4 after training"
    );

    // Oracle: derive_stats with the new EVs is the SSOT.
    let expected_evs = EVs::new(0, 4, 0, 0, 0, 0).unwrap();
    let expected_stats = derive_stats(&base, &ivs, &expected_evs, &nature, level);

    assert_eq!(
        result.derived_stats, expected_stats,
        "derived_stats must equal derive_stats(&base, &ivs, &new_evs, &nature, level)"
    );

    // Non-vacuity: training must have increased the Attack value.
    assert!(
        result.derived_stats.get(StatKind::Attack) > pre_attack,
        "training must increase derived Attack: pre={pre_attack}, post={}",
        result.derived_stats.get(StatKind::Attack)
    );

    // Exact oracle value from hand computation.
    assert_eq!(
        result.derived_stats.get(StatKind::Attack),
        68,
        "Attack with EV=4, adamant, lv50, base_bulba, ivs_all_15 must be exactly 68"
    );
}

// Test 11
/// HP target with nature ignored: HP stat is nature-independent.
/// Nature (Adamant) must not affect derived HP — a neutral and Adamant nature
/// must yield identical HP from the same HP EVs.
/// kills: an impl that mistakenly applies the nature multiplier to HP.
///
/// Hand-computed oracle (base_bulba, ivs_all_15, adamant, lv50, hp_ev=4):
///   HP = ((2*45 + 15 + 4/4) * 50 / 100) + 50 + 10
///      = ((90 + 15 + 1) * 50 / 100) + 60
///      = (106 * 50 / 100) + 60
///      = 53 + 60 = 113
#[test]
fn focus_train_ssot_hp_nature_independent() {
    let base = base_bulba();
    let ivs = ivs_all_15();
    let level = lv50();
    let pre_evs = EVs::zero();

    // Train HP by 4 using Adamant nature.
    let result_adamant = focus_train(&base, &ivs, &pre_evs, &adamant(), level, StatKind::Hp, 4)
        .expect("should succeed: Hp has full headroom");

    // Oracle: derive_stats with new EVs is SSOT.
    let new_evs = EVs::new(4, 0, 0, 0, 0, 0).unwrap();
    let oracle_adamant = derive_stats(&base, &ivs, &new_evs, &adamant(), level);
    let oracle_hardy = derive_stats(&base, &ivs, &new_evs, &hardy(), level);

    assert_eq!(
        result_adamant.derived_stats, oracle_adamant,
        "derived_stats must equal derive_stats with Adamant nature"
    );

    // HP is nature-independent: both natures must give the same HP.
    assert_eq!(
        oracle_adamant.get(StatKind::Hp),
        oracle_hardy.get(StatKind::Hp),
        "HP must be identical for Adamant and Hardy nature (HP ignores nature)"
    );

    // Exact oracle value from hand computation.
    assert_eq!(
        result_adamant.derived_stats.get(StatKind::Hp),
        113,
        "HP with EV=4, lv50, base_bulba, ivs_all_15 must be exactly 113 (nature-independent)"
    );
}

// Test 12
/// HP training never lowers derived HP (monotonic safety for deferral chains).
/// kills: an impl where the re-derive path accidentally decreases HP when training
/// (e.g., wrong EV field written, nature modifier misapplied to HP).
#[test]
fn focus_train_hp_monotonic_on_train() {
    let base = base_bulba();
    let ivs = ivs_all_15();
    let level = lv50();
    let old_evs = EVs::new(10, 0, 0, 0, 0, 0).unwrap();
    let nature = adamant();

    let pre_hp = derive_stats(&base, &ivs, &old_evs, &nature, level).get(StatKind::Hp);

    let result = focus_train(&base, &ivs, &old_evs, &nature, level, StatKind::Hp, 40)
        .expect("should succeed: Hp has headroom");

    assert!(
        result.derived_stats.get(StatKind::Hp) >= pre_hp,
        "training Hp must never lower derived HP: before={pre_hp}, after={}",
        result.derived_stats.get(StatKind::Hp)
    );
}

// ---------------------------------------------------------------------------
// CRITERION B — apply_care (example-based)
// ---------------------------------------------------------------------------

// Test 13
/// Saturating addition: never wraps past 255.
/// kills: an impl that uses wrapping_add (254+2=0, 200+MAX=wraps).
#[test]
fn apply_care_saturates_not_wraps() {
    // 254 + 2 would overflow to 0 with wrapping; saturation gives 255.
    let r1 = apply_care(Bond::new(254), 2).expect("should succeed: bond < 255");
    assert_eq!(
        r1.value(),
        255,
        "254 + 2 must saturate to 255, not wrap to 0"
    );

    // 200 + u8::MAX would overflow with wrapping; saturation gives 255.
    let r2 = apply_care(Bond::new(200), u8::MAX).expect("should succeed: bond < 255");
    assert_eq!(r2.value(), 255, "200 + 255 must saturate to 255, not wrap");

    // 254 + 1 = exactly 255 (no saturation needed, but is the max).
    let r3 = apply_care(Bond::new(254), 1).expect("should succeed: bond < 255");
    assert_eq!(r3.value(), 255, "254 + 1 must equal exactly 255");
}

// Test 14
/// Normal bond raise (no saturation, no rejection).
/// kills: an impl with an off-by-one or wrong addition.
#[test]
fn apply_care_normal_raise() {
    let result = apply_care(Bond::new(70), 5).expect("should succeed: bond is 70, not at max");
    assert_eq!(result.value(), 75, "70 + 5 must equal 75");
}

// Test 15
/// AtMaxBond is returned when bond is already at 255.
/// kills: an impl that returns Ok (letting bond saturate from an already-max bond),
/// or one that returns NoEffect.
#[test]
fn apply_care_rejects_at_max_bond() {
    let err = apply_care(Bond::new(255), 5).expect_err("should fail: bond already at max");

    assert_eq!(
        err,
        CareError::AtMaxBond,
        "must be AtMaxBond (not NoEffect)"
    );
}

// Test 16
/// NoEffect is returned when amount is 0.
/// kills: an impl that returns Ok(bond) unchanged for amount=0.
#[test]
fn apply_care_rejects_no_effect_amount_zero() {
    let err = apply_care(Bond::new(50), 0).expect_err("should fail: amount is 0");

    assert_eq!(err, CareError::NoEffect, "amount=0 must produce NoEffect");
}

// Test 17
/// Precedence: amount=0 wins over AtMaxBond (NoEffect is checked FIRST).
/// kills: an impl that checks AtMaxBond before NoEffect, returning AtMaxBond for amount=0.
#[test]
fn apply_care_noeffect_precedes_at_max_bond() {
    // Bond is at max (255) AND amount is 0 — NoEffect must win.
    let err = apply_care(Bond::new(255), 0).expect_err("should fail");

    assert_eq!(
        err,
        CareError::NoEffect,
        "amount=0 must produce NoEffect even when bond is also at max (NoEffect checked first)"
    );
}

// Test 25 — red-team M9a finding #1
/// Guard-order precedence: StatAtCap PRECEDES BudgetExhausted when BOTH hold simultaneously.
/// Fixture: attack=252 (per-stat cap hit), total=510 (budget exhausted), amount=1.
/// Guard order from ADR-0058 §2: (1) NoEffect → (2) StatAtCap → (3) BudgetExhausted.
/// The simultaneous-double-cap state (cur==252 AND total==510) is the ONLY state where
/// swapping guards 2 and 3 produces a different observable result.
/// kills: an impl that checks total==510 (BudgetExhausted) BEFORE cur==252 (StatAtCap),
/// returning BudgetExhausted where StatAtCap is required.
#[test]
fn focus_train_stat_at_cap_precedes_budget_exhausted() {
    // attack=252, defense=252, speed=6 → total=510, attack is at per-stat cap.
    let evs = EVs::new(0, 252, 252, 6, 0, 0).unwrap();
    assert_eq!(evs.total(), 510, "fixture sanity: total must be 510");
    assert_eq!(
        evs.get(StatKind::Attack),
        252,
        "fixture sanity: Attack must be at per-stat cap"
    );

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs,
        &hardy(),
        lv50(),
        StatKind::Attack, // target is AT per-stat cap; total is ALSO at budget cap
        1,
    )
    .expect_err("should fail: Attack is at cap");

    assert_eq!(
        err,
        FocusTrainError::StatAtCap,
        "cur==252 AND total==510 AND amount>0 must produce StatAtCap (second guard), \
         NOT BudgetExhausted (third guard) — ADR-0058 §2 guard order is load-bearing"
    );
}

// Test 26 — red-team M9a finding #2
/// Single-SSOT cap self-test: `focus_train`'s StatAtCap boundary and `EVs::new`'s
/// per-stat cap are now ONE shared constant imported from `monster::types`
/// (ADR-0058 residual (b) resolved — no longer two separate consts that could
/// drift). This test guards that the shared cap value (252) is consistently
/// enforced at both sites: training from cur=251 must succeed (StatAtCap not yet
/// hit), and training from the resulting cur=252 must return StatAtCap (boundary
/// reached). A wrong shared-cap value (e.g. 251) would cause the first call to
/// return StatAtCap prematurely; a wrong value (e.g. 253) would cause the second
/// call to return Ok and then panic when EVs::new rejects new_val=253.
/// kills: any impl where focus_train's cap boundary disagrees with EVs::new's
/// per-stat cap — i.e. the single shared constant is used inconsistently.
#[test]
fn focus_train_cap_const_agrees_with_evs_constructor() {
    // Confirm the cap boundary: training from cur=251 (one below cap) must succeed.
    let evs_near_cap = EVs::new(0, 251, 0, 0, 0, 0).unwrap();
    let result = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs_near_cap,
        &hardy(),
        lv50(),
        StatKind::Attack,
        1, // exactly fills the last slot
    )
    .expect("cur=251 with amount=1 must succeed: exactly one EV gap remains");

    assert_eq!(
        result.evs.get(StatKind::Attack),
        252,
        "attack EV must be exactly 252 after filling the last slot"
    );

    // Now confirm that training from cur=252 (exactly at cap) returns StatAtCap.
    let evs_at_cap = result.evs;
    assert_eq!(
        evs_at_cap.get(StatKind::Attack),
        252,
        "sanity: attack is now at cap"
    );

    let err = focus_train(
        &base_bulba(),
        &ivs_all_15(),
        &evs_at_cap,
        &hardy(),
        lv50(),
        StatKind::Attack,
        1,
    )
    .expect_err("cur=252 must be rejected: stat is at cap");

    assert_eq!(
        err,
        FocusTrainError::StatAtCap,
        "training a stat already at 252 must return StatAtCap — \
         const drift between rules.rs EV_PER_STAT_CAP and monster/types.rs would break this"
    );
}

// Test 27
/// EVs field mapping for ALL six StatKind variants — deterministic regression.
/// Iterates every target stat from a fixed start (EVs 10/20/30/40/50/60, total=210)
/// and asserts: (a) the target EV increases by exactly the grant (5), and (b) every
/// OTHER stat's EV is bitwise-identical to its start value.
///
/// kills: a field-swap bug in the internal `evs_with(target, new_val)` helper for
/// ANY specific stat — e.g. Defense and Speed fields transposed would be caught here
/// but NOT by proptest alone (no pinned seed → no guarantee that exact swap is hit).
/// Test 5 (`focus_train_nontarget_evs_unchanged`) covers Attack only; this test
/// closes the gap for Defense, Speed, SpAttack, and SpDefense.
#[test]
fn focus_train_all_stat_targets_field_mapping() {
    // Starting EVs: hp=10 atk=20 def=30 spd=40 spa=50 spd2=60  total=210.
    // Grant for each target = min(5, 252-start, 510-210) = min(5, ≥192, 300) = 5.
    let start_evs = EVs::new(10, 20, 30, 40, 50, 60).unwrap();
    assert_eq!(start_evs.total(), 210, "fixture sanity: total must be 210");

    let all_stats = [
        StatKind::Hp,
        StatKind::Attack,
        StatKind::Defense,
        StatKind::Speed,
        StatKind::SpAttack,
        StatKind::SpDefense,
    ];

    // Original value for each stat, in the same order as all_stats.
    let start_vals = [10u16, 20, 30, 40, 50, 60];

    for (i, &target) in all_stats.iter().enumerate() {
        let result = focus_train(
            &base_bulba(),
            &ivs_all_15(),
            &start_evs,
            &hardy(),
            lv50(),
            target,
            5,
        )
        .unwrap_or_else(|e| {
            panic!(
                "focus_train with target={:?} should succeed (budget+per-stat headroom), got {:?}",
                target, e
            )
        });

        // (a) The target EV increased by exactly 5.
        let expected_target_ev = start_vals[i] + 5;
        assert_eq!(
            result.evs.get(target),
            expected_target_ev,
            "target={:?}: EV must be {} (was {}+5), field mapping wrong",
            target,
            expected_target_ev,
            start_vals[i]
        );

        // (b) Every OTHER stat's EV is unchanged.
        for (j, &other) in all_stats.iter().enumerate() {
            if j == i {
                continue;
            }
            assert_eq!(
                result.evs.get(other),
                start_vals[j],
                "target={:?}: sibling {:?} EV must be unchanged at {} but got {} — \
                 field-swap in evs_with?",
                target,
                other,
                start_vals[j],
                result.evs.get(other)
            );
        }
    }
}

// ---------------------------------------------------------------------------
// CRITERION A+B — Determinism
// ---------------------------------------------------------------------------

// Test 18
/// Same inputs → same outputs for both focus_train and apply_care.
/// kills: any impl that reads global mutable state, the system clock, or thread-local RNG.
#[test]
fn rules_are_deterministic() {
    let base = base_bulba();
    let ivs = ivs_all_15();
    let evs = EVs::new(0, 50, 0, 0, 0, 0).unwrap();
    let nature = hardy();
    let level = lv50();

    let r1 = focus_train(&base, &ivs, &evs, &nature, level, StatKind::Attack, 10);
    let r2 = focus_train(&base, &ivs, &evs, &nature, level, StatKind::Attack, 10);
    assert_eq!(r1, r2, "focus_train must be deterministic");

    let c1 = apply_care(Bond::new(100), 15);
    let c2 = apply_care(Bond::new(100), 15);
    assert_eq!(c1, c2, "apply_care must be deterministic");
}

// ---------------------------------------------------------------------------
// CRITERION A — Property-based (focus_train) — mirrors monster/rules.rs strategies
// ---------------------------------------------------------------------------

/// Strategy for valid IVs (each in [0, 31]).
fn arb_ivs() -> impl Strategy<Value = IVs> {
    (0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31)
        .prop_map(|(hp, atk, def, spd, spa, spd2)| IVs::new(hp, atk, def, spd, spa, spd2).unwrap())
}

/// Strategy for valid EVs (each ≤ 252, total ≤ 510).
fn arb_evs() -> impl Strategy<Value = EVs> {
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

/// Strategy for Nature (one of 25 kinds).
fn arb_nature() -> impl Strategy<Value = Nature> {
    (0u8..25).prop_map(Nature::from_index)
}

/// Strategy for Level ([1, 100]).
fn arb_level() -> impl Strategy<Value = Level> {
    (1u8..=100).prop_map(|v| Level::new(v).unwrap())
}

/// Strategy for realistic base stats ([1, 255] per stat).
fn arb_base_stats() -> impl Strategy<Value = StatBlock> {
    (
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
        1u16..=255,
    )
        .prop_map(|(hp, atk, def, spd, spa, spd2)| StatBlock {
            hp,
            attack: atk,
            defense: def,
            speed: spd,
            sp_attack: spa,
            sp_defense: spd2,
        })
}

/// Strategy for any StatKind (all six variants).
fn arb_statkind() -> impl Strategy<Value = StatKind> {
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
    // Test 19
    /// focus_train never panics for any combination of valid inputs and arbitrary amount.
    /// kills: an impl that panics on any EV arithmetic path (e.g., overflow in grant
    /// computation, or an unwrap() on EVs::new with a total that would be >510).
    #[test]
    fn focus_train_never_panics(
        base in arb_base_stats(),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        target in arb_statkind(),
        amount in 0u16..=u16::MAX,
    ) {
        // Must not panic — result (Ok or Err) is irrelevant here.
        let _ = focus_train(&base, &ivs, &evs, &nature, level, target, amount);
    }

    // Test 20
    /// On Ok, both the per-stat cap (252) and total cap (510) are never exceeded.
    /// kills: an impl that only applies one cap (per-stat but not total, or vice versa).
    #[test]
    fn focus_train_ok_caps_never_exceeded(
        base in arb_base_stats(),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        target in arb_statkind(),
        amount in 1u16..=u16::MAX,
    ) {
        if let Ok(result) = focus_train(&base, &ivs, &evs, &nature, level, target, amount) {
            prop_assert!(
                result.evs.get(target) <= 252,
                "per-stat cap violated: target EV = {}",
                result.evs.get(target)
            );
            prop_assert!(
                result.evs.total() <= 510,
                "total cap violated: total EVs = {}",
                result.evs.total()
            );
        }
    }

    // Test 21
    /// On Ok, every EV is non-decreasing — training never reduces any EV.
    /// kills: an impl that accidentally zeroes sibling EVs or re-derives them.
    #[test]
    fn focus_train_ok_evs_monotone_nondecreasing(
        base in arb_base_stats(),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        target in arb_statkind(),
        amount in 1u16..=u16::MAX,
    ) {
        let all_stats = [
            StatKind::Hp,
            StatKind::Attack,
            StatKind::Defense,
            StatKind::Speed,
            StatKind::SpAttack,
            StatKind::SpDefense,
        ];
        if let Ok(result) = focus_train(&base, &ivs, &evs, &nature, level, target, amount) {
            for k in all_stats {
                prop_assert!(
                    result.evs.get(k) >= evs.get(k),
                    "EV for {:?} decreased: before={}, after={}",
                    k,
                    evs.get(k),
                    result.evs.get(k)
                );
            }
        }
    }

    // Test 22
    /// SSOT property: on Ok, grant is >= 1 AND derived_stats == derive_stats(new_evs).
    /// kills: an impl that returns Ok with grant=0, or one that duplicates the stat
    /// formula instead of calling derive_stats (any formula divergence is caught here).
    #[test]
    fn focus_train_ok_ssot_and_positive_grant(
        base in arb_base_stats(),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        target in arb_statkind(),
        amount in 1u16..=u16::MAX,
    ) {
        if let Ok(result) = focus_train(&base, &ivs, &evs, &nature, level, target, amount) {
            // Grant was >= 1 (otherwise it would have returned Err).
            prop_assert!(
                result.evs.get(target) > evs.get(target),
                "Ok result must have a positive grant (target EV did not increase)"
            );
            // SSOT: derived_stats == derive_stats with the resulting EVs.
            let expected = derive_stats(&base, &ivs, &result.evs, &nature, level);
            prop_assert_eq!(
                result.derived_stats,
                expected,
                "derived_stats must equal derive_stats(&base, &ivs, &result.evs, &nature, level)"
            );
        }
    }

    // Test 23
    /// Branch classification: the exact error variant matches the guard order from ADR-0058 §2.
    /// Guard order (load-bearing): NoEffect (amount==0) FIRST; StatAtCap SECOND; BudgetExhausted THIRD.
    /// kills: any impl that checks caps before the amount guard, or swaps StatAtCap and BudgetExhausted.
    #[test]
    fn focus_train_branch_classification(
        base in arb_base_stats(),
        ivs in arb_ivs(),
        evs in arb_evs(),
        nature in arb_nature(),
        level in arb_level(),
        target in arb_statkind(),
        amount in 0u16..=u16::MAX,
    ) {
        let result = focus_train(&base, &ivs, &evs, &nature, level, target, amount);
        if amount == 0 {
            // First guard: NoEffect regardless of cap state.
            prop_assert_eq!(
                result,
                Err(FocusTrainError::NoEffect),
                "amount==0 must produce NoEffect (first guard)"
            );
        } else if evs.get(target) == 252 {
            // Second guard: StatAtCap (only when amount > 0).
            prop_assert_eq!(
                result,
                Err(FocusTrainError::StatAtCap),
                "target EV==252, amount>0 must produce StatAtCap (second guard)"
            );
        } else if evs.total() == 510 {
            // Third guard: BudgetExhausted (only when target < 252 and amount > 0).
            prop_assert_eq!(
                result,
                Err(FocusTrainError::BudgetExhausted),
                "total==510, target<252, amount>0 must produce BudgetExhausted (third guard)"
            );
        } else {
            // Otherwise: Ok (there is both per-stat and budget headroom, and amount > 0).
            prop_assert!(
                result.is_ok(),
                "headroom exists and amount>0, expected Ok but got {:?}",
                result
            );
        }
    }
}

// ---------------------------------------------------------------------------
// CRITERION B — Property-based (apply_care)
// ---------------------------------------------------------------------------

proptest! {
    // Test 24
    /// apply_care property: guard order + saturating value on Ok.
    /// Guard order: NoEffect (amount==0) FIRST; AtMaxBond (bond==255) SECOND; else Ok.
    /// On Ok, value == min(255, bond as u16 + amount as u16) computed via u16 to avoid wrap.
    /// kills: an impl with wrong guard order, wrapping addition, or wrong Ok value.
    #[test]
    fn apply_care_branch_and_value(
        bond_val in 0u8..=255,
        amount in 0u8..=255,
    ) {
        let bond = Bond::new(bond_val);
        let result = apply_care(bond, amount);

        if amount == 0 {
            // First guard: NoEffect regardless of bond state.
            prop_assert_eq!(
                result,
                Err(CareError::NoEffect),
                "amount==0 must produce NoEffect (first guard)"
            );
        } else if bond_val == 255 {
            // Second guard: AtMaxBond (only when amount > 0).
            prop_assert_eq!(
                result,
                Err(CareError::AtMaxBond),
                "bond==255, amount>0 must produce AtMaxBond (second guard)"
            );
        } else {
            // Else: Ok with saturating value.
            // Use u16 arithmetic to compute the expected saturated value without
            // wrapping in the test itself.
            let expected_val = ((bond_val as u16) + (amount as u16)).min(255) as u8;
            let ok_bond = result.expect("expected Ok but got Err");
            prop_assert_eq!(
                ok_bond.value(),
                expected_val,
                "bond must be min(255, bond+amount) = {}",
                expected_val
            );
        }
    }
}
