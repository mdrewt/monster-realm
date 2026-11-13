//! `marshal` domain-submodule tests (M8.9c — test relocation).
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
        acked_seq: 0,
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
        ability: None,
        // evolution-graph tier. 0 = a base, wild-catchable form.
        tier: 0,
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
///
/// The signature is `pub_from_monster(&Monster, tier: u8)`.
#[test]
fn pub_from_monster_omits_hidden_fields() {
    let sp = test_species();
    let inst = roll_starter(42, &sp);
    let identity = Identity::from_byte_array([1u8; 32]);
    let m = monster_from_instance(identity, &inst, PARTY_SLOT_NONE);
    let p = pub_from_monster(&m, 0);

    // Public fields match
    assert_eq!(p.monster_id, m.monster_id);
    assert_eq!(p.owner_identity, m.owner_identity);
    assert_eq!(p.species_id, m.species_id);
    assert_eq!(p.nickname, m.nickname);
    assert_eq!(p.level, m.level);
    assert_eq!(p.xp, m.xp);
    assert_eq!(p.current_hp, m.current_hp);
    assert_eq!(p.stat_hp, m.stat_hp);
    assert_eq!(p.stat_attack, m.stat_attack);
    assert_eq!(p.stat_defense, m.stat_defense);
    assert_eq!(p.stat_speed, m.stat_speed);
    assert_eq!(p.stat_sp_attack, m.stat_sp_attack);
    assert_eq!(p.stat_sp_defense, m.stat_sp_defense);
    assert_eq!(p.party_slot, m.party_slot);
    // The MonsterPub struct has no IV/EV/nature fields — this is a compile-time
    // guarantee.
}

// =========================================================================
// server-module helper seams
//
// These tests gate the two pure helper functions that the battle write-back
// and the reward rules depend on.
//
// The helpers being gated:
//   1. write_back_hp(monster_row, battle_monster)
//      Writes HP from the battle-engine state back to the Monster row.
//
//   2. loser_base_stat_total(species_row) -> u16
//      Sums the six base stats from a SpeciesRow for the XP formula.
//
// Neither function touches ReducerContext — they are pure transformers
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
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
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
        ability: None,
        tier: 0,
    }
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
        ability: None,
        tier: 0,
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
        ability: None,
        tier: 0,
    };
    // 255 * 6 = 1530, which fits in u16.
    let bst: u16 = loser_base_stat_total(&species);
    assert_eq!(
        bst, 1530,
        "loser_base_stat_total must not overflow u8; 255*6=1530, got {bst}"
    );
}

// =========================================================================
// encounter_rows_from_table marshaling seam
//
// These tests gate the pure function `encounter_rows_from_table` that the
// implementer will add to server-module/src/lib.rs.
//
// Mirror: monster_from_instance_flattens_correctly.
// Flatten-at-boundary: Level -> u8 (same pattern as Millis -> i64).
//
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
// write_back_hp clamps to the ROW's stat_hp.
//
// Scenario: a mid-battle content nerf (sync_content re-derive) lowered the
// Monster row's stat_hp while the in-flight BattleMonster still carries the
// OLD (higher) max_hp/current_hp. Writing bm.current_hp back unclamped
// produces current_hp > stat_hp — an illegal row the battle engine and the
// recompute clamp invariant both forbid.
//
// Clamp target is the ROW's stat_hp, NOT bm.max_hp (bm.max_hp is the stale
// pre-nerf value). Note the write-back ordering caveat: correctness of the
// clamp depends on write-back running BEFORE the XP/level-up re-derive
// (battle.rs), which recomputes from the SSOT afterwards.
//
// =========================================================================

/// write_back_hp must clamp bm.current_hp to the row's stat_hp.
///
/// an impl that clamps to `bm.max_hp` instead of the ROW's
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

/// bm.current_hp == row stat_hp passes through
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

// =========================================================================
// Migration A marshaling.
//
// Field-by-field with DISTINCTIVE values throughout: a transposed column or a
// hardcoded constant must not be able to survive.
// =========================================================================

/// A `MonsterInstance` whose every EG1 field carries a DISTINCT value, so no
/// two columns can be swapped without a test firing.
///
/// essence = [1,2,3,4,5,6,7,8] in `Affinity::ALL` order (Fire..Dark),
/// trust favorable = 11, unfavorable = 22, quality-time ticks = 33.
fn eg1_distinctive_instance() -> MonsterInstance {
    let ivs = game_core::IVs::new(1, 2, 3, 4, 5, 6).expect("valid IVs");
    let evs = EVs::new(10, 20, 30, 40, 50, 60).expect("valid EVs");
    let nature = game_core::Nature::new(game_core::NatureKind::Adamant);
    let level = Level::new(25).expect("valid level");
    MonsterInstance {
        species_id: 7,
        nickname: Some("Distinct".to_string()),
        level,
        xp: game_core::Xp::new(15_625),
        ivs,
        nature,
        evs,
        essence: [1, 2, 3, 4, 5, 6, 7, 8],
        trust_favorable_count: 11,
        trust_unfavorable_count: 22,
        quality_time_ticks_total: 33,
        current_hp: 55,
        derived_stats: StatBlock {
            hp: 70,
            attack: 40,
            defense: 41,
            speed: 42,
            sp_attack: 43,
            sp_defense: 44,
        },
        party_slot: Some(2),
    }
}

/// A `Monster` row whose every EG1 column carries a DISTINCT value (the row-side
/// mirror of `eg1_distinctive_instance`).
fn eg1_distinctive_monster_row() -> Monster {
    let mut m = m7b_test_monster_row();
    m.essence_fire = 1;
    m.essence_water = 2;
    m.essence_plant = 3;
    m.essence_electric = 4;
    m.essence_earth = 5;
    m.essence_wind = 6;
    m.essence_light = 7;
    m.essence_dark = 8;
    m.trust_favorable_count = 11;
    m.trust_unfavorable_count = 22;
    m.quality_time_ticks_total = 33;
    m
}

// -------------------------------------------------------------------------
// monster_from_instance flattens the new instance fields
// -------------------------------------------------------------------------

/// The 8 essence pools and the three history stats flatten from the
/// `MonsterInstance` into their named columns, in `Affinity::ALL` order.
///
/// Kills: an impl that leaves the new columns at 0 on creation (essence/trust/
/// quality-time silently discarded at the boundary), and any transposition of the
/// essence array into the flat columns (every value is distinct).
#[test]
fn eg1_monster_from_instance_flattens_new_fields() {
    let inst = eg1_distinctive_instance();
    let identity = Identity::from_byte_array([3u8; 32]);
    let m = monster_from_instance(identity, &inst, 0);

    assert_eq!(
        (
            m.essence_fire,
            m.essence_water,
            m.essence_plant,
            m.essence_electric,
            m.essence_earth,
            m.essence_wind,
            m.essence_light,
            m.essence_dark
        ),
        (1, 2, 3, 4, 5, 6, 7, 8),
        "TEETH(EG1-1): the 8 flat essence columns must take instance.essence in \
         Affinity::ALL order (Fire..Dark); kills a transposed or zeroing flatten"
    );
    assert_eq!(
        m.trust_favorable_count, 11,
        "trust_favorable_count must flatten from the instance (11)"
    );
    assert_eq!(
        m.trust_unfavorable_count, 22,
        "trust_unfavorable_count must flatten from the instance (22); \
         kills a favorable/unfavorable swap (11 vs 22 are distinct on purpose)"
    );
    assert_eq!(
        m.quality_time_ticks_total, 33,
        "quality_time_ticks_total must flatten from the instance (33)"
    );
}

/// The SERVER-ONLY columns — the ones with no `MonsterInstance` counterpart
/// — start at 0 for a freshly created monster (epoch anchors / empty accumulators).
///
/// Kills: an impl that copies an unrelated field into them (e.g. seeding
/// `last_essence_train_at_ms` from `now_ms`, which would silently put a brand-new
/// monster on cooldown), or that leaves them uninitialised garbage.
#[test]
fn eg1_monster_from_instance_defaults_server_only_columns_to_zero() {
    let inst = eg1_distinctive_instance();
    let identity = Identity::from_byte_array([3u8; 32]);
    let m = monster_from_instance(identity, &inst, 0);

    assert_eq!(
        m.trust_favorable_battle_day_epoch, 0,
        "trust_favorable_battle_day_epoch is server-only state — 0 at creation"
    );
    assert_eq!(
        m.quality_time_accum_ms, 0,
        "quality_time_accum_ms is server-only state — 0 at creation"
    );
    assert_eq!(
        m.quality_time_window_ms, 0,
        "quality_time_window_ms is server-only state — 0 at creation"
    );
    assert_eq!(
        m.quality_time_window_start_ms, 0,
        "quality_time_window_start_ms is server-only state — 0 at creation"
    );
    assert_eq!(
        m.last_essence_train_at_ms, 0,
        "TEETH: last_essence_train_at_ms must be 0 (epoch ⇒ cooldown elapsed ⇒ the \
         first essence_train is allowed); kills seeding it from the clock"
    );
}

// -------------------------------------------------------------------------
// monster_to_instance rebuilds the new fields (the inverse leg)
// -------------------------------------------------------------------------

/// The 8 named essence columns rebuild `instance.essence` INDEXED BY
/// `Affinity::index()` — column `essence_fire` lands at `Affinity::Fire`'s index,
/// `essence_dark` at `Affinity::Dark`'s, and so on.
///
/// Kills: a reversed array build ([8,7,..,1]), any pairwise transposition, and a
/// positional build that ignores `Affinity::ALL` order — every one of the 8 values
/// is distinct, and the per-affinity assertions below pin each slot by NAME.
#[test]
fn eg1_monster_to_instance_round_trips_new_fields() {
    let m = eg1_distinctive_monster_row();

    let inst = monster_to_instance(&m).expect("a valid row marshals");

    assert_eq!(
        inst.essence,
        [1u32, 2, 3, 4, 5, 6, 7, 8],
        "TEETH(EG1-7): instance.essence must be [essence_fire..essence_dark] in \
         Affinity::ALL order; kills a reversed or re-sorted rebuild"
    );
    // Per-affinity pins: these are what actually kill a transposition, because they
    // name the affinity rather than assuming a position.
    assert_eq!(
        inst.essence[Affinity::Fire.index()],
        1,
        "essence_fire (1) must land at Affinity::Fire's index"
    );
    assert_eq!(
        inst.essence[Affinity::Water.index()],
        2,
        "essence_water (2) must land at Affinity::Water's index"
    );
    assert_eq!(
        inst.essence[Affinity::Plant.index()],
        3,
        "essence_plant (3) must land at Affinity::Plant's index"
    );
    assert_eq!(
        inst.essence[Affinity::Electric.index()],
        4,
        "essence_electric (4) must land at Affinity::Electric's index"
    );
    assert_eq!(
        inst.essence[Affinity::Earth.index()],
        5,
        "essence_earth (5) must land at Affinity::Earth's index"
    );
    assert_eq!(
        inst.essence[Affinity::Wind.index()],
        6,
        "essence_wind (6) must land at Affinity::Wind's index"
    );
    assert_eq!(
        inst.essence[Affinity::Light.index()],
        7,
        "essence_light (7) must land at Affinity::Light's index"
    );
    assert_eq!(
        inst.essence[Affinity::Dark.index()],
        8,
        "essence_dark (8) must land at Affinity::Dark's index"
    );

    assert_eq!(
        inst.trust_favorable_count, 11,
        "trust_favorable_count must rebuild from the row (11)"
    );
    assert_eq!(
        inst.trust_unfavorable_count, 22,
        "TEETH: trust_unfavorable_count must rebuild from the row (22); \
         11 vs 22 are distinct precisely so a favorable/unfavorable swap dies here"
    );
    assert_eq!(
        inst.quality_time_ticks_total, 33,
        "quality_time_ticks_total must rebuild from the row (33)"
    );
}

/// Round-trip closure: row -> instance -> row preserves every EG1 value.
///
/// Kills: an asymmetric pair of marshal legs (e.g. `monster_to_instance` reading
/// `essence_light` where `monster_from_instance` writes `essence_dark`) — an error
/// that cancels out in neither direction alone but is visible across the round trip.
#[test]
fn eg1_monster_essence_round_trip_is_lossless() {
    let m = eg1_distinctive_monster_row();
    let inst = monster_to_instance(&m).expect("a valid row marshals");
    let back = monster_from_instance(m.owner_identity, &inst, m.party_slot);

    assert_eq!(
        (
            back.essence_fire,
            back.essence_water,
            back.essence_plant,
            back.essence_electric,
            back.essence_earth,
            back.essence_wind,
            back.essence_light,
            back.essence_dark
        ),
        (
            m.essence_fire,
            m.essence_water,
            m.essence_plant,
            m.essence_electric,
            m.essence_earth,
            m.essence_wind,
            m.essence_light,
            m.essence_dark
        ),
        "row -> instance -> row must preserve all 8 essence columns exactly"
    );
    assert_eq!(back.trust_favorable_count, m.trust_favorable_count);
    assert_eq!(back.trust_unfavorable_count, m.trust_unfavorable_count);
    assert_eq!(back.quality_time_ticks_total, m.quality_time_ticks_total);
}

// -------------------------------------------------------------------------
// pub_from_monster(m, tier) — the projection now DERIVES three
// public tiers and takes `tier` from its caller.
// -------------------------------------------------------------------------

/// `tier` comes from the ARGUMENT, never from a default or from the row.
///
/// Kills: an impl that hardcodes `tier: 0` (or any constant) and ignores the new
/// parameter — two calls with different tiers must produce different projections.
#[test]
fn eg1_pub_from_monster_uses_passed_tier_not_default() {
    let m = eg1_distinctive_monster_row();

    let p3 = pub_from_monster(&m, 3);
    assert_eq!(
        p3.tier, 3,
        "TEETH(EG1-8): MonsterPub.tier must be the passed tier (3); \
         kills a hardcoded 0/default"
    );

    let p0 = pub_from_monster(&m, 0);
    assert_eq!(
        p0.tier, 0,
        "tier 0 must also come through verbatim (no clamping/bumping)"
    );
    assert_ne!(
        p3.tier, p0.tier,
        "TEETH: the projection must actually vary with the tier argument"
    );
}

/// `MonsterPub.trust_tier` is DERIVED from the row's
/// two lifetime counters via `game_core::trust_tier_of` — never stored, never a
/// caller argument.
///
/// Fixtures: (fav=30, unfav=0) sits exactly on the Devoted band edge
/// ((30+10)*100 == 80*(30+0+20)), and (0, 0) is the zero-history midpoint,
/// Neutral.
///
/// Kills: an impl that writes the `#[default(TrustTier::Neutral)]` value
/// unconditionally (the Devoted case fires), and one that hardcodes any single
/// tier (the Neutral case fires).
#[test]
fn eg1_pub_from_monster_computes_trust_tier() {
    let mut devoted = eg1_distinctive_monster_row();
    devoted.trust_favorable_count = 30;
    devoted.trust_unfavorable_count = 0;
    assert_eq!(
        pub_from_monster(&devoted, 1).trust_tier,
        game_core::TrustTier::Devoted,
        "TEETH: (fav=30, unfav=0) is the Devoted band edge — smoothed \
         (30+10)/(30+0+20) = 40/50 = 80%, inclusive; kills an always-Neutral impl"
    );

    let mut fresh = eg1_distinctive_monster_row();
    fresh.trust_favorable_count = 0;
    fresh.trust_unfavorable_count = 0;
    assert_eq!(
        pub_from_monster(&fresh, 1).trust_tier,
        game_core::TrustTier::Neutral,
        "TEETH: zero history smooths to exactly 50% = Neutral; \
         kills an always-Devoted impl and a raw fav/(fav+unfav) ratio (0/0)"
    );

    // The projection must AGREE with the game-core SSOT, not re-derive its own bands.
    assert_eq!(
        pub_from_monster(&devoted, 1).trust_tier,
        game_core::trust_tier_of(
            devoted.trust_favorable_count,
            devoted.trust_unfavorable_count
        ),
        "MonsterPub.trust_tier must equal game_core::trust_tier_of(fav, unfav)"
    );
}

/// `MonsterPub.quality_time_tier` is derived from
/// `quality_time_ticks_total` via `game_core::quality_time_tier_of`.
///
/// 150 ticks is the INCLUSIVE lower bound of tier 3; 149 is still tier 2.
///
/// Kills: an off-by-one band lookup (exclusive `>`), a hardcoded 0, and an impl
/// that copies the raw tick count into the u8 column.
#[test]
fn eg1_pub_from_monster_computes_quality_time_tier() {
    let mut at_boundary = eg1_distinctive_monster_row();
    at_boundary.quality_time_ticks_total = 150;
    assert_eq!(
        pub_from_monster(&at_boundary, 1).quality_time_tier,
        3,
        "TEETH: 150 ticks is the INCLUSIVE lower bound of quality-time tier 3; \
         kills an exclusive `>` band lookup (would say 2) and a raw-tick copy"
    );

    let mut just_below = eg1_distinctive_monster_row();
    just_below.quality_time_ticks_total = 149;
    assert_eq!(
        pub_from_monster(&just_below, 1).quality_time_tier,
        2,
        "TEETH: 149 ticks is still tier 2; kills a constant-3 impl and an \
         off-by-one that rounds the boundary down a band early"
    );
}

/// `MonsterPub.nutrition_pct` is the EV pool as a
/// percentage of the 510 budget, computed over the SIX ev_* columns.
///
/// 252 + 3 = 255 EVs = exactly half the 510 budget → 50.
///
/// Kills: summing only five columns (would give 3 or 47 here), dividing by 255
/// instead of 510 (would give 100), and a hardcoded 0.
#[test]
fn eg1_pub_from_monster_computes_nutrition_pct() {
    let mut half = eg1_distinctive_monster_row();
    half.ev_hp = 252;
    half.ev_attack = 3;
    half.ev_defense = 0;
    half.ev_speed = 0;
    half.ev_sp_attack = 0;
    half.ev_sp_defense = 0;
    assert_eq!(
        pub_from_monster(&half, 1).nutrition_pct,
        50,
        "TEETH: EV total 255 of the 510 budget is 50%; kills a /255 denominator \
         (100), a five-column sum (49), and a hardcoded 0"
    );

    let mut empty = eg1_distinctive_monster_row();
    empty.ev_hp = 0;
    empty.ev_attack = 0;
    empty.ev_defense = 0;
    empty.ev_speed = 0;
    empty.ev_sp_attack = 0;
    empty.ev_sp_defense = 0;
    assert_eq!(
        pub_from_monster(&empty, 1).nutrition_pct,
        0,
        "an empty EV pool is 0% nutrition; kills a constant-50 impl"
    );

    // Agreement with the game-core SSOT formula (A12: the total-based
    // helper is `pub` precisely so this cross-crate caller shares ONE formula).
    let total: u16 = half.ev_hp
        + half.ev_attack
        + half.ev_defense
        + half.ev_speed
        + half.ev_sp_attack
        + half.ev_sp_defense;
    assert_eq!(
        pub_from_monster(&half, 1).nutrition_pct,
        game_core::nutrition_pct_from_ev_total(total),
        "MonsterPub.nutrition_pct must equal game_core::nutrition_pct_from_ev_total(total)"
    );
}

/// All 8 public essence columns are copied VERBATIM from the private row
/// (they are public by design — the client's requirements panel reads them).
///
/// Kills: a projection that zeroes or transposes essence on the way out — every
/// value is distinct, so any permutation fires.
#[test]
fn eg1_pub_from_monster_copies_all_eight_essence_columns() {
    let m = eg1_distinctive_monster_row();
    let p = pub_from_monster(&m, 2);

    assert_eq!(
        p.essence_fire, m.essence_fire,
        "essence_fire must be copied"
    );
    assert_eq!(
        p.essence_water, m.essence_water,
        "essence_water must be copied"
    );
    assert_eq!(
        p.essence_plant, m.essence_plant,
        "essence_plant must be copied"
    );
    assert_eq!(
        p.essence_electric, m.essence_electric,
        "essence_electric must be copied"
    );
    assert_eq!(
        p.essence_earth, m.essence_earth,
        "essence_earth must be copied"
    );
    assert_eq!(
        p.essence_wind, m.essence_wind,
        "essence_wind must be copied"
    );
    assert_eq!(
        p.essence_light, m.essence_light,
        "essence_light must be copied"
    );
    assert_eq!(
        p.essence_dark, m.essence_dark,
        "essence_dark must be copied"
    );
    assert_eq!(
        (
            p.essence_fire,
            p.essence_water,
            p.essence_plant,
            p.essence_electric,
            p.essence_earth,
            p.essence_wind,
            p.essence_light,
            p.essence_dark
        ),
        (1, 2, 3, 4, 5, 6, 7, 8),
        "TEETH(EG1-2): the projected essence tuple must be (1..8) — kills any \
         permutation of the eight copies"
    );
}

/// qf-3 (QF3.1/QF3.2): `MonsterPub.last_care_at_ms` is the private row's care
/// cooldown anchor copied VERBATIM — never derived, never clamped, never taken
/// from another column — and moving the anchor alone moves nothing else in the
/// projection.
///
/// Every mirror site writes `monster_pub` through this one fn, so this copy is
/// what keeps the owner's cooldown hint correct after a care, a train, an
/// evolve, a trade or a content resync.
///
/// Kills: `last_care_at_ms: 0` (the column's default — the hint would read every
/// monster as never cared); a copy from `last_essence_train_at_ms` or
/// `quality_time_window_start_ms` (both set to other nonzero values); `.max(0)`
/// on the anchor (the -42 and i64::MIN rows); a truncation through u32/i32 (the
/// 1.75e12 and i64::MAX rows); and a projection that derives some OTHER public
/// column from the anchor (the tier/nutrition/trust/quality-time tuple must not
/// move when only the anchor does).
#[test]
fn pub_from_monster_copies_last_care_at_ms_verbatim_qf3() {
    let mut m = eg1_distinctive_monster_row();
    m.last_essence_train_at_ms = 1_111_111_111_111;
    m.quality_time_window_start_ms = 2_222_222_222_222;
    // A nonzero EV spread (252 + 3 = 255 = half the budget), so nutrition_pct is a
    // real derived value rather than a default 0 that could not move anyway.
    m.ev_hp = 252;
    m.ev_attack = 3;
    m.last_care_at_ms = 1_750_000_000_123;
    let baseline = pub_from_monster(&m, 3);
    assert_eq!(
        baseline.tier, 3,
        "fixture: the baseline projection carries the passed tier"
    );
    assert_eq!(
        baseline.nutrition_pct,
        game_core::nutrition_pct_from_ev_total(255),
        "fixture: the baseline nutrition_pct is the real derived value for 255 EVs"
    );
    assert_eq!(
        baseline.quality_time_tier,
        game_core::quality_time_tier_of(33),
        "fixture: the baseline quality_time_tier is derived from the row's 33 ticks"
    );
    assert_eq!(
        baseline.trust_tier,
        game_core::trust_tier_of(11, 22),
        "fixture: the baseline trust tier is derived from the row's 11/22 counters"
    );

    for anchor in [1_750_000_000_123_i64, -42, i64::MAX, i64::MIN] {
        m.last_care_at_ms = anchor;
        let p = pub_from_monster(&m, 3);
        assert_eq!(
            p.last_care_at_ms, anchor,
            "TEETH(qf-3): MonsterPub.last_care_at_ms must be the monster row's care anchor \
             ({anchor}) verbatim; got {} (0 = never copied; 1111111111111 / 2222222222222 = a \
             sibling i64 column was copied instead)",
            p.last_care_at_ms
        );
        assert_eq!(
            p.tier, baseline.tier,
            "qf-3: changing ONLY the care anchor (to {anchor}) must leave tier as it was"
        );
        assert_eq!(
            p.nutrition_pct, baseline.nutrition_pct,
            "qf-3: changing ONLY the care anchor (to {anchor}) must leave nutrition_pct alone"
        );
        assert_eq!(
            p.quality_time_tier, baseline.quality_time_tier,
            "qf-3: changing ONLY the care anchor (to {anchor}) must leave quality_time_tier alone"
        );
        assert_eq!(
            p.trust_tier, baseline.trust_tier,
            "qf-3: changing ONLY the care anchor (to {anchor}) must leave trust_tier as it was"
        );
        assert_eq!(
            p.monster_id, m.monster_id,
            "qf-3: the anchor copy must not disturb the monster id"
        );
        assert_eq!(
            p.owner_identity, m.owner_identity,
            "qf-3: the anchor copy must not disturb the owner"
        );
    }
}

// -------------------------------------------------------------------------
// species_from_row carries the new tier column
// -------------------------------------------------------------------------

/// `SpeciesRow.tier` marshals into `game_core::Species.tier`.
///
/// Kills: an impl that leaves `tier: 0` on the domain struct (which would make
/// every tier-monotonicity check pass vacuously against real content).
#[test]
fn eg1_species_from_row_carries_tier() {
    let mut row = m7b_test_species_row();
    row.tier = 3;

    let sp = species_from_row(&row).expect("a valid species row marshals");
    assert_eq!(
        sp.tier, 3,
        "TEETH(EG1-3): Species.tier must come from SpeciesRow.tier (3); \
         kills a hardcoded 0"
    );

    let mut base = m7b_test_species_row();
    base.tier = 0;
    assert_eq!(
        species_from_row(&base).expect("valid").tier,
        0,
        "a tier-0 base form marshals as 0 (kills a constant-3 impl)"
    );
}

// -------------------------------------------------------------------------
// evolution_path_from_row — the DB row -> pure content struct leg
// -------------------------------------------------------------------------

/// A fully populated `EvolutionPathRow` with distinctive values in every field.
fn eg1_evolution_path_row() -> crate::schema::EvolutionPathRow {
    crate::schema::EvolutionPathRow {
        path_id: 9_001, // DB-internal only — NEVER durable identity
        edge_id: 77,
        from_species: 3,
        to_species: 9,
        min_level: 22,
        essence: vec![
            crate::schema::EssenceRequirementRow {
                affinity: Affinity::Water,
                amount: 120,
            },
            crate::schema::EssenceRequirementRow {
                affinity: Affinity::Fire,
                amount: 5,
            },
        ],
        min_trust_tier: Some(game_core::TrustTier::Friendly),
        min_quality_time_tier: Some(2),
        min_nutrition_pct: Some(40),
    }
}

/// Every field of the DB row lands on the matching field of the pure
/// `game_core::EvolutionPath`, with `min_level` parsed into the `Level` newtype.
///
/// Kills: a from/to species swap (3 vs 9 are distinct), a dropped `edge_id` (the
/// DURABLE identity — a 0 here would silently orphan the edge), essence
/// entries re-ordered or collapsed, and any of the three Option gates being
/// hardcoded to None (which would make every gate permissive).
#[test]
fn eg1_evolution_path_from_row_round_trips() {
    let row = eg1_evolution_path_row();

    let path = evolution_path_from_row(&row).expect("a valid path row marshals");

    assert_eq!(
        path.edge_id, 77,
        "TEETH(EG1-12): edge_id is the DURABLE edge identity and must carry over; \
         kills an impl that drops it or substitutes path_id (9001)"
    );
    assert_ne!(
        path.edge_id, 9_001,
        "TEETH(EG1-12): edge_id must NEVER be sourced from the DB auto_inc path_id"
    );
    assert_eq!(
        path.from_species, 3,
        "from_species must be 3; kills a from/to swap"
    );
    assert_eq!(
        path.to_species, 9,
        "to_species must be 9; kills a from/to swap"
    );
    assert_eq!(
        path.min_level.as_u8(),
        22,
        "min_level must parse into Level(22)"
    );
    assert_eq!(
        path.essence,
        vec![
            game_core::EssenceRequirement {
                affinity: Affinity::Water,
                amount: 120,
            },
            game_core::EssenceRequirement {
                affinity: Affinity::Fire,
                amount: 5,
            },
        ],
        "TEETH: the essence requirement list must carry over in order, with each \
         (affinity, amount) pair intact; kills a re-sorted, truncated, or \
         affinity-transposed rebuild"
    );
    assert_eq!(
        path.min_trust_tier,
        Some(game_core::TrustTier::Friendly),
        "min_trust_tier must carry over as Some(Friendly); kills a hardcoded None \
         (which would make the Trust gate permissive for every edge)"
    );
    assert_eq!(
        path.min_quality_time_tier,
        Some(2),
        "min_quality_time_tier must carry over as Some(2)"
    );
    assert_eq!(
        path.min_nutrition_pct,
        Some(40),
        "min_nutrition_pct must carry over as Some(40)"
    );
}

/// `min_level` is the `Level` newtype, so a row carrying an out-of-range
/// `min_level: u8` is a loud `Err`, never a panic and never a silently clamped
/// gate.
///
/// Kills: `Level::new(row.min_level).unwrap()` (panics inside a reducer — a WASM
/// trap, not a rejection) and `unwrap_or(Level::new(1))` (silently turns a corrupt
/// row into a level-1 gate that every monster clears).
#[test]
fn eg1_evolution_path_from_row_rejects_level_zero() {
    let mut zero = eg1_evolution_path_row();
    zero.min_level = 0;
    assert!(
        evolution_path_from_row(&zero).is_err(),
        "TEETH: min_level 0 is out of Level's [1,100] range and must be Err"
    );

    let mut too_high = eg1_evolution_path_row();
    too_high.min_level = 101;
    assert!(
        evolution_path_from_row(&too_high).is_err(),
        "TEETH: min_level 101 exceeds Level's [1,100] range and must be Err; \
         kills a lower-bound-only check"
    );

    // Positive sibling: the vacuous always-Err impl must not survive.
    let mut boundary = eg1_evolution_path_row();
    boundary.min_level = 1;
    assert!(
        evolution_path_from_row(&boundary).is_ok(),
        "min_level 1 is the inclusive lower boundary and must marshal Ok — \
         kills a vacuous always-Err impl"
    );
    let mut top = eg1_evolution_path_row();
    top.min_level = 100;
    assert!(
        evolution_path_from_row(&top).is_ok(),
        "min_level 100 is the inclusive upper boundary and must marshal Ok"
    );
}

/// An empty `essence` list marshals to an empty `Vec`, and all three history gates
/// may legitimately be `None` (a plain level-gated edge).
///
/// Kills: an impl that rejects empty essence, or that substitutes a placeholder
/// requirement when the list is empty.
#[test]
fn eg1_evolution_path_from_row_allows_empty_essence_and_no_history_gates() {
    let mut plain = eg1_evolution_path_row();
    plain.essence = vec![];
    plain.min_trust_tier = None;
    plain.min_quality_time_tier = None;
    plain.min_nutrition_pct = None;

    let path = evolution_path_from_row(&plain).expect("a plain level gate marshals");
    assert!(
        path.essence.is_empty(),
        "an empty essence list must stay empty (no placeholder requirement)"
    );
    assert_eq!(
        path.min_trust_tier, None,
        "None must stay None (permissive)"
    );
    assert_eq!(path.min_quality_time_tier, None, "None must stay None");
    assert_eq!(path.min_nutrition_pct, None, "None must stay None");
}

// =========================================================================
// Debloat Phase 3 mutants triage: the marshal decision points no other
// test reached (js-path-parity drives client-wasm movement only and never
// loads server-module).
// =========================================================================

/// `nutrition_pct` is derived from the SUM of all six EV columns. The six EVs
/// are distinct (10..=60, total 210 -> 41%) so dropping, subtracting or
/// multiplying any one term lands on a different percentage.
///
/// kills: any `+` in the EV sum replaced by `-` (underflow or a smaller total)
/// or by `*` (a total past the cap reads 100%).
#[test]
fn pub_from_monster_nutrition_pct_sums_all_six_evs() {
    let mut m = m7b_test_monster_row();
    (m.ev_hp, m.ev_attack, m.ev_defense) = (10, 20, 30);
    (m.ev_speed, m.ev_sp_attack, m.ev_sp_defense) = (40, 50, 60);
    let p = pub_from_monster(&m, 0);
    assert_eq!(p.nutrition_pct, game_core::nutrition_pct_from_ev_total(210));
    assert_eq!(p.nutrition_pct, 41, "210 * 100 / 510, floored");
}

/// `monster_to_instance` maps the boxed sentinel to `None` and a real party
/// slot to `Some(slot)`.
///
/// kills: the sentinel comparison inverted (party monsters read as boxed).
#[test]
fn monster_to_instance_maps_the_party_slot_sentinel() {
    let mut m = m7b_test_monster_row();
    m.party_slot = 2;
    assert_eq!(monster_to_instance(&m).unwrap().party_slot, Some(2));
    m.party_slot = PARTY_SLOT_NONE;
    assert_eq!(monster_to_instance(&m).unwrap().party_slot, None);
}
