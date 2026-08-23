//! rw3c — roster wave 3 tuning: zone-1 placement of Voltkit (40) and Aurelet
//! (42), CONTENT_VERSION bump, zone-0 freeze.
//!
//! RED-first: at slice open, species 40/42 have no encounter row anywhere
//! (`game-core/content/encounters/000-core.ron` carries only the pre-existing
//! zone-0/zone-1 tables) and `CONTENT_VERSION` is still 20. Every pure
//! predicate below is proven non-vacuous by a synthetic counterexample built
//! from in-memory structs — never by mutating the shipped content files (a
//! tooth that edits shipped content is a content change, not a tooth).
//!
//! Criteria -> tests:
//!   RW3-06  rw3c_6_*  every wave-3 tier-0 species is wild-legal, no
//!                     evolution-edge target is wild-legal, placement is
//!                     zone-1-only
//!   RW3-07  (folded into rw3c_6_placement_is_zone_1_only) zone 0 stays
//!                     byte-identical (entries, weights, encounter_rate); the
//!                     RW3-07 band-sanity half lives in rw3c_7_*
//!   RW3-09  rw3c_9_*  CONTENT_VERSION floor >= 21
//!
//! Every predicate is derived from the LIVE registries (`load_species`,
//! `load_encounters`, `load_evolution_paths`) — the wave-3 id set is never
//! hardcoded, it is filtered live from `load_species()`.

use std::collections::BTreeSet;

use game_core::{
    load_encounters, load_evolution_paths, load_species, Affinity, EncounterEntry, EncounterTable,
    EvolutionPath, Level, Species,
};

// ===========================================================================
// Fixture helpers (copied verbatim in shape from `rw3b_roster_wave3.rs` — each
// `tests/*.rs` binary compiles independently, so this is a deliberate, small
// duplication rather than a shared-crate dependency).
// ===========================================================================

fn stats(
    hp: u16,
    attack: u16,
    defense: u16,
    speed: u16,
    sp_attack: u16,
    sp_defense: u16,
) -> game_core::StatBlock {
    game_core::StatBlock {
        hp,
        attack,
        defense,
        speed,
        sp_attack,
        sp_defense,
    }
}

fn synth_species(
    id: u32,
    affinity: Affinity,
    learn: &[u32],
    base: game_core::StatBlock,
    tier: u8,
) -> Species {
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

fn level(n: u8) -> Level {
    Level::new(n).expect("test level must be in [1, 100]")
}

fn synth_entry(species_id: u32, weight: u16, min_level: u8, max_level: u8) -> EncounterEntry {
    EncounterEntry {
        species_id,
        weight,
        min_level: level(min_level),
        max_level: level(max_level),
    }
}

// ===========================================================================
// Pure helpers under test (extracted so the teeth can call them directly)
// ===========================================================================

/// RW3-06 predicate: the wave-3 tier-0 set, derived LIVE (never hardcoded) as
/// `id in 40..=49 && tier == 0`.
fn wave3_tier0_species(species: &[Species]) -> Vec<&Species> {
    species
        .iter()
        .filter(|s| (40..=49).contains(&s.id) && s.tier == 0)
        .collect()
}

/// The union of every encounter table's `species_id`.
fn wild_legal_ids(encounters: &[EncounterTable]) -> BTreeSet<u32> {
    encounters
        .iter()
        .flat_map(|t| t.entries.iter().map(|e| e.species_id))
        .collect()
}

/// RW3-06 predicate: tier-0 wave-3 species absent from `wild`.
fn missing_from_wild(tier0: &[&Species], wild: &BTreeSet<u32>) -> Vec<u32> {
    tier0
        .iter()
        .filter(|s| !wild.contains(&s.id))
        .map(|s| s.id)
        .collect()
}

/// RW3-06 predicate: evolution-edge `to_species` values that are ALSO in
/// `wild` — checked over ALL edges passed in, never narrowed to a band.
fn edge_targets_present_in_wild(edges: &[EvolutionPath], wild: &BTreeSet<u32>) -> Vec<u32> {
    let mut out: Vec<u32> = edges
        .iter()
        .map(|e| e.to_species)
        .filter(|t| wild.contains(t))
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Every zone id in which `species_id` appears in at least one entry, sorted
/// and deduplicated — a species placed in two zones reports BOTH, it never
/// collapses to a single membership.
fn zone_membership(species_id: u32, encounters: &[EncounterTable]) -> Vec<u32> {
    let mut zones: Vec<u32> = encounters
        .iter()
        .filter(|t| t.entries.iter().any(|e| e.species_id == species_id))
        .map(|t| t.zone_id)
        .collect();
    zones.sort_unstable();
    // DEDUP IS LOAD-BEARING: `load_encounters()` concatenates every part file
    // in `game-core/content/encounters/**` without re-merging same-`zone_id`
    // tables (see `parse_encounters_parts` in `game-core/src/content.rs`), and
    // this repo's OWN convention (species/evolution_paths splitting one
    // logical id-band across `000-core.ron` + `070-wave3.ron`) shows a future
    // wave could split a zone's table the same way for encounters. Without
    // `.dedup()`, a species placed once but reachable via two same-`zone_id`
    // part-file tables would report `[1, 1]`, and the real test's
    // `assert_eq!(zones, vec![1])` would false-RED a perfectly legal single
    // placement — the exact regression `rw3c_teeth_zone_membership_helper_*`
    // below now pins.
    zones.dedup();
    zones
}

/// RW3-07 predicate: zone 0's `encounter_rate` and ordered entries pinned
/// exactly to the pre-rw3c shape. Structural counterpart to the JS eval's
/// text-level pin.
fn zone0_pin_violations(zone0: &EncounterTable) -> Vec<String> {
    let mut out = Vec::new();
    if zone0.encounter_rate != 200 {
        out.push(format!(
            "zone 0 encounter_rate changed: pinned 200, live {}",
            zone0.encounter_rate
        ));
    }
    let want: Vec<(u32, u16, u8, u8)> = vec![(1, 10, 3, 7), (2, 7, 3, 7), (3, 5, 4, 8)];
    if zone0.entries.len() != want.len() {
        out.push(format!(
            "zone 0 entry count changed: pinned {}, live {}",
            want.len(),
            zone0.entries.len()
        ));
        return out;
    }
    for (i, (id, weight, min, max)) in want.iter().enumerate() {
        let e = &zone0.entries[i];
        if e.species_id != *id
            || e.weight != *weight
            || e.min_level.as_u8() != *min
            || e.max_level.as_u8() != *max
        {
            out.push(format!(
                "zone 0 entry {i} changed: pinned (id={id}, weight={weight}, min={min}, \
                 max={max}), live (id={}, weight={}, min={}, max={})",
                e.species_id,
                e.weight,
                e.min_level.as_u8(),
                e.max_level.as_u8()
            ));
        }
    }
    out
}

/// RW3-07 predicate: for every encounter entry whose species is in
/// `wave3_tier0_ids`, `weight > 0`, `min_level <= max_level`,
/// `max_level - min_level <= 12`, and `max_level` STRICTLY BELOW the lowest
/// outgoing evolution-edge `min_level` for that species (if it has one).
///
/// STRICT, not `<=`: `game-core/src/evolution/eligibility.rs`'s
/// `level_gate_met` is inclusive `>=`, and ADR-0176 D2 auto-evolution fires
/// immediately when exactly one path is eligible. Each wave-3 base form ships
/// exactly one outgoing edge, so a band that REACHES the gate ships wild
/// catches that evolve on the spot and the player never obtains the tier-0
/// form RW3-06 promises.
fn wave3_band_violations(
    wave3_tier0_ids: &BTreeSet<u32>,
    encounters: &[EncounterTable],
    edges: &[EvolutionPath],
) -> Vec<String> {
    let mut out = Vec::new();
    for table in encounters {
        for entry in &table.entries {
            if !wave3_tier0_ids.contains(&entry.species_id) {
                continue;
            }
            if entry.weight == 0 {
                out.push(format!(
                    "species {} entry in zone {} has weight 0",
                    entry.species_id, table.zone_id
                ));
            }
            if entry.min_level.as_u8() > entry.max_level.as_u8() {
                out.push(format!(
                    "species {} entry in zone {} has min_level {} > max_level {}",
                    entry.species_id,
                    table.zone_id,
                    entry.min_level.as_u8(),
                    entry.max_level.as_u8()
                ));
            }
            let width = entry
                .max_level
                .as_u8()
                .saturating_sub(entry.min_level.as_u8());
            if width > 12 {
                out.push(format!(
                    "species {} entry in zone {} has a {}-level band, exceeding the sane 12",
                    entry.species_id, table.zone_id, width
                ));
            }
            let lowest_gate = edges
                .iter()
                .filter(|e| e.from_species == entry.species_id)
                .map(|e| e.min_level.as_u8())
                .min();
            if let Some(gate) = lowest_gate {
                if entry.max_level.as_u8() >= gate {
                    out.push(format!(
                        "species {} entry in zone {} has max_level {} >= its lowest outgoing \
                         evolution edge's min_level {} — level_gate_met is inclusive (>=), so a \
                         wild catch at max_level auto-evolves on the spot (ADR-0176 D2)",
                        entry.species_id,
                        table.zone_id,
                        entry.max_level.as_u8(),
                        gate
                    ));
                }
            }
        }
    }
    out
}

/// RW3-09 needle parser. Copied VERBATIM from
/// `game-core/tests/rw3b_roster_wave3.rs` / `pt_d3_tuning.rs` (same
/// rationale: each `tests/*.rs` binary compiles independently, so a shared
/// helper would require a crate dependency for a five-line function; the
/// decoy-hardened shape — word-boundary anchored, `None` on ambiguity — is
/// load-bearing and must not be re-derived).
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
// RW3-06 — every wave-3 tier-0 species is wild-legal
// ===========================================================================

#[test]
fn rw3c_6_wave3_tier0_species_are_wild_legal() {
    let species = load_species().expect("species registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");

    let tier0 = wave3_tier0_species(&species);
    assert!(
        !tier0.is_empty(),
        "rw3c-6: vacuity guard — the wave-3 tier-0 set (id in 40..=49 && tier == 0) must be \
         non-empty; an empty set would make the loop below trivially pass"
    );

    let wild = wild_legal_ids(&encounters);
    let missing = missing_from_wild(&tier0, &wild);
    assert!(
        missing.is_empty(),
        "rw3c-6: every wave-3 tier-0 species must appear in at least one encounter entry; \
         missing {missing:?}"
    );
}

#[test]
fn rw3c_teeth_missing_wave3_species_is_flagged() {
    let sp = synth_species(40, Affinity::Electric, &[40], stats(1, 1, 1, 1, 1, 1), 0);
    let tier0: Vec<&Species> = vec![&sp];

    let empty: BTreeSet<u32> = BTreeSet::new();
    let missing = missing_from_wild(&tier0, &empty);
    assert_eq!(
        missing,
        vec![40],
        "TEETH(a): a tier-0 wave-3 species absent from every table must be reported by id"
    );

    let present: BTreeSet<u32> = [40].into_iter().collect();
    assert!(
        missing_from_wild(&tier0, &present).is_empty(),
        "TEETH(a/GOOD): a species present in the wild set must NOT be flagged"
    );
}

// ===========================================================================
// RW3-06 — no evolution-edge target is wild-legal (checked over ALL edges)
// ===========================================================================

#[test]
fn rw3c_6_no_wave3_edge_target_is_wild_legal() {
    let encounters = load_encounters().expect("encounters registry must parse");
    let edges = load_evolution_paths().expect("evolution_paths registry must parse");

    let wild = wild_legal_ids(&encounters);
    // Deliberately NOT narrowed to the wave-3 100..=199 edge_id band — a
    // red-team pass flagged that narrowing as a real bypass (a target
    // smuggled in via a NON-wave-3 edge would slip through). This is a
    // slice-level restatement of R6 over the WHOLE registry and is green
    // today for the pre-existing content.
    let present = edge_targets_present_in_wild(&edges, &wild);
    assert!(
        present.is_empty(),
        "rw3c-6: no evolution-edge to_species (of ANY edge, not just the wave-3 band) may \
         appear in any encounter table; found {present:?}"
    );
}

#[test]
fn rw3c_teeth_edge_target_present_in_wild_is_flagged() {
    let edges = vec![synth_edge(100, 40, 41, 20)];

    let bad_wild: BTreeSet<u32> = [40, 41].into_iter().collect();
    let present = edge_targets_present_in_wild(&edges, &bad_wild);
    assert_eq!(
        present,
        vec![41],
        "TEETH(b): an evolution-edge to_species present in the wild set must be flagged"
    );

    let good_wild: BTreeSet<u32> = [40].into_iter().collect();
    assert!(
        edge_targets_present_in_wild(&edges, &good_wild).is_empty(),
        "TEETH(b/GOOD): an evolution-edge target absent from the wild set must NOT be flagged"
    );
}

// ===========================================================================
// RW3-06/RW3-07 — placement is zone-1-only; zone 0 stays byte-identical
// ===========================================================================

#[test]
fn rw3c_6_placement_is_zone_1_only() {
    let encounters = load_encounters().expect("encounters registry must parse");

    for id in [40u32, 42] {
        let zones = zone_membership(id, &encounters);
        assert_eq!(
            zones,
            vec![1],
            "rw3c-6: species {id} must appear in zone 1 and in NO other zone, found {zones:?}"
        );
    }

    let zone0 = encounters
        .iter()
        .find(|t| t.zone_id == 0)
        .expect("rw3c-7: zone 0 must still exist in the encounter registry");
    let violations = zone0_pin_violations(zone0);
    assert!(
        violations.is_empty(),
        "rw3c-7: zone 0 must stay byte-identical (entries, weights, encounter_rate): \
         {violations:?}"
    );
}

#[test]
fn rw3c_teeth_zone_membership_helper_bites_a_second_zone_placement() {
    let entry_40 = |zone_id: u32| EncounterTable {
        zone_id,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 10, 19)],
    };
    // TEETH(e): a wave-3 species placed in TWO zones is reported for both —
    // this proves the real test's `assert_eq!(zones, vec![1])` would bite
    // this exact shape (a `[1, 2]` result fails equality against `[1]`).
    let two_zones = vec![entry_40(1), entry_40(2)];
    let zones = zone_membership(40, &two_zones);
    assert_eq!(
        zones,
        vec![1, 2],
        "TEETH(e): a wave-3 species placed in a SECOND zone must be reported for both zones"
    );

    let one_zone = vec![entry_40(1)];
    assert_eq!(
        zone_membership(40, &one_zone),
        vec![1],
        "TEETH(e/GOOD): single-zone placement must resolve to exactly [1]"
    );
}

#[test]
fn rw3c_teeth_zone_membership_dedups_a_same_zone_id_split_across_two_tables() {
    // TEETH(review finding 1): `load_encounters()` concatenates every part
    // file under `game-core/content/encounters/**` (`parse_encounters_parts`
    // in `game-core/src/content.rs`) without re-merging tables that share a
    // `zone_id` — and this repo's OWN species/evolution_paths registries
    // already split one logical id-band across two part files
    // (`000-core.ron` + `070-wave3.ron`), so a future wave following that
    // convention for encounters (a SECOND part file also defining a
    // `zone_id: 1` table) is a realistic shape, not a contrived one. Without
    // `.dedup()` in `zone_membership`, a species placed exactly ONCE overall
    // — but reachable via two same-`zone_id` tables from different part files
    // — would report `[1, 1]`, and the real test's
    // `assert_eq!(zones, vec![1])` in `rw3c_6_placement_is_zone_1_only` would
    // false-RED a perfectly legal single placement.
    // CRITICAL to this tooth actually biting: species 40 must be present in
    // BOTH same-`zone_id: 1` tables (not just one) — `zone_membership` first
    // FILTERS to tables containing the species, so if 40 appeared in only one
    // of the two, exactly one table would survive the filter regardless of
    // whether `.dedup()` ran, and the result would be `[1]` either way. Two
    // tables that both carry a species_id=40 entry, both zone_id=1, is also
    // the realistic split-part-file shape (one zone's roster spread across
    // two files, the species present in each half's row set).
    let split_same_zone = vec![
        EncounterTable {
            zone_id: 1,
            encounter_rate: 150,
            entries: vec![synth_entry(2, 10, 4, 10), synth_entry(40, 6, 10, 19)],
        },
        EncounterTable {
            zone_id: 1,
            encounter_rate: 150,
            entries: vec![synth_entry(40, 6, 10, 19)],
        },
    ];
    assert_eq!(
        zone_membership(40, &split_same_zone),
        vec![1],
        "TEETH(review finding 1): a species present in BOTH of two same-zone_id tables (the \
         split-part-file shape) must resolve to a single-element [1], not [1, 1] — without \
         `.dedup()` the filter step keeps BOTH tables (species 40 is in each), so the pinned \
         vec![1] can only hold if dedup actually runs"
    );

    // Non-vacuity, other direction: dedup must never collapse GENUINELY
    // different zones together (would silently defeat TEETH(e) above). Species
    // 40 is present in all three tables here — the split zone_id=1 pair AND
    // the distinct zone_id=2 table — so this result is dedup-dependent too:
    // without `.dedup()` it would be [1, 1, 2], not [1, 2].
    let split_and_second_zone = vec![
        EncounterTable {
            zone_id: 1,
            encounter_rate: 150,
            entries: vec![synth_entry(2, 10, 4, 10), synth_entry(40, 6, 10, 19)],
        },
        EncounterTable {
            zone_id: 1,
            encounter_rate: 150,
            entries: vec![synth_entry(40, 6, 10, 19)],
        },
        EncounterTable {
            zone_id: 2,
            encounter_rate: 150,
            entries: vec![synth_entry(40, 6, 10, 19)],
        },
    ];
    assert_eq!(
        zone_membership(40, &split_and_second_zone),
        vec![1, 2],
        "TEETH(review finding 1/GOOD): dedup must collapse the split zone_id=1 pair down to one \
         `1`, while still reporting the genuinely distinct zone_id=2 placement — [1, 2], not \
         [1] or [1, 1, 2]"
    );
}

#[test]
fn rw3c_teeth_zone0_pin_bites_a_drifted_weight() {
    let good = EncounterTable {
        zone_id: 0,
        encounter_rate: 200,
        entries: vec![
            synth_entry(1, 10, 3, 7),
            synth_entry(2, 7, 3, 7),
            synth_entry(3, 5, 4, 8),
        ],
    };
    assert!(
        zone0_pin_violations(&good).is_empty(),
        "TEETH(f/GOOD): the verbatim pinned zone-0 shape must NOT be flagged"
    );

    let mut drifted = good.clone();
    drifted.entries[0].weight = 99;
    assert!(
        !zone0_pin_violations(&drifted).is_empty(),
        "TEETH(f): a drifted zone-0 weight must be flagged"
    );
}

// ===========================================================================
// RW3-07 — wave-3 bands are sane and strictly pre-evolution
// ===========================================================================

#[test]
fn rw3c_7_wave3_bands_are_sane_and_pre_evolution() {
    let species = load_species().expect("species registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let edges = load_evolution_paths().expect("evolution_paths registry must parse");

    let wave3_tier0_ids: BTreeSet<u32> =
        wave3_tier0_species(&species).iter().map(|s| s.id).collect();
    assert!(
        !wave3_tier0_ids.is_empty(),
        "rw3c-7: vacuity guard — the wave-3 tier-0 id set must be non-empty"
    );

    // SCOPE NOTE — deliberately restricted to `wave3_tier0_ids`, NOT every
    // encounter entry. Pre-existing content already violates the general
    // "max_level strictly below the lowest outgoing edge" shape: species 7
    // spawns to level 16 in zone 1 (game-core/content/encounters/000-core.ron)
    // while its lowest outgoing edge — edge_id 6 in
    // game-core/content/evolution_paths/000-core.ron — gates at min_level 15
    // (16 >= 15, so this is a genuine pre-existing violation of the general
    // form, verified by reading both files). A global assertion here would
    // therefore be RED on content this slice does not own. Do NOT widen this
    // to all species — that is a separate slice's cleanup, not rw3c's.
    let violations = wave3_band_violations(&wave3_tier0_ids, &encounters, &edges);
    assert!(violations.is_empty(), "rw3c-7: {violations:?}");
}

#[test]
fn rw3c_teeth_band_violations_bite_zero_weight_and_wide_bands() {
    let ids: BTreeSet<u32> = [40].into_iter().collect();

    let zero_weight = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 0, 10, 19)],
    };
    assert!(
        !wave3_band_violations(&ids, &[zero_weight], &[]).is_empty(),
        "TEETH: a weight-0 wave-3 entry must be flagged"
    );

    let wide_band = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 1, 19)],
    };
    assert!(
        !wave3_band_violations(&ids, &[wide_band], &[]).is_empty(),
        "TEETH: an 18-level-wide wave-3 band (> 12) must be flagged"
    );

    let inverted = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 19, 10)],
    };
    assert!(
        !wave3_band_violations(&ids, &[inverted], &[]).is_empty(),
        "TEETH: an inverted band (min_level > max_level) must be flagged"
    );

    let good = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 10, 19)],
    };
    assert!(
        wave3_band_violations(&ids, &[good], &[synth_edge(100, 40, 41, 20)]).is_empty(),
        "TEETH(GOOD): weight>0, min<=max, width<=12, and max_level strictly below the edge gate \
         must NOT be flagged"
    );
}

#[test]
fn rw3c_teeth_band_pre_evolution_strictness_bites_at_the_gate_and_above() {
    let ids: BTreeSet<u32> = [40].into_iter().collect();
    let edges = vec![synth_edge(100, 40, 41, 20)];

    // (c) max_level == edge.min_level — the off-by-one, proves STRICT not <=.
    let at_gate = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 10, 20)],
    };
    assert!(
        !wave3_band_violations(&ids, &[at_gate], &edges).is_empty(),
        "TEETH(c): max_level == edge.min_level must be flagged — level_gate_met is inclusive \
         (>=), so this ships a wild catch that auto-evolves the instant it is caught"
    );

    // (d) max_level > edge.min_level — clearly past the gate.
    let past_gate = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 10, 21)],
    };
    assert!(
        !wave3_band_violations(&ids, &[past_gate], &edges).is_empty(),
        "TEETH(d): max_level > edge.min_level must be flagged"
    );

    // Paired GOOD: max_level one below the gate.
    let below_gate = EncounterTable {
        zone_id: 1,
        encounter_rate: 150,
        entries: vec![synth_entry(40, 6, 10, 19)],
    };
    assert!(
        wave3_band_violations(&ids, &[below_gate], &edges).is_empty(),
        "TEETH(GOOD): max_level strictly below the gate must NOT be flagged"
    );
}

// ===========================================================================
// RW3-09 — CONTENT_VERSION floor >= 21
// ===========================================================================

/// WHY this test exists: `server-module/src/content.rs` early-returns from
/// `sync_content_inner` when the DB's stored content version EQUALS
/// `CONTENT_VERSION`. Without a bump, Voltkit/Aurelet's new zone-1 placement
/// parses, validates, hashes and passes CI while NEVER reaching a deployed
/// database — the ADR-0054 silent-skip trap.
#[test]
fn rw3c_9_content_version_floor_is_at_least_21() {
    let src = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../server-module/src/lib.rs"
    ))
    .expect("server-module/src/lib.rs must be readable from game-core/tests");
    let version = parse_content_version(&src)
        .expect("rw3c-9: the CONTENT_VERSION declaration must be present and parseable");
    assert!(
        version >= 21,
        "rw3c-9: CONTENT_VERSION is {version}; the rw3c tuning pass (zone-1 placement for \
         Voltkit/Aurelet) needs >= 21 or sync_content_inner early-returns and the new placement \
         never reaches a live DB (CONTENT_VERSION was 20 when this slice opened)"
    );
}

#[test]
fn rw3c_teeth_content_version_parser_is_decoy_hardened() {
    let synthetic = ["pub(crate) const ", "CONTENT_VERSION", ": u32 = ", "21;\n"].concat();
    assert_eq!(
        parse_content_version(&synthetic),
        Some(21),
        "TEETH(g/1): the needle parser must read the version out of a canonical declaration"
    );

    // (g) a decoy MIN_SUPPORTED_CONTENT_VERSION declared ABOVE the real one
    // must not shadow it — proves word-boundary anchoring.
    let decoyed = [
        "pub(crate) const MIN_SUPPORTED_",
        "CONTENT_VERSION",
        ": u32 = ",
        "99;\npub(crate) const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "21;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&decoyed),
        Some(21),
        "TEETH(g/2): a decoy constant merely ending in the needle, declared above the real one, \
         must NOT shadow the real CONTENT_VERSION"
    );

    // (g) a genuine SECOND CONTENT_VERSION declaration must return None, not
    // guess by taking the first hit.
    let doubled = [
        "const ",
        "CONTENT_VERSION",
        ": u32 = ",
        "21;\nconst ",
        "CONTENT_VERSION",
        ": u32 = ",
        "22;\n",
    ]
    .concat();
    assert_eq!(
        parse_content_version(&doubled),
        None,
        "TEETH(g/3): two real declarations must be reported as unparseable, not guessed"
    );
}
