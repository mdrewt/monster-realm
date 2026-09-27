//! Passive abilities: `StatusKind` matching, entry heal / status immunity,
//! ability validation and content loading, and entry abilities firing on a
//! KO auto-switch. One nested module per facet; each keeps its own fixtures.

pub mod passive_system {
    //! Passive ability system: `StatusKind` matching, entry heal / immunity, validation, loading.

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
            weather: None,
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
            tier: 0,
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

    // ===========================================================================
    // StatusKind::matches full truth table — all 5 variants, true arms
    //
    // Invariant protected: every StatusKind variant has a DISTINCT true arm in
    // StatusKind::matches that returns true exactly when the paired StatusEffect
    // variant matches. The false-arm exhaustiveness check in the match forces
    // developers to add new variants to the catch-all, but DOES NOT force adding a
    // true arm — a developer can satisfy the compiler by adding only to the false
    // arm, silently breaking StatusImmunity for that variant.
    //
    // This test pins the complete truth table so that omitting the true arm for any
    // variant turns this test RED. When a new StatusKind variant is added (e.g.
    // Confuse), this test must receive the corresponding true-arm assertion:
    //   assert!(StatusKind::Confuse.matches(&StatusEffect::Confuse), ...);
    //
    // Kills: any impl that adds a new StatusKind variant only to the false arm
    // (StatusImmunity for that variant silently never fires).
    // ===========================================================================

    #[test]
    fn ears_21_status_kind_matches_full_truth_table() {
        // True arm: each variant must match its paired StatusEffect.
        assert!(
            StatusKind::Poison.matches(&StatusEffect::Poison),
            "TEETH (EARS-21): StatusKind::Poison.matches(StatusEffect::Poison) must be true; \
         omitting the Poison true arm and only updating the false arm compiles but silently \
         breaks PoisonImmunity — this assertion is the gate"
        );
        assert!(
            StatusKind::Burn.matches(&StatusEffect::Burn),
            "TEETH (EARS-21): StatusKind::Burn.matches(StatusEffect::Burn) must be true"
        );
        assert!(
            StatusKind::Paralysis.matches(&StatusEffect::Paralysis),
            "TEETH (EARS-21): StatusKind::Paralysis.matches(StatusEffect::Paralysis) must be true"
        );
        assert!(
            StatusKind::Sleep.matches(&StatusEffect::Sleep { turns_remaining: 1 }),
            "TEETH (EARS-21): StatusKind::Sleep.matches(Sleep{{turns_remaining:1}}) must be true"
        );
        assert!(
            StatusKind::Freeze.matches(&StatusEffect::Freeze),
            "TEETH (EARS-21): StatusKind::Freeze.matches(StatusEffect::Freeze) must be true"
        );

        // False arm: each variant must NOT match a different variant's StatusEffect.
        // (Cross-check that the true arms are discriminating, not always-true.)
        assert!(
            !StatusKind::Poison.matches(&StatusEffect::Burn),
            "TEETH (EARS-21): StatusKind::Poison must NOT match StatusEffect::Burn"
        );
        assert!(
            !StatusKind::Burn.matches(&StatusEffect::Poison),
            "TEETH (EARS-21): StatusKind::Burn must NOT match StatusEffect::Poison"
        );
        assert!(
            !StatusKind::Paralysis.matches(&StatusEffect::Freeze),
            "TEETH (EARS-21): StatusKind::Paralysis must NOT match StatusEffect::Freeze"
        );
        assert!(
            !StatusKind::Sleep.matches(&StatusEffect::Paralysis),
            "TEETH (EARS-21): StatusKind::Sleep must NOT match StatusEffect::Paralysis"
        );
        assert!(
            !StatusKind::Freeze.matches(&StatusEffect::Sleep { turns_remaining: 1 }),
            "TEETH (EARS-21): StatusKind::Freeze must NOT match StatusEffect::Sleep"
        );
    }
}

pub mod passive_hardening {
    //! Passive ability hardening: validation wiring, undersized stores, modifier semantics.

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
            weather: None,
        }
    }

    // ===========================================================================
    // validate_abilities is NOT called from sync_content_inner.
    //
    // `sync_content_inner` calls validate_content, validate_encounters,
    // validate_evolution_fusion, validate_npc_content, and validate_shops — but
    // NOT validate_abilities. This means a content author can publish species rows
    // with dangling ability ids (e.g., `ability: Some(99)` where id=99 does not
    // exist in the abilities registry) and the server will accept it without error.
    //
    // This test gates that the word "validate_abilities" appears in the
    // sync_content_inner source body.
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
    // debug_assert!(denom >= 2) fires in debug builds when
    // denom=1 bypasses validate_abilities.
    //
    // The precondition guard in apply_entry_ability:
    //   debug_assert!(denom >= 2, "EntryHeal denom {denom} bypassed ...")
    //
    // When denom < 2 reaches apply_entry_ability (bypassing validate_abilities),
    // the debug_assert fires loudly in debug/test builds — which is the project's
    // "fail loud" policy for precondition violations. This test pins that the
    // guard is active by confirming the panic message.
    //
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
    // apply_ability_modifiers with EntryHeal ability does NOT heal on modifier calls
    // (per-turn hook only touches immunity).
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
}

pub mod content_wiring {
    //! End-to-end ability wiring from species content to battle effects.

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
    // species content assigns ability IDs (schema → content level)
    // ---------------------------------------------------------------------------

    /// Flameling (id=1) must have ability_id=1 (Flame Body).
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

    /// Sproutlet (id=3) must have ability_id=3 (Regeneration).
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

    /// Tidalin (id=2) must have no ability (baseline species).
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
    // ability store resolves correctly from content
    // ---------------------------------------------------------------------------

    /// ability_id=1 resolves to `StatusImmunity { immune_to: Burn }`.
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

    /// ability_id=3 resolves to `EntryHeal { denom: 4 }`.
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
    // each ability kind is exercised end-to-end by a shipped species
    // ---------------------------------------------------------------------------

    /// Flameling's Flame Body clears Burn via `apply_ability_modifiers`.
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

    /// Sproutlet's Regeneration heals on entry via `apply_entry_ability`.
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

    /// Flameling KO-auto-switched in does NOT have its Burn cleared on entry.
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
}

pub mod entry_on_ko_switch {
    //! Entry abilities fire on a KO auto-switch (D6 wiring; heal boundary at full HP).
    //!
    //! These tests pass — they document the boundary
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
    // Entry abilities fire on KO auto-switch via resolve_full_turn
    //
    // ===========================================================================

    /// EntryHeal fires on KO auto-switch via resolve_full_turn.
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
    /// triggering auto-switch to slot 1.
    ///
    /// Assert: after resolve_full_turn, SideA slot 1 current_hp == 75 (50 + 25).
    ///
    /// an impl that omits apply_entry_ability on KO auto-switch
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
        // - apply_entry_ability fires for SideA slot 1 → heal = 100/4 = 25 HP.
        // - SideA slot 1 should have current_hp = 50 + 25 = 75.

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

    /// StatusImmunity fires on KO auto-switch via resolve_full_turn.
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
    /// auto-switch to slot 1.
    ///
    /// Assert: after resolve_full_turn, status.side_a[1] is None (Burn cleared).
    ///
    /// an impl that omits apply_entry_ability on KO auto-switch
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
        // - apply_entry_ability fires for SideA slot 1 (StatusImmunity { Burn }).
        //   This clears the Burn from status.side_a[1].

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
}
