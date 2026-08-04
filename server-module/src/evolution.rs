//! `evolution` — server-module domain submodule (EG1 rewrite, ADR-0174).
//!
//! ONE reducer: `evolve(ctx, monster_id, to_species)` — the write path of the
//! essence-graph evolution model. It is a ctx/DB shell only: the gate DECISION
//! is `game_core::path_satisfied` and the requirement NAMING is
//! `game_core::unmet_requirement`; nothing in this file reads a gate field
//! (EG1-11 source scan, whole production region). Fusion is deleted as a
//! feature (EG1-9); the `Fusion` TABLE struct stays in schema.rs until
//! Migration B, but no code here references it.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::{reject_if_in_battle, reject_if_monster_in_trade, require_owner};
use crate::marshal::{
    evolution_path_from_row, monster_to_instance, pub_from_monster, species_from_row,
};
use crate::schema::{battle, evolution_path, monster, monster_pub, species_row, trade_offer};
use game_core::Affinity;
use spacetimedb::ReducerContext;

/// Evolve a monster along one authored evolution-graph edge (EG2-1 shape).
///
/// Steps:
/// 1. Look up the Monster row (loud reject if not found)
/// 2. require_owner -> both-role battle guard (ADR-0122) -> trade escrow guard
/// 3. ONE targeted `evolution_path` lookup keyed on BOTH endpoints (btree on
///    from_species, then compare to_species) — a client-supplied `to_species`
///    can never cross-apply a foreign edge
/// 4. Marshal to the pure instance + path, gate via the SHARED predicate
/// 5. FRESH target-species lookup (the MonsterPub.tier source, EG1-8)
/// 6. `game_core::evolve` transform (re-derives stats, clamps HP, zeroes all 8
///    essence pools — ADR-0174 D2); Trust/Quality-Time survive untouched
/// 7. Dual-write Monster + MonsterPub (ADR-0015 discipline)
#[spacetimedb::reducer]
pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };

    require_owner(ctx, "evolve", m.owner_identity)?;
    // Both-role battle guard (ADR-0122): chain the opponent_identity iterator so
    // a monster whose owner sits on side B of an ongoing PvP battle is caught —
    // mirrors the m16.5a trading.rs chain shape (ADR-0112 D1/D2).
    reject_if_in_battle(
        ctx.db
            .battle()
            .player_identity()
            .filter(m.owner_identity)
            .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
        monster_id,
    )?;
    // Trade escrow guard (TR-2, ADR-0106): monster in an active offer cannot be evolved.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;

    // EG2-1: the ONE targeted row, keyed on BOTH endpoints. R1 guarantees at
    // most one (from, to) edge; an empty table (the pre-EG3 state) or a foreign
    // edge both land here as a clean rejection.
    let Some(path_row) = ctx
        .db
        .evolution_path()
        .from_species()
        .filter(m.species_id)
        .find(|p| p.to_species == to_species)
    else {
        return Err(format!(
            "no such evolution: species {} has no path to species {to_species}",
            m.species_id
        ));
    };
    let path = evolution_path_from_row(&path_row)?;
    let instance = monster_to_instance(&m)?;

    // The SHARED gate predicate decides (EG1-11); the game-core describer only
    // turns a failure into a player-facing sentence.
    if !game_core::path_satisfied(&instance, &path) {
        return Err(game_core::unmet_requirement(&instance, &path)
            .unwrap_or_else(|| "evolution requirements not met".to_string()));
    }

    // FRESH target-species lookup — the MonsterPub.tier source (EG1-8) and the
    // transform's base stats both come from it.
    let Some(to_species_row) = ctx.db.species_row().id().find(to_species) else {
        return Err(format!("target species {to_species} not found"));
    };
    let target = species_from_row(&to_species_row)?;

    // Pure transform: carries individuality, re-derives stats from the TARGET
    // base stats, clamps current_hp, zeroes all 8 essence pools (ADR-0174 D2).
    let transformed = game_core::evolve(&instance, &target);

    m.species_id = transformed.species_id;
    m.level = transformed.level.as_u8();
    m.xp = transformed.xp.value();
    m.stat_hp = transformed.derived_stats.hp;
    m.stat_attack = transformed.derived_stats.attack;
    m.stat_defense = transformed.derived_stats.defense;
    m.stat_speed = transformed.derived_stats.speed;
    m.stat_sp_attack = transformed.derived_stats.sp_attack;
    m.stat_sp_defense = transformed.derived_stats.sp_defense;
    m.current_hp = transformed.current_hp;
    m.essence_fire = transformed.essence[Affinity::Fire.index()];
    m.essence_water = transformed.essence[Affinity::Water.index()];
    m.essence_plant = transformed.essence[Affinity::Plant.index()];
    m.essence_electric = transformed.essence[Affinity::Electric.index()];
    m.essence_earth = transformed.essence[Affinity::Earth.index()];
    m.essence_wind = transformed.essence[Affinity::Wind.index()];
    m.essence_light = transformed.essence[Affinity::Light.index()];
    m.essence_dark = transformed.essence[Affinity::Dark.index()];
    // Trust and Quality-Time are lifetime history — untouched on purpose, as
    // are the server-only bookkeeping columns. `evolves_to` stays frozen too
    // (dead column until Migration B, ADR-0174 D2).

    // Dual-write, with the tier read fresh from the TARGET species row.
    let pub_row = pub_from_monster(&m, to_species_row.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);

    Ok(())
}

#[cfg(test)]
#[path = "evolution_tests.rs"]
mod evolution_tests;
