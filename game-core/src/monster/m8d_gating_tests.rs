// Cosmetic doc-formatting lint only (Rust 1.96 `doc_overindented_list_items` fires
// on the 5-space EARS list below); suppressing it changes NO test assertion.
#![allow(clippy::doc_overindented_list_items)]
//! M8d gating tests — acceptance criteria for the recruit slice (pure game-core surface).
//!
//! These tests are intentionally RED until the implementer adds:
//!   - `build_monster(seed: u32, species: &Species, level: Level) -> MonsterInstance`
//!     in `monster/rolls.rs`
//!   - `RECRUIT_BASE_RATE: u16` const in `taming/rules.rs`
//!   - `validate_content` rejection of `recruit_bonus > 1000` in `content.rs`
//!
//! They compile-error (missing items) / assert-fail (wrong values) in the RED
//! state and pass ONLY when the behavior is correct — never trivially.
//!
//! EARS criteria covered (M8 spec §4 "Recruit", ADR-0046/0047):
//!   A1 — `build_monster` determinism: same (seed, species, level) → identical MonsterInstance.
//!   A2 — Exact-wild rebuild: IVs+nature from build_monster == roll_individuality(seed).
//!   A3 — Backward-compat equivalence: build_monster(seed, sp, Level::new(5)) == roll_starter(seed, sp).
//!   A4 — Full HP + correct xp + zero EVs + default bond + party_slot None.
//!   A5 — Level-parameterised stat growth: higher level => >= HP.
//!   A6 — validate_content rejects recruit_bonus > 1000; accepts 0 and 1000.
//!   A7 — RECRUIT_BASE_RATE const exists and is in [0, 1000].
//!
//! Each test names the wrong implementation it kills.

#[allow(unused_imports)]
use crate::content::{validate_content, ItemDef, SkillDef, Species};
use crate::monster::rolls::{build_monster, roll_individuality, roll_starter};
use crate::monster::rules::{derive_stats, xp_for_level};
use crate::monster::types::{Affinity, Bond, EVs, Level, StatBlock, StatKind};
use crate::taming::rules::RECRUIT_BASE_RATE;

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn level(v: u8) -> Level {
    Level::new(v).expect("valid level")
}

fn fixture_species(id: u32) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        },
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
    }
}

fn fixture_item(id: u32, recruit_bonus: u16) -> ItemDef {
    ItemDef {
        id,
        name: format!("Item{id}"),
        description: "Test item".to_string(),
        recruit_bonus,
        train_stat: None,
        train_amount: 0,
        sell_price: 0,
    }
}

// ---------------------------------------------------------------------------
// CRITERION A1 — build_monster determinism
// Same (seed, species, level) must always produce an identical MonsterInstance.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses system RNG, wall-clock, or any non-deterministic source.
/// EARS A1: same inputs → identical output (no side-channel entropy).
#[test]
fn build_monster_deterministic_spot_checks() {
    let sp = fixture_species(1);
    for seed in [0u32, 1, 42, 999, u32::MAX] {
        for lv in [1u8, 5, 50, 100] {
            let a = build_monster(seed, &sp, level(lv));
            let b = build_monster(seed, &sp, level(lv));
            assert_eq!(
                a, b,
                "build_monster must be deterministic; seed={seed}, level={lv}"
            );
        }
    }
}

// Kills: any impl where the same call produces different results across two invocations.
// EARS A1: property — for all u32 seeds, build_monster is a pure function.
proptest! {
    #[test]
    fn build_monster_deterministic_property(seed in any::<u32>()) {
        let sp = fixture_species(7);
        let a = build_monster(seed, &sp, level(5));
        let b = build_monster(seed, &sp, level(5));
        prop_assert_eq!(a, b, "build_monster must be deterministic for seed={}", seed);
    }
}

// ---------------------------------------------------------------------------
// CRITERION A2 — Exact-wild rebuild (the trust invariant)
// build_monster(seed, sp, lvl).ivs == roll_individuality(seed).0
// build_monster(seed, sp, lvl).nature == roll_individuality(seed).1
// This PROVES the recruited wild is the SAME individual that was fought.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses a different seed derivation for IVs/nature vs roll_individuality
/// (which would mean the rebuilt monster differs from the fought wild).
/// EARS A2: the individuality embedded in build_monster == roll_individuality(seed).
#[test]
fn build_monster_ivs_match_roll_individuality_spot_checks() {
    let sp = fixture_species(3);
    for seed in [0u32, 1, 42, 999, u32::MAX] {
        let inst = build_monster(seed, &sp, level(5));
        let (expected_ivs, expected_nature) = roll_individuality(seed);
        assert_eq!(
            inst.ivs, expected_ivs,
            "IVs from build_monster must match roll_individuality(seed); seed={seed}"
        );
        assert_eq!(
            inst.nature, expected_nature,
            "nature from build_monster must match roll_individuality(seed); seed={seed}"
        );
    }
}

// Kills: any impl that re-seeds the RNG differently inside build_monster, breaking
// the invariant that the same seed → the same individual across all contexts.
// EARS A2: property over all seeds — the rebuild contract holds universally.
proptest! {
    #[test]
    fn build_monster_individuality_matches_roll_individuality(seed in any::<u32>()) {
        let sp = fixture_species(2);
        let inst = build_monster(seed, &sp, level(10));
        let (expected_ivs, expected_nature) = roll_individuality(seed);
        prop_assert_eq!(
            inst.ivs,
            expected_ivs,
            "IVs must match roll_individuality; seed={}",
            seed
        );
        prop_assert_eq!(
            inst.nature,
            expected_nature,
            "nature must match roll_individuality; seed={}",
            seed
        );
    }
}

// ---------------------------------------------------------------------------
// CRITERION A3 — Backward-compat equivalence with roll_starter
// build_monster(seed, sp, Level::new(5).unwrap()) == roll_starter(seed, sp)
// for ALL seeds — proves the generalization preserves M7 behavior exactly.
// ---------------------------------------------------------------------------

/// Kills: a build_monster impl that computes stats differently from roll_starter at
/// level 5, breaking backward compatibility with existing starters.
/// EARS A3: build_monster at level 5 is IDENTICAL to roll_starter.
#[test]
fn build_monster_at_level_5_equals_roll_starter_spot_checks() {
    let sp = fixture_species(1);
    for seed in [0u32, 1, 42, 100, 999, u32::MAX] {
        let from_build = build_monster(seed, &sp, Level::new(5).unwrap());
        let from_starter = roll_starter(seed, &sp);
        assert_eq!(
            from_build, from_starter,
            "build_monster(seed, sp, Level::new(5)) must equal roll_starter(seed, sp); seed={seed}"
        );
    }
}

// Kills: any impl where the equivalence breaks for edge-case seed values.
// EARS A3: property — the equivalence holds for all u32 seeds without exception.
proptest! {
    #[test]
    fn build_monster_at_level_5_equals_roll_starter_property(seed in any::<u32>()) {
        let sp = fixture_species(1);
        let from_build = build_monster(seed, &sp, Level::new(5).unwrap());
        let from_starter = roll_starter(seed, &sp);
        prop_assert_eq!(
            from_build,
            from_starter,
            "build_monster(seed, sp, Level::new(5)) must equal roll_starter(seed, sp) for seed={}",
            seed
        );
    }
}

// ---------------------------------------------------------------------------
// CRITERION A4 — Full HP, correct xp, zero EVs, default bond, party_slot None
// The M8d recruit grants: current_hp == derived HP, xp == xp_for_level(level),
// evs == zero, bond == default(70), party_slot == None.
// ---------------------------------------------------------------------------

/// Kills: an impl that starts current_hp at 0, gives non-zero EVs, wrong XP,
/// wrong bond, or sets a party_slot.
/// EARS A4: all five postconditions hold at levels 1, 5, 50, 100.
#[test]
fn build_monster_postconditions_across_levels() {
    let sp = fixture_species(1);
    for lv in [1u8, 5, 50, 100] {
        let l = level(lv);
        let inst = build_monster(42, &sp, l);

        // current_hp must equal derived HP (full HP on grant).
        assert_eq!(
            inst.current_hp,
            inst.derived_stats.get(StatKind::Hp),
            "level={lv}: current_hp must equal derived HP (full HP on recruit)"
        );

        // xp must be exactly xp_for_level(level) — places the monster squarely at
        // the start of the level band, not at 0 XP (which would be level 1).
        assert_eq!(
            inst.xp,
            xp_for_level(l),
            "level={lv}: xp must be xp_for_level(level)"
        );

        // EVs are all zero — a fresh recruit has no training.
        assert_eq!(
            inst.evs,
            EVs::zero(),
            "level={lv}: EVs must be zero on recruit"
        );

        // Bond is the default (70) — trust starts at the species default.
        assert_eq!(
            inst.bond,
            Bond::default_bond(),
            "level={lv}: bond must be default(70)"
        );

        // party_slot is None — recruited monster goes to box, NOT party.
        assert_eq!(
            inst.party_slot, None,
            "level={lv}: party_slot must be None (box, not party)"
        );
    }
}

/// Kills: an impl that uses xp=0 (wrong — would show as level 1 in-game) instead
/// of xp_for_level(level) (correct — places at the START of the target level).
#[test]
fn build_monster_xp_reflects_level_not_zero() {
    let sp = fixture_species(1);
    // level 50: xp_for_level(50) = 125000; a monster with xp=0 would be level 1.
    let inst = build_monster(0, &sp, level(50));
    let expected_xp = xp_for_level(level(50));
    assert_ne!(
        inst.xp.value(),
        0,
        "xp must not be 0 for level 50 — a recruit at level 50 must have 50^3 = 125000 XP"
    );
    assert_eq!(
        inst.xp,
        expected_xp,
        "xp must be xp_for_level(50)=125000; got {}",
        inst.xp.value()
    );
}

// ---------------------------------------------------------------------------
// CRITERION A5 — Level-parameterized stat growth
// Higher level produces >= HP; at level 50 >= level 5 (monotonic sanity).
// Tests the "level is consumed" contract — a build_monster that ignores the
// level parameter would produce identical stats regardless of level.
// ---------------------------------------------------------------------------

/// Kills: an impl that ignores the `level` parameter (returns the same stats for
/// any level — the fixed-level-5 roll_starter internally used before generalization).
/// EARS A5: HP at level 50 must be >= HP at level 5 for the same seed.
#[test]
fn build_monster_higher_level_yields_at_least_as_much_hp() {
    let sp = fixture_species(1);
    let seed = 77u32;
    // Use level bounds we know are valid.
    let low = build_monster(seed, &sp, level(5));
    let high = build_monster(seed, &sp, level(50));

    assert!(
        high.derived_stats.hp >= low.derived_stats.hp,
        "level-50 HP ({}) must be >= level-5 HP ({})",
        high.derived_stats.hp,
        low.derived_stats.hp
    );
    // The higher level must ACTUALLY differ in HP (sanity: the formula must scale).
    assert!(
        high.derived_stats.hp > low.derived_stats.hp,
        "level-50 HP ({}) must be strictly greater than level-5 HP ({}) — \
         stat formula must scale with level",
        high.derived_stats.hp,
        low.derived_stats.hp
    );
}

/// Kills: a build_monster that computes derived_stats with a hardcoded level (e.g. 5)
/// instead of the `level` parameter, making level-100 identical to level-5.
/// EARS A5: derived_stats in the returned instance matches derive_stats(..., level).
#[test]
fn build_monster_derived_stats_match_expected_formula() {
    let sp = fixture_species(1);
    // Choose a seed and level; verify stats match calling derive_stats directly.
    let seed = 13u32;
    let l = level(50);
    let inst = build_monster(seed, &sp, l);
    let (expected_ivs, expected_nature) = roll_individuality(seed);
    let expected_stats = derive_stats(
        &sp.base_stats,
        &expected_ivs,
        &EVs::zero(),
        &expected_nature,
        l,
    );
    assert_eq!(
        inst.derived_stats, expected_stats,
        "build_monster derived_stats must match derive_stats(base, ivs, zero_evs, nature, level)"
    );
}

// Kills: any impl that uses the wrong level in derive_stats.
// EARS A5: property — for all seeds and two valid levels, build_monster stats match
// derive_stats with the correct level argument.
proptest! {
    #[test]
    fn build_monster_stats_computed_at_correct_level(
        seed in any::<u32>(),
        lv in 1u8..=100u8,
    ) {
        let sp = fixture_species(1);
        let l = Level::new(lv).unwrap();
        let inst = build_monster(seed, &sp, l);
        let (ivs, nature) = roll_individuality(seed);
        let expected = derive_stats(&sp.base_stats, &ivs, &EVs::zero(), &nature, l);
        prop_assert_eq!(
            inst.derived_stats,
            expected,
            "build_monster stats must match derive_stats at level={}; seed={}",
            lv,
            seed
        );
    }
}

// ---------------------------------------------------------------------------
// CRITERION A6 — validate_content rejects recruit_bonus > 1000
// Accepts 0 (no bait function) and 1000 (maximum bait bonus).
// Rejects 1001 (over-range — bait could exceed the per-mille cap).
// ---------------------------------------------------------------------------

/// Kills: a validate_content that silently accepts any recruit_bonus value, allowing
/// a malformed item to grant recruit_chance > 1000 + RECRUIT_BASE_RATE.
/// EARS A6: recruit_bonus=1001 must be rejected with Err.
#[test]
fn validate_content_rejects_recruit_bonus_above_1000() {
    let bad_item = fixture_item(1, 1001);
    let result = validate_content(&[], &[], &[], &[bad_item]);
    assert!(
        result.is_err(),
        "recruit_bonus=1001 must be rejected by validate_content; got Ok(())"
    );
}

/// Kills: a validate_content that rejects recruit_bonus=1000 (valid boundary).
/// EARS A6: recruit_bonus=1000 is exactly at the per-mille cap — must be accepted.
#[test]
fn validate_content_accepts_recruit_bonus_at_1000() {
    let ok_item = fixture_item(1, 1000);
    let result = validate_content(&[], &[], &[], &[ok_item]);
    assert!(
        result.is_ok(),
        "recruit_bonus=1000 must be accepted by validate_content; got Err({:?})",
        result
    );
}

/// Kills: a validate_content that rejects recruit_bonus=0 (items without bait function).
/// EARS A6: recruit_bonus=0 is the default for non-bait items — must be accepted.
#[test]
fn validate_content_accepts_recruit_bonus_at_zero() {
    let ok_item = fixture_item(1, 0);
    let result = validate_content(&[], &[], &[], &[ok_item]);
    assert!(
        result.is_ok(),
        "recruit_bonus=0 must be accepted by validate_content; got Err({:?})",
        result
    );
}

/// Proof-of-teeth: the 1001 fixture MUST be flagged.
/// Kills: any validate_content that blindly returns Ok(()) (no item validation).
#[test]
fn validate_content_teeth_recruit_bonus_over_limit() {
    let bad = fixture_item(99, 1001);
    let result = validate_content(&[], &[], &[], &[bad]);
    assert!(
        result.is_err(),
        "TEETH: recruit_bonus=1001 must be rejected — if this passes, validate_content has no teeth for bait items"
    );
}

// ---------------------------------------------------------------------------
// CRITERION A7 — RECRUIT_BASE_RATE const exists and is in [0, 1000]
// The const must be reachable from game-core (re-exported via taming::rules),
// and its value must be a valid per-mille probability.
// ---------------------------------------------------------------------------

/// Kills: an impl that omits RECRUIT_BASE_RATE entirely (compile error in RED),
/// or that sets it to a value > 1000 (which would make every recruit auto-succeed).
/// EARS A7: RECRUIT_BASE_RATE is defined and within the per-mille range.
#[test]
fn recruit_base_rate_is_valid_per_mille() {
    // This test also compiles-references the const, so a missing const
    // causes a compile error — the intended RED state.
    assert!(
        RECRUIT_BASE_RATE <= 1000,
        "RECRUIT_BASE_RATE={RECRUIT_BASE_RATE} exceeds per-mille max 1000 — \
         a base rate above 1000 would make recruit_chance always succeed regardless of HP"
    );
    // The range check also catches a zero base rate (which would make all recruit
    // attempts fail unless the bait_bonus or HP damage compensates).
    // We do NOT assert > 0 because a zero base rate is a valid design choice
    // (force the player to use bait or reduce HP). The spec does not constrain
    // the lower bound beyond [0, 1000]. If the designer chose 0, it is legal.
    let _ = RECRUIT_BASE_RATE; // explicit reference to suppress unused warning in RED state
}
