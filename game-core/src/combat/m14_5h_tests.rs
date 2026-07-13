//! M14.5h gating tests — D6 wiring: entry abilities fire on KO auto-switch.
//!
//! Criterion → test mapping:
//!   EARS-h-1 (boundary documentation for `<` comparison in apply_entry_ability)
//!       → boundary_full_hp_no_heal          [PASSES already — pure documentation]
//!       → boundary_one_below_full_hp_heals  [PASSES already — pure documentation]
//!   EARS-h-2 (entry abilities fire on KO auto-switch via resolve_full_turn)
//!       → ko_auto_switch_fires_entry_heal_via_resolve_full_turn   [RED until D6 fix]
//!       → ko_auto_switch_fires_status_immunity_via_resolve_full_turn [RED until D6 fix]
//!
//! # EARS-h-1: boundary documentation tests
//!
//! These tests pass regardless of the D6 fix — they document the boundary
//! semantics of the `<` comparison in `apply_entry_ability`:
//!
//!   ```text
//!   if !monster.is_fainted() && monster.current_hp < monster.max_hp { heal }
//!   ```
//!
//! The downstream `.min(max_hp)` clamp means that changing `<` to `<=` produces
//! identical results (full-HP case: `heal = max_hp/denom`, then
//! `current_hp.saturating_add(heal).min(max_hp) == max_hp` regardless of
//! whether the branch is taken). These tests cannot kill that mutant, but
//! they document the intended semantics for future readers.

use crate::combat::ability::{apply_entry_ability, AbilityEffect, AbilityStore, StatusKind};
use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, StatusEffect, TurnChoice,
    TurnVariance,
};
use crate::content::SkillDef;
use crate::monster::types::{Affinity, StatBlock};

// ===========================================================================
// Fixture helpers
// ===========================================================================

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

/// Build a BattleMonster with explicit HP values, speed, and status.
fn make_monster(
    affinity: Affinity,
    current_hp: u16,
    max_hp: u16,
    speed: u16,
    status: Option<StatusEffect>,
) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity,
        level: 10,
        current_hp,
        max_hp,
        stats: make_stat_block(40, 40, speed),
        known_skill_ids: vec![1],
        status,
    }
}

/// Build a strong attacker guaranteed to KO a 1-HP target. High attack + low
/// defense target affinity gives max damage. Speed is configurable to control
/// turn order.
fn make_strong_attacker(affinity: Affinity, speed: u16) -> BattleMonster {
    BattleMonster {
        species_id: 99,
        affinity,
        level: 50,
        current_hp: 500,
        max_hp: 500,
        stats: StatBlock {
            hp: 500,
            attack: 255,
            defense: 50,
            speed,
            sp_attack: 50,
            sp_defense: 50,
        },
        known_skill_ids: vec![1],
        status: None,
    }
}

/// A Fire skill — Fire is super-effective vs Plant, guaranteeing KO on 1-HP targets.
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

/// TurnVariance that always hits and uses maximum damage roll.
/// `b_faster = true` makes SideB go first (higher speed tie-break to B).
fn always_hit_max_damage(b_faster: bool) -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0, // 0 < 100 accuracy threshold → always hits
        accuracy_roll_b: 0,
        speed_tie_breaker: !b_faster, // speed_tie_breaker=true means A first
    }
}

/// StatusVariance that never blocks any action.
fn no_block_sv() -> StatusVariance {
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
// EARS-h-1: Boundary documentation for the `<` comparison in apply_entry_ability
//
// IMPORTANT: These two tests PASS before and after the D6 fix. They are pure
// documentation of the boundary semantics of the `current_hp < max_hp` guard.
// The downstream `.min(max_hp)` clamp makes `<` and `<=` produce identical
// results at full HP (the heal is clamped back to max_hp regardless), so no
// mutation test can be written here to distinguish the two operators.
// ===========================================================================

/// EARS-h-1a: A monster at exactly full HP (current_hp == max_hp) with an
/// EntryHeal ability must NOT change HP.
///
/// This test PASSES before and after the D6 fix — it documents the boundary
/// behavior: full-HP monsters are not healed (the `<` guard skips the heal,
/// and even if `<=` were used, `.min(max_hp)` clamps back to max_hp anyway).
///
/// Kills: an impl that somehow overflows HP above max_hp (saturating_add
/// without `.min(max_hp)` for example). That bug is clamped in the real impl.
#[test]
fn boundary_full_hp_no_heal() {
    let max_hp: u16 = 10;
    let current_hp: u16 = 10; // exactly full HP
    let denom: u16 = 2;

    let monster_a = make_monster(Affinity::Fire, current_hp, max_hp, 40, None);
    let monster_b = make_monster(Affinity::Water, 100, 100, 40, None);

    let mut state = BattleState {
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
    };

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.team[0].current_hp, max_hp,
        "EARS-h-1a (boundary doc): a monster at full HP ({current_hp}/{max_hp}) \
         must not be healed above max_hp; HP must remain {max_hp}. \
         This test passes regardless of the D6 fix."
    );
}

/// EARS-h-1b: A monster at `current_hp = max_hp - 1` with EntryHeal must be healed.
///
/// This test PASSES before and after the D6 fix — it exercises the branch
/// where `current_hp < max_hp` is true (one below full HP). With max_hp=10,
/// denom=10: heal = (10/10).max(1) = 1, so current_hp goes from 9 to 10.
///
/// This test passes before and after the fix because it calls apply_entry_ability
/// directly, not via resolve_full_turn.
#[test]
fn boundary_one_below_full_hp_heals() {
    let max_hp: u16 = 10;
    let current_hp: u16 = 9; // one below full HP
    let denom: u16 = 10; // heal = (10/10).max(1) = 1

    let monster_a = make_monster(Affinity::Fire, current_hp, max_hp, 40, None);
    let monster_b = make_monster(Affinity::Water, 100, 100, 40, None);

    let mut state = BattleState {
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
    };

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    let expected_heal = (max_hp / denom).max(1); // = 1
    let expected_hp = (current_hp + expected_heal).min(max_hp); // = 10

    assert_eq!(
        state.side_a.team[0].current_hp, expected_hp,
        "EARS-h-1b (boundary doc): a monster at {current_hp}/{max_hp} with \
         EntryHeal denom={denom} must be healed by {expected_heal} to {expected_hp}. \
         This test passes regardless of the D6 fix."
    );
}

// ===========================================================================
// EARS-h-2: Entry abilities fire on KO auto-switch via resolve_full_turn
//
// These tests are RED until the D6 fix is implemented. The fix adds a call to
// `apply_ko_switch_entry_abilities` (or equivalent) inside `resolve_full_turn`
// AFTER `resolve_turn` returns, so that when a KO-triggered auto-switch fires
// inside `resolve_one_attack`, the switched-in monster's entry ability is applied
// in the same turn rather than being deferred to Phase 0 of the next turn.
//
// CURRENT behavior (RED):
//   - EntryHeal is NOT called on KO auto-switch → switched-in monster stays
//     at its pre-entry HP.
//   - StatusImmunity is NOT cleared on KO auto-switch → matching status persists
//     in the slot until Phase 0 of the NEXT turn.
//
// DESIRED behavior after fix (GREEN):
//   - EntryHeal fires immediately when the switched-in monster enters the active
//     slot via KO auto-switch → HP increases by max_hp/denom.
//   - StatusImmunity fires immediately → matching status is cleared to None.
// ===========================================================================

/// EARS-h-2a: EntryHeal fires on KO auto-switch via resolve_full_turn.
///
/// Setup (2v1 battle):
/// - SideA slot 0: 1 HP, Plant affinity (KO'd by SideB's Fire attack in one hit).
///   No ability.
/// - SideA slot 1: 50 HP, max_hp=100, Water affinity.
///   AbilityStore[SideA][1] = EntryHeal { denom: 4 } → expected heal = 25 HP.
/// - SideB: 1 strong Fire-affinity monster, very high speed (goes first).
///   A Fire skill is super-effective vs Plant → guaranteed KO on 1-HP slot 0.
///
/// Turn: both sides Attack. SideB goes first (higher speed), KOs SideA slot 0,
/// triggering auto-switch to slot 1. The D6 fix causes apply_entry_ability to
/// be called for slot 1 during (or immediately after) that auto-switch.
///
/// Assert: after resolve_full_turn, SideA slot 1 current_hp == 75 (50 + 25).
///
/// TEETH (EARS-h-2a): an impl that omits apply_entry_ability on KO auto-switch
/// leaves slot 1 at 50 HP — this assertion kills that gap.
/// A wrong denom (e.g. denom=8 → heal=12) would land at 62, not 75 — also killed.
#[test]
fn ko_auto_switch_fires_entry_heal_via_resolve_full_turn() {
    let chart = make_type_chart();

    // SideA slot 0: very weak, Plant affinity → Fire is SE, 1-HP guaranteed KO.
    let slot0_a = BattleMonster {
        species_id: 10,
        affinity: Affinity::Plant,
        level: 1,
        current_hp: 1,
        max_hp: 100,
        stats: make_stat_block(10, 1, 10), // very low speed → B goes first
        known_skill_ids: vec![1],
        status: None,
    };

    // SideA slot 1: the monster that will be auto-switched in.
    // 50/100 HP, EntryHeal denom=4 → heal = 100/4 = 25 → expected 75 HP.
    let slot1_a = BattleMonster {
        species_id: 11,
        affinity: Affinity::Water,
        level: 10,
        current_hp: 50,
        max_hp: 100,
        stats: make_stat_block(40, 40, 10),
        known_skill_ids: vec![1],
        status: None,
    };

    // SideB: strong Fire attacker. Very high speed ensures it attacks first.
    // Fire vs Plant = super-effective → even minimum damage KOs a 1-HP monster.
    let side_b_monster = make_strong_attacker(Affinity::Fire, 200); // speed=200 > 10

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![slot0_a, slot1_a],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![side_b_monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    // AbilityStore: slot 1 on SideA has EntryHeal { denom: 4 }.
    // Slot 0 on SideA has no ability (so no ability fires when it enters/exits as active).
    let mut abilities = AbilityStore::new(2, 1);
    abilities.side_a[1] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(2, 1);
    let sv = no_block_sv();
    // SideB faster (speed_tie_breaker=false means B goes first on tie; B has 200 speed so it goes first regardless)
    let variance = always_hit_max_damage(true); // b_faster=true → speed_tie_breaker=false

    let _events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // After the turn:
    // - SideB attacked first (speed 200 > 10), KO'd SideA slot 0 (Plant, 1 HP vs Fire SE).
    // - Auto-switch fired: SideA.active moved to slot 1.
    // - D6 fix: apply_entry_ability fires for SideA slot 1 → heal = 100/4 = 25 HP.
    // - SideA slot 1 should have current_hp = 50 + 25 = 75.
    //
    // CURRENT (RED): slot 1 stays at 50 HP (no entry ability called on KO auto-switch).
    // DESIRED (GREEN after fix): slot 1 is healed to 75 HP.

    assert_eq!(
        state.side_a.active, 1,
        "EARS-h-2a (setup): SideA must have auto-switched to slot 1 after KO of slot 0"
    );

    assert_eq!(
        state.side_a.team[1].current_hp, 75,
        "TEETH (EARS-h-2a): after KO auto-switch to SideA slot 1, EntryHeal must fire \
         and heal 25 HP (100/4), bringing current_hp from 50 to 75. \
         CURRENT behavior: current_hp stays at 50 (entry ability not called on KO auto-switch). \
         An impl that omits apply_entry_ability on KO auto-switch fails this assertion. \
         An impl with wrong denom (e.g. 8 → heal=12 → hp=62) also fails."
    );
}

/// EARS-h-2b: StatusImmunity fires on KO auto-switch via resolve_full_turn.
///
/// Setup (2v1 battle):
/// - SideA slot 0: 1 HP, Plant affinity → KO'd by SideB's Fire attack.
/// - SideA slot 1: 100 HP, Water affinity.
///   AbilityStore[SideA][1] = StatusImmunity { immune_to: Burn }.
///   BattleStatusStore.side_a[1] is pre-set to Some(Burn) to simulate a
///   Burn placed on the bench slot before this turn.
/// - SideB: strong Fire attacker, very high speed (goes first).
///
/// Turn: both sides Attack. SideB goes first, KOs SideA slot 0, triggering
/// auto-switch to slot 1. The D6 fix causes apply_entry_ability to fire for
/// slot 1 during the auto-switch, clearing the Burn immediately.
///
/// Assert: after resolve_full_turn, status.side_a[1] is None (Burn cleared).
///
/// TEETH (EARS-h-2b): an impl that omits apply_entry_ability on KO auto-switch
/// leaves the Burn in place (Some(Burn)) — this assertion kills that gap.
/// An impl that only clears on Phase 0 of the NEXT turn would also fail (the
/// Burn persists through this turn's post-turn DoT, potentially dealing damage).
#[test]
fn ko_auto_switch_fires_status_immunity_via_resolve_full_turn() {
    let chart = make_type_chart();

    // SideA slot 0: very weak, Plant affinity → Fire SE, 1-HP guaranteed KO.
    let slot0_a = BattleMonster {
        species_id: 10,
        affinity: Affinity::Plant,
        level: 1,
        current_hp: 1,
        max_hp: 100,
        stats: make_stat_block(10, 1, 10), // low speed → B goes first
        known_skill_ids: vec![1],
        status: None,
    };

    // SideA slot 1: Burn-immune monster with plenty of HP.
    // Pre-existing Burn in the status store simulates a status placed before this turn.
    let slot1_a = BattleMonster {
        species_id: 11,
        affinity: Affinity::Water,
        level: 10,
        current_hp: 100,
        max_hp: 100,
        stats: make_stat_block(40, 40, 10),
        known_skill_ids: vec![1],
        status: Some(StatusEffect::Burn), // mirrored from status store
    };

    // SideB: strong Fire attacker, very high speed.
    let side_b_monster = make_strong_attacker(Affinity::Fire, 200);

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![slot0_a, slot1_a],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![side_b_monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    // AbilityStore: slot 1 on SideA has Burn immunity.
    let mut abilities = AbilityStore::new(2, 1);
    abilities.side_a[1] = Some(AbilityEffect::StatusImmunity {
        immune_to: StatusKind::Burn,
    });

    // StatusStore: slot 1 already has Burn (bench status pre-existing this turn).
    let mut status = BattleStatusStore::new(2, 1);
    status.side_a[1] = Some(StatusEffect::Burn);

    let sv = no_block_sv();
    let variance = always_hit_max_damage(true); // b_faster=true → SideB goes first

    let _events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &skills_vec(),
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // After the turn:
    // - SideB attacked first, KO'd SideA slot 0.
    // - Auto-switch fired: SideA.active moved to slot 1.
    // - D6 fix: apply_entry_ability fires for SideA slot 1 (StatusImmunity { Burn }).
    //   This clears the Burn from status.side_a[1].
    //
    // CURRENT (RED): Burn stays in status.side_a[1] = Some(Burn).
    //   (apply_entry_ability is not called on KO auto-switch; the Burn only gets
    //   cleared at Phase 0 of the NEXT turn via apply_ability_modifiers.)
    // DESIRED (GREEN after fix): status.side_a[1] == None (Burn cleared on entry).

    assert_eq!(
        state.side_a.active, 1,
        "EARS-h-2b (setup): SideA must have auto-switched to slot 1 after KO of slot 0"
    );

    assert_eq!(
        status.side_a[1], None,
        "TEETH (EARS-h-2b): after KO auto-switch to SideA slot 1 (Burn-immune), \
         the Burn in status.side_a[1] must be cleared immediately by apply_entry_ability. \
         CURRENT behavior: Burn persists as Some(Burn) because apply_entry_ability is \
         not called on KO auto-switch — the Burn is only cleared at Phase 0 of the NEXT \
         turn. An impl without the D6 fix leaves status.side_a[1] = Some(Burn) here, \
         failing this assertion. This gap means one turn of phantom Burn DoT on the \
         Burn-immune monster."
    );
}
