//! `marshal` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Row <-> `game-core` domain marshaling helpers (and `now_ms`, the platform
//! timestamp -> `game_core::Millis` i64 marshal). Intentionally repetitive — DRY
//! does not cross the marshaling boundary. These are pure (no DB I/O); `now_ms`
//! reads only `ctx.timestamp`.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::schema::{
    Character, EncounterEntryRow, EncounterRow, Monster, MonsterPub, SkillRow, SpeciesRow,
    TypeRelationRow,
};
use game_core::{
    derive_stats, roll_individuality, BattleMonster, CharacterState, EVs, EncounterEntry,
    EncounterTable, Level, Millis, MonsterInstance, SkillDef, StatBlock, StatKind, TilePos,
    TypeChart,
};
use spacetimedb::{Identity, ReducerContext};

pub(crate) fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000
}

// `convert` seam: flatten `game-core::CharacterState` <-> `character` columns. The
// shared type stays the SSOT while the table stays queryable. Intentionally
// repetitive — DRY does not cross the marshaling boundary.
pub(crate) fn char_state(row: &Character) -> CharacterState {
    CharacterState {
        pos: TilePos {
            x: row.tile_x,
            y: row.tile_y,
        },
        facing: row.facing,
        action: row.action,
        move_started_at: Millis(row.move_started_at_ms),
    }
}

pub(crate) fn apply_state(row: &mut Character, next: &CharacterState) {
    row.tile_x = next.pos.x;
    row.tile_y = next.pos.y;
    row.facing = next.facing;
    row.action = next.action;
    row.move_started_at_ms = next.move_started_at.0;
}

// `convert` seam: flatten `game-core::MonsterInstance` -> `Monster` table row.
// Intentionally repetitive — DRY does not cross the marshaling boundary.
pub(crate) fn monster_from_instance(
    owner: Identity,
    inst: &MonsterInstance,
    party_slot: u8,
) -> Monster {
    Monster {
        monster_id: 0, // auto_inc
        owner_identity: owner,
        species_id: inst.species_id,
        nickname: inst.nickname.clone().unwrap_or_default(),
        level: inst.level.as_u8(),
        xp: inst.xp.value(),
        bond: inst.bond.value(),
        iv_hp: inst.ivs.get(StatKind::Hp),
        iv_attack: inst.ivs.get(StatKind::Attack),
        iv_defense: inst.ivs.get(StatKind::Defense),
        iv_speed: inst.ivs.get(StatKind::Speed),
        iv_sp_attack: inst.ivs.get(StatKind::SpAttack),
        iv_sp_defense: inst.ivs.get(StatKind::SpDefense),
        nature_kind: inst.nature.kind(),
        ev_hp: inst.evs.get(StatKind::Hp),
        ev_attack: inst.evs.get(StatKind::Attack),
        ev_defense: inst.evs.get(StatKind::Defense),
        ev_speed: inst.evs.get(StatKind::Speed),
        ev_sp_attack: inst.evs.get(StatKind::SpAttack),
        ev_sp_defense: inst.evs.get(StatKind::SpDefense),
        stat_hp: inst.derived_stats.hp,
        stat_attack: inst.derived_stats.attack,
        stat_defense: inst.derived_stats.defense,
        stat_speed: inst.derived_stats.speed,
        stat_sp_attack: inst.derived_stats.sp_attack,
        stat_sp_defense: inst.derived_stats.sp_defense,
        current_hp: inst.current_hp,
        party_slot,
    }
}

// `convert` seam: flatten `game-core::EncounterTable` -> private `EncounterRow`.
// No `ctx` — pure marshaling. `Level` flattens to `u8` (like `Millis` -> `i64`).
pub(crate) fn encounter_rows_from_table(table: &game_core::EncounterTable) -> EncounterRow {
    EncounterRow {
        zone_id: table.zone_id,
        encounter_rate: table.encounter_rate,
        entries: table
            .entries
            .iter()
            .map(|e| EncounterEntryRow {
                species_id: e.species_id,
                weight: e.weight,
                min_level: e.min_level.as_u8(),
                max_level: e.max_level.as_u8(),
            })
            .collect(),
    }
}

// `convert` seam: inverse of `encounter_rows_from_table` — rebuild the pure
// `game_core::EncounterTable` from the private `EncounterRow` so the grass/manual
// paths can call `resolve_encounter` (the SSOT trigger decision). Pure, no `ctx`.
pub(crate) fn table_from_encounter_row(row: &EncounterRow) -> Result<EncounterTable, String> {
    let mut entries = Vec::with_capacity(row.entries.len());
    for e in &row.entries {
        entries.push(EncounterEntry {
            species_id: e.species_id,
            weight: e.weight,
            min_level: Level::new(e.min_level)?,
            max_level: Level::new(e.max_level)?,
        });
    }
    Ok(EncounterTable {
        zone_id: row.zone_id,
        encounter_rate: row.encounter_rate,
        entries,
    })
}

/// Build a wild `BattleMonster` (no owned `monster` row) from a species, the
/// server-loaded skill ids, a level, and the individuality seed (M8c, ADR-0045).
/// PURE / deterministic in `seed` — no `ctx`. Full-HP, EVs zero; IVs+nature come
/// from `roll_individuality(seed)` and stats from `derive_stats`, so the stored
/// seed rebuilds THIS exact wild in M8d. `known_skill_ids` = the species'
/// `learnable_skill_ids` intersected with `skill_ids`, iterated in learnable order
/// (so `[1,2,3] ∩ [2,3,9] == [2,3]`). An out-of-range `level` is a loud `Err`,
/// never a panic.
pub(crate) fn wild_battle_monster(
    species: &SpeciesRow,
    skill_ids: &[u32],
    level: u8,
    seed: u32,
) -> Result<BattleMonster, String> {
    let lvl = Level::new(level)?;
    let (ivs, nature) = roll_individuality(seed);
    let evs = EVs::zero();
    let base = StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    let stats = derive_stats(&base, &ivs, &evs, &nature, lvl);
    let known_skill_ids: Vec<u32> = species
        .learnable_skill_ids
        .iter()
        .copied()
        .filter(|id| skill_ids.contains(id))
        .collect();
    Ok(BattleMonster {
        species_id: species.id,
        affinity: species.affinity,
        level,
        current_hp: stats.hp,
        max_hp: stats.hp,
        stats,
        known_skill_ids,
    })
}

/// Derive the public projection from a private monster row. No hidden fields.
pub(crate) fn pub_from_monster(m: &Monster) -> MonsterPub {
    MonsterPub {
        monster_id: m.monster_id,
        owner_identity: m.owner_identity,
        species_id: m.species_id,
        nickname: m.nickname.clone(),
        level: m.level,
        xp: m.xp,
        bond: m.bond,
        current_hp: m.current_hp,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        party_slot: m.party_slot,
    }
}

// --- Battle helpers (M7b, pure marshaling — no ctx) ---------------------------

/// Marshal a Monster row + its species + its known skills into a BattleMonster.
///
/// Trust boundary (ADR-0049, reject-not-clamp): a row with `stat_defense == 0`
/// is rejected with `Err` rather than passed into the pure core, where it would
/// divide-by-zero in `calc_damage`.
pub(crate) fn battle_monster_from_row(
    monster: &Monster,
    species: &SpeciesRow,
    skills: &[SkillRow],
) -> Result<BattleMonster, String> {
    if monster.stat_defense == 0 {
        return Err(format!(
            "monster {} has stat_defense 0 (illegal: would divide-by-zero in calc_damage)",
            monster.monster_id
        ));
    }
    Ok(BattleMonster {
        species_id: monster.species_id,
        affinity: species.affinity,
        level: monster.level,
        current_hp: monster.current_hp,
        max_hp: monster.stat_hp,
        stats: StatBlock {
            hp: monster.stat_hp,
            attack: monster.stat_attack,
            defense: monster.stat_defense,
            speed: monster.stat_speed,
            sp_attack: monster.stat_sp_attack,
            sp_defense: monster.stat_sp_defense,
        },
        known_skill_ids: skills.iter().map(|s| s.id).collect(),
    })
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row.
pub(crate) fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp;
}

/// Sum the six base stats of a species (for the XP formula).
///
/// Pure marshaling (ADR-0049): the base-stat-total definition is owned by the
/// rule layer (`game_core::base_stat_total`, SSOT). This shell only builds a
/// `StatBlock` from the species row's six `base_*` columns and delegates.
pub(crate) fn loser_base_stat_total(species: &SpeciesRow) -> u16 {
    let base = game_core::StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    game_core::base_stat_total(&base)
}

/// Build a `Vec<SkillDef>` from the DB skill rows for the resolver.
pub(crate) fn skill_defs_from_rows(rows: &[SkillRow]) -> Vec<SkillDef> {
    rows.iter()
        .map(|r| SkillDef {
            id: r.id,
            name: r.name.clone(),
            affinity: r.affinity,
            power: r.power,
            accuracy: r.accuracy,
            pp: r.pp,
        })
        .collect()
}

/// Build the type chart from DB rows.
pub(crate) fn type_chart_from_rows(rows: impl Iterator<Item = TypeRelationRow>) -> TypeChart {
    let rels: Vec<game_core::TypeRelation> = rows
        .map(|r| game_core::TypeRelation {
            attacker: r.attacker,
            defender: r.defender,
            effectiveness: r.effectiveness,
        })
        .collect();
    game_core::TypeChart::new(&rels)
}

#[cfg(test)]
#[path = "marshal_tests.rs"]
mod marshal_tests;
