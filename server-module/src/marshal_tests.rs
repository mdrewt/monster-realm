//! `marshal` domain-submodule tests (M8.9c — test relocation, ADR-0056).
//!
//! Extracted verbatim from the former inline `#[cfg(test)] mod tests` in
//! `marshal.rs`; every assertion, fixture, and helper is unchanged. Declared
//! from `marshal.rs` as `#[path = "marshal_tests.rs"] mod marshal_tests;`, so
//! `super` still resolves to `marshal` exactly as the inline module did.

use super::*;
use crate::PARTY_SLOT_NONE;
use game_core::{roll_starter, ActionState, Affinity, Direction};

fn row() -> Character {
    Character {
        entity_id: 1,
        zone_id: 0,
        tile_x: 3,
        tile_y: 4,
        facing: Direction::East,
        action: ActionState::Walking,
        move_started_at_ms: 123,
        sprite_id: 0,
        move_queue: Vec::new(),
    }
}

#[test]
fn convert_seam_round_trips() {
    let r = row();
    let s = char_state(&r);
    assert_eq!(s.pos, TilePos { x: 3, y: 4 });
    assert_eq!(s.facing, Direction::East);
    assert_eq!(s.move_started_at, Millis(123));
    let mut r2 = row();
    let next = CharacterState {
        pos: TilePos { x: 9, y: 9 },
        facing: Direction::North,
        action: ActionState::Idle,
        move_started_at: Millis(500),
    };
    apply_state(&mut r2, &next);
    assert_eq!((r2.tile_x, r2.tile_y), (9, 9));
    assert_eq!(r2.facing, Direction::North);
    assert_eq!(r2.move_started_at_ms, 500);
}

// === M6b tests ===

fn test_species() -> game_core::Species {
    game_core::Species {
        id: 1,
        name: "Flameling".to_string(),
        base_stats: StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        },
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1, 2],
    }
}

/// monster_from_instance flattens a MonsterInstance into the correct columns.
#[test]
fn monster_from_instance_flattens_correctly() {
    let sp = test_species();
    let inst = roll_starter(42, &sp);
    let identity = Identity::from_byte_array([0u8; 32]);
    let m = monster_from_instance(identity, &inst, 0);

    assert_eq!(m.species_id, inst.species_id);
    assert_eq!(m.level, inst.level.as_u8());
    assert_eq!(m.xp, inst.xp.value());
    assert_eq!(m.bond, inst.bond.value());
    assert_eq!(m.iv_hp, inst.ivs.get(StatKind::Hp));
    assert_eq!(m.iv_attack, inst.ivs.get(StatKind::Attack));
    assert_eq!(m.iv_defense, inst.ivs.get(StatKind::Defense));
    assert_eq!(m.iv_speed, inst.ivs.get(StatKind::Speed));
    assert_eq!(m.iv_sp_attack, inst.ivs.get(StatKind::SpAttack));
    assert_eq!(m.iv_sp_defense, inst.ivs.get(StatKind::SpDefense));
    assert_eq!(m.nature_kind, inst.nature.kind());
    assert_eq!(m.ev_hp, inst.evs.get(StatKind::Hp));
    assert_eq!(m.stat_hp, inst.derived_stats.hp);
    assert_eq!(m.stat_attack, inst.derived_stats.attack);
    assert_eq!(m.current_hp, inst.current_hp);
    assert_eq!(m.party_slot, 0);
    assert_eq!(m.owner_identity, identity);
    // A fresh monster starts with the care cooldown elapsed (epoch anchor).
    assert_eq!(m.last_care_at_ms, 0);
}

/// pub_from_monster produces a projection with NO hidden fields.
#[test]
fn pub_from_monster_omits_hidden_fields() {
    let sp = test_species();
    let inst = roll_starter(42, &sp);
    let identity = Identity::from_byte_array([1u8; 32]);
    let m = monster_from_instance(identity, &inst, PARTY_SLOT_NONE);
    let p = pub_from_monster(&m);

    // Public fields match
    assert_eq!(p.monster_id, m.monster_id);
    assert_eq!(p.owner_identity, m.owner_identity);
    assert_eq!(p.species_id, m.species_id);
    assert_eq!(p.nickname, m.nickname);
    assert_eq!(p.level, m.level);
    assert_eq!(p.xp, m.xp);
    assert_eq!(p.bond, m.bond);
    assert_eq!(p.current_hp, m.current_hp);
    assert_eq!(p.stat_hp, m.stat_hp);
    assert_eq!(p.stat_attack, m.stat_attack);
    assert_eq!(p.stat_defense, m.stat_defense);
    assert_eq!(p.stat_speed, m.stat_speed);
    assert_eq!(p.stat_sp_attack, m.stat_sp_attack);
    assert_eq!(p.stat_sp_defense, m.stat_sp_defense);
    assert_eq!(p.party_slot, m.party_slot);
    // The MonsterPub struct has no IV/EV/nature fields — this is a compile-time
    // guarantee; the privacy eval enforces it at the source level.
}

// =========================================================================
// M7b gating tests — server-module helper seams
//
// These tests gate the three pure helper functions that the battle reducers
// will depend on. They are RED until the implementer adds these helpers to
// server-module/src/lib.rs.
//
// The helpers being gated:
//   1. battle_monster_from_row(monster, skills) -> BattleMonster
//      Marshaling seam: Monster table row + species skills -> BattleMonster.
//
//   2. write_back_hp(monster_row, battle_monster)
//      Writes HP from the battle-engine state back to the Monster row.
//
//   3. loser_base_stat_total(species_row) -> u16
//      Sums the six base stats from a SpeciesRow for the XP formula.
//
// None of these functions touch ReducerContext — they are pure transformers
// that can be tested without a SpacetimeDB runtime.
// =========================================================================

// -------------------------------------------------------------------------
// Fixture builders for M7b tests
// -------------------------------------------------------------------------

fn m7b_test_monster_row() -> Monster {
    Monster {
        monster_id: 42,
        owner_identity: Identity::from_byte_array([7u8; 32]),
        species_id: 1,
        nickname: "Sparky".to_string(),
        level: 15,
        xp: 0,
        bond: 0,
        iv_hp: 20,
        iv_attack: 25,
        iv_defense: 10,
        iv_speed: 30,
        iv_sp_attack: 15,
        iv_sp_defense: 5,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        // Derived stats (set explicitly for test predictability)
        stat_hp: 120,
        stat_attack: 55,
        stat_defense: 45,
        stat_speed: 70,
        stat_sp_attack: 50,
        stat_sp_defense: 40,
        current_hp: 90, // damaged — not at max
        party_slot: 0,
        last_care_at_ms: 0,
        evolves_to: None,
    }
}

fn m7b_test_skill_rows() -> Vec<SkillRow> {
    vec![
        SkillRow {
            id: 1,
            name: "Ember".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
        },
        SkillRow {
            id: 2,
            name: "Scratch".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 35,
        },
    ]
}

fn m7b_test_species_row() -> SpeciesRow {
    SpeciesRow {
        id: 1,
        name: "Flameling".to_string(),
        base_hp: 45,
        base_attack: 49,
        base_defense: 49,
        base_speed: 65,
        base_sp_attack: 65,
        base_sp_defense: 45,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1, 2],
    }
}

// -------------------------------------------------------------------------
// TEST M7b-SM-1: battle_monster_from_row marshaling seam
//
// Kills: an impl that swaps species_id and affinity, maps the wrong HP
// column (using stat_hp instead of current_hp or vice-versa), or copies
// known_skill_ids from learnable_skill_ids without filtering.
// -------------------------------------------------------------------------

/// The function `battle_monster_from_row` must exist in the server module
/// and produce a BattleMonster whose fields correctly reflect the Monster
/// table row and the provided skill list.
///
/// Kills: maps stat_hp → current_hp (wrong — battle starts with actual HP),
/// or maps current_hp → max_hp (wrong — max_hp must equal stat_hp).
#[test]
fn m7b_battle_monster_from_row_maps_hp_correctly() {
    let monster = m7b_test_monster_row();
    let species = m7b_test_species_row();
    let skills = m7b_test_skill_rows();

    let bm: game_core::BattleMonster =
        battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

    // current_hp in battle = Monster.current_hp (the persisted damage state)
    assert_eq!(
        bm.current_hp, monster.current_hp,
        "BattleMonster.current_hp must equal Monster.current_hp (90), not stat_hp (120)"
    );
    // max_hp in battle = Monster.stat_hp (the computed maximum)
    assert_eq!(
        bm.max_hp, monster.stat_hp,
        "BattleMonster.max_hp must equal Monster.stat_hp (120), not current_hp (90)"
    );
}

/// Kills: an impl that copies all learnable_skill_ids instead of only
/// the skill_ids present in the provided skills slice, or that maps the
/// wrong species_id / affinity / level.
#[test]
fn m7b_battle_monster_from_row_maps_identity_fields() {
    let monster = m7b_test_monster_row();
    let species = m7b_test_species_row();
    let skills = m7b_test_skill_rows();

    let bm: game_core::BattleMonster =
        battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

    assert_eq!(bm.species_id, monster.species_id, "species_id must match");
    assert_eq!(
        bm.affinity,
        Affinity::Fire,
        "affinity must come from species (Fire)"
    );
    assert_eq!(bm.level, monster.level, "level must match monster.level");
}

/// Kills: an impl that uses derived stats from the wrong columns (e.g.
/// reads iv_attack instead of stat_attack for the StatBlock).
#[test]
fn m7b_battle_monster_from_row_maps_derived_stats() {
    let monster = m7b_test_monster_row();
    let species = m7b_test_species_row();
    let skills = m7b_test_skill_rows();

    let bm: game_core::BattleMonster =
        battle_monster_from_row(&monster, &species, &skills).expect("valid row builds");

    // The StatBlock in BattleMonster must come from the derived stat columns,
    // not from raw IV/EV values or base stats.
    assert_eq!(bm.stats.hp, monster.stat_hp, "stats.hp must be stat_hp");
    assert_eq!(
        bm.stats.attack, monster.stat_attack,
        "stats.attack must be stat_attack"
    );
    assert_eq!(
        bm.stats.defense, monster.stat_defense,
        "stats.defense must be stat_defense"
    );
    assert_eq!(
        bm.stats.speed, monster.stat_speed,
        "stats.speed must be stat_speed"
    );
    assert_eq!(
        bm.stats.sp_attack, monster.stat_sp_attack,
        "stats.sp_attack must be stat_sp_attack"
    );
    assert_eq!(
        bm.stats.sp_defense, monster.stat_sp_defense,
        "stats.sp_defense must be stat_sp_defense"
    );
}

/// Kills: an impl that puts all learnable_skill_ids (from the species) into
/// known_skill_ids instead of only the IDs present in the provided skills slice.
/// The skill slice represents what the server has loaded for this monster;
/// known_skill_ids must reflect exactly those IDs.
#[test]
fn m7b_battle_monster_from_row_known_skill_ids_match_skills_slice() {
    let monster = m7b_test_monster_row();
    let species = m7b_test_species_row();
    // Only provide skill 1 (not skill 2) — simulates the monster only knowing one move.
    let one_skill = vec![m7b_test_skill_rows().remove(0)];

    let bm: game_core::BattleMonster =
        battle_monster_from_row(&monster, &species, &one_skill).expect("valid row builds");

    assert_eq!(
        bm.known_skill_ids,
        vec![1u32],
        "known_skill_ids must match the provided skills slice (only skill 1)"
    );
}

// -------------------------------------------------------------------------
// TEST M7b-SM-2: write_back_hp writes battle HP to the monster row
//
// Kills: an impl that writes max_hp instead of current_hp, writes to the
// wrong Monster field (e.g. stat_hp), or does not write at all.
// -------------------------------------------------------------------------

/// Kills: write_back_hp writes 0 (fainted) back as current_hp.
#[test]
fn m7b_write_back_hp_writes_fainted_state() {
    let mut monster = m7b_test_monster_row(); // current_hp = 90
                                              // Build a BattleMonster representing the fainted state after combat.
    let bm = game_core::BattleMonster {
        species_id: monster.species_id,
        affinity: Affinity::Fire,
        level: monster.level,
        current_hp: 0, // fainted in battle
        max_hp: monster.stat_hp,
        stats: game_core::StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: vec![1],
        status: None,
    };

    // write_back_hp does not exist yet — this test is RED.
    write_back_hp(&mut monster, &bm);

    assert_eq!(
        monster.current_hp, 0,
        "write_back_hp must set Monster.current_hp = 0 (fainted)"
    );
    // stat_hp must NOT be modified — it is derived, not a battle value.
    assert_eq!(monster.stat_hp, 120, "write_back_hp must not touch stat_hp");
}

/// Kills: write_back_hp that caps HP at max_hp (ignoring current_hp).
#[test]
fn m7b_write_back_hp_writes_partial_damage() {
    let mut monster = m7b_test_monster_row(); // current_hp = 90 initially
    let partial_hp: u16 = 37;
    let bm = game_core::BattleMonster {
        species_id: monster.species_id,
        affinity: Affinity::Fire,
        level: monster.level,
        current_hp: partial_hp,
        max_hp: monster.stat_hp,
        stats: game_core::StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: vec![1],
        status: None,
    };

    write_back_hp(&mut monster, &bm);

    assert_eq!(
        monster.current_hp, partial_hp,
        "write_back_hp must write current_hp = {partial_hp}, not cap or round"
    );
}

// -------------------------------------------------------------------------
// TEST M7b-SM-3: loser_base_stat_total sums the six base stats correctly
//
// Kills: an impl that sums derived stats (stat_hp etc.) instead of base
// stats, sums only five stats (off-by-one), or wraps on overflow.
// -------------------------------------------------------------------------

/// Kills: an impl that returns the sum of derived stats (monster row's
/// stat_hp etc.) instead of the six BASE stat columns from the species row.
/// 45 + 49 + 49 + 65 + 65 + 45 = 318 (Flameling base stat total).
#[test]
fn m7b_loser_base_stat_total_flameling() {
    let species = m7b_test_species_row();

    // The explicit `u16` binding pins the signature: a return-type
    // regression (or dropping the game_core::base_stat_total delegation
    // for a wider type) fails to compile here.
    let bst: u16 = loser_base_stat_total(&species);

    assert_eq!(
        bst, 318,
        "loser_base_stat_total must sum the six BASE stats: \
         45+49+49+65+65+45 = 318, got {bst}"
    );
}

/// Kills: an impl that only sums five stats (off-by-one on the stat fields).
#[test]
fn m7b_loser_base_stat_total_high_bst_species() {
    // A species with high base stats — verifies all six fields are summed.
    let species = SpeciesRow {
        id: 99,
        name: "Apexion".to_string(),
        base_hp: 100,
        base_attack: 120,
        base_defense: 90,
        base_speed: 100,
        base_sp_attack: 130,
        base_sp_defense: 90,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
    };
    // 100 + 120 + 90 + 100 + 130 + 90 = 630
    let bst: u16 = loser_base_stat_total(&species);
    assert_eq!(
        bst, 630,
        "loser_base_stat_total must sum all six base stats: \
         100+120+90+100+130+90 = 630, got {bst}"
    );
}

/// Kills: an impl that wraps on u16 overflow. All six base stats at 255 = 1530,
/// which fits in u16 (max 65535). But if the impl uses u8 intermediates, 255*6=1530
/// wraps to 250. This test catches that.
#[test]
fn m7b_loser_base_stat_total_max_stats_no_overflow() {
    let species = SpeciesRow {
        id: 0,
        name: "MaxStat".to_string(),
        base_hp: 255,
        base_attack: 255,
        base_defense: 255,
        base_speed: 255,
        base_sp_attack: 255,
        base_sp_defense: 255,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
    };
    // 255 * 6 = 1530, which fits in u16.
    let bst: u16 = loser_base_stat_total(&species);
    assert_eq!(
        bst, 1530,
        "loser_base_stat_total must not overflow u8; 255*6=1530, got {bst}"
    );
}

// =========================================================================
// M8.5b gating tests — battle_monster_from_row trust boundary (defense==0)
//
// These tests gate the signature change for `battle_monster_from_row`:
// it must become `-> Result<BattleMonster, String>` and reject rows
// where `monster.stat_defense == 0`.
//
// All tests in this block are compile-RED until the signature changes.
// =========================================================================

// -------------------------------------------------------------------------
// TEST M8.5b-A-3: battle_monster_from_row rejects zero defense
//
// Kills: an impl that passes defense==0 through to BattleMonster (which
// would later cause a divide-by-zero in calc_damage).
// -------------------------------------------------------------------------

/// Kills: an impl that silently returns Ok(..) for a zero-defense row instead
/// of Err. If battle_monster_from_row doesn't validate stat_defense, a
/// defense==0 BattleMonster reaches calc_damage and causes UB/panic there.
///
/// PROOF-OF-TEETH: the positive sibling below ensures the implementer can't
/// trivially make this pass by returning Err for ALL inputs.
///
/// RED state: compile-RED because `battle_monster_from_row` currently returns
/// `BattleMonster` (not `Result`), so `.is_err()` does not compile.
#[test]
fn battle_monster_from_row_rejects_zero_defense() {
    let mut monster = m7b_test_monster_row();
    monster.stat_defense = 0; // precondition violation: defense must be >= 1

    let species = m7b_test_species_row();
    let skills = m7b_test_skill_rows();

    let result: Result<game_core::BattleMonster, String> =
        battle_monster_from_row(&monster, &species, &skills);

    assert!(
        result.is_err(),
        "TEETH: battle_monster_from_row must reject stat_defense==0 with Err; \
         an impl that passes it through would return Ok(..) and this assertion fails"
    );
}

/// Sibling positive test: a normal row (defense > 0) must succeed.
///
/// Kills: a vacuous always-Err impl. Without this test, an implementer could
/// make the reject test pass by unconditionally returning Err("nope"), which
/// would break all callers. This test ensures the happy path still works.
///
/// RED state: compile-RED (same signature change required).
#[test]
fn battle_monster_from_row_accepts_nonzero_defense() {
    let monster = m7b_test_monster_row(); // stat_defense = 45 (non-zero)
    let species = m7b_test_species_row();
    let skills = m7b_test_skill_rows();

    let result: Result<game_core::BattleMonster, String> =
        battle_monster_from_row(&monster, &species, &skills);

    assert!(
        result.is_ok(),
        "battle_monster_from_row must return Ok(..) for a valid row with \
         stat_defense={} (> 0); got Err",
        monster.stat_defense
    );
    // Spot-check that the result still maps correctly (regression guard)
    let bm = result.unwrap();
    assert_eq!(bm.stats.defense, monster.stat_defense);
}

// =========================================================================
// M8b gating tests — encounter_rows_from_table marshaling seam
//
// These tests gate the pure function `encounter_rows_from_table` that the
// implementer will add to server-module/src/lib.rs. The function does NOT
// exist yet — this entire block is RED (crate won't compile until added).
//
// Mirror: monster_from_instance_flattens_correctly (lib.rs ~1359).
// Flatten-at-boundary: Level -> u8 (same pattern as Millis -> i64).
//
// Symbols referenced (not yet defined — intentionally RED):
//   encounter_rows_from_table(&game_core::EncounterTable) -> EncounterRow
//   struct EncounterRow { zone_id: u32, encounter_rate: u16, entries: Vec<EncounterEntryRow> }
//   struct EncounterEntryRow { species_id: u32, weight: u16, min_level: u8, max_level: u8 }
// =========================================================================

// -------------------------------------------------------------------------
// Fixture builder for M8b marshaling tests
// -------------------------------------------------------------------------

fn m8b_test_encounter_table() -> game_core::EncounterTable {
    game_core::EncounterTable {
        zone_id: 42,
        encounter_rate: 350,
        entries: vec![
            game_core::EncounterEntry {
                species_id: 1,
                weight: 60,
                min_level: game_core::Level::new(3).expect("valid level"),
                max_level: game_core::Level::new(7).expect("valid level"),
            },
            game_core::EncounterEntry {
                species_id: 2,
                weight: 30,
                min_level: game_core::Level::new(5).expect("valid level"),
                max_level: game_core::Level::new(10).expect("valid level"),
            },
            game_core::EncounterEntry {
                species_id: 3,
                weight: 10,
                min_level: game_core::Level::new(8).expect("valid level"),
                max_level: game_core::Level::new(15).expect("valid level"),
            },
        ],
    }
}

// -------------------------------------------------------------------------
// TEST M8b-SM-1: encounter_rows_from_table flattens correctly
//
// Kills: min/max swap; Level-not-flattened (storing a newtypes struct instead
// of u8); wrong zone_id or encounter_rate copied; entry count wrong.
// -------------------------------------------------------------------------

/// encounter_rows_from_table must flatten a game_core::EncounterTable into
/// an EncounterRow with the correct zone_id, encounter_rate, entry count,
/// and correct per-entry species_id/weight/min_level/max_level (as u8).
///
/// Kills: an impl that swaps min_level/max_level columns,
///        stores Level newtype instead of u8,
///        or copies the wrong zone_id.
#[test]
fn encounter_rows_from_table_flattens_correctly() {
    let table = m8b_test_encounter_table();

    // encounter_rows_from_table does not exist yet — this test is RED.
    let row: EncounterRow = encounter_rows_from_table(&table);

    // Top-level fields
    assert_eq!(row.zone_id, 42, "zone_id must be copied from table.zone_id");
    assert_eq!(
        row.encounter_rate, 350,
        "encounter_rate must be copied from table.encounter_rate"
    );
    assert_eq!(
        row.entries.len(),
        3,
        "entries.len() must equal source table entries count (3)"
    );

    // Entry 0: species=1, weight=60, min=3, max=7
    assert_eq!(
        row.entries[0].species_id, 1,
        "entries[0].species_id must be 1"
    );
    assert_eq!(row.entries[0].weight, 60, "entries[0].weight must be 60");
    assert_eq!(
        row.entries[0].min_level, 3,
        "entries[0].min_level must be 3 (Level flattened to u8)"
    );
    assert_eq!(
        row.entries[0].max_level, 7,
        "entries[0].max_level must be 7 (Level flattened to u8)"
    );

    // Entry 1: species=2, weight=30, min=5, max=10
    assert_eq!(
        row.entries[1].species_id, 2,
        "entries[1].species_id must be 2"
    );
    assert_eq!(row.entries[1].weight, 30, "entries[1].weight must be 30");
    assert_eq!(
        row.entries[1].min_level, 5,
        "entries[1].min_level must be 5"
    );
    assert_eq!(
        row.entries[1].max_level, 10,
        "entries[1].max_level must be 10"
    );

    // Entry 2: species=3, weight=10, min=8, max=15
    assert_eq!(
        row.entries[2].species_id, 3,
        "entries[2].species_id must be 3"
    );
    assert_eq!(row.entries[2].weight, 10, "entries[2].weight must be 10");
    assert_eq!(
        row.entries[2].min_level, 8,
        "entries[2].min_level must be 8"
    );
    assert_eq!(
        row.entries[2].max_level, 15,
        "entries[2].max_level must be 15"
    );
}

/// ORDER PRESERVATION: entry[i] in the source maps to entries[i] in the row.
/// Kills: an impl that reverses or re-sorts entries.
#[test]
fn encounter_rows_from_table_preserves_entry_order() {
    let table = m8b_test_encounter_table();
    let row: EncounterRow = encounter_rows_from_table(&table);

    // The species_ids in insertion order are [1, 2, 3] — verify the row
    // preserves this order exactly.
    let species_order: Vec<u32> = row.entries.iter().map(|e| e.species_id).collect();
    assert_eq!(
        species_order,
        vec![1u32, 2, 3],
        "entry order must be preserved: [1,2,3] → kills any sorting/reversing impl"
    );
}

// -------------------------------------------------------------------------
// TEST M8b-SM-2: distinct min/max levels are preserved (not swapped, not const)
//
// Kills: an impl that writes min into max (or vice-versa), or uses a single
// constant level for all entries.
// -------------------------------------------------------------------------

/// Each entry in the fixture has DISTINCT min and max levels (min != max,
/// and all three entries have different min/max pairs). This test verifies
/// that both fields are individually correct, killing a mutant that copies
/// min into max or uses a constant.
///
/// Kills: min-into-max copy; max-into-min copy; const(1) for all levels.
#[test]
fn encounter_rows_from_table_preserves_distinct_levels() {
    let table = m8b_test_encounter_table();
    let row: EncounterRow = encounter_rows_from_table(&table);

    // All three entries have distinct min ≠ max — ensures neither field is
    // aliased to the other.
    for (i, entry) in row.entries.iter().enumerate() {
        assert_ne!(
            entry.min_level, entry.max_level,
            "entries[{i}]: min_level ({}) must differ from max_level ({}) — \
             kills any impl that copies one field into the other",
            entry.min_level, entry.max_level
        );
    }

    // Verify the actual u8 values of all six level fields are distinct enough
    // to catch a constant-level impl (e.g., always writing 1).
    // min levels: 3, 5, 8 — all different
    let min_levels: Vec<u8> = row.entries.iter().map(|e| e.min_level).collect();
    assert_eq!(
        min_levels,
        vec![3u8, 5, 8],
        "min_levels across entries must be [3,5,8] — kills const-level impl"
    );

    // max levels: 7, 10, 15 — all different
    let max_levels: Vec<u8> = row.entries.iter().map(|e| e.max_level).collect();
    assert_eq!(
        max_levels,
        vec![7u8, 10, 15],
        "max_levels across entries must be [7,10,15] — kills const-level impl"
    );
}

// -------------------------------------------------------------------------
// TEST M8b-SM-3: empty entries → empty row entries, no panic
//
// B1 validation prevents empty tables from reaching sync_content_inner, but
// encounter_rows_from_table must be total (no panic on empty input).
// -------------------------------------------------------------------------

/// encounter_rows_from_table with empty entries must produce a row with
/// entries.is_empty() == true and must not panic.
///
/// Kills: any impl that indexes entries[0] unconditionally.
#[test]
fn encounter_rows_from_table_empty_entries() {
    let table = game_core::EncounterTable {
        zone_id: 99,
        encounter_rate: 100,
        entries: vec![],
    };

    // Must not panic — B1 blocks empties before seeding, but the helper
    // must be total regardless.
    let row: EncounterRow = encounter_rows_from_table(&table);

    assert_eq!(row.zone_id, 99, "zone_id preserved for empty-entries table");
    assert_eq!(
        row.encounter_rate, 100,
        "encounter_rate preserved for empty-entries table"
    );
    assert!(
        row.entries.is_empty(),
        "empty source entries → empty row entries (no panic)"
    );
}

// =========================================================================
// --- M8c gating tests ---
//
// Gate the PURE wild-monster build helper the implementer will add:
//   fn wild_battle_monster(species: &SpeciesRow, skill_ids: &[u32],
//                          level: u8, seed: u32) -> Result<BattleMonster, String>
// (full-HP, EVs-zero, IVs/nature from game_core::roll_individuality(seed),
//  derived via game_core::derive_stats, Level::new(level)?).
//
// The helper does NOT exist yet → this block is RED (won't compile until it
// is added). Mirrors the M7b `battle_monster_from_row` tests above.
//
// ASSUMPTION (documented per the handoff): the pure signature is
//   wild_battle_monster(&SpeciesRow, &[u32], u8, u32) -> Result<BattleMonster, String>
// where `skill_ids` is the set of skill ids the server has loaded; the helper
// intersects them with the species' learnable_skill_ids for known_skill_ids
// (same contract as battle_monster_from_row's skill handling). If the
// implementer picks a slightly different PURE signature it must keep: no ctx,
// deterministic in seed, full-HP, EVs-zero, Err (not panic) on bad level.
// =========================================================================

fn m8c_test_species_row() -> SpeciesRow {
    SpeciesRow {
        id: 7,
        name: "Wildling".to_string(),
        base_hp: 50,
        base_attack: 55,
        base_defense: 45,
        base_speed: 60,
        base_sp_attack: 65,
        base_sp_defense: 50,
        affinity: Affinity::Plant,
        learnable_skill_ids: vec![1, 2, 3],
    }
}

/// EARS (R-D / M8d rebuild contract): the wild build is DETERMINISTIC in the
/// seed — same seed ⇒ byte-identical BattleMonster.
/// Kills: an impl that draws from a non-seed RNG or ignores the seed when
/// rolling individuality (so the stored seed could not rebuild the same wild).
#[test]
fn wild_battle_monster_is_deterministic_in_seed() {
    let sp = m8c_test_species_row();
    let skill_ids = [1u32, 2, 3];
    let a =
        wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234).expect("valid level builds a wild");
    let b =
        wild_battle_monster(&sp, &skill_ids, 12, 0xABCD_1234).expect("valid level builds a wild");
    assert_eq!(a, b, "same seed must build an identical BattleMonster");
}

/// EARS: a freshly-spawned wild is at FULL HP — current_hp == max_hp == derived
/// HP, and the level/species come through.
/// Kills: an impl that starts the wild damaged (current_hp != max_hp), or that
/// sets max_hp from the wrong stat.
#[test]
fn wild_battle_monster_is_full_hp_and_carries_level_species() {
    let sp = m8c_test_species_row();
    let bm = wild_battle_monster(&sp, &[1, 2, 3], 18, 42).expect("valid level builds a wild");
    assert_eq!(
        bm.current_hp, bm.max_hp,
        "a fresh wild must be at full HP (current_hp == max_hp)"
    );
    assert_eq!(
        bm.max_hp, bm.stats.hp,
        "max_hp must equal the derived HP stat"
    );
    assert_eq!(bm.level, 18, "level must be the requested wild level");
    assert_eq!(
        bm.species_id, sp.id,
        "species_id must come from the species"
    );
    assert_eq!(
        bm.affinity, sp.affinity,
        "affinity must come from the species"
    );
}

/// EARS: known_skill_ids = the species' learnable filtered by the provided
/// skill ids (same contract as the owned-monster build).
/// Kills: an impl that copies ALL provided skill ids (ignoring learnable), or
/// copies ALL learnable (ignoring the provided set).
#[test]
fn wild_battle_monster_known_skills_are_learnable_intersect_provided() {
    let sp = m8c_test_species_row(); // learnable = [1,2,3]
                                     // Provide skill ids 2, 3, and 9 — but 9 is NOT learnable by this species.
    let bm = wild_battle_monster(&sp, &[2, 3, 9], 10, 5).expect("valid level builds a wild");
    assert_eq!(
        bm.known_skill_ids,
        vec![2u32, 3],
        "known_skill_ids must be learnable ∩ provided ([1,2,3] ∩ [2,3,9] = [2,3]); \
         kills copy-all-provided (would include 9) and copy-all-learnable (would include 1)"
    );
}

/// EARS (R-D): an out-of-range level is a loud `Err`, NEVER a panic (the wild
/// build must be total over arbitrary content levels).
/// Kills: an impl that calls `Level::new(level).unwrap()` (panics on 0 / 250)
/// instead of propagating the error.
#[test]
fn wild_battle_monster_bad_level_is_err_not_panic() {
    let sp = m8c_test_species_row();
    assert!(
        wild_battle_monster(&sp, &[1, 2, 3], 0, 1).is_err(),
        "level 0 must be an Err (Level::new rejects 0), not a panic"
    );
    assert!(
        wild_battle_monster(&sp, &[1, 2, 3], 250, 1).is_err(),
        "level 250 must be an Err (Level::new rejects > 100), not a panic"
    );
    // A boundary valid level must still succeed.
    assert!(
        wild_battle_monster(&sp, &[1, 2, 3], 100, 1).is_ok(),
        "level 100 is valid and must build a wild"
    );
}

/// EARS (M8d rebuild contract — the load-bearing one): the wild's derived stats
/// are EXACTLY what `game_core::roll_individuality(seed)` → `derive_stats(...)`
/// produces with EVs zero. This is what makes the stored `individuality_seed`
/// truly rebuild the same wild in M8d.
/// Kills: an impl that rolls individuality from a different seed transform,
/// uses non-zero EVs, or derives stats with the wrong inputs — any of which
/// would make the persisted seed rebuild a DIFFERENT monster than the one fought.
#[test]
fn wild_battle_monster_stats_match_roll_individuality_then_derive_stats() {
    let sp = m8c_test_species_row();
    let seed = 0x0BAD_F00D;
    let wild_level = 14u8;
    let bm =
        wild_battle_monster(&sp, &[1, 2, 3], wild_level, seed).expect("valid level builds a wild");

    // Reconstruct the EXACT expected derived stats from the SSOT pure path.
    let (ivs, nature) = game_core::roll_individuality(seed);
    let base = StatBlock {
        hp: sp.base_hp,
        attack: sp.base_attack,
        defense: sp.base_defense,
        speed: sp.base_speed,
        sp_attack: sp.base_sp_attack,
        sp_defense: sp.base_sp_defense,
    };
    let level = game_core::Level::new(wild_level).expect("valid level");
    let expected = game_core::derive_stats(&base, &ivs, &game_core::EVs::zero(), &nature, level);

    assert_eq!(
        bm.stats, expected,
        "wild stats must equal roll_individuality(seed) → derive_stats(.., EVs::zero, ..); \
         this is the M8d 'rebuild THAT exact wild' contract"
    );
    // And max_hp must equal the derived HP stat (full-HP coupling).
    assert_eq!(
        bm.max_hp, expected.hp,
        "max_hp must equal the derived HP stat from the same roll"
    );
}

// =========================================================================
// M12.5e-4 unit test: battle_monster_from_row must build known_skill_ids
// in canonical content order (species.learnable_skill_ids order), NOT in
// DB scan order (skills.iter() order).
//
// EARS: The owned-monster path SHALL build `known_skill_ids` in canonical
// content order (species.learnable_skill_ids order), mirroring
// wild_battle_monster.
//
// RED state: the current implementation does:
//   known_skill_ids: skills.iter().map(|s| s.id).collect()
// which returns IDs in whatever order the skills slice was passed in (DB
// scan order), NOT the canonical species.learnable_skill_ids order.
//
// When species.learnable_skill_ids = [3, 1, 2] and the skills slice is
// provided in scan order [2, 1, 3], the current code returns [2, 1, 3]
// but the spec requires [3, 1, 2] (canonical order).
//
// This assertion is RED today: assert_eq!(bm.known_skill_ids, vec![3, 1, 2])
// will fail because the current impl returns vec![2, 1, 3].
// =========================================================================

/// 12.5e-4 unit: owned battle monster known_skill_ids must follow
/// species.learnable_skill_ids canonical order, not DB scan order.
///
/// KILLS: an impl that does `skills.iter().map(|s| s.id).collect()` —
/// that returns [2, 1, 3] (scan order) when skills are provided in
/// [2, 1, 3] order but species.learnable_skill_ids is [3, 1, 2].
/// The correct impl must re-order by iterating learnable_skill_ids and
/// retaining only those present in the skills slice.
///
/// Species has learnable_skill_ids = [3, 1, 2] (non-ascending, intentional).
/// Skills are provided in scan order [2, 1, 3] (simulating DB not preserving
/// content order).
/// Expected known_skill_ids = [3, 1, 2] (canonical = learnable order).
#[test]
fn owned_battle_monster_known_skills_respect_canonical_order() {
    // Species with learnable_skill_ids in non-ascending order [3, 1, 2].
    // This is the canonical order the client expects (the order skills
    // appear in the species definition).
    let mut species = m7b_test_species_row();
    species.learnable_skill_ids = vec![3, 1, 2];

    let monster = m7b_test_monster_row(); // monster_id=42, stat_defense=45

    // Skills provided in reverse order (simulating non-canonical DB scan order:
    // the DB returns skill rows in insertion/scan order [2, 1, 3], not the
    // content-defined learnable order [3, 1, 2]).
    let skills = vec![
        SkillRow {
            id: 2,
            name: "B".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 20,
        },
        SkillRow {
            id: 1,
            name: "A".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 20,
        },
        SkillRow {
            id: 3,
            name: "C".to_string(),
            affinity: Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 20,
        },
    ];

    let bm = battle_monster_from_row(&monster, &species, &skills)
        .expect("valid monster + skills build a BattleMonster");

    assert_eq!(
        bm.known_skill_ids,
        vec![3u32, 1, 2],
        "owned monster known_skill_ids must follow species.learnable_skill_ids \
         canonical order [3,1,2], not DB scan order [2,1,3]; \
         KILLS: battle_monster_from_row impl that does \
         `skills.iter().map(|s| s.id).collect()` (returns [2,1,3], the scan order). \
         Fix: iterate species.learnable_skill_ids and retain only IDs present in the \
         skills slice, preserving learnable order."
    );
}

// =========================================================================
// M10.5a gating tests — wild_battle_monster empty-known-skills guard
// (defense-in-depth, ADR-0049, 10.5a-2)
// =========================================================================

/// M10.5a-2 (WHEN): wild_battle_monster must return Err when
/// learnable_skill_ids ∩ skill_ids = ∅ (the intersection is empty).
///
/// Fixture: SpeciesRow id=98 "EmptyMover" has learnable_skill_ids = [1, 2].
/// We pass skill_ids = [7, 8, 9] — entirely disjoint from [1, 2].
/// The intersection is empty, so known_skill_ids would be [].
/// A monster with an empty moveset panics at pick_best_skill's .expect(…).
///
/// PROOF-OF-TEETH: removing the guard causes wild_battle_monster to return
/// Ok(BattleMonster { known_skill_ids: [], … }). The assert!(result.is_err())
/// then FAILS, turning this test RED — proving the guard has bite.
///
/// Kills: any wild_battle_monster that builds and returns BattleMonster even
/// when the learnable × provided intersection is empty (the current behaviour,
/// which would reach pick_best_skill's .expect and panic at runtime).
#[test]
fn m10_5a_wild_battle_monster_rejects_empty_known_skills() {
    // Species with learnable_skill_ids [1, 2] — the "EmptyMover" fixture.
    // Distinct from m8c_test_species_row() to make the fixture self-contained.
    let sp = SpeciesRow {
        id: 98,
        name: "EmptyMover".to_string(),
        base_hp: 50,
        base_attack: 55,
        base_defense: 45,
        base_speed: 60,
        base_sp_attack: 65,
        base_sp_defense: 50,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1, 2],
    };

    // Skill ids [7, 8, 9] are entirely disjoint from learnable [1, 2].
    // The intersection is empty → known_skill_ids would be [].
    let disjoint_skill_ids = [7u32, 8, 9];

    let result = wild_battle_monster(&sp, &disjoint_skill_ids, 10, 42);
    assert!(
        result.is_err(),
        "M10.5a-2 TEETH: wild_battle_monster must return Err when \
         learnable_skill_ids ∩ skill_ids = ∅ (intersection is empty); \
         species learnable=[1,2] ∩ provided=[7,8,9] = []; \
         current impl returns Ok with known_skill_ids:[] which panics \
         downstream at pick_best_skill's .expect(…); \
         removing the guard makes this assertion fail (proof-of-teeth)"
    );
}

// =========================================================================
// 13.5f-5 gating tests — skill_defs_from_rows and type_chart_from_rows
// seed-time range checks (ADR-0049 symmetry with monster_to_instance).
// =========================================================================

// -------------------------------------------------------------------------
// skill_defs_from_rows: power > 0 + accuracy ∈ [1, 100]
// -------------------------------------------------------------------------

fn f5_skill_row_valid() -> SkillRow {
    SkillRow {
        id: 1,
        name: "Ember".to_string(),
        affinity: Affinity::Fire,
        power: 40,
        accuracy: 95,
        pp: 25,
    }
}

/// Positive: a skill row with valid power and accuracy must produce Ok.
/// Kills: an overly strict impl that rejects all skill rows.
#[test]
fn f5_skill_defs_from_rows_accepts_valid_row() {
    let rows = vec![f5_skill_row_valid()];
    let result = skill_defs_from_rows(&rows);
    assert!(
        result.is_ok(),
        "13.5f-5 TEETH: valid skill row (power=40, accuracy=95) must produce Ok; \
         got: {:?}",
        result.err()
    );
}

/// Proof-of-teeth A1: power == 0 → Err.
/// Kills: an impl that skips the power > 0 check.
#[test]
fn f5_skill_defs_from_rows_rejects_zero_power() {
    let mut row = f5_skill_row_valid();
    row.power = 0;
    let result = skill_defs_from_rows(&[row]);
    assert!(
        result.is_err(),
        "13.5f-5 TEETH: skill row with power=0 must produce Err; got Ok"
    );
}

/// Proof-of-teeth A2: accuracy == 0 → Err.
/// Kills: any impl that allows accuracy=0 (a 0% accuracy move is a content error).
#[test]
fn f5_skill_defs_from_rows_rejects_zero_accuracy() {
    let mut row = f5_skill_row_valid();
    row.accuracy = 0;
    let result = skill_defs_from_rows(&[row]);
    assert!(
        result.is_err(),
        "13.5f-5 TEETH: skill row with accuracy=0 must produce Err; got Ok"
    );
}

/// Proof-of-teeth A3: accuracy > 100 → Err.
/// Kills: an impl that only lower-bounds accuracy (skips the upper bound).
#[test]
fn f5_skill_defs_from_rows_rejects_accuracy_over_100() {
    let mut row = f5_skill_row_valid();
    row.accuracy = 101;
    let result = skill_defs_from_rows(&[row]);
    assert!(
        result.is_err(),
        "13.5f-5 TEETH: skill row with accuracy=101 must produce Err; got Ok"
    );
}

/// Boundary: accuracy == 100 is valid (max legal value).
/// Kills: an off-by-one impl using accuracy > 100 exclusion instead of >= 1 ∩ <= 100.
#[test]
fn f5_skill_defs_from_rows_accepts_accuracy_100() {
    let mut row = f5_skill_row_valid();
    row.accuracy = 100;
    let result = skill_defs_from_rows(&[row]);
    assert!(
        result.is_ok(),
        "13.5f-5: accuracy=100 is the legal maximum; must produce Ok. Got: {:?}",
        result.err()
    );
}

// -------------------------------------------------------------------------
// type_chart_from_rows: effectiveness ∈ {0, 5, 10, 20}
// -------------------------------------------------------------------------

fn f5_type_relation_rows_valid() -> Vec<crate::schema::TypeRelationRow> {
    use crate::schema::TypeRelationRow;
    use game_core::Affinity;
    vec![
        TypeRelationRow {
            id: 1,
            attacker: Affinity::Fire,
            defender: Affinity::Plant,
            effectiveness: 20,
        },
        TypeRelationRow {
            id: 2,
            attacker: Affinity::Fire,
            defender: Affinity::Water,
            effectiveness: 5,
        },
        TypeRelationRow {
            id: 3,
            attacker: Affinity::Plant,
            defender: Affinity::Electric,
            effectiveness: 10,
        },
    ]
}

/// Positive: rows with effectiveness in {0,5,10,20} must produce Ok.
/// Kills: an overly strict impl that rejects all type-chart rows.
#[test]
fn f5_type_chart_from_rows_accepts_valid_effectiveness_values() {
    let rows = f5_type_relation_rows_valid();
    let result = type_chart_from_rows(rows.into_iter());
    assert!(
        result.is_ok(),
        "13.5f-5 TEETH: type chart rows with effectiveness ∈ {{0,5,10,20}} must produce Ok; \
         got: {:?}",
        result.err()
    );
}

/// Proof-of-teeth B1: effectiveness == 3 (not in {0,5,10,20}) → Err.
/// Kills: an impl that skips the set-membership check.
#[test]
fn f5_type_chart_from_rows_rejects_invalid_effectiveness() {
    use crate::schema::TypeRelationRow;
    use game_core::Affinity;
    let rows = vec![TypeRelationRow {
        id: 1,
        attacker: Affinity::Fire,
        defender: Affinity::Water,
        effectiveness: 3,
    }];
    let result = type_chart_from_rows(rows.into_iter());
    assert!(
        result.is_err(),
        "13.5f-5 TEETH: effectiveness=3 is not in {{0,5,10,20}} → must produce Err; got Ok"
    );
}

/// Proof-of-teeth B2: effectiveness == 255 (large invalid value) → Err.
/// Kills: an impl that only checks the lower bound (e.g. effectiveness > 20).
#[test]
fn f5_type_chart_from_rows_rejects_effectiveness_255() {
    use crate::schema::TypeRelationRow;
    use game_core::Affinity;
    let rows = vec![TypeRelationRow {
        id: 1,
        attacker: Affinity::Plant,
        defender: Affinity::Fire,
        effectiveness: 255,
    }];
    let result = type_chart_from_rows(rows.into_iter());
    assert!(
        result.is_err(),
        "13.5f-5 TEETH: effectiveness=255 is not in {{0,5,10,20}} → must produce Err; got Ok"
    );
}

/// Boundary: effectiveness == 0 (immune) is a valid sentinel value.
/// Kills: an impl that treats 0 as "unset" and rejects it.
#[test]
fn f5_type_chart_from_rows_accepts_zero_effectiveness() {
    use crate::schema::TypeRelationRow;
    use game_core::Affinity;
    let rows = vec![TypeRelationRow {
        id: 1,
        attacker: Affinity::Dark,
        defender: Affinity::Light,
        effectiveness: 0,
    }];
    let result = type_chart_from_rows(rows.into_iter());
    assert!(
        result.is_ok(),
        "13.5f-5: effectiveness=0 (immunity sentinel) is a legal value; must produce Ok. \
         Got: {:?}",
        result.err()
    );
}

/// M10.5a-2-pos (no over-rejection): wild_battle_monster must return Ok when
/// the intersection is non-empty (at least one learnable skill is provided).
///
/// Uses m8c_test_species_row() (learnable=[1,2,3]) with skill_ids=[1] —
/// intersection=[1] (non-empty). Must succeed to prevent a vacuous always-Err
/// guard from breaking all existing wild encounter builds.
///
/// Kills: a vacuous guard that always returns Err regardless of intersection
/// size, which would reject every valid wild encounter.
#[test]
fn m10_5a_wild_battle_monster_accepts_nonempty_known_skills() {
    let sp = m8c_test_species_row(); // learnable_skill_ids: [1, 2, 3]

    // Provide skill_ids=[1] — intersection=[1,2,3]∩[1]=[1] (non-empty).
    let skill_ids = [1u32];

    let result = wild_battle_monster(&sp, &skill_ids, 10, 42);
    assert!(
        result.is_ok(),
        "M10.5a-2-pos: wild_battle_monster must return Ok when \
         learnable_skill_ids ∩ skill_ids is non-empty ([1,2,3] ∩ [1] = [1]); \
         got Err: {:?}",
        result.err()
    );
    // Spot-check: known_skill_ids must be the non-empty intersection [1].
    let bm = result.unwrap();
    assert_eq!(
        bm.known_skill_ids,
        vec![1u32],
        "M10.5a-2-pos: BattleMonster.known_skill_ids must be [1] \
         (learnable [1,2,3] ∩ provided [1] = [1]); got: {:?}",
        bm.known_skill_ids
    );
}

// M10.5a gating tests — battle_monster_from_row empty-known-skills guard
// (defense-in-depth, ADR-0049, H-1 from review). Mirrors the wild_battle_monster
// guard above but for owned-monster path.

/// M10.5a-3 TEETH: battle_monster_from_row must return Err when the
/// learnable_skill_ids ∩ loaded_skills intersection is empty.
///
/// Kills: an impl that returns Ok with known_skill_ids: [] (which causes
/// pick_best_skill to panic when the enemy AI runs).
///
/// PROOF-OF-TEETH: removing the empty-known-skills guard in battle_monster_from_row
/// makes this test RED (returns Ok instead of Err).
#[test]
fn m10_5a_battle_monster_from_row_rejects_empty_known_skills() {
    let species = SpeciesRow {
        id: 97,
        name: "EmptyKnownOwned".to_string(),
        base_hp: 50,
        base_attack: 55,
        base_defense: 45,
        base_speed: 60,
        base_sp_attack: 65,
        base_sp_defense: 50,
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![1, 2], // species has skills in content
    };
    let mut monster = m7b_test_monster_row();
    monster.species_id = 97;
    // Empty skills slice: intersection with [1,2] is [] (stale/diverged DB state).
    let result = battle_monster_from_row(&monster, &species, &[]);
    assert!(
        result.is_err(),
        "M10.5a-3 TEETH: battle_monster_from_row must return Err when \
         learnable_skill_ids ∩ loaded_skills is empty ([1,2] ∩ [] = []); \
         got Ok — removing the guard makes this RED"
    );
}

/// M10.5a-3-pos: a valid monster+species+skills triple must still return Ok.
///
/// Kills: a vacuous always-Err impl.
#[test]
fn m10_5a_battle_monster_from_row_accepts_nonempty_known_skills() {
    let species = m7b_test_species_row(); // learnable_skill_ids: [1, 2]
    let monster = m7b_test_monster_row(); // stat_defense = 45
    let skills = m7b_test_skill_rows(); // includes ids 1 and 2
    let result = battle_monster_from_row(&monster, &species, &skills);
    assert!(
        result.is_ok(),
        "M10.5a-3-pos: battle_monster_from_row must return Ok for a valid row \
         with non-empty skill intersection; got Err: {:?}",
        result.err()
    );
}

// =========================================================================
// M13.5c gating tests (EARS 13.5c-3) — write_back_hp clamps to the ROW's
// stat_hp.
//
// Scenario: a mid-battle content nerf (sync_content re-derive) lowered the
// Monster row's stat_hp while the in-flight BattleMonster still carries the
// OLD (higher) max_hp/current_hp. Writing bm.current_hp back unclamped
// produces current_hp > stat_hp — an illegal row the battle engine and the
// recompute clamp invariant (12.5b-3) both forbid.
//
// Clamp target is the ROW's stat_hp, NOT bm.max_hp (bm.max_hp is the stale
// pre-nerf value). Note the write-back ordering caveat: correctness of the
// clamp depends on write-back running BEFORE the XP/level-up re-derive
// (battle.rs), which recomputes from the SSOT afterwards.
//
// RED state: marshal.rs:331-333 currently does an unclamped
// `monster.current_hp = bm.current_hp;` → the first test fails (200 != 120).
// =========================================================================

/// EARS 13.5c-3: write_back_hp must clamp bm.current_hp to the row's stat_hp.
///
/// KILLS: the current unclamped write (`monster.current_hp = bm.current_hp;`)
/// — it lands current_hp=200 on a stat_hp=120 row (illegal state).
/// ALSO KILLS: an impl that clamps to `bm.max_hp` instead of the ROW's
/// stat_hp — bm.max_hp is deliberately set to the stale 200 here, so a
/// bm.max_hp clamp still writes 200 and this assertion fires.
#[test]
fn m13_5c_write_back_hp_clamps_to_row_stat_hp() {
    let mut monster = m7b_test_monster_row(); // row stat_hp = 120 (post-nerf)
    let bm = game_core::BattleMonster {
        species_id: monster.species_id,
        affinity: Affinity::Fire,
        level: monster.level,
        current_hp: 200, // battle HP derived from stale pre-nerf stats
        max_hp: 200,     // stale pre-nerf max — NOT the clamp target
        stats: game_core::StatBlock {
            hp: 200, // stale pre-nerf derived HP
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: vec![1],
        status: None,
    };

    write_back_hp(&mut monster, &bm);

    assert_eq!(
        monster.current_hp, 120,
        "TEETH(13.5c-3): write_back_hp must clamp current_hp to the Monster \
         ROW's stat_hp (120); an unclamped write lands 200 and violates the \
         current_hp <= stat_hp invariant, got {}",
        monster.current_hp
    );
    // stat_hp itself must never be modified by write-back (derived, not a
    // battle value) — same contract as M7b-SM-2.
    assert_eq!(
        monster.stat_hp, 120,
        "write_back_hp must not touch stat_hp while clamping"
    );
}

/// EARS 13.5c-3 equality edge: bm.current_hp == row stat_hp passes through
/// unchanged (clamp is inclusive: min(current_hp, stat_hp)).
///
/// KILLS: an off-by-one clamp (e.g. `min(bm.current_hp, stat_hp - 1)` or a
/// strict `<` guard that rewrites the full-HP value) — either would write
/// 119 instead of 120 here.
#[test]
fn m13_5c_write_back_hp_equality_edge_passes_through() {
    let mut monster = m7b_test_monster_row(); // row stat_hp = 120
    let bm = game_core::BattleMonster {
        species_id: monster.species_id,
        affinity: Affinity::Fire,
        level: monster.level,
        current_hp: 120, // exactly at the row's stat_hp — full HP, legal
        max_hp: monster.stat_hp,
        stats: game_core::StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: vec![1],
        status: None,
    };

    write_back_hp(&mut monster, &bm);

    assert_eq!(
        monster.current_hp, 120,
        "TEETH(13.5c-3 equality edge): current_hp == stat_hp is a legal \
         full-HP state and must pass through unchanged (inclusive clamp); \
         got {}",
        monster.current_hp
    );
}
