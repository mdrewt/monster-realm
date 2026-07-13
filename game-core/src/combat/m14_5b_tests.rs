//! M14.5b gating tests — acceptance criteria for the `StatusApplied` slot-field fix.
//!
//! ## What these tests protect
//!
//! `BattleEvent::StatusApplied` currently carries only `side` and `status`.
//! When Sandstorm/Hail chip damage kills the targeted monster between Phase 2
//! (attack resolution, where `StatusApplied` is emitted) and Phase 4.5 (where
//! the event is committed to `BattleStatusStore`), `run_post_turn_phases` used
//! to write the status to whichever slot happened to be active AFTER the
//! auto-switch — the wrong monster.
//!
//! The fix (m14.5b) closes two gaps left by the m14.5a partial fix:
//!
//!   1. `BattleEvent::StatusApplied` gains a `slot: u32` field — the team index
//!      of the monster that was attacked at the time the event was emitted.
//!
//!   2. Phase 4.5 reads `slot` from the event. If the monster at that slot has
//!      `current_hp == 0` (fainted from DoT or weather chip since Phase 2), the
//!      write is DROPPED — the status must not be applied to a fainted monster or
//!      (worse) redirected to the auto-switched-in backup.
//!
//! ## Criterion → test mapping
//!
//!   14.5b-1a (slot in event)           → `m14_5b_1a_status_applied_event_carries_target_slot`
//!   14.5b-1b (drop write on faint)     → (covered by 14.5b-2 proof-of-teeth below)
//!   14.5b-2  (proof-of-teeth, full     → `m14_5b_2_proof_of_teeth_near_lethal_status_hit_sandstorm_chip_faint`
//!              scenario)
//!
//! ## RED state today (before the implementation)
//!
//!   * `m14_5b_1a_*`: **compile error** — `StatusApplied { slot: 0, ... }` references
//!     a field that does not yet exist on `BattleEvent::StatusApplied`.
//!
//!   * `m14_5b_2_*`: **runtime failure** — current `run_post_turn_phases` writes
//!     `Some(Burn)` to `status.side_b[0]` regardless of whether the targeted monster
//!     is still conscious. The test asserts `None`, so it fails.

use crate::combat::ability::{AbilityStore, StatusKind};
use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusVariance};
use crate::combat::type_chart::TypeChart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, StatusEffect,
    TurnChoice, TurnVariance,
};
use crate::combat::weather::WeatherEffect;
use crate::content::{SkillDef, TypeRelation};
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors redteam_m14_5a_tests.rs convention so the two
// files stay in sync. Copy rather than re-export avoids coupling test modules.
// ---------------------------------------------------------------------------

fn make_type_chart_neutral() -> TypeChart {
    // Neutral type chart: every Affinity pair → effectiveness 10 (Neutral).
    let affinities = [
        Affinity::Fire,
        Affinity::Water,
        Affinity::Plant,
        Affinity::Electric,
        Affinity::Earth,
        Affinity::Wind,
        Affinity::Light,
        Affinity::Dark,
    ];
    let mut rels = Vec::new();
    for &a in &affinities {
        for &d in &affinities {
            rels.push(TypeRelation {
                attacker: a,
                defender: d,
                effectiveness: 10,
            });
        }
    }
    TypeChart::new(&rels)
}

fn stat_block(attack: u16, defense: u16, speed: u16, hp: u16) -> StatBlock {
    StatBlock {
        hp,
        attack,
        defense,
        speed,
        sp_attack: 50,
        sp_defense: 50,
    }
}

/// A Burn-applying skill with minimal power so a healthy target survives.
fn burn_applying_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Scorch".to_string(),
        affinity: Affinity::Fire,
        power: 1, // minimal power — large-defense targets survive
        accuracy: 100,
        pp: 10,
        sets_weather: None,
        applies_status: Some(StatusKind::Burn),
    }
}

/// `StatusVariance` that never blocks any action and never causes free thaw/wake.
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

/// `TurnVariance` that always hits, minimum damage roll, A wins speed ties.
fn always_hit_variance() -> TurnVariance {
    TurnVariance {
        damage_roll_a: 85, // minimum roll → lowest possible damage
        damage_roll_b: 85,
        accuracy_roll_a: 0, // always hits
        accuracy_roll_b: 0,
        speed_tie_breaker: true, // A goes first on tie
    }
}

// ===========================================================================
// TEST 1 (EARS 14.5b-1a): StatusApplied event carries the target's team slot.
//
// Invariant: when Side A applies Burn to Side B (slot 0 active), the emitted
// `BattleEvent::StatusApplied` must have `slot == 0`.
//
// RED today: compile error — `BattleEvent::StatusApplied` has no `slot` field.
// The struct literal `StatusApplied { side, status, slot }` and the destructure
// below both fail to compile until `slot: u32` is added to the variant.
//
// Kills: any impl that adds `slot` to the variant but hard-codes it (e.g. always
// `slot: 0`) — the test would accidentally pass; the proof-of-teeth scenario in
// test 2 enforces that the correct value is computed at runtime.
// ===========================================================================
#[test]
fn m14_5b_1a_status_applied_event_carries_target_slot() {
    // Setup: SideA (faster, speed=80) uses Burn skill against SideB (speed=40).
    // SideB has one monster at slot 0 with enough HP to survive the minimal hit.
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(40, 40, 80, 200), // speed 80 — goes first
        known_skill_ids: vec![1],
        status: None,
    };
    // Defender: high defense, high HP so it survives power=1 Burn hit.
    let defender = BattleMonster {
        species_id: 2,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(10, 200, 40, 200), // defense=200 → absorbs minimal damage
        known_skill_ids: vec![1],
        status: None,
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![attacker],
        },
        side_b: BattleSide {
            active: 0, // target is at team slot 0
            team: vec![defender],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(1, 1);
    let chart = make_type_chart_neutral();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // Side A uses Burn skill; Side B uses the same skill (to keep the registry simple).
    // A is faster (speed 80 vs 40) so A attacks first and applies Burn to B slot 0.
    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Find the StatusApplied event for SideB.
    let applied_event = events.iter().find(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });

    assert!(
        applied_event.is_some(),
        "14.5b-1a precondition: a StatusApplied event for SideB must be emitted when \
         Side A's Burn skill hits a clean defender; \
         if missing, the Burn skill or attack resolution is broken. \
         Events: {events:?}"
    );

    // Destructure and assert the slot field.
    // COMPILE-RED today: `slot` does not exist on `StatusApplied` until the fix.
    // This exhaustive destructure (no `..`) ensures no new fields can be silently added.
    match applied_event.unwrap() {
        BattleEvent::StatusApplied {
            side,
            status: new_status,
            slot,
        } => {
            assert_eq!(
                *side,
                SideId::SideB,
                "14.5b-1a: StatusApplied.side must be SideB (the target side)"
            );
            assert_eq!(
                *new_status,
                StatusEffect::Burn,
                "14.5b-1a: StatusApplied.status must be Burn (the applied status)"
            );
            assert_eq!(
                *slot, 0,
                "14.5b-1a FAILED: StatusApplied.slot must be 0 — the team index of \
                 SideB's active monster at the time of the attack. \
                 Kills: any impl that omits `slot` (compile error), or encodes the wrong \
                 slot (e.g. attacker's slot, or always 0 when defender was at slot 1)."
            );
        }
        _ => panic!("expected StatusApplied variant"),
    }
}

// ===========================================================================
// TEST 2 (EARS 14.5b-2, proof-of-teeth): near-lethal Burn hit + Sandstorm chip
// faint in ONE resolve_full_turn call → BOTH status slots remain None.
//
// Scenario (matches the exact EARS 14.5b-2 specification):
//   - SideA active:  attacker with high HP, attack=40, speed=80, Fire affinity
//   - SideB slot 0 (active, targeted): 3 HP, max_hp=16, Fire affinity (not
//     Sandstorm-immune — Earth is immune, Fire is not). defense=200 so the
//     minimal-power Burn skill deals ~1–2 damage; B survives the attack.
//   - SideB slot 1 (bench backup): healthy, Fire affinity.
//   - Sandstorm active (turns_remaining=5).
//   - Phase 2: SideA attacks SideB slot 0 with Burn skill (power=1).
//     SideB slot 0 survives (≥1 HP remaining). `StatusApplied { side:SideB, slot:0, status:Burn }`
//     is emitted into `turn_events`. Slot carries `0` (the active slot at attack time).
//   - Phase 3 (DoT): no prior statuses in store → no DoT.
//   - Phase 3.5 (Sandstorm chip): chip = max_hp/16 = 16/16 = 1.
//     SideB slot 0 has ≤1 HP → dies. Faint emitted. Auto-switch to SideB slot 1.
//     state.side_b.active is now 1.
//   - Phase 4.5: `StatusApplied { slot:0, ... }` is processed. The fix checks
//     `state.side_b.team[0].current_hp == 0` (fainted) → DROPS the write.
//     Slot 1 (the switch-in) is never targeted → also None.
//
// Expected after resolve_full_turn returns:
//   status.side_b[0] == None   (targeted, but fainted before 4.5 → dropped)
//   status.side_b[1] == None   (auto-switch-in, never targeted)
//
// RED today (runtime failure): current run_post_turn_phases captures active_slot_b
// at the top of the function (== 0 at that point), then Phase 3.5 kills slot 0
// and switches to slot 1 (state.side_b.active becomes 1). Phase 4.5 still reads
// the captured active_slot_b (== 0) and writes Some(Burn) to status.side_b[0]
// WITHOUT checking consciousness. So current code produces:
//   status.side_b[0] == Some(Burn)  ← WRONG: fainted monster got the status
//   status.side_b[1] == None
// The assertion `status.side_b[0] == None` catches this and turns RED.
//
// Kills: any impl that writes StatusApplied to slot 0 without checking
// current_hp == 0 after the chip-damage phase.
// ===========================================================================
#[test]
fn m14_5b_2_proof_of_teeth_near_lethal_status_hit_sandstorm_chip_faint() {
    // SideA active: strong attacker, Fire affinity, speed=80 (goes first).
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(40, 40, 80, 200),
        known_skill_ids: vec![1],
        status: None,
    };

    // SideB slot 0 (active, target of Burn):
    //   - 3 HP, max_hp=16 → chip = max_hp/16 = 16/16 = 1.
    //   - defense=200 → power=1 Burn skill deals min ~1–2 damage (formula minimum);
    //     after the hit B has ≤2 HP, then chip (1) kills it.
    //   - Fire affinity → NOT Sandstorm-immune (Earth is immune, not Fire).
    //   - No prior status → Burn skill can apply Burn (no-stacking guard doesn't fire).
    let sideb_slot0 = BattleMonster {
        species_id: 2,
        affinity: Affinity::Fire, // not Earth → takes Sandstorm chip
        level: 5,
        current_hp: 3, // survives a power=1 hit (deals ≤2), then chip kills it
        max_hp: 16,    // chip = 16/16 = 1, exactly enough to kill at 1 HP after attack
        stats: stat_block(10, 200, 40, 16), // defense=200 absorbs the minimal attack
        known_skill_ids: vec![1],
        status: None,
    };

    // SideB slot 1 (bench backup): healthy, Fire affinity (also non-immune, but never targeted).
    let sideb_slot1 = BattleMonster {
        species_id: 3,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(10, 40, 30, 200),
        known_skill_ids: vec![1],
        status: None,
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![attacker],
        },
        side_b: BattleSide {
            active: 0, // slot 0 is the active target
            team: vec![sideb_slot0, sideb_slot1],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        // Sandstorm active — chip = max_hp/16 fires every turn for each non-immune active.
        weather: Some(WeatherEffect::Sandstorm { turns_remaining: 5 }),
    };

    // Status store: 1 slot on SideA (attacker), 2 slots on SideB (slot 0 + slot 1).
    // Both SideB slots start None — the test asserts they both END None.
    let mut status = BattleStatusStore::new(1, 2);
    let chart = make_type_chart_neutral();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // SideA uses the Burn skill. SideB uses Pass — keeping the scenario focused
    // purely on the A→B Burn application + Sandstorm chip sequence.
    let abilities = AbilityStore::new(1, 2);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 }, // SideA uses Burn skill
        TurnChoice::Pass,                   // SideB does nothing (focused scenario)
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // -----------------------------------------------------------------------
    // Precondition assertions — verify the scenario played out as designed.
    // If these fail, the fixture arithmetic is wrong (not a product bug).
    // -----------------------------------------------------------------------

    // P1: StatusApplied for SideB must have been emitted (A hit B and Burn applied).
    let status_applied_emitted = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });
    assert!(
        status_applied_emitted,
        "14.5b-2 PRECONDITION FAILED: StatusApplied for SideB was not emitted. \
         SideA's Burn skill must hit SideB slot 0 (it has no prior status, and A hits \
         with accuracy_roll=0). If this fails, check burn_applying_skill() and fixture HP. \
         Events: {events:?}"
    );

    // P2: SideB slot 0 must have fainted (from Sandstorm chip after the attack).
    let sideb_fainted = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Faint {
                side: SideId::SideB
            }
        )
    });
    assert!(
        sideb_fainted,
        "14.5b-2 PRECONDITION FAILED: SideB slot 0 did not faint. \
         Slot 0 starts at 3 HP. After a power=1 hit (defense=200 → min ~1 damage) \
         it should have ≤2 HP, then Sandstorm chip (max_hp/16=1) must kill it. \
         Check that Fire affinity is not Sandstorm-immune (Earth is immune, not Fire). \
         SideB slot 0 HP after call: {}. Events: {events:?}",
        state.side_b.team[0].current_hp
    );

    // P3: Auto-switch to SideB slot 1 must have fired (slot 0 fainted, slot 1 exists).
    let switched_to_slot1 = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Switch {
                side: SideId::SideB,
                new_active: 1,
            }
        )
    });
    assert!(
        switched_to_slot1,
        "14.5b-2 PRECONDITION FAILED: auto-switch to SideB slot 1 did not fire. \
         After SideB slot 0 faints, the resolver should auto-switch to slot 1 (the \
         first conscious non-active team member). \
         state.side_b.active after call: {}. Events: {events:?}",
        state.side_b.active
    );

    // -----------------------------------------------------------------------
    // Invariant assertions — the actual RED/GREEN gate for this slice.
    // -----------------------------------------------------------------------

    // INVARIANT A: The targeted slot (SideB slot 0) must NOT have Burn in the store.
    // It was targeted by the Burn skill, but it fainted from Sandstorm chip before
    // Phase 4.5 ran. The fix DROPS the write when current_hp == 0 at Phase 4.5.
    //
    // RED today: current code writes Some(Burn) to status.side_b[0] without
    // checking consciousness. This assertion fails.
    assert_eq!(
        status.side_b[0], None,
        "14.5b-2 FAILED (INVARIANT A): status.side_b[0] is {:?} but must be None. \
         SideB slot 0 was targeted by the Burn skill AND subsequently fainted from \
         Sandstorm chip damage before Phase 4.5 ran. \
         The fix must DROP the StatusApplied write when the targeted slot's \
         current_hp == 0 at Phase 4.5. \
         Kills: any impl that writes Some(Burn) to slot 0 without the consciousness guard.",
        status.side_b[0]
    );

    // INVARIANT B: The auto-switched-in monster (SideB slot 1) must also have None.
    // It was never targeted by any Burn skill — it just happened to be the switch-in.
    // The fix must not redirect the Burn write to slot 1 either.
    //
    // RED today if the fix mistakenly writes to the current active slot instead of
    // dropping: slot 1 (the auto-switch backup) would get Some(Burn). This assertion
    // ensures the fix doesn't "fix" the wrong-slot write by just switching from slot 0
    // to slot 1 — it must DROP the write entirely.
    assert_eq!(
        status.side_b[1], None,
        "14.5b-2 FAILED (INVARIANT B): status.side_b[1] is {:?} but must be None. \
         SideB slot 1 was the auto-switch-in after slot 0 fainted; it was NEVER targeted \
         by any status-applying skill. A naive 'fix' that redirects the StatusApplied write \
         to the current active slot (slot 1) would produce Some(Burn) here. \
         The correct fix DROPS the write entirely when the targeted slot has fainted. \
         Kills: any impl that redirects the Burn write to the auto-switched-in backup.",
        status.side_b[1]
    );

    // Sanity check: SideB slot 0 must actually be fainted (hp == 0) to confirm the
    // consciousness guard had something to check.
    assert_eq!(
        state.side_b.team[0].current_hp, 0,
        "14.5b-2 sanity: SideB slot 0 must have 0 HP after the Sandstorm chip KO; \
         the fixture is malformed if this fails"
    );

    // Sanity check: auto-switch must have moved active to slot 1.
    assert_eq!(
        state.side_b.active, 1,
        "14.5b-2 sanity: SideB active must be 1 (the switch-in) after slot 0's KO; \
         the auto-switch did not fire if this fails"
    );
}

// ===========================================================================
// TEST 3 (EARS 14.5b-3): Both sides apply status in the same turn.
//
// Invariant: when A applies Burn to B (slot 0) AND B applies Poison to A (slot 0)
// in the SAME turn, BOTH StatusApplied events must be emitted and BOTH statuses
// must be written to the store at Phase 4.5.
//
// The concern: `turn_events` contains both events; `run_post_turn_phases` scans
// all of them. This exercises the multi-event path in Phase 4.5.
//
// Kills: any impl that only processes the FIRST `StatusApplied` event, or that
// deduplicates by side (two events for different sides should both fire).
// ===========================================================================
#[test]
fn m14_5b_3_both_sides_apply_status_in_same_turn_both_committed() {
    // SideA (speed=80, faster): uses Burn skill against SideB.
    // SideB (speed=40, slower): uses Poison skill against SideA.
    // Both monsters have large HP and defense so neither faints from the attack.
    // Neither has a prior status, so no-stacking guard does not block.

    fn poison_applying_skill() -> SkillDef {
        SkillDef {
            id: 2,
            name: "Toxic".to_string(),
            affinity: Affinity::Dark,
            power: 1, // minimal power
            accuracy: 100,
            pp: 10,
            sets_weather: None,
            applies_status: Some(crate::combat::ability::StatusKind::Poison),
        }
    }

    let side_a_monster = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 400,
        max_hp: 400,
        stats: stat_block(40, 200, 80, 400), // speed=80 (faster), high defense
        known_skill_ids: vec![1],
        status: None,
    };
    let side_b_monster = BattleMonster {
        species_id: 2,
        affinity: Affinity::Dark,
        level: 5,
        current_hp: 400,
        max_hp: 400,
        stats: stat_block(40, 200, 40, 400), // speed=40 (slower), high defense
        known_skill_ids: vec![2],
        status: None,
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![side_a_monster],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![side_b_monster],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(1, 1);
    let chart = make_type_chart_neutral();
    let variance = always_hit_variance();
    let sv = no_block_sv();
    let skills = vec![burn_applying_skill(), poison_applying_skill()];

    // A uses Burn (skill 1), B uses Poison (skill 2).
    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 }, // A → Burn on B
        TurnChoice::Attack { skill_id: 2 }, // B → Poison on A
        &skills,
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Both StatusApplied events must have been emitted.
    let burn_applied = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                slot: 0,
                status: StatusEffect::Burn,
            }
        )
    });
    let poison_applied = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideA,
                slot: 0,
                status: StatusEffect::Poison,
            }
        )
    });
    assert!(
        burn_applied,
        "14.5b-3 PRECONDITION: StatusApplied(SideB, Burn) must be emitted; \
         events: {events:?}"
    );
    assert!(
        poison_applied,
        "14.5b-3 PRECONDITION: StatusApplied(SideA, Poison) must be emitted; \
         events: {events:?}"
    );

    // Both statuses must be committed to the store by Phase 4.5.
    assert_eq!(
        status.side_b[0],
        Some(StatusEffect::Burn),
        "14.5b-3 FAILED: SideB slot 0 must have Burn in the store after both-sides \
         status turn. Phase 4.5 must process ALL StatusApplied events in turn_events, \
         not just the first one. Kills: any impl that returns after writing the first event."
    );
    assert_eq!(
        status.side_a[0],
        Some(StatusEffect::Poison),
        "14.5b-3 FAILED: SideA slot 0 must have Poison in the store after both-sides \
         status turn. Phase 4.5 must process the second StatusApplied event even when \
         the first event (Burn on B) was already committed."
    );

    // Sanity: both monsters survived (high HP + defense ensures no KO).
    assert_eq!(
        state.outcome,
        BattleOutcome::Ongoing,
        "14.5b-3 sanity: battle must remain Ongoing — both monsters had 400 HP and \
         high defense so neither was KO'd by a power=1 hit"
    );
}

// ===========================================================================
// TEST 4 (EARS 14.5b-4): Slot captured from DEFENDER side — not from attacker.
//
// Invariant: when A (slot 0 active) applies status to B, the emitted
// StatusApplied.slot must be B's active slot (state.side_b.active), NOT
// A's active slot (state.side_a.active).
//
// The concern: an impl might erroneously capture `state.side_a.active` (the
// attacker's slot) instead of `state.side_b.active` (the defender's slot).
//
// This test uses a SideB team with active=1 (non-zero active slot) so that
// confusing attacker vs defender sides produces a detectable wrong value.
//
// Kills: any impl that captures the attacker's active slot instead of the
// defender's active slot for the StatusApplied.slot field.
// ===========================================================================
#[test]
fn m14_5b_4_status_applied_slot_is_defender_slot_not_attacker_slot() {
    // SideA: slot 0 active (attacker). slot must NOT appear in StatusApplied.slot.
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(40, 40, 80, 200), // speed=80, goes first
        known_skill_ids: vec![1],
        status: None,
    };
    // SideB: slot 0 is fainted (0 HP), slot 1 is the active defender.
    // We set side_b.active = 1, so the status must be applied to slot 1.
    let sideb_fainted = BattleMonster {
        species_id: 2,
        affinity: Affinity::Fire,
        level: 1,
        current_hp: 0, // fainted — not active
        max_hp: 10,
        stats: stat_block(10, 40, 10, 10),
        known_skill_ids: vec![1],
        status: None,
    };
    let sideb_active = BattleMonster {
        species_id: 3,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(10, 200, 20, 200), // high defense → survives Burn skill
        known_skill_ids: vec![1],
        status: None,
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0, // attacker at slot 0
            team: vec![attacker],
        },
        side_b: BattleSide {
            active: 1, // DEFENDER at slot 1 (non-zero!)
            team: vec![sideb_fainted, sideb_active],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(1, 2);
    let chart = make_type_chart_neutral();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // SideA uses Burn skill. SideB active is at slot 1.
    let abilities = AbilityStore::new(1, 2);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass, // B does nothing
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // StatusApplied event must carry slot=1 (the defender's actual active slot).
    let applied = events.iter().find(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });
    assert!(
        applied.is_some(),
        "14.5b-4 PRECONDITION: StatusApplied for SideB must be emitted; events: {events:?}"
    );
    match applied.unwrap() {
        BattleEvent::StatusApplied {
            side,
            slot,
            status: st,
        } => {
            assert_eq!(*side, SideId::SideB);
            assert_eq!(
                *slot, 1,
                "14.5b-4 FAILED: StatusApplied.slot must be 1 (SideB's active defender slot), \
                 not 0 (SideA's active attacker slot). \
                 An impl that captures state.side_a.active instead of state.side_b.active \
                 would emit slot=0 here. \
                 Kills: any impl that confuses attacker slot with defender slot."
            );
            assert_eq!(*st, StatusEffect::Burn);
        }
        _ => panic!("expected StatusApplied"),
    }

    // Phase 4.5 must write to slot 1 (the actual target), not slot 0.
    assert_eq!(
        status.side_b[0], None,
        "14.5b-4 FAILED: status.side_b[0] must be None — slot 0 is fainted and was \
         never targeted by the Burn skill."
    );
    assert_eq!(
        status.side_b[1],
        Some(StatusEffect::Burn),
        "14.5b-4 FAILED: status.side_b[1] must be Some(Burn) — slot 1 was the active \
         defender when A's Burn skill hit. Phase 4.5 must write to the slot captured \
         in the event (slot=1), not to state.side_b.active after any subsequent auto-switch."
    );
}

// ===========================================================================
// TEST 5 (EARS 14.5b-5): A KOs B in Phase 2 — only ONE StatusApplied event.
//
// Invariant: when A applies status to B AND KOs B in the same attack, the
// `!fainted` guard in resolve_one_attack must suppress the StatusApplied
// event (applying status to a fainted monster is pointless and should not
// happen). Exactly ZERO StatusApplied events must be emitted.
//
// Also tests: the guard that prevents B from retaliating after being KO'd
// means B's Burn skill never fires, so there is no StatusApplied from B's side.
//
// Kills: any impl that emits StatusApplied even when the target fainted from
// the same attack (fainted guard removed or inverted).
// ===========================================================================
#[test]
fn m14_5b_5_no_status_applied_when_ko_and_status_in_same_hit() {
    // SideA: high attack, Burn skill, speed=80 (faster).
    // SideB: 1 HP — will faint from the Burn hit (even power=1 deals min 1 damage).
    let attacker = BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 5,
        current_hp: 200,
        max_hp: 200,
        stats: stat_block(40, 40, 80, 200), // speed=80
        known_skill_ids: vec![1],
        status: None,
    };
    let fragile_target = BattleMonster {
        species_id: 2,
        affinity: Affinity::Fire,
        level: 1,
        current_hp: 1, // 1 HP — will faint from any hit (min damage = 1)
        max_hp: 1,
        stats: stat_block(10, 1, 20, 1), // defense=1 → guaranteed non-zero damage
        known_skill_ids: vec![1],
        status: None,
    };

    let mut state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: vec![attacker],
        },
        side_b: BattleSide {
            active: 0,
            team: vec![fragile_target],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    let mut status = BattleStatusStore::new(1, 1);
    let chart = make_type_chart_neutral();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // A uses Burn skill. B has 1 HP and will die from the minimum-damage hit.
    // B also uses Burn skill but must not get to attack after being KO'd.
    let abilities = AbilityStore::new(1, 1);
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 }, // A → Burn on B (KOs B)
        TurnChoice::Attack { skill_id: 1 }, // B → Burn on A (must NOT fire — B is KO'd)
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // INVARIANT: No StatusApplied events must be emitted in this turn.
    // A's !fainted guard prevents StatusApplied when the target is KO'd by the same hit.
    // B's KO prevents B from retaliating, so B never gets to emit StatusApplied either.
    let status_applied_count = events
        .iter()
        .filter(|e| matches!(e, BattleEvent::StatusApplied { .. }))
        .count();
    assert_eq!(
        status_applied_count, 0,
        "14.5b-5 FAILED: exactly 0 StatusApplied events must be emitted when A KOs B \
         in the same hit that would apply status (fainted guard suppresses the event), \
         and B never gets to retaliate. Got {status_applied_count} events. Events: {events:?}\n\
         Kills: any impl that emits StatusApplied for a fainted monster, or that lets \
         the KO'd side still attack."
    );

    // Both store slots must remain None (the status was never committed).
    assert_eq!(
        status.side_b[0], None,
        "14.5b-5 FAILED: status.side_b[0] must be None — B was KO'd by the same hit \
         that would have applied Burn. The !fainted guard must prevent the status write."
    );
    assert_eq!(
        status.side_a[0], None,
        "14.5b-5 FAILED: status.side_a[0] must be None — B never got to attack A \
         (B was KO'd by A's first strike; the second_had_faint guard prevented B's turn)."
    );

    // Sanity: SideB must have fainted and the battle must have ended.
    let b_fainted = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Faint {
                side: SideId::SideB
            }
        )
    });
    assert!(
        b_fainted,
        "14.5b-5 sanity: SideB must have fainted from A's minimum-damage hit on a 1-HP target"
    );
    assert_ne!(
        state.outcome,
        BattleOutcome::Ongoing,
        "14.5b-5 sanity: battle must have ended after B's only monster fainted"
    );
}
