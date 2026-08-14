//! `movement` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Server-paced, per-zone movement (ADR-0011/0007): clients buffer intent; the
//! scheduled `movement_tick` drains at most one move/character/tick (a character
//! whose player is in an ongoing battle drains none — its queue stays frozen,
//! ADR-0168) and runs the M8c grass-encounter trigger. The
//! `movement_tick_schedule` scheduled `#[table]`
//! lives HERE (not `schema.rs`) so the `scheduled(movement_tick)` attribute
//! reference resolves within the module (ADR-0056 / spec §6 macro hygiene).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::battle::{begin_encounter, lead_party, lead_party_ids, NO_CONSCIOUS_MONSTER_REASON};
use crate::evolution::check_and_evolve;
use crate::guards::{authorize_move, is_in_ongoing_battle, json_escape, log_reject, validate_name};
use crate::marshal::{
    apply_state, char_state, monster_from_instance, now_ms, pub_from_monster,
    table_from_encounter_row,
};
use crate::raising::accrue_quality_time;
use crate::schema::{
    character, encounter, monster, monster_pub, npc, player, species_row, trade_offer, Character,
    Player,
};
use crate::{SPRITE_PLAYER, STARTER_SPECIES_ID, ZONE_0};
use game_core::{
    apply_move, map_for, npc_decide, resolve_encounter, roll_starter, spawn, stepped_onto_grass,
    ActionState, Direction, Millis, MoveInput, StatBlock, TilePos, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::{ReducerContext, ScheduleAt, Table};
use std::sync::Mutex;

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
            ability: None,
            tier: species.tier,
        };
        let seed: u32 = ctx.random();
        let inst = roll_starter(seed, &species_core);
        let row = monster_from_instance(me, &inst, 0); // party slot 0
        let inserted = ctx.db.monster().insert(row);
        // FRESH tier (EG1-8/ADR-0174 D7): creation site — the species row is in hand.
        let pub_row = pub_from_monster(&inserted, species.tier);
        ctx.db.monster_pub().insert(pub_row);
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
    // Intake battle lock (ADR-0168 D2): reject-not-clamp movement intent while
    // the caller is in an ongoing battle, either role. `ctx.sender` is correct
    // here — this is a player-called reducer (unlike scheduler-only movement_tick).
    if is_in_ongoing_battle(ctx, ctx.sender) {
        let e = "cannot move during an ongoing battle".to_string();
        log_reject("enqueue_move", ctx.sender, &e);
        return Err(e);
    }
    let mut ch = authorize_move(ctx, "enqueue_move", seq)?;
    if ch.move_queue.len() >= MOVE_QUEUE_CAP {
        let e = "queue full".to_string();
        log_reject("enqueue_move", ctx.sender, &e);
        return Err(e);
    }
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    // EG2-8/EG2-12 growth tails: THE movement call site — a genuinely
    // player-triggered reducer (never movement_tick, EG2-9). Once per party
    // monster over lead_party's FULL id list (not just the lead); accrual
    // first, auto-evolution check LAST. No party -> credit nothing.
    if let Some(party_ids) = lead_party_ids(ctx, ctx.sender) {
        // Trade escrow (TR-6, ADR-0106): an escrowed party monster keeps its
        // party slot until settlement, so without this it would keep accruing
        // Quality Time and could AUTO-EVOLVE out from under the counterparty's
        // propose-time card snapshot (confirm_trade never revalidates it).
        // Collect the caller's escrowed ids ONCE, from BOTH trade roles (the
        // same both-role chain care uses), and SKIP those monsters — never
        // reject the move (a pending offer must not freeze the player).
        // Collected inside this arm on purpose: a caller with no party pays
        // zero trade-offer index reads on the hottest reducer in the game.
        let escrowed: Vec<u64> = ctx
            .db
            .trade_offer()
            .initiator()
            .filter(ctx.sender)
            .chain(ctx.db.trade_offer().counterparty().filter(ctx.sender))
            .filter(|t| t.status.is_active())
            .flat_map(|t| {
                t.initiator_monster_ids
                    .into_iter()
                    .chain(t.counterparty_monster_ids)
            })
            .collect();
        for mid in party_ids {
            if escrowed.contains(&mid) {
                continue;
            }
            // PERF (ADR-0148 latency budget): walking can only move the
            // Quality-Time gate, so the eligibility read runs only when this
            // call actually minted a tick. The other call sites check
            // unconditionally — they mutate other gate values.
            if accrue_quality_time(ctx, mid) {
                check_and_evolve(ctx, mid);
            }
        }
    }
    Ok(())
}

/// Replace the ENTIRE undrained queue with one input (a responsive turn/direction
/// change). Cap-safe (length 1).
#[spacetimedb::reducer]
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    // Intake battle lock (ADR-0168 D2): same reject as enqueue_move — set_move
    // also ADDS movement intent, and the client is hostile.
    if is_in_ongoing_battle(ctx, ctx.sender) {
        let e = "cannot move during an ongoing battle".to_string();
        log_reject("set_move", ctx.sender, &e);
        return Err(e);
    }
    let mut ch = authorize_move(ctx, "set_move", seq)?;
    ch.move_queue.clear();
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

/// Empty the queue (key release).
#[spacetimedb::reducer]
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String> {
    // Deliberately NOT battle-guarded (ADR-0168 D3): pure cancellation — it
    // cannot cause movement. Guarding it would force the stale pre-battle queue
    // to survive to battle end and deny an honest key-release cancel while the
    // battle overlay is opening.
    let mut ch = authorize_move(ctx, "clear_queue", seq)?;
    ch.move_queue.clear();
    ctx.db.character().entity_id().update(ch);
    Ok(())
}

// --- Rate-limited encounter-failure logging (11r-g, ADR-0170 D4) -------------

/// A process-static log rate limiter (ADR-0170 D4): at most one emit per
/// window, counting what was suppressed in between.
///
/// ONE `Mutex` over `(last_emit_ms, suppressed)` makes read-decide-write-back
/// atomic by construction; `Option<i64>` makes never-emitted unrepresentable
/// as a magic value (no sentinel a real clock could collide with). All
/// arithmetic saturates: the workspace ships `overflow-checks = true`, so a
/// bare subtraction on an extreme clock operand would panic the zone tick from
/// the very logging path added to make faults visible.
pub(crate) struct RateLimiter {
    state: Mutex<(Option<i64>, u32)>,
}

impl RateLimiter {
    /// `const` so the two production limiters can be plain process `static`s.
    pub(crate) const fn new() -> Self {
        Self {
            state: Mutex::new((None, 0)),
        }
    }

    /// Decide whether to emit at `now` (ms on the caller's injected clock):
    /// `Some(suppressed)` means EMIT and report how many checks were suppressed
    /// since the last emit (then re-anchor and reset the count); `None` means
    /// suppress and count. The parameter is `now`, not a name shadowing the
    /// imported `marshal::now_ms` helper (the landmine raising.rs's evaluate
    /// helpers deliberately avoid).
    ///
    /// Emits on the first-ever check, at `elapsed >= window_ms` (boundary
    /// INCLUSIVE), and when the clock runs BACKWARDS — re-anchoring to the new
    /// earlier instant rather than suppressing until the clock catches up
    /// (ADR-0170 D4 accepts the jittery-clock trade explicitly). A poisoned
    /// lock is recovered: one unrelated panic must not silence the encounter
    /// log path for the process lifetime.
    pub(crate) fn check(&self, now: i64, window_ms: i64) -> Option<u32> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let (last, suppressed) = *state;
        let emit = match last {
            None => true,
            Some(l) => now < l || now.saturating_sub(l) >= window_ms,
        };
        if emit {
            *state = (Some(now), 0);
            Some(suppressed)
        } else {
            *state = (last, suppressed.saturating_add(1));
            None
        }
    }
}

/// Shared emit window for both grass-block failure limiters: at most one
/// `log::error!` per limiter per 5000 ms of the tick's injected clock
/// (ADR-0003 — never a wall clock). A NAMED constant so both arms provably
/// share one window value instead of drifting apart.
const ENCOUNTER_ERR_WINDOW_MS: i64 = 5000;

/// Gates `encounter_table_error` logging (a failed `table_from_encounter_row`).
static ENCOUNTER_TABLE_ERR_LIMITER: RateLimiter = RateLimiter::new();

/// Gates `begin_encounter_error` logging. A SECOND, independent limiter on
/// purpose (ADR-0170 D4): the party-has-no-conscious-monster Err from
/// `begin_encounter` is routine gameplay (a fainted party walking grass) and
/// bursts; sharing one limiter would let that burst mask a real content
/// defect in the encounter table.
static BEGIN_ENCOUNTER_ERR_LIMITER: RateLimiter = RateLimiter::new();

/// Per-zone, server-paced tick: drain ≤1 move per character in THIS zone, compute
/// the outcome via `game_core::apply_move`, write back. Scheduler-only.
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;
    let now = Millis(now_ms(ctx));
    // Zone-maps cache: compile-time-embedded RON, parsed once per process (ADR-0089).
    let zone_maps = match crate::content_cache::cached_zone_maps() {
        Ok(z) => z,
        Err(e) => {
            // Reason through json_escape (ADR-0170 D4/D5): a RON parse error is
            // exactly the shape that carries a double quote into hand-built JSON.
            log::error!(
                "{{\"evt\":\"movement_tick_error\",\"zone\":{zone},\"reason\":\"{}\"}}",
                json_escape(&e)
            );
            return Ok(()); // logged no-op: a content-load failure must not abort the tick (ADR-0066)
        }
    };
    let map = match map_for(zone, zone_maps) {
        Ok(m) => m,
        Err(e) => {
            log::error!(
                "{{\"evt\":\"movement_tick_error\",\"zone\":{zone},\"reason\":\"{}\"}}",
                json_escape(&e)
            );
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
        // Drain-time battle lock (ADR-0168 D1): while this character's player is
        // in an ongoing battle in EITHER role, SKIP the drain with the queue
        // INTACT — the same semantics the sim-harness models — normalising
        // `action` to Idle write-on-change; the lock self-releases the tick after
        // the battle's outcome leaves Ongoing. The argument is the CHARACTER's
        // own `p.identity`: `movement_tick` is scheduler-only, so `ctx.sender`
        // here is the MODULE identity and would make the guard always false.
        // `unwrap_or(false)` states a FACT — a character with no `player` row is
        // not a player and can never appear in a `battle` row, so it is not
        // battle-locked — deliberately OPPOSITE to the warp guard's ADR-0070
        // `unwrap_or(true)` POLICY below (no player row means an NPC, which must
        // stay in its home zone). Do not unify the two defaults.
        let battle_locked = ctx
            .db
            .player()
            .entity_id()
            .filter(id)
            .next()
            .map(|p| is_in_ongoing_battle(ctx, p.identity))
            .unwrap_or(false);
        if battle_locked {
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
                // Battle guard: skip the warp for a character whose player is in an
                // ongoing battle in EITHER role (ADR-0122 D1 SSOT — the former inline
                // filter saw side A only, so a PvP side-B player walked through a warp
                // tile mid-ranked-battle; ADR-0166 D4). The argument is the CHARACTER's
                // own `p.identity`: `movement_tick` is scheduler-only, so `ctx.sender`
                // here is the MODULE identity and would make the guard always false.
                // `skip_warp` is named for what it decides, NOT for "is in battle":
                // `unwrap_or(true)` means "no player row ⇒ an NPC ⇒ SKIP the warp"
                // (stay in home zone, ADR-0070), so the default must stay `true`.
                let skip_warp = ctx
                    .db
                    .player()
                    .entity_id()
                    .filter(entity_id)
                    .next()
                    .map(|p| is_in_ongoing_battle(ctx, p.identity))
                    .unwrap_or(true);
                if !skip_warp {
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
        // ADR-0166 R4, closed by ADR-0188: ask the ADR-0122 D1 both-role SSOT, not
        // a second, side-A-only implementation of the same predicate. This is
        // DEFENSIVE hygiene, not a reachable-bug fix — the ADR-0168 D1 drain lock
        // above already skipped every battle-locked character before this point,
        // and begin_encounter re-guards. Killing the divergent copy is what stops a
        // future edit to that drain lock from silently reopening R4.
        let already = is_in_ongoing_battle(ctx, player_identity);
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
        // A malformed encounter row is a rate-limited logged no-op (ADR-0170 D4):
        // the content fault must never abort the zone tick (ADR-0066), but it must
        // no longer be silent — it stops all wild encounters in this zone.
        let table = match table_from_encounter_row(&enc_row) {
            Ok(t) => t,
            Err(e) => {
                if let Some(suppressed) =
                    ENCOUNTER_TABLE_ERR_LIMITER.check(now.0, ENCOUNTER_ERR_WINDOW_MS)
                {
                    log::error!(
                        "{{\"evt\":\"encounter_table_error\",\"zone\":{zone},\"reason\":\"{}\",\"suppressed\":{suppressed}}}",
                        json_escape(&e)
                    );
                }
                continue;
            }
        };
        let seed: u32 = ctx.random();
        if let Some(w) = resolve_encounter(&table, seed, player_level) {
            // A failed begin_encounter is a rate-limited logged no-op (ADR-0170 D4):
            // one character's failure cannot abort the tick, and its own limiter
            // keeps genuine faults visible.
            if let Err(e) = begin_encounter(
                ctx,
                player_identity,
                party_ids,
                w.species_id,
                w.level.as_u8(),
                w.individuality_seed,
            ) {
                // Routine fainted-party reason filtered at source (shared const,
                // ADR-0170 D4): normal gameplay, a non-event like a None roll —
                // it must consume neither the limiter window nor the suppressed
                // counter, or a client walking grass with an all-fainted party
                // could saturate the limiter and mask genuine faults
                // (species-not-found, stat corruption), which still log below.
                if e != NO_CONSCIOUS_MONSTER_REASON {
                    if let Some(suppressed) =
                        BEGIN_ENCOUNTER_ERR_LIMITER.check(now.0, ENCOUNTER_ERR_WINDOW_MS)
                    {
                        log::error!(
                            "{{\"evt\":\"begin_encounter_error\",\"zone\":{zone},\"reason\":\"{}\",\"suppressed\":{suppressed}}}",
                            json_escape(&e)
                        );
                    }
                }
            }
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
        let st = char_state(&ch);
        let Some(dir) = npc_decide(
            current,
            home,
            npc_row.wander_radius,
            st.facing,
            entity_id,
            tick_counter,
            &map,
        ) else {
            continue;
        };
        let next_state = apply_move(&st, MoveInput::Step(dir), &map, now);
        apply_state(&mut ch, &next_state);
        // NOTE (F5): apply_state writes ONLY tile_x/tile_y/facing/action/move_started_at.
        // It does NOT write zone_id. NPC zone crossings deferred to M12c.
        ctx.db.character().entity_id().update(ch);
    }

    Ok(())
}

// movement.rs is a file-module (declared `mod movement;` in `lib.rs`), so a plain
// `mod movement_tests;` would resolve under `src/movement/`; `#[path]` keeps the
// test file a sibling in `src/` (the game-core `*_tests.rs` convention, ADR-0056 map).
#[cfg(test)]
#[path = "movement_tests.rs"]
mod movement_tests;
