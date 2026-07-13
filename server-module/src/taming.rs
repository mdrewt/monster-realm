//! `taming` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Recruiting wild monsters (ADR-0047). The inventory helpers it consumes
//! (`grant_item` / `consume_one`) now live in `inventory.rs` (ADR-0059, the
//! single item-mutation surface). The recruit roll is injected (`ctx.random()`),
//! never a client argument; bait is classified by data (the item's
//! `recruit_bonus`), consumed BEFORE the roll.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::battle::{write_back_battle_results, write_back_party_hp};
use crate::guards::log_reject;
// `grant_item` is dev-gated (its only caller `grant_bait` is too — an ungated
// import would be an unused-import warning in the non-dev build, red-team F6);
// `consume_one` is ungated (its caller `attempt_recruit` always compiles).
use crate::inventory::consume_one;
#[cfg(feature = "dev_reducers")]
use crate::inventory::grant_item;
use crate::marshal::{
    build_ability_store, monster_from_instance, pub_from_monster, type_chart_from_rows,
};
use crate::schema::{
    battle, battle_wild, item_row, monster, monster_pub, species_row, type_relation_row,
};
use crate::PARTY_SLOT_NONE;
use game_core::combat::resolve::resolve_recruit_failure;
use game_core::{
    build_monster, load_abilities, recruit_chance, BattleOutcome, BattleStatusStore, Level,
    StatBlock, StatusVariance, TurnVariance, RECRUIT_BASE_RATE,
};
use spacetimedb::{ReducerContext, Table};

/// Attempt to recruit the wild monster in a wild battle (M8d, ADR-0047). The
/// roll is injected (`ctx.random()`), never a client argument. Optional `bait`
/// is classified by data (the item's `recruit_bonus`), consumed BEFORE the roll.
///
/// Success: build the SAME individual from the stored seed (full HP), drop it in
/// the box, write back party HP (NO XP), GC the wild row, end the battle.
/// Failure: advance the turn, let the wild strike back; if that ends the battle,
/// run the full results path (XP/loss handling) + GC.
#[spacetimedb::reducer]
pub fn attempt_recruit(
    ctx: &ReducerContext,
    battle_id: u64,
    bait_item_id: Option<u32>,
) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = match ctx.db.battle().battle_id().find(battle_id) {
        Some(b) => b,
        None => {
            let e = "battle not found".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };
    // Ownership guard — explicit `!=` form required by recruit-reducer-security eval
    // (which pattern-matches `player_identity != me`). Functionally equivalent to
    // require_owner; PARK: unify when the eval is updated to accept require_owner.
    if battle.player_identity != me {
        let e = "not owner".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("attempt_recruit", me, &e);
        return Err(e);
    }
    let bw = match ctx.db.battle_wild().battle_id().find(battle_id) {
        Some(bw) => bw,
        None => {
            let e = "not a wild battle".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
    };

    // Bait (optional): classify by data (recruit_bonus), consume BEFORE the roll.
    let mut bait_bonus = 0u16;
    if let Some(id) = bait_item_id {
        let item = match ctx.db.item_row().id().find(id) {
            Some(row) => row,
            None => {
                let e = "unknown item".to_string();
                log_reject("attempt_recruit", me, &e);
                return Err(e);
            }
        };
        let rb = item.recruit_bonus;
        if rb == 0 {
            let e = "item is not bait".to_string();
            log_reject("attempt_recruit", me, &e);
            return Err(e);
        }
        consume_one(ctx, me, id)?;
        bait_bonus = rb;
    }

    // Read every value we need off the wild into OWNED locals BEFORE any
    // mutation of `battle.state`, so the fail branch never re-borrows across the
    // `resolve_recruit_failure` turn-counter write (no borrow-across-mutation trap).
    let wild = battle.state.side_b.active_monster();
    let wild_max_hp = wild.max_hp;
    let wild_current_hp = wild.current_hp;

    let chance = recruit_chance(wild_max_hp, wild_current_hp, RECRUIT_BASE_RATE, bait_bonus);
    let roll: u32 = ctx.random();
    let success = game_core::attempt_recruit(chance, roll);

    if success {
        // Rebuild the EXACT wild from the stored seed at its level (full HP).
        let species_row = ctx
            .db
            .species_row()
            .id()
            .find(bw.wild_species_id)
            .ok_or_else(|| format!("wild species {} not found", bw.wild_species_id))?;
        let species_core = game_core::Species {
            id: species_row.id,
            name: species_row.name.clone(),
            base_stats: StatBlock {
                hp: species_row.base_hp,
                attack: species_row.base_attack,
                defense: species_row.base_defense,
                speed: species_row.base_speed,
                sp_attack: species_row.base_sp_attack,
                sp_defense: species_row.base_sp_defense,
            },
            affinity: species_row.affinity,
            learnable_skill_ids: species_row.learnable_skill_ids.clone(),
            ability: None,
        };
        let inst = build_monster(
            bw.individuality_seed,
            &species_core,
            Level::new(bw.wild_level)?,
        );
        let row = monster_from_instance(me, &inst, PARTY_SLOT_NONE);
        let inserted = ctx.db.monster().insert(row);
        ctx.db.monster_pub().insert(pub_from_monster(&inserted));

        battle.state.outcome = BattleOutcome::SideAWins;
        // NO XP on recruit (ADR-0047): do NOT swap for write_back_battle_results.
        write_back_party_hp(ctx, &battle)?;
        ctx.db.battle_wild().battle_id().delete(battle_id);
        ctx.db.battle().battle_id().update(battle);
        // Log ONLY public coordinates — NEVER seed/IVs/nature (side-channel).
        log::info!(
            "{{\"evt\":\"recruit_success\",\"battle_id\":{battle_id},\"species_id\":{},\"monster_id\":{}}}",
            bw.wild_species_id,
            inserted.monster_id
        );
        return Ok(());
    }

    // Failure: the recruit roll missed. game_core owns the failed-recruit battle
    // transition (game_core::resolve_recruit_failure): it advances the turn through
    // the SSOT `u16::MAX -> Fled` terminal — NEVER a raw in-shell `turn_number += 1`
    // — and then lets the wild (side B) strike back ONLY if it has a skill and the
    // turn-limit terminal did not fire. Post-turn phases (DoT, weather chip, status/
    // weather tick) now run on every failed-recruit turn (ADR-0098 D1, closes R3).
    // Use load_skills() — not skill_defs_from_rows — so sets_weather/applies_status
    // are populated (ADR-0098 D2, closes RT-W14-DESYNC-01).
    let skill_defs = game_core::load_skills()?;
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter())?;
    let variance = TurnVariance::from_ctx_random(ctx.random());
    let sv = StatusVariance::from_ctx_random(ctx.random());

    // Build the per-slot status store from BattleMonster.status fields (same
    // pattern as submit_attack; ADR-0098 D4).
    let mut status = BattleStatusStore {
        side_a: battle.state.side_a.team.iter().map(|m| m.status).collect(),
        side_b: battle.state.side_b.team.iter().map(|m| m.status).collect(),
    };

    // Build AbilityStore from species content for this battle's teams (ADR-0100).
    let ability_defs = load_abilities()?;
    let a_ability_ids: Vec<Option<u32>> = battle
        .state
        .side_a
        .team
        .iter()
        .map(|m| {
            ctx.db
                .species_row()
                .id()
                .find(m.species_id)
                .and_then(|sp| sp.ability)
        })
        .collect();
    let b_ability_ids: Vec<Option<u32>> = battle
        .state
        .side_b
        .team
        .iter()
        .map(|m| {
            ctx.db
                .species_row()
                .id()
                .find(m.species_id)
                .and_then(|sp| sp.ability)
        })
        .collect();
    let abilities = build_ability_store(&a_ability_ids, &b_ability_ids, &ability_defs);

    let _events = resolve_recruit_failure(
        &mut battle.state,
        &skill_defs,
        &type_chart,
        &variance,
        &mut status,
        &sv,
        &abilities,
    );

    // Persist status store back into BattleMonster.status fields (same pattern as
    // submit_attack; write only when ongoing — terminal rows are immediately GC'd).
    if battle.state.outcome == BattleOutcome::Ongoing {
        for (m, s) in battle
            .state
            .side_a
            .team
            .iter_mut()
            .zip(status.side_a.iter())
        {
            m.status = *s;
        }
        for (m, s) in battle
            .state
            .side_b
            .team
            .iter_mut()
            .zip(status.side_b.iter())
        {
            m.status = *s;
        }
    }

    if battle.state.outcome != BattleOutcome::Ongoing {
        // Terminal: the wild knocked out the player's last monster, OR the
        // turn-limit terminal (Fled) fired in advance_turn. write_back_battle_results
        // owns terminal GC (it deletes battle_wild unconditionally) and grants XP
        // only on SideAWins, so the Fled terminal writes back HP without XP.
        write_back_battle_results(ctx, &battle)?;
    }
    ctx.db.battle().battle_id().update(battle);
    log::info!("{{\"evt\":\"recruit_fail\",\"battle_id\":{battle_id}}}");
    Ok(())
}

/// DEV/TEST: grant bait to the CALLER only (self-scoped to `ctx.sender`; no
/// arbitrary-recipient parameter). Rejects non-bait items. Superseded by the M9
/// shop. Capped at 99 per call.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender;
    let Some(item) = ctx.db.item_row().id().find(item_id) else {
        let e = "item not found".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    };
    if item.recruit_bonus == 0 {
        let e = "not a bait item".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    }
    let capped = qty.min(99);
    grant_item(ctx, ctx.sender, item_id, capped);
    Ok(())
}

#[cfg(test)]
#[path = "taming_tests.rs"]
mod taming_tests;
