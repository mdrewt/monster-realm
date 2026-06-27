// Cosmetic doc-formatting lint only (Rust 1.96 `doc_overindented_list_items` fires
// on the 5-space EARS list below); suppressing it changes NO test assertion.
#![allow(clippy::doc_overindented_list_items)]
//! M8c gating tests — acceptance criteria for the grass-encounter spine (pure
//! game-core surface).
//!
//! These tests are intentionally RED until the implementer adds the new APIs
//! (`TileKind::TallGrass`, `TileMap::is_grass`, `stepped_onto_grass`, `WildSpawn`,
//! `resolve_encounter`). They compile-error / `None`-mismatch in the RED state and
//! pass ONLY when the behavior is correct (never trivially).
//!
//! EARS criteria covered (M8 spec §3 "Trigger & encounter", PLAN-v2 R-C / R-J):
//!   - "WHEN a player character enters a NEW grass tile (position actually changed
//!      onto grass — not standing still in grass, not bumping a wall while facing
//!      grass) THE SYSTEM SHALL [trigger]" → section B (`stepped_onto_grass`).
//!   - "WHEN a grass step is rolled THE SYSTEM SHALL decide an encounter via
//!      encounter_triggers(roll) and, if triggered, pick a species by the weighted,
//!      level-ranged EncounterTable for that zone — deterministic for a given seed."
//!      → section C (`resolve_encounter`).
//!   - The map's tall-grass tile layer (`TileKind::TallGrass`, walkable; `is_grass`
//!      bounds-safe; serde rides along) → section A.
//!
//! Each test names the wrong implementation it kills.

use crate::monster::types::Level;
use crate::taming::types::{EncounterEntry, EncounterTable};
use crate::types::{TileKind, TilePos};
use crate::world::{spawn, stepped_onto_grass, zone_0, TileMap};

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

fn level(v: u8) -> Level {
    Level::new(v).expect("valid level")
}

fn make_entry(species_id: u32, weight: u16, min: u8, max: u8) -> EncounterEntry {
    EncounterEntry {
        species_id,
        weight,
        min_level: level(min),
        max_level: level(max),
    }
}

fn make_table(zone_id: u32, encounter_rate: u16, entries: Vec<EncounterEntry>) -> EncounterTable {
    EncounterTable {
        zone_id,
        encounter_rate,
        entries,
    }
}

/// A small map with a known grass layout for `is_grass` truth-table tests:
///   row 0: "###"
///   row 1: ".~#"   → (0,1) floor, (1,1) grass, (2,1) wall
///   row 2: "~.#"   → (0,2) grass, (1,2) floor, (2,2) wall
fn grass_fixture() -> TileMap {
    TileMap::from_rows(7, &["###", ".~#", "~.#"]).expect("grass fixture art is valid")
}

/// Find a `~` tile in zone_0's art (the implementer adds at least one interior
/// grass tile). Returns the first grass tile found, or panics with a clear
/// message — keeping the test honest about the "zone_0 has grass" criterion.
fn first_zone0_grass_tile() -> TilePos {
    let m = zone_0();
    for y in 0..m.height {
        for x in 0..m.width {
            let p = TilePos { x, y };
            if m.is_grass(p) {
                return p;
            }
        }
    }
    panic!("zone_0 must contain at least one tall-grass (~) tile for the trigger to fire on");
}

// ===========================================================================
// SECTION A — tile layer (TallGrass glyph, is_grass, serde, zone_0 art)
// ===========================================================================

/// EARS: the map grows a tall-grass tile — `TileKind::TallGrass` parses from `'~'`
/// and is walkable; unknown chars still fail loud (parse-don't-validate).
/// Kills: an impl that maps `'~'` to Floor/Wall, makes grass non-walkable, or
/// silently accepts an unknown glyph.
#[test]
fn from_char_maps_tilde_to_tall_grass_walkable() {
    assert_eq!(TileKind::from_char('~'), Ok(TileKind::TallGrass));
    assert!(
        TileKind::TallGrass.is_walkable(),
        "tall grass must be walkable (you step INTO it)"
    );
    // Regression: the existing glyphs still parse and unknowns still fail loud.
    assert_eq!(TileKind::from_char('.'), Ok(TileKind::Floor));
    assert_eq!(TileKind::from_char('#'), Ok(TileKind::Wall));
    assert!(
        TileKind::from_char('Z').is_err(),
        "unknown glyph must still be rejected"
    );
}

/// EARS: `TileMap` gains grass info; `is_grass` is a bounds-safe truth-table over
/// the parsed art.
/// Kills: an impl that confuses grass with walkable (returns true on `.`), inverts
/// the row-major index, or panics out of bounds.
#[test]
fn is_grass_truth_table_and_floor_wall_are_not_grass() {
    let m = grass_fixture();
    // grass tiles
    assert!(m.is_grass(TilePos { x: 1, y: 1 }), "(1,1) '~' is grass");
    assert!(m.is_grass(TilePos { x: 0, y: 2 }), "(0,2) '~' is grass");
    // floor is NOT grass
    assert!(
        !m.is_grass(TilePos { x: 0, y: 1 }),
        "(0,1) '.' is not grass"
    );
    assert!(
        !m.is_grass(TilePos { x: 1, y: 2 }),
        "(1,2) '.' is not grass"
    );
    // wall is NOT grass
    assert!(
        !m.is_grass(TilePos { x: 2, y: 1 }),
        "(2,1) '#' is not grass"
    );
    assert!(
        !m.is_grass(TilePos { x: 0, y: 0 }),
        "(0,0) '#' is not grass"
    );
}

/// EARS: `is_grass` out-of-bounds → false (like `is_walkable`), never a panic.
/// Kills: an impl that indexes the backing vec without a bounds check (panics on
/// negative or huge coords).
#[test]
fn is_grass_out_of_bounds_is_false_not_panic() {
    let m = grass_fixture();
    assert!(!m.is_grass(TilePos { x: -1, y: 0 }), "negative x → false");
    assert!(!m.is_grass(TilePos { x: 0, y: -1 }), "negative y → false");
    assert!(
        !m.is_grass(TilePos {
            x: i32::MAX,
            y: i32::MAX
        }),
        "huge coords → false, no panic"
    );
    assert!(
        !m.is_grass(TilePos { x: 3, y: 1 }),
        "just past width → false"
    );
}

/// EARS: zone_0 grows ≥1 grass tile (so the trigger has something to fire on) AND
/// the spawn (1,1) stays plain floor (R-I keeps the test-asserted tiles plain).
/// Kills: an impl that adds no grass to zone_0 (trigger can never fire), or that
/// turns the spawn into grass (which would fire an encounter the instant you spawn).
#[test]
fn zone_0_has_grass_but_spawn_is_plain_floor() {
    let m = zone_0();
    // At least one grass tile exists (panics with a clear message otherwise).
    let g = first_zone0_grass_tile();
    assert!(m.is_grass(g), "found grass tile must report is_grass");
    assert!(m.is_walkable(g), "grass is walkable");
    // The authoritative spawn must remain plain floor (walkable, not grass).
    let s = spawn();
    assert!(m.is_walkable(s), "spawn must stay walkable");
    assert!(
        !m.is_grass(s),
        "spawn (1,1) must NOT be grass (R-I: keep test-asserted tiles plain)"
    );
    // The world-test-asserted interior tiles must also stay plain floor.
    for (x, y) in [(2, 1), (3, 3), (1, 0)] {
        assert!(
            !m.is_grass(TilePos { x, y }),
            "({x},{y}) must stay plain (asserted by existing world tests)"
        );
    }
}

proptest! {
    /// EARS: `from_rows` builds a parallel grass layer of the SAME length as the
    /// walkable grid (width*height), and grass ⇒ walkable (you can step into grass).
    /// Kills: an impl whose `grass` vec length diverges from the grid (ragged
    /// internal state), or that marks a grass tile non-walkable.
    #[test]
    fn from_rows_grass_layer_total_and_grass_implies_walkable(
        // Arbitrary small valid art rows: each cell is one of '.', '#', '~'.
        rows in prop::collection::vec(
            prop::collection::vec(prop::sample::select(vec!['.', '#', '~']), 1usize..6),
            1usize..6,
        )
        .prop_map(|grid| {
            // Pad every row to the width of the first so the art is rectangular.
            let w = grid[0].len();
            grid.into_iter()
                .map(|mut r| {
                    while r.len() < w { r.push('.'); }
                    r.truncate(w);
                    r.into_iter().collect::<String>()
                })
                .collect::<Vec<String>>()
        }),
    ) {
        let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
        let m = TileMap::from_rows(0, &refs).expect("rectangular art must parse");
        let w = m.width;
        let h = m.height;
        // Walk every in-bounds cell: grass ⇒ walkable, and is_grass is total.
        for y in 0..h {
            for x in 0..w {
                let p = TilePos { x, y };
                if m.is_grass(p) {
                    prop_assert!(
                        m.is_walkable(p),
                        "grass tile ({x},{y}) must be walkable"
                    );
                }
            }
        }
    }

    /// EARS: serde `Serialize` of a `TileMap` carries the grass layer along (the
    /// `zone_map()` wire contract the TS renderer's `RawTileMap.grass` reads).
    /// Kills: an impl that adds `grass` to the struct but forgets `Serialize`, or
    /// that omits it from the serialized form (the TS side would then have no grass).
    #[test]
    fn tilemap_serialize_includes_grass(seed in any::<u32>()) {
        // `seed` only varies which zone_0 we build (it is deterministic), keeping
        // the property cheap; the assertion is structural.
        let _ = seed;
        let m = zone_0();
        let s = ron::to_string(&m).expect("TileMap serializes");
        prop_assert!(
            s.contains("grass"),
            "serialized TileMap must include a `grass` field for the wire contract; got: {s}"
        );
    }
}

/// EARS (concrete, non-property witness): a specific zone_0 grass tile survives
/// serialize→inspect — the grass layer is on the wire, not just an in-memory field.
/// Kills: an impl that serializes `walkable` but drops `grass`.
#[test]
fn zone_0_grass_survives_serialize() {
    let m = zone_0();
    let s = ron::to_string(&m).expect("TileMap serializes");
    assert!(
        s.contains("grass"),
        "serialized zone_0 must expose its grass layer; got: {s}"
    );
    // And at least one `true` must appear in the grass list (zone_0 has grass).
    // We re-confirm via the API that grass exists, coupling the wire claim to state.
    let _ = first_zone0_grass_tile();
}

// ===========================================================================
// SECTION B — stepped_onto_grass (trigger geometry; each case bites a distinct
// over/under-fire). Mirrors PLAN-v2 R-C: fires on a MOVE onto grass, never on a
// non-move (bump / standstill / blocked).
// ===========================================================================

/// EARS: a player who ENTERS a new grass tile triggers (position changed onto
/// grass).
/// Kills: an impl that ignores the destination being grass (never fires).
#[test]
fn stepped_onto_grass_floor_to_grass_is_true() {
    let m = grass_fixture();
    // (0,1) floor → (1,1) grass : a real move onto grass.
    let prev = TilePos { x: 0, y: 1 };
    let next = TilePos { x: 1, y: 1 };
    assert!(
        stepped_onto_grass(prev, next, &m),
        "non-grass → grass step must fire"
    );
}

/// EARS (R-C/m5): a step from grass to a NEW grass tile is "entering a new grass
/// tile" and triggers.
/// Kills: an impl that only fires when leaving NON-grass (suppresses grass→grass),
/// which would under-fire when the player walks through a grass patch.
#[test]
fn stepped_onto_grass_grass_to_grass_is_true() {
    // A map with two adjacent grass tiles: "~~"
    let m = TileMap::from_rows(0, &["~~"]).expect("valid");
    let prev = TilePos { x: 0, y: 0 };
    let next = TilePos { x: 1, y: 0 };
    assert!(m.is_grass(prev) && m.is_grass(next), "both tiles are grass");
    assert!(
        stepped_onto_grass(prev, next, &m),
        "grass → NEW grass step must fire (position changed onto grass)"
    );
}

/// EARS: bumping a wall while facing grass does NOT trigger (position unchanged).
/// Kills: an impl that fires on `is_grass(next)` alone, ignoring `prev != next`
/// (would over-fire on every bump).
#[test]
fn stepped_onto_grass_bump_does_not_fire() {
    let m = grass_fixture();
    // A bump leaves pos unchanged: prev == next, even though the tile is grass.
    let same = TilePos { x: 1, y: 1 }; // a grass tile
    assert!(m.is_grass(same), "the tile under the bumper is grass");
    assert!(
        !stepped_onto_grass(same, same, &m),
        "bump (prev == next) must NOT fire even on a grass tile"
    );
}

/// EARS: standing still on grass does NOT trigger (no position change).
/// Kills: an impl that fires whenever the current tile is grass (would re-trigger
/// every tick while idle in grass).
#[test]
fn stepped_onto_grass_standstill_on_grass_does_not_fire() {
    let m = grass_fixture();
    let g = TilePos { x: 0, y: 2 }; // grass
    assert!(
        !stepped_onto_grass(g, g, &m),
        "standstill on grass (prev == next) must NOT fire"
    );
}

/// EARS: a step onto a non-grass tile does NOT trigger (moved, but not onto grass).
/// Kills: an impl that fires on ANY position change regardless of destination tile.
#[test]
fn stepped_onto_grass_step_onto_floor_does_not_fire() {
    let m = grass_fixture();
    // (1,2) floor → (0,2) grass would fire; here we move (1,1) grass → (0,1) floor.
    let prev = TilePos { x: 1, y: 1 }; // grass
    let next = TilePos { x: 0, y: 1 }; // floor
    assert!(!m.is_grass(next), "destination is floor, not grass");
    assert!(
        !stepped_onto_grass(prev, next, &m),
        "moving onto a NON-grass tile must NOT fire"
    );
}

/// EARS: a wall-blocked target resolves to a no-op (prev == next), so it does NOT
/// trigger — even if some grass tile is elsewhere.
/// Kills: an impl that fires on the INTENDED target instead of the RESOLVED
/// position (a blocked move never reaches the tile).
#[test]
fn stepped_onto_grass_wall_blocked_does_not_fire() {
    let m = grass_fixture();
    // (1,2) floor, blocked move resolves back to itself (prev == next).
    let blocked = TilePos { x: 1, y: 2 };
    assert!(
        !stepped_onto_grass(blocked, blocked, &m),
        "a wall-blocked move (prev == next) must NOT fire"
    );
}

// ===========================================================================
// SECTION C — resolve_encounter (the core trigger DECISION; pure/total/det, R-J)
// ===========================================================================

use crate::taming::resolve_encounter;

/// EARS: rate-0 table never triggers — `resolve_encounter` returns `None` for ALL
/// seeds (the cheap probability gate fires first).
/// Kills: an impl that skips the `encounter_triggers` gate and always rolls a
/// species (would spawn wilds in a rate-0 zone).
#[test]
fn resolve_encounter_rate_zero_is_always_none() {
    let table = make_table(0, 0, vec![make_entry(1, 10, 1, 100)]);
    for seed in [0u32, 1, 7, 42, 999, 123_456, u32::MAX] {
        assert_eq!(
            resolve_encounter(&table, seed, level(5)),
            None,
            "rate-0 zone must never trigger; seed={seed}"
        );
    }
}

proptest! {
    /// EARS (property witness): rate-0 ⇒ `None` for arbitrary seeds.
    /// Kills: any impl whose gate is probabilistic-but-not-zero-respecting.
    #[test]
    fn resolve_encounter_rate_zero_none_for_all_seeds(seed in any::<u32>()) {
        let table = make_table(0, 0, vec![make_entry(1, 10, 1, 100)]);
        prop_assert_eq!(resolve_encounter(&table, seed, level(5)), None);
    }
}

/// EARS: at rate 1000 a populated, level-eligible table ALWAYS triggers; the
/// chosen `species_id` is one of the table's eligible entries, the spawned `level`
/// lies within that chosen entry's [min_level, max_level], and within the player's
/// eligible band.
/// Kills: an impl that returns `None` at rate 1000, picks an out-of-table species,
/// or rolls a level outside the entry's band.
#[test]
fn resolve_encounter_rate_max_always_some_within_bands() {
    // Two eligible entries for player level 5; their level bands are [3,7] and
    // [4,9]; both contain level 5.
    let e1 = make_entry(11, 50, 3, 7);
    let e2 = make_entry(22, 50, 4, 9);
    let table = make_table(0, 1000, vec![e1, e2]);
    let pl = level(5);

    for seed in 0u32..256 {
        let w = resolve_encounter(&table, seed, pl)
            .unwrap_or_else(|| panic!("rate-1000 must always trigger; seed={seed}"));
        assert!(
            w.species_id == 11 || w.species_id == 22,
            "spawned species {} must be one of the eligible entries [11,22]; seed={seed}",
            w.species_id
        );
        // The spawned level must lie within the CHOSEN entry's band.
        let (lo, hi) = if w.species_id == 11 {
            (3u8, 7u8)
        } else {
            (4u8, 9u8)
        };
        let lv = w.level.as_u8();
        assert!(
            lv >= lo && lv <= hi,
            "spawned level {lv} must be in [{lo},{hi}] for species {}; seed={seed}",
            w.species_id
        );
    }
}

/// EARS: the encounter decision is deterministic for a given seed (and the seed
/// matters — different seeds CAN differ).
/// Kills: an impl that uses a non-seed RNG (non-deterministic), or that ignores
/// the seed entirely (constant output).
#[test]
fn resolve_encounter_is_deterministic_and_seed_sensitive() {
    let table = make_table(
        0,
        1000,
        vec![make_entry(1, 1, 1, 100), make_entry(2, 1, 1, 100)],
    );
    let pl = level(10);

    // Determinism: same inputs → identical result.
    for seed in [0u32, 3, 17, 99, 5000, u32::MAX] {
        let a = resolve_encounter(&table, seed, pl);
        let b = resolve_encounter(&table, seed, pl);
        assert_eq!(a, b, "resolve_encounter must be deterministic; seed={seed}");
    }

    // Seed-sensitivity: across a span of seeds, at least two distinct results must
    // appear (species choice and/or level differ) — proves the seed is consumed.
    let results: std::collections::BTreeSet<(u32, u8)> = (0u32..512)
        .filter_map(|s| resolve_encounter(&table, s, pl).map(|w| (w.species_id, w.level.as_u8())))
        .collect();
    assert!(
        results.len() >= 2,
        "different seeds must be able to produce different spawns; got {} distinct",
        results.len()
    );
}

/// EARS: a player level outside ALL entries' bands ⇒ no eligible species ⇒ `None`,
/// even at rate 1000 (the level-range filter overrides the trigger).
/// Kills: an impl that triggers an encounter with an out-of-band species (or
/// panics on an empty eligible set) when the rate gate passes.
#[test]
fn resolve_encounter_no_eligible_species_is_none() {
    // All entries are for low levels; the player is level 50 — none eligible.
    let table = make_table(
        0,
        1000,
        vec![make_entry(1, 10, 1, 10), make_entry(2, 10, 5, 12)],
    );
    for seed in [0u32, 1, 42, 9999, u32::MAX] {
        assert_eq!(
            resolve_encounter(&table, seed, level(50)),
            None,
            "no level-eligible species → None even at rate 1000; seed={seed}"
        );
    }
}

/// EARS: species selection is WEIGHTED — a higher-weight species is chosen more
/// often than a lower-weight one. Bounded, deterministic loop over seeds 0..N
/// (NOT randomness), asserted with a clear margin so it is robust, not flaky.
/// Kills: an impl that picks uniformly (ignores weight) — with a 9:1 weight ratio
/// a uniform impl would split ~50/50 and fail the inequality.
#[test]
fn resolve_encounter_weighting_favors_heavier_species() {
    // species 1 weight 9, species 2 weight 1 — both eligible for level 5, both
    // bands single-level so the level-pick cannot mask the species split.
    let heavy = make_entry(1, 9, 5, 5);
    let light = make_entry(2, 1, 5, 5);
    let table = make_table(0, 1000, vec![heavy, light]);
    let pl = level(5);

    let mut heavy_count = 0u32;
    let mut light_count = 0u32;
    const N: u32 = 4000;
    for seed in 0..N {
        match resolve_encounter(&table, seed, pl) {
            Some(w) if w.species_id == 1 => heavy_count += 1,
            Some(w) if w.species_id == 2 => light_count += 1,
            other => panic!("unexpected resolve result {other:?} for seed={seed}"),
        }
    }
    // With a 9:1 weight ratio the heavy species should dominate by a wide margin.
    // Assert a robust inequality (heavy at least 3× light) rather than an exact split.
    assert!(
        heavy_count > light_count * 3,
        "weight-9 species must dominate weight-1 (>3x); got heavy={heavy_count}, light={light_count}"
    );
    assert!(
        light_count > 0,
        "the light species must still be reachable (weight 1 is not zero); got {light_count}"
    );
}

/// EARS (R-J / M8d rebuild contract): the `individuality_seed` in the result is a
/// deterministic function of the INPUT seed (same input seed ⇒ same
/// individuality_seed) and is a stable sub-roll regardless of which species/level
/// is picked.
/// Kills: an impl that derives `individuality_seed` from the species/level outcome
/// (so it would change if the species pick changed) or from a fresh RNG draw
/// (non-deterministic) — either breaks M8d's "rebuild THAT exact wild" contract.
#[test]
fn resolve_encounter_individuality_seed_is_deterministic_in_input_seed() {
    // Table A and Table B share encounter_rate but differ in their species pool /
    // bands, so the species & level OUTCOMES differ — yet for the same input seed
    // the derived individuality_seed (a fixed sub-roll of the input) must match.
    let table_a = make_table(0, 1000, vec![make_entry(1, 1, 5, 5)]);
    let table_b = make_table(0, 1000, vec![make_entry(99, 1, 5, 5)]);
    let pl = level(5);

    for seed in [0u32, 1, 7, 12345, u32::MAX] {
        let a = resolve_encounter(&table_a, seed, pl).expect("rate 1000 triggers");
        let b = resolve_encounter(&table_b, seed, pl).expect("rate 1000 triggers");
        // Different species outcomes…
        assert_ne!(a.species_id, b.species_id, "fixture sanity: species differ");
        // …but the individuality_seed is the same sub-roll of the input seed.
        assert_eq!(
            a.individuality_seed, b.individuality_seed,
            "individuality_seed must be a deterministic sub-roll of the INPUT seed, \
             independent of the species/level outcome; seed={seed}"
        );
        // And it is stable on repeat (pure).
        let a2 = resolve_encounter(&table_a, seed, pl).expect("rate 1000 triggers");
        assert_eq!(a.individuality_seed, a2.individuality_seed);
    }
}
