//! M14c gating tests — acceptance criteria for the passive ability system slice.
//!
//! Criterion → test mapping:
//!   EARS-1  (StatusKind::matches true)            → ears_1_status_kind_matches_true
//!   EARS-2  (StatusKind::matches false)           → ears_2_status_kind_matches_false_wrong_variant
//!   EARS-3  (StatusKind::Sleep any turns)         → ears_3_status_kind_sleep_matches_any_turns_remaining
//!   EARS-4  (EntryHeal heals HP)                  → ears_4_entry_heal_restores_hp
//!   EARS-5  (EntryHeal no overheal)               → ears_5_entry_heal_does_not_overheal
//!   EARS-6  (EntryHeal skip fainted)              → ears_6_entry_heal_skips_fainted_monster
//!   EARS-7  (EntryHeal skip full HP)              → ears_7_entry_heal_skips_full_hp_monster
//!   EARS-8  (StatusImmunity clears matching)      → ears_8_entry_ability_status_immunity_clears_matching
//!   EARS-9  (StatusImmunity keeps non-matching)   → ears_9_entry_ability_status_immunity_keeps_non_matching
//!   EARS-10 (no ability is no-op)                 → ears_10_entry_ability_none_is_noop
//!   EARS-11 (per-turn immunity clears matching)   → ears_11_modifiers_clears_immunity_matching_status
//!   EARS-12 (per-turn immunity keeps other)       → ears_12_modifiers_keeps_non_matching_status
//!   EARS-13 (validate duplicate id)               → ears_13_validate_abilities_rejects_duplicate_id
//!   EARS-14 (validate denom < 2)                  → ears_14_validate_abilities_rejects_entry_heal_denom_below_2
//!   EARS-15 (validate dangling species ability)   → ears_15_validate_abilities_rejects_dangling_species_ref
//!   EARS-16 (validate accepts valid data)         → ears_16_validate_abilities_accepts_valid_data
//!   EARS-17 (parse_abilities RON)                 → ears_17_parse_abilities_parses_core_ron
//!   EARS-18 (load_abilities loads 3 items)        → ears_18_load_abilities_returns_three_items
//!   EARS-19 (Species ability defaults to None)    → ears_19_species_ability_field_defaults_to_none
//!   EARS-20 (EntryHeal minimum heal is 1)         → ears_20_entry_heal_minimum_heal_is_1

use crate::combat::ability::{
    apply_ability_modifiers, apply_entry_ability, AbilityEffect, AbilityStore, StatusKind,
};
use crate::combat::status::BattleStatusStore;
use crate::combat::types::{
    BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, StatusEffect,
};
use crate::content::{parse_abilities, parse_species, validate_abilities, AbilityDef, Species};
use crate::monster::types::{Affinity, StatBlock};

// ---------------------------------------------------------------------------
// Fixture helpers
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

/// Build a BattleMonster with the given HP values and status.
fn make_monster(current_hp: u16, max_hp: u16, status: Option<StatusEffect>) -> BattleMonster {
    BattleMonster {
        species_id: 1,
        affinity: Affinity::Fire,
        level: 10,
        current_hp,
        max_hp,
        stats: make_stat_block(),
        known_skill_ids: vec![1],
        status,
    }
}

/// Build a BattleState with a single monster on each side.
fn make_state(monster_a: BattleMonster, monster_b: BattleMonster) -> BattleState {
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
    }
}

/// Build a minimal valid AbilityDef.
fn make_ability_def(id: u32, effect: AbilityEffect) -> AbilityDef {
    AbilityDef {
        id,
        name: format!("Ability{id}"),
        effect,
    }
}

/// Build a minimal valid Species with ability=None.
fn make_species(id: u32, ability: Option<u32>) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: make_stat_block(),
        affinity: Affinity::Water,
        learnable_skill_ids: vec![1],
        ability,
    }
}

// ===========================================================================
// EARS-1: StatusKind::matches returns true for exact variant
//
// Kills: an impl that inverts the result, returns false for exact matches,
// or misroutes the Burn↔Burn pair to a false arm.
// ===========================================================================

#[test]
fn ears_1_status_kind_matches_true() {
    assert!(
        StatusKind::Burn.matches(&StatusEffect::Burn),
        "TEETH (EARS-1): StatusKind::Burn.matches(&StatusEffect::Burn) must be true; \
         an impl that inverts the return or routes Burn→Burn to the wildcard false arm fails here"
    );
}

// ===========================================================================
// EARS-2: StatusKind::matches returns false for wrong variant
//
// Kills: an impl that always returns true, or uses type-erasure that ignores
// the variant discriminant.
// ===========================================================================

#[test]
fn ears_2_status_kind_matches_false_wrong_variant() {
    assert!(
        !StatusKind::Burn.matches(&StatusEffect::Poison),
        "TEETH (EARS-2): StatusKind::Burn.matches(&StatusEffect::Poison) must be false; \
         an impl that always returns true (or uses a wildcard true arm) fails here"
    );
}

// ===========================================================================
// EARS-3: StatusKind::Sleep matches Sleep with any turns_remaining
//
// Kills: an impl that requires turns_remaining == 0, or matches on the payload
// value rather than the variant tag.
// ===========================================================================

#[test]
fn ears_3_status_kind_sleep_matches_any_turns_remaining() {
    assert!(
        StatusKind::Sleep.matches(&StatusEffect::Sleep { turns_remaining: 3 }),
        "TEETH (EARS-3): StatusKind::Sleep must match Sleep{{turns_remaining:3}}; \
         an impl that pattern-matches the exact payload (e.g. turns_remaining==0 guard) fails here"
    );
    assert!(
        StatusKind::Sleep.matches(&StatusEffect::Sleep { turns_remaining: 1 }),
        "TEETH (EARS-3): StatusKind::Sleep must match Sleep{{turns_remaining:1}} (any value)"
    );
    assert!(
        !StatusKind::Sleep.matches(&StatusEffect::Freeze),
        "TEETH (EARS-3): StatusKind::Sleep must NOT match Freeze \
         (cross-check that `..` wildcard doesn't accept all variants)"
    );
}

// ===========================================================================
// EARS-4: apply_entry_ability EntryHeal restores HP
//
// Monster at 50/100 HP + EntryHeal(denom:4) → heals 100/4=25 → 75 HP.
//
// Kills: an impl that heals nothing, heals the wrong amount, or skips the
// EntryHeal branch entirely.
// ===========================================================================

#[test]
fn ears_4_entry_heal_restores_hp() {
    let monster_a = make_monster(50, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        75,
        "TEETH (EARS-4): monster at 50/100 HP with EntryHeal(denom:4) must heal \
         100/4=25 HP to reach 75; an impl that skips EntryHeal or heals nothing leaves HP=50"
    );
}

// ===========================================================================
// EARS-5: apply_entry_ability EntryHeal does NOT overheal past max_hp
//
// Monster at 95/100 HP + EntryHeal(denom:4) → heal=25 but clamp to max=100.
//
// Kills: an impl that uses saturating_add without the min(max_hp) clamp.
// ===========================================================================

#[test]
fn ears_5_entry_heal_does_not_overheal() {
    let monster_a = make_monster(95, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        100,
        "TEETH (EARS-5): monster at 95/100 HP with EntryHeal(denom:4) must cap at 100 (max_hp); \
         an impl that adds heal without clamping would overshoot to 120"
    );
}

// ===========================================================================
// EARS-6: apply_entry_ability EntryHeal does NOT heal a fainted monster
//
// Monster at 0/100 HP (is_fainted()==true) → HP stays 0 after hook.
//
// Kills: an impl that heals fainted monsters, bringing them back from 0 HP.
// ===========================================================================

#[test]
fn ears_6_entry_heal_skips_fainted_monster() {
    let monster_a = make_monster(0, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        0,
        "TEETH (EARS-6): a fainted monster (current_hp=0) must NOT be healed by EntryHeal; \
         an impl missing the is_fainted() guard would raise HP to 25 — kills that impl"
    );
}

// ===========================================================================
// EARS-7: apply_entry_ability EntryHeal does NOT heal a full-HP monster
//
// Monster at 100/100 HP → HP stays 100 (current_hp < max_hp guard fails).
//
// Kills: an impl that heals unconditionally or uses `<=` instead of `<`.
// ===========================================================================

#[test]
fn ears_7_entry_heal_skips_full_hp_monster() {
    let monster_a = make_monster(100, 100, None);
    let monster_b = make_monster(80, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        100,
        "TEETH (EARS-7): a full-HP monster (current_hp==max_hp) must NOT be healed; \
         an impl that heals unconditionally would leave HP=100 (capped), but the \
         guard must prevent any mutation — this is also a no-op correctness check"
    );
}

// ===========================================================================
// EARS-8: apply_entry_ability StatusImmunity clears matching status on entry
//
// Monster has Burn in status store, ability = StatusImmunity(Burn). After
// entry hook, side_a[0] must be None.
//
// Kills: an impl that only applies immunity per-turn but skips the entry clear,
// or that compares by equality instead of using StatusKind::matches.
// ===========================================================================

#[test]
fn ears_8_entry_ability_status_immunity_clears_matching() {
    let monster_a = make_monster(100, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::StatusImmunity {
        immune_to: StatusKind::Burn,
    });

    let mut status = BattleStatusStore::new(1, 1);
    status.side_a[0] = Some(StatusEffect::Burn);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        status.side_a[0],
        None,
        "TEETH (EARS-8): StatusImmunity(Burn) on entry must clear Burn from status store; \
         an impl that only applies the per-turn hook (not the entry hook) leaves Burn in slot — fails here"
    );
}

// ===========================================================================
// EARS-9: apply_entry_ability StatusImmunity does NOT clear non-matching status
//
// Monster has Poison in status store, ability = StatusImmunity(Burn). After
// entry hook, Poison must remain.
//
// Kills: an impl that clears all status on entry (ignoring the immune_to check).
// ===========================================================================

#[test]
fn ears_9_entry_ability_status_immunity_keeps_non_matching() {
    let monster_a = make_monster(100, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::StatusImmunity {
        immune_to: StatusKind::Burn,
    });

    let mut status = BattleStatusStore::new(1, 1);
    status.side_a[0] = Some(StatusEffect::Poison);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        status.side_a[0],
        Some(StatusEffect::Poison),
        "TEETH (EARS-9): StatusImmunity(Burn) must NOT clear Poison on entry; \
         an impl that unconditionally clears any status in the slot fails here"
    );
}

// ===========================================================================
// EARS-10: apply_entry_ability with no ability in store is a no-op
//
// AbilityStore::new(1,1) → all None. Must not panic, HP unchanged.
//
// Kills: an impl that panics on None ability, or that mutates HP spuriously.
// ===========================================================================

#[test]
fn ears_10_entry_ability_none_is_noop() {
    let monster_a = make_monster(75, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let abilities = AbilityStore::new(1, 1); // all None
    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        75,
        "TEETH (EARS-10): apply_entry_ability with no ability must leave HP unchanged; \
         an impl that heals unconditionally regardless of ability presence fails here"
    );
}

// ===========================================================================
// EARS-11: apply_ability_modifiers clears immunity-matching status per-turn
//
// Monster in side_a active slot has StatusImmunity(Burn), status store has
// Burn. After apply_ability_modifiers, status slot is None.
//
// Kills: an impl that only applies immunity on entry (not per-turn), or one
// that skips the per-turn modifier check.
// ===========================================================================

#[test]
fn ears_11_modifiers_clears_immunity_matching_status() {
    let monster_a = make_monster(100, 100, None);
    let monster_b = make_monster(100, 100, None);
    let state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::StatusImmunity {
        immune_to: StatusKind::Burn,
    });

    let mut status = BattleStatusStore::new(1, 1);
    status.side_a[0] = Some(StatusEffect::Burn);

    apply_ability_modifiers(&state, &mut status, &abilities);

    assert_eq!(
        status.side_a[0], None,
        "TEETH (EARS-11): apply_ability_modifiers with StatusImmunity(Burn) must clear \
         Burn from the active slot; an impl that omits the per-turn hook (only wires \
         apply_entry_ability) leaves Burn in place — this assertion kills it"
    );
}

// ===========================================================================
// EARS-12: apply_ability_modifiers does NOT touch non-matching status
//
// Monster has StatusImmunity(Burn), status has Poison. Poison remains after call.
//
// Kills: an impl that clears all status on every turn regardless of immune_to.
// ===========================================================================

#[test]
fn ears_12_modifiers_keeps_non_matching_status() {
    let monster_a = make_monster(100, 100, None);
    let monster_b = make_monster(100, 100, None);
    let state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::StatusImmunity {
        immune_to: StatusKind::Burn,
    });

    let mut status = BattleStatusStore::new(1, 1);
    status.side_a[0] = Some(StatusEffect::Poison);

    apply_ability_modifiers(&state, &mut status, &abilities);

    assert_eq!(
        status.side_a[0],
        Some(StatusEffect::Poison),
        "TEETH (EARS-12): apply_ability_modifiers with StatusImmunity(Burn) must NOT clear \
         Poison — Poison is not what the ability is immune to; \
         an impl that clears any status regardless of immune_to fails here"
    );
}

// ===========================================================================
// EARS-13: validate_abilities rejects duplicate ability id
//
// Two AbilityDefs both with id=1 → Err(...).
//
// Kills: an impl that silently ignores duplicate ids (e.g. using a HashMap
// that overwrites without checking).
// ===========================================================================

#[test]
fn ears_13_validate_abilities_rejects_duplicate_id() {
    let abilities = vec![
        make_ability_def(
            1,
            AbilityEffect::StatusImmunity {
                immune_to: StatusKind::Burn,
            },
        ),
        make_ability_def(
            1,
            AbilityEffect::StatusImmunity {
                immune_to: StatusKind::Poison,
            },
        ),
    ];
    let species: Vec<Species> = vec![];

    let result = validate_abilities(&abilities, &species);

    assert!(
        result.is_err(),
        "TEETH (EARS-13): validate_abilities must reject two AbilityDefs with the same id=1; \
         an impl using HashMap::insert without duplicate checking silently drops one and returns Ok"
    );
}

// ===========================================================================
// EARS-14: validate_abilities rejects EntryHeal denom < 2
//
// AbilityDef with EntryHeal(denom:1) → Err(...) (denom 0/1 = free full-heal).
//
// Kills: an impl that only validates denom==0 (not denom==1), or one that
// doesn't validate denom at all.
// ===========================================================================

#[test]
fn ears_14_validate_abilities_rejects_entry_heal_denom_below_2() {
    let abilities_denom_1 = vec![make_ability_def(1, AbilityEffect::EntryHeal { denom: 1 })];
    let species: Vec<Species> = vec![];

    let result = validate_abilities(&abilities_denom_1, &species);
    assert!(
        result.is_err(),
        "TEETH (EARS-14a): validate_abilities must reject EntryHeal{{denom:1}}; \
         denom=1 grants a free full-heal on entry — an impl that only rejects denom==0 passes 1 through"
    );

    let abilities_denom_0 = vec![make_ability_def(1, AbilityEffect::EntryHeal { denom: 0 })];
    let result_0 = validate_abilities(&abilities_denom_0, &species);
    assert!(
        result_0.is_err(),
        "TEETH (EARS-14b): validate_abilities must also reject EntryHeal{{denom:0}}; \
         denom=0 would cause division-by-zero or unconditional full-heal"
    );

    // denom=2 is exactly the threshold — must be accepted.
    let abilities_denom_2 = vec![make_ability_def(1, AbilityEffect::EntryHeal { denom: 2 })];
    let result_2 = validate_abilities(&abilities_denom_2, &species);
    assert!(
        result_2.is_ok(),
        "TEETH (EARS-14c): validate_abilities must accept EntryHeal{{denom:2}} (the minimum valid value); \
         an impl with a strict > 2 boundary incorrectly rejects denom=2"
    );
}

// ===========================================================================
// EARS-15: validate_abilities rejects species with dangling ability id
//
// Species has ability: Some(99), no AbilityDef with id=99 → Err(...).
//
// Kills: an impl that validates the ability registry in isolation without
// cross-checking species references.
// ===========================================================================

#[test]
fn ears_15_validate_abilities_rejects_dangling_species_ref() {
    let abilities = vec![make_ability_def(
        1,
        AbilityEffect::StatusImmunity {
            immune_to: StatusKind::Freeze,
        },
    )];
    let species = vec![make_species(42, Some(99))]; // species 42 references ability 99 — doesn't exist

    let result = validate_abilities(&abilities, &species);

    assert!(
        result.is_err(),
        "TEETH (EARS-15): validate_abilities must reject a species referencing non-existent \
         ability id=99 when only id=1 is defined; \
         an impl that validates only the abilities list (not species cross-refs) returns Ok here"
    );
}

// ===========================================================================
// EARS-16: validate_abilities accepts valid data
//
// Valid abilities + species with ability:None and ability:Some(1) → Ok(()).
//
// Kills: an impl that always returns Err, or that incorrectly flags valid
// data as invalid.
// ===========================================================================

#[test]
fn ears_16_validate_abilities_accepts_valid_data() {
    let abilities = vec![
        make_ability_def(
            1,
            AbilityEffect::StatusImmunity {
                immune_to: StatusKind::Burn,
            },
        ),
        make_ability_def(2, AbilityEffect::EntryHeal { denom: 4 }),
    ];
    let species = vec![
        make_species(1, None),    // no ability
        make_species(2, Some(1)), // references ability id=1 (exists)
        make_species(3, Some(2)), // references ability id=2 (exists)
    ];

    let result = validate_abilities(&abilities, &species);

    assert!(
        result.is_ok(),
        "TEETH (EARS-16): validate_abilities must return Ok(()) for valid data; \
         got Err: {:?}",
        result.err()
    );
}

// ===========================================================================
// EARS-17: parse_abilities parses embedded RON correctly
//
// Parse the literal 000-core.ron content. Must yield 3 entries with exact
// values: id=1 "Flame Body" StatusImmunity(Burn), id=3 "Regeneration" EntryHeal(4).
//
// Kills: an impl that parses a different struct shape, ignores fields, or
// returns a different count.
// ===========================================================================

#[test]
fn ears_17_parse_abilities_parses_core_ron() {
    // This is the verbatim content of content/abilities/000-core.ron.
    let ron_str = r#"[
    (
        id: 1,
        name: "Flame Body",
        effect: StatusImmunity(immune_to: Burn),
    ),
    (
        id: 2,
        name: "Vital Spirit",
        effect: StatusImmunity(immune_to: Sleep),
    ),
    (
        id: 3,
        name: "Regeneration",
        effect: EntryHeal(denom: 4),
    ),
]"#;

    let abilities = parse_abilities(ron_str).expect(
        "TEETH (EARS-17): parse_abilities must parse the 3-entry abilities RON without error",
    );

    assert_eq!(
        abilities.len(),
        3,
        "TEETH (EARS-17): parsed abilities must contain exactly 3 entries; \
         an impl that truncates or skips entries would return a different count"
    );

    // First entry: id=1 "Flame Body" StatusImmunity(Burn)
    assert_eq!(
        abilities[0].id, 1,
        "TEETH (EARS-17): first ability must have id=1"
    );
    assert_eq!(
        abilities[0].name, "Flame Body",
        "TEETH (EARS-17): first ability must be named 'Flame Body'"
    );
    assert_eq!(
        abilities[0].effect,
        AbilityEffect::StatusImmunity {
            immune_to: StatusKind::Burn
        },
        "TEETH (EARS-17): first ability must have effect StatusImmunity(Burn); \
         an impl that parses the wrong StatusKind or wrong effect variant fails here"
    );

    // Third entry: id=3 "Regeneration" EntryHeal(denom:4)
    assert_eq!(
        abilities[2].id, 3,
        "TEETH (EARS-17): third ability must have id=3"
    );
    assert_eq!(
        abilities[2].name, "Regeneration",
        "TEETH (EARS-17): third ability must be named 'Regeneration'"
    );
    assert_eq!(
        abilities[2].effect,
        AbilityEffect::EntryHeal { denom: 4 },
        "TEETH (EARS-17): third ability must have effect EntryHeal{{denom:4}}; \
         an impl that parses a wrong denom (e.g. 0 or 1) or wrong variant fails here"
    );
}

// ===========================================================================
// EARS-18: load_abilities loads content without error
//
// load_abilities() must return Ok with exactly 3 items (matching the one
// file in content/abilities/ with 3 entries).
//
// Kills: an impl where build.rs does not embed the abilities dir, where the
// embedded constant is empty, or where parse fails at load time.
// ===========================================================================

#[test]
fn ears_18_load_abilities_returns_three_items() {
    let abilities = crate::content::load_abilities().expect(
        "TEETH (EARS-18): load_abilities() must succeed; \
                 failing here means the ABILITIES_RON_PARTS static is missing or parse fails",
    );

    assert_eq!(
        abilities.len(),
        3,
        "TEETH (EARS-18): load_abilities() must return exactly 3 abilities (the 000-core.ron content); \
         a wrong count means build.rs embedded the wrong files or the RON was truncated"
    );
}

// ===========================================================================
// EARS-19: Species with no ability field defaults to None
//
// Parse species RON that omits the `ability` field. Must deserialize with
// ability: None (via #[serde(default)]).
//
// Kills: an impl that adds the `ability` field WITHOUT #[serde(default)],
// which would cause a deserialization error when the field is absent.
// ===========================================================================

#[test]
fn ears_19_species_ability_field_defaults_to_none() {
    // This mirrors what the existing species RON files look like — they do NOT
    // have an `ability` field. The #[serde(default)] attr must make this parse.
    let ron_str = r#"[
    (
        id: 1,
        name: "Flameling",
        base_stats: (hp: 45, attack: 49, defense: 49, speed: 65, sp_attack: 65, sp_defense: 45),
        affinity: Fire,
        learnable_skill_ids: [1, 2],
    ),
]"#;

    let species_list = parse_species(ron_str).expect(
        "TEETH (EARS-19): parse_species must succeed even when the `ability` field is absent; \
                 a missing #[serde(default)] causes a deserialization error here",
    );

    assert_eq!(
        species_list.len(),
        1,
        "TEETH (EARS-19): must parse exactly 1 species"
    );
    assert_eq!(
        species_list[0].ability, None,
        "TEETH (EARS-19): species parsed without an `ability` field must default to None; \
         any other value means the default is wrong or the field was incorrectly initialized"
    );
}

// ===========================================================================
// EARS-20: EntryHeal minimum heal is 1
//
// Monster at 1/100 HP, EntryHeal(denom:u16::MAX). The computed heal is
// (100 / u16::MAX as u32).max(1) = (0).max(1) = 1. HP must become 2.
//
// Kills: an impl that uses integer division without the .max(1) floor,
// which would compute heal=0 and leave HP=1 unchanged.
// ===========================================================================

#[test]
fn ears_20_entry_heal_minimum_heal_is_1() {
    // max_hp=100, denom=u16::MAX → 100 / 65535 = 0 → max(1) = 1 → new HP = 2.
    let monster_a = make_monster(1, 100, None);
    let monster_b = make_monster(100, 100, None);
    let mut state = make_state(monster_a, monster_b);

    let mut abilities = AbilityStore::new(1, 1);
    abilities.side_a[0] = Some(AbilityEffect::EntryHeal { denom: u16::MAX });

    let mut status = BattleStatusStore::new(1, 1);

    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);

    assert_eq!(
        state.side_a.active_monster().current_hp,
        2,
        "TEETH (EARS-20): EntryHeal with denom=u16::MAX on 1/100 HP must heal exactly 1 \
         (minimum floor) reaching HP=2; an impl without .max(1) computes heal=0 and leaves \
         HP=1 unchanged — this assertion kills that impl"
    );
}
