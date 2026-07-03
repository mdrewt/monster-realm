//! `movement` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Server-paced, per-zone movement (ADR-0011/0007): clients buffer intent; the
//! scheduled `movement_tick` drains one move/character/tick and runs the M8c
//! grass-encounter trigger. The `movement_tick_schedule` scheduled `#[table]`
//! lives HERE (not `schema.rs`) so the `scheduled(movement_tick)` attribute
//! reference resolves within the module (ADR-0056 / spec §6 macro hygiene).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::battle::{begin_encounter, lead_party};
use crate::guards::{authorize_move, log_reject, validate_name};
use crate::marshal::{
    apply_state, char_state, monster_from_instance, now_ms, pub_from_monster,
    table_from_encounter_row,
};
use crate::schema::{
    battle, character, encounter, monster, monster_pub, npc, player, species_row, Character, Player,
};
use crate::{SPRITE_PLAYER, STARTER_SPECIES_ID, ZONE_0};
use game_core::{
    apply_move, load_zone_maps, map_for, npc_decide, resolve_encounter, roll_starter, spawn,
    stepped_onto_grass, ActionState, BattleOutcome, Direction, Millis, MoveInput, StatBlock,
    TilePos, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::{ReducerContext, ScheduleAt, Table};

/// Per-zone movement schedule: one interval-row per active zone makes the
/// scheduler call `movement_tick` for THAT zone every `STEP_MS`.
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}

/// Join: one `player` + one `character` at the spawn + one starter `monster`
/// (idempotent: a returning player gets character+player only, not a second
/// monster). Rejects a double-join within the same session.
#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let me = ctx.sender;
    let name = validate_name(&name).inspect_err(|e| log_reject("join_game", me, e))?;
    if ctx.db.player().identity().find(me).is_some() {
        let e = "already joined".to_string();
        log_reject("join_game", me, &e);
        return Err(e);
    }
    let sp = spawn();
    let ch = ctx.db.character().insert(Character {
        entity_id: 0,
        zone_id: ZONE_0,
        tile_x: sp.x,
        tile_y: sp.y,
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at_ms: now_ms(ctx),
        sprite_id: SPRITE_PLAYER,
        move_queue: Vec::new(),
    });
    ctx.db.player().insert(Player {
        identity: me,
        entity_id: ch.entity_id,
        name,
        online: true,
        last_input_seq: 0,
    });

    // Grant starter if this identity has no monsters yet (idempotent on reconnect).
    let has_monsters = ctx
        .db
        .monster()
        .owner_identity()
        .filter(me)
        .next()
        .is_some();
    if !has_monsters {
        let Some(species) = ctx.db.species_row().id().find(STARTER_SPECIES_ID) else {
            let e =
                format!("starter species {STARTER_SPECIES_ID} not found — content sync required");
            log_reject("join_game", me, &e);
            return Err(e);
        };
        let species_core = game_core::Species {
            id: species.id,
            name: species.name.clone(),
            base_stats: StatBlock {
                hp: species.base_hp,
                attack: species.base_attack,
                defense: species.base_defense,
                speed: species.base_speed,
                sp_attack: species.base_sp_attack,
                sp_defense: species.base_sp_defense,
            },
            affinity: species.affinity,
            learnable_skill_ids: species.learnable_skill_ids.clone(),
        };
        let seed: u32 = ctx.random();
        let inst = roll_starter(seed, &species_core);
        let row = monster_from_instance(me, &inst, 0); // party slot 0
        let inserted = ctx.db.monster().insert(row);
        ctx.db.monster_pub().insert(pub_from_monster(&inserted));
        log::info!(
            "{{\"evt\":\"starter_granted\",\"sender\":\"{me}\",\"monster_id\":{}}}",
            inserted.monster_id
        );
    }

    log::info!("{{\"evt\":\"join\",\"sender\":\"{me}\"}}");
    Ok(())
}

/// Append one intent to the bounded queue (anti-flood: reject when full). Buffers
/// intent only — NEVER computes movement. Atomic: queue + ack in one transaction.
#[spacetimedb::reducer]
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "enqueue_move", seq)?;
    if ch.move_queue.len() >= MOVE_QUEUE_CAP {
        let e = "queue full".to_string();
        log_reject("enqueue_move", ctx.sender, &e);
        return Err(e);
    }
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Replace the ENTIRE undrained queue with one input (a responsive turn/direction
/// change). Cap-safe (length 1).
#[spacetimedb::reducer]
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "set_move", seq)?;
    ch.move_queue.clear();
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Empty the queue (key release).
#[spacetimedb::reducer]
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String> {
    let mut ch = authorize_move(ctx, "clear_queue", seq)?;
    ch.move_queue.clear();
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Per-zone, server-paced tick: drain ≤1 move per character in THIS zone, compute
/// the outcome via `game_core::apply_move`, write back. Scheduler-only.
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;
    let now = Millis(now_ms(ctx));
    let zone_maps = match load_zone_maps() {
        Ok(z) => z,
        Err(e) => {
            log::error!("{{\"evt\":\"movement_tick_error\",\"zone\":{zone},\"reason\":\"{e}\"}}");
            return Ok(()); // logged no-op: a content-load failure must not abort the tick (ADR-0066)
        }
    };
    let map = match map_for(zone, &zone_maps) {
        Ok(m) => m,
        Err(e) => {
            log::error!("{{\"evt\":\"movement_tick_error\",\"zone\":{zone},\"reason\":\"{e}\"}}");
            return Ok(());
        }
    };
    // Snapshot ids BEFORE mutating (never mutate the table mid-iteration).
    let ids: Vec<u64> = ctx
        .db
        .character()
        .zone_id()
        .filter(zone)
        .map(|c| c.entity_id)
        .collect();
    for id in ids {
        let Some(mut row) = ctx.db.character().entity_id().find(id) else {
            continue;
        };
        if row.move_queue.is_empty() {
            if row.action != ActionState::Idle {
                row.action = ActionState::Idle;
                ctx.db.character().entity_id().update(row);
            }
            continue;
        }
        let input = row.move_queue.remove(0);
        let prev = char_state(&row).pos; // capture BEFORE apply_move
        let next = apply_move(&char_state(&row), input, &map, now);
        apply_state(&mut row, &next);
        let entity_id = row.entity_id; // capture before any move/borrow

        // Server-authoritative warp resolution (ADR-0020/0066).
        // Guard 1: only fire when the character actually MOVED (bump = no warp).
        // Guard 2: players in active battles must not be warped (C1 security finding).
        if prev != next.pos {
            if let Some(warp) = map.warp_at(next.pos) {
                // Copy scalars out of the WarpDef borrow BEFORE mutating row.
                let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                // Battle guard: skip warp for players currently in an ongoing battle.
                let in_battle = ctx
                    .db
                    .player()
                    .entity_id()
                    .filter(entity_id)
                    .next()
                    .map(|p| {
                        ctx.db
                            .battle()
                            .player_identity()
                            .filter(p.identity)
                            .any(|b| b.state.outcome == BattleOutcome::Ongoing)
                    })
                    .unwrap_or(false); // NPCs have no player row → treat as not in battle → warp them
                if !in_battle {
                    row.zone_id = to_zone;
                    row.tile_x = tx;
                    row.tile_y = ty;
                    row.move_queue.clear(); // clear queued moves across zone boundary
                    row.action = ActionState::Idle; // arrive idle in new zone
                    ctx.db.character().entity_id().update(row);
                    // skip grass-encounter trigger — a warp step is not a grass step
                    continue;
                }
            }
        }

        // Normal (non-warp) one-write path — position + drained move_queue (atomic, ADR-0013 §B).
        ctx.db.character().entity_id().update(row);

        // M8c grass-encounter trigger (ADR-0045). EVERY failure mode below is a
        // no-op, never a panic. Draw `ctx.random()` AT MOST once per character —
        // only after `stepped_onto_grass` + player + not-already-in-battle pass —
        // so A's hit cannot shift B's roll in the same tick (R-E).
        if !stepped_onto_grass(prev, next.pos, &map) {
            continue;
        }
        // Player-only: an NPC character has no `player` row → no encounter.
        let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
            continue;
        };
        let player_identity = player.identity;
        let already = ctx
            .db
            .battle()
            .player_identity()
            .filter(player_identity)
            .any(|b| b.state.outcome == BattleOutcome::Ongoing);
        if already {
            continue;
        }
        // Lead party level (no party → no-op). begin_encounter's empty-party guard
        // is the backstop.
        let Some((party_ids, player_level)) = lead_party(ctx, player_identity) else {
            continue;
        };
        // The zone's PRIVATE encounter table (partial-sync: missing row → no-op).
        let Some(enc_row) = ctx.db.encounter().zone_id().find(zone) else {
            continue;
        };
        let Ok(table) = table_from_encounter_row(&enc_row) else {
            continue;
        };
        let seed: u32 = ctx.random();
        if let Some(w) = resolve_encounter(&table, seed, player_level) {
            // A failed begin_encounter is a no-op (logged inside on the happy path);
            // swallow the Err so one character's encounter cannot abort the tick.
            let _ = begin_encounter(
                ctx,
                player_identity,
                party_ids,
                w.species_id,
                w.level.as_u8(),
                w.individuality_seed,
            );
        }
    }

    // NPC wander (M12b, ADR-0069): deterministic per-tick wander via game_core::npc_decide.
    // Tick counter derived from server clock — avoids wall-clock entropy (ADR-0003).
    let tick_counter: u64 = now.0.unsigned_abs() / (STEP_MS.unsigned_abs().max(1));
    let npc_entity_ids: Vec<u64> = ctx
        .db
        .npc()
        .zone_id()
        .filter(zone)
        .map(|n| n.entity_id)
        .collect();
    for entity_id in npc_entity_ids {
        let Some(npc_row) = ctx.db.npc().entity_id().find(entity_id) else {
            continue;
        };
        let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else {
            continue;
        };
        let current = TilePos {
            x: ch.tile_x,
            y: ch.tile_y,
        };
        let home = TilePos {
            x: npc_row.home_x,
            y: npc_row.home_y,
        };
        let Some(dir) = npc_decide(
            current,
            home,
            npc_row.wander_radius,
            entity_id,
            tick_counter,
        ) else {
            continue;
        };
        let next_state = apply_move(&char_state(&ch), MoveInput::Step(dir), &map, now);
        apply_state(&mut ch, &next_state);
        // NOTE (F5): apply_state writes ONLY tile_x/tile_y/facing/action/move_started_at.
        // It does NOT write zone_id. NPC zone crossings deferred to M12c.
        ctx.db.character().entity_id().update(ch);
    }

    Ok(())
}
