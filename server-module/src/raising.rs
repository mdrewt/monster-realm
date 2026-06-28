//! `raising` — server-module domain submodule (M8.9, ADR-0056 / ADR-0059).
//!
//! The M9b raising shell: the `care` reducer (itemless bond raise, server-
//! authoritative per-monster cooldown). It is THIN — find the monster, check
//! ownership, run the pure decision seam `evaluate_care` (which delegates the bond
//! arithmetic to the SSOT `game_core::apply_care` and then gates on the cooldown),
//! and only on `Ok` mutate + dual-write `monster` / `monster_pub`. No DB write
//! occurs before the success path, so a rejected `care` can never burn the
//! cooldown or mutate bond (the reducer transaction rolls back on any `Err`).
//!
//! `train` (focus-training food spend) is parked as M9b-tail — it forces edits
//! outside this slice's server touch-set (game-core content + a public `ItemRow`
//! column). See ADR-0059 §4.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::require_owner;
use crate::inventory::consume_one;
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{item_row, monster, monster_pub, species_row};
use game_core::{
    apply_care, focus_train, Bond, EVs, FocusTrainError, FocusTrainResult, IVs, Level, Nature,
    StatBlock, StatKind,
};
use spacetimedb::ReducerContext;

/// Fixed bond raise per successful `care` (tunable policy the reducer supplies to
/// the pure rule; ADR-0058 §residual(c) / ADR-0059 §3). Initial tuning is a
/// playtest call (spec §6 "bond curve … tunable"), not a contract.
pub(crate) const CARE_BOND_AMOUNT: u8 = 5;
/// Per-monster care cooldown (6h). Documented as playtest-tunable (spec §6).
pub(crate) const CARE_COOLDOWN_MS: i64 = 6 * 60 * 60 * 1000;

/// Pure decision seam (testable without a DB): apply the SSOT bond rule FIRST
/// (so `AtMaxBond` / `NoEffect` reject before the cooldown is consulted — the
/// order matches ADR-0058 §3 / ADR-0059 §3), THEN gate on the cooldown. Returns
/// the new bond value, or `Err` if the action is rejected.
///
/// The cooldown comparison is strict `<` (elapsed == `CARE_COOLDOWN_MS` is
/// ALLOWED), and the elapsed is `now.saturating_sub(last_care_at_ms)` so a
/// future/zero clock can only OVER-reject, never wrap into a bypass.
///
/// The `now` parameter is the server clock ms (the caller passes `now_ms(ctx)`);
/// it is named `now` — NOT `now_ms` — to avoid shadowing the module-level
/// `now_ms` helper inside this body (red-team F2, least-surprise).
pub(crate) fn evaluate_care(bond: u8, last_care_at_ms: i64, now: i64) -> Result<u8, String> {
    let new_bond = apply_care(Bond::new(bond), CARE_BOND_AMOUNT).map_err(|e| format!("{e:?}"))?;
    if now.saturating_sub(last_care_at_ms) < CARE_COOLDOWN_MS {
        return Err("care cooldown not yet elapsed".to_string());
    }
    Ok(new_bond.value())
}

/// Raise a monster's bond, gated by a per-monster cooldown measured from the
/// server clock (`ctx.timestamp`, never a client argument). Ownership-checked;
/// dual-writes the private `monster` row and its public `monster_pub` projection.
/// No DB write before the success path — a reject (not found, not owner, max bond,
/// within cooldown) never burns the cooldown (ADR-0059 §3, reject-never-burns).
#[spacetimedb::reducer]
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    require_owner(ctx, "care", m.owner_identity)?;
    let now = now_ms(ctx);
    let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)?;
    m.bond = new_bond;
    m.last_care_at_ms = now;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

/// Pure decision seam (DB-free, unit-testable; mirrors `evaluate_care`): reject
/// an item that is not a training food, else delegate the EV top-off + re-derive
/// to the SSOT `focus_train` (ADR-0058). No EV/stat math here.
pub(crate) fn evaluate_train(
    base: &StatBlock,
    ivs: &IVs,
    evs: &EVs,
    nature: &Nature,
    level: Level,
    train_stat: Option<StatKind>,
    train_amount: u16,
) -> Result<FocusTrainResult, String> {
    let Some(target) = train_stat else {
        return Err("item is not a training food".to_string());
    };
    focus_train(base, ivs, evs, nature, level, target, train_amount).map_err(|e| match e {
        FocusTrainError::StatAtCap => "target stat is already at its EV cap".to_string(),
        FocusTrainError::BudgetExhausted => "monster's EV budget is exhausted".to_string(),
        FocusTrainError::NoEffect => "training food grants no effect".to_string(),
    })
}

/// Spend a training food to grant EVs toward its target stat and re-derive the
/// monster's stats (server-authoritative, reject-not-clamp). The fallible
/// decision (`evaluate_train`) runs BEFORE the irreversible spend (`consume_one`),
/// so a rejected train (not a food / stat at cap / budget exhausted / monster
/// not owned / food not owned) rolls the whole txn back with the food intact
/// (reject-never-burns, ADR-0058/0059). `current_hp` is NOT written: EVs are
/// monotone-up so `stat_hp` only grows ⇒ `current_hp ≤ stat_hp` holds; training
/// is not a heal (ADR-0058 residual (a) resolved).
#[spacetimedb::reducer]
pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    require_owner(ctx, "train", m.owner_identity)?;

    let Some(item) = ctx.db.item_row().id().find(food_item_id) else {
        return Err("item not found".to_string());
    };
    let Some(species) = ctx.db.species_row().id().find(m.species_id) else {
        return Err(format!("species {} not found", m.species_id));
    };

    // Reconstruct game-core inputs from the row (parse-don't-validate: a corrupt
    // row is a loud Err, never a panic). Mirrors the battle.rs level-up path.
    let base = StatBlock {
        hp: species.base_hp,
        attack: species.base_attack,
        defense: species.base_defense,
        speed: species.base_speed,
        sp_attack: species.base_sp_attack,
        sp_defense: species.base_sp_defense,
    };
    let ivs = IVs::new(
        m.iv_hp,
        m.iv_attack,
        m.iv_defense,
        m.iv_speed,
        m.iv_sp_attack,
        m.iv_sp_defense,
    )?;
    let evs = EVs::new(
        m.ev_hp,
        m.ev_attack,
        m.ev_defense,
        m.ev_speed,
        m.ev_sp_attack,
        m.ev_sp_defense,
    )?;
    let nature = Nature::new(m.nature_kind);
    let level = Level::new(m.level)?;

    // DECISION before SPEND (reject-never-burns).
    let result = evaluate_train(
        &base,
        &ivs,
        &evs,
        &nature,
        level,
        item.train_stat,
        item.train_amount,
    )?;

    // Irreversible spend of the caller's OWN food (consume_one filters by owner).
    consume_one(ctx, ctx.sender, food_item_id)?;

    // Write back topped-off EVs + re-derived stats. current_hp UNCHANGED.
    m.ev_hp = result.evs.get(StatKind::Hp);
    m.ev_attack = result.evs.get(StatKind::Attack);
    m.ev_defense = result.evs.get(StatKind::Defense);
    m.ev_speed = result.evs.get(StatKind::Speed);
    m.ev_sp_attack = result.evs.get(StatKind::SpAttack);
    m.ev_sp_defense = result.evs.get(StatKind::SpDefense);
    m.stat_hp = result.derived_stats.hp;
    m.stat_attack = result.derived_stats.attack;
    m.stat_defense = result.derived_stats.defense;
    m.stat_speed = result.derived_stats.speed;
    m.stat_sp_attack = result.derived_stats.sp_attack;
    m.stat_sp_defense = result.derived_stats.sp_defense;

    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

#[cfg(test)]
#[path = "raising_tests.rs"]
mod raising_tests;
