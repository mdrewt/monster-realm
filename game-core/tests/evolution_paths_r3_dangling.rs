//! R3 of `validate_evolution_paths`: an evolution edge whose `from_species` or
//! `to_species` names no loaded species is rejected before `sync_content`
//! writes anything. Exercised on the real shipped content with one edge
//! re-pointed at an id no species uses.

use game_core::{
    load_encounters, load_evolution_paths, load_items, load_species, validate_evolution_paths,
};

const UNKNOWN_SPECIES: u32 = 999_999;

#[test]
fn r3_rejects_an_edge_to_or_from_an_unknown_species() {
    let species = load_species().expect("species parse");
    let paths = load_evolution_paths().expect("evolution paths parse");
    let encounters = load_encounters().expect("encounters parse");
    let items = load_items().expect("items parse");
    assert!(species.iter().all(|s| s.id != UNKNOWN_SPECIES));
    assert!(
        !paths.is_empty(),
        "shipped content must have evolution edges"
    );

    // Non-vacuity: the unmodified content passes, so a failure below is R3's.
    validate_evolution_paths(&species, &paths, &encounters, &items)
        .expect("shipped evolution graph validates");

    let mut bad_from = paths.clone();
    bad_from[0].from_species = UNKNOWN_SPECIES;
    let err = validate_evolution_paths(&species, &bad_from, &encounters, &items)
        .expect_err("dangling from_species must be rejected");
    assert!(
        err.starts_with("R3:") && err.contains("missing from_species 999999"),
        "{err}"
    );

    let mut bad_to = paths.clone();
    bad_to[0].to_species = UNKNOWN_SPECIES;
    let err = validate_evolution_paths(&species, &bad_to, &encounters, &items)
        .expect_err("dangling to_species must be rejected");
    assert!(
        err.starts_with("R3:") && err.contains("missing to_species 999999"),
        "{err}"
    );
}
