//! pt-d1 — playtest roster wave 1 (species 7-10) gating tests.
//!
//! RED-first: these tests are written BEFORE the content RON exists. They encode
//! the six EARS criteria for the slice and carry proof-of-teeth built from
//! SYNTHETIC RON strings / in-memory structs — never by mutating the live
//! registry files (a tooth that edits shipped content is not a tooth, it is a
//! content change).
//!
//! Criteria:
//!   pt-d1-1  new species rows land + the whole merged registry still validates
//!   pt-d1-2  evolution wiring (7 -> 9 @ L18, 8 -> 10 @ L20; 9/10 never wild)
//!   pt-d1-3  STAB invariant (registry-wide: every species can learn its own type)
//!   pt-d1-4  relative archetype separation, scoped to the NEW rows only
//!   pt-d1-6  CONTENT_VERSION floor  (pt-d1-5 lives in the spritesheet eval)

use game_core::{
    base_stat_total, load_abilities, load_encounters, load_evolutions, load_fusion, load_items,
    load_skills, load_species, load_type_chart, parse_encounters, parse_evolutions, parse_species,
    validate_abilities, validate_content, validate_evolution_fusion, Affinity, EncounterTable,
    EvolutionCondition, EvolutionTrigger, Level, Species, SpeciesEvolutions, StatBlock,
};

// ===========================================================================
// Pure helpers under test (extracted so the teeth can call them directly)
// ===========================================================================

/// pt-d1-3 STAB predicate. Returns the ids of every species that CANNOT learn a
/// single skill matching its own affinity. `Ok` content yields an empty vec.
///
/// Pure over its inputs — no registry access — so a synthetic counterexample can
/// prove it is not vacuous.
fn stab_violations(species: &[Species], skills: &[game_core::SkillDef]) -> Vec<u32> {
    species
        .iter()
        .filter(|sp| {
            !sp.learnable_skill_ids.iter().any(|sid| {
                skills
                    .iter()
                    .any(|sk| sk.id == *sid && sk.affinity == sp.affinity)
            })
        })
        .map(|sp| sp.id)
        .collect()
}

fn find(species: &[Species], id: u32) -> Option<&Species> {
    species.iter().find(|s| s.id == id)
}

/// pt-d1-4 relative-archetype predicate, SCOPED to the four new ids only (no
/// global superlatives — a sibling slice adds more forms and any "highest in the
/// registry" claim would break). Returns a human-readable violation list.
fn archetype_violations(species: &[Species]) -> Vec<String> {
    let mut out = Vec::new();
    let (s7, s8, s9, s10) = (
        find(species, 7),
        find(species, 8),
        find(species, 9),
        find(species, 10),
    );
    for (id, got) in [(7, s7), (8, s8), (9, s9), (10, s10)] {
        if got.is_none() {
            out.push(format!("species {id} missing from the registry"));
        }
    }
    let (Some(s7), Some(s8), Some(s9), Some(s10)) = (s7, s8, s9, s10) else {
        return out;
    };
    if s9.base_stats.defense <= s7.base_stats.defense {
        out.push(format!(
            "species 9 defense {} must exceed species 7 defense {}",
            s9.base_stats.defense, s7.base_stats.defense
        ));
    }
    if s10.base_stats.speed <= s8.base_stats.speed {
        out.push(format!(
            "species 10 speed {} must exceed species 8 speed {}",
            s10.base_stats.speed, s8.base_stats.speed
        ));
    }
    if s7.base_stats.speed >= s8.base_stats.speed {
        out.push(format!(
            "species 7 speed {} must be below species 8 speed {}",
            s7.base_stats.speed, s8.base_stats.speed
        ));
    }
    if base_stat_total(&s9.base_stats) <= base_stat_total(&s7.base_stats) {
        out.push("species 9 BST must exceed species 7 BST".to_string());
    }
    if base_stat_total(&s10.base_stats) <= base_stat_total(&s8.base_stats) {
        out.push("species 10 BST must exceed species 8 BST".to_string());
    }
    out
}

/// pt-d1-6 needle parser. The needle is built by CONCATENATION so this test file
/// contains no literal a source-scan could confuse with the real declaration.
fn parse_content_version(src: &str) -> Option<u32> {
    let needle = ["CONTENT_VERSION", ": u32 = "].concat();
    let idx = src.find(&needle)?;
    let rest = &src[idx + needle.len()..];
    let end = rest.find(';')?;
    rest[..end].trim().parse::<u32>().ok()
}

fn stats(
    hp: u16,
    attack: u16,
    defense: u16,
    speed: u16,
    sp_attack: u16,
    sp_defense: u16,
) -> StatBlock {
    StatBlock {
        hp,
        attack,
        defense,
        speed,
        sp_attack,
        sp_defense,
    }
}

fn synth(id: u32, affinity: Affinity, learn: &[u32], base: StatBlock) -> Species {
    Species {
        id,
        name: format!("Synth{id}"),
        base_stats: base,
        affinity,
        learnable_skill_ids: learn.to_vec(),
        ability: None,
    }
}

// ===========================================================================
// pt-d1-1 — the rows land and the whole registry still validates
// ===========================================================================

#[test]
fn pt_d1_1_new_species_rows_present_with_exact_fields() {
    let species = load_species().expect("species registry must parse");
    let expected: [(u32, &str, Affinity, Option<u32>, &[u32]); 4] = [
        (7, "Cragling", Affinity::Earth, None, &[9, 1]),
        (8, "Shadelet", Affinity::Dark, Some(2), &[11, 4]),
        (9, "Stoneward", Affinity::Earth, Some(3), &[9, 5]),
        (10, "Umbrafang", Affinity::Dark, Some(2), &[11, 2]),
    ];
    // Membership only — NEVER a count. A sibling slice adds more forms, so
    // `species.len() == 10` would be a false gate.
    for (id, name, affinity, ability, learn) in expected {
        let sp = find(&species, id)
            .unwrap_or_else(|| panic!("pt-d1-1: species {id} ({name}) missing from load_species()"));
        assert_eq!(sp.name, name, "pt-d1-1: species {id} name");
        assert_eq!(sp.affinity, affinity, "pt-d1-1: species {id} affinity");
        assert_eq!(
            sp.ability, ability,
            "pt-d1-1: species {id} ability — kills a row authored without the ADR-0100 ability wiring"
        );
        assert_eq!(
            sp.learnable_skill_ids, learn,
            "pt-d1-1: species {id} learnable_skill_ids (order-sensitive: the first entry is the STAB move)"
        );
    }
}

#[test]
fn pt_d1_1_live_registry_still_validates_end_to_end() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    let abilities = load_abilities().expect("abilities registry must parse");
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    let fusion = load_fusion().expect("fusion registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");

    assert_eq!(
        validate_content(&species, &skills, &type_chart, &items),
        Ok(()),
        "pt-d1-1: the merged live registry must pass validate_content"
    );
    assert_eq!(
        validate_abilities(&abilities, &species),
        Ok(()),
        "pt-d1-1: species 8/9/10 reference abilities 2/3 — a dangling ability id must fail here"
    );
    assert_eq!(
        validate_evolution_fusion(&species, &evolutions, &fusion, &encounters, &items),
        Ok(()),
        "pt-d1-1: the new evolution blocks must be cross-registry clean"
    );
}

#[test]
fn pt_d1_1_teeth_empty_moveset_is_rejected() {
    // TEETH(pt-d1-1/A): ADR-0049 empty-moveset invariant. A wave-1 row authored
    // with `learnable_skill_ids: []` (easy to do while stubbing) must be Err.
    let bad = parse_species(
        r#"[( id: 7, name: "Cragling",
             base_stats: (hp: 60, attack: 55, defense: 70, speed: 30, sp_attack: 40, sp_defense: 55),
             affinity: Earth, learnable_skill_ids: [] )]"#,
    )
    .expect("fixture must parse (the violation is semantic, not syntactic)");
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    assert!(
        validate_content(&bad, &skills, &type_chart, &items).is_err(),
        "TEETH(pt-d1-1/A): an empty learnable_skill_ids must be rejected"
    );
}

#[test]
fn pt_d1_1_teeth_dangling_skill_reference_is_rejected() {
    // TEETH(pt-d1-1/B): kills a row that cites a skill id that does not exist
    // (e.g. inventing "Rock Throw" as id 99 instead of reusing Sandblast id 9).
    let bad = parse_species(
        r#"[( id: 7, name: "Cragling",
             base_stats: (hp: 60, attack: 55, defense: 70, speed: 30, sp_attack: 40, sp_defense: 55),
             affinity: Earth, learnable_skill_ids: [99] )]"#,
    )
    .expect("fixture must parse");
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    assert!(
        validate_content(&bad, &skills, &type_chart, &items).is_err(),
        "TEETH(pt-d1-1/B): a learnable_skill_ids entry with no matching SkillDef must be rejected"
    );
}

#[test]
fn pt_d1_1_teeth_duplicate_species_id_is_rejected() {
    // TEETH(pt-d1-1/C): kills a copy-paste row that reuses an existing id
    // (the append-only-ids trap: id 7 authored twice across two part files).
    let bad = parse_species(
        r#"[( id: 7, name: "Cragling",
             base_stats: (hp: 60, attack: 55, defense: 70, speed: 30, sp_attack: 40, sp_defense: 55),
             affinity: Earth, learnable_skill_ids: [9] ),
           ( id: 7, name: "Craglong",
             base_stats: (hp: 61, attack: 55, defense: 70, speed: 30, sp_attack: 40, sp_defense: 55),
             affinity: Earth, learnable_skill_ids: [9] )]"#,
    )
    .expect("fixture must parse");
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    assert!(
        validate_content(&bad, &skills, &type_chart, &items).is_err(),
        "TEETH(pt-d1-1/C): a duplicate species id must be rejected"
    );
}

// ===========================================================================
// pt-d1-2 — evolution wiring
// ===========================================================================

#[test]
fn pt_d1_2_evolution_blocks_for_7_and_8_are_exact() {
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    for (src, level, target) in [(7u32, 18u8, 9u32), (8, 20, 10)] {
        let blocks: Vec<&SpeciesEvolutions> = evolutions
            .iter()
            .filter(|b| b.species_id == src)
            .collect();
        assert_eq!(
            blocks.len(),
            1,
            "pt-d1-2: exactly ONE evolutions block for species {src} (two blocks are a validator Err)"
        );
        let want = EvolutionCondition {
            trigger: EvolutionTrigger::Level(Level::new(level).expect("level in [1,100]")),
            to_species: target,
        };
        assert_eq!(
            blocks[0].evolutions,
            vec![want],
            "pt-d1-2: species {src} must have exactly one branch Level({level}) -> {target} — kills a Bond/Item trigger or an extra branch"
        );
    }
}

#[test]
fn pt_d1_2_derived_forms_9_and_10_are_not_wild_catchable() {
    let encounters = load_encounters().expect("encounters registry must parse");
    // NOTE: deliberately says nothing about species 7/8 — a later slice adds
    // them to encounter tables and this test must not block it.
    for derived in [9u32, 10] {
        for table in &encounters {
            assert!(
                !table.entries.iter().any(|e| e.species_id == derived),
                "pt-d1-2: derived form {derived} must never appear in zone {}'s encounter table",
                table.zone_id
            );
        }
    }
}

#[test]
fn pt_d1_2_teeth_duplicate_evolution_block_is_rejected() {
    // TEETH(pt-d1-2/A): two blocks for the same species_id (the natural mistake
    // when appending 7's block to a file that already holds one) must be Err.
    let bad = parse_evolutions(
        "[(species_id: 7, evolutions: [(trigger: Level(18), to_species: 9)]),
          (species_id: 7, evolutions: [(trigger: Level(19), to_species: 9)])]",
    )
    .expect("fixture must parse");
    let species = vec![
        synth(7, Affinity::Earth, &[9], stats(60, 55, 70, 30, 40, 55)),
        synth(9, Affinity::Earth, &[9], stats(80, 70, 100, 35, 55, 75)),
    ];
    assert!(
        validate_evolution_fusion(&species, &bad, &[], &[], &[]).is_err(),
        "TEETH(pt-d1-2/A): a duplicate evolutions block for one species must be rejected"
    );
}

#[test]
fn pt_d1_2_teeth_derived_form_in_encounter_table_is_rejected() {
    // TEETH(pt-d1-2/B): kills the "just make Stoneward wild too" authoring
    // shortcut — an evolution target in an encounter table must be Err.
    let evolutions = parse_evolutions("[(species_id: 7, evolutions: [(trigger: Level(18), to_species: 9)])]")
        .expect("fixture must parse");
    let encounters: Vec<EncounterTable> = parse_encounters(
        "[(zone_id: 0, encounter_rate: 200,
           entries: [(species_id: 9, weight: 5, min_level: 4, max_level: 8)])]",
    )
    .expect("fixture must parse");
    let species = vec![
        synth(7, Affinity::Earth, &[9], stats(60, 55, 70, 30, 40, 55)),
        synth(9, Affinity::Earth, &[9], stats(80, 70, 100, 35, 55, 75)),
    ];
    assert!(
        validate_evolution_fusion(&species, &evolutions, &[], &encounters, &[]).is_err(),
        "TEETH(pt-d1-2/B): a derived form in an encounter table must be rejected"
    );
}

// ===========================================================================
// pt-d1-3 — STAB invariant (registry-wide)
// ===========================================================================

#[test]
fn pt_d1_3_every_species_can_learn_a_same_affinity_skill() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let violations = stab_violations(&species, &skills);
    assert!(
        violations.is_empty(),
        "pt-d1-3: every species must be able to learn at least one skill of its OWN affinity; violating ids: {violations:?}"
    );
}

#[test]
fn pt_d1_3_teeth_stab_helper_flags_an_off_type_learnset() {
    // TEETH(pt-d1-3): a synthetic Earth species whose learnset is [1, 3]
    // (Ember=Fire, Water Gun=Water) MUST be reported. This kills a wave-1 row
    // that gets a plausible-looking but off-type moveset, and proves the helper
    // is not vacuous (the good fixture below must report nothing).
    let skills = load_skills().expect("skills registry must parse");
    let bad = vec![synth(77, Affinity::Earth, &[1, 3], stats(60, 55, 70, 30, 40, 55))];
    assert_eq!(
        stab_violations(&bad, &skills),
        vec![77],
        "TEETH(pt-d1-3): an Earth species with only Fire+Water moves must be flagged"
    );
    // Non-vacuity: the same helper reports NOTHING for an on-type learnset
    // (skill 9 Sandblast is Earth), so the assertion above is not trivially true.
    let good = vec![synth(77, Affinity::Earth, &[9, 1], stats(60, 55, 70, 30, 40, 55))];
    assert!(
        stab_violations(&good, &skills).is_empty(),
        "TEETH(pt-d1-3): the helper must NOT flag a species that does learn its own type"
    );
}

// ===========================================================================
// pt-d1-4 — relative archetype separation (new rows only)
// ===========================================================================

#[test]
fn pt_d1_4_new_rows_are_archetypically_separated() {
    let species = load_species().expect("species registry must parse");
    let violations = archetype_violations(&species);
    assert!(
        violations.is_empty(),
        "pt-d1-4: relative archetype separation for the NEW rows only (no global superlatives): {violations:?}"
    );
}

#[test]
fn pt_d1_4_teeth_predicate_flags_a_slow_umbrafang() {
    // TEETH(pt-d1-4): species 10 (the Dark speedster's evolution) with its speed
    // dropped BELOW species 8 must be flagged — this kills a stat block that is
    // merely "bigger everywhere" without preserving the archetype direction.
    let mut fixture = vec![
        synth(7, Affinity::Earth, &[9, 1], stats(60, 55, 70, 30, 40, 55)),
        synth(8, Affinity::Dark, &[11, 4], stats(45, 60, 40, 72, 55, 40)),
        synth(9, Affinity::Earth, &[9, 5], stats(85, 75, 105, 35, 55, 80)),
        synth(10, Affinity::Dark, &[11, 2], stats(70, 90, 60, 105, 80, 60)),
    ];
    assert!(
        archetype_violations(&fixture).is_empty(),
        "TEETH(pt-d1-4): the GOOD fixture must pass, else the tooth is vacuous"
    );
    fixture[3].base_stats.speed = 50; // below species 8's 72
    let violations = archetype_violations(&fixture);
    assert!(
        violations.iter().any(|v| v.contains("species 10 speed")),
        "TEETH(pt-d1-4): lowering species 10's speed below species 8's must be flagged; got {violations:?}"
    );
}

// ===========================================================================
// pt-d1-6 — CONTENT_VERSION floor
// ===========================================================================

/// WHY this test exists: `server-module/src/content.rs` early-returns from
/// `sync_content_inner` when the DB's stored content version EQUALS
/// `CONTENT_VERSION`. Without a bump, species 7-10 parse, validate, hash and
/// pass CI while NEVER reaching a deployed database — the ADR-0054 silent-skip
/// trap. A green test suite over content that no player can ever encounter is
/// exactly the failure this floor prevents.
#[test]
fn pt_d1_6_content_version_floor_is_at_least_13() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../server-module/src/lib.rs"
    ))
    .expect("server-module/src/lib.rs must be readable from game-core/tests");
    let version = parse_content_version(&src)
        .expect("pt-d1-6: the CONTENT_VERSION declaration must be present and parseable");
    assert!(
        version >= 13,
        "pt-d1-6: CONTENT_VERSION is {version}; the wave-1 roster needs >= 13 or sync_content_inner early-returns and the new species never reach a live DB"
    );
}

#[test]
fn pt_d1_6_teeth_needle_parser_is_not_vacuous() {
    // TEETH(pt-d1-6): if a refactor renames/reformats the declaration so the scan
    // finds nothing, the test above fails LOUDLY (expect panics) rather than
    // passing vacuously. Prove the parser both matches and rejects.
    let synthetic = ["pub(crate) const ", "CONTENT_VERSION", ": u32 = ", "13;\n"].concat();
    assert_eq!(
        parse_content_version(&synthetic),
        Some(13),
        "TEETH(pt-d1-6): the needle parser must read the version out of a canonical declaration"
    );
    assert_eq!(
        parse_content_version("pub const OTHER_VERSION: u32 = 99;"),
        None,
        "TEETH(pt-d1-6): the parser must NOT match an unrelated constant"
    );
    assert_eq!(
        parse_content_version("CONTENT_VERSION: u32 = twelve;"),
        None,
        "TEETH(pt-d1-6): a non-numeric payload must be None, not a silent 0"
    );
}
