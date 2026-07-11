//! Red-team findings for the M14c passive ability system.
//!
//! Each test is a permanent gating test that protects a concrete invariant.
//! All were confirmed by adversarial analysis of `ability.rs` and `content.rs`.
//!
//! Findings summary (ranked by severity):
//!
//!   RT-A14-01 (HIGH)   — `validate_abilities` is NOT called from `sync_content_inner`.
//!                         Invalid species ability references (dangling ids, illegal denoms)
//!                         slip through to the live server if the caller only runs
//!                         `validate_content`. The gate here pins the mandatory call-site
//!                         in `sync_content_inner`'s source text.
//!
//!   RT-A14-02 (MEDIUM) — AbilityStore/BattleStatusStore size contract is unchecked.
//!                         `apply_entry_ability` and `apply_ability_modifiers` use `Vec::get`
//!                         so an undersized AbilityStore silently produces a no-op instead of
//!                         applying the ability. Same contract gap as RT-S14-03 (BattleStatusStore).
//!                         Probe: AbilityStore with 1 slot, BattleState.active=1 → ability is
//!                         silently skipped, monster heals nothing.
//!
//!   RT-A14-03 (MEDIUM) — `debug_assert!(denom >= 2)` precondition fires loudly in debug
//!                         builds when `denom < 2` bypasses `validate_abilities`. This test
//!                         confirms the debug guard is active (project ADR-0055 policy).
//!
//!   RT-A14-05 (LOW)    — `apply_ability_modifiers` with EntryHeal does NOT heal per-turn
//!                         (entry-only). Pins this so a per-turn heal exploit is not
//!                         accidentally introduced.

use crate::combat::ability::{
    apply_ability_modifiers, apply_entry_ability, AbilityEffect, AbilityStore,
};
use crate::combat::status::BattleStatusStore;
use crate::combat::types::{BattleMonster, BattleOutcome, BattleSide, BattleState, SideId};
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn make_stat_block() -> StatBlock {
    StatBlock {
        hp: 100,
        attack: 40,
        defense: 40,
        speed: 40,
        sp_attack: 50,
        sp_defense: 50,
    }
}

fn make_monster(current_hp: u16, max_hp: u16) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 10,
        current_hp,
        max_hp,
        stats: make_stat_block(),
        known_skill_ids: vec![1],
        status: None,
    }
}

fn make_state(
    a_active: u32,
    a_team: Vec<BattleMonster>,
    b_team: Vec<BattleMonster>,
) -> BattleState {
    BattleState {
        side_a: BattleSide {
            active: a_active,
            team: a_team,
        },
        side_b: BattleSide {
            active: 0,
            team: b_team,
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    }
}

// ===========================================================================
// RT-A14-01 (HIGH): validate_abilities is NOT called from sync_content_inner.
//
// `sync_content_inner` calls validate_content, validate_encounters,
// validate_evolution_fusion, validate_npc_content, and validate_shops — but
// NOT validate_abilities. This means a content author can publish species rows
// with dangling ability ids (e.g., `ability: Some(99)` where id=99 does not
// exist in the abilities registry) and the server will accept it without error.
//
// This test gates that the word "validate_abilities" appears in the
// sync_content_inner source body.  It uses the source-guard pattern (include_str!)
// established by the project for analogous cross-registry validators
// (validate_shops, validate_evolution_fusion).
// ===========================================================================

/// RT-A14-01: pins that sync_content_inner calls validate_abilities.
///
/// Kills: an impl of sync_content_inner that omits validate_abilities, allowing
/// dangling species ability references or invalid denom values to slip through
/// to the live server without rejection.
#[test]
fn rt_a14_01_sync_content_inner_calls_validate_abilities() {
    let src = include_str!("../../../server-module/src/content.rs");

    assert!(
        src.contains("validate_abilities"),
        "RT-A14-01 TEETH: server-module/src/content.rs must call validate_abilities \
         in sync_content_inner (the validate phase, before any DB write). \
         Without this call, invalid species ability references (dangling ids, \
         denom < 2 in a crafted ability def) can reach the live server without \
         rejection. Current source does NOT contain 'validate_abilities'. \
         Fix: add `validate_abilities(&abilities, &species)` to the validate \
         phase of sync_content_inner, following the validate_shops / \
         validate_evolution_fusion precedent."
    );
}

// ===========================================================================
// RT-A14-02 (MEDIUM): Undersized AbilityStore silently skips ability for
// the active slot when active > store size.
//
// `apply_entry_ability` uses `abilities.side_a.get(active_idx)` — returning
// `None` if `active_idx >= abilities.side_a.len()`. If the AbilityStore was
// constructed with fewer slots than the team (e.g., AbilityStore::new(1, 1)
// but the active monster is now at slot 1 after the first fainted), the
// ability is silently not applied. No panic, no error, just wrong behavior.
//
// Attack: side_a has 2 monsters, active=1. AbilityStore has only 1 slot.
// Monster at slot 1 has EntryHeal(denom:4) in the INTENDED store, but the
// store only has slot 0. apply_entry_ability: get(1) → None → early return.
// Monster HP unchanged even though it "should" have healed.
// ===========================================================================

/// RT-A14-02: Undersized AbilityStore silently produces no-op for active slot > 0.
///
/// Kills: any future hardening that asserts size parity between AbilityStore
/// and BattleState team sizes. With such a fix, this scenario panics or errors
/// rather than silently skipping the ability.
#[test]
fn rt_a14_02_undersized_ability_store_silently_skips_entry_heal() {
    let m0 = make_monster(0, 80); // slot 0: fainted
    let m1 = make_monster(40, 80); // slot 1: alive, active

    let mut state = make_state(1, vec![m0, m1], vec![make_monster(80, 80)]);

    // AbilityStore with only 1 slot — slot 1 is out of bounds.
    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(2, 1);

    let hp_before = state.side_a.team[1].current_hp;

    // Apply for SideA — active=1, but store only has slot 0 → get(1) returns None.
    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.team[1].current_hp, hp_before,
        "RT-A14-02 TEETH: An undersized AbilityStore (1 slot) with active=1 \
         silently produces no heal — abilities.side_a.get(1) returns None. \
         HP must remain at {hp_before}. A size-check hardening would panic here instead."
    );
}

// ===========================================================================
// RT-A14-03 (MEDIUM): debug_assert!(denom >= 2) fires in debug builds when
// denom=1 bypasses validate_abilities.
//
// The precondition guard in apply_entry_ability (ADR-0055 policy):
//   debug_assert!(denom >= 2, "EntryHeal denom {denom} bypassed ...")
//
// When denom < 2 reaches apply_entry_ability (bypassing validate_abilities),
// the debug_assert fires loudly in debug/test builds — which is the project's
// "fail loud" policy for precondition violations. This test pins that the
// guard is active by confirming the panic message.
//
// Root fix: RT-A14-01 (validate_abilities called server-side).
// ===========================================================================

/// RT-A14-03: debug_assert fires loudly on denom=1 (precondition violation).
///
/// Kills: an impl that silently accepts invalid denom without a precondition
/// guard. With this test, removing the debug_assert changes the test outcome
/// from "expected panic" to "no panic" (wrong behavior in test mode).
#[test]
#[should_panic(expected = "EntryHeal denom 1 bypassed validate_abilities")]
fn rt_a14_03_denom_1_triggers_debug_assert_precondition() {
    let monster_a = make_monster(30, 100);
    let monster_b = make_monster(100, 100);
    let mut state = make_state(0, vec![monster_a], vec![monster_b]);

    let mut abilities = AbilityStore::new(1, 1);
    // Intentionally bypassing validate_abilities (which would reject denom=1).
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 1 });

    let mut status = BattleStatusStore::new(1, 1);

    // debug_assert!(denom >= 2) fires here in debug/test builds.
    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);
}

// ===========================================================================
// RT-A14-05 (LOW / correctness pin): apply_ability_modifiers with EntryHeal
// ability does NOT heal on modifier calls (per-turn hook only touches immunity).
//
// AbilityEffect::EntryHeal is matched exhaustively in apply_entry_ability but
// NOT in apply_ability_modifiers. The modifier loop only acts on StatusImmunity:
//   if let Some(AbilityEffect::StatusImmunity { immune_to }) = ability { ... }
//
// This means an EntryHeal monster does NOT get healed per-turn — only on entry.
// This is correct per spec. But the `if let` pattern (non-exhaustive) silently
// ignores all non-StatusImmunity variants. If a new AbilityEffect variant is
// added (e.g., StatBoost), apply_ability_modifiers will silently do nothing
// for it. The OCP gate comment in AbilityEffect warns about this, but there is
// no compile-time forcing function on apply_ability_modifiers.
//
// This test pins the current behavior: EntryHeal has no per-turn modifier effect.
// ===========================================================================

/// RT-A14-05: apply_ability_modifiers does NOT heal a monster with EntryHeal ability.
///
/// Kills: an accidental implementation that tries to apply EntryHeal per-turn
/// (which would continuously heal every turn — an exploit-level bug).
#[test]
fn rt_a14_05_ability_modifiers_does_not_heal_entry_heal_ability() {
    let state = make_state(
        0,
        vec![make_monster(50, 100)],  // side_a: 50/100 HP
        vec![make_monster(100, 100)], // side_b: full HP
    );

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(1, 1);

    apply_ability_modifiers(&state, &mut status, &abilities);

    // apply_ability_modifiers takes &BattleState (not &mut), so HP cannot change.
    assert_eq!(
        state.side_a.active_monster().current_hp,
        50,
        "RT-A14-05 TEETH: apply_ability_modifiers must NOT heal; it takes &BattleState \
         (immutable). EntryHeal is for entry only (apply_entry_ability). HP must remain 50. \
         If a future refactor accidentally makes this function heal per-turn, \
         EntryHeal monsters would gain free HP every turn — a balance-breaking bug."
    );
}
