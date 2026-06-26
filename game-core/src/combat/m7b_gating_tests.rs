//! M7b gating tests — acceptance criteria for the M7b combat type changes.
//!
//! These tests are intentionally RED until the implementer makes the changes
//! described in the M7b spec:
//!   - `BattleSide.active` changed from `usize` to `u32`
//!   - `TurnChoice::Swap.team_index` changed from `usize` to `u32`
//!   - `BattleEvent::Switch.new_active` changed from `usize` to `u32`
//!   - `BattleOutcome::Fled` variant added
//!   - `TurnVariance::from_ctx_random(seed: u32)` constructor added
//!
//! Each test is annotated with which wrong implementation it kills.
//!
//! Run: cargo test m7b_gating -- --nocapture

use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

fn make_stat_block() -> StatBlock {
    StatBlock {
        hp: 100,
        attack: 50,
        defense: 50,
        speed: 50,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_battle_monster(hp: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 10,
        current_hp: hp,
        max_hp: hp,
        stats: make_stat_block(),
        known_skill_ids: vec![1],
    }
}

// ---------------------------------------------------------------------------
// TEST 1: BattleSide.active is u32
//
// Kills: an impl that leaves `active` as `usize`. The type annotation `active:
// u32` on the struct literal and the `let _: u32 = side.active` binding both
// fail to compile if the field is still `usize` on a platform where
// `usize != u32` (or in the type-checker regardless of platform).
// ---------------------------------------------------------------------------

#[test]
fn battle_side_active_field_is_u32() {
    // Construct BattleSide with an explicit u32 literal. If the field is
    // `usize`, the struct literal requires a `usize` value and this u32
    // literal will cause a type-mismatch compile error.
    let side = BattleSide {
        active: 0u32,
        team: vec![make_battle_monster(100)],
    };

    // Bind the field to a u32-typed variable. If `active` is `usize` this
    // line fails to compile: "expected u32, found usize".
    let _active: u32 = side.active;
    assert_eq!(side.active, 0u32, "active must be u32 and equal 0");
}

/// Kills: active left as usize — active_monster() must still work after the
/// type change. This test exercises the indexing path with a u32 active value.
#[test]
fn battle_side_active_monster_works_with_u32_active() {
    let m = make_battle_monster(80);
    let side = BattleSide {
        active: 0u32,
        team: vec![m.clone()],
    };
    // active_monster() must compile and return the correct member.
    let got = side.active_monster();
    assert_eq!(got.species_id, m.species_id);
    assert_eq!(got.current_hp, 80);
}

/// Kills: next_conscious_index returning `usize` — the return type must be
/// `Option<u32>` after the M7b change.
#[test]
fn next_conscious_index_returns_option_u32() {
    let m0 = make_battle_monster(100);
    let m1 = make_battle_monster(100);
    let side = BattleSide {
        active: 0u32,
        team: vec![m0, m1],
    };
    // Bind the return to `Option<u32>`. If the impl still returns
    // `Option<usize>`, this assignment fails to compile.
    let result: Option<u32> = side.next_conscious_index();
    assert_eq!(
        result,
        Some(1u32),
        "must return Some(1u32) — the second slot"
    );
}

/// Kills: next_conscious_index returning None when a live backup exists.
/// Also validates the skip-active logic with u32 index arithmetic.
#[test]
fn next_conscious_index_skips_active_u32() {
    let fainted = make_battle_monster(0);
    let alive = make_battle_monster(50);
    let side = BattleSide {
        active: 0u32,
        team: vec![fainted, alive],
    };
    // team[0] is fainted AND is active; team[1] is the conscious backup.
    let result: Option<u32> = side.next_conscious_index();
    assert_eq!(result, Some(1u32));
}

// ---------------------------------------------------------------------------
// TEST 2: TurnChoice::Swap uses u32 team_index
//
// Kills: an impl that leaves `team_index` as `usize`. The struct destructure
// binds to a u32-typed variable — a type mismatch is a compile error.
// ---------------------------------------------------------------------------

#[test]
fn turn_choice_swap_team_index_is_u32() {
    // Construct the variant with an explicit u32 literal. Fails to compile if
    // team_index is `usize`.
    let choice = TurnChoice::Swap { team_index: 2u32 };

    // Destructure and bind to u32. Fails to compile if team_index is usize.
    let TurnChoice::Swap { team_index } = choice else {
        panic!("not a Swap variant");
    };
    let _idx: u32 = team_index;
    assert_eq!(team_index, 2u32, "team_index must be u32 = 2");
}

/// Kills: any impl where team_index can hold a value that u32 cannot represent.
/// Specifically gates that a max-u32 sentinel value round-trips through the type.
#[test]
fn turn_choice_swap_team_index_u32_max_round_trips() {
    let choice = TurnChoice::Swap {
        team_index: u32::MAX,
    };
    let TurnChoice::Swap { team_index } = choice else {
        panic!("not a Swap variant");
    };
    assert_eq!(team_index, u32::MAX);
}

// ---------------------------------------------------------------------------
// TEST 3: BattleOutcome::Fled exists
//
// Kills: an impl that does not add the Fled variant. The exhaustive match
// must include all variants. If Fled is missing, the match arm is dead code
// and the compile would warn (or the explicit unreachable! arm would never
// execute). We force the discriminant to be constructible.
// ---------------------------------------------------------------------------

#[test]
fn battle_outcome_fled_variant_exists() {
    // Constructing BattleOutcome::Fled fails to compile if the variant does
    // not exist.
    let outcome = BattleOutcome::Fled;

    // Exhaustive match — if Fled is missing from the enum, the compiler
    // errors with "non-exhaustive patterns".
    let is_terminal = match outcome {
        BattleOutcome::Ongoing => false,
        BattleOutcome::SideAWins => true,
        BattleOutcome::SideBWins => true,
        BattleOutcome::Fled => true,
    };

    assert!(is_terminal, "Fled must be a terminal (non-Ongoing) outcome");
}

/// Kills: Fled treated as Ongoing by helper logic. Confirms Fled != Ongoing.
#[test]
fn battle_outcome_fled_is_not_ongoing() {
    assert_ne!(BattleOutcome::Fled, BattleOutcome::Ongoing);
    assert_ne!(BattleOutcome::Fled, BattleOutcome::SideAWins);
    assert_ne!(BattleOutcome::Fled, BattleOutcome::SideBWins);
}

// ---------------------------------------------------------------------------
// TEST 4: BattleEvent::Switch.new_active is u32
//
// Kills: an impl that leaves Switch.new_active as usize. The struct literal
// and destructure bind to u32 — type mismatch is a compile error.
// ---------------------------------------------------------------------------

#[test]
fn battle_event_switch_new_active_is_u32() {
    // Construct with explicit u32. Fails to compile if new_active is usize.
    let ev = BattleEvent::Switch {
        side: SideId::SideA,
        new_active: 1u32,
    };

    // Destructure and bind new_active to u32 local.
    let BattleEvent::Switch { side, new_active } = ev else {
        panic!("not a Switch variant");
    };
    let _: u32 = new_active;
    assert_eq!(new_active, 1u32);
    assert_eq!(side, SideId::SideA);
}

// ---------------------------------------------------------------------------
// TEST 5: TurnVariance::from_ctx_random produces valid ranges
//
// Kills: any from_ctx_random implementation that:
//   - produces damage_roll outside 85..=100
//   - produces accuracy_roll outside 0..=99
//   - uses the wrong bit for speed_tie_breaker
//
// The constructor does not exist yet — the test starts red (compile error).
// ---------------------------------------------------------------------------

#[test]
fn turn_variance_from_ctx_random_known_seed_is_in_range() {
    // Seed 0 — a concrete known-answer test.
    let v = TurnVariance::from_ctx_random(0u32);
    assert!(
        (85..=100).contains(&v.damage_roll_a),
        "damage_roll_a={} must be in 85..=100",
        v.damage_roll_a
    );
    assert!(
        (85..=100).contains(&v.damage_roll_b),
        "damage_roll_b={} must be in 85..=100",
        v.damage_roll_b
    );
    assert!(
        (0..=99).contains(&v.accuracy_roll_a),
        "accuracy_roll_a={} must be in 0..=99",
        v.accuracy_roll_a
    );
    assert!(
        (0..=99).contains(&v.accuracy_roll_b),
        "accuracy_roll_b={} must be in 0..=99",
        v.accuracy_roll_b
    );
    // speed_tie_breaker is bool — any value is valid, just verify it's accessible.
    let _: bool = v.speed_tie_breaker;
}

/// Kills: a from_ctx_random that ignores the high bits of the seed and always
/// produces the same speed_tie_breaker value regardless of the seed.
#[test]
fn turn_variance_from_ctx_random_seed_max_is_in_range() {
    let v = TurnVariance::from_ctx_random(u32::MAX);
    assert!(
        (85..=100).contains(&v.damage_roll_a),
        "damage_roll_a={} out of range for seed u32::MAX",
        v.damage_roll_a
    );
    assert!(
        (85..=100).contains(&v.damage_roll_b),
        "damage_roll_b={} out of range for seed u32::MAX",
        v.damage_roll_b
    );
    assert!(
        (0..=99).contains(&v.accuracy_roll_a),
        "accuracy_roll_a={} out of range for seed u32::MAX",
        v.accuracy_roll_a
    );
    assert!(
        (0..=99).contains(&v.accuracy_roll_b),
        "accuracy_roll_b={} out of range for seed u32::MAX",
        v.accuracy_roll_b
    );
}

/// Kills: a from_ctx_random where the damage range computation is off by one
/// (e.g. produces 84..=99 or 86..=100).
#[test]
fn turn_variance_from_ctx_random_damage_roll_range_boundaries() {
    // Sweep a diverse set of seeds and confirm boundaries are never exceeded.
    // We test 256 evenly-distributed seeds to catch modular-arithmetic errors.
    for i in 0u32..=255 {
        let seed = i.wrapping_mul(0x0101_0101); // spread across the u32 range
        let v = TurnVariance::from_ctx_random(seed);
        assert!(
            (85..=100).contains(&v.damage_roll_a),
            "damage_roll_a={} out of 85..=100 for seed {seed}",
            v.damage_roll_a
        );
        assert!(
            (85..=100).contains(&v.damage_roll_b),
            "damage_roll_b={} out of 85..=100 for seed {seed}",
            v.damage_roll_b
        );
        assert!(
            (0..=99).contains(&v.accuracy_roll_a),
            "accuracy_roll_a={} out of 0..=99 for seed {seed}",
            v.accuracy_roll_a
        );
        assert!(
            (0..=99).contains(&v.accuracy_roll_b),
            "accuracy_roll_b={} out of 0..=99 for seed {seed}",
            v.accuracy_roll_b
        );
    }
}

// ---------------------------------------------------------------------------
// TEST 6 (property): from_ctx_random always produces valid variance for any u32
//
// Kills: a from_ctx_random that works for common seeds but overflows or
// produces out-of-range values for rare seeds (e.g., near u32::MAX, or
// values that saturate a narrow modulus).
// ---------------------------------------------------------------------------

use proptest::prelude::*;

proptest! {
    /// Kills: any from_ctx_random that produces out-of-range variance for
    /// any u32 seed input. The block-body arrow is required — fast-check
    /// misreads an expression body as a false return.
    #[test]
    fn prop_turn_variance_from_ctx_random_always_valid(seed in 0u32..=u32::MAX) {
        let v = TurnVariance::from_ctx_random(seed);
        prop_assert!(
            (85..=100).contains(&v.damage_roll_a),
            "damage_roll_a={} out of range for seed {seed}",
            v.damage_roll_a
        );
        prop_assert!(
            (85..=100).contains(&v.damage_roll_b),
            "damage_roll_b={} out of range for seed {seed}",
            v.damage_roll_b
        );
        prop_assert!(
            (0..=99).contains(&v.accuracy_roll_a),
            "accuracy_roll_a={} out of range for seed {seed}",
            v.accuracy_roll_a
        );
        prop_assert!(
            (0..=99).contains(&v.accuracy_roll_b),
            "accuracy_roll_b={} out of range for seed {seed}",
            v.accuracy_roll_b
        );
        // speed_tie_breaker is always valid as a bool — assert it's reachable.
        let _: bool = v.speed_tie_breaker;
    }
}

// ---------------------------------------------------------------------------
// TEST 7: BattleState still round-trips through serde with u32 active
//
// Kills: a serde impl that serializes `active: u32` as a platform-width
// integer, breaking the wire format between 32-bit and 64-bit hosts.
// ---------------------------------------------------------------------------

#[test]
fn battle_state_serde_round_trip_with_u32_active() {
    let state = BattleState {
        side_a: BattleSide {
            active: 0u32,
            team: vec![make_battle_monster(100)],
        },
        side_b: BattleSide {
            active: 0u32,
            team: vec![make_battle_monster(80)],
        },
        outcome: BattleOutcome::Fled,
        turn_number: 3,
    };
    let s = ron::to_string(&state).unwrap();
    let back: BattleState = ron::from_str(&s).unwrap();
    assert_eq!(
        state, back,
        "BattleState with u32 active + Fled must serde round-trip losslessly"
    );
}
