//! Red-team findings for the M14a/M14b status-effect implementation.
//!
//! Each test is a permanent gating test that protects a concrete invariant.
//! All were confirmed by adversarial analysis of `status.rs` and `resolve.rs`.
//!
//! Findings summary (ranked by severity):
//!
//!   RT-S14-01 (HIGH)    — tick_status emits StatusCured with no slot index.
//!                          Bench-slot cures produce client-ambiguous events.
//!   RT-S14-02 (MEDIUM)  — Sleep{turns_remaining:0} handled correctly by `<= 1`
//!                          guard; mutant `== 1` would survive existing EARS tests
//!                          and underflow/panic on this input. This test pins it.
//!   RT-S14-03 (MEDIUM)  — Undersized BattleStatusStore silently drops all status
//!                          effects for the active slot after auto-switch. No panic,
//!                          wrong behavior.
//!   RT-S14-04 (LOW)     — Simultaneous-DoT-KO: SideA always processed first.
//!                          If both sides die from DoT the same turn, SideB wins.
//!                          Deterministic but undocumented; this test pins the order.
//!   RT-S14-05 (MEDIUM)  — resolve_player_swap (the swap_active reducer path) does NOT
//!                          apply pre-turn status effects to the enemy side. A paralyzed,
//!                          sleeping, or frozen enemy always attacks back after a player
//!                          swap, bypassing the 25%/100% action-block checks that
//!                          apply_pre_turn_effects would enforce on a normal attack turn.
//!                          This is a game-correctness gap: the player cannot exploit
//!                          enemy status to get a free-swap turn. (M14b, ADR-0093)

use crate::combat::resolve::resolve_player_swap;
use crate::combat::status::{
    apply_post_turn_effects, tick_status, BattleStatusStore, StatusEffect, StatusVariance,
};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnVariance,
};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

fn make_stat_block(speed: u16) -> StatBlock {
    StatBlock {
        hp: 100,
        attack: 40,
        defense: 40,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_monster(affinity: Affinity, hp: u16, max_hp: u16, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity,
        level: 5,
        current_hp: hp,
        max_hp,
        stats: make_stat_block(speed),
        known_skill_ids: vec![1],
        status: None,
    }
}

fn no_block_variance() -> StatusVariance {
    StatusVariance {
        action_skip_roll_a: 99,
        action_skip_roll_b: 99,
        freeze_thaw_roll_a: 0,
        freeze_thaw_roll_b: 0,
        sleep_wake_roll_a: 0,
        sleep_wake_roll_b: 0,
    }
}

// ===========================================================================
// RT-S14-01 (HIGH): tick_status emits StatusCured with no slot identifier.
//
// When a BENCH (non-active) slot has a status that expires, tick_status emits
// StatusCured { side: SideA } — identical to a cure on the ACTIVE slot.
// The consumer has no way to distinguish which slot was cured.
//
// This is a protocol ambiguity: if the active slot has a different status
// (or no status), the client will incorrectly attribute the cure to the wrong
// slot. Any render code that removes a status indicator from the active monster
// on seeing StatusCured will be wrong when it was the bench monster that cured.
//
// Attack: construct a 2-member side_a with active=0 (no status), bench slot 1
// has Sleep{turns_remaining:1}. tick_status → slot 1 cures → StatusCured emitted.
// Assert: StatusCured fires even though active slot 0 has no status.
//
// This test PASSES with the current implementation, confirming the protocol
// ambiguity exists. A correct design would include slot index in StatusCured.
// ===========================================================================

/// RT-S14-01 FIX (m14b): `StatusCured` now carries `slot: u32` identifying which
/// team slot was cured. This test verifies the fix: a bench cure on slot 1 must
/// emit `StatusCured { side: SideA, slot: 1 }`, not an ambiguous side-only event.
///
/// Kills: any impl that sets `slot: 0` for all cures (bench cure would fire
/// slot=0, failing the `assert_eq!(*slot, 1)` assertion).
#[test]
fn rt_s14_01_bench_slot_status_cure_carries_correct_slot_index() {
    let mut status = BattleStatusStore {
        // active slot 0: no status
        // bench slot 1: Sleep about to expire
        side_a: vec![None, Some(StatusEffect::Sleep { turns_remaining: 1 })],
        side_b: vec![None],
    };

    let variance = no_block_variance();
    let events = tick_status(&mut status, &variance);

    // StatusCured fires for the BENCH slot — not the active slot.
    let cured_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusCured { .. }))
        .collect();

    assert_eq!(
        cured_events.len(),
        1,
        "RT-S14-01: tick_status must emit one StatusCured when bench slot 1 expires; \
         a guard that only ticks the active slot would emit 0 events"
    );

    match &cured_events[0] {
        BattleEvent::StatusCured { side, slot } => {
            assert_eq!(*side, SideId::SideA, "cure must be on SideA");
            assert_eq!(
                *slot, 1,
                "RT-S14-01 FIX: StatusCured.slot must be 1 (bench slot index). \
                 A naive impl setting slot=0 always fails here — the cure was \
                 for bench slot 1, not active slot 0."
            );
        }
        _ => panic!("expected StatusCured"),
    }

    // Active slot 0 should remain None (no status on active was cured).
    assert!(
        status.side_a[0].is_none(),
        "RT-S14-01: Active slot 0 must remain None — no status was applied to it"
    );

    // Bench slot 1 should now be None (cured).
    assert!(
        status.side_a[1].is_none(),
        "RT-S14-01: Bench slot 1 must be cured (set to None) after tick"
    );
}

// ===========================================================================
// RT-S14-02 (MEDIUM): Sleep{turns_remaining:0} must NOT underflow.
//
// The `tick_one_slot` guard is `*turns_remaining <= 1`.
// A survivable mutant changes this to `== 1`:
//   - turns_remaining=1 → still cures (== 1 is true) — EARS-12 still passes
//   - turns_remaining=3 → still decrements — EARS-11 still passes
//   - turns_remaining=0 → would NOT cure under `== 1`, falls to else:
//       `*turns_remaining -= 1` → u8 underflow → panic (debug) / 255 (release)
//
// The existing EARS tests don't pin the turns_remaining=0 path.
// This test pins it: Sleep{0} must cure immediately, not underflow.
//
// Source: the `<= 1` guard covers both 0 and 1 → cures, never decrements.
// ===========================================================================

/// Kills: a mutant that changes `<= 1` to `== 1` in tick_one_slot.
/// Under `== 1`: turns_remaining=0 would not cure → falls to `*turns_remaining -= 1`
/// → u8 overflow in debug (panic) or silent wrap to 255 in release.
///
/// This test also documents that external construction of Sleep{0} must not
/// corrupt state. (Sleep{0} can arise via direct BattleStatusStore construction.)
#[test]
fn rt_s14_02_sleep_zero_turns_remaining_cures_without_underflow() {
    let mut status = BattleStatusStore {
        // Sleep with turns_remaining=0 — externally constructed edge case.
        // This should cure immediately (not wrap to 255).
        side_a: vec![Some(StatusEffect::Sleep { turns_remaining: 0 })],
        side_b: vec![None],
    };

    let variance = no_block_variance();

    // Must NOT panic (debug overflow) and must NOT wrap to 255 (release).
    let events = tick_status(&mut status, &variance);

    // Status must be cleared (cured).
    assert!(
        status.side_a[0].is_none(),
        "RT-S14-02: Sleep{{turns_remaining:0}} must cure immediately (set to None); \
         a mutant using `== 1` instead of `<= 1` would fall through to the decrement \
         branch, causing u8 underflow (panic in debug, silent 255 in release)"
    );

    // StatusCured must be emitted.
    let has_cured = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusCured { side, .. } if *side == SideId::SideA));
    assert!(
        has_cured,
        "RT-S14-02: StatusCured{{side:SideA}} must be emitted for Sleep{{0}}; \
         a mutant that falls through to the decrement path emits no cure event"
    );
}

// ===========================================================================
// RT-S14-03 (MEDIUM): Undersized BattleStatusStore silently loses DoT for the
// active slot after an auto-switch to a higher-index slot.
//
// BattleStatusStore has no size contract relative to BattleState team size.
// If the store is constructed with fewer slots than the team has members
// (e.g., BattleStatusStore::new(1, 1) but team has 2 members), then after
// an auto-switch to slot 1, `status.side_a.get(active_idx=1)` returns None,
// and all status effects (DoT, blocking, tick) are silently dropped for the
// new active monster.
//
// This is not a crash — it's silent wrong behavior. The poisoned monster takes
// no DoT damage after the switch.
// ===========================================================================

/// Kills: any future hardening that adds a size check in apply_post_turn_effects,
/// apply_pre_turn_effects, or BattleStatusStore::new. With the fix, this scenario
/// would either panic (size mismatch) or correctly track the new active's status.
/// As written, this test DEMONSTRATES the silent data loss.
#[test]
fn rt_s14_03_undersized_status_store_silently_drops_dot_after_slot_change() {
    // Team: [m0 (fainted), m1 (alive, active)] — active is slot 1.
    let m0 = make_monster(Affinity::Fire, 0, 80, 50); // fainted
    let m1 = make_monster(Affinity::Water, 80, 80, 40); // alive, this is the active

    let mut state = BattleState {
        side_a: BattleSide {
            active: 1, // m1 is active (slot 1 after m0 fainted)
            team: vec![m0, m1],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![make_monster(Affinity::Plant, 80, 80, 30)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
    };

    // Status store has only 1 slot (undersized for a 2-member team).
    // Slot 0 has Poison (but slot 0 corresponds to the fainted m0, not the active m1).
    // The active monster m1 is at slot 1, which doesn't exist in this store.
    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)], // only slot 0 exists
        side_b: vec![None],
    };

    let hp_before = state.side_a.team[1].current_hp;
    let events = apply_post_turn_effects(&mut state, &status);

    let has_dot_for_a = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusDamage {
                side: SideId::SideA,
                ..
            }
        )
    });

    // DoT is NOT applied: status.side_a.get(1) returns None (out of bounds),
    // so no Poison is found for the active slot.
    assert!(
        !has_dot_for_a,
        "RT-S14-03: An undersized status store (1 slot) with active=1 silently produces \
         no DoT for the active monster. status.side_a.get(1) returns None. \
         The DoT in slot 0 was intended for m0 (slot 0), not the active m1 (slot 1). \
         But this exposes the broader risk: if a caller intended to track status \
         for m1 via slot 0 (wrong index assumption), the status is silently lost."
    );

    // HP is unchanged because no DoT was applied.
    assert_eq!(
        state.side_a.team[1].current_hp, hp_before,
        "RT-S14-03: Active monster HP must be unchanged when status store is undersized; \
         the store has no slot for active=1, so get(1) returns None and no damage is dealt"
    );
}

// ===========================================================================
// RT-S14-04 (LOW): Simultaneous DoT KO — SideA always processed first.
//
// When both sides have Poison and both would KO from DoT on the same turn,
// SideA is processed first (loop order: [SideA, SideB]). SideA dies → SideBWins
// is set → loop breaks → SideB's DoT is never applied.
// Result: SideB wins even though SideB would have also died from poison.
//
// This is deterministic behavior. The test pins the exact outcome so it cannot
// silently change (e.g., if loop order is reversed, SideA would win instead).
// ===========================================================================

/// Kills: an impl that reverses the loop order in apply_post_turn_effects
/// (would change winner from SideB to SideA in simultaneous-KO scenarios).
#[test]
fn rt_s14_04_simultaneous_dot_ko_side_a_processed_first_side_b_wins() {
    // Both sides: max_hp=8, current_hp=1 → Poison DoT = max(1, 8/8) = 1 → both would KO
    let m_a = make_monster(Affinity::Fire, 1, 8, 50);
    let m_b = make_monster(Affinity::Water, 1, 8, 40);

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![m_a], // no backup
        },
        side_b: BattleSide {
            active: 0,
            team: vec![m_b], // no backup
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 1,
    };

    let status = BattleStatusStore {
        side_a: vec![Some(StatusEffect::Poison)],
        side_b: vec![Some(StatusEffect::Poison)],
    };

    let events = apply_post_turn_effects(&mut state, &status);

    // SideA is processed first → SideA faints → SideBWins → loop breaks.
    // SideB's Poison is NEVER applied (loop broke before SideB's turn).

    // SideA must have fainted (its DoT was applied).
    let a_fainted = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Faint {
                side: SideId::SideA
            }
        )
    });
    assert!(
        a_fainted,
        "RT-S14-04: SideA must faint from Poison DoT (processed first)"
    );

    // SideB's DoT must NOT have been applied (loop broke after SideA fainted).
    let b_dot = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusDamage {
                side: SideId::SideB,
                ..
            }
        )
    });
    assert!(
        !b_dot,
        "RT-S14-04: TEETH: SideB's Poison DoT must NOT be applied after SideA's KO \
         ends the battle. A reversed loop order (SideB first) would apply SideB's DoT \
         first — changing the winner from SideB to SideA in this scenario."
    );

    // SideB wins (it survived because the loop broke before its DoT fired).
    assert_eq!(
        state.outcome,
        BattleOutcome::SideBWins,
        "RT-S14-04: TEETH: outcome must be SideBWins when SideA is processed first. \
         A reversed loop order produces SideAWins — this assertion catches that mutation."
    );

    // SideB's HP must be unchanged (its Poison never fired).
    assert_eq!(
        state.side_b.active_monster().current_hp,
        1,
        "RT-S14-04: SideB's HP must remain at 1 — its Poison DoT was never applied \
         (the loop broke after SideA fainted). \
         A reversed loop order would reduce SideB's HP to 0 and change the winner."
    );
}

// ===========================================================================
// RT-S14-05 (MEDIUM): resolve_player_swap does NOT apply pre-turn status blocks
// to the enemy side.
//
// When a player swaps (swap_active reducer → resolve_player_swap), the enemy
// attacks back via resolve_enemy_turn → resolve_one_attack. This path does NOT
// call apply_pre_turn_effects, so a paralyzed/sleeping/frozen enemy ALWAYS
// attacks after a player swap — the 25%/100% block from apply_pre_turn_effects
// is never evaluated on the swap path.
//
// This is a game-correctness gap: on a normal attack turn, a fully-paralyzed
// enemy has a 25% chance of being blocked. On a swap turn, it attacks with
// 100% probability. The player loses the benefit of enemy status during swaps.
//
// The test pins this behavior as DOCUMENTED (not a silent accident) so a future
// "fix" that accidentally applies status blocks to the swap path can be
// caught before it changes game balance without deliberate intent.
//
// Design note: whether swap turns SHOULD apply enemy status is a game-design
// question; this test documents the CURRENT behavior as an invariant so any
// change is visible and deliberate.
// ===========================================================================

/// RT-S14-05: Pins that resolve_player_swap does NOT block a paralyzed enemy.
///
/// Setup: Enemy (side B) has Paralysis loaded via status store. Player swaps.
/// Expected: enemy always attacks (no ActionBlocked event).
///
/// Kills: a "fix" that wraps resolve_player_swap in apply_pre_turn_effects
/// without deliberate intent — the enemy would sometimes be blocked and
/// sometimes not, making swap turns depend on status in a new undocumented way.
/// Also pins the gap so the code reviewer knows the omission is intentional.
#[test]
fn rt_s14_05_resolve_player_swap_does_not_apply_enemy_status_block() {
    let fire_skill = SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
    };
    let skills = vec![fire_skill];
    let chart = make_type_chart();

    // Player has two healthy monsters (so a swap is legal).
    let player_m0 = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    };
    let player_m1 = BattleMonster {
        species_id: 2,
        affinity: Affinity::Water,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 50,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    };
    // Enemy has Paralysis in its BattleMonster.status — this would normally give
    // a 25% chance of blocking. On a swap turn, this block is never evaluated.
    let enemy = BattleMonster {
        species_id: 3,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: StatBlock {
            hp: 100,
            attack: 40,
            defense: 40,
            speed: 30,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: Some(StatusEffect::Paralysis),
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![player_m0, player_m1],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![enemy],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    };

    let pre_hp_a = state.side_a.team[0].current_hp;

    // Always-hit variance — if the enemy attacks, it will hit.
    let variance = TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    };

    // Player swaps from slot 0 to slot 1.
    let events = resolve_player_swap(&mut state, SideId::SideA, 1, &skills, &chart, &variance);

    // The swap must have happened.
    assert_eq!(
        state.side_a.active, 1,
        "RT-S14-05: player must now be on slot 1 after the swap"
    );

    // RT-S14-05: The paralyzed enemy ALWAYS attacks on a swap turn.
    // There must be NO ActionBlocked event for SideB.
    let enemy_blocked = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::ActionBlocked {
                side: SideId::SideB
            }
        )
    });
    assert!(
        !enemy_blocked,
        "RT-S14-05 TEETH: resolve_player_swap must NOT emit ActionBlocked for the enemy — \
         the swap path uses resolve_enemy_turn (not resolve_full_turn), so \
         apply_pre_turn_effects is NEVER called and a paralyzed enemy always attacks. \
         A future change that wraps resolve_player_swap in status checks would break this pin."
    );

    // The enemy MUST have attacked (produce a Damage event targeting SideA).
    let enemy_attacked = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Damage {
                side: SideId::SideA,
                ..
            }
        )
    });
    assert!(
        enemy_attacked,
        "RT-S14-05: A paralyzed enemy must attack after a player swap (always-hit \
         variance, no status block applied). If the enemy did not attack, the test \
         fixture is wrong or the swap rejected the enemy turn."
    );

    // The new active (slot 1) must have taken damage — not the old active (slot 0).
    assert_eq!(
        state.side_a.team[0].current_hp, pre_hp_a,
        "RT-S14-05: the OLD active (slot 0) must be undamaged — the enemy attacks \
         the NEW active (slot 1) after the swap"
    );
}
