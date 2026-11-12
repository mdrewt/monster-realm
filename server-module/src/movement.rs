//! `movement` — server-module domain submodule.
//!
//! Server-paced, per-zone movement: clients buffer intent in the PRIVATE
//! `move_intent` table (an accepted input writes that one row and no public
//! row); the scheduled `movement_tick` drains at most one move/character/tick (a
//! character whose player is in an ongoing battle drains none — its queue stays
//! frozen), publishes the remaining queue and the accepted seq on the
//! `character` row it writes, and runs the grass-encounter trigger, which opens a TACTICAL wild battle through
//! `tactics::start_wild_tactical` (bt-16: the one live wild path). The
//! A zone ticks only while a player's character is in it (`arm_zone_tick` on
//! entry; the tick that finds the zone empty sends its NPCs home and removes the
//! schedule). The `movement_tick_schedule` scheduled `#[table]`
//! lives HERE (not `schema.rs`) so the `scheduled(movement_tick)` attribute
//! reference resolves within the module.

use crate::battle::{lead_party, lead_party_ids, NO_CONSCIOUS_MONSTER_REASON};
use crate::evolution::check_and_evolve;
use crate::guards::{
    authorize_move, escrowed_monster_ids_of, is_in_ongoing_battle, json_escape, log_reject,
    validate_name,
};
use crate::marshal::{
    apply_state, char_state, monster_from_instance, now_ms, pub_from_monster,
    table_from_encounter_row,
};
use crate::raising::accrue_quality_time;
use crate::schema::{
    character, encounter, monster, monster_pub, move_intent, npc, player, player_conversation,
    species_row, Character, MoveIntent, Player, PlayerConversation,
};
use crate::tactics::start_wild_tactical;
use crate::{SPRITE_PLAYER, STARTER_SPECIES_ID, ZONE_0};
use game_core::npc::rules::{in_talk_range, npc_step_due};
use game_core::{
    apply_move, npc_decide, resolve_encounter, roll_starter, spawn, stepped_onto_grass,
    ActionState, Direction, Millis, MoveInput, StatBlock, TilePos, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::{ReducerContext, ScheduleAt, Table};
use std::sync::Mutex;
use std::time::Duration;

/// Per-zone movement schedule: an interval row makes the scheduler call
/// `movement_tick` for THAT zone every `STEP_MS`. A zone holds a row only while a
/// player's character is in it: `arm_zone_tick` inserts it on entry and the tick
/// that finds the zone empty deletes it, so an empty zone costs no reducer call.
#[spacetimedb::table(accessor = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub zone_id: u32,
    pub scheduled_at: ScheduleAt,
}

/// Arm `zone_id`'s tick. Idempotent: a zone that already holds a schedule row
/// keeps that row, so there is never more than one tick per zone per `STEP_MS`.
/// Called by every path that puts a player's character into a zone (`join_game`,
/// the tick's warp arm) and by the content sync's reconcile. The scan is over at
/// most one row per occupied zone.
pub(crate) fn arm_zone_tick(ctx: &ReducerContext, zone_id: u32) {
    if ctx
        .db
        .movement_tick_schedule()
        .iter()
        .any(|s| s.zone_id == zone_id)
    {
        return;
    }
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id,
            scheduled_at: ScheduleAt::Interval(
                Duration::from_millis(STEP_MS.unsigned_abs()).into(),
            ),
        });
}

/// Is this character a player's? The `player` row is the one fact that separates
/// a player's character from an NPC's.
fn is_player_character(ctx: &ReducerContext, entity_id: u64) -> bool {
    ctx.db
        .player()
        .entity_id()
        .filter(entity_id)
        .next()
        .is_some()
}

/// Put every NPC of `zone` back on its home tile, Idle. NPC position is ambient
/// state: nobody is in the zone to see it, and the next player to enter finds
/// each NPC where its content places it. Writes only the rows that differ.
fn reset_npcs_home(ctx: &ReducerContext, zone: u32) {
    let npcs: Vec<(u64, i32, i32)> = ctx
        .db
        .npc()
        .zone_id()
        .filter(zone)
        .map(|n| (n.entity_id, n.home_x, n.home_y))
        .collect();
    for (entity_id, home_x, home_y) in npcs {
        let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else {
            continue;
        };
        if ch.tile_x == home_x && ch.tile_y == home_y && ch.action == ActionState::Idle {
            continue;
        }
        ch.tile_x = home_x;
        ch.tile_y = home_y;
        ch.action = ActionState::Idle;
        ctx.db.character().entity_id().update(ch);
    }
}

/// Join: one `player` + one `character` at the spawn + its `move_intent` row + one starter `monster`
/// (idempotent: a returning player gets character+player only, not a second
/// monster). Rejects a double-join within the same session.
#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "join_game")?;
    let me = ctx.sender();
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
        acked_seq: 0,
    });
    // Created here so a move reducer finds the row and never takes its seeding branch.
    ctx.db.move_intent().insert(MoveIntent {
        entity_id: ch.entity_id,
        queue: Vec::new(),
        last_input_seq: 0,
    });
    ctx.db.player().insert(Player {
        identity: me,
        entity_id: ch.entity_id,
        name,
        online: true,
        last_input_seq: 0,
    });
    arm_zone_tick(ctx, ZONE_0);

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
        // FRESH tier: creation site — the species row is in hand.
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

/// The `move_intent` row for a character that has none: a session that joined
/// before the table existed. It starts from what the character row publishes, so
/// queued steps survive, and from the higher of the two seq columns, so the
/// guard never moves backwards (`player.last_input_seq` held it before
/// `character.acked_seq` did).
pub(crate) fn seed_intent(ch: &Character, player: Option<&Player>) -> MoveIntent {
    MoveIntent {
        entity_id: ch.entity_id,
        queue: ch.move_queue.clone(),
        last_input_seq: ch.acked_seq.max(player.map_or(0, |p| p.last_input_seq)),
    }
}

/// Copy the private queue and seq onto the character row. Returns whether the
/// row changed, so a tick that has nothing new to tell the owner writes nothing.
/// Every `movement_tick` branch that holds an intent row publishes through here.
pub(crate) fn publish_intent(row: &mut Character, queue: &[MoveInput], seq: u64) -> bool {
    let changed = row.move_queue != queue || row.acked_seq != seq;
    if changed {
        row.move_queue = queue.to_vec();
        row.acked_seq = seq;
    }
    changed
}

/// A character that does not move this tick (nothing queued, or battle-locked):
/// publish its intent and normalise `action` to Idle, writing the row only if
/// either changed it.
fn publish_standing(ctx: &ReducerContext, mut row: Character, intent: &MoveIntent) {
    let mut dirty = publish_intent(&mut row, &intent.queue, intent.last_input_seq);
    if row.action != ActionState::Idle {
        row.action = ActionState::Idle;
        dirty = true;
    }
    if dirty {
        ctx.db.character().entity_id().update(row);
    }
}

/// Append one intent to the bounded queue (anti-flood: reject when full). Buffers
/// intent only — NEVER computes movement. One private `move_intent` write carries
/// the queue and the seq. The caller's `player` row is read for its entity id;
/// no `character` row is read, and neither table is written.
#[spacetimedb::reducer]
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "enqueue_move")?;
    // Intake battle lock: reject-not-clamp movement intent while
    // the caller is in an ongoing battle, either role. `ctx.sender()` is correct
    // here — this is a player-called reducer (unlike scheduler-only movement_tick).
    if is_in_ongoing_battle(ctx, ctx.sender()) {
        let e = "cannot move during an ongoing battle".to_string();
        log_reject("enqueue_move", ctx.sender(), &e);
        return Err(e);
    }
    let mut intent = authorize_move(ctx, "enqueue_move", seq)?;
    if intent.queue.len() >= MOVE_QUEUE_CAP {
        let e = "queue full".to_string();
        log_reject("enqueue_move", ctx.sender(), &e);
        return Err(e);
    }
    intent.queue.push(input);
    ctx.db.move_intent().entity_id().update(intent);
    // THE movement call site — a genuinely player-triggered reducer
    // (never movement_tick). Once per party monster over lead_party's
    // FULL id list (not just the lead); accrual first, auto-evolution
    // check LAST. No party -> credit nothing.
    if let Some(party_ids) = lead_party_ids(ctx, ctx.sender()) {
        // Trade escrow: an escrowed party monster keeps its
        // party slot until settlement, so without this it would keep accruing
        // Quality Time and could AUTO-EVOLVE out from under the counterparty's
        // propose-time card snapshot (confirm_trade never revalidates it).
        // Collect the caller's escrowed ids ONCE, from BOTH trade roles (the
        // guards wrapper owns that read), and SKIP those monsters — never
        // reject the move (a pending offer must not freeze the player).
        // Collected inside this arm on purpose: a caller with no party pays
        // zero trade-offer index reads on the hottest reducer in the game.
        let escrowed = escrowed_monster_ids_of(ctx, ctx.sender());
        for mid in party_ids {
            if escrowed.contains(&mid) {
                continue;
            }
            // PERF: walking can only move the Quality-Time gate, so the
            // eligibility read runs only when this call actually minted a
            // tick. The other call sites check unconditionally — they mutate
            // other gate values.
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
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "set_move")?;
    // Intake battle lock: same reject as enqueue_move — set_move
    // also ADDS movement intent, and the client is hostile.
    if is_in_ongoing_battle(ctx, ctx.sender()) {
        let e = "cannot move during an ongoing battle".to_string();
        log_reject("set_move", ctx.sender(), &e);
        return Err(e);
    }
    let mut intent = authorize_move(ctx, "set_move", seq)?;
    intent.queue.clear();
    intent.queue.push(input);
    ctx.db.move_intent().entity_id().update(intent);
    Ok(())
}

/// Empty the queue (key release).
#[spacetimedb::reducer]
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "clear_queue")?;
    // Deliberately NOT battle-guarded: pure cancellation — it
    // cannot cause movement. Guarding it would force the stale pre-battle queue
    // to survive to battle end and deny an honest key-release cancel while the
    // battle overlay is opening.
    let mut intent = authorize_move(ctx, "clear_queue", seq)?;
    intent.queue.clear();
    ctx.db.move_intent().entity_id().update(intent);
    Ok(())
}

// --- Rate-limited encounter-failure logging -------------

/// A process-static log rate limiter: at most one emit per
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
    /// earlier instant rather than suppressing until the clock catches up.
    /// A poisoned lock is recovered: one unrelated panic must not silence the
    /// encounter log path for the process lifetime.
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
/// `log::error!` per limiter per 5000 ms of the tick's injected clock.
/// A NAMED constant so both arms provably share one window value instead
/// of drifting apart.
const ENCOUNTER_ERR_WINDOW_MS: i64 = 5000;

/// Gates `encounter_table_error` logging (a failed `table_from_encounter_row`).
static ENCOUNTER_TABLE_ERR_LIMITER: RateLimiter = RateLimiter::new();

/// Gates `wild_start_error` logging. A SECOND, independent limiter on
/// purpose: the party-has-no-conscious-monster Err from
/// `start_wild_tactical` is routine gameplay (a fainted party walking grass) and
/// bursts; sharing one limiter would let that burst mask a real content
/// defect in the encounter table.
static WILD_START_ERR_LIMITER: RateLimiter = RateLimiter::new();

/// Per-zone, server-paced tick: drain ≤1 move per character in THIS zone, compute
/// the outcome via `game_core::apply_move`, write back. Scheduler-only.
///
/// The tick is the only writer of `character.move_queue` and
/// `character.acked_seq`: whenever a character's private `move_intent` pair
/// differs from the published pair, this tick writes the character row, and a
/// drained step carries position, remaining queue and seq in that one write.
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }
    let zone = sched.zone_id;
    // Snapshot BEFORE mutating (never mutate the table mid-iteration): each
    // character of the zone with its private intent row, if it has one.
    let chars: Vec<(u64, Option<MoveIntent>)> = ctx
        .db
        .character()
        .zone_id()
        .filter(zone)
        .map(|c| {
            let intent = ctx.db.move_intent().entity_id().find(c.entity_id);
            (c.entity_id, intent)
        })
        .collect();
    // A zone with no player's character in it does no work: this tick puts its
    // NPCs home and removes the schedule row, so no further tick fires until
    // `arm_zone_tick` runs for the zone. Leaving, warping out, disconnecting and
    // timing out all end here, because each of them removes the character from
    // the zone and the next tick sees the zone without it. An intent row is
    // proof of a player (only a player's character ever gets one), so a zone
    // with a player in it pays no `player` read for this; the `player` lookups
    // run only when no character has an intent row, where they find a session
    // that pre-dates `move_intent`. Checked before the map is read so a zone
    // whose content fails to load still stops ticking.
    let occupied = chars.iter().any(|(_, intent)| intent.is_some())
        || chars.iter().any(|&(id, _)| is_player_character(ctx, id));
    if !occupied {
        reset_npcs_home(ctx, zone);
        ctx.db.movement_tick_schedule().id().delete(sched.id);
        return Ok(());
    }
    let now = Millis(now_ms(ctx));
    // The zone's map: built once per process from the compile-time-embedded
    // RON, borrowed here every tick (never rebuilt per tick).
    let map = match crate::content_cache::cached_zone_tile_map(zone) {
        Ok(m) => m,
        Err(e) => {
            // Reason through json_escape: a RON parse error is
            // exactly the shape that carries a double quote into hand-built JSON.
            log::error!(
                "{{\"evt\":\"movement_tick_error\",\"zone\":{zone},\"reason\":\"{}\"}}",
                json_escape(&e)
            );
            return Ok(()); // logged no-op: a content failure must not abort the tick
        }
    };
    for (id, intent) in chars {
        let Some(mut row) = ctx.db.character().entity_id().find(id) else {
            continue;
        };
        let mut intent = match intent {
            Some(intent) => intent,
            // No intent row and nothing published to drain: an NPC, or an idle
            // session that pre-dates `move_intent`. Normalise to Idle write-on-change.
            None if row.move_queue.is_empty() => {
                if row.action != ActionState::Idle {
                    row.action = ActionState::Idle;
                    ctx.db.character().entity_id().update(row);
                }
                continue;
            }
            // A published queue with no intent row: a session that was mid-walk
            // when `move_intent` was added. Its row is created from what it published.
            None => {
                let player = ctx.db.player().entity_id().filter(id).next();
                ctx.db
                    .move_intent()
                    .insert(seed_intent(&row, player.as_ref()))
            }
        };
        if intent.queue.is_empty() {
            publish_standing(ctx, row, &intent);
            continue;
        }
        // Drain-time battle lock: while this character's player is
        // in an ongoing battle in EITHER role, SKIP the drain with the queue
        // INTACT — the same semantics the sim-harness models — normalising
        // `action` to Idle write-on-change; the lock self-releases the tick after
        // the battle's outcome leaves Ongoing. The argument is the CHARACTER's
        // own `p.identity`: `movement_tick` is scheduler-only, so `ctx.sender()`
        // here is the MODULE identity and would make the guard always false.
        // `unwrap_or(false)` states a FACT — a character with no `player` row is
        // not a player and can never appear in a `battle` row, so it is not
        // battle-locked — deliberately OPPOSITE to the warp guard
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
            // The intent queue stays intact; the owner still learns of it once.
            publish_standing(ctx, row, &intent);
            continue;
        }
        let input = intent.queue.remove(0);
        let prev = char_state(&row).pos; // capture BEFORE apply_move
        let next = apply_move(&char_state(&row), input, map, now);
        apply_state(&mut row, &next);
        let entity_id = row.entity_id; // capture before any move/borrow

        // Server-authoritative warp resolution.
        // Guard 1: only fire when the character actually MOVED (bump = no warp).
        // Guard 2: players in active battles must not be warped (C1 security finding).
        if prev != next.pos {
            if let Some(warp) = map.warp_at(next.pos) {
                // Copy scalars out of the WarpDef borrow BEFORE mutating row.
                let (to_zone, tx, ty) = (warp.to_zone, warp.to_tile.x, warp.to_tile.y);
                // Battle guard: skip the warp for a character whose player is in an
                // ongoing battle in EITHER role. The argument is the CHARACTER's own
                // `p.identity`: `movement_tick` is scheduler-only, so `ctx.sender()`
                // here is the MODULE identity and would make the guard always false.
                // `skip_warp` is named for what it decides, NOT for "is in battle":
                // `unwrap_or(true)` means "no player row ⇒ an NPC ⇒ SKIP the warp"
                // (stay in home zone), so the default must stay `true`.
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
                    intent.queue.clear(); // clear queued moves across zone boundary
                    row.action = ActionState::Idle; // arrive idle in new zone
                    publish_intent(&mut row, &intent.queue, intent.last_input_seq);
                    ctx.db.character().entity_id().update(row);
                    ctx.db.move_intent().entity_id().update(intent);
                    arm_zone_tick(ctx, to_zone);
                    // skip grass-encounter trigger — a warp step is not a grass step
                    continue;
                }
            }
        }

        // Normal (non-warp) path — ONE character write carries position, the
        // post-drain queue and the accepted seq.
        publish_intent(&mut row, &intent.queue, intent.last_input_seq);
        ctx.db.character().entity_id().update(row);
        ctx.db.move_intent().entity_id().update(intent);

        // M8c grass-encounter trigger. EVERY failure mode below is a
        // no-op, never a panic. Draw `ctx.random()` only after `stepped_onto_grass` +
        // player + not-already-in-battle pass — once for the trigger roll and, on a hit,
        // twice more for the writer's seeds — so A's hit cannot shift B's roll in the
        // same tick (R-E).
        if !stepped_onto_grass(prev, next.pos, map) {
            continue;
        }
        // Player-only: an NPC character has no `player` row → no encounter.
        let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
            continue;
        };
        let player_identity = player.identity;
        // ask the both-role SSOT, not a second, side-A-only implementation of the
        // same predicate. This is DEFENSIVE hygiene, not a reachable-bug fix — the
        // drain lock above already skipped every battle-locked character before
        // this point, and start_wild_tactical re-guards.
        let already = is_in_ongoing_battle(ctx, player_identity);
        if already {
            continue;
        }
        // Lead party level (no party → no-op); the writer re-reads the party itself.
        let Some((_, player_level)) = lead_party(ctx, player_identity) else {
            continue;
        };
        // The zone's PRIVATE encounter table (partial-sync: missing row → no-op). The
        // trigger rolls on this row; the writer re-reads the same registry through
        // `content()` — both are `sync_content` projections of one RON table.
        let Some(enc_row) = ctx.db.encounter().zone_id().find(zone) else {
            continue;
        };
        // A malformed encounter row is a rate-limited logged no-op:
        // the content fault must never abort the zone tick, but it must
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
        if resolve_encounter(&table, seed, player_level).is_some() {
            // The trigger fired: the tactical writer rolls the pack, the map and every wild from
            // `encounter_seed`; `battle_seed` alone feeds the private roll stream (bt-16).
            // A refused start is a rate-limited logged no-op: one character's failure cannot
            // abort the tick, and its own limiter keeps genuine faults visible.
            let encounter_seed: u64 = ctx.random();
            let battle_seed: u64 = ctx.random();
            if let Err(e) =
                start_wild_tactical(ctx, player_identity, encounter_seed, battle_seed, None)
            {
                // A deletion-gated walker is refused the encounter as ROUTINE
                // gameplay, like a fainted party, so this reason must consume neither the error
                // log nor the limiter window (client-reachable at tick rate: request deletion,
                // walk grass). it skips ONLY the log/limiter arm — the encounter block is the
                // last statement of the per-character loop, so re-examine if per-character work
                // is ever appended after it. COUPLING: keyed by equality on the ONE reason
                // constant, so a per-state reason split must extend this skip.
                if e == crate::guards::REJECT_DELETION_GATED {
                    continue;
                }
                // Routine fainted-party reason filtered at source (shared const):
                // normal gameplay, a non-event like a None roll —
                // it must consume neither the limiter window nor the suppressed
                // counter, or a client walking grass with an all-fainted party
                // could saturate the limiter and mask genuine faults
                // (species-not-found, stat corruption), which still log below.
                if e != NO_CONSCIOUS_MONSTER_REASON {
                    if let Some(suppressed) =
                        WILD_START_ERR_LIMITER.check(now.0, ENCOUNTER_ERR_WINDOW_MS)
                    {
                        log::error!(
                            "{{\"evt\":\"wild_start_error\",\"zone\":{zone},\"reason\":\"{}\",\"suppressed\":{suppressed}}}",
                            json_escape(&e)
                        );
                    }
                }
            }
        }
    }

    // NPC wander: deterministic, cadence-gated wander via game_core::npc_decide.
    // The tick counter is the server clock in `STEP_MS` units, never a count of
    // ticks that ran: it keeps advancing while a zone's schedule is removed, so a
    // zone that empties and is entered again cannot replay or rewind an NPC's
    // step sequence.
    let tick_counter: u64 = now.0.unsigned_abs() / (STEP_MS.unsigned_abs().max(1));
    let npc_entity_ids: Vec<u64> = ctx
        .db
        .npc()
        .zone_id()
        .filter(zone)
        .map(|n| n.entity_id)
        .collect();
    // QF5.1: an NPC in a live conversation never moves. A full scan: `npc_entity_id`
    // has no index, and the table holds at most one row per player (deleted on
    // disconnect). Skipped when the zone has no NPCs.
    let conversing: Vec<u64> = if npc_entity_ids.is_empty() {
        Vec::new()
    } else {
        ctx.db
            .player_conversation()
            .iter()
            .filter(|c| npc_entity_ids.contains(&c.npc_entity_id))
            .filter(|c| conversation_is_live(ctx, c, zone))
            .map(|c| c.npc_entity_id)
            .collect()
    };
    for entity_id in npc_entity_ids {
        // QF5.2: the game-core cadence decides WHEN an NPC may step at all.
        if !npc_step_due(entity_id, tick_counter) || conversing.contains(&entity_id) {
            continue;
        }
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
            map,
        ) else {
            continue;
        };
        let next_state = apply_move(&st, MoveInput::Step(dir), map, now);
        apply_state(&mut ch, &next_state);
        // NOTE (F5): apply_state writes ONLY tile_x/tile_y/facing/action/move_started_at.
        // It does NOT write zone_id. NPC zone crossings deferred to M12c.
        ctx.db.character().entity_id().update(ch);
    }

    Ok(())
}

/// A conversation pins its NPC only while the owner's character is in `zone` and
/// within talk range of the NPC: a row left behind by a player who walked off (or
/// idles elsewhere) must not freeze the NPC for everyone.
fn conversation_is_live(ctx: &ReducerContext, conv: &PlayerConversation, zone: u32) -> bool {
    let Some(owner) = ctx.db.player().identity().find(conv.owner_identity) else {
        return false;
    };
    let chars = ctx.db.character().entity_id();
    let (Some(me), Some(npc_ch)) = (chars.find(owner.entity_id), chars.find(conv.npc_entity_id))
    else {
        return false;
    };
    me.zone_id == zone && in_talk_range(char_state(&me).pos, char_state(&npc_ch).pos)
}

// movement.rs is a file-module (declared `mod movement;` in `lib.rs`), so a plain
// `mod movement_tests;` would resolve under `src/movement/`; `#[path]` keeps the
// test file a sibling in `src/`.
#[cfg(test)]
#[path = "movement_tests.rs"]
mod movement_tests;
