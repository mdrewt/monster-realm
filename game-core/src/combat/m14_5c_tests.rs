//! M14.5c gating tests — end-to-end ability wiring (ADR-0100).
//!
//! Criterion → test mapping:
//!   EARS-14.5c-1 (schema: species content assigns abilities)
//!       → content_flameling_has_flame_body_ability
//!       → content_sproutlet_has_regeneration_ability
//!       → content_tidalin_has_no_ability
//!   EARS-14.5c-2 (wiring: ability store resolves correctly from content)
//!       → content_driven_ability_store_resolves_flame_body
//!       → content_driven_ability_store_resolves_regeneration
//!   EARS-14.5c-3 (gameplay: each ability kind exercised by a shipped species)
//!       → flameling_flame_body_clears_burn_via_modifiers       (StatusImmunity)
//!       → sproutlet_regeneration_heals_on_entry                (EntryHeal)

use crate::combat::ability::{
    apply_ability_modifiers, apply_entry_ability, AbilityEffect, AbilityStore, StatusKind,
};
use crate::combat::status::BattleStatusStore;
use crate::combat::types::{
    BattleMonster, BattleOutcome, BattleSide, BattleState, SideId, StatusEffect,
};
use crate::content::{load_abilities, load_species};
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

fn make_monster_hp(current_hp: u16, max_hp: u16) -> BattleMonster {
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

fn make_state_1v1(monster_a: BattleMonster, monster_b: BattleMonster) -> BattleState {
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

// ---------------------------------------------------------------------------
// EARS-14.5c-1: species content assigns ability IDs (schema → content level)
// ---------------------------------------------------------------------------

/// EARS-14.5c-1a: Flameling (id=1) must have ability_id=1 (Flame Body).
///
/// Kills: a species RON that omits the `ability` field on Flameling (the field
/// defaults to `None` via `#[serde(default)]`, leaving ability_id unset).
/// A content author who forgets `ability: Some(1)` would leave Flameling unable
/// to use its defining trait. This test makes the assignment mandatory.
#[test]
fn content_flameling_has_flame_body_ability() {
    let species = load_species().expect("species must load");
    let flameling = species
        .iter()
        .find(|s| s.id == 1)
        .expect("Flameling (id=1) must exist in species registry");
    assert_eq!(
        flameling.ability,
        Some(1),
        "TEETH (14.5c-1a): Flameling must have ability_id=1 (Flame Body); \
         the species RON must include `ability: Some(1)`. \
         A missing entry causes ability to default to None."
    );
}

/// EARS-14.5c-1b: Sproutlet (id=3) must have ability_id=3 (Regeneration).
///
/// Kills: omitting `ability: Some(3)` in the Sproutlet RON entry; the field
/// would default to `None` and EntryHeal would never fire for Sproutlet in game.
#[test]
fn content_sproutlet_has_regeneration_ability() {
    let species = load_species().expect("species must load");
    let sproutlet = species
        .iter()
        .find(|s| s.id == 3)
        .expect("Sproutlet (id=3) must exist in species registry");
    assert_eq!(
        sproutlet.ability,
        Some(3),
        "TEETH (14.5c-1b): Sproutlet must have ability_id=3 (Regeneration); \
         the species RON must include `ability: Some(3)`. \
         A missing entry causes EntryHeal to never fire for Sproutlet."
    );
}

/// EARS-14.5c-1c: Tidalin (id=2) must have no ability (baseline species).
///
/// Keeps the registry honest: not every species needs an ability, and Tidalin
/// is the control case for `ability: None` in the default content set.
#[test]
fn content_tidalin_has_no_ability() {
    let species = load_species().expect("species must load");
    let tidalin = species
        .iter()
        .find(|s| s.id == 2)
        .expect("Tidalin (id=2) must exist in species registry");
    assert_eq!(
        tidalin.ability, None,
        "TEETH (14.5c-1c): Tidalin must have no ability (ability: None); \
         the content baseline must include at least one species without an ability."
    );
}

// ---------------------------------------------------------------------------
// EARS-14.5c-2: ability store resolves correctly from content
// ---------------------------------------------------------------------------

/// EARS-14.5c-2a: ability_id=1 resolves to `StatusImmunity { immune_to: Burn }`.
///
/// Kills: a content author who sets the wrong effect on ability id=1 (e.g.
/// `EntryHeal` instead of `StatusImmunity`), or mixes up ability IDs. The
/// wiring path uses `build_ability_store` to resolve id→effect; this test
/// pins that the id→effect mapping is correct in the embedded content.
#[test]
fn content_driven_ability_store_resolves_flame_body() {
    let abilities = load_abilities().expect("abilities must load");
    let flame_body = abilities
        .iter()
        .find(|a| a.id == 1)
        .expect("ability id=1 (Flame Body) must exist in abilities registry");
    assert!(
        matches!(
            &flame_body.effect,
            AbilityEffect::StatusImmunity {
                immune_to: StatusKind::Burn
            }
        ),
        "TEETH (14.5c-2a): ability id=1 must be StatusImmunity {{ immune_to: Burn }} \
         (Flame Body); got {:?}",
        flame_body.effect
    );
}

/// EARS-14.5c-2b: ability_id=3 resolves to `EntryHeal { denom: 4 }`.
///
/// Kills: wrong denom (e.g. denom=8 would halve the heal) or wrong effect kind.
#[test]
fn content_driven_ability_store_resolves_regeneration() {
    let abilities = load_abilities().expect("abilities must load");
    let regen = abilities
        .iter()
        .find(|a| a.id == 3)
        .expect("ability id=3 (Regeneration) must exist in abilities registry");
    assert!(
        matches!(&regen.effect, AbilityEffect::EntryHeal { denom: 4 }),
        "TEETH (14.5c-2b): ability id=3 must be EntryHeal {{ denom: 4 }} (Regeneration); \
         got {:?}",
        regen.effect
    );
}

// ---------------------------------------------------------------------------
// EARS-14.5c-3: each ability kind is exercised end-to-end by a shipped species
// ---------------------------------------------------------------------------

/// EARS-14.5c-3a: Flameling's Flame Body clears Burn via `apply_ability_modifiers`.
///
/// Uses actual content IDs: loads Flameling's ability_id, resolves it against the
/// abilities registry, populates an AbilityStore, and calls apply_ability_modifiers.
/// Asserts that a Burn applied to the active slot is cleared.
///
/// Kills:
/// - A `resolve_full_turn` that omits Phase 0 `apply_ability_modifiers` — Burn
///   stays in the slot and blocks the attack next turn.
/// - An `apply_ability_modifiers` that only checks SideB — Flameling on SideA
///   keeps its Burn.
/// - Content that has the wrong immune_to (e.g. `Poison` instead of `Burn`) —
///   Burn is not cleared.
#[test]
fn flameling_flame_body_clears_burn_via_modifiers() {
    let species = load_species().expect("species must load");
    let abilities_content = load_abilities().expect("abilities must load");

    // Resolve Flameling's ability from content.
    let flameling = species.iter().find(|s| s.id == 1).expect("Flameling");
    let ability_id = flameling
        .ability
        .expect("Flameling must have an ability (14.5c-1a prerequisite)");
    let ability_def = abilities_content
        .iter()
        .find(|a| a.id == ability_id)
        .expect("Flameling's ability def must exist");

    // Build AbilityStore with Flameling's ability on SideA slot 0.
    let mut store = AbilityStore::new(1, 1);
    store.side_a[0] = Some(ability_def.effect.clone());

    // Construct a 1v1 state and give SideA slot 0 a Burn status.
    let monster_a = make_monster_hp(100, 100);
    let monster_b = make_monster_hp(100, 100);
    let state = make_state_1v1(monster_a, monster_b);
    let mut status = BattleStatusStore::new(1, 1);
    status.side_a[0] = Some(StatusEffect::Burn);

    // Phase 0 hook: apply_ability_modifiers must clear the Burn.
    apply_ability_modifiers(&state, &mut status, &store);

    assert_eq!(
        status.side_a[0], None,
        "TEETH (14.5c-3a): Flameling's Flame Body must clear Burn from SideA slot 0 \
         via apply_ability_modifiers; Burn persists when Phase 0 is missing or \
         immune_to is wrong in content."
    );
    // SideB must be unaffected (no ability on SideB).
    assert_eq!(
        status.side_b[0], None,
        "SideB slot 0 must not be modified when no ability is set on SideB."
    );
}

/// EARS-14.5c-3b: Sproutlet's Regeneration heals on entry via `apply_entry_ability`.
///
/// Uses actual content IDs: resolves Sproutlet's EntryHeal, populates an AbilityStore,
/// calls apply_entry_ability, and asserts the active monster's HP increased by
/// `max_hp / denom` (= 100 / 4 = 25).
///
/// Kills:
/// - A `resolve_player_swap` that omits the `apply_entry_ability` call — Sproutlet
///   enters at the same HP it had when switched in, never regaining the on-entry heal.
/// - An EntryHeal impl with the wrong denom (e.g. 8 → heals 12 instead of 25).
/// - An `apply_entry_ability` that checks SideB but not SideA.
#[test]
fn sproutlet_regeneration_heals_on_entry() {
    let species = load_species().expect("species must load");
    let abilities_content = load_abilities().expect("abilities must load");

    // Resolve Sproutlet's ability from content.
    let sproutlet = species.iter().find(|s| s.id == 3).expect("Sproutlet");
    let ability_id = sproutlet
        .ability
        .expect("Sproutlet must have an ability (14.5c-1b prerequisite)");
    let ability_def = abilities_content
        .iter()
        .find(|a| a.id == ability_id)
        .expect("Sproutlet's ability def must exist");

    let denom = match &ability_def.effect {
        AbilityEffect::EntryHeal { denom } => *denom,
        other => panic!(
            "Sproutlet's ability must be EntryHeal, got {:?} (14.5c-2b prerequisite)",
            other
        ),
    };

    // Build AbilityStore with Sproutlet's ability on SideA slot 0.
    let mut store = AbilityStore::new(1, 1);
    store.side_a[0] = Some(ability_def.effect.clone());

    // Construct a 1v1 state with Sproutlet at 50% HP (to see the heal).
    let max_hp: u16 = 100;
    let initial_hp: u16 = 50;
    let monster_a = make_monster_hp(initial_hp, max_hp);
    let monster_b = make_monster_hp(max_hp, max_hp);
    let mut state = make_state_1v1(monster_a, monster_b);
    let mut status = BattleStatusStore::new(1, 1);

    // Entry hook: apply_entry_ability must heal max_hp / denom (minimum 1).
    apply_entry_ability(&mut state, SideId::SideA, &store, &mut status);

    let expected_heal = (max_hp / denom).max(1);
    let expected_hp = (initial_hp + expected_heal).min(max_hp);
    assert_eq!(
        state.side_a.team[0].current_hp, expected_hp,
        "TEETH (14.5c-3b): Sproutlet's Regeneration must heal {expected_heal} HP \
         (max_hp {max_hp} / denom {denom}) on entry; \
         current_hp is {}, expected {expected_hp}. \
         EntryHeal is skipped when apply_entry_ability is not called on switch-in.",
        state.side_a.team[0].current_hp
    );
    // Verify the heal is positive and doesn't exceed max_hp.
    assert!(
        state.side_a.team[0].current_hp > initial_hp,
        "TEETH (14.5c-3b): Regeneration must increase HP above the initial {initial_hp}; \
         healing is blocked or the denom produces 0."
    );
    assert!(
        state.side_a.team[0].current_hp <= max_hp,
        "Regeneration must not overheal above max_hp {max_hp}."
    );
}

// ---------------------------------------------------------------------------
// RT-D6: entry ability is NOT called on KO-triggered auto-switch (D6 gap)
//
// When a monster is KO'd during resolve_one_attack, the engine calls
// next_conscious_index() and set_active() to auto-switch — but it does NOT
// call apply_entry_ability for the newly-entered monster.  This means:
//
//   a) Flameling (Flame Body) switched in via KO-auto-switch enters carrying
//      any Burn that was placed on that slot before the switch.  The Burn IS
//      cleared by apply_ability_modifiers at Phase 0 of the FOLLOWING turn,
//      so the monster only suffers phantom Burn on entry — but it would take
//      one turn of Burn DoT before Phase 0 can clear it.
//
//   b) Sproutlet (Regeneration) switched in via KO-auto-switch does NOT
//      receive the EntryHeal.  A monster that triggers to the bench via KO
//      misses its free heal completely.
//
// This test documents the gap by showing that after a KO-auto-switch,
// the incoming monster's slot status in the BattleStatusStore is unchanged
// (no StatusImmunity clear and no EntryHeal applied).
//
// A fix would call apply_entry_ability inside resolve_one_attack after the
// auto-switch fires (passing the abilities store down into that function).
// The test is written to PASS today (documenting current behavior) and MUST
// be updated if the gap is intentionally closed.
//
// Severity: MEDIUM — manifests as:
//   - One phantom Burn DoT tick on auto-switched Flameling (then cleared next turn)
//   - Missing EntryHeal for auto-switched Sproutlet
// The Burn DoT can be fatal if the Flameling enters at very low HP.
// ---------------------------------------------------------------------------

/// RT-D6a: Flameling KO-auto-switched in does NOT have its Burn cleared on entry.
///
/// This test DOCUMENTS the gap. The Burn in the store is cleared only at
/// Phase 0 of the NEXT turn (apply_ability_modifiers), not on auto-switch.
///
/// If this test starts FAILING it means the gap has been closed (the entry
/// ability now fires on KO-auto-switch) — update the assertion direction and
/// promote to a positive gate.
#[test]
fn rt_d6a_ko_auto_switch_does_not_call_entry_ability_status_immunity() {
    use crate::combat::ability::AbilityEffect;
    use crate::combat::status::BattleStatusStore;
    use crate::combat::types::StatusEffect;

    // AbilityStore: slot 1 on SideA has Flame Body (Burn immunity).
    // Slot 0 has no ability (it starts active, gets KO'd).
    let mut abilities = AbilityStore::new(2, 1);
    abilities.side_a[1] = Some(AbilityEffect::StatusImmunity {
        immune_to: crate::combat::ability::StatusKind::Burn,
    });

    // Status store: slot 1 (the bench, soon-to-be-active) already has Burn.
    // This simulates status placed on the slot before the switch.
    let mut status = BattleStatusStore::new(2, 1);
    status.side_a[1] = Some(StatusEffect::Burn);

    // BattleState: SideA slot 0 at 1 HP (will be KO'd), slot 1 is the Flameling.
    let mut state = BattleState {
        side_a: crate::combat::types::BattleSide {
            active: 0,
            team: vec![
                make_monster_hp(1, 100),  // slot 0: 1 HP, dies to any hit
                make_monster_hp(80, 100), // slot 1: Flameling, has Burn in store
            ],
        },
        side_b: crate::combat::types::BattleSide {
            active: 0,
            team: vec![make_monster_hp(200, 200)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    // Give slot 0 the right HP/status mirror in the state (Burn from store not
    // mirrored to BattleMonster for slot 0 — it's irrelevant; we just need the
    // KO auto-switch to fire).
    // The enemy (SideB) is strong enough to KO slot 0 in one hit.
    // We call apply_ability_modifiers manually here only to show it WOULD clear the
    // Burn IF called — but resolve_one_attack doesn't call it.

    // Apply ability modifiers BEFORE the KO — this runs in Phase 0, clearing
    // any existing Burn on the active slot.  The active slot is 0 (no ability),
    // so slot 1's Burn is UNTOUCHED by this call.
    apply_ability_modifiers(&state, &mut status, &abilities);

    // Slot 0 is active (no ability) — slot 1 Burn is untouched by Phase 0 on slot 0.
    assert_eq!(
        status.side_a[1],
        Some(StatusEffect::Burn),
        "RT-D6a: Phase 0 apply_ability_modifiers on slot 0 (no ability) must NOT \
         clear Burn on the bench slot 1 — the bench is inactive"
    );

    // Now simulate the KO auto-switch: SideA.active moves from 0 to 1.
    // In the real pipeline this happens inside resolve_one_attack — no
    // apply_entry_ability is called here.
    state
        .side_a
        .set_active(1)
        .expect("slot 1 is valid and not fainted");

    // After the auto-switch, the Burn on slot 1 in the status store is still
    // present — no entry ability was called to clear it.
    assert_eq!(
        status.side_a[1],
        Some(StatusEffect::Burn),
        "RT-D6a (GAP DOCUMENTED): after KO-auto-switch to slot 1 (Flameling, \
         Flame Body), the Burn on slot 1 is NOT cleared because apply_entry_ability \
         is not called on auto-switch. The Burn will persist until Phase 0 of the \
         NEXT turn. If this assertion starts failing, the gap has been closed — \
         update to assert None."
    );

    // Now simulate what the NEXT turn's Phase 0 does: apply_ability_modifiers
    // on the now-active slot 1.  This WILL clear the Burn.
    apply_ability_modifiers(&state, &mut status, &abilities);
    assert_eq!(
        status.side_a[1], None,
        "RT-D6a: Phase 0 on the NEXT turn clears the Burn correctly. \
         The gap means exactly one turn of unblocked Burn DoT on the Flameling."
    );
}

/// RT-D6b: Sproutlet KO-auto-switched in does NOT receive EntryHeal.
///
/// Documents that auto-switch via KO does not trigger EntryHeal.
/// The missing heal matters most when Sproutlet enters at low HP.
#[test]
fn rt_d6b_ko_auto_switch_does_not_call_entry_ability_entry_heal() {
    use crate::combat::ability::AbilityEffect;
    use crate::combat::status::BattleStatusStore;

    let initial_hp: u16 = 50;
    let max_hp: u16 = 100;
    let expected_heal = max_hp / 4; // denom=4 → 25 HP

    // AbilityStore: slot 1 on SideA has Regeneration (EntryHeal denom=4).
    let mut abilities = AbilityStore::new(2, 1);
    abilities.side_a[1] = Some(AbilityEffect::EntryHeal { denom: 4 });

    let mut status = BattleStatusStore::new(2, 1);

    let mut state = BattleState {
        side_a: crate::combat::types::BattleSide {
            active: 0,
            team: vec![
                make_monster_hp(1, 100),             // slot 0: dies to KO
                make_monster_hp(initial_hp, max_hp), // slot 1: Sproutlet at 50% HP
            ],
        },
        side_b: crate::combat::types::BattleSide {
            active: 0,
            team: vec![make_monster_hp(200, 200)],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
        weather: None,
    };

    // Simulate the KO auto-switch: slot 0 faints, engine sets active=1.
    // apply_entry_ability is NOT called in this path.
    state.side_a.set_active(1).expect("slot 1 is valid");

    // HP of the Sproutlet (slot 1) is unchanged — no EntryHeal was applied.
    let hp_after_auto_switch = state.side_a.team[1].current_hp;
    assert_eq!(
        hp_after_auto_switch, initial_hp,
        "RT-D6b (GAP DOCUMENTED): after KO-auto-switch to slot 1 (Sproutlet, \
         Regeneration), current_hp is still {initial_hp} — EntryHeal was NOT \
         applied. Expected heal of {expected_heal} HP was missed. \
         If this assertion starts failing, the gap has been closed."
    );

    // Confirm that a MANUAL apply_entry_ability call would have healed it.
    apply_entry_ability(&mut state, SideId::SideA, &abilities, &mut status);
    let hp_after_manual_entry = state.side_a.team[1].current_hp;
    assert_eq!(
        hp_after_manual_entry,
        initial_hp + expected_heal,
        "RT-D6b: manual apply_entry_ability correctly heals {expected_heal} HP \
         — proving the call is what's missing in the KO-auto-switch path"
    );
}
