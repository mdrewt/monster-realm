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

use crate::combat::ability::StatusKind;
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
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
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

    // SideA uses the Burn skill. SideB slot 0 also uses the same skill (irrelevant —
    // B's attack fires after A's, by which point B is still alive when A hits, then
    // B acts next, but B's attack on A doesn't affect the invariant we're testing).
    // We use TurnChoice::Pass for SideB so B doesn't attack A at all, keeping the
    // test focused purely on the Burn-application + Sandstorm-chip sequence.
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 }, // SideA uses Burn skill
        TurnChoice::Pass,                   // SideB does nothing (focused scenario)
        &[burn_applying_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
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
