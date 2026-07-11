//! M14a gating tests — acceptance criteria for the M14a status effect system.
//!
//! ALL tests start RED (compile error) because the following do not exist yet:
//!   - `game-core/src/combat/status.rs` (module, all types, all functions)
//!   - `StatusEffect`, `BattleStatusStore`, `StatusVariance` types
//!   - `apply_pre_turn_effects`, `apply_post_turn_effects`, `tick_status` functions
//!   - `resolve_full_turn` in `resolve.rs`
//!   - `TurnChoice::Pass` variant in `types.rs`
//!   - `BattleEvent::StatusDamage`, `ActionBlocked`, `StatusCured` variants
//!
//! Criterion → test mapping:
//!   EARS-1 (regression)        → m14a_plain_attack_unchanged_with_empty_status
//!   EARS-2 (exhaustive match)  → m14a_status_effect_match_is_exhaustive
//!   EARS-3 (poison amount)     → m14a_poison_deals_max_hp_over_8_damage
//!   EARS-4 (poison min)        → m14a_poison_deals_at_least_1_damage
//!   EARS-5 (burn amount)       → m14a_burn_deals_max_hp_over_16_damage
//!   EARS-6 (no status no DoT)  → m14a_no_status_no_dot_events
//!   EARS-7 (paralysis blocks)  → m14a_paralysis_blocks_action_when_roll_under_25
//!   EARS-8 (paralysis allows)  → m14a_paralysis_does_not_block_when_roll_25_or_above
//!   EARS-9 (sleep always)      → m14a_sleep_always_blocks_action
//!   EARS-10 (freeze always)    → m14a_freeze_always_blocks_action
//!   EARS-11 (sleep decrement)  → m14a_sleep_turns_decrement_each_tick
//!   EARS-12 (sleep cure)       → m14a_sleep_cures_when_turns_reach_zero
//!   EARS-13 (freeze thaws)     → m14a_freeze_thaws_when_roll_ge_80
//!   EARS-14 (freeze persists)  → m14a_freeze_persists_when_roll_lt_80
//!   EARS-15 (blocked no atk)   → m14a_paralysis_block_prevents_attack_in_resolve_full_turn
//!   EARS-16 (determinism)      → m14a_resolve_full_turn_is_deterministic
//!   EARS-17 (DoT KO)           → m14a_poison_dot_ko_triggers_faint_and_battle_end
//!   EARS-18 (independent)      → m14a_both_sides_can_have_independent_status

use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{
    apply_post_turn_effects, apply_pre_turn_effects, tick_status, BattleStatusStore, StatusEffect,
    StatusVariance,
};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

fn make_stat_block(attack: u16, defense: u16, speed: u16) -> StatBlock {
    StatBlock {
        hp: 100,
        attack,
        defense,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_monster(affinity: Affinity, hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity,
        level: 5,
        current_hp: hp,
        max_hp: hp,
        stats: make_stat_block(40, 40, speed),
        known_skill_ids: vec![1],
        status: None,
    }
}

fn make_battle_state(monster_a: BattleMonster, monster_b: BattleMonster) -> BattleState {
    BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![monster_a],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![monster_b],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    }
}

fn fire_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        applies_status: None,
    }
}

fn skills_vec() -> Vec<SkillDef> {
    vec![fire_skill()]
}

/// All rolls guarantee hits, no paralysis.
fn always_hit_variance(a_faster: bool) -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: a_faster,
    }
}

/// StatusVariance with all rolls set so no blocking occurs (no paralysis, no thaw).
fn no_block_status_variance() -> StatusVariance {
    StatusVariance {
        action_skip_roll_a: 99, // 99 >= 25: paralysis does NOT block
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0, // 0 < 80: freeze does NOT thaw
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0, // unused in wake logic per spec
        sleep_wake_roll_b: 0,
    }
}

/// Empty BattleStatusStore (all None) for a 1-vs-1 battle.
fn empty_status() -> BattleStatusStore {
    BattleStatusStore::new(1, 1)
}

// ---------------------------------------------------------------------------
// TEST 1 (EARS-1): M7 regression proof-of-teeth
//
// resolve_full_turn with empty status + no-paralysis variance must produce
// IDENTICAL events to resolve_turn called directly.
//
// Kills: an impl where the status layer emits extra events, corrupts damage,
// or alters event order even when all status slots are None.
// ---------------------------------------------------------------------------

/// Kills: a resolve_full_turn that emits extra events, changes damage amounts,
/// or reorders events compared to bare resolve_turn when status is empty.
#[test]
fn m14a_plain_attack_unchanged_with_empty_status() {
    use crate::combat::resolve::resolve_turn;

    let chart = make_type_chart();
    let variance = always_hit_variance(true);
    let sv = no_block_status_variance();

    // Identical initial states for both calls.
    let monster_a = make_monster(Affinity::Fire, 200, 80);
    let monster_b = make_monster(Affinity::Water, 200, 40);

    let mut state_direct = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut state_full = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut status = empty_status();

    // Call bare resolve_turn directly.
    let events_direct = resolve_turn(
        &mut state_direct,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
    );

    // Call resolve_full_turn with empty status (must produce identical events).
    let events_full = resolve_full_turn(
        &mut state_full,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    assert_eq!(
        events_full, events_direct,
        "TEETH: resolve_full_turn with empty status must produce identical events \
         to bare resolve_turn; a wrong impl emits extra ActionBlocked/StatusDamage events \
         or changes damage amounts — this assertion catches it"
    );
    assert_eq!(
        state_full, state_direct,
        "TEETH: resulting BattleState must be identical after resolve_full_turn vs \
         resolve_turn with empty status; a wrong impl mutates state differently"
    );
}

// ---------------------------------------------------------------------------
// TEST 2 (EARS-2): Exhaustive match proof-of-teeth (compile-time OCP gate)
//
// An exhaustive match over ALL StatusEffect variants with no wildcard arm.
// This test FAILS TO COMPILE if a new StatusEffect variant is added without
// updating this match — it does not need to run to enforce the contract.
//
// Kills: any impl that adds a StatusEffect variant without updating all
// match sites; the compiler will error here first.
// ---------------------------------------------------------------------------

/// Kills: adding a new StatusEffect variant without updating exhaustive matches.
/// This test fails to COMPILE if any variant is unhandled — a compile-time gate.
#[test]
fn m14a_status_effect_match_is_exhaustive() {
    // Construct one of each variant to ensure all are reachable.
    let effects: Vec<StatusEffect> = vec![
        StatusEffect::Poison,
        StatusEffect::Burn,
        StatusEffect::Paralysis,
        StatusEffect::Sleep { turns_remaining: 3 },
        StatusEffect::Freeze,
    ];

    for effect in &effects {
        // Exhaustive match — NO wildcard arm. Adding a new variant without
        // updating this match will cause a compile error: "non-exhaustive patterns".
        let label = match effect {
            StatusEffect::Poison => "Poison",
            StatusEffect::Burn => "Burn",
            StatusEffect::Paralysis => "Paralysis",
            StatusEffect::Sleep { .. } => "Sleep",
            StatusEffect::Freeze => "Freeze",
        };
        assert!(
            !label.is_empty(),
            "every variant must produce a non-empty label"
        );
    }
}

// ---------------------------------------------------------------------------
// TEST 3 (EARS-3): Poison DoT amount = max_hp / 8 (integer division)
//
// Monster with max_hp=100, Poison. apply_post_turn_effects → StatusDamage
// amount = 12 (100/8 = 12 via integer division), HP decreases by 12.
//
// Kills: an impl that uses /16 instead of /8, or uses floating-point rounding,
// or forgets to subtract from current_hp.
// ---------------------------------------------------------------------------

/// Kills: an impl using /16 instead of /8 for Poison (produces 6 not 12),
/// floating-point truncation, or failing to update current_hp.
#[test]
fn m14a_poison_deals_max_hp_over_8_damage() {
    let mut m = make_monster(Affinity::Fire, 100, 50);
    m.max_hp = 100;
    m.current_hp = 100;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![m],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    // Must emit StatusDamage for SideA with amount = 100/8 = 12.
    let damage_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { .. }))
        .collect();
    assert_eq!(
        damage_events.len(),
        1,
        "exactly one StatusDamage event must be emitted for Poison"
    );
    match &damage_events[0] {
        BattleEvent::StatusDamage { side, amount } => {
            assert_eq!(
                *side,
                SideId::SideA,
                "TEETH: StatusDamage must target SideA (the poisoned side)"
            );
            assert_eq!(
                *amount, 12,
                "TEETH: Poison DoT for max_hp=100 must be 12 (100/8); \
                 a /16 impl produces 6, floating-point rounding may differ"
            );
        }
        _ => panic!("expected StatusDamage event"),
    }

    assert_eq!(
        state.side_a.active_monster().current_hp,
        88,
        "TEETH: current_hp must decrease from 100 to 88 (100 - 12); \
         an impl that doesn't subtract fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 4 (EARS-4): Poison DoT minimum damage = 1
//
// Monster with max_hp=4, Poison. max(1, 4/8) = max(1, 0) = 1.
// apply_post_turn_effects → amount >= 1.
//
// Kills: an impl that uses straight integer division without max(1,…),
// emitting a StatusDamage of 0 for tiny max_hp values.
// ---------------------------------------------------------------------------

/// Kills: an impl that emits StatusDamage amount=0 when max_hp is tiny
/// (e.g. max_hp=4 → 4/8=0 without the max(1) floor).
#[test]
fn m14a_poison_deals_at_least_1_damage() {
    let mut m = make_monster(Affinity::Fire, 4, 50);
    m.max_hp = 4;
    m.current_hp = 4;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![m],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    let damage_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { .. }))
        .collect();
    assert!(
        !damage_events.is_empty(),
        "Poison must emit at least one StatusDamage event"
    );

    match &damage_events[0] {
        BattleEvent::StatusDamage { amount, .. } => {
            assert!(
                *amount >= 1,
                "TEETH: Poison DoT must be at least 1 even for max_hp=4 (4/8=0 without max(1,…)); \
                 an impl without the floor emits 0 and fails here"
            );
        }
        _ => panic!("expected StatusDamage event"),
    }
}

// ---------------------------------------------------------------------------
// TEST 5 (EARS-5): Burn DoT amount = max_hp / 16
//
// Monster with max_hp=160, Burn. apply_post_turn_effects → amount = 10 (160/16).
//
// Kills: an impl that uses /8 instead of /16 for Burn (produces 20 not 10),
// or confuses the Poison and Burn formulas.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses /8 for Burn instead of /16 (produces 20 vs 10),
/// or swaps Poison and Burn divisors.
#[test]
fn m14a_burn_deals_max_hp_over_16_damage() {
    let mut m = make_monster(Affinity::Fire, 160, 50);
    m.max_hp = 160;
    m.current_hp = 160;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![m],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Burn)],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    let damage_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { .. }))
        .collect();
    assert_eq!(
        damage_events.len(),
        1,
        "exactly one StatusDamage event for Burn"
    );
    match &damage_events[0] {
        BattleEvent::StatusDamage { side, amount } => {
            assert_eq!(
                *side,
                SideId::SideA,
                "StatusDamage must target the burning side (SideA)"
            );
            assert_eq!(
                *amount, 10,
                "TEETH: Burn DoT for max_hp=160 must be 10 (160/16); \
                 a /8 impl produces 20, a /16 impl on Poison produces 20 — both fail here"
            );
        }
        _ => panic!("expected StatusDamage event"),
    }
    assert_eq!(
        state.side_a.active_monster().current_hp,
        150,
        "current_hp must decrease from 160 to 150 after Burn DoT"
    );
}

// ---------------------------------------------------------------------------
// TEST 6 (EARS-6): No status = no DoT events
//
// Monster with None status. apply_post_turn_effects → empty events.
//
// Kills: an impl that emits spurious StatusDamage events for None status slots.
// ---------------------------------------------------------------------------

/// Kills: an impl that emits StatusDamage events even when status is None.
#[test]
fn m14a_no_status_no_dot_events() {
    let m = make_monster(Affinity::Fire, 100, 50);
    let mut state = make_battle_state(m, make_monster(Affinity::Water, 100, 40));
    state.turn_number = 1;

    let status = BattleStatusStore {
        side_a: vec![None],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    let dot_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { .. }))
        .collect();
    assert!(
        dot_events.is_empty(),
        "TEETH: None status must produce no StatusDamage events; \
         an impl that emits DoT for all slots fails here — got {dot_events:?}"
    );
    assert!(
        events.is_empty(),
        "TEETH: no status means NO events at all from apply_post_turn_effects; \
         got {events:?}"
    );
}

// ---------------------------------------------------------------------------
// TEST 7 (EARS-7): Paralysis blocks when roll < 25
//
// Side A active: Paralysis. StatusVariance.action_skip_roll_a = 24.
// apply_pre_turn_effects → a_can_act = false, ActionBlocked { side: SideA }.
//
// Kills: an impl that uses roll < 50 (wrong threshold), or roll <= 25 (off-by-one),
// or that doesn't emit ActionBlocked when blocking.
// ---------------------------------------------------------------------------

/// Kills: a threshold bug (e.g. < 50 instead of < 25) or missing ActionBlocked event.
#[test]
fn m14a_paralysis_blocks_action_when_roll_under_25() {
    let state = make_battle_state(
        make_monster(Affinity::Electric, 100, 50),
        make_monster(Affinity::Water, 100, 40),
    );

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Paralysis)],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 24, // 24 < 25 → BLOCKS
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let (a_can_act, b_can_act, events) = apply_pre_turn_effects(&status, &state, &variance);

    assert!(
        !a_can_act,
        "TEETH: Paralysis with roll=24 (< 25) must block SideA; \
         a >= 25 threshold instead of < 25 fails this (24 < 25 is true, block fires)"
    );
    assert!(b_can_act, "SideB has no status; must be able to act");

    let blocked_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::ActionBlocked { .. }))
        .collect();
    assert_eq!(
        blocked_events.len(),
        1,
        "exactly one ActionBlocked event must be emitted for the paralyzed side"
    );
    match &blocked_events[0] {
        BattleEvent::ActionBlocked { side } => {
            assert_eq!(
                *side,
                SideId::SideA,
                "ActionBlocked must target SideA (the paralyzed side)"
            );
        }
        _ => panic!("expected ActionBlocked event"),
    }
}

// ---------------------------------------------------------------------------
// TEST 8 (EARS-8): Paralysis does NOT block when roll >= 25
//
// action_skip_roll_a = 25 → a_can_act = true, NO ActionBlocked for SideA.
//
// Kills: an impl using roll <= 25 (off-by-one), which would still block at 25.
// ---------------------------------------------------------------------------

/// Kills: an impl using `roll <= 25` instead of `roll < 25` — blocks at 25 incorrectly.
#[test]
fn m14a_paralysis_does_not_block_when_roll_25_or_above() {
    let state = make_battle_state(
        make_monster(Affinity::Electric, 100, 50),
        make_monster(Affinity::Water, 100, 40),
    );

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Paralysis)],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 25, // boundary: 25 is NOT < 25 → must NOT block
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let (a_can_act, _b_can_act, events) = apply_pre_turn_effects(&status, &state, &variance);

    assert!(
        a_can_act,
        "TEETH: Paralysis with roll=25 (NOT < 25) must NOT block SideA; \
         an impl using `<= 25` incorrectly blocks at the boundary — this assertion catches it"
    );

    let blocked_for_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::ActionBlocked { side } if *side == SideId::SideA));
    assert!(
        !blocked_for_a,
        "TEETH: NO ActionBlocked for SideA when roll=25 with Paralysis threshold < 25; \
         an off-by-one impl emits ActionBlocked here and fails"
    );
}

// ---------------------------------------------------------------------------
// TEST 9 (EARS-9): Sleep ALWAYS blocks regardless of roll
//
// Side A: Sleep{turns_remaining: 3}. action_skip_roll_a = 99 (maximum possible).
// a_can_act = false, ActionBlocked emitted.
//
// Kills: an impl that applies the paralysis roll threshold to Sleep,
// letting Sleep through when roll >= 25.
// ---------------------------------------------------------------------------

/// Kills: an impl that uses the paralysis-style roll check for Sleep,
/// allowing Sleep to "fail to block" at high roll values.
#[test]
fn m14a_sleep_always_blocks_action() {
    let state = make_battle_state(
        make_monster(Affinity::Fire, 100, 50),
        make_monster(Affinity::Water, 100, 40),
    );

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Sleep { turns_remaining: 3 })],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 99, // highest possible roll — should NOT matter for Sleep
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 99,
        sleep_wake_roll_b: 0,
    };

    let (a_can_act, _b_can_act, events) = apply_pre_turn_effects(&status, &state, &variance);

    assert!(
        !a_can_act,
        "TEETH: Sleep must ALWAYS block action regardless of roll (even roll=99); \
         an impl that applies a paralysis-style threshold lets Sleep fail to block at roll=99"
    );

    let blocked_for_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::ActionBlocked { side } if *side == SideId::SideA));
    assert!(
        blocked_for_a,
        "TEETH: ActionBlocked must be emitted for Sleep even at roll=99; \
         an impl using a roll check for Sleep may omit this event"
    );
}

// ---------------------------------------------------------------------------
// TEST 10 (EARS-10): Freeze ALWAYS blocks regardless of roll
//
// Side A: Freeze. action_skip_roll_a = 99.
// a_can_act = false.
//
// Kills: an impl that uses a roll threshold for Freeze, allowing it through.
// ---------------------------------------------------------------------------

/// Kills: an impl that applies a roll threshold to Freeze (should always block).
#[test]
fn m14a_freeze_always_blocks_action() {
    let state = make_battle_state(
        make_monster(Affinity::Water, 100, 50),
        make_monster(Affinity::Fire, 100, 40),
    );

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Freeze)],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 99, // maximum roll — must not matter for Freeze
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0, // thaw check is < 80: 0 < 80 → freeze does NOT thaw here
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let (a_can_act, _b_can_act, _events) = apply_pre_turn_effects(&status, &state, &variance);

    assert!(
        !a_can_act,
        "TEETH: Freeze must ALWAYS block action (pre-turn check); \
         an impl with a roll threshold for Freeze may allow action at roll=99"
    );
}

// ---------------------------------------------------------------------------
// TEST 11 (EARS-11): Sleep turns decrement each tick
//
// BattleStatusStore with side_a[0] = Sleep{turns_remaining: 3}.
// tick_status → side_a[0] = Sleep{turns_remaining: 2}, no StatusCured event.
//
// Kills: an impl that decrements by 2, does not decrement, or emits StatusCured
// before turns reach 0.
// ---------------------------------------------------------------------------

/// Kills: an impl that decrements by 2, skips decrement, or prematurely cures sleep.
#[test]
fn m14a_sleep_turns_decrement_each_tick() {
    let mut status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Sleep { turns_remaining: 3 })],
        side_b: vec![None],
    };

    let variance = no_block_status_variance();
    let events = tick_status(&mut status, &variance);

    // turns_remaining must have decreased from 3 to 2.
    match &status.side_a[0] {
        Some(StatusEffect::Sleep { turns_remaining }) => {
            assert_eq!(
                *turns_remaining, 2,
                "TEETH: Sleep turns must decrement by exactly 1 (3 → 2); \
                 a -=2 impl produces 1, a no-op impl leaves it at 3"
            );
        }
        Some(other) => panic!("expected Sleep, got {other:?}"),
        None => panic!("TEETH: sleep must not be cleared when turns_remaining goes from 3 to 2"),
    }

    // No StatusCured event while turns > 0 after decrement.
    let cured = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusCured { .. }));
    assert!(
        !cured,
        "TEETH: StatusCured must NOT be emitted when turns_remaining is still > 0 after decrement; \
         a premature-cure impl emits it at turn 2 — this assertion catches it"
    );
}

// ---------------------------------------------------------------------------
// TEST 12 (EARS-12): Sleep cures when turns_remaining reaches 0 after decrement
//
// side_a[0] = Sleep{turns_remaining: 1}. tick_status → side_a[0] = None,
// StatusCured { side: SideA } event emitted.
//
// Kills: an impl that cures at turns_remaining==1 (before decrement),
// or that never cures, or emits the wrong event.
// ---------------------------------------------------------------------------

/// Kills: an impl that doesn't set status to None when turns reach 0,
/// or omits the StatusCured event, or cures at the wrong turn count.
#[test]
fn m14a_sleep_cures_when_turns_reach_zero() {
    let mut status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Sleep { turns_remaining: 1 })],
        side_b: vec![None],
    };

    let variance = no_block_status_variance();
    let events = tick_status(&mut status, &variance);

    // Status must have been cleared (turns 1 → 0 → cured).
    assert!(
        status.side_a[0].is_none(),
        "TEETH: Sleep{{turns_remaining:1}} → tick → must become None (cured); \
         an impl that doesn't clear the status slot fails here"
    );

    // StatusCured event must have been emitted for SideA.
    let cured_for_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusCured { side, .. } if *side == SideId::SideA));
    assert!(
        cured_for_a,
        "TEETH: StatusCured{{side:SideA}} must be emitted when Sleep reaches 0; \
         an impl that clears the slot but forgets the event fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 13 (EARS-13): Freeze thaws on high roll (freeze_thaw_roll >= 80)
//
// side_a[0] = Freeze. freeze_thaw_roll_a = 80.
// tick_status → side_a[0] = None, StatusCured { side: SideA }.
//
// Kills: an impl using roll > 80 instead of roll >= 80 (off-by-one).
// ---------------------------------------------------------------------------

/// Kills: an impl using `roll > 80` (strict) instead of `roll >= 80` (inclusive),
/// which would keep freeze at roll=80.
#[test]
fn m14a_freeze_thaws_when_roll_ge_80() {
    let mut status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Freeze)],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 80, // boundary: 80 >= 80 → must thaw
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let events = tick_status(&mut status, &variance);

    assert!(
        status.side_a[0].is_none(),
        "TEETH: Freeze with freeze_thaw_roll=80 (>= 80) must thaw (status → None); \
         an impl using `> 80` keeps freeze at the boundary and fails here"
    );

    let cured_for_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusCured { side, .. } if *side == SideId::SideA));
    assert!(
        cured_for_a,
        "TEETH: StatusCured{{side:SideA}} must be emitted on freeze thaw at roll=80; \
         an impl that clears status without emitting the event fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 14 (EARS-14): Freeze persists on low roll (freeze_thaw_roll < 80)
//
// side_a[0] = Freeze. freeze_thaw_roll_a = 79.
// tick_status → side_a[0] = Some(Freeze), no StatusCured.
//
// Kills: an impl using roll >= 79 (wrong threshold), thawing at 79.
// ---------------------------------------------------------------------------

/// Kills: an impl using roll >= 79 or any threshold below 80 — would thaw at 79.
#[test]
fn m14a_freeze_persists_when_roll_lt_80() {
    let mut status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Freeze)],
        side_b: vec![None],
    };

    let variance = StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 79, // 79 < 80 → must NOT thaw
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let events = tick_status(&mut status, &variance);

    assert!(
        matches!(status.side_a[0], Some(StatusEffect::Freeze)),
        "TEETH: Freeze with freeze_thaw_roll=79 (< 80) must persist; \
         an impl using threshold < 80 (e.g. >= 79) incorrectly thaws here"
    );

    let cured = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusCured { .. }));
    assert!(
        !cured,
        "TEETH: no StatusCured must be emitted when Freeze persists at roll=79; \
         an impl that cures at roll=79 emits this event and fails"
    );
}

// ---------------------------------------------------------------------------
// TEST 15 (EARS-15): ActionBlocked prevents attack in resolve_full_turn
//
// Side A has Paralysis with action_skip_roll_a = 0 (guaranteed block).
// Both sides choose Attack. Assert: ActionBlocked for SideA in events,
// NO Damage event targeting SideB (A never attacked).
//
// Kills: an impl that ignores the ActionBlocked result and still resolves
// SideA's attack even when a_can_act = false.
// ---------------------------------------------------------------------------

/// Kills: an impl that resolves SideA's attack even when paralysis blocks it —
/// SideB would receive Damage events that must be absent when A is blocked.
#[test]
fn m14a_paralysis_block_prevents_attack_in_resolve_full_turn() {
    let chart = make_type_chart();
    let variance = always_hit_variance(true); // A faster
    let sv = StatusVariance {
        action_skip_roll_a: 0, // 0 < 25 → GUARANTEED block for SideA
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    let monster_a = make_monster(Affinity::Fire, 200, 100); // A is faster
    let monster_b = make_monster(Affinity::Water, 200, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Paralysis)],
        side_b: vec![None],
    };

    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // ActionBlocked for SideA must appear.
    let blocked_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::ActionBlocked { side } if *side == SideId::SideA));
    assert!(
        blocked_a,
        "TEETH: ActionBlocked{{side:SideA}} must appear when paralysis blocks SideA; \
         an impl that ignores the block result omits this event"
    );

    // NO Damage event targeting SideB (A's attack was blocked, A never hit B).
    let damage_to_b = events
        .iter()
        .any(|e| matches!(e, BattleEvent::Damage { side, .. } if *side == SideId::SideB));
    assert!(
        !damage_to_b,
        "TEETH: SideB must receive NO Damage when SideA is paralysis-blocked; \
         an impl that still resolves A's attack after blocking emits Damage{{side:SideB}}"
    );
}

// ---------------------------------------------------------------------------
// TEST 16 (EARS-16): Determinism property test
//
// Same (state, choices, status, variance) inputs → same outputs every time.
//
// Kills: any non-deterministic impl (e.g. unseeded RNG inside status functions).
// ---------------------------------------------------------------------------

fn arb_affinity() -> impl Strategy<Value = Affinity> {
    prop_oneof![
        Just(Affinity::Fire),
        Just(Affinity::Water),
        Just(Affinity::Plant),
        Just(Affinity::Electric),
        Just(Affinity::Earth),
        Just(Affinity::Wind),
        Just(Affinity::Light),
        Just(Affinity::Dark),
    ]
}

proptest! {
    /// Kills: any non-deterministic status impl (hidden unseeded RNG, wall clock, etc.).
    #[test]
    fn m14a_resolve_full_turn_is_deterministic(
        aff_a in arb_affinity(),
        aff_b in arb_affinity(),
        spd_a in 1u16..100,
        spd_b in 1u16..100,
        damage_roll_a in 85u8..=100,
        damage_roll_b in 85u8..=100,
        accuracy_roll_a in 0u8..100,
        accuracy_roll_b in 0u8..100,
        tie_breaker in any::<bool>(),
        skip_roll_a in 0u8..100,
        skip_roll_b in 0u8..100,
        thaw_roll_a in 0u8..100,
        thaw_roll_b in 0u8..100,
    ) {
        let chart = make_type_chart();
        let monster_a = make_monster(aff_a, 200, spd_a);
        let monster_b = make_monster(aff_b, 200, spd_b);

        let variance = TurnVariance {
            damage_roll_a,
            damage_roll_b,
            accuracy_roll_a,
            accuracy_roll_b,
            speed_tie_breaker: tie_breaker,
        };
        let sv = StatusVariance {
            action_skip_roll_a: skip_roll_a,
            action_skip_roll_b: skip_roll_b,
            freeze_thaw_roll_a: thaw_roll_a,
            freeze_thaw_roll_b: thaw_roll_b,
            sleep_wake_roll_a: 0,
            sleep_wake_roll_b: 0,
        };

        let mut state1 = make_battle_state(monster_a.clone(), monster_b.clone());
        let mut state2 = make_battle_state(monster_a.clone(), monster_b.clone());
        let mut status1 = empty_status();
        let mut status2 = empty_status();

        let events1 = resolve_full_turn(
            &mut state1,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
            &mut status1,
            &sv,
        );
        let events2 = resolve_full_turn(
            &mut state2,
            TurnChoice::Attack { skill_id: 1 },
            TurnChoice::Attack { skill_id: 1 },
            &skills_vec(),
            &chart,
            &variance,
            &mut status2,
            &sv,
        );

        prop_assert_eq!(
            events1, events2,
            "TEETH: resolve_full_turn must be deterministic for identical inputs; \
             non-deterministic RNG inside status functions fails here"
        );
        prop_assert_eq!(
            state1, state2,
            "resulting BattleState must also be identical across two identical calls"
        );
    }
}

// ---------------------------------------------------------------------------
// TEST 17 (EARS-17): DoT KO triggers Faint + BattleEnd
//
// Monster with current_hp=1, max_hp=8, Poison, no backup on SideA.
// apply_post_turn_effects → StatusDamage with amount=1, then Faint for SideA,
// then BattleEnd (since no backup for SideA → SideB wins).
//
// Kills: an impl that applies DoT damage but never checks for KO/faint,
// leaving current_hp=0 without emitting Faint or BattleEnd.
// ---------------------------------------------------------------------------

/// Kills: an impl that decrements HP from DoT but doesn't check for KO afterward,
/// producing no Faint/BattleEnd events when DoT brings HP to 0.
#[test]
fn m14a_poison_dot_ko_triggers_faint_and_battle_end() {
    // max_hp=8 → Poison DoT = max(1, 8/8) = max(1, 1) = 1
    // current_hp=1, so 1 - 1 = 0 → faint
    let mut dying = make_monster(Affinity::Fire, 8, 50);
    dying.current_hp = 1;
    dying.max_hp = 8;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![dying], // no backup
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    // StatusDamage must appear first.
    let has_status_damage = events.iter().any(|e| {
        matches!(e, BattleEvent::StatusDamage { side, amount }
            if *side == SideId::SideA && *amount == 1)
    });
    assert!(
        has_status_damage,
        "TEETH: StatusDamage{{side:SideA,amount:1}} must be emitted for Poison on max_hp=8; \
         an impl without the floor emits 0 damage and fails here"
    );

    // Faint for SideA must appear.
    let has_faint = events
        .iter()
        .any(|e| matches!(e, BattleEvent::Faint { side } if *side == SideId::SideA));
    assert!(
        has_faint,
        "TEETH: Faint{{side:SideA}} must be emitted when DoT brings current_hp to 0; \
         an impl that applies DoT but skips KO detection fails here"
    );

    // BattleEnd must appear (SideA has no backup → SideB wins).
    let has_battle_end = events
        .iter()
        .any(|e| matches!(e, BattleEvent::BattleEnd { winner } if *winner == SideId::SideB));
    assert!(
        has_battle_end,
        "TEETH: BattleEnd{{winner:SideB}} must be emitted after DoT KO with no backup; \
         an impl that emits Faint but not BattleEnd fails here"
    );

    // State outcome must be updated.
    assert_eq!(
        state.outcome,
        BattleOutcome::SideBWins,
        "TEETH: state.outcome must be SideBWins after DoT KO with no SideA backup; \
         an impl that omits the outcome update leaves it as Ongoing"
    );

    // current_hp must be 0.
    assert_eq!(
        state.side_a.active_monster().current_hp,
        0,
        "current_hp must be 0 after saturating_sub reduces it from 1 to 0"
    );
}

// ---------------------------------------------------------------------------
// TEST 18 (EARS-18): Both sides can have independent status
//
// Side A: Poison, Side B: Paralysis.
// apply_post_turn_effects emits StatusDamage for A only (Paralysis has no DoT).
// apply_pre_turn_effects with action_skip_roll_b = 0 → b_can_act = false, a_can_act = true.
//
// Kills: an impl that cross-contaminates side A's status to side B or vice versa,
// or one that applies DoT for Paralysis.
// ---------------------------------------------------------------------------

/// Kills: an impl that applies DoT to the wrong side, cross-contaminates status
/// between sides, or incorrectly applies DoT to Paralysis.
#[test]
fn m14a_both_sides_can_have_independent_status() {
    let m_a = make_monster(Affinity::Fire, 100, 50);
    let m_b = make_monster(Affinity::Water, 100, 40);

    let mut state = make_battle_state(m_a, m_b);
    state.turn_number = 1;

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)],
        side_b: vec![Some(StatusEffect::Paralysis)],
    };

    // Part 1: DoT — Poison deals damage to A, Paralysis has no DoT
    let dot_events = apply_post_turn_effects(&mut state, &status);

    let damage_for_a = dot_events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { side, .. } if *side == SideId::SideA))
        .count();
    let damage_for_b = dot_events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { side, .. } if *side == SideId::SideB))
        .count();

    assert_eq!(
        damage_for_a, 1,
        "TEETH: Poison on SideA must produce exactly 1 StatusDamage for SideA; \
         an impl that applies DoT to SideB only or to neither fails here"
    );
    assert_eq!(
        damage_for_b, 0,
        "TEETH: Paralysis on SideB must produce NO StatusDamage for SideB; \
         an impl that applies DoT for Paralysis emits a StatusDamage here"
    );

    // Part 2: Pre-turn blocking — Paralysis on B with roll=0 blocks B, not A
    let variance = StatusVariance {
        action_skip_roll_a: 99, // A has Poison, not Paralysis — no blocking from Poison
        action_skip_roll_b: 0,  // B has Paralysis, roll=0 < 25 → blocks B
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    };

    // Re-read current state for pre-turn (state was mutated by DoT above — use fresh state)
    let state2 = make_battle_state(
        make_monster(Affinity::Fire, 100, 50),
        make_monster(Affinity::Water, 100, 40),
    );

    let (a_can_act, b_can_act, _events) = apply_pre_turn_effects(&status, &state2, &variance);

    assert!(
        a_can_act,
        "TEETH: SideA with Poison must still be able to act (Poison is a DoT, not a blocker); \
         an impl that blocks on Poison fails here"
    );
    assert!(
        !b_can_act,
        "TEETH: SideB with Paralysis and roll=0 (< 25) must be blocked; \
         an impl that cross-contaminates or ignores side B's status fails here"
    );
}

// ---------------------------------------------------------------------------
// TEST 19 (mutation gate): Poison on SideB emits StatusDamage{side:SideB}
//
// Kills: a mutant that hardcodes SideId::SideA in the StatusDamage event
// regardless of which side the loop is processing.
// Every DoT test in EARS-3 through EARS-5 and EARS-17 places Poison/Burn only
// on SideA. A hardcode-SideA mutant passes all 18 EARS tests. This test closes
// that mutation gap by putting Poison exclusively on SideB and verifying the
// event targets SideB (not SideA).
// ---------------------------------------------------------------------------

/// Kills: any mutant that hardcodes SideId::SideA in StatusDamage or in the
/// side_status lookup — both result in the wrong side being targeted or no
/// DoT being applied to SideB at all.
#[test]
fn m14a_poison_on_side_b_deals_dot_to_side_b() {
    let m_a = make_monster(Affinity::Water, 100, 100);
    let mut m_b = make_monster(Affinity::Fire, 160, 50);
    m_b.max_hp = 160;
    m_b.current_hp = 160;

    let mut state = make_battle_state(m_a, m_b);
    state.turn_number = 1;

    let status = BattleStatusStore {
        side_a: vec![None],
        side_b: vec![Some(StatusEffect::Poison)],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    // No DoT must target SideA (SideA has no status).
    let dot_a = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusDamage { side, .. } if *side == SideId::SideA));
    assert!(
        !dot_a,
        "TEETH: SideA has no status — must receive no StatusDamage; \
         a mutant that always targets SideA emits StatusDamage{{side:SideA}} here"
    );

    // Exactly one DoT event must target SideB.
    let dot_b_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { side, .. } if *side == SideId::SideB))
        .collect();
    assert_eq!(
        dot_b_events.len(),
        1,
        "TEETH: Poison on SideB must emit exactly 1 StatusDamage{{side:SideB}}; \
         a hardcode-SideA mutant emits 0 events for SideB — this assertion catches it"
    );

    match &dot_b_events[0] {
        BattleEvent::StatusDamage { side, amount } => {
            assert_eq!(*side, SideId::SideB, "StatusDamage must target SideB");
            assert_eq!(
                *amount, 20,
                "TEETH: Poison DoT for max_hp=160 must be 20 (160/8); \
                 a /16 impl produces 10, a hardcode-SideA path produces wrong amounts"
            );
        }
        _ => panic!("expected StatusDamage"),
    }

    assert_eq!(
        state.side_b.active_monster().current_hp,
        140,
        "TEETH: SideB current_hp must decrease from 160 to 140 (160 - 20); \
         a mutant applying DoT to SideA would leave SideB HP unchanged"
    );
}

// ---------------------------------------------------------------------------
// TEST 20 (mutation gate): Burn minimum damage = 1
//
// Parallel to EARS-4 (Poison floor). Kills a mutant that removes `.max(1)` from
// burn_dot_amount — for max_hp=8, 8/16=0 without the floor, emitting 0 damage.
// ---------------------------------------------------------------------------

/// Kills: a mutant that removes `.max(1)` from burn_dot_amount.
/// max_hp=8 → 8/16 = 0 → without the floor, amount=0 and no HP is subtracted.
#[test]
fn m14a_burn_deals_at_least_1_damage() {
    let mut m = make_monster(Affinity::Fire, 8, 50);
    m.max_hp = 8;
    m.current_hp = 8;

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![m],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Water, 100, 40)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
        weather: None,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Burn)],
        side_b: vec![None],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    let dot_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusDamage { .. }))
        .collect();
    assert!(
        !dot_events.is_empty(),
        "Burn must emit at least one StatusDamage event"
    );

    match &dot_events[0] {
        BattleEvent::StatusDamage { amount, .. } => {
            assert!(
                *amount >= 1,
                "TEETH: Burn DoT must be at least 1 even for max_hp=8 (8/16=0 without floor); \
                 a mutant removing .max(1) from burn_dot_amount emits 0 damage and fails here"
            );
        }
        _ => panic!("expected StatusDamage"),
    }
}
