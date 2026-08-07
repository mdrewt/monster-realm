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
//!   pt-d1-2  derived forms 9/10 are never wild-catchable
//!   pt-d1-3  STAB invariant (registry-wide: every species can learn its own type)
//!   pt-d1-4  relative archetype separation, scoped to the NEW rows only
//!   pt-d1-6  CONTENT_VERSION floor  (pt-d1-5 lives in the spritesheet eval)
//!
//! EG1 RETIREMENT: the `evolutions.ron` branch-shape arms of pt-d1-2 are gone
//! with the file and the `EvolutionTrigger`/`SpeciesEvolutions` model itself
//! (ADR-0174). Their successor is the R1-R12 gate in
//! `game-core/src/content.rs` plus EG3's re-authored `evolution_paths/`
//! content. The derived-forms-not-wild arm survives verbatim — it reads the
//! encounter registry alone.

use game_core::{
    base_stat_total, load_abilities, load_encounters, load_items, load_skills, load_species,
    load_type_chart, parse_species, validate_abilities, validate_content, Affinity, Species,
    StatBlock,
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

/// One expected wave-1 row. A named struct rather than a 5-tuple: the tuple form
/// trips `clippy::type_complexity` and reads as five anonymous positions at the
/// assertion site.
struct ExpectedRow {
    id: u32,
    name: &'static str,
    affinity: Affinity,
    ability: Option<u32>,
    learn: &'static [u32],
}

impl ExpectedRow {
    const fn new(
        id: u32,
        name: &'static str,
        affinity: Affinity,
        ability: Option<u32>,
        learn: &'static [u32],
    ) -> Self {
        Self {
            id,
            name,
            affinity,
            ability,
            learn,
        }
    }
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
    // Absolute power bands. Relative ordering alone would accept an all-1s base
    // or an all-255s evolution: the new rows must sit INSIDE the tiers the six
    // pre-existing forms already established (bases 318-328, evolved 450-479), so
    // no wave-1 form is a stat outlier. Bands are deliberately a little wider than
    // the current extremes to leave later waves room without re-opening this gate.
    for (id, sp, lo, hi) in [
        (7, s7, 300u16, 340u16),
        (8, s8, 300, 340),
        (9, s9, 440, 490),
        (10, s10, 440, 490),
    ] {
        let bst = base_stat_total(&sp.base_stats);
        if !(lo..=hi).contains(&bst) {
            out.push(format!(
                "species {id} BST {bst} is outside the {lo}..={hi} power band for its tier"
            ));
        }
    }
    out
}

/// Comment-hygiene predicate (ADR-0143 D7). Returns a violation per RON comment
/// that carries an id-shaped needle.
///
/// WHY THIS IS A GATE AND NOT A CONVENTION: `append-only-ids.eval.mjs` strips
/// WHOLE-LINE `//` comments only and then regex-scans the remainder, so a
/// *trailing* comment carrying `id:` — or `species_id:`, which contains it —
/// injects a phantom stable content id into that append-only scan and poisons the
/// committed baseline. Its EG5-1 sibling `evolution-content-integrity.eval.mjs`
/// (renamed from `evolution-fusion-content-integrity.eval.mjs`) meets the same
/// hazard from the other side: it does NOT strip such a comment either, it
/// REFUSES the whole evolution_paths registry whenever a trailing `//` comment or
/// a block comment carries an `edge_id:`-shaped needle — a hard red rather than a
/// silent mis-scan — while its separate R1-R12 structural lens scrubs comments
/// outright. `to_species:` is retained in the needle list below as belt-and-braces
/// for any future text scanner over this directory. The species registry is
/// authored one part file per wave, so leaving this as prose in a wave-1 header
/// would bind nobody; scanning the directory binds every future wave.
fn comment_needle_violations(file_label: &str, src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (n, line) in src.lines().enumerate() {
        let Some(pos) = line.find("//") else { continue };
        // Whole-line comments are stripped by both evals, so they are safe.
        if line[..pos].trim().is_empty() {
            continue;
        }
        let comment = &line[pos..];
        // Longest needle first, then stop: `species_id:` and `to_species:` both
        // contain `id:`, so scanning shortest-first would report one offending
        // comment two or three times and blur which scanner it actually poisons.
        if let Some(needle) = ["to_species:", "species_id:", "id:"]
            .into_iter()
            .find(|n| comment.contains(n))
        {
            out.push(format!(
                "{file_label}:{}: trailing comment contains `{needle}` — use the `id=N` form",
                n + 1
            ));
        }
    }
    out
}

/// pt-d1-6 needle parser. The needle is built by CONCATENATION so this test file
/// contains no literal a source-scan could confuse with the real declaration.
///
/// The match is anchored on a WORD BOUNDARY and must be UNIQUE. A bare substring
/// search on the first hit is defeatable: a constant whose name merely *ends in*
/// the needle — `MIN_SUPPORTED_CONTENT_VERSION: u32 = 13;` declared above the real
/// one — would shadow it, so this gate would report 13 while the module shipped 12
/// and `sync_content_inner` silently skipped the re-seed. That is precisely the
/// ADR-0054 trap this criterion exists to catch, so the parser must not fall for it.
///
/// (`evals/content-version.eval.mjs`'s `readContentVersion` has the same
/// first-substring-wins shape and is defeatable the same way. That is a
/// pre-existing gate weakness outside this slice's touch set — recorded as a
/// residual in ADR-0143 rather than fixed here.)
fn parse_content_version(src: &str) -> Option<u32> {
    let needle = ["CONTENT_VERSION", ": u32 = "].concat();
    let mut found: Option<u32> = None;
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(&needle) {
        let idx = from + rel;
        from = idx + needle.len();
        // Reject a match glued to an identifier character on its left — that is a
        // DIFFERENT constant (e.g. `..._CONTENT_VERSION`), not this one.
        let preceded_by_ident = src[..idx]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if preceded_by_ident {
            continue;
        }
        let rest = &src[from..];
        let end = match rest.find(';') {
            Some(e) => e,
            None => continue,
        };
        let value = rest[..end].trim().parse::<u32>().ok()?;
        if found.is_some() {
            // Two genuine declarations: ambiguous, so refuse to guess.
            return None;
        }
        found = Some(value);
    }
    found
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
        tier: 0,
    }
}

// ===========================================================================
// pt-d1-1 — the rows land and the whole registry still validates
// ===========================================================================

#[test]
fn pt_d1_1_new_species_rows_present_with_exact_fields() {
    let species = load_species().expect("species registry must parse");
    let expected = [
        ExpectedRow::new(7, "Cragling", Affinity::Earth, None, &[9, 1]),
        ExpectedRow::new(8, "Shadelet", Affinity::Dark, Some(2), &[11, 4]),
        ExpectedRow::new(9, "Stoneward", Affinity::Earth, Some(3), &[9, 5]),
        ExpectedRow::new(10, "Umbrafang", Affinity::Dark, Some(2), &[11, 2]),
    ];
    // Membership only — NEVER a count. A sibling slice adds more forms, so
    // `species.len() == 10` would be a false gate.
    for ExpectedRow {
        id,
        name,
        affinity,
        ability,
        learn,
    } in expected
    {
        let sp = find(&species, id).unwrap_or_else(|| {
            panic!("pt-d1-1: species {id} ({name}) missing from load_species()")
        });
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
    // The evolution/fusion half of this gate moved to
    // `game_core::content::validate_evolution_paths` (EG1-10) and is asserted
    // over the live registries by that module's own test suite.
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

// EG1 RETIREMENT (ADR-0174): `pt_d1_2_evolution_blocks_for_7_and_8_are_exact`
// pinned the exact `EvolutionCondition` branch shape of species 7/8 in
// `evolutions.ron`. Both the file and the `EvolutionTrigger` model are deleted;
// species 7 -> 9 / 8 -> 10 are re-authored as `evolution_paths/` edges by EG3-7
// and pinned there. The two synthetic-fixture teeth that called
// `validate_evolution_fusion` (duplicate block, derived-form-in-encounters) are
// superseded by R1/R6's biting fixtures in `game-core/src/content.rs`.

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
    let bad = vec![synth(
        77,
        Affinity::Earth,
        &[1, 3],
        stats(60, 55, 70, 30, 40, 55),
    )];
    assert_eq!(
        stab_violations(&bad, &skills),
        vec![77],
        "TEETH(pt-d1-3): an Earth species with only Fire+Water moves must be flagged"
    );
    // Non-vacuity: the same helper reports NOTHING for an on-type learnset
    // (skill 9 Sandblast is Earth), so the assertion above is not trivially true.
    let good = vec![synth(
        77,
        Affinity::Earth,
        &[9, 1],
        stats(60, 55, 70, 30, 40, 55),
    )];
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
    let good = || {
        vec![
            synth(7, Affinity::Earth, &[9, 1], stats(60, 55, 70, 30, 40, 55)),
            synth(8, Affinity::Dark, &[11, 4], stats(45, 60, 40, 72, 55, 40)),
            synth(9, Affinity::Earth, &[9, 5], stats(90, 75, 105, 35, 60, 85)),
            synth(10, Affinity::Dark, &[11, 2], stats(70, 90, 60, 105, 80, 60)),
        ]
    };
    assert!(
        archetype_violations(&good()).is_empty(),
        "TEETH(pt-d1-4): the GOOD fixture must pass, else the tooth is vacuous"
    );

    // Every branch of the predicate needs its own counterexample — a tooth that
    // only perturbs one field lets the other four assertions be deleted silently.
    struct Case {
        /// Index into the good fixture (0=species 7 … 3=species 10).
        idx: usize,
        /// The single-field mutation that should break exactly one branch.
        mutate: fn(&mut Species),
        /// Substring the resulting violation must name.
        needle: &'static str,
    }
    let case = |idx, mutate: fn(&mut Species), needle| Case {
        idx,
        mutate,
        needle,
    };
    let cases = [
        // species 10 slower than species 8 — the sweeper stops being a sweeper.
        case(3, |s| s.base_stats.speed = 50, "species 10 speed"),
        // species 9 no bulkier than species 7 — the tank's evolution adds nothing.
        case(2, |s| s.base_stats.defense = 60, "species 9 defense"),
        // species 7 faster than species 8 — the tank/fast-base contrast inverts.
        case(0, |s| s.base_stats.speed = 99, "species 7 speed"),
        // an evolution that is not a power increase at all.
        case(2, |s| s.base_stats.hp = 1, "species 9 BST"),
        // an evolution far above its tier band (the all-255s outlier).
        case(3, |s| s.base_stats.attack = 250, "power band"),
    ];
    for Case {
        idx,
        mutate,
        needle,
    } in cases
    {
        let mut fixture = good();
        mutate(&mut fixture[idx]);
        let violations = archetype_violations(&fixture);
        assert!(
            violations.iter().any(|v| v.contains(needle)),
            "TEETH(pt-d1-4): mutating fixture[{idx}] must produce a violation naming \
             `{needle}`; got {violations:?}"
        );
    }
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
    // The attack this parser exists to survive: a DIFFERENT constant whose name
    // merely ENDS IN the needle, declared ABOVE the real one. A first-substring
    // -wins scan reads 13 off the decoy while the module still ships 12 — a green
    // gate over the exact ADR-0054 silent-skip it is supposed to catch.
    let decoyed = [
        "pub(crate) const MIN_SUPPORTED_",
        "CONTENT_VERSION",
        ": u32 = ",
        "13;\npub(crate) const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "12;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&decoyed),
        Some(12),
        "TEETH(pt-d1-6): a constant ending in the needle must NOT shadow the real \
         declaration — kills a scan that takes the first substring hit"
    );
    // Two genuine declarations are ambiguous; refuse to guess rather than pick one.
    let doubled = [
        "const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "13;\nconst ",
        "CONTENT_VERSION",
        ": u32 = ",
        "14;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&doubled),
        None,
        "TEETH(pt-d1-6): two real declarations must be reported as unparseable"
    );
}

// ---------------------------------------------------------------------------
// pt-d1-7 — RON comment hygiene (ADR-0143 D7), enforced over the whole species
// directory + evolutions.ron so it binds later authoring waves, not just wave 1.
// ---------------------------------------------------------------------------

#[test]
fn pt_d1_7_ron_comments_carry_no_id_shaped_needles() {
    let content_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/content");
    let mut violations = Vec::new();

    let species_dir = format!("{content_dir}/species");
    let mut parts: Vec<_> = std::fs::read_dir(&species_dir)
        .expect("species content directory must exist")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "ron"))
        .collect();
    parts.sort();
    assert!(
        parts.len() >= 3,
        "pt-d1-7: expected at least the three species part files, found {}",
        parts.len()
    );
    for p in &parts {
        let label = p.file_name().unwrap().to_string_lossy().to_string();
        let src = std::fs::read_to_string(p).expect("species part must be readable");
        violations.extend(comment_needle_violations(&label, &src));
    }

    let evo_dir = format!("{content_dir}/evolution_paths");
    let mut evo_parts: Vec<_> = std::fs::read_dir(&evo_dir)
        .expect("evolution_paths content directory must exist")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "ron"))
        .collect();
    evo_parts.sort();
    assert!(
        !evo_parts.is_empty(),
        "pt-d1-7: the evolution_paths registry must ship at least one part file"
    );
    for p in &evo_parts {
        let label = p.file_name().unwrap().to_string_lossy().to_string();
        let src = std::fs::read_to_string(p).expect("evolution_paths part must be readable");
        violations.extend(comment_needle_violations(&label, &src));
    }

    assert!(
        violations.is_empty(),
        "pt-d1-7: RON trailing comments must not carry id-shaped needles — \
         append-only-ids strips WHOLE-LINE comments only and then regex-scans, so a \
         trailing `id:`/`species_id:` injects a phantom stable content id into its \
         append-only baseline, and evolution-content-integrity REFUSES the whole \
         evolution_paths registry when a trailing comment carries an `edge_id:`-shaped \
         needle. Violations: {violations:?}"
    );
}

#[test]
fn pt_d1_7_teeth_comment_scan_flags_a_trailing_needle() {
    // TEETH(pt-d1-7): each of the three needles is caught in a TRAILING comment...
    for needle in ["id:", "species_id:", "to_species:"] {
        let bad = format!("    learnable_skill_ids: [9], // pairs with {needle} 5\n");
        assert_eq!(
            comment_needle_violations("f.ron", &bad).len(),
            1,
            "TEETH(pt-d1-7): a trailing comment carrying `{needle}` must be flagged"
        );
    }
    // ...and a WHOLE-LINE comment is deliberately NOT flagged: both evals strip
    // those before scanning, so banning them too would be a vacuous over-reach.
    assert!(
        comment_needle_violations("f.ron", "    // block for species_id: 7 below\n").is_empty(),
        "TEETH(pt-d1-7): whole-line comments are stripped by both evals and must stay legal"
    );
    // And a clean file yields nothing — proving the scan is not indiscriminate.
    assert!(
        comment_needle_violations("f.ron", "    ability: Some(2), // Vital Spirit (id=2)\n")
            .is_empty(),
        "TEETH(pt-d1-7): the sanctioned `id=N` form must not be flagged"
    );
}
