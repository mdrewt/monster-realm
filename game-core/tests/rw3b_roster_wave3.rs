//! rw3b — roster wave 3 (Electric + Light) gating tests.
//!
//! RED-first: `evals/rw3b-roster-wave-3.eval.mjs` and `CONTENT_VERSION` (still 19
//! at slice open) are the load-bearing missing pieces; the four wave-3 RON files
//! already exist in-tree. Every pure predicate below is proven non-vacuous by a
//! synthetic counterexample built from in-memory structs or synthetic RON
//! strings — never by mutating the shipped content files (a tooth that edits
//! shipped content is a content change, not a tooth).
//!
//! Criteria -> tests:
//!   RW3-01  rw3b_1_*   Electric/Light species+skill floors
//!   RW3-02  rw3b_2_*   wave-3 STAB + no dangling skill refs
//!   RW3-03  rw3b_3_*   wave-3 id band + uniqueness + pre-existing ids survive
//!   RW3-04  rw3b_4_*   base tier:0, derived tier+1, derived is an edge target,
//!                      edge ids banded
//!   RW3-05  rw3b_5_*   ADR-0176 D2 no-auto-evolution-race
//!   RW3-08  rw3b_8_*   live merged registry still validates end to end
//!   RW3-09  rw3b_9_*   CONTENT_VERSION floor >= 20
//!   (ADR-0143 D7) rw3b_comment_hygiene_* — RON comment hygiene over the four
//!                      new wave-3 files
//!
//! RW3-06/RW3-07 (encounter placement / zone-0 freeze) and the sprite/plan-table
//! half of RW3-01..05 are the JS eval's job (`evals/rw3b-roster-wave-3.eval.mjs`)
//! — no encounters content exists for wave 3 yet (rw3c), so there is nothing for
//! a Rust test to assert there.

use std::collections::{BTreeMap, BTreeSet};

use game_core::{
    load_encounters, load_evolution_paths, load_items, load_skills, load_species, load_type_chart,
    parse_evolution_paths, parse_skills, parse_species, validate_content, validate_evolution_paths,
    Affinity, EssenceRequirement, EvolutionPath, Level, SkillDef, Species, StatBlock, TrustTier,
};

// ===========================================================================
// Fixture helpers
// ===========================================================================

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

fn synth_species(id: u32, affinity: Affinity, learn: &[u32], base: StatBlock, tier: u8) -> Species {
    Species {
        id,
        name: format!("Synth{id}"),
        base_stats: base,
        affinity,
        learnable_skill_ids: learn.to_vec(),
        ability: None,
        tier,
    }
}

fn synth_skill(id: u32, affinity: Affinity, power: u16, accuracy: u8, pp: u8) -> SkillDef {
    SkillDef {
        id,
        name: format!("SynthSkill{id}"),
        affinity,
        power,
        accuracy,
        pp,
        sets_weather: None,
        applies_status: None,
    }
}

fn synth_edge(edge_id: u32, from: u32, to: u32, min_level: u8) -> EvolutionPath {
    EvolutionPath {
        edge_id,
        from_species: from,
        to_species: to,
        min_level: Level::new(min_level).expect("test min_level must be in [1, 100]"),
        essence: vec![],
        min_trust_tier: None,
        min_quality_time_tier: None,
        min_nutrition_pct: None,
    }
}

fn content_dir_file(rel: &str) -> String {
    format!("{}/content/{rel}", env!("CARGO_MANIFEST_DIR"))
}

// ===========================================================================
// Pure helpers under test (extracted so the teeth can call them directly)
// ===========================================================================

/// RW3-01 predicate: counts of wave-affected registries. Pure over its inputs.
fn affinity_counts(species: &[Species], skills: &[SkillDef]) -> (usize, usize, usize, usize) {
    let electric_species = species
        .iter()
        .filter(|s| s.affinity == Affinity::Electric)
        .count();
    let light_species = species
        .iter()
        .filter(|s| s.affinity == Affinity::Light)
        .count();
    let electric_skills = skills
        .iter()
        .filter(|s| s.affinity == Affinity::Electric)
        .count();
    let light_skills = skills
        .iter()
        .filter(|s| s.affinity == Affinity::Light)
        .count();
    (
        electric_species,
        light_species,
        electric_skills,
        light_skills,
    )
}

/// RW3-02 predicate, SCOPED to the wave-3 id band `40..=49` only (a sibling
/// slice must not be dragged into this gate). Reports both the STAB violation
/// and any dangling `learnable_skill_ids` reference in one pass.
fn wave3_stab_and_dangling_violations(species: &[Species], skills: &[SkillDef]) -> Vec<String> {
    let mut out = Vec::new();
    for sp in species.iter().filter(|s| (40..=49).contains(&s.id)) {
        for &sid in &sp.learnable_skill_ids {
            if !skills.iter().any(|sk| sk.id == sid) {
                out.push(format!(
                    "species {} references non-existent skill {sid}",
                    sp.id
                ));
            }
        }
        let has_stab = sp.learnable_skill_ids.iter().any(|sid| {
            skills
                .iter()
                .any(|sk| sk.id == *sid && sk.affinity == sp.affinity)
        });
        if !has_stab {
            out.push(format!(
                "species {} (affinity {:?}) has no same-affinity learnable skill",
                sp.id, sp.affinity
            ));
        }
    }
    out
}

/// RW3-03 predicate: ids outside `min..=max`.
fn find_out_of_band(ids: &[u32], min: u32, max: u32) -> Vec<u32> {
    ids.iter()
        .copied()
        .filter(|&id| !(min..=max).contains(&id))
        .collect()
}

/// RW3-03 predicate: ids that appear more than once, one entry per repeat.
fn find_duplicates(ids: &[u32]) -> Vec<u32> {
    let mut seen = BTreeSet::new();
    let mut dups = Vec::new();
    for &id in ids {
        if !seen.insert(id) {
            dups.push(id);
        }
    }
    dups
}

/// RW3-04 predicate: base-tier / derived-tier / edge-target / edge-band checks
/// over an explicit `(base, derived, edges)` triple. Pure — no registry access.
fn wave3_tier_and_edge_violations(
    base: &[Species],
    derived: &[Species],
    edges: &[EvolutionPath],
) -> Vec<String> {
    let mut out = Vec::new();
    for b in base {
        if b.tier != 0 {
            out.push(format!(
                "base species {} declares tier {} (expected 0)",
                b.id, b.tier
            ));
        }
    }
    let all: Vec<&Species> = base.iter().chain(derived.iter()).collect();
    for d in derived {
        let inbound: Vec<&EvolutionPath> = edges.iter().filter(|e| e.to_species == d.id).collect();
        if inbound.is_empty() {
            out.push(format!(
                "derived species {} is not the to_species of any wave-3 edge",
                d.id
            ));
            continue;
        }
        for e in &inbound {
            match all.iter().find(|s| s.id == e.from_species) {
                Some(src) => {
                    if u16::from(d.tier) != u16::from(src.tier) + 1 {
                        out.push(format!(
                            "derived species {} (tier {}) is not exactly one tier above \
                             source species {} (tier {}) via edge {}",
                            d.id, d.tier, src.id, src.tier, e.edge_id
                        ));
                    }
                }
                None => out.push(format!(
                    "edge {} from_species {} is not among the wave-3 species passed in",
                    e.edge_id, e.from_species
                )),
            }
        }
    }
    for e in edges {
        if !(100..=199).contains(&e.edge_id) {
            out.push(format!(
                "edge {} is outside the wave-3 edge band 100..=199",
                e.edge_id
            ));
        }
    }
    out
}

/// RW3-05 predicate (ADR-0176 D2): for every `from_species` with >=2 outgoing
/// edges, either every edge shares `min_level`, or the LOWEST-level edge among
/// them carries at least one additional non-level gate (essence / trust /
/// quality-time / nutrition). Pure over an explicit edge slice.
fn racing_violations(edges: &[EvolutionPath]) -> Vec<String> {
    let mut by_from: BTreeMap<u32, Vec<&EvolutionPath>> = BTreeMap::new();
    for e in edges {
        by_from.entry(e.from_species).or_default().push(e);
    }
    let mut out = Vec::new();
    for (from, group) in by_from {
        if group.len() < 2 {
            continue;
        }
        let mut levels: Vec<u8> = group.iter().map(|e| e.min_level.as_u8()).collect();
        levels.sort_unstable();
        let lowest_level = levels[0];
        if levels.iter().all(|&l| l == lowest_level) {
            continue;
        }
        // EVERY edge sitting at the lowest level, not just the first one
        // `min_by_key` happens to return. A red-team pass proved the
        // single-edge form order-dependent: `[gated@10, ungated@10,
        // outlier@30]` came back clean while the byte-identical
        // `[ungated@10, gated@10, outlier@30]` was flagged. The ungated
        // sibling is unconditionally eligible at level 10, so auto-evolution
        // fires and forecloses the outlier — precisely the D2 defect.
        for lowest in group.iter().filter(|e| e.min_level.as_u8() == lowest_level) {
            // "Binding", NOT merely "present" — mirrors the `binds` expression
            // in `validate_evolution_paths`' rule R4 (game-core/src/content.rs).
            // Testing presence accepts the four toothless encodings R4 itself
            // enumerates (`amount: 0`, `Some(Hostile)`, `Some(0)`, `Some(0)`),
            // every one of which each monster already clears — so a "gated"
            // low edge would still race. Keep this aligned with R4's `binds`.
            let has_extra_gate = lowest.essence.iter().any(|req| req.amount > 0)
                || lowest
                    .min_trust_tier
                    .is_some_and(|t| t > game_core::TrustTier::Hostile)
                || lowest.min_quality_time_tier.is_some_and(|t| t > 0)
                || lowest.min_nutrition_pct.is_some_and(|p| p > 0);
            if !has_extra_gate {
                out.push(format!(
                    "species {from} has racing outgoing edges with min_levels {levels:?}; the \
                     lowest (edge {}) carries no BINDING non-level gate (ADR-0176 D2)",
                    lowest.edge_id
                ));
            }
        }
    }
    out
}

/// Comment-hygiene predicate (ADR-0143 D7), mirroring `pt_d1_roster.rs`'s
/// scanner verbatim (each `tests/*.rs` binary compiles independently, so this
/// is a deliberate, small duplication rather than a shared-crate dependency).
fn comment_needle_violations(file_label: &str, src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (n, line) in src.lines().enumerate() {
        let Some(pos) = line.find("//") else { continue };
        if line[..pos].trim().is_empty() {
            continue;
        }
        let comment = &line[pos..];
        if let Some(needle) = [
            "to_species:",
            "from_species:",
            "species_id:",
            "edge_id:",
            "id:",
            "tier:",
        ]
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

/// RW3-09 needle parser, mirroring `pt_d1_roster.rs::parse_content_version`
/// verbatim (same rationale: independent compilation unit per `tests/*.rs`).
fn parse_content_version(src: &str) -> Option<u32> {
    let needle = ["CONTENT_VERSION", ": u32 = "].concat();
    let mut found: Option<u32> = None;
    let mut from = 0usize;
    while let Some(rel) = src[from..].find(&needle) {
        let idx = from + rel;
        from = idx + needle.len();
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
            return None;
        }
        found = Some(value);
    }
    found
}

// ===========================================================================
// RW3-01 — Electric + Light species/skill floors
// ===========================================================================

#[test]
fn rw3b_1_electric_and_light_have_species_and_skills() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let (e_sp, l_sp, e_sk, l_sk) = affinity_counts(&species, &skills);
    assert!(
        e_sp >= 1,
        "rw3b-1: expected >=1 Electric species, found {e_sp}"
    );
    assert!(
        l_sp >= 1,
        "rw3b-1: expected >=1 Light species, found {l_sp}"
    );
    assert!(
        e_sk >= 2,
        "rw3b-1: expected >=2 Electric skills, found {e_sk}"
    );
    assert!(l_sk >= 2, "rw3b-1: expected >=2 Light skills, found {l_sk}");
}

#[test]
fn rw3b_1_teeth_affinity_counts_helper_is_not_vacuous() {
    assert_eq!(
        affinity_counts(&[], &[]),
        (0, 0, 0, 0),
        "TEETH(rw3b-1): empty registries must count as zero, not a false positive"
    );
    let sp = vec![synth_species(
        40,
        Affinity::Electric,
        &[40],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    let sk = vec![
        synth_skill(40, Affinity::Electric, 10, 100, 10),
        synth_skill(41, Affinity::Electric, 10, 100, 10),
        synth_skill(42, Affinity::Light, 10, 100, 10),
    ];
    assert_eq!(
        affinity_counts(&sp, &sk),
        (1, 0, 2, 1),
        "TEETH(rw3b-1): the helper must count exactly what it is given, never fall back to the live registry"
    );
}

// ===========================================================================
// RW3-02 — wave-3 STAB + no dangling skill refs
// ===========================================================================

#[test]
fn rw3b_2_wave3_species_satisfy_stab_and_reference_real_skills() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let violations = wave3_stab_and_dangling_violations(&species, &skills);
    assert!(
        violations.is_empty(),
        "rw3b-2: every wave-3 species must learn >=1 same-affinity skill and reference only \
         real skill ids: {violations:?}"
    );
}

#[test]
fn rw3b_2_teeth_stab_and_dangling_helper_bites() {
    let skills = vec![
        synth_skill(1, Affinity::Fire, 40, 100, 25), // off-type decoy, mirrors real Ember
        synth_skill(40, Affinity::Electric, 40, 100, 25),
    ];

    let off_type = vec![synth_species(
        40,
        Affinity::Electric,
        &[1],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    let v1 = wave3_stab_and_dangling_violations(&off_type, &skills);
    assert!(
        v1.iter().any(|v| v.contains("no same-affinity")),
        "TEETH(rw3b-2/A): an Electric species with only a Fire move must be flagged: {v1:?}"
    );

    let dangling = vec![synth_species(
        40,
        Affinity::Electric,
        &[999],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    let v2 = wave3_stab_and_dangling_violations(&dangling, &skills);
    assert!(
        v2.iter().any(|v| v.contains("non-existent skill")),
        "TEETH(rw3b-2/B): a dangling skill reference must be flagged: {v2:?}"
    );

    let good = vec![synth_species(
        40,
        Affinity::Electric,
        &[40],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    assert!(
        wave3_stab_and_dangling_violations(&good, &skills).is_empty(),
        "TEETH(rw3b-2/C): a species that DOES learn its own affinity must NOT be flagged"
    );

    let out_of_band = vec![synth_species(
        7,
        Affinity::Electric,
        &[999],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    assert!(
        wave3_stab_and_dangling_violations(&out_of_band, &skills).is_empty(),
        "TEETH(rw3b-2/D): a species outside the 40..=49 band must not be scoped into this predicate"
    );
}

// ===========================================================================
// RW3-03 — id band, uniqueness, and pre-existing ids survive
// ===========================================================================

#[test]
fn rw3b_3_wave3_ids_are_banded_unique_and_pre_existing_ids_survive() {
    let base_txt = std::fs::read_to_string(content_dir_file("species/070-wave3.ron"))
        .expect("species/070-wave3.ron must be readable");
    let derived_txt = std::fs::read_to_string(content_dir_file("species/071-wave3-derived.ron"))
        .expect("species/071-wave3-derived.ron must be readable");
    let skills_txt = std::fs::read_to_string(content_dir_file("skills/070-wave3.ron"))
        .expect("skills/070-wave3.ron must be readable");

    let base = parse_species(&base_txt).expect("species/070-wave3.ron must parse");
    let derived = parse_species(&derived_txt).expect("species/071-wave3-derived.ron must parse");
    let wave3_skills = parse_skills(&skills_txt).expect("skills/070-wave3.ron must parse");

    let species_ids: Vec<u32> = base.iter().chain(derived.iter()).map(|s| s.id).collect();
    let skill_ids: Vec<u32> = wave3_skills.iter().map(|s| s.id).collect();

    assert!(
        find_out_of_band(&species_ids, 40, 49).is_empty(),
        "rw3b-3: wave-3 species ids {species_ids:?} must fall inside 40..=49"
    );
    assert!(
        find_out_of_band(&skill_ids, 40, 49).is_empty(),
        "rw3b-3: wave-3 skill ids {skill_ids:?} must fall inside 40..=49"
    );
    assert!(
        find_duplicates(&species_ids).is_empty(),
        "rw3b-3: duplicate wave-3 species ids: {:?}",
        find_duplicates(&species_ids)
    );
    assert!(
        find_duplicates(&skill_ids).is_empty(),
        "rw3b-3: duplicate wave-3 skill ids: {:?}",
        find_duplicates(&skill_ids)
    );

    let live_species = load_species().expect("species registry must parse");
    let live_skills = load_skills().expect("skills registry must parse");
    for id in [1u32, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 22, 23, 30, 31] {
        assert!(
            live_species.iter().any(|s| s.id == id),
            "rw3b-3: pre-existing species id {id} must still be present (append-only)"
        );
    }
    for id in 1u32..=11 {
        assert!(
            live_skills.iter().any(|s| s.id == id),
            "rw3b-3: pre-existing skill id {id} must still be present (append-only)"
        );
    }
}

#[test]
fn rw3b_3_teeth_band_and_duplicate_helpers_bite() {
    assert_eq!(
        find_out_of_band(&[7, 40, 50], 40, 49),
        vec![7, 50],
        "TEETH(rw3b-3/A): ids 7 and 50 must be reported as outside 40..=49"
    );
    assert!(
        find_out_of_band(&[40, 41, 49], 40, 49).is_empty(),
        "TEETH(rw3b-3/B): a GOOD in-band set must not be flagged"
    );
    assert_eq!(
        find_duplicates(&[40, 41, 40]),
        vec![40],
        "TEETH(rw3b-3/C): a repeated id must be reported"
    );
    assert!(
        find_duplicates(&[40, 41, 42]).is_empty(),
        "TEETH(rw3b-3/D): a GOOD unique set must not be flagged"
    );
}

// ===========================================================================
// RW3-04 — base tier 0 / derived tier+1 / edge targets / edge band
// ===========================================================================

#[test]
fn rw3b_4_base_forms_tier0_derived_forms_are_edge_targets_at_tier_plus_one() {
    let base_txt = std::fs::read_to_string(content_dir_file("species/070-wave3.ron"))
        .expect("species/070-wave3.ron must be readable");
    let derived_txt = std::fs::read_to_string(content_dir_file("species/071-wave3-derived.ron"))
        .expect("species/071-wave3-derived.ron must be readable");
    let edges_txt = std::fs::read_to_string(content_dir_file("evolution_paths/070-wave3.ron"))
        .expect("evolution_paths/070-wave3.ron must be readable");

    let base = parse_species(&base_txt).expect("species/070-wave3.ron must parse");
    let derived = parse_species(&derived_txt).expect("species/071-wave3-derived.ron must parse");
    let edges =
        parse_evolution_paths(&edges_txt).expect("evolution_paths/070-wave3.ron must parse");

    let violations = wave3_tier_and_edge_violations(&base, &derived, &edges);
    assert!(violations.is_empty(), "rw3b-4: {violations:?}");
}

#[test]
fn rw3b_4_teeth_tier_and_edge_helper_bites() {
    let base = vec![synth_species(
        40,
        Affinity::Electric,
        &[40],
        stats(1, 1, 1, 1, 1, 1),
        0,
    )];
    let good_derived = vec![synth_species(
        41,
        Affinity::Electric,
        &[40],
        stats(1, 1, 1, 1, 1, 1),
        1,
    )];
    let good_edges = vec![synth_edge(100, 40, 41, 20)];
    assert!(
        wave3_tier_and_edge_violations(&base, &good_derived, &good_edges).is_empty(),
        "TEETH(rw3b-4/GOOD): a well-formed base/derived/edge triple must not be flagged"
    );

    // A: base declares tier != 0
    let mut bad_base = base.clone();
    bad_base[0].tier = 1;
    let v = wave3_tier_and_edge_violations(&bad_base, &good_derived, &good_edges);
    assert!(
        v.iter().any(|s| s.contains("expected 0")),
        "TEETH(rw3b-4/A): a base form with tier != 0 must be flagged: {v:?}"
    );

    // B: derived form with no inbound edge
    let v = wave3_tier_and_edge_violations(&base, &good_derived, &[]);
    assert!(
        v.iter().any(|s| s.contains("not the to_species")),
        "TEETH(rw3b-4/B): a derived form with no inbound wave-3 edge must be flagged: {v:?}"
    );

    // C: derived tier is +2 instead of +1
    let mut bad_derived = good_derived.clone();
    bad_derived[0].tier = 2;
    let v = wave3_tier_and_edge_violations(&base, &bad_derived, &good_edges);
    assert!(
        v.iter().any(|s| s.contains("not exactly one tier above")),
        "TEETH(rw3b-4/C): a derived tier skip must be flagged: {v:?}"
    );

    // D: edge id outside 100..=199
    let out_of_band_edge = vec![synth_edge(50, 40, 41, 20)];
    let v = wave3_tier_and_edge_violations(&base, &good_derived, &out_of_band_edge);
    assert!(
        v.iter().any(|s| s.contains("outside the wave-3 edge band")),
        "TEETH(rw3b-4/D): an edge_id outside 100..=199 must be flagged: {v:?}"
    );
}

// ===========================================================================
// RW3-05 — ADR-0176 D2 no-auto-evolution-race
// ===========================================================================

#[test]
fn rw3b_5_no_auto_evolution_race_among_wave3_species_with_multiple_edges() {
    let edges_txt = std::fs::read_to_string(content_dir_file("evolution_paths/070-wave3.ron"))
        .expect("evolution_paths/070-wave3.ron must be readable");
    let edges =
        parse_evolution_paths(&edges_txt).expect("evolution_paths/070-wave3.ron must parse");
    // Vacuous today over the SHIPPED content: wave 3 ships exactly one outgoing
    // edge per base species (the safe default the spec's own anti-pattern note
    // recommends). The teeth below prove the predicate itself is NOT vacuous.
    let violations = racing_violations(&edges);
    assert!(violations.is_empty(), "rw3b-5: {violations:?}");
}

#[test]
fn rw3b_5_teeth_racing_predicate_flags_unshared_min_level_with_no_extra_gate() {
    let bad = vec![synth_edge(900, 40, 41, 10), synth_edge(901, 40, 44, 20)];
    let violations = racing_violations(&bad);
    assert!(
        !violations.is_empty(),
        "TEETH(rw3b-5/A): differing min_level with no extra gate on the lower edge must be flagged"
    );

    // Non-vacuity arm B: identical min_level across both edges is fine.
    let shared = vec![synth_edge(900, 40, 41, 20), synth_edge(901, 40, 44, 20)];
    assert!(
        racing_violations(&shared).is_empty(),
        "TEETH(rw3b-5/B): identical min_level across both edges must NOT be flagged"
    );

    // Non-vacuity arm C: an essence gate on the lower edge legitimizes the race.
    let mut essence_gated = vec![synth_edge(900, 40, 41, 10), synth_edge(901, 40, 44, 20)];
    essence_gated[0].essence = vec![EssenceRequirement {
        affinity: Affinity::Electric,
        amount: 1,
    }];
    assert!(
        racing_violations(&essence_gated).is_empty(),
        "TEETH(rw3b-5/C): the lower edge carrying an essence gate must NOT be flagged"
    );

    // Non-vacuity arm D: a Trust-tier gate is an equally valid non-level gate.
    let mut trust_gated = vec![synth_edge(900, 40, 41, 10), synth_edge(901, 40, 44, 20)];
    trust_gated[0].min_trust_tier = Some(TrustTier::Wary);
    assert!(
        racing_violations(&trust_gated).is_empty(),
        "TEETH(rw3b-5/D): the lower edge carrying a min_trust_tier gate must NOT be flagged"
    );

    // Non-vacuity arm C2 (red-team regression): a PRESENT-but-TOOTHLESS essence
    // gate must NOT legitimize the race. `amount: 0` is one of the four
    // encodings rule R4 in game-core/src/content.rs explicitly names as
    // non-binding — every monster already clears it — and `min_level > 1` alone
    // keeps the edge valid under R4, so this shape ships CI-clean. The
    // presence-only form of this predicate passed it.
    let mut toothless_essence = vec![synth_edge(900, 40, 41, 10), synth_edge(901, 40, 44, 20)];
    toothless_essence[0].essence = vec![EssenceRequirement {
        affinity: Affinity::Electric,
        amount: 0,
    }];
    assert!(
        !racing_violations(&toothless_essence).is_empty(),
        "TEETH(rw3b-5/C2): an `amount: 0` essence gate is toothless and must NOT excuse the race"
    );

    // Non-vacuity arm D2 (red-team regression): `Some(Hostile)` is the minimum
    // of its own comparison in `path_satisfied`, so it excludes no monster.
    let mut toothless_trust = vec![synth_edge(900, 40, 41, 10), synth_edge(901, 40, 44, 20)];
    toothless_trust[0].min_trust_tier = Some(TrustTier::Hostile);
    assert!(
        !racing_violations(&toothless_trust).is_empty(),
        "TEETH(rw3b-5/D2): a `Some(Hostile)` trust gate is toothless and must NOT excuse the race"
    );

    // Non-vacuity arm F (red-team regression): with two edges TIED at the
    // lowest level — one gated, one not — plus a higher outlier, the ungated
    // sibling is unconditionally eligible at that level and forecloses the
    // outlier. The predicate must flag it REGARDLESS of slice order; the
    // `min_by_key` form inspected only the first tied edge, so the same data
    // passed in one order and failed in the other.
    for (label, order) in [
        ("gated-first", [0usize, 1, 2]),
        ("ungated-first", [1, 0, 2]),
    ] {
        let mut gated = synth_edge(900, 40, 41, 10);
        gated.min_trust_tier = Some(TrustTier::Friendly);
        let ungated = synth_edge(901, 40, 44, 10);
        let outlier = synth_edge(902, 40, 45, 30);
        let all = [gated, ungated, outlier];
        let permuted: Vec<EvolutionPath> = order.iter().map(|&i| all[i].clone()).collect();
        assert!(
            !racing_violations(&permuted).is_empty(),
            "TEETH(rw3b-5/F/{label}): an UNGATED edge tied at the lowest min_level must be \
             flagged whatever the slice order"
        );
    }

    // Non-vacuity arm E: a species with exactly one outgoing edge is never in scope.
    let single = vec![synth_edge(900, 40, 41, 1)];
    assert!(
        racing_violations(&single).is_empty(),
        "TEETH(rw3b-5/E): a species with exactly one outgoing edge is never a racing candidate"
    );
}

// ===========================================================================
// RW3-08 — live merged registry still validates end to end
// ===========================================================================

#[test]
fn rw3b_8_live_merged_registry_still_validates() {
    let species = load_species().expect("species registry must parse");
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let paths = load_evolution_paths().expect("evolution_paths registry must parse");

    assert_eq!(
        validate_content(&species, &skills, &type_chart, &items),
        Ok(()),
        "rw3b-8: validate_content must still pass with the wave-3 rows merged in"
    );
    assert_eq!(
        validate_evolution_paths(&species, &paths, &encounters, &items),
        Ok(()),
        "rw3b-8: validate_evolution_paths (R1-R12) must still pass with the wave-3 edges merged in"
    );
}

#[test]
fn rw3b_8_teeth_validate_content_still_rejects_a_wave3_shaped_empty_moveset() {
    // TEETH(rw3b-8): confirms this test is actually calling through to the real
    // gate (not a stub) by feeding it a species shaped like a wave-3 row but with
    // an empty moveset — the ADR-0049 invariant `validate_content` enforces.
    let bad = vec![synth_species(
        40,
        Affinity::Electric,
        &[],
        stats(44, 48, 40, 82, 66, 42),
        0,
    )];
    let skills = load_skills().expect("skills registry must parse");
    let type_chart = load_type_chart().expect("type chart must parse");
    let items = load_items().expect("items registry must parse");
    assert!(
        validate_content(&bad, &skills, &type_chart, &items).is_err(),
        "TEETH(rw3b-8): an empty learnable_skill_ids for a wave-3-shaped species must be rejected"
    );
}

// ===========================================================================
// RW3-09 — CONTENT_VERSION floor >= 20
// ===========================================================================

/// WHY this test exists: `server-module/src/content.rs` early-returns from
/// `sync_content_inner` when the DB's stored content version EQUALS
/// `CONTENT_VERSION`. Without a bump, Voltkit/Voltarion/Aurelet/Aurelith parse,
/// validate, hash and pass CI while NEVER reaching a deployed database — the
/// ADR-0054 silent-skip trap.
#[test]
fn rw3b_9_content_version_floor_is_at_least_20() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../server-module/src/lib.rs"
    ))
    .expect("server-module/src/lib.rs must be readable from game-core/tests");
    let version = parse_content_version(&src)
        .expect("rw3b-9: the CONTENT_VERSION declaration must be present and parseable");
    assert!(
        version >= 20,
        "rw3b-9: CONTENT_VERSION is {version}; wave 3 needs >= 20 or sync_content_inner \
         early-returns and Voltkit/Voltarion/Aurelet/Aurelith never reach a live DB \
         (CONTENT_VERSION was 19 when this spec was written)"
    );
}

#[test]
fn rw3b_9_teeth_needle_parser_is_not_vacuous() {
    let synthetic = ["pub(crate) const ", "CONTENT_VERSION", ": u32 = ", "20;\n"].concat();
    assert_eq!(
        parse_content_version(&synthetic),
        Some(20),
        "TEETH(rw3b-9): the needle parser must read the version out of a canonical declaration"
    );
    assert_eq!(
        parse_content_version("pub const OTHER_VERSION: u32 = 99;"),
        None,
        "TEETH(rw3b-9): the parser must NOT match an unrelated constant"
    );
    // The attack this parser exists to survive: a DIFFERENT constant whose name
    // merely ENDS IN the needle, declared ABOVE the real one.
    let decoyed = [
        "pub(crate) const MIN_SUPPORTED_",
        "CONTENT_VERSION",
        ": u32 = ",
        "20;\npub(crate) const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "19;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&decoyed),
        Some(19),
        "TEETH(rw3b-9): a decoy constant merely ending in the needle must NOT shadow the \
         real declaration — kills a scan that takes the first substring hit"
    );
    let doubled = [
        "const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "20;\nconst ",
        "CONTENT_VERSION",
        ": u32 = ",
        "21;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&doubled),
        None,
        "TEETH(rw3b-9): two real declarations must be reported as unparseable, not guessed"
    );
}

// ===========================================================================
// ADR-0143 D7 — RON comment hygiene over the four new wave-3 files
// ===========================================================================

#[test]
fn rw3b_comment_hygiene_over_the_four_new_wave3_files() {
    let files = [
        content_dir_file("species/070-wave3.ron"),
        content_dir_file("species/071-wave3-derived.ron"),
        content_dir_file("skills/070-wave3.ron"),
        content_dir_file("evolution_paths/070-wave3.ron"),
    ];
    let mut violations = Vec::new();
    for path in &files {
        let src = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("rw3b: {path} must be readable: {e}"));
        let label = path.rsplit('/').next().unwrap_or(path.as_str()).to_string();
        violations.extend(comment_needle_violations(&label, &src));
    }
    assert!(
        violations.is_empty(),
        "rw3b: RON trailing comments in the four new wave-3 files must not carry id-shaped \
         needles — append-only-ids strips whole-line comments only and then regex-scans, so a \
         trailing `id:`/`species_id:`/`to_species:` injects a phantom stable content id: {violations:?}"
    );
}

#[test]
fn rw3b_comment_hygiene_teeth_scan_flags_a_trailing_needle() {
    for needle in ["id:", "species_id:", "to_species:"] {
        let bad = format!("    learnable_skill_ids: [40], // pairs with {needle} 5\n");
        assert_eq!(
            comment_needle_violations("f.ron", &bad).len(),
            1,
            "TEETH: a trailing comment carrying `{needle}` must be flagged"
        );
    }
    assert!(
        comment_needle_violations("f.ron", "    // block for species_id: 40 below\n").is_empty(),
        "TEETH: whole-line comments are stripped by the content scanners and must stay legal"
    );
    assert!(
        comment_needle_violations("f.ron", "    ability: Some(2), // Vital Spirit (id=2)\n")
            .is_empty(),
        "TEETH: the sanctioned `id=N` form must not be flagged"
    );
}
