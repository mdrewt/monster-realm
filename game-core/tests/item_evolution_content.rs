//! Slice B — item-triggered evolution content (ADR-0149, EARS B-1..B-5) gating
//! tests.
//!
//! RED-first: these tests are written BEFORE the content lands (species 7/8's
//! evolutions blocks gain an `Item` branch; new species 30/31 in id band
//! 30..=39; two new `ItemDef` rows). They encode the criteria pinned by
//! ADR-0149 and carry proof-of-teeth built from SYNTHETIC RON strings /
//! in-memory structs — never by mutating the live registry files (a tooth
//! that edits shipped content is not a tooth, it is a content change;
//! ownership of the implementation is split from this file on purpose,
//! mirroring `pt_d1_roster.rs` / `pt_d3_tuning.rs`).
//!
//! Criteria:
//!   T-B1a   exactly one evolutions block per source species (7 and 8)
//!   T-B1b   each block has exactly 2 branches: the pinned Level branch
//!           VERBATIM + exactly one Item branch targeting the new form
//!   T-B1c   ORDERING tooth (ADR-0149 D2): Item declared FIRST so it can
//!           resolve above the level threshold; passive behavior unchanged
//!   TEETH-B1 a synthetic duplicate evolutions block for species 7 is Err
//!   T-B2    no species-7/8 branch targets species 6 (fusion.ron's sole
//!           output) — same-round-only disjointness (spec Decision)
//!   TEETH-B2 the `branches_targeting` helper bites a synthetic violation and
//!           does not flag the good fixture (two-sided non-vacuity)
//!   T-B3a   the two new ItemDef rows exist with the exact pinned shape
//!   T-B3b   cross-registry closure: every Item trigger id in evolutions
//!           resolves in items, and the live registry validates end-to-end
//!   T-S1    species 30/31 exist with the exact pinned shape and are never
//!           wild-catchable
//!   T-S2    power-band + sidegrade gate (BST ordering + 440..=490 band)
//!   TEETH-S2 case table: one single-field mutation per branch must be
//!           flagged, plus a GOOD fixture that must report nothing
//!
//! NOT duplicated here (cited, not re-authored — YAGNI):
//!   - STAB (species 30/31 can learn a same-affinity move) is already covered
//!     registry-wide by `pt_d1_roster.rs::pt_d1_3_every_species_can_learn_a_same_affinity_skill`.
//!   - The dangling-Item-id validator path is already proven by
//!     `game_core::content::tests::m10a_dangling_item_trigger_ref_rejected`
//!     (`game-core/src/content.rs`) — an unknown `Item` id is already Err.

use game_core::{
    base_stat_total, load_encounters, load_evolutions, load_fusion, load_items, load_species,
    parse_evolutions, resolve_evolution, validate_evolution_fusion, Affinity, Bond,
    EvolutionCondition, EvolutionTrigger, ItemDef, Level, Species, SpeciesEvolutions, StatBlock,
};

// ===========================================================================
// Shared synthetic-fixture helpers (never applied to the live registry)
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

fn cond_level(threshold: u8, to_species: u32) -> EvolutionCondition {
    EvolutionCondition {
        trigger: EvolutionTrigger::Level(Level::new(threshold).expect("level in [1,100]")),
        to_species,
    }
}

fn cond_item(item_id: u32, to_species: u32) -> EvolutionCondition {
    EvolutionCondition {
        trigger: EvolutionTrigger::Item(item_id),
        to_species,
    }
}

fn find_species(species: &[Species], id: u32) -> Option<&Species> {
    species.iter().find(|s| s.id == id)
}

fn find_item(items: &[ItemDef], id: u32) -> Option<&ItemDef> {
    items.iter().find(|i| i.id == id)
}

// ===========================================================================
// T-B1a — exactly ONE evolutions block per source species (7 and 8)
// ===========================================================================

#[test]
fn t_b1a_exactly_one_evolutions_block_for_7_and_8() {
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    for src in [7u32, 8] {
        let blocks: Vec<&SpeciesEvolutions> =
            evolutions.iter().filter(|b| b.species_id == src).collect();
        assert_eq!(
            blocks.len(),
            1,
            "T-B1a: exactly ONE evolutions block for species {src} (a second block is a \
             validator Err per ADR-0149 B-1 — append to the EXISTING block, never create a \
             new SpeciesEvolutions block)"
        );
    }
}

// ===========================================================================
// T-B1b — each block has exactly 2 branches: pinned Level branch VERBATIM +
// exactly one Item branch. This REPLACES the old length-1 pin in
// pt_d1_roster.rs (see the edit to that file for the ADR-0149 D7 rationale).
// ===========================================================================

#[test]
fn t_b1b_branch_shape_is_level_plus_item_for_7_and_8() {
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    for (src, level, level_target, item_id, item_target) in
        [(7u32, 18u8, 9u32, 4u32, 30u32), (8, 20, 10, 5, 31)]
    {
        let block = evolutions
            .iter()
            .find(|b| b.species_id == src)
            .unwrap_or_else(|| panic!("T-B1b: species {src} must have an evolutions block"));
        assert_eq!(
            block.evolutions.len(),
            2,
            "T-B1b: species {src} must have exactly 2 branches (the pinned Level branch + one \
             new Item branch), got {:?}",
            block.evolutions
        );

        let want_level = cond_level(level, level_target);
        let level_count = block
            .evolutions
            .iter()
            .filter(|c| *c == &want_level)
            .count();
        assert_eq!(
            level_count, 1,
            "T-B1b: species {src} must still carry Level({level}) -> {level_target} VERBATIM \
             exactly once — a replaced or duplicated level branch must be caught here"
        );

        let want_item = cond_item(item_id, item_target);
        let item_count = block.evolutions.iter().filter(|c| *c == &want_item).count();
        assert_eq!(
            item_count, 1,
            "T-B1b: species {src} must carry exactly one Item({item_id}) -> {item_target} \
             branch — kills a missing branch or a duplicated one"
        );
    }
}

// ===========================================================================
// T-B1c — ORDERING tooth (ADR-0149 D2): Item declared FIRST.
//
// At level 100 (>= both thresholds) with no item applied, resolution must
// still yield the passive Level target (regression guard — every existing
// passive caller is unaffected). With the item APPLIED, resolution must yield
// the Item target — which is RED if the Item branch is declared SECOND (the
// Level branch would fire first at level >= 18/20 and the item would never be
// consulted, exactly the hazard ADR-0149 D2/B2-2 exists to prevent).
// ===========================================================================

#[test]
fn t_b1c_item_branch_declared_first_wins_above_level_threshold() {
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    let max_level = Level::new(100).expect("100 is a valid level");
    let max_bond = Bond::new(255);

    for (src, passive_target, item_id, item_target) in [(7u32, 9u32, 4u32, 30u32), (8, 10, 5, 31)] {
        let block = evolutions
            .iter()
            .find(|b| b.species_id == src)
            .unwrap_or_else(|| panic!("T-B1c: species {src} must have an evolutions block"));

        assert_eq!(
            resolve_evolution(&block.evolutions, max_level, max_bond, None),
            Some(passive_target),
            "T-B1c: species {src} passive resolution (no item applied) at max level/bond must \
             still yield {passive_target} — every existing passive caller must be unaffected \
             by the new Item branch"
        );

        assert_eq!(
            resolve_evolution(&block.evolutions, max_level, max_bond, Some(item_id)),
            Some(item_target),
            "T-B1c: species {src} with item {item_id} APPLIED at level 100 (>= the level \
             threshold) must resolve to {item_target}, not fall through to the level target — \
             this is RED if the Item branch is declared SECOND (ADR-0149 D2)"
        );
    }
}

// ===========================================================================
// TEETH-B1 — a synthetic duplicate evolutions block for one species is Err
// ===========================================================================

#[test]
fn teeth_b1_synthetic_duplicate_block_for_species_7_is_rejected() {
    let bad = parse_evolutions(
        "[(species_id: 7, evolutions: [(trigger: Level(18), to_species: 9)]),
          (species_id: 7, evolutions: [(trigger: Item(4), to_species: 30)])]",
    )
    .expect("fixture must parse (the violation is semantic, not syntactic)");
    let species = vec![
        synth(7, Affinity::Earth, &[9], stats(60, 55, 70, 30, 40, 55)),
        synth(9, Affinity::Earth, &[9], stats(90, 75, 105, 35, 60, 85)),
        synth(30, Affinity::Water, &[3], stats(84, 60, 90, 46, 94, 78)),
    ];
    assert!(
        validate_evolution_fusion(&species, &bad, &[], &[], &[]).is_err(),
        "TEETH-B1: a second evolutions block for species 7 (even a well-formed Item branch) \
         must be rejected"
    );
}

// ===========================================================================
// T-B2 — no species-7/8 branch targets species 6 (fusion.ron's sole output)
// ===========================================================================

/// Returns the `species_id` of every block in `sources` that carries a branch
/// targeting `target`. Scoped by `sources` on purpose (per the spec Decision:
/// the fusion/evolution disjointness is same-round-only) — a registry-wide
/// "nothing ever evolves into 6" gate would over-bind a future wave.
fn branches_targeting(blocks: &[SpeciesEvolutions], sources: &[u32], target: u32) -> Vec<u32> {
    blocks
        .iter()
        .filter(|b| sources.contains(&b.species_id))
        .filter(|b| b.evolutions.iter().any(|c| c.to_species == target))
        .map(|b| b.species_id)
        .collect()
}

#[test]
fn t_b2_no_species_7_or_8_branch_targets_species_6() {
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    let violators = branches_targeting(&evolutions, &[7, 8], 6);
    assert!(
        violators.is_empty(),
        "T-B2: species 7/8 must never gain a branch targeting species 6 (fusion.ron's sole \
         output) — violators: {violators:?}"
    );
}

// ===========================================================================
// TEETH-B2 — the helper bites a synthetic violation; the good fixture is
// clean (two-sided non-vacuity, mirroring pt_d1_roster.rs's pattern)
// ===========================================================================

#[test]
fn teeth_b2_branches_targeting_flags_bad_and_clears_good() {
    let bad = vec![SpeciesEvolutions {
        species_id: 7,
        evolutions: vec![cond_item(4, 6)],
    }];
    assert_eq!(
        branches_targeting(&bad, &[7, 8], 6),
        vec![7],
        "TEETH-B2: a synthetic species-7 branch targeting 6 must be flagged"
    );

    let good = vec![SpeciesEvolutions {
        species_id: 7,
        evolutions: vec![cond_item(4, 30), cond_level(18, 9)],
    }];
    assert!(
        branches_targeting(&good, &[7, 8], 6).is_empty(),
        "TEETH-B2: the good fixture (branch targets 30, not 6) must NOT be flagged — else the \
         tooth above is vacuous"
    );
}

// ===========================================================================
// T-B3a — the two new ItemDef rows exist with the exact pinned shape
// ===========================================================================

#[test]
fn t_b3a_new_trigger_items_have_exact_shape() {
    let items = load_items().expect("items registry must parse");

    for (id, name) in [(4u32, "Tidewell Shard"), (5, "Emberheart Cinder")] {
        let item = find_item(&items, id)
            .unwrap_or_else(|| panic!("T-B3a: item {id} ({name}) missing from load_items()"));
        assert_eq!(item.name, name, "T-B3a: item {id} name");
        assert!(
            !item.description.is_empty(),
            "T-B3a: item {id} description must be non-empty"
        );
        assert_eq!(
            item.sell_price, 200,
            "T-B3a: item {id} sell_price must be exactly 200 (ADR-0149 D5)"
        );
        assert_eq!(
            item.recruit_bonus, 0,
            "T-B3a: item {id} recruit_bonus must be 0 — this is a trigger item, not bait \
             (kills a copy-paste of item 1's Lure Berry row)"
        );
        assert!(
            item.train_stat.is_none(),
            "T-B3a: item {id} train_stat must be None (kills a copy-paste of item 2's Power \
             Root row)"
        );
        assert_eq!(
            item.train_amount, 0,
            "T-B3a: item {id} train_amount must be 0"
        );
        assert!(
            item.cure_status.is_none(),
            "T-B3a: item {id} cure_status must be None — this is not a battle-use cure item"
        );
    }
}

// ===========================================================================
// T-B3b — cross-registry closure: every Item trigger id in evolutions exists
// in items, and the live merged registry validates end-to-end.
// ===========================================================================

#[test]
fn t_b3b_item_triggers_resolve_and_live_registry_validates() {
    let species = load_species().expect("species registry must parse");
    // NOTE: the skills/type-chart half of registry validation (`validate_content`)
    // is already asserted registry-wide by `pt_d1_1_live_registry_still_validates_end_to_end`
    // — not re-loaded or re-authored here (YAGNI).
    let items = load_items().expect("items registry must parse");
    let evolutions = load_evolutions().expect("evolutions registry must parse");
    let fusion = load_fusion().expect("fusion registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");

    let mut item_trigger_ids: Vec<u32> = Vec::new();
    for se in &evolutions {
        for cond in &se.evolutions {
            if let EvolutionTrigger::Item(id) = &cond.trigger {
                item_trigger_ids.push(*id);
            }
        }
    }
    assert!(
        !item_trigger_ids.is_empty(),
        "T-B3b: expected at least the two new Item triggers (4, 5) declared in evolutions.ron \
         — found none; the item-triggered evolution content is missing"
    );

    let item_ids: std::collections::BTreeSet<u32> = items.iter().map(|i| i.id).collect();
    for id in &item_trigger_ids {
        assert!(
            item_ids.contains(id),
            "T-B3b: evolutions.ron declares Item({id}) but load_items() has no item {id} — \
             dangling item trigger reference"
        );
    }

    // Belt-and-suspenders: `validate_evolution_fusion` already proves an
    // unknown Item id is Err elsewhere (`content.rs`'s
    // `m10a_dangling_item_trigger_ref_rejected`) — not re-authored here.
    assert_eq!(
        validate_evolution_fusion(&species, &evolutions, &fusion, &encounters, &items),
        Ok(()),
        "T-B3b: the live merged registry (species 30/31 + items 4/5 + evolutions branches) \
         must be cross-registry clean"
    );
}

// ===========================================================================
// T-S1 — species 30/31 exist with the exact pinned shape, never wild-legal
// ===========================================================================

#[test]
fn t_s1_new_derived_species_have_exact_shape() {
    let species = load_species().expect("species registry must parse");

    let cases: [(u32, &str, Affinity, StatBlock, &[u32]); 2] = [
        (
            30,
            "Tidecrag",
            Affinity::Water,
            stats(84, 60, 90, 46, 94, 78),
            &[3, 9],
        ),
        (
            31,
            "Cindershade",
            Affinity::Fire,
            stats(72, 68, 66, 92, 104, 64),
            &[2, 11],
        ),
    ];

    for (id, name, affinity, base, learn) in cases {
        let sp = find_species(&species, id)
            .unwrap_or_else(|| panic!("T-S1: species {id} ({name}) missing from load_species()"));
        assert_eq!(sp.name, name, "T-S1: species {id} name");
        assert_eq!(sp.affinity, affinity, "T-S1: species {id} affinity");
        assert_eq!(
            sp.base_stats, base,
            "T-S1: species {id} base_stats must match exactly"
        );
        assert_eq!(
            sp.learnable_skill_ids, learn,
            "T-S1: species {id} learnable_skill_ids (order-sensitive: first is the STAB move)"
        );
        assert_eq!(
            sp.ability, None,
            "T-S1: species {id} must have no ability (per ADR-0149 D3)"
        );
    }
}

#[test]
fn t_s1_new_derived_species_never_wild_catchable() {
    let encounters = load_encounters().expect("encounters registry must parse");
    for derived in [30u32, 31] {
        for table in &encounters {
            assert!(
                !table.entries.iter().any(|e| e.species_id == derived),
                "T-S1: derived form {derived} must never appear in zone {}'s encounter table",
                table.zone_id
            );
        }
    }
}

// ===========================================================================
// T-S2 — power-band + sidegrade gate
// ===========================================================================

/// Sidegrade + power-band predicate (ADR-0149 D4): species 30 must sit
/// strictly above species 7's BST and strictly below species 9's BST; species
/// 31 must sit strictly above species 8's BST and strictly below species
/// 10's BST; both 30 and 31's BST must land inside the established evolved
/// tier band 440..=490. Pure over its inputs (no registry access) so a
/// synthetic counterexample can prove it is not vacuous.
fn sidegrade_violations(species: &[Species]) -> Vec<String> {
    let mut out = Vec::new();
    let ids = [7u32, 8, 9, 10, 30, 31];
    for id in ids {
        if find_species(species, id).is_none() {
            out.push(format!("species {id} missing from the registry"));
        }
    }
    let (Some(s7), Some(s8), Some(s9), Some(s10), Some(s30), Some(s31)) = (
        find_species(species, 7),
        find_species(species, 8),
        find_species(species, 9),
        find_species(species, 10),
        find_species(species, 30),
        find_species(species, 31),
    ) else {
        return out;
    };

    let bst = |s: &Species| base_stat_total(&s.base_stats);
    let (bst7, bst8, bst9, bst10, bst30, bst31) =
        (bst(s7), bst(s8), bst(s9), bst(s10), bst(s30), bst(s31));

    if bst30 <= bst7 {
        out.push(format!(
            "species 30 BST {bst30} must exceed species 7 BST {bst7} (sidegrade must be a real \
             power gain over the source)"
        ));
    }
    if bst31 <= bst8 {
        out.push(format!(
            "species 31 BST {bst31} must exceed species 8 BST {bst8} (sidegrade must be a real \
             power gain over the source)"
        ));
    }
    if bst30 >= bst9 {
        out.push(format!(
            "species 30 BST {bst30} must be below species 9 BST {bst9} (sidegrade, not a \
             power-creep bypass of the level grind)"
        ));
    }
    if bst31 >= bst10 {
        out.push(format!(
            "species 31 BST {bst31} must be below species 10 BST {bst10} (sidegrade, not a \
             power-creep bypass of the level grind)"
        ));
    }

    for (id, b) in [(30u32, bst30), (31, bst31)] {
        if !(440..=490).contains(&b) {
            out.push(format!(
                "species {id} BST {b} is outside the 440..=490 power band for the evolved tier"
            ));
        }
    }

    out
}

#[test]
fn t_s2_new_forms_are_sidegrades_inside_the_power_band() {
    let species = load_species().expect("species registry must parse");
    let violations = sidegrade_violations(&species);
    assert!(
        violations.is_empty(),
        "T-S2: sidegrade + power-band gate for species 30/31: {violations:?}"
    );
}

// ===========================================================================
// TEETH-S2 — one single-field mutation per branch must be flagged, plus a
// GOOD fixture that reports nothing.
// ===========================================================================

#[test]
fn teeth_s2_sidegrade_predicate_case_table() {
    let good = || {
        vec![
            synth(7, Affinity::Earth, &[9], stats(53, 53, 53, 53, 53, 53)), // bst 318
            synth(8, Affinity::Dark, &[11], stats(54, 54, 54, 54, 54, 52)), // bst 322
            synth(9, Affinity::Earth, &[9], stats(76, 76, 76, 75, 76, 76)), // bst 455
            synth(10, Affinity::Dark, &[11], stats(79, 79, 79, 78, 78, 77)), // bst 470
            synth(30, Affinity::Water, &[3], stats(76, 75, 76, 75, 75, 75)), // bst 452
            synth(31, Affinity::Fire, &[2], stats(78, 78, 77, 78, 78, 77)), // bst 466
        ]
    };
    assert!(
        sidegrade_violations(&good()).is_empty(),
        "TEETH-S2: the GOOD fixture must pass, else the tooth is vacuous"
    );

    struct Case {
        /// Index into the good fixture (4 = species 30, 5 = species 31).
        idx: usize,
        mutate: fn(&mut Species),
        needle: &'static str,
    }
    let case = |idx, mutate: fn(&mut Species), needle| Case {
        idx,
        mutate,
        needle,
    };
    let cases = [
        // species 30 pushed to/above Stoneward's (species 9) BST 455.
        case(
            4,
            |s| s.base_stats = stats(90, 90, 90, 90, 90, 90),
            "species 30 BST",
        ),
        // species 31 dropped to/below its source (species 8) BST 322.
        case(
            5,
            |s| s.base_stats = stats(10, 10, 10, 10, 10, 10),
            "species 31 BST",
        ),
        // an all-255s outlier, far above the 440..=490 power band.
        case(
            4,
            |s| s.base_stats = stats(255, 255, 255, 255, 255, 255),
            "power band",
        ),
    ];
    for Case {
        idx,
        mutate,
        needle,
    } in cases
    {
        let mut fixture = good();
        mutate(&mut fixture[idx]);
        let violations = sidegrade_violations(&fixture);
        assert!(
            violations.iter().any(|v| v.contains(needle)),
            "TEETH-S2: mutating fixture[{idx}] must produce a violation naming `{needle}`; got \
             {violations:?}"
        );
    }
}
