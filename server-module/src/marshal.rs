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
#[cfg(test)]
use game_core::SkillDef;
use game_core::{
    derive_stats, roll_individuality, AbilityDef, AbilityStore, BattleMonster, CharacterState, EVs,
    EncounterEntry, EncounterTable, Level, Millis, MonsterInstance, StatBlock, StatKind, TilePos,
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
        last_care_at_ms: 0, // epoch ⇒ cooldown elapsed ⇒ first care allowed (ADR-0059)
        evolves_to: None,
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
    if known_skill_ids.is_empty() {
        return Err(format!(
            "species {} has no known skills after filtering learnable_skill_ids against loaded skills; \
             an empty moveset would panic the AI (defense-in-depth, ADR-0049)",
            species.id
        ));
    }
    Ok(BattleMonster {
        species_id: species.id,
        affinity: species.affinity,
        level,
        current_hp: stats.hp,
        max_hp: stats.hp,
        stats,
        known_skill_ids,
        status: None,
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
        evolves_to: m.evolves_to,
    }
}

/// Marshal a Monster row to a game-core MonsterInstance (M10b evolution/fusion).
/// Trust boundary: rejects illegal level (0 or >100) per Level::new bounds.
pub(crate) fn monster_to_instance(m: &Monster) -> Result<game_core::MonsterInstance, String> {
    let level =
        game_core::Level::new(m.level).map_err(|_| format!("invalid monster level {}", m.level))?;
    let xp = game_core::Xp::new(m.xp);
    let bond = game_core::Bond::new(m.bond);
    let ivs = game_core::IVs::new(
        m.iv_hp,
        m.iv_attack,
        m.iv_defense,
        m.iv_speed,
        m.iv_sp_attack,
        m.iv_sp_defense,
    )
    .map_err(|_| "invalid IVs (not 0..=31)".to_string())?;
    let evs = game_core::EVs::new(
        m.ev_hp,
        m.ev_attack,
        m.ev_defense,
        m.ev_speed,
        m.ev_sp_attack,
        m.ev_sp_defense,
    )
    .map_err(|_| "invalid EVs (not 0..=252, total ≤ 510)".to_string())?;
    let nature = game_core::Nature::new(m.nature_kind);
    let derived_stats = game_core::StatBlock {
        hp: m.stat_hp,
        attack: m.stat_attack,
        defense: m.stat_defense,
        speed: m.stat_speed,
        sp_attack: m.stat_sp_attack,
        sp_defense: m.stat_sp_defense,
    };
    let party_slot = if m.party_slot == crate::PARTY_SLOT_NONE {
        None
    } else {
        Some(m.party_slot)
    };

    Ok(game_core::MonsterInstance {
        species_id: m.species_id,
        nickname: if m.nickname.is_empty() {
            None
        } else {
            Some(m.nickname.clone())
        },
        level,
        xp,
        ivs,
        nature,
        evs,
        bond,
        current_hp: m.current_hp,
        derived_stats,
        party_slot,
    })
}

/// Marshal a SpeciesRow to a game-core Species (M10b evolution/fusion).
pub(crate) fn species_from_row(row: &SpeciesRow) -> Result<game_core::Species, String> {
    Ok(game_core::Species {
        id: row.id,
        name: row.name.clone(),
        base_stats: game_core::StatBlock {
            hp: row.base_hp,
            attack: row.base_attack,
            defense: row.base_defense,
            speed: row.base_speed,
            sp_attack: row.base_sp_attack,
            sp_defense: row.base_sp_defense,
        },
        affinity: row.affinity,
        learnable_skill_ids: row.learnable_skill_ids.clone(),
        ability: row.ability,
    })
}

/// Build an [`AbilityStore`] for a battle from the ability IDs recorded on each
/// slot's species row.
///
/// `side_a_ability_ids` and `side_b_ability_ids` are parallel slices aligned to
/// team slots (index 0 = slot 0, etc.). Each element is the `ability: Option<u32>`
/// column from the matching `SpeciesRow`. Unknown IDs (no matching `AbilityDef`)
/// silently resolve to `None` so a stale or missing def does not crash battle start.
pub(crate) fn build_ability_store(
    side_a_ability_ids: &[Option<u32>],
    side_b_ability_ids: &[Option<u32>],
    ability_defs: &[AbilityDef],
) -> AbilityStore {
    let resolve = |id: Option<u32>| -> Option<game_core::AbilityEffect> {
        let id = id?;
        ability_defs
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.effect.clone())
    };
    AbilityStore {
        side_a: side_a_ability_ids.iter().map(|&id| resolve(id)).collect(),
        side_b: side_b_ability_ids.iter().map(|&id| resolve(id)).collect(),
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
    // Canonical content order: iterate species.learnable_skill_ids and retain
    // only those present in the provided skills slice (mirrors wild_battle_monster,
    // so owned and wild monsters have the same ordering — ADR-0077 12.5e-4).
    let known_skill_ids: Vec<u32> = species
        .learnable_skill_ids
        .iter()
        .copied()
        .filter(|id| skills.iter().any(|s| s.id == *id))
        .collect();
    if known_skill_ids.is_empty() {
        return Err(format!(
            "monster {} (species {}) has no known skills after filtering learnable_skill_ids \
             against loaded skills; an empty moveset would panic the AI (defense-in-depth, ADR-0049)",
            monster.monster_id, species.id
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
        known_skill_ids,
        status: None,
    })
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row,
/// clamped to the ROW's current `stat_hp` (13.5c-3). A mid-battle `sync_content`
/// nerf can lower the row's `stat_hp` while the in-flight BattleMonster still
/// carries the stale pre-nerf `max_hp` — so the clamp target is the ROW's
/// `stat_hp`, NOT `bm.max_hp`. Ordering caveat: this clamp is correct because
/// write-back (battle.rs:614) runs BEFORE the XP/level-up recompute — the
/// level-up heal re-derives stats from the SSOT and uses the post-re-derive
/// `stat_hp` afterwards.
pub(crate) fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp.min(monster.stat_hp);
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

/// Build a `Vec<SkillDef>` from the DB skill rows.
///
/// Production battle paths (submit_attack, swap_active, attempt_recruit) all use
/// `load_skills()` (content cache, ADR-0098 D2). This function is retained for
/// marshal boundary tests (power > 0, accuracy ∈ [1, 100]); it sets
/// `sets_weather: None, applies_status: None` which is intentional for unit tests
/// that exercise the validation logic only.
#[cfg(test)]
pub(crate) fn skill_defs_from_rows(rows: &[SkillRow]) -> Result<Vec<SkillDef>, String> {
    rows.iter()
        .map(|r| {
            if r.power == 0 {
                return Err(format!("skill {} has power=0 at marshal boundary", r.id));
            }
            if r.accuracy == 0 || r.accuracy > 100 {
                return Err(format!(
                    "skill {} has accuracy {} (must be 1..=100) at marshal boundary",
                    r.id, r.accuracy
                ));
            }
            Ok(SkillDef {
                id: r.id,
                name: r.name.clone(),
                affinity: r.affinity,
                power: r.power,
                accuracy: r.accuracy,
                pp: r.pp,
                // DB SkillRow has no sets_weather or applies_status columns; these are
                // only populated via load_skills() (content cache). All battle-resolution
                // paths (submit_attack, swap_active, attempt_recruit) now use load_skills()
                // directly (ADR-0098 D2). skill_defs_from_rows is used only for schema
                // validation and marshal tests where sets_weather/applies_status are not needed.
                sets_weather: None,
                applies_status: None,
            })
        })
        .collect()
}

/// Build the type chart from DB rows.
///
/// Trust boundary (ADR-0049): re-validates `effectiveness ∈ {0, 5, 10, 20}` —
/// the seed-time constraint from `validate_content`. An out-of-range value would
/// scale damage by the raw number (`TypeChart::effectiveness` returns it verbatim)
/// while `classify` silently maps it to `Neutral`.
pub(crate) fn type_chart_from_rows(
    rows: impl Iterator<Item = TypeRelationRow>,
) -> Result<TypeChart, String> {
    let mut rels: Vec<game_core::TypeRelation> = Vec::new();
    for r in rows {
        if !matches!(r.effectiveness, 0 | 5 | 10 | 20) {
            return Err(format!(
                "type relation ({:?},{:?}) has illegal effectiveness {} (must be 0, 5, 10, or 20)",
                r.attacker, r.defender, r.effectiveness
            ));
        }
        rels.push(game_core::TypeRelation {
            attacker: r.attacker,
            defender: r.defender,
            effectiveness: r.effectiveness,
        });
    }
    Ok(game_core::TypeChart::new(&rels))
}

#[cfg(test)]
#[path = "marshal_tests.rs"]
mod marshal_tests;
