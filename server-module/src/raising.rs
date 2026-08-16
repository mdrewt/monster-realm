//! `raising` — server-module domain submodule (M8.9, ADR-0056 / ADR-0059).
//!
//! The M9b raising shell: the `care` reducer (itemless Trust raise since
//! EG2/ADR-0175 — Bond retired at EG5/ADR-0177 — server-authoritative
//! per-monster cooldown). It is THIN — find the monster, check ownership, run
//! the pure decision seam `evaluate_care` (a cooldown-only gate delegating to
//! the SSOT `game_core::is_cooldown_ready`), and only on `Ok` mutate +
//! dual-write `monster` / `monster_pub`. No DB write occurs before the success
//! path, so a rejected `care` can never burn the cooldown or credit Trust
//! (the reducer transaction rolls back on any `Err`).
//!
//! `train` (focus-training food spend) is implemented in the same file (M9b-tail,
//! ADR-0059): pure `evaluate_train` seam → SSOT `focus_train`; decision-before-
//! `consume_one` so a rejected train never burns the food item.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::economy::{spend_currency, wallet_balance};
use crate::evolution::check_and_evolve;
use crate::guards::{
    escrowed_currency_amount, escrowed_item_qty, is_in_ongoing_battle, reject_if_monster_in_trade,
    require_owner, saturating_sub_u64,
};
use crate::inventory::consume_one;
use crate::marshal::{now_ms, pub_from_monster};
use crate::schema::{
    character, heal_cooldown, heal_location_row, inventory, item_row, monster, monster_pub, player,
    species_row, trade_offer, HealCooldown, Monster,
};
use game_core::{
    focus_train, is_cooldown_ready, Affinity, EVs, FocusTrainError, FocusTrainResult, IVs, Level,
    Nature, StatBlock, StatKind,
};
// SSOT (ptc5e-1): the CARE cooldown magnitude lives in game-core. Re-exported
// `pub(crate)` — and ONLY this name, not the whole `game_core` import above —
// so the `#[path]`-attached `raising_tests.rs` child mod reaches it through
// `use super::*` without an ambiguous-glob clash with its own explicit
// `use game_core::{EVs, IVs, ...}` imports. (`CARE_BOND_AMOUNT`/`apply_care`/
// `Bond`/`CareError` dropped at EG5/ADR-0177 D3 — Bond retired; they remain in
// game-core as a named retirement follow-up.)
pub(crate) use game_core::CARE_COOLDOWN_MS;
use spacetimedb::{Identity, ReducerContext, Table};

/// Pure decision seam (testable without a DB): the cooldown-only care gate.
/// Bond and its arithmetic are retired (EG5/ADR-0177 D3 — the AtMaxBond remap,
/// `apply_care`, and the returned bond value all went with the column); what
/// remains is the same thin pure-seam-over-`is_cooldown_ready` shape
/// `evaluate_heal` already has. Kept as a seam (not inlined into `care`) so the
/// cooldown gate stays DB-free unit-testable and `raising-reducer-security`'s
/// g8 SSOT-delegation check has a real target.
///
/// The cooldown gate delegates to the SSOT `game_core::is_cooldown_ready`
/// (ptc5e-1): ready ⟺ `now - last >= CARE_COOLDOWN_MS`, so elapsed ==
/// `CARE_COOLDOWN_MS` is ALLOWED and the `saturating_sub` elapsed means a
/// future/zero clock can only OVER-reject, never wrap into a bypass.
///
/// The `now` parameter is the server clock ms (the caller passes `now_ms(ctx)`);
/// it is named `now` — NOT `now_ms` — to avoid shadowing the module-level
/// `now_ms` helper inside this body (red-team F2, least-surprise).
pub(crate) fn evaluate_care(last_care_at_ms: i64, now: i64) -> Result<(), String> {
    if !is_cooldown_ready(last_care_at_ms, now, CARE_COOLDOWN_MS) {
        return Err("care cooldown not yet elapsed".to_string());
    }
    Ok(())
}

/// Care for a monster (Trust-favorable credit, EG2-5/ADR-0175), gated by a
/// per-monster cooldown measured from the server clock (`ctx.timestamp`, never
/// a client argument). Ownership-checked; dual-writes the private `monster` row
/// and its public `monster_pub` projection. No DB write before the success path
/// — a reject (not found, not owner, within cooldown) never burns the cooldown
/// (ADR-0059 §3, reject-never-burns).
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
    if is_in_ongoing_battle(ctx, ctx.sender()) {
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
    evaluate_care(m.last_care_at_ms, now)?;
    m.last_care_at_ms = now;
    // EG2-5: care is the Trust-favorable writer — saturating, the counter is a
    // u32 lifetime total and a raw increment would overflow-panic mid-reducer.
    m.trust_favorable_count = m.trust_favorable_count.saturating_add(1);
    // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    // EG2-8/EG2-12 tails (fresh-find, after this reducer's own dual-write):
    // Quality-Time credit first — it is itself an evolution gate — then the
    // auto-evolution check LAST.
    accrue_quality_time(ctx, monster_id);
    check_and_evolve(ctx, monster_id);
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
    if is_in_ongoing_battle(ctx, ctx.sender()) {
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
    consume_one(ctx, ctx.sender(), food_item_id)?;

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

    // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    // EG2-6: the EV path above is mechanically unchanged; EG2 adds ONLY the two
    // tails (accrual first, auto-evolution check LAST — nutrition is a gate).
    accrue_quality_time(ctx, monster_id);
    check_and_evolve(ctx, monster_id);
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
///
/// The `now` parameter is intentionally named `now` (not `now_ms`) — the same
/// convention as `evaluate_care` — to avoid shadowing the module-level `now_ms`
/// helper if this body is ever extended with a `now_ms(ctx)` call.
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
    let me = ctx.sender();

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

    // Step 6b: currency cost (ADR-0083). Cost from the process-wide
    // heal-location cache (ADR-0170 D3) — no per-call RON re-parse; 0 means free.
    let currency_cost = crate::content_cache::cached_heal_locations()
        .map_err(|e| format!("heal_party: cached_heal_locations: {e}"))?
        .iter()
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
            // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing
            // monster_pub row — never fabricate a tier.
            let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(mid) else {
                return Err(format!("monster_pub row missing for monster {mid}"));
            };
            let pub_row = pub_from_monster(&m, existing_pub.tier);
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

// ===========================================================================
// EG2 — the essence-graph raising layer (spec §2 EG2-3/4/5/8/10, ADR-0175).
// All pacing magnitudes below are playtest-tunable placeholders (spec §6); the
// SHAPES (clamp-never-reject, bounded-gap accrual, shared cooldown clock) are
// the decisions.
// ===========================================================================

/// Shared essence-training cooldown (5 h in ms) — ONE clock for `essence_train`
/// and `consume_crystalized_essence` (EG2-4), anchored on
/// `last_essence_train_at_ms`.
pub(crate) const ESSENCE_TRAIN_COOLDOWN_MS: i64 = 18_000_000;
/// Flat essence granted per `essence_train` (EG2-3).
pub(crate) const ESSENCE_TRAIN_AMOUNT: u32 = 5;
/// Per-pool essence soft cap — grants CLAMP here, never reject (EG1-1).
pub(crate) const ESSENCE_SOFT_CAP: u32 = 999;
/// One Quality-Time tick per this many credited active ms (1 tick per minute).
pub(crate) const QT_TICK_MS: i64 = 60_000;
/// A gap longer than this means the player was away — idle time never credits.
pub(crate) const QT_IDLE_GAP_MS: i64 = 120_000;
/// A gap shorter than this batches (no DB write, anchor kept) — hot-path bound.
pub(crate) const QT_MIN_WRITE_GAP_MS: i64 = 5_000;
/// Hard cap on credited Quality Time per UTC day (2 h) — defense in depth.
pub(crate) const QT_DAILY_CAP_MS: i64 = 7_200_000;

/// Grant essence to the ONE pool matching `affinity`:
/// `saturating_add(amount).min(ESSENCE_SOFT_CAP)` — clamp, never reject, never
/// panic (EG2-3 / EG1-1). Exhaustive match, so a new affinity cannot silently
/// no-op.
pub(crate) fn grant_essence(m: &mut Monster, affinity: Affinity, amount: u32) {
    match affinity {
        Affinity::Fire => {
            m.essence_fire = m.essence_fire.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Water => {
            m.essence_water = m.essence_water.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Plant => {
            m.essence_plant = m.essence_plant.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Electric => {
            m.essence_electric = m
                .essence_electric
                .saturating_add(amount)
                .min(ESSENCE_SOFT_CAP);
        }
        Affinity::Earth => {
            m.essence_earth = m.essence_earth.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Wind => {
            m.essence_wind = m.essence_wind.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Light => {
            m.essence_light = m.essence_light.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
        Affinity::Dark => {
            m.essence_dark = m.essence_dark.saturating_add(amount).min(ESSENCE_SOFT_CAP);
        }
    }
}

/// Pure bounded-gap Quality-Time accrual (EG2-8, ADR-0175 D1). Mutates the four
/// Quality-Time columns of `m` in place; returns whether the row changed (false
/// = the caller must perform NO DB write — the sub-threshold hot-path batch).
///
/// Branch order is load-bearing (each step is pinned by a unit test):
///   1. `now < anchor` (backwards clock): re-anchor only. Checked FIRST —
///      saturating_sub would otherwise collapse it into the keep-anchor branch
///      and leave a FUTURE anchor in the row (a silent accrual lockout).
///   2. `gap < QT_MIN_WRITE_GAP_MS` (strict): pure no-op, anchor KEPT so the
///      skipped time batches against the older anchor.
///   3. UTC-day rollover resets the day window — ABOVE the idle branch, i.e.
///      compared BEFORE any re-anchor. The common rollover is "capped on day N,
///      idle overnight, back on day N+1": that path takes the idle branch, and
///      a reset placed below it would re-anchor into the new day without ever
///      clearing `window_ms`, silently turning the 2 h DAILY cap into a
///      permanent LIFETIME cap. The day rule is the SSOT `day_epoch_utc`
///      (battle.rs) — sound here because anchors are non-negative server
///      timestamps once the backwards-clock branch has run.
///   4. `gap > QT_IDLE_GAP_MS` (strict): the player was away — re-anchor, no
///      credit. The first-ever call (anchor 0) lands here by construction.
///   5. credit `min(gap, QT_DAILY_CAP_MS - window)`, floored at 0; convert
///      whole ticks at QT_TICK_MS, keep the remainder, saturate the counter.
pub(crate) fn apply_quality_time_credit(m: &mut Monster, now: i64) -> bool {
    let anchor = m.quality_time_window_start_ms;
    if now < anchor {
        m.quality_time_window_start_ms = now;
        return true;
    }
    let gap = now.saturating_sub(anchor);
    if gap < QT_MIN_WRITE_GAP_MS {
        return false;
    }
    if crate::battle::day_epoch_utc(now) != crate::battle::day_epoch_utc(anchor) {
        m.quality_time_window_ms = 0;
    }
    if gap > QT_IDLE_GAP_MS {
        m.quality_time_window_start_ms = now;
        return true;
    }
    let headroom = QT_DAILY_CAP_MS
        .saturating_sub(i64::from(m.quality_time_window_ms))
        .max(0);
    let creditable = gap.min(headroom);
    if creditable == 0 {
        // Daily cap exhausted: no tick, no tier change, nothing check_and_evolve
        // can observe. Return false WITHOUT re-anchoring so the ctx shell skips
        // its row write (ADR-0178 D4) — on enqueue_move that was one wasted
        // write per party monster per QT_MIN_WRITE_GAP_MS for the rest of the
        // UTC day. Dropping the re-anchor is safe and drops exactly this one
        // mutation: creditable == 0 <=> headroom == 0 <=> window_ms >= CAP,
        // while the rollover branch above sets window_ms = 0 => headroom == CAP
        // => creditable > 0, so the two branches are MUTUALLY EXCLUSIVE and a
        // day reset can never be suppressed here. Anchor staleness stays bounded
        // by the idle branch above, which still re-anchors.
        return false;
    }
    // creditable <= QT_IDLE_GAP_MS here, so the conversion cannot fail; the
    // defensive arm re-anchors without credit rather than truncating (no `as`).
    let Ok(credit) = u32::try_from(creditable) else {
        m.quality_time_window_start_ms = now;
        return true;
    };
    m.quality_time_window_ms = m.quality_time_window_ms.saturating_add(credit);
    m.quality_time_accum_ms = m.quality_time_accum_ms.saturating_add(credit);
    // QT_TICK_MS (60_000) always fits u32; the MAX fallback keeps the division
    // total and errs toward crediting FEWER ticks, never more.
    let tick_ms = u32::try_from(QT_TICK_MS).unwrap_or(u32::MAX);
    m.quality_time_ticks_total = m
        .quality_time_ticks_total
        .saturating_add(m.quality_time_accum_ms / tick_ms);
    m.quality_time_accum_ms %= tick_ms;
    m.quality_time_window_start_ms = now;
    true
}

/// Quality-Time ctx shell (EG2-8, ADR-0175 D1/D3): delegate the ms rule to the
/// pure seam above, then write back — re-projecting `monster_pub` ONLY when the
/// public `quality_time_tier` actually changed (an unchanged tier is a
/// byte-identical projection, and this runs on the movement hot path).
///
/// Returns whether `quality_time_ticks_total` actually advanced this call —
/// the ONE Quality-Time observable an evolution gate can see. `enqueue_move`
/// gates its `check_and_evolve` tail on it (walking changes no other gate
/// value, so a no-tick call cannot change eligibility — ADR-0148 latency
/// budget); every other call site ignores the return and checks
/// unconditionally, because it mutates other gate values itself.
///
/// Infallible outward (a reducer TAIL must never fail its caller's write):
/// missing rows are log-and-return-false. A missing `monster_pub` row writes
/// NOTHING — the tier is copy-forward-only here, never fabricated (ADR-0174
/// D7/A3).
pub(crate) fn accrue_quality_time(ctx: &ReducerContext, monster_id: u64) -> bool {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        log::warn!("{{\"evt\":\"qt_accrue_skip\",\"monster_id\":{monster_id},\"reason\":\"monster row missing\"}}");
        return false;
    };
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        log::error!("{{\"evt\":\"qt_accrue_skip\",\"monster_id\":{monster_id},\"reason\":\"monster_pub row missing\"}}");
        return false;
    };
    let ticks_before = m.quality_time_ticks_total;
    if !apply_quality_time_credit(&mut m, now_ms(ctx)) {
        return false;
    }
    let ticked = m.quality_time_ticks_total != ticks_before;
    let new_pub = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    if new_pub.quality_time_tier != existing_pub.quality_time_tier {
        ctx.db.monster_pub().monster_id().update(new_pub);
    }
    ticked
}

/// Pure cooldown seam for `essence_train` (EG2-3): the SSOT
/// `game_core::is_cooldown_ready` predicate against the shared 5 h clock.
pub(crate) fn evaluate_essence_train(last_train_ms: i64, now: i64) -> Result<(), String> {
    if !is_cooldown_ready(last_train_ms, now, ESSENCE_TRAIN_COOLDOWN_MS) {
        return Err("essence training cooldown not yet elapsed".to_string());
    }
    Ok(())
}

/// Pure decision seam for `consume_crystalized_essence` (EG2-4/EG2-10): exactly
/// two rejects — not a crystalized-essence item, or the SHARED cooldown — both
/// decided BEFORE the caller's irreversible `consume_one`. Ok hands back the
/// ITEM's affinity and the ITEM's amount verbatim.
pub(crate) fn evaluate_consume_crystalized(
    item: &game_core::ItemDef,
    last_train_ms: i64,
    now: i64,
) -> Result<(game_core::Affinity, u32), String> {
    let Some(affinity) = item.essence_affinity else {
        return Err("item is not crystalized essence".to_string());
    };
    if !is_cooldown_ready(last_train_ms, now, ESSENCE_TRAIN_COOLDOWN_MS) {
        return Err("essence training cooldown not yet elapsed".to_string());
    }
    Ok((affinity, item.essence_amount))
}

/// Essence-train a monster: +ESSENCE_TRAIN_AMOUNT to ONE pool, gated by the
/// shared 5 h cooldown (EG2-3). Full care-shaped guard set; decision before
/// mutation (reject-never-burns); dual-write; then the EG2 growth tails.
#[spacetimedb::reducer]
pub fn essence_train(
    ctx: &ReducerContext,
    monster_id: u64,
    affinity: Affinity,
) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    require_owner(ctx, "essence_train", m.owner_identity)?;
    // Both-role ongoing-battle guard (ADR-0136 amends ADR-0122 §D7), as in care.
    if is_in_ongoing_battle(ctx, ctx.sender()) {
        return Err("cannot essence-train during an ongoing battle".to_string());
    }
    // Trade escrow guard (ADR-0106): an escrowed monster must not be mutated.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    let now = now_ms(ctx);
    // DECISION before mutation (reject-never-burns, ADR-0059 §3).
    evaluate_essence_train(m.last_essence_train_at_ms, now)?;
    grant_essence(&mut m, affinity, ESSENCE_TRAIN_AMOUNT);
    m.last_essence_train_at_ms = now;
    // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    // EG2-8/EG2-12 tails: accrual first (Quality Time is itself a gate), then
    // the auto-evolution check LAST — essence just changed, a gate value.
    accrue_quality_time(ctx, monster_id);
    check_and_evolve(ctx, monster_id);
    Ok(())
}

/// Consume a crystalized-essence item: grant the ITEM's essence to the matching
/// pool, sharing `essence_train`'s cooldown clock (EG2-4). Exactly two decision
/// rejects (wrong item; cooldown), both BEFORE `consume_one` — a reject never
/// burns the item (EG2-10). Item defs come from the compile-time content
/// registry: `ItemRow` carries no essence columns (ADR-0175 D5).
#[spacetimedb::reducer]
pub fn consume_crystalized_essence(
    ctx: &ReducerContext,
    monster_id: u64,
    item_id: u32,
) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    require_owner(ctx, "consume_crystalized_essence", m.owner_identity)?;
    // Both-role ongoing-battle guard (ADR-0136 amends ADR-0122 §D7), as in care.
    if is_in_ongoing_battle(ctx, ctx.sender()) {
        return Err("cannot consume essence during an ongoing battle".to_string());
    }
    // Trade escrow guard (ADR-0106): an escrowed monster must not be mutated.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    // Item escrow: reject if consuming this item would breach the escrowed
    // reserve (same block as train, EG2-4's non-optional double-spend guard).
    {
        let escrowed = escrowed_item_qty(
            ctx.db
                .trade_offer()
                .initiator()
                .filter(m.owner_identity)
                .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
            m.owner_identity,
            item_id,
        );
        let count = ctx
            .db
            .inventory()
            .owner_identity()
            .filter(m.owner_identity)
            .find(|r| r.item_id == item_id)
            .map(|r| r.count)
            .unwrap_or(0);
        if escrowed >= count {
            return Err("item is in an active trade".to_string());
        }
    }
    // ItemDef from the process-wide content registry (essence fields live only
    // there — ItemRow has no essence columns, ADR-0175 D5).
    let item = crate::content_cache::cached_items()
        .map_err(|e| format!("consume_crystalized_essence: cached_items: {e}"))?
        .iter()
        .find(|d| d.id == item_id)
        .ok_or_else(|| format!("item {item_id} not found"))?;
    let now = now_ms(ctx);
    // DECISION before the irreversible spend (reject-never-burns, EG2-10).
    let (item_affinity, amount) =
        evaluate_consume_crystalized(item, m.last_essence_train_at_ms, now)?;
    consume_one(ctx, ctx.sender(), item_id)?;
    grant_essence(&mut m, item_affinity, amount);
    m.last_essence_train_at_ms = now;
    // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    // EG2-8/EG2-12 tails: the sixth call site (ADR-0175 D3) — accrual first,
    // auto-evolution check LAST so a full-bar feed evolves immediately.
    accrue_quality_time(ctx, monster_id);
    check_and_evolve(ctx, monster_id);
    Ok(())
}

// --- M21 guest→account re-key (ADR-0179 D6) ----------------------------------

/// Re-key the `heal_cooldown` row owned by `from` onto `to`. Called only from
/// `accounts::rekey_all` (D0 write-isolation). `owner_identity` IS the PK →
/// delete-then-insert; the destination owns no row (`complete_guest_claim`
/// guard 3), so no collision. No-op when the guest has never healed.
pub(crate) fn rekey_heal_cooldown(ctx: &ReducerContext, from: Identity, to: Identity) {
    if let Some(row) = ctx.db.heal_cooldown().owner_identity().find(from) {
        ctx.db.heal_cooldown().owner_identity().delete(from);
        ctx.db.heal_cooldown().insert(HealCooldown {
            owner_identity: to,
            last_heal_at_ms: row.last_heal_at_ms,
        });
    }
}

/// True if `owner` has a `heal_cooldown` row (for
/// `accounts::account_has_game_data`; ADR-0179 D5 guard 3). Read-only.
pub(crate) fn has_heal_cooldown(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .heal_cooldown()
        .owner_identity()
        .find(owner)
        .is_some()
}

#[cfg(test)]
#[path = "raising_tests.rs"]
mod raising_tests;
