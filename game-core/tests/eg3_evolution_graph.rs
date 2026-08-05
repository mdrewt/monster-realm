//! Slice EG3 — evolution-path content (ADR-0176, spec EG3-1..EG3-9) gating
//! tests.
//!
//! The ten-edge `evolution_paths/000-core.ron` graph and the items
//! 4/5 (`essence_affinity`/`essence_amount`) + shop 1 stocking changes
//! described in ADR-0176 have landed. These tests were originally written
//! RED against the pre-content state (an empty `evolution_paths` registry
//! and un-essenced items 4/5, EG1's deliberate placeholder, ADR-0174 D6) and
//! now exercise the real, authored registry end-to-end.
//!
//! T1..T11 mirror the spec-handoff task list 1:1; each negative/TEETH half
//! constructs its violation on a CLONE of the loaded `Vec`, never on the
//! shipped RON (`item_evolution_content.rs`'s doctrine, carried over
//! verbatim). Several negative halves must isolate a single rule against the
//! DECLARED R1->R12 evaluation order (`content.rs:954-957`) rather than the
//! first rule the mutation happens to trip — see T3/T4 (must trip R1, not an
//! incidental later rule) and especially T6 (R11 is mutually inescapable
//! against the live ten-edge graph: every species is either edge-participating,
//! which trips R5 first, or edge-free with `tier > 0`... wait, edge-free
//! `tier > 0` species trip R10 first; T6's doc comment on
//! `t6_r11_tier_cap` works through this in full and lands on the one fixture
//! shape — an empty path set — that reaches R11 at all).

use std::collections::{HashMap, HashSet};

use game_core::{
    load_encounters, load_evolution_paths, load_items, load_shops, load_species,
    validate_evolution_paths, Affinity, EncounterTable, EssenceRequirement, EvolutionPath, ItemDef,
    Species, StatKind, TrustTier,
};

// ===========================================================================
// Shared fixture: the live, on-disk registry (never mutated in place — every
// negative half below clones first).
// ===========================================================================

/// Load the four registries `validate_evolution_paths` cross-checks.
///
/// # Panics
/// Panics (via `expect`) if any registry fails to parse — a parse failure is
/// not this file's concern (it is covered elsewhere) and would make every
/// downstream assertion meaningless.
fn live_world() -> (
    Vec<Species>,
    Vec<EvolutionPath>,
    Vec<EncounterTable>,
    Vec<ItemDef>,
) {
    let species = load_species().expect("species registry must parse");
    let paths = load_evolution_paths().expect("evolution_paths registry must parse");
    let encounters = load_encounters().expect("encounters registry must parse");
    let items = load_items().expect("items registry must parse");
    (species, paths, encounters, items)
}

fn essence(pairs: &[(Affinity, u32)]) -> Vec<EssenceRequirement> {
    pairs
        .iter()
        .map(|&(affinity, amount)| EssenceRequirement { affinity, amount })
        .collect()
}

/// The ten pinned edges (ADR-0176), expressed as tuples for the T2 pin and
/// reused by other tests that need "the edge with this id".
#[allow(clippy::type_complexity)]
fn expected_edges() -> Vec<(u32, u32, u32, u8, Vec<(Affinity, u32)>, Option<TrustTier>)> {
    vec![
        (1, 1, 4, 20, vec![], None),
        (
            2,
            1,
            5,
            1,
            vec![(Affinity::Fire, 150)],
            Some(TrustTier::Friendly),
        ),
        (3, 1, 6, 20, vec![(Affinity::Water, 120)], None),
        (4, 2, 6, 20, vec![(Affinity::Fire, 120)], None),
        (5, 7, 9, 18, vec![], None),
        (6, 7, 30, 15, vec![(Affinity::Water, 100)], None),
        (7, 8, 10, 20, vec![], None),
        (8, 8, 31, 17, vec![(Affinity::Fire, 100)], None),
        (9, 20, 22, 22, vec![], None),
        (10, 21, 23, 1, vec![], Some(TrustTier::Friendly)),
    ]
}

// ===========================================================================
// T1 — live registry passes validate_evolution_paths -> Ok(())
// ===========================================================================

/// Kills `load_evolution_paths -> Ok(vec![])` (the mutant EG1's blessed
/// exclusion covers today) once ten real edges replace the empty placeholder:
/// an empty graph passes R1-R12 trivially (the R10 carve-out), so this
/// assertion alone cannot bite until content exists — T2/T5/T6 below close
/// that gap with pins that DO fail against an empty or wrong graph.
#[test]
fn t1_live_registry_passes_validate_evolution_paths() {
    let (species, paths, encounters, items) = live_world();
    let result = validate_evolution_paths(&species, &paths, &encounters, &items);
    assert!(
        result.is_ok(),
        "T1: the live evolution-path registry must validate cleanly: {result:?}"
    );
}

// ===========================================================================
// T2 — the registry pins EXACTLY the ten edges, field-for-field
// ===========================================================================

/// Kills a silent retune (any edge_id/from/to/level/essence/trust changed) or
/// a wrong edge count (missing/extra edge), and kills
/// `load_evolution_paths -> Ok(vec![])` directly: an empty `Vec` fails the
/// length assertion immediately.
#[test]
fn t2_registry_pins_exactly_the_ten_edges() {
    let (_species, paths, _encounters, _items) = live_world();
    assert_eq!(
        paths.len(),
        10,
        "T2: the evolution_paths registry must contain exactly ten edges, got {}",
        paths.len()
    );

    let by_id: HashMap<u32, &EvolutionPath> = paths.iter().map(|p| (p.edge_id, p)).collect();

    for (edge_id, from, to, min_level, essence_pairs, trust) in expected_edges() {
        let path = by_id
            .get(&edge_id)
            .unwrap_or_else(|| panic!("T2: edge_id {edge_id} missing from the registry"));
        assert_eq!(path.from_species, from, "T2: edge {edge_id} from_species");
        assert_eq!(path.to_species, to, "T2: edge {edge_id} to_species");
        assert_eq!(
            path.min_level.as_u8(),
            min_level,
            "T2: edge {edge_id} min_level"
        );
        assert_eq!(
            path.essence,
            essence(&essence_pairs),
            "T2: edge {edge_id} essence"
        );
        assert_eq!(
            path.min_trust_tier, trust,
            "T2: edge {edge_id} min_trust_tier"
        );
        assert_eq!(
            path.min_quality_time_tier, None,
            "T2: edge {edge_id} min_quality_time_tier must be None (per the authoring table)"
        );
        assert_eq!(
            path.min_nutrition_pct, None,
            "T2: edge {edge_id} min_nutrition_pct must be None (per the authoring table)"
        );
    }
}

// ===========================================================================
// T3 — R8 fan-in POSITIVE + negative control
// ===========================================================================

/// Positive half kills a graph that drops one of the two `to_species == 6`
/// edges (fan-in silently collapsed to one source). Negative control kills a
/// `validate_evolution_paths` that stopped enforcing R1 (duplicate pairs) —
/// without it, a "positive fan-in" assertion alone would still pass on a
/// broken validator, so the negative half is what proves R8 is a real
/// PERMIT, not an accidental gap.
#[test]
fn t3_r8_fan_in_to_species_6_from_1_and_2() {
    let (species, paths, encounters, items) = live_world();

    let mut sources: Vec<u32> = paths
        .iter()
        .filter(|p| p.to_species == 6)
        .map(|p| p.from_species)
        .collect();
    sources.sort_unstable();
    assert_eq!(
        sources,
        vec![1, 2],
        "T3: exactly two edges must target species 6, from species {{1, 2}}"
    );
    assert!(
        validate_evolution_paths(&species, &paths, &encounters, &items).is_ok(),
        "T3: the live graph (which contains this fan-in) must validate Ok"
    );

    // Negative control: collapse both `to_species == 6` edges onto a single
    // `from_species` — this must trip R1 (duplicate pair), not be silently
    // accepted as "more fan-in".
    let mut broken = paths.clone();
    for path in &mut broken {
        if path.to_species == 6 {
            path.from_species = 1;
        }
    }
    let result = validate_evolution_paths(&species, &broken, &encounters, &items);
    let err = result.expect_err("T3 negative: collapsing the fan-in sources must fail");
    assert!(
        err.starts_with("R1: "),
        "T3 negative: expected an R1 duplicate-pair error, got: {err}"
    );
}

// ===========================================================================
// T4 — fan-out POSITIVE + negative control (species 7 -> {9, 30})
// ===========================================================================

/// Positive half kills a graph missing one of species 7's two out-edges.
/// Negative control (both edges retargeted to one `to_species`) kills a
/// broken R1, proving the positive pin is not vacuous.
#[test]
fn t4_fan_out_from_species_7_to_9_and_30() {
    let (species, paths, encounters, items) = live_world();

    let mut targets: Vec<u32> = paths
        .iter()
        .filter(|p| p.from_species == 7)
        .map(|p| p.to_species)
        .collect();
    targets.sort_unstable();
    assert_eq!(
        targets,
        vec![9, 30],
        "T4: exactly two edges must originate from species 7, targeting {{9, 30}}"
    );
    assert!(
        validate_evolution_paths(&species, &paths, &encounters, &items).is_ok(),
        "T4: the live graph (which contains this fan-out) must validate Ok"
    );

    // Negative control: collapse both species-7 out-edges onto one target.
    let mut broken = paths.clone();
    for path in &mut broken {
        if path.from_species == 7 {
            path.to_species = 9;
        }
    }
    let result = validate_evolution_paths(&species, &broken, &encounters, &items);
    let err = result.expect_err("T4 negative: collapsing the fan-out targets must fail");
    assert!(
        err.starts_with("R1: "),
        "T4 negative: expected an R1 duplicate-pair error, got: {err}"
    );
}

// ===========================================================================
// T5 — R10 universal reachability
// ===========================================================================

/// Positive half kills a graph where any `tier > 0` species is missing an
/// in-edge. Negative half removes species 22's SOLE in-edge (edge_id 9) —
/// deliberately not species 6, which has two in-edges and would leave R10
/// silently satisfied by the surviving edge (a vacuous, non-biting test).
#[test]
fn t5_r10_universal_reachability() {
    let (species, paths, encounters, items) = live_world();

    let reachable: HashSet<u32> = paths.iter().map(|p| p.to_species).collect();
    for sp in &species {
        if sp.tier > 0 {
            assert!(
                reachable.contains(&sp.id),
                "T5: species {} (tier {}) must be the to_species of at least one edge",
                sp.id,
                sp.tier
            );
        }
    }

    // Negative: species 22's only in-edge is edge_id 9 (20 -> 22). Removing
    // it must trip R10 by name.
    let mut broken = paths.clone();
    let before = broken.len();
    broken.retain(|p| p.edge_id != 9);
    assert_eq!(
        broken.len(),
        before - 1,
        "T5 negative: edge_id 9 must exist in the live graph to be removed"
    );
    let result = validate_evolution_paths(&species, &broken, &encounters, &items);
    let err = result.expect_err("T5 negative: removing species 22's sole in-edge must fail");
    assert!(
        err.contains("R10"),
        "T5 negative: expected an R10 unreachable-species error, got: {err}"
    );
}

// ===========================================================================
// T6 — R11 tier cap
// ===========================================================================

/// Positive half kills a species accidentally authored above the cap (or a
/// cap that silently regressed to 0, which max <= 5 alone wouldn't catch —
/// hence the `>= 1` non-vacuity half). Negative half kills a
/// `validate_evolution_paths` that stopped enforcing R11.
///
/// The negative fixture MUST run against an EMPTY path set. R11 is a pure
/// species-set rule (it never reads `paths`), but every other rule outranks
/// it in the DECLARED R1->R12 order (`content.rs:954-957`), and against the
/// live ten-edge graph R11 is *mutually inescapable*: bumping an
/// edge-participating species (e.g. species 1, a `from_species` of edges
/// 1-3) trips R5 first ("R5: edge 1 breaks tier monotonicity"), and bumping
/// an edge-FREE species (e.g. species 3, Sproutlet — ADR-0176 D4's
/// deliberate tier-0 dead end) instead trips R10 ("species 3 ... is
/// unreachable"), because R10 requires every `tier > 0` species to be a
/// `to_species` and a freshly tier-6 Sproutlet has no in-edge. No species in
/// the live registry can isolate R11 while the live paths are present. The
/// only fixture shape that reaches R11 is `paths == &[]`: R1-R8 then iterate
/// nothing (vacuously pass) and R10 hits its documented empty-set carve-out
/// (`content.rs:1086`), leaving R11 as the sole rule that can still fire.
/// Sanity check: with R11 hypothetically deleted, this exact fixture (live
/// species with one bumped to tier 6, empty paths) would return `Ok(())` —
/// no other rule reads the tier-6 value — so `expect_err` below is a real
/// bite, not a vacuous pass-through from some other rule.
#[test]
fn t6_r11_tier_cap() {
    let (species, _paths, encounters, items) = live_world();

    let max_tier = species.iter().map(|sp| sp.tier).max().unwrap_or(0);
    assert!(
        max_tier <= 5,
        "T6: no species may exceed tier 5 (R11), found max tier {max_tier}"
    );
    assert!(
        max_tier >= 1,
        "T6: the live registry must contain at least one tier > 0 species (non-vacuity), got \
         max tier {max_tier}"
    );

    let mut broken_species = species.clone();
    let sproutlet = broken_species
        .iter_mut()
        .find(|sp| sp.id == 3)
        .expect("T6 negative: species 3 (Sproutlet) must exist");
    sproutlet.tier = 6;
    let result = validate_evolution_paths(&broken_species, &[], &encounters, &items);
    let err = result.expect_err("T6 negative: a tier-6 species must fail validation");
    assert!(
        err.contains("R11"),
        "T6 negative: expected an R11 tier-cap error, got: {err}"
    );
}

// ===========================================================================
// T7 — R12 edge_id uniqueness
// ===========================================================================

/// Positive half kills a duplicated or gapped edge_id set (any id outside
/// exactly {1..=10}). Negative half kills a `validate_evolution_paths` that
/// stopped enforcing R12.
#[test]
fn t7_r12_edge_id_uniqueness() {
    let (species, paths, encounters, items) = live_world();

    let mut ids: Vec<u32> = paths.iter().map(|p| p.edge_id).collect();
    ids.sort_unstable();
    let expected: Vec<u32> = (1..=10).collect();
    assert_eq!(
        ids, expected,
        "T7: edge_ids must be exactly {{1..=10}}, got {ids:?}"
    );

    let mut broken = paths.clone();
    assert!(
        broken.len() >= 2,
        "T7 negative: fixture requires at least two edges"
    );
    broken[1].edge_id = broken[0].edge_id;
    let result = validate_evolution_paths(&species, &broken, &encounters, &items);
    let err = result.expect_err("T7 negative: a duplicated edge_id must fail validation");
    assert!(
        err.contains("R12"),
        "T7 negative: expected an R12 duplicate-edge_id error, got: {err}"
    );
}

// ===========================================================================
// T8 — R9 essence items are single-role
// ===========================================================================

/// Positive half kills an item 4/5 that silently regained a training/curing
/// role, or lost `essence_affinity`/`essence_amount`. Negative half kills a
/// `validate_evolution_paths` that stopped enforcing R9.
#[test]
fn t8_r9_essence_items_are_single_role() {
    let (species, paths, encounters, items) = live_world();

    for (id, affinity) in [(4u32, Affinity::Water), (5, Affinity::Fire)] {
        let item = items
            .iter()
            .find(|i| i.id == id)
            .unwrap_or_else(|| panic!("T8: item {id} missing from load_items()"));
        assert_eq!(
            item.essence_affinity,
            Some(affinity),
            "T8: item {id} essence_affinity"
        );
        assert_eq!(item.essence_amount, 100, "T8: item {id} essence_amount");
        assert!(
            item.train_stat.is_none(),
            "T8: item {id} train_stat must be None (R9 single-role)"
        );
        assert!(
            item.cure_status.is_none(),
            "T8: item {id} cure_status must be None (R9 single-role)"
        );
    }

    let mut broken_items = items.clone();
    let item4 = broken_items
        .iter_mut()
        .find(|i| i.id == 4)
        .expect("T8 negative: item 4 must exist");
    item4.train_stat = Some(StatKind::Attack);
    let result = validate_evolution_paths(&species, &paths, &encounters, &broken_items);
    let err = result.expect_err("T8 negative: a dual-role essence item must fail validation");
    assert!(
        err.contains("R9"),
        "T8 negative: expected an R9 single-role error, got: {err}"
    );
}

// ===========================================================================
// T9 — EG3-8 "one feed clears the bar"
// ===========================================================================

/// Kills an author mismatch between an item-assisted edge's essence
/// requirement and the corresponding trigger item's `essence_amount` (e.g.
/// item 4 shipped at 80 essence against edge 6's 100 requirement — a feed
/// that does NOT clear the bar).
#[test]
fn t9_one_feed_clears_the_bar() {
    let (_species, paths, _encounters, items) = live_world();

    let edge6 = paths
        .iter()
        .find(|p| p.edge_id == 6)
        .expect("T9: edge_id 6 (7 -> 30, Water) must exist");
    let item4 = items
        .iter()
        .find(|i| i.id == 4)
        .expect("T9: item 4 (Tidewell Shard) must exist");
    let water_req = edge6
        .essence
        .iter()
        .find(|r| r.affinity == Affinity::Water)
        .expect("T9: edge 6 must carry a Water essence requirement");
    assert_eq!(item4.essence_affinity, Some(Affinity::Water));
    assert!(
        item4.essence_amount >= water_req.amount,
        "T9: item 4's essence_amount ({}) must clear edge 6's Water requirement ({}) in one feed",
        item4.essence_amount,
        water_req.amount
    );

    let edge8 = paths
        .iter()
        .find(|p| p.edge_id == 8)
        .expect("T9: edge_id 8 (8 -> 31, Fire) must exist");
    let item5 = items
        .iter()
        .find(|i| i.id == 5)
        .expect("T9: item 5 (Emberheart Cinder) must exist");
    let fire_req = edge8
        .essence
        .iter()
        .find(|r| r.affinity == Affinity::Fire)
        .expect("T9: edge 8 must carry a Fire essence requirement");
    assert_eq!(item5.essence_affinity, Some(Affinity::Fire));
    assert!(
        item5.essence_amount >= fire_req.amount,
        "T9: item 5's essence_amount ({}) must clear edge 8's Fire requirement ({}) in one feed",
        item5.essence_amount,
        fire_req.amount
    );
}

// ===========================================================================
// T10 — shop 1 stocks items 4/5 at buy_price 500, sell/buy 40% convention
// ===========================================================================

/// Kills a shop that forgets to stock items 4/5, stocks them at the wrong
/// price, or breaks the file's documented 40% sell/buy convention.
#[test]
fn t10_shop_1_stocks_items_4_and_5_at_500() {
    let shops = load_shops().expect("shops registry must parse");
    let items = load_items().expect("items registry must parse");

    let shop1 = shops
        .iter()
        .find(|s| s.id == 1)
        .expect("T10: shop 1 must exist");

    for id in [4u32, 5] {
        let entry = shop1
            .stock
            .iter()
            .find(|e| e.item_id == id)
            .unwrap_or_else(|| panic!("T10: shop 1 must stock item {id}"));
        assert_eq!(entry.buy_price, 500, "T10: item {id} buy_price");

        let item = items
            .iter()
            .find(|i| i.id == id)
            .unwrap_or_else(|| panic!("T10: item {id} missing from load_items()"));
        assert_eq!(item.sell_price, 200, "T10: item {id} sell_price");
        assert_eq!(
            item.sell_price * 5,
            entry.buy_price * 2,
            "T10: item {id} must follow the 40% sell/buy convention (sell*5 == buy*2)"
        );
    }
}

// ===========================================================================
// T11 — ADR-0176 D2 regression guard: no out-edge is temporally dominated
// ===========================================================================

/// Test-local invariant (deliberately NOT added to `validate_evolution_paths`
/// — ADR-0176 D2 proposes it as a future R13 candidate for the EG5-1 gate
/// rewrite). For every species with 2+ out-edges, either ALL out-edges share
/// one `min_level`, or the lowest-`min_level` out-edge carries at least one
/// additional gate. Without this, an unconditional low-level edge races its
/// siblings to death under EG2-11 auto-evolution: the first monster to hit
/// that level auto-resolves onto the dominant edge before any sibling with a
/// higher `min_level` (or the same level but an unmet essence/history gate)
/// ever becomes eligible, permanently starving that sibling in practice.
#[test]
fn t11_no_out_edge_is_temporally_dominated() {
    let (_species, paths, _encounters, _items) = live_world();

    let mut by_source: HashMap<u32, Vec<&EvolutionPath>> = HashMap::new();
    for path in &paths {
        by_source.entry(path.from_species).or_default().push(path);
    }

    for (from_species, out_edges) in &by_source {
        if out_edges.len() < 2 {
            continue;
        }
        let levels: Vec<u8> = out_edges.iter().map(|p| p.min_level.as_u8()).collect();
        let all_same_level = levels.iter().all(|&lv| lv == levels[0]);
        if all_same_level {
            continue;
        }
        let min_level = *levels.iter().min().expect("out_edges is non-empty");
        for edge in out_edges {
            if edge.min_level.as_u8() != min_level {
                continue;
            }
            let has_extra_gate = !edge.essence.is_empty()
                || edge.min_trust_tier.is_some()
                || edge.min_quality_time_tier.is_some()
                || edge.min_nutrition_pct.is_some();
            let edge_id = edge.edge_id;
            assert!(
                has_extra_gate,
                "T11: species {from_species}'s lowest-min_level out-edge (edge_id {edge_id}, \
                 level {min_level}) carries no essence or history gate — under EG2-11 \
                 auto-evolution it races and permanently starves its higher-level sibling(s); \
                 levels seen: {levels:?}"
            );
        }
    }
}
