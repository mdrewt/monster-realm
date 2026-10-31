//! bt-4 gating tests — BT4.7 (`tactics::encounter`). Written by the tester from the EARS criteria.
//!
//! Every expected value is hand-derived from the plan's contract ("Contracts → encounter.rs",
//! J7/J8): the pack roll is `r = encounter_seed % 1000` against the cumulative per-mille
//! thresholds (`r < one` → 1, `r < one + two` → 2, else 3); the clamp is
//! `min(rolled, 3, conscious)`; wild `i`'s seed is the low 32 bits of
//! `splitmix64(encounter_seed ^ i)`; the map is `encounter_seed % pool_len` in u64.
//!
//! Known splitmix64 outputs (pinned by `resolve_tests.rs`'s
//! `splitmix64_is_the_canonical_splitmix_output_bt2_5`): `splitmix64(0)` =
//! 0xE220_A839_7B1D_CDAF, `splitmix64(1)` = 0x910A_2DEC_8902_5CC1, `splitmix64(6)` =
//! 0xBD64_A5D9_ADEF_E000. Where a seed's output is not known by hand, the oracle is the canonical
//! `crate::tick_seed(x, 0, 0)` (`rt::mix`), never the module under test.
//!
//! Residues used: 2^32 = 4 294 967 296, so (2^32) % 1000 = 296, (2^32 + 304) % 1000 = 600,
//! (2^32 + 604) % 1000 = 900, (2^32 + 5) % 1000 = 301; 2^32 ≡ 1 (mod 3) so (2^32 + 5) % 3 = 0 and
//! (2^32 + 604) % 3 = 2 (604 ≡ 1); u64::MAX = 18 446 744 073 709 551 615 ends in 615, and
//! 2^64 ≡ 2 (mod 7) so u64::MAX % 7 = 1; 2^53 − 1 = 9 007 199 254 740 991 ends in 991.
//!
//! Test names end in the criterion tag `_bt4_7`.

use super::encounter::{
    effective_pack, generate_encounter, pick_map_index, roll_pack_size, spawn_tiles, wild_seed,
    Encounter, EncounterError, PackWeights, MAX_PACK,
};
use super::geometry::Cell;
use super::map::{validate_battle_map, BattleMapDef, TileDef};
use super::movement::Terrain;
use super::resolve_tests as rt;

const TWO_POW_32: u64 = 1 << 32;

fn weights(one: u16, two: u16, three: u16) -> PackWeights {
    PackWeights { one, two, three }
}

/// The oracle: the low 32 bits of the canonical splitmix64 output for state `x`.
fn low32(x: u64) -> u32 {
    u32::try_from(rt::mix(x) & 0xFFFF_FFFF).expect("masked to 32 bits")
}

/// A 7×7 all-Plain map with `spawn_b` as given (not validated — `spawn_tiles` reads the slots).
fn map_with_spawn_b(spawn_b: Vec<Cell>) -> BattleMapDef {
    BattleMapDef {
        spawn_b,
        ..rt::open_map()
    }
}

/// A valid 8×8 all-Plain map: spawns (1, 1/3/5) and (6, 1/3/5) — opposing pairs 5..=9 apart.
fn map8() -> BattleMapDef {
    BattleMapDef {
        width: 8,
        height: 8,
        tiles: vec![
            TileDef {
                terrain: Terrain::Plain,
                elevation: 0,
                blocks_los: false,
            };
            64
        ],
        spawn_a: vec![rt::c(1, 1), rt::c(1, 3), rt::c(1, 5)],
        spawn_b: vec![rt::c(6, 1), rt::c(6, 3), rt::c(6, 5)],
    }
}

// ===========================================================================
// The pack roll
// ===========================================================================

/// BT4.7: the default weights (600 / 300 / 100 ‰) against `r = seed % 1000`: r 0 and 599 → 1;
/// 600 and 899 → 2; 900 and 999 → 3; the same residues one or more thousands up (1 000 → 1,
/// 1 599 → 1, 1 600 → 2, 2 899 → 2, 3 900 → 3); seeds past 2^32 keep their FULL residue (2^32
/// → 296 → 1, 2^32 + 304 → 600 → 2, 2^32 + 604 → 900 → 3; a u32-truncating roll reads 304 → 1);
/// 2^53 − 1 → 991 → 3; u64::MAX → 615 → 2.
/// Kills: non-cumulative thresholds (600 → 3); `<=` (600 → 1); a truncated seed; `% 100`.
#[test]
fn the_pack_roll_is_seed_mod_1000_against_the_cumulative_default_thresholds_bt4_7() {
    let w = PackWeights::DEFAULT;
    assert_eq!(w, weights(600, 300, 100), "the design split");
    for (seed, want) in [
        (0_u64, 1_u8),
        (599, 1),
        (600, 2),
        (899, 2),
        (900, 3),
        (999, 3),
        (1_000, 1),
        (1_599, 1),
        (1_600, 2),
        (2_899, 2),
        (3_900, 3),
        (TWO_POW_32, 1),
        (TWO_POW_32 + 304, 2),
        (TWO_POW_32 + 604, 3),
        ((1 << 53) - 1, 3),
        (u64::MAX, 2),
    ] {
        assert_eq!(roll_pack_size(&w, seed), Ok(want), "seed {seed}");
    }
}

/// BT4.7: zero-weight buckets are never rolled: {0, 0, 1000} → always 3, {1000, 0, 0} → always
/// 1, {0, 1000, 0} → always 2 (r 0, 500, 999); and a custom split {100, 800, 100}: r 99 → 1,
/// 100 → 2, 899 → 2, 900 → 3; {0, 500, 500}: r 0 → 2, 499 → 2, 500 → 3.
/// Kills: thresholds hard-coded to the default; `r <= 0` reaching an empty bucket.
#[test]
fn the_pack_roll_honours_custom_and_zero_weight_buckets_bt4_7() {
    for seed in [0_u64, 500, 999, 7_777] {
        assert_eq!(
            roll_pack_size(&weights(0, 0, 1000), seed),
            Ok(3),
            "{{0,0,1000}} seed {seed}"
        );
        assert_eq!(
            roll_pack_size(&weights(1000, 0, 0), seed),
            Ok(1),
            "{{1000,0,0}} seed {seed}"
        );
        assert_eq!(
            roll_pack_size(&weights(0, 1000, 0), seed),
            Ok(2),
            "{{0,1000,0}} seed {seed}"
        );
    }
    let custom = weights(100, 800, 100);
    for (seed, want) in [(99_u64, 1_u8), (100, 2), (899, 2), (900, 3), (1_099, 1)] {
        assert_eq!(
            roll_pack_size(&custom, seed),
            Ok(want),
            "{{100,800,100}} seed {seed}"
        );
    }
    let halves = weights(0, 500, 500);
    for (seed, want) in [(0_u64, 2_u8), (499, 2), (500, 3), (999, 3)] {
        assert_eq!(
            roll_pack_size(&halves, seed),
            Ok(want),
            "{{0,500,500}} seed {seed}"
        );
    }
}

/// BT4.7: weights must sum to exactly 1000, summed in u32: the default and {1000, 0, 0} pass;
/// {600, 300, 99} is 999 and {600, 300, 101} is 1001; {40000, 26536, 0} is 66 536 (a u16 sum
/// wraps to exactly 1000 and would pass); {65535, 65535, 65535} is 196 605; {0, 0, 0} is 0. The
/// roll refuses the same weights with the same error (validate first).
/// Kills: a u16 sum; `>= 1000` / `<= 1000`; a roll that never validates.
#[test]
fn pack_weights_must_sum_to_exactly_1000_in_u32_bt4_7() {
    assert_eq!(PackWeights::DEFAULT.validate(), Ok(()));
    assert_eq!(weights(1000, 0, 0).validate(), Ok(()));
    for (w, sum) in [
        (weights(600, 300, 99), 999_u32),
        (weights(600, 300, 101), 1001),
        (weights(40_000, 26_536, 0), 66_536),
        (weights(65_535, 65_535, 65_535), 196_605),
        (weights(0, 0, 0), 0),
    ] {
        assert_eq!(
            w.validate(),
            Err(EncounterError::BadWeights { sum }),
            "{w:?}"
        );
        assert_eq!(
            roll_pack_size(&w, 0),
            Err(EncounterError::BadWeights { sum }),
            "{w:?}"
        );
    }
}

/// BT4.7: `PackWeights` is the serde shape the content `pack_weights` loads through, and its
/// deserialization is STRICT — exercised through the product's own derive in both formats the
/// crate reads (JSON via `serde_json`, RON via `ron`, the content format):
/// - JSON `{"one":600,"two":300,"three":100}` is `DEFAULT`, and `DEFAULT` serializes to exactly
///   that text; RON `(one: 600, two: 300, three: 100)` is `DEFAULT` and `DEFAULT` round-trips;
/// - an unknown key (`"four": 0`) is an error naming it, in both formats;
/// - a missing field (`three`) is an error naming it, in both formats — `{one: 600, two: 400}`
///   would otherwise default to a sum of exactly 1000 and pass `validate`.
///
/// Kills: `deny_unknown_fields` dropped (a misspelt bucket silently ignored); a `serde(default)`
/// (a missing bucket read as 0); a renamed field.
#[test]
fn pack_weights_deserialize_strictly_bt4_7() {
    let json = r#"{"one":600,"two":300,"three":100}"#;
    assert_eq!(
        serde_json::from_str::<PackWeights>(json).expect("the JSON shape parses"),
        PackWeights::DEFAULT
    );
    assert_eq!(
        serde_json::to_string(&PackWeights::DEFAULT).expect("DEFAULT serializes"),
        json
    );
    let unknown =
        serde_json::from_str::<PackWeights>(r#"{"one":600,"two":300,"three":100,"four":0}"#)
            .expect_err("an unknown JSON key is refused");
    assert!(unknown.to_string().contains("four"), "{unknown}");
    let missing = serde_json::from_str::<PackWeights>(r#"{"one":600,"two":400}"#)
        .expect_err("a missing JSON field is refused");
    assert!(missing.to_string().contains("three"), "{missing}");

    assert_eq!(
        ron::from_str::<PackWeights>("(one: 600, two: 300, three: 100)")
            .expect("the RON shape parses"),
        PackWeights::DEFAULT
    );
    let text = ron::to_string(&PackWeights::DEFAULT).expect("DEFAULT serializes to RON");
    assert_eq!(
        ron::from_str::<PackWeights>(&text).expect("DEFAULT round-trips through RON"),
        PackWeights::DEFAULT
    );
    let unknown = ron::from_str::<PackWeights>("(one: 600, two: 300, three: 100, four: 0)")
        .expect_err("an unknown RON field is refused");
    assert!(unknown.to_string().contains("four"), "{unknown}");
    let missing = ron::from_str::<PackWeights>("(one: 600, two: 400)")
        .expect_err("a missing RON field is refused");
    assert!(missing.to_string().contains("three"), "{missing}");
}

// ===========================================================================
// The clamp
// ===========================================================================

/// BT4.7 / J8: `effective = min(rolled, 3, conscious)`; conscious 0 is `NoConsciousParty` (checked
/// first, even for a rolled 0); then rolled 0 is `BadPackSize{0}`. The table rolled {0, 1, 2, 3,
/// 4, 255} × conscious {0, 1, 2, 3, 6}; `MAX_PACK` is the spec's 3.
/// Kills: a missing 3-cap (4 → 4); the conscious clamp dropped; the error order swapped; a 0-wild
/// encounter.
#[test]
fn the_pack_is_clamped_to_three_and_the_conscious_party_with_typed_errors_bt4_7() {
    assert_eq!(MAX_PACK, 3);
    for rolled in [0_u8, 1, 2, 3, 4, 255] {
        assert_eq!(
            effective_pack(rolled, 0),
            Err(EncounterError::NoConsciousParty),
            "rolled {rolled}, nobody conscious"
        );
    }
    for conscious in [1_u8, 2, 3, 6] {
        assert_eq!(
            effective_pack(0, conscious),
            Err(EncounterError::BadPackSize { rolled: 0 }),
            "rolled 0, {conscious} conscious"
        );
    }
    for (rolled, conscious, want) in [
        (1_u8, 1_u8, 1_u8),
        (1, 2, 1),
        (1, 3, 1),
        (1, 6, 1),
        (2, 1, 1),
        (2, 2, 2),
        (2, 3, 2),
        (2, 6, 2),
        (3, 1, 1),
        (3, 2, 2),
        (3, 3, 3),
        (3, 6, 3),
        (4, 1, 1),
        (4, 2, 2),
        (4, 3, 3),
        (4, 6, 3),
        (255, 1, 1),
        (255, 2, 2),
        (255, 3, 3),
        (255, 6, 3),
        (255, 255, 3),
    ] {
        assert_eq!(
            effective_pack(rolled, conscious),
            Ok(want),
            "rolled {rolled}, {conscious} conscious"
        );
    }
}

// ===========================================================================
// Per-wild seeds
// ===========================================================================

/// BT4.7: wild `i`'s seed is `splitmix64(encounter_seed ^ i) as u32` (the LOW 32 bits):
/// (0, 0) → splitmix64(0) → 0x7B1D_CDAF; (1, 0) and (0, 1) → splitmix64(1) → 0x8902_5CC1;
/// (7, 1) and (6, 0) → splitmix64(6) → 0xADEF_E000 (an additive `seed + i` reads splitmix64(8));
/// (7, 7) and (2, 2) → splitmix64(0) → 0x7B1D_CDAF. Two more XOR-not-add rows against the oracle:
/// (10, 2) → 10 ^ 2 = 8 (additive: 12) and (5, 9) → 12 (additive: 14).
/// Kills: the high 32 bits (0xE220_A839 for seed 0); `seed + i`; the raw seed; a per-encounter
/// (not per-wild) seed.
#[test]
fn a_wild_seed_is_the_low_half_of_splitmix64_of_seed_xor_index_bt4_7() {
    for (seed, index, want) in [
        (0_u64, 0_u8, 0x7B1D_CDAF_u32),
        (1, 0, 0x8902_5CC1),
        (0, 1, 0x8902_5CC1),
        (7, 1, 0xADEF_E000),
        (6, 0, 0xADEF_E000),
        (7, 7, 0x7B1D_CDAF),
        (2, 2, 0x7B1D_CDAF),
    ] {
        assert_eq!(wild_seed(seed, index), want, "wild_seed({seed}, {index})");
    }
    assert_eq!(wild_seed(10, 2), low32(8), "wild_seed(10, 2)");
    assert_eq!(wild_seed(5, 9), low32(12), "wild_seed(5, 9)");
}

/// BT4.7: every wild of an encounter gets its own seed — indices 0, 1, 2 (and 255) of several
/// encounter seeds (0, 1, 0xDEAD_BEEF, 2^40 + 7, 2^53 − 1, u64::MAX) match the oracle
/// `low32(splitmix64(seed ^ i))` and the three pack seeds are pairwise distinct.
/// Kills: one seed reused for the whole pack; the index ignored past 0.
#[test]
fn each_wild_index_gets_its_own_seed_bt4_7() {
    for seed in [
        0_u64,
        1,
        0xDEAD_BEEF,
        (1 << 40) + 7,
        (1 << 53) - 1,
        u64::MAX,
    ] {
        let pack: Vec<u32> = (0..3_u8).map(|i| wild_seed(seed, i)).collect();
        let want: Vec<u32> = (0..3_u64).map(|i| low32(seed ^ i)).collect();
        assert_eq!(pack, want, "seed {seed:#x}");
        assert!(
            pack[0] != pack[1] && pack[0] != pack[2] && pack[1] != pack[2],
            "seed {seed:#x}: {pack:?}"
        );
        assert_eq!(
            wild_seed(seed, 255),
            low32(seed ^ 255),
            "seed {seed:#x}, index 255"
        );
    }
}

// ===========================================================================
// The map pick
// ===========================================================================

/// BT4.7 / J7: the map is `encounter_seed % pool_len`, computed in u64 and narrowed after: a pool
/// of 1 is always 0; (3, 0) → 0; (3, 7) → 1; (3, 2^32 + 5) → 0 (a seed truncated to 32 bits — the
/// wasm32 `as usize` — reads 5 % 3 = 2); (1000, 2^32 + 5) → 301 (truncated: 5); (1000, 999) → 999;
/// (1000, 1000) → 0; (7, u64::MAX) → 1 (truncated: (2^32 − 1) % 7 = 3).
/// Kills: a u32/usize-truncated seed; `% (len − 1)`; an off-by-one wrap.
#[test]
fn the_map_pick_is_seed_mod_pool_len_in_u64_bt4_7() {
    for seed in [0_u64, 1, 999, TWO_POW_32 + 5, u64::MAX] {
        assert_eq!(pick_map_index(1, seed), Ok(0), "pool 1, seed {seed}");
    }
    for (len, seed, want) in [
        (3_usize, 0_u64, 0_usize),
        (3, 7, 1),
        (3, TWO_POW_32 + 5, 0),
        (1000, TWO_POW_32 + 5, 301),
        (1000, 999, 999),
        (1000, 1000, 0),
        (7, u64::MAX, 1),
    ] {
        assert_eq!(
            pick_map_index(len, seed),
            Ok(want),
            "pool {len}, seed {seed}"
        );
    }
}

/// BT4.7: an empty map pool is an error for every seed, never a panic or a 0.
/// Kills: `seed % 0` (a divide-by-zero panic); a defaulted index 0.
#[test]
fn an_empty_map_pool_is_an_error_bt4_7() {
    for seed in [0_u64, 5, TWO_POW_32 + 5, u64::MAX] {
        assert_eq!(
            pick_map_index(0, seed),
            Err(EncounterError::EmptyMapPool),
            "seed {seed}"
        );
    }
}

// ===========================================================================
// Placement
// ===========================================================================

/// BT4.7: wilds take `spawn_b[..pack]` in slot order: on the open map (spawn_b (6,0), (6,2),
/// (6,4)) a pack of 1 / 2 / 3 is the first 1 / 2 / 3 slots and 0 is none; an UNSORTED spawn_b
/// ((5,5), (5,1), (5,3)) keeps its order; a pack larger than the slots is
/// `SpawnSlots{got, want}` (3 slots, pack 4 or 255; 2 slots, pack 3).
/// Kills: sorted / reversed slots; a pack silently truncated to the slots available.
#[test]
fn wilds_take_the_first_pack_spawn_b_slots_in_order_bt4_7() {
    let open = rt::open_map();
    let slots = [rt::c(6, 0), rt::c(6, 2), rt::c(6, 4)];
    assert_eq!(spawn_tiles(&open, 0), Ok(Vec::new()));
    assert_eq!(spawn_tiles(&open, 1), Ok(slots[..1].to_vec()));
    assert_eq!(spawn_tiles(&open, 2), Ok(slots[..2].to_vec()));
    assert_eq!(spawn_tiles(&open, 3), Ok(slots.to_vec()));
    let unsorted = map_with_spawn_b(vec![rt::c(5, 5), rt::c(5, 1), rt::c(5, 3)]);
    assert_eq!(
        spawn_tiles(&unsorted, 3),
        Ok(vec![rt::c(5, 5), rt::c(5, 1), rt::c(5, 3)])
    );
    assert_eq!(
        spawn_tiles(&unsorted, 2),
        Ok(vec![rt::c(5, 5), rt::c(5, 1)])
    );
    for pack in [4_u8, 255] {
        assert_eq!(
            spawn_tiles(&open, pack),
            Err(EncounterError::SpawnSlots { got: 3, want: pack }),
            "pack {pack}"
        );
    }
    let two = map_with_spawn_b(vec![rt::c(6, 0), rt::c(6, 2)]);
    assert_eq!(
        spawn_tiles(&two, 3),
        Err(EncounterError::SpawnSlots { got: 2, want: 3 })
    );
    assert_eq!(spawn_tiles(&two, 2), Ok(vec![rt::c(6, 0), rt::c(6, 2)]));
}

/// BT4.7: every map `validate_battle_map` accepts (the 7×7 open map, a valid 8×8) seats the
/// largest pack: `spawn_tiles(map, MAX_PACK)` is all of its spawn_b, in order.
/// Kills: a MAX_PACK above the validated slot count; placement reading spawn_a.
#[test]
fn a_validated_map_seats_the_largest_pack_bt4_7() {
    for map in [rt::open_map(), map8()] {
        assert_eq!(validate_battle_map(&map), Ok(()));
        assert_eq!(spawn_tiles(&map, MAX_PACK), Ok(map.spawn_b.clone()));
    }
}

// ===========================================================================
// The whole generation
// ===========================================================================

/// BT4.7: `generate_encounter` composes map pick → pack roll → clamp → per-wild seeds:
/// - {0, 1000, 0}, pool 2, seed 0, 3 conscious: map 0 % 2 = 0; roll 2; pack min(2, 3, 3) = 2;
///   seeds [splitmix64(0), splitmix64(1)] low halves = [0x7B1D_CDAF, 0x8902_5CC1];
/// - default, pool 4, seed 6, 6 conscious: map 6 % 4 = 2; r 6 → 1; seeds [0xADEF_E000];
/// - default, pool 5, seed 0, 1 conscious: map 0; r 0 → 1; seeds [0x7B1D_CDAF];
/// - default, pool 10, seed 999, 2 conscious: map 9; r 999 → 3; clamped to 2; seeds
///   [low32(999), low32(999 ^ 1 = 998)];
/// - {0, 0, 1000}, pool 4, seed 1, 6 conscious: map 1; roll 3; pack 3; seeds [0x8902_5CC1,
///   0x7B1D_CDAF, low32(3)];
/// - default, pool 3, seed 2^32 + 604, 3 conscious: map (2^32 + 604) % 3 = 2; r 900 → 3; pack 3;
///   seeds low32 of seed ^ 0, ^ 1, ^ 2.
///
/// Kills: the pack not clamped before seeding; the map index from the roll residue; seeds per
/// encounter instead of per wild; `seeds.len()` other than the effective pack.
#[test]
fn generate_encounter_composes_the_map_pick_the_roll_the_clamp_and_the_seeds_bt4_7() {
    let big = TWO_POW_32 + 604;
    for (w, pool, seed, conscious, want) in [
        (
            weights(0, 1000, 0),
            2_usize,
            0_u64,
            3_u8,
            Encounter {
                map_index: 0,
                seeds: vec![0x7B1D_CDAF, 0x8902_5CC1],
            },
        ),
        (
            PackWeights::DEFAULT,
            4,
            6,
            6,
            Encounter {
                map_index: 2,
                seeds: vec![0xADEF_E000],
            },
        ),
        (
            PackWeights::DEFAULT,
            5,
            0,
            1,
            Encounter {
                map_index: 0,
                seeds: vec![0x7B1D_CDAF],
            },
        ),
        (
            PackWeights::DEFAULT,
            10,
            999,
            2,
            Encounter {
                map_index: 9,
                seeds: vec![low32(999), low32(998)],
            },
        ),
        (
            weights(0, 0, 1000),
            4,
            1,
            6,
            Encounter {
                map_index: 1,
                seeds: vec![0x8902_5CC1, 0x7B1D_CDAF, low32(3)],
            },
        ),
        (
            PackWeights::DEFAULT,
            3,
            big,
            3,
            Encounter {
                map_index: 2,
                seeds: vec![low32(big), low32(big ^ 1), low32(big ^ 2)],
            },
        ),
    ] {
        assert_eq!(
            generate_encounter(&w, pool, seed, conscious),
            Ok(want),
            "{w:?}, pool {pool}, seed {seed}, {conscious} conscious"
        );
    }
}

/// BT4.7: the first failure wins in `EncounterError` declaration order: bad weights + empty pool +
/// nobody conscious → `BadWeights{999}`; good weights + empty pool + nobody conscious →
/// `EmptyMapPool`; good weights + a pool + nobody conscious → `NoConsciousParty`.
/// Kills: any other check order; a 0-wild encounter for an empty party.
#[test]
fn generate_encounter_reports_the_first_failure_in_declaration_order_bt4_7() {
    assert_eq!(
        generate_encounter(&weights(600, 300, 99), 0, 0, 0),
        Err(EncounterError::BadWeights { sum: 999 })
    );
    assert_eq!(
        generate_encounter(&PackWeights::DEFAULT, 0, 0, 0),
        Err(EncounterError::EmptyMapPool)
    );
    assert_eq!(
        generate_encounter(&PackWeights::DEFAULT, 3, 0, 0),
        Err(EncounterError::NoConsciousParty)
    );
    assert_eq!(
        generate_encounter(&weights(0, 0, 1000), 1, 0, 0),
        Err(EncounterError::NoConsciousParty)
    );
}
