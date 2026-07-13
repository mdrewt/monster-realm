//! M14e gating tests — acceptance criteria for the M14e status-curing items +
//! client battle-event display slice.
//!
//! ALL tests start RED (compile error OR runtime failure) because the following
//! do not exist yet:
//!   - `BattleEvent::StatusApplied { side: SideId, status: StatusEffect }` variant
//!   - `SkillDef.applies_status: Option<StatusKind>` field
//!   - `ItemDef.cure_status: Option<StatusKind>` field
//!   - Status-application logic in `resolve_full_turn` / `resolve_one_attack`
//!   - No-stack guard in `resolve_full_turn`
//!   - Post-turn StatusApplied application to BattleStatusStore
//!
//! Criterion → test mapping:
//!   EARS-1  (variant exists)          → status_applied_event_exists
//!   EARS-2  (skill default)           → skill_def_applies_status_field_defaults_to_none
//!   EARS-3  (skill parse)             → skill_def_applies_status_field_parses_some_burn
//!   EARS-4  (item default)            → item_def_cure_status_field_defaults_to_none
//!   EARS-5  (item parse)              → item_def_cure_status_field_parses_some_poison
//!   EARS-6  (emitted on hit)          → status_applied_emitted_when_skill_hits_unstatused_target
//!   EARS-7  (not emitted on miss)     → status_applied_not_emitted_on_miss
//!   EARS-8  (not on already statused) → status_applied_not_emitted_when_target_already_statused
//!   EARS-9  (both sides get status)   → status_applied_not_stacked_same_turn_by_two_attacks
//!   EARS-10 (next-turn DoT only)      → status_applied_next_turn_dot_not_same_turn
//!   EARS-11 (M7 regression)           → m14e_m7_regression_plain_attack_identical_events

use crate::combat::ability::StatusKind;
use crate::combat::resolve::resolve_full_turn;
use crate::combat::status::{BattleStatusStore, StatusEffect, StatusVariance};
use crate::combat::type_chart::tests::make_type_chart;
use crate::combat::types::{
    BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, TurnChoice,
    TurnVariance,
};
use crate::content::{ItemDef, SkillDef};
use crate::monster::types::{Affinity, StatBlock};

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

/// A plain-attack skill with NO applies_status (the "plain attack" fixture).
///
/// Kills: any code that treats the default `None` applies_status as if it were Some.
fn plain_fire_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 25,
        sets_weather: None,
        // M14e adds this field. Red before implementation: struct literal will
        // complain "missing field `applies_status`" until the field is added.
        applies_status: None,
    }
}

/// A skill that always hits and applies Poison to the target.
fn poison_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Poison Sting".to_string(),
        affinity: Affinity::Dark,
        power: 35,
        accuracy: 100,
        pp: 35,
        sets_weather: None,
        applies_status: Some(StatusKind::Poison),
    }
}

/// A skill that ALWAYS MISSES (accuracy = 0 means accuracy_check always fails).
fn always_miss_skill() -> SkillDef {
    SkillDef {
        id: 1,
        name: "Wild Swing".to_string(),
        affinity: Affinity::Fire,
        power: 60,
        // accuracy: 1 (minimum valid content value); combined with always_miss_variance()
        // (accuracy_roll_a: 99) guarantees a miss without using content-invalid 0.
        accuracy: 1,
        pp: 10,
        sets_weather: None,
        applies_status: Some(StatusKind::Burn),
    }
}

/// All rolls guarantee hits, A attacks first.
fn always_hit_variance() -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 0,
        accuracy_roll_b: 0,
        speed_tie_breaker: true, // A goes first on tie
    }
}

/// Always-miss variance (accuracy_roll at 99, accuracy must be > 99 to hit — impossible).
fn always_miss_variance() -> TurnVariance {
    TurnVariance {
        damage_roll_a: 100,
        damage_roll_b: 100,
        accuracy_roll_a: 99,
        accuracy_roll_b: 99,
        speed_tie_breaker: true,
    }
}

/// StatusVariance with no blocking and no thaw (clean baseline).
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

fn empty_status() -> BattleStatusStore {
    BattleStatusStore::new(1, 1)
}

// ---------------------------------------------------------------------------
// TEST 1 (EARS-1): BattleEvent::StatusApplied variant exists and is constructible
//
// This is a COMPILE-TIME gate. If the variant does not exist, this entire
// test module fails to compile — the desired red state.
//
// Kills: an impl that ships the slice without adding the StatusApplied variant.
// ---------------------------------------------------------------------------

/// Kills: any impl that omits `BattleEvent::StatusApplied { side, slot, status }` —
/// the struct literal below fails to compile if the variant or its fields are absent.
#[test]
fn status_applied_event_exists() {
    // Construct the variant — compile-RED if the variant or any field is absent.
    let ev = BattleEvent::StatusApplied {
        side: SideId::SideA,
        slot: 0,
        status: StatusEffect::Poison,
    };

    // Exhaustive destructuring — NO wildcard. Fails to compile if fields change.
    match &ev {
        BattleEvent::StatusApplied { side, slot, status } => {
            assert_eq!(
                *side,
                SideId::SideA,
                "StatusApplied side must round-trip through construction"
            );
            assert_eq!(
                *slot, 0,
                "TEETH: StatusApplied.slot must be 0 as constructed; \
                 a missing or mistyped field means the event cannot carry the target slot"
            );
            assert_eq!(
                *status,
                StatusEffect::Poison,
                "TEETH: StatusApplied.status must be Poison as constructed; \
                 a missing or mistyped field means the variant cannot carry status data"
            );
        }
        _ => panic!("must match StatusApplied variant"),
    }

    // Verify serde round-trip preserves all three fields.
    let s = ron::to_string(&ev).unwrap();
    let back: BattleEvent = ron::from_str(&s).unwrap();
    assert_eq!(
        ev, back,
        "TEETH: StatusApplied must survive serde round-trip with all three fields intact; \
         a field marked #[serde(skip)] would lose the status, slot, or side on deserialize"
    );
}

// ---------------------------------------------------------------------------
// TEST 2 (EARS-2): SkillDef.applies_status defaults to None (additive compat)
//
// A SkillDef parsed from RON without the `applies_status` field must have
// `applies_status = None`. This is the #[serde(default)] contract.
//
// Kills: an impl that adds the field WITHOUT #[serde(default)], breaking
// all existing skill RON files that lack the field.
// ---------------------------------------------------------------------------

/// Kills: an impl that adds `applies_status` to SkillDef WITHOUT `#[serde(default)]` —
/// parsing old RON that lacks the field would return a deserialization error instead
/// of defaulting to None, breaking all existing skill content.
#[test]
fn skill_def_applies_status_field_defaults_to_none() {
    // Hand-crafted RON that intentionally omits `applies_status` — this is what
    // all existing skill RON files look like before M14e.
    let old_skill_ron = r#"(
        id: 1,
        name: "Ember",
        affinity: Fire,
        power: 40,
        accuracy: 100,
        pp: 25
    )"#;

    let skill: SkillDef = ron::from_str(old_skill_ron).expect(
        "TEETH: #[serde(default)] must allow a SkillDef missing `applies_status`; \
         without the attribute this returns a deserialization error, breaking all \
         existing skill RON files — this test catches it",
    );

    assert_eq!(
        skill.applies_status, None,
        "TEETH: SkillDef parsed without `applies_status` field must default to None; \
         an impl without #[serde(default)] would either error (caught above) or default \
         to Some value unexpectedly — any non-None value here is wrong"
    );
}

// ---------------------------------------------------------------------------
// TEST 3 (EARS-3): SkillDef.applies_status parses Some(Burn) correctly
//
// A SkillDef with `applies_status: Some(Burn)` in RON must parse to
// `Some(StatusKind::Burn)`. Tests the happy-path serde for the new field.
//
// Kills: an impl where applies_status is present but always ignores the value
// (e.g. always returns None), or one where StatusKind::Burn doesn't map correctly.
// ---------------------------------------------------------------------------

/// Kills: an impl where the `applies_status` field parses but the `Some(Burn)` value
/// is silently discarded (e.g. via a custom Deserialize that always returns None),
/// or where the RON string `Some(Burn)` doesn't map to `StatusKind::Burn`.
#[test]
fn skill_def_applies_status_field_parses_some_burn() {
    let ron_str = r#"(
        id: 2,
        name: "Scorch",
        affinity: Fire,
        power: 55,
        accuracy: 85,
        pp: 15,
        applies_status: Some(Burn)
    )"#;

    let skill: SkillDef = ron::from_str(ron_str)
        .expect("SkillDef with applies_status: Some(Burn) must parse without error");

    assert_eq!(
        skill.applies_status,
        Some(StatusKind::Burn),
        "TEETH: `applies_status: Some(Burn)` in RON must parse to Some(StatusKind::Burn); \
         an impl that ignores the field value or always returns None fails here. \
         This is the primary content-pipeline test: skill authors must be able to \
         author skills that apply status via RON data."
    );

    // Re-parse the same RON to verify deserialization is idempotent (no Serialize needed).
    let back: SkillDef = ron::from_str(ron_str).unwrap();
    assert_eq!(
        back.applies_status,
        Some(StatusKind::Burn),
        "TEETH: applies_status=Some(Burn) must parse consistently on a second pass; \
         a non-idempotent deserializer or one that returns None on re-parse is broken"
    );
}

// ---------------------------------------------------------------------------
// TEST 4 (EARS-4): ItemDef.cure_status defaults to None (additive compat)
//
// An ItemDef parsed from RON without the `cure_status` field must have
// `cure_status = None`. This is the #[serde(default)] contract.
//
// Kills: an impl that adds `cure_status` to ItemDef WITHOUT `#[serde(default)]`.
// ---------------------------------------------------------------------------

/// Kills: an impl that adds `cure_status` to ItemDef WITHOUT `#[serde(default)]` —
/// parsing old item RON that lacks the field would break, making the entire item
/// registry unloadable. The red state: ItemDef doesn't have `cure_status` yet.
#[test]
fn item_def_cure_status_field_defaults_to_none() {
    // Hand-crafted RON without cure_status — matches all existing item RON files.
    let old_item_ron = r#"(
        id: 1,
        name: "Bait",
        description: "Increases recruit chance.",
        recruit_bonus: 100
    )"#;

    let item: ItemDef = ron::from_str(old_item_ron).expect(
        "TEETH: #[serde(default)] must allow an ItemDef missing `cure_status`; \
         without the attribute this returns a deserialization error, breaking all \
         existing item RON content",
    );

    assert_eq!(
        item.cure_status, None,
        "TEETH: ItemDef parsed without `cure_status` field must default to None; \
         any non-None value here means the default is wrong or the field is not \
         properly optional"
    );
}

// ---------------------------------------------------------------------------
// TEST 5 (EARS-5): ItemDef.cure_status parses Some(Poison) correctly
//
// An ItemDef with `cure_status: Some(Poison)` in RON must parse to
// `Some(StatusKind::Poison)`. Tests the happy-path serde for the new field.
//
// Kills: an impl where cure_status is present but always returns None.
// ---------------------------------------------------------------------------

/// Kills: an impl where `cure_status: Some(Poison)` in RON is silently discarded
/// (e.g. always None), or where StatusKind::Poison doesn't map correctly.
#[test]
fn item_def_cure_status_field_parses_some_poison() {
    let ron_str = r#"(
        id: 10,
        name: "Antidote",
        description: "Cures poison.",
        cure_status: Some(Poison)
    )"#;

    let item: ItemDef = ron::from_str(ron_str)
        .expect("ItemDef with cure_status: Some(Poison) must parse without error");

    assert_eq!(
        item.cure_status,
        Some(StatusKind::Poison),
        "TEETH: `cure_status: Some(Poison)` in RON must parse to Some(StatusKind::Poison); \
         an impl that ignores the field value or always returns None fails here. \
         This is the critical path for use_battle_item to know which status an item cures."
    );

    // Re-parse the same RON to verify deserialization is idempotent.
    let back: ItemDef = ron::from_str(ron_str).unwrap();
    assert_eq!(
        back.cure_status,
        Some(StatusKind::Poison),
        "TEETH: cure_status=Some(Poison) must parse consistently on a second pass"
    );
}

// ---------------------------------------------------------------------------
// TEST 6 (EARS-6): StatusApplied emitted when a status-applying skill hits an
// unstatused, non-fainted target.
//
// Scenario: Side A uses Poison Sting (applies_status=Some(Poison)) against a
// healthy Side B with no status. resolve_full_turn → events must contain
// StatusApplied { side: SideB, status: Poison }.
//
// Kills: an impl that ignores `applies_status` entirely (no StatusApplied emitted),
// or one that only applies status but forgets to emit the event.
// ---------------------------------------------------------------------------

/// Kills: an impl that ignores `applies_status` on SkillDef — no StatusApplied
/// event is emitted even when a status-applying skill hits a clean target.
/// Also kills: an impl that applies the status to the store but forgets the event.
#[test]
fn status_applied_emitted_when_skill_hits_unstatused_target() {
    let chart = make_type_chart();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    // Side A is faster and uses the poison skill. Side B has no status.
    let monster_a = make_monster(Affinity::Dark, 200, 80); // faster
    let monster_b = make_monster(Affinity::Fire, 200, 40); // slower
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = empty_status();

    // Side A uses poison skill; Side B uses plain attack (no status application).
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // A StatusApplied event for SideB (the target of Side A's poison skill)
    // must appear in the events.
    let status_applied_for_b = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                status: StatusEffect::Poison,
                ..
            }
        )
    });

    assert!(
        status_applied_for_b,
        "TEETH (EARS-6): resolve_full_turn with a Poison-applying skill hitting a \
         clean target MUST emit StatusApplied{{side:SideB, status:Poison}}. \
         An impl that ignores applies_status produces no such event — this assertion \
         kills it. An impl that writes to the store but omits the event also fails."
    );
}

// ---------------------------------------------------------------------------
// TEST 7 (EARS-7): StatusApplied NOT emitted when the skill misses.
//
// Scenario: Side A uses an always-miss skill with applies_status=Some(Burn).
// The accuracy check fails → Miss event is emitted, NO StatusApplied.
//
// Kills: an impl that emits StatusApplied regardless of whether the attack hit
// (forgetting to check the accuracy gate before applying status).
// ---------------------------------------------------------------------------

/// Kills: an impl that emits StatusApplied even when the skill misses — an
/// accuracy=0 skill must produce only a Miss event, never StatusApplied.
#[test]
fn status_applied_not_emitted_on_miss() {
    let chart = make_type_chart();
    let variance = always_miss_variance(); // accuracy_roll=99 → fails accuracy=0 check
    let sv = no_block_sv();

    let monster_a = make_monster(Affinity::Fire, 200, 80);
    let monster_b = make_monster(Affinity::Water, 200, 40);
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = empty_status();

    // always_miss_skill has applies_status=Some(Burn) AND accuracy=0
    // accuracy_check(0, 99) → false → Miss event, attack never lands.
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[always_miss_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // A Miss event must appear for Side A (A goes first per speed_tie_breaker=true).
    let has_miss = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::Miss {
                side: SideId::SideA
            }
        )
    });
    assert!(
        has_miss,
        "TEETH: an always-miss skill must produce a Miss event for SideA; \
         if no Miss appears, the fixture itself is broken"
    );

    // NO StatusApplied of any kind must appear in the events.
    let has_status_applied = events
        .iter()
        .any(|e| matches!(e, BattleEvent::StatusApplied { .. }));

    assert!(
        !has_status_applied,
        "TEETH (EARS-7): StatusApplied must NOT be emitted when the skill misses; \
         an impl that checks applies_status BEFORE the accuracy gate emits \
         StatusApplied even on Miss — this assertion kills such an impl. \
         Got events: {events:?}"
    );
}

// ---------------------------------------------------------------------------
// TEST 8 (EARS-8): StatusApplied NOT emitted when the target is already statused.
//
// Scenario: Side B already has Burn. Side A uses a Poison-applying skill.
// → No StatusApplied for SideB (no stacking). The pre-existing Burn remains.
//
// Kills: an impl that overwrites the existing status and emits StatusApplied
// (status stacking is not allowed per spec).
// ---------------------------------------------------------------------------

/// Kills: an impl that overwrites an existing status and emits StatusApplied —
/// the target's Burn must not be replaced by Poison, and no event must fire.
#[test]
fn status_applied_not_emitted_when_target_already_statused() {
    let chart = make_type_chart();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    let monster_a = make_monster(Affinity::Dark, 200, 80); // faster
    let monster_b = make_monster(Affinity::Fire, 200, 40); // already has Burn
    let mut state = make_battle_state(monster_a, monster_b);

    // Pre-set SideB active slot to Burn.
    let mut status = BattleStatusStore::new(1, 1);
    status.side_b[0] = Some(StatusEffect::Burn);

    // Side A uses poison skill. B is already Burned — no Poison StatusApplied.
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass,
        &[poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // No StatusApplied for SideB (already statused).
    let poison_applied_to_b = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });

    assert!(
        !poison_applied_to_b,
        "TEETH (EARS-8): StatusApplied must NOT be emitted when the target already \
         has a status (no stacking). An impl that overwrites Burn with Poison and emits \
         StatusApplied fails here. The pre-existing Burn must be left untouched. \
         Got events: {events:?}"
    );

    // The pre-existing Burn status must still be intact in the store.
    assert_eq!(
        status.side_b[0],
        Some(StatusEffect::Burn),
        "TEETH: SideB's pre-existing Burn status must remain unchanged when a \
         Poison-applying skill hits it (no stacking allowed); \
         an impl that overwrites the status would set this to Poison"
    );
}

// ---------------------------------------------------------------------------
// TEST 9 (EARS-9): Both sides receive their respective status when both use
// status-applying skills in the same turn.
//
// Scenario: Side A uses Poison Sting (speed 80, faster). Side B uses a Burn
// skill (speed 40, slower). Both hit. After resolve_full_turn:
// - StatusApplied { side: SideB, status: Poison } (from A's attack on B)
// - StatusApplied { side: SideA, status: Burn }   (from B's attack on A, B DIDN'T faint)
//
// Kills: an impl that only processes status application for the first attacker,
// or one that skips the second attacker's status because of a premature short-circuit.
// ---------------------------------------------------------------------------

/// Kills: an impl that only applies status for the first (faster) attacker —
/// the slower attacker's status application is silently skipped.
#[test]
fn status_applied_independently_both_sides_same_turn() {
    let chart = make_type_chart();
    let variance = TurnVariance {
        damage_roll_a: 85, // minimum damage roll to avoid KO
        damage_roll_b: 85,
        accuracy_roll_a: 0, // always hits
        accuracy_roll_b: 0,
        speed_tie_breaker: true,
    };
    let sv = no_block_sv();

    // High HP so neither side faints from the other's attack.
    let monster_a = make_monster(Affinity::Dark, 5000, 80); // faster
    let monster_b = make_monster(Affinity::Dark, 5000, 40); // slower

    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = empty_status();

    // Side A uses Poison Sting (applies Poison).
    // Side B also uses Poison Sting (applies Poison to A — we use same skill id).
    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // A attacks B first (A faster) → StatusApplied { side: SideB, status: Poison }
    let poison_on_b = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                status: StatusEffect::Poison,
                ..
            }
        )
    });

    // B attacks A second → StatusApplied { side: SideA, status: Poison }
    // (B now has Poison from A's attack, but that doesn't block B's own attack)
    // After A applies Poison to B, B is already statused, so B's own poison
    // application to A should still work (A has no status yet).
    let poison_on_a = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideA,
                status: StatusEffect::Poison,
                ..
            }
        )
    });

    assert!(
        poison_on_b,
        "TEETH (EARS-9): Side A's Poison Sting must apply Poison to Side B \
         and emit StatusApplied{{side:SideB, status:Poison}}. \
         Got events: {events:?}"
    );

    assert!(
        poison_on_a,
        "TEETH (EARS-9): Side B's Poison Sting must apply Poison to Side A \
         (A has no status when B attacks) and emit StatusApplied{{side:SideA, status:Poison}}. \
         An impl that only processes the faster side's status application fails here. \
         Got events: {events:?}"
    );
}

// ---------------------------------------------------------------------------
// TEST 10 (EARS-10): StatusApplied is stored in BattleStatusStore, but no DoT
// fires in the SAME turn (DoT starts NEXT turn).
//
// Scenario: Side A hits Side B with a Poison-applying skill. After resolve_full_turn:
// - status.side_b[0] == Some(Poison) (the status was committed to the store)
// - NO StatusDamage event for SideB in this turn's events (DoT is next turn)
//
// Kills: an impl that applies StatusApplied events to the store BEFORE phase 3
// (DoT), which would incorrectly make the freshly-applied status deal DoT in the
// same turn it was applied (violates the "next turn DoT" spec rule).
// ---------------------------------------------------------------------------

/// Kills: an impl that applies newly-acquired statuses to the BattleStatusStore
/// BEFORE the post-turn DoT phase — the freshly-applied Poison would deal DoT
/// in the same turn it was applied (same-turn DoT is wrong per spec).
#[test]
fn status_applied_next_turn_dot_not_same_turn() {
    let chart = make_type_chart();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    let monster_a = make_monster(Affinity::Dark, 5000, 80); // faster
    let monster_b = make_monster(Affinity::Fire, 5000, 40); // target
    let mut state = make_battle_state(monster_a, monster_b);
    let mut status = empty_status();

    let events = resolve_full_turn(
        &mut state,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Pass,
        &[poison_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    // The StatusApplied event must appear (status was applied this turn).
    let has_status_applied = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusApplied {
                side: SideId::SideB,
                ..
            }
        )
    });
    assert!(
        has_status_applied,
        "TEETH: StatusApplied{{side:SideB}} must appear this turn \
         (the status was applied by the Poison Sting); \
         if this fails, the status-application logic is broken"
    );

    // The status must now be in the store (committed for next turn's DoT).
    assert!(
        status.side_b[0].is_some(),
        "TEETH (EARS-10): BattleStatusStore.side_b[0] must be Some(Poison) after \
         apply — the status must be committed to the store so next turn's DoT fires. \
         An impl that emits the event but doesn't commit to the store fails here."
    );

    // NO StatusDamage for SideB in THIS turn's events (DoT is next turn, not this turn).
    let same_turn_dot = events.iter().any(|e| {
        matches!(
            e,
            BattleEvent::StatusDamage {
                side: SideId::SideB,
                ..
            }
        )
    });

    assert!(
        !same_turn_dot,
        "TEETH (EARS-10): StatusDamage for SideB must NOT appear in the SAME turn \
         the status was applied. Newly-applied status should start DoT NEXT turn only. \
         An impl that applies StatusApplied events to the store BEFORE the post-turn DoT \
         phase incorrectly deals DoT on the turn of application — this assertion catches it. \
         Got events: {events:?}"
    );
}

// ---------------------------------------------------------------------------
// TEST 11 (EARS-11): M7 regression — resolve_full_turn with a plain-attack
// skill (no applies_status) and empty BattleStatusStore + no weather produces
// IDENTICAL events to resolve_turn called directly.
//
// This ensures the M14e status-application layer is truly additive: when no
// applies_status skills are in play, the event pipeline is unchanged.
//
// Kills: an impl where the M14e logic injects extra StatusApplied events for
// plain-attack skills (applies_status = None).
// ---------------------------------------------------------------------------

/// Kills: an impl where the M14e status-application phase emits StatusApplied
/// events even for skills with `applies_status = None` — this would produce extra
/// events compared to bare resolve_turn, breaking the regression contract.
#[test]
fn m14e_m7_regression_plain_attack_identical_events() {
    use crate::combat::resolve::resolve_turn;

    let chart = make_type_chart();
    let variance = always_hit_variance();
    let sv = no_block_sv();

    let monster_a = make_monster(Affinity::Fire, 200, 80);
    let monster_b = make_monster(Affinity::Water, 200, 40);

    let mut state_direct = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut state_full = make_battle_state(monster_a.clone(), monster_b.clone());
    let mut status = empty_status();

    // Direct resolve_turn call (baseline — no status layer, no M14e logic).
    let events_direct = resolve_turn(
        &mut state_direct,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[plain_fire_skill()],
        &chart,
        &variance,
    );

    // resolve_full_turn with empty status and plain-attack skill (no applies_status).
    let events_full = resolve_full_turn(
        &mut state_full,
        TurnChoice::Attack { skill_id: 1 },
        TurnChoice::Attack { skill_id: 1 },
        &[plain_fire_skill()],
        &chart,
        &variance,
        &mut status,
        &sv,
    );

    assert_eq!(
        events_full, events_direct,
        "TEETH (EARS-11 / M7 regression): resolve_full_turn with a plain-attack skill \
         (applies_status=None) and empty BattleStatusStore must produce IDENTICAL events \
         to bare resolve_turn. The M14e status-application layer must be a true no-op \
         when applies_status is None — emitting extra StatusApplied events for plain \
         attacks violates this regression contract."
    );

    assert_eq!(
        state_full, state_direct,
        "TEETH (EARS-11 / M7 regression): resulting BattleState must be identical \
         after resolve_full_turn vs resolve_turn with a plain-attack skill; \
         the M14e layer must not mutate state when applies_status is None"
    );
}
