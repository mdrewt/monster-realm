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
//! `train` (focus-training food spend) is implemented in the same file (M9b-tail,
//! ADR-0059): pure `evaluate_train` seam → SSOT `focus_train`; decision-before-
//! `consume_one` so a rejected train never burns the food item.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::economy::{spend_currency, wallet_balance};
use crate::guards::{
    escrowed_currency_amount, escrowed_item_qty, is_in_ongoing_battle, reject_if_monster_in_trade,
    require_owner, saturating_sub_u64,
};
use crate::inventory::consume_one;
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{
    character, heal_cooldown, heal_location_row, inventory, item_row, monster, monster_pub, player,
    species_row, trade_offer, HealCooldown,
};
use game_core::{
    apply_care, focus_train, is_cooldown_ready, Bond, EVs, FocusTrainError, FocusTrainResult, IVs,
    Level, Nature, StatBlock, StatKind,
};
// SSOT (ptc5e-1): the CARE policy magnitudes now live in game-core beside
// `apply_care`. Re-exported `pub(crate)` — and ONLY these two names, not the
// whole `game_core` import above — so the `#[path]`-attached `raising_tests.rs`
// child mod reaches them through `use super::*` without an ambiguous-glob clash
// with its own explicit `use game_core::{EVs, IVs, ...}` imports.
pub(crate) use game_core::{CARE_BOND_AMOUNT, CARE_COOLDOWN_MS};
use spacetimedb::{ReducerContext, Table};

/// Pure decision seam (testable without a DB): apply the SSOT bond rule FIRST
/// (so `AtMaxBond` / `NoEffect` reject before the cooldown is consulted — the
/// order matches ADR-0058 §3 / ADR-0059 §3), THEN gate on the cooldown. Returns
/// the new bond value, or `Err` if the action is rejected.
///
/// The cooldown gate delegates to the SSOT `game_core::is_cooldown_ready`
/// (ptc5e-1): ready ⟺ `now - last >= CARE_COOLDOWN_MS`, so elapsed ==
/// `CARE_COOLDOWN_MS` is ALLOWED and the `saturating_sub` elapsed means a
/// future/zero clock can only OVER-reject, never wrap into a bypass. This is the
/// exact dual of the prior in-line strict-`<` reject — behavior is unchanged.
///
/// The `now` parameter is the server clock ms (the caller passes `now_ms(ctx)`);
/// it is named `now` — NOT `now_ms` — to avoid shadowing the module-level
/// `now_ms` helper inside this body (red-team F2, least-surprise).
pub(crate) fn evaluate_care(bond: u8, last_care_at_ms: i64, now: i64) -> Result<u8, String> {
    let new_bond = apply_care(Bond::new(bond), CARE_BOND_AMOUNT).map_err(|e| format!("{e:?}"))?;
    if !is_cooldown_ready(last_care_at_ms, now, CARE_COOLDOWN_MS) {
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
    // Both-role ongoing-battle guard (ADR-0136 amends ADR-0122 §D7): a caller
    // who is mid-battle (side A of a wild/PvE battle OR side B of a PvP battle)
    // cannot care — closes the bounded mid-battle HP-laundering path where a
    // live-EV bump would fold extra HP into the level-up heal. Reuses the SSOT
    // is_in_ongoing_battle helper (WILD_IDENTITY-refined), same as heal_party.
    if is_in_ongoing_battle(ctx, ctx.sender) {
        return Err("cannot care during an ongoing battle".to_string());
    }
    // Trade escrow guard (TR-6, ADR-0106).
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    let now = now_ms(ctx);
    let new_bond = evaluate_care(m.bond, m.last_care_at_ms, now)?;
    m.bond = new_bond;
    m.last_care_at_ms = now;
    // Recompute evolves_to after bond change from care (12.5b-4, ADR-0073, cached ADR-0089).
    // fail-loud on parse error — silently zeroing evolves_to would mask content issues.
    let all_evolutions = crate::content_cache::cached_evolutions()
        .map_err(|e| format!("care: load_evolutions failed: {e}"))?;
    let monster_evolutions = all_evolutions
        .iter()
        .find(|se| se.species_id == m.species_id)
        .map(|se| &se.evolutions[..])
        .unwrap_or(&[]);
    m.evolves_to = crate::evolution::compute_evolves_to(monster_evolutions, m.level, m.bond);
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
    // Both-role ongoing-battle guard (ADR-0136 amends ADR-0122 §D7): a caller
    // who is mid-battle cannot train — a mid-battle EV bump would inflate the
    // in-battle level-up heal (the HP-laundering vector). Reuses the SSOT
    // is_in_ongoing_battle helper (WILD_IDENTITY-refined), same as heal_party.
    if is_in_ongoing_battle(ctx, ctx.sender) {
        return Err("cannot train during an ongoing battle".to_string());
    }
    // Trade escrow guards (TR-7, ADR-0106): monster and food item must be free.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    // Item escrow: reject if consuming this item would breach the escrowed reserve.
    {
        let escrowed = escrowed_item_qty(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(m.owner_identity)
                .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
            m.owner_identity,
            food_item_id,
        );
        let count = ctx
            .db
            .inventory()
            .owner_identity()
            .filter(m.owner_identity)
            .find(|r| r.item_id == food_item_id)
            .map(|r| r.count)
            .unwrap_or(0);
        if escrowed >= count {
            return Err("item is in an active trade".to_string());
        }
    }

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

/// Minimum ms between heals (used by raising_tests.rs; heal_party uses loc.cooldown_ms).
#[cfg(test)]
pub(crate) const HEAL_COOLDOWN_MS: i64 = 30_000;

/// Pure cooldown seam (testable without DB). Delegates the elapsed check to the
/// SSOT `game_core::is_cooldown_ready` (ptc5e-1) — the SAME predicate `care` uses
/// — instead of open-coding a second `saturating_sub`/`<` copy. Ready ⟺ elapsed
/// `>= cooldown_ms` (elapsed == cooldown_ms is allowed); saturating so a future
/// clock can only over-reject, never bypass the cooldown.
pub(crate) fn evaluate_heal(
    last_heal_at_ms: i64,
    now: i64,
    cooldown_ms: i64,
) -> Result<(), String> {
    if !is_cooldown_ready(last_heal_at_ms, now, cooldown_ms) {
        return Err("heal cooldown not yet elapsed".to_string());
    }
    Ok(())
}

/// Restore all party monsters to full HP at a heal location.
/// Reject-never-burns: all checks run BEFORE the first DB write.
/// In-battle + cooldown + zone checked. Cost consumed before heal.
#[spacetimedb::reducer]
pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String> {
    let me = ctx.sender;

    // Step 1-2: player must be joined + have a character
    let Some(p) = ctx.db.player().identity().find(me) else {
        return Err("not joined".to_string());
    };
    let Some(ch) = ctx.db.character().entity_id().find(p.entity_id) else {
        return Err("character not found".to_string());
    };

    // Step 3: look up heal location
    let Some(loc) = ctx.db.heal_location_row().location_id().find(location_id) else {
        return Err("heal location not found".to_string());
    };

    // Step 4: zone check
    if ch.zone_id != loc.zone_id {
        return Err("not in heal location zone".to_string());
    }

    // Step 5: in-battle check — EITHER role (ADR-0122): side-B of an ongoing
    // PvP battle cannot heal mid-battle.
    if is_in_ongoing_battle(ctx, me) {
        return Err("cannot heal during an ongoing battle".to_string());
    }

    // Step 6: cooldown check (using location's cooldown_ms)
    let now = now_ms(ctx);
    let last_heal = ctx
        .db
        .heal_cooldown()
        .owner_identity()
        .find(me)
        .map(|r| r.last_heal_at_ms)
        .unwrap_or(0);
    evaluate_heal(last_heal, now, loc.cooldown_ms)?;

    // Step 6b: currency cost (ADR-0083). Load cost from content; 0 means free.
    let currency_cost = game_core::load_heal_locations()
        .map_err(|e| format!("heal_party: load_heal_locations: {e}"))?
        .into_iter()
        .find(|d| d.location_id == location_id)
        .map(|d| d.cost_currency)
        .unwrap_or(0);
    if currency_cost > 0 {
        require_owner(ctx, "heal_party", me)?;
        // Trade escrow guard (TR-10, ADR-0106): reject if currency_cost > available.
        let escrowed = escrowed_currency_amount(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(me)
                .chain(ctx.db.trade_offer().counterparty().filter(me)),
            me,
        );
        let balance = wallet_balance(ctx, me);
        let available = saturating_sub_u64(balance, escrowed);
        if currency_cost > available {
            return Err("currency is in an active trade".to_string());
        }
        spend_currency(ctx, me, currency_cost)?;
    }

    // Step 7: cost consume. consume_one is a DB write; if it fails mid-loop the
    // reducer transaction rolls back (ACID), so no items are permanently lost.
    // Batch consume (cost_qty > 1) is deferred to M13 — current content has None cost.
    if let Some(item_id) = loc.cost_item_id {
        for _ in 0..loc.cost_qty {
            consume_one(ctx, me, item_id)?;
        }
    }

    // Step 8: heal all party monsters (party_slot != PARTY_SLOT_NONE)
    use crate::PARTY_SLOT_NONE;
    let monster_ids: Vec<u64> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(me)
        .filter(|m| m.party_slot != PARTY_SLOT_NONE)
        .map(|m| m.monster_id)
        .collect();
    for mid in monster_ids {
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            m.current_hp = m.stat_hp;
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }

    // Step 9: upsert heal_cooldown
    match ctx.db.heal_cooldown().owner_identity().find(me) {
        Some(existing) => {
            ctx.db
                .heal_cooldown()
                .owner_identity()
                .update(HealCooldown {
                    owner_identity: existing.owner_identity,
                    last_heal_at_ms: now,
                });
        }
        None => {
            ctx.db.heal_cooldown().insert(HealCooldown {
                owner_identity: me,
                last_heal_at_ms: now,
            });
        }
    }

    log::info!("{{\"evt\":\"heal_party\",\"sender\":\"{me}\",\"location\":{location_id}}}");
    Ok(())
}

#[cfg(test)]
#[path = "raising_tests.rs"]
mod raising_tests;
