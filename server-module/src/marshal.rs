//! `marshal` — server-module domain submodule.
//!
//! Row <-> `game-core` domain marshaling helpers (and `now_ms`, the platform
//! timestamp -> `game_core::Millis` i64 marshal). Intentionally repetitive — DRY
//! does not cross the marshaling boundary. These are pure (no DB I/O); `now_ms`
//! reads only `ctx.timestamp`.

use crate::schema::{
    Character, EncounterEntryRow, EncounterRow, EvolutionPathRow, Monster, MonsterPub, SpeciesRow,
};
use game_core::{
    Affinity, BattleMonster, CharacterState, EncounterEntry, EncounterTable, Level, Millis,
    MonsterInstance, StatKind, TilePos,
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
        last_care_at_ms: 0, // epoch ⇒ cooldown elapsed ⇒ first care allowed
        // The 8 essence pools flatten from the instance array in
        // Affinity::ALL order (each named column reads its own affinity index).
        essence_fire: inst.essence[Affinity::Fire.index()],
        essence_water: inst.essence[Affinity::Water.index()],
        essence_plant: inst.essence[Affinity::Plant.index()],
        essence_electric: inst.essence[Affinity::Electric.index()],
        essence_earth: inst.essence[Affinity::Earth.index()],
        essence_wind: inst.essence[Affinity::Wind.index()],
        essence_light: inst.essence[Affinity::Light.index()],
        essence_dark: inst.essence[Affinity::Dark.index()],
        trust_favorable_count: inst.trust_favorable_count,
        trust_unfavorable_count: inst.trust_unfavorable_count,
        // Server-only columns (no MonsterInstance counterpart): 0 at creation —
        // epoch anchors and empty accumulators (never seeded from now_ms,
        // which would put a brand-new monster on cooldown).
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: inst.quality_time_ticks_total,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
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
/// Derive the public projection from a private monster row. No hidden fields.
///
/// `tier` comes from the CALLER — fresh from the species row at the 4
/// creation/transform sites, copied forward from the existing `monster_pub` row
/// everywhere else (never fabricated; a missing row is the caller's fail-loud
/// problem). The three history tiers are DERIVED here from the
/// private counters via the game-core SSOT helpers — pure and infallible.
/// The care cooldown anchor (`last_care_at_ms`, qf-3) is COPIED verbatim:
/// every mirror site builds its projection here, so the owner-visible anchor
/// can never drift from the private one the `care` reducer checks.
pub(crate) fn pub_from_monster(m: &Monster, tier: u8) -> MonsterPub {
    // Sum the six EV columns in u32 (cannot overflow: 6 * 65535 << u32::MAX),
    // then clamp into the u16 the SSOT helper takes — a corrupt row saturates
    // instead of panicking (the helper caps at 100% far below u16::MAX anyway).
    let ev_total_u32 = u32::from(m.ev_hp)
        + u32::from(m.ev_attack)
        + u32::from(m.ev_defense)
        + u32::from(m.ev_speed)
        + u32::from(m.ev_sp_attack)
        + u32::from(m.ev_sp_defense);
    let ev_total = u16::try_from(ev_total_u32).unwrap_or(u16::MAX);
    MonsterPub {
        monster_id: m.monster_id,
        owner_identity: m.owner_identity,
        species_id: m.species_id,
        nickname: m.nickname.clone(),
        level: m.level,
        xp: m.xp,
        current_hp: m.current_hp,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        party_slot: m.party_slot,
        tier,
        essence_fire: m.essence_fire,
        essence_water: m.essence_water,
        essence_plant: m.essence_plant,
        essence_electric: m.essence_electric,
        essence_earth: m.essence_earth,
        essence_wind: m.essence_wind,
        essence_light: m.essence_light,
        essence_dark: m.essence_dark,
        trust_tier: game_core::trust_tier_of(m.trust_favorable_count, m.trust_unfavorable_count),
        quality_time_tier: game_core::quality_time_tier_of(m.quality_time_ticks_total),
        nutrition_pct: game_core::nutrition_pct_from_ev_total(ev_total),
        last_care_at_ms: m.last_care_at_ms,
    }
}

/// Marshal a Monster row to a game-core MonsterInstance.
/// Trust boundary: rejects illegal level (0 or >100) per Level::new
/// bounds. The server-only Quality-Time/Trust bookkeeping columns stay behind
/// (no instance counterpart).
pub(crate) fn monster_to_instance(m: &Monster) -> Result<game_core::MonsterInstance, String> {
    let level =
        game_core::Level::new(m.level).map_err(|_| format!("invalid monster level {}", m.level))?;
    let xp = game_core::Xp::new(m.xp);
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
    // Rebuild the essence array from the 8 named columns, each landing at
    // its own Affinity::index() slot (the inverse of monster_from_instance).
    let mut essence = [0u32; 8];
    essence[Affinity::Fire.index()] = m.essence_fire;
    essence[Affinity::Water.index()] = m.essence_water;
    essence[Affinity::Plant.index()] = m.essence_plant;
    essence[Affinity::Electric.index()] = m.essence_electric;
    essence[Affinity::Earth.index()] = m.essence_earth;
    essence[Affinity::Wind.index()] = m.essence_wind;
    essence[Affinity::Light.index()] = m.essence_light;
    essence[Affinity::Dark.index()] = m.essence_dark;

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
        essence,
        trust_favorable_count: m.trust_favorable_count,
        trust_unfavorable_count: m.trust_unfavorable_count,
        quality_time_ticks_total: m.quality_time_ticks_total,
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
        tier: row.tier,
    })
}

/// Marshal a public `evolution_path` row to the pure `game_core::EvolutionPath`
/// content struct. Parse-don't-validate: `min_level` goes through
/// the `Level` newtype, so a corrupt row is a loud `Err`, never a panic and
/// never a silently clamped gate.
pub(crate) fn evolution_path_from_row(
    row: &EvolutionPathRow,
) -> Result<game_core::EvolutionPath, String> {
    let min_level = Level::new(row.min_level).map_err(|e| {
        format!(
            "evolution path edge {}: invalid min_level: {e}",
            row.edge_id
        )
    })?;
    Ok(game_core::EvolutionPath {
        edge_id: row.edge_id,
        from_species: row.from_species,
        to_species: row.to_species,
        min_level,
        essence: row
            .essence
            .iter()
            .map(|e| game_core::EssenceRequirement {
                affinity: e.affinity,
                amount: e.amount,
            })
            .collect(),
        min_trust_tier: row.min_trust_tier,
        min_quality_time_tier: row.min_quality_time_tier,
        min_nutrition_pct: row.min_nutrition_pct,
    })
}

/// Write post-battle HP back from a BattleMonster to the persistent Monster row,
/// clamped to the ROW's current `stat_hp`. A mid-battle `sync_content`
/// nerf can lower the row's `stat_hp` while the in-flight BattleMonster still
/// carries the stale pre-nerf `max_hp` — so the clamp target is the ROW's
/// `stat_hp`, NOT `bm.max_hp`. Ordering caveat: this clamp is correct because
/// write-back (`battle::write_back_party_hp`) runs BEFORE the XP/level-up recompute — the
/// level-up heal re-derives stats from the SSOT and uses the post-re-derive
/// `stat_hp` afterwards.
pub(crate) fn write_back_hp(monster: &mut Monster, bm: &BattleMonster) {
    monster.current_hp = bm.current_hp.min(monster.stat_hp);
}

/// Sum the six base stats of a species (for the XP formula).
///
/// Pure marshaling: the base-stat-total definition is owned by the
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

#[cfg(test)]
#[path = "marshal_tests.rs"]
mod marshal_tests;
