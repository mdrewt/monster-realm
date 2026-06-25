//! monster-realm server module (SpacetimeDB 2.6 / `spacetimedb` crate 1.12).
//!
//! The authoritative imperative shell: tables hold the world's truth; reducers are
//! the ONLY writers. Reducers are THIN — validate `ctx.sender` + legality, delegate
//! the rule to `game-core` (the SSOT `apply_move`), write tables; reject with `Err`,
//! never clamp. Movement is **server-paced and per-zone** (ADR-0011/0007): clients
//! buffer intent; a per-zone scheduled `movement_tick` drains one move/character/tick.
//! Time columns are `i64` ms (round-trip `game_core::Millis`). Syntax: crate 1.12.

use game_core::{
    apply_move, spawn, zone_0, ActionState, CharacterState, Direction, Millis, MoveInput, TileMap,
    TilePos, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

const ZONE_0: u32 = 0;
const SPRITE_PLAYER: u32 = 0;
const MAX_NAME_LEN: usize = 24;

// --- Tables (additive, ADR-0006; world tables carry an indexed zone_id, ADR-0007) ---

/// One renderable entity. The enum/queue columns are the EXACT M1 `game-core`
/// types (the shared type IS the schema, never re-declared). `move_queue` is
/// bounded + public so the owner's client reconciles against the undrained queue.
#[spacetimedb::table(name = character, public)]
pub struct Character {
    #[primary_key]
    #[auto_inc]
    pub entity_id: u64,
    #[index(btree)]
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub facing: Direction,
    pub action: ActionState,
    pub move_started_at_ms: i64,
    pub sprite_id: u32,
    pub move_queue: Vec<MoveInput>,
}

/// Links a connection identity to its character. `last_input_seq` is the
/// reconciliation ack (set at accept-time) — NEVER trusted for authority.
#[spacetimedb::table(name = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub entity_id: u64,
    pub name: String,
    pub online: bool,
    pub last_input_seq: u64,
}

/// Singleton world config.
#[spacetimedb::table(name = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub content_version: u32,
}

/// Zone definitions seeded from the `game-core` RON registry by `sync_content`.
#[spacetimedb::table(name = zone_def, public)]
pub struct ZoneDefRow {
    #[primary_key]
    pub zone_id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

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

// --- Helpers (no game rules — pure marshaling) --------------------------------

fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000
}

fn log_reject(reducer: &str, sender: Identity, reason: &str) {
    log::warn!("{{\"evt\":\"reject\",\"reducer\":\"{reducer}\",\"sender\":\"{sender}\",\"reason\":\"{reason}\"}}");
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be at most {MAX_NAME_LEN} characters"));
    }
    if name.chars().any(char::is_control) {
        return Err("name contains invalid characters".to_string());
    }
    Ok(name.to_string())
}

/// The map for a zone (M2: one authored zone; `map_for(zone_id)` generalizes at M11).
fn zone_map(_zone_id: u32) -> TileMap {
    zone_0()
}

// `convert` seam: flatten `game-core::CharacterState` <-> `character` columns. The
// shared type stays the SSOT while the table stays queryable. Intentionally
// repetitive — DRY does not cross the marshaling boundary.
fn char_state(row: &Character) -> CharacterState {
    CharacterState {
        pos: TilePos { x: row.tile_x, y: row.tile_y },
        facing: row.facing,
        action: row.action,
        move_started_at: Millis(row.move_started_at_ms),
    }
}

fn apply_state(row: &mut Character, next: &CharacterState) {
    row.tile_x = next.pos.x;
    row.tile_y = next.pos.y;
    row.facing = next.facing;
    row.action = next.action;
    row.move_started_at_ms = next.move_started_at.0;
}

fn sync_content_inner(ctx: &ReducerContext) {
    let zones = match game_core::load_zones() {
        Ok(z) => z,
        Err(e) => {
            log::error!("{{\"evt\":\"sync_content_error\",\"reason\":\"{e}\"}}");
            return;
        }
    };
    if let Err(e) = game_core::validate_zones(&zones) {
        log::error!("{{\"evt\":\"sync_content_invalid\",\"reason\":\"{e}\"}}");
        return;
    }
    for z in &zones {
        match ctx.db.zone_def().zone_id().find(z.id) {
            Some(existing) => {
                if existing.name != z.name || existing.width != z.width || existing.height != z.height
                {
                    ctx.db.zone_def().zone_id().update(ZoneDefRow {
                        zone_id: z.id,
                        name: z.name.clone(),
                        width: z.width,
                        height: z.height,
                    });
                }
            }
            None => {
                ctx.db.zone_def().insert(ZoneDefRow {
                    zone_id: z.id,
                    name: z.name.clone(),
                    width: z.width,
                    height: z.height,
                });
            }
        }
    }
}

/// Shared ownership + monotonic-seq guard for the move reducers. Returns the
/// owned character row on success.
fn authorize_move(ctx: &ReducerContext, reducer: &str, seq: u64) -> Result<Character, String> {
    let me = ctx.sender;
    let Some(mut player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    if seq <= player.last_input_seq {
        let e = "stale seq".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    let Some(ch) = ctx.db.character().entity_id().find(player.entity_id) else {
        let e = "no character".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    // Accept-time ack: record receipt the moment intent is accepted (not applied).
    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(ch)
}

// --- Reducers -----------------------------------------------------------------

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config { id: 0, content_version: 1 });
    sync_content_inner(ctx);
    // One schedule row per initial zone (M2: zone 0).
    ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
        id: 0,
        zone_id: ZONE_0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS.unsigned_abs()).into()),
    });
    log::info!("{{\"evt\":\"init\",\"zones\":{}}}", ctx.db.zone_def().iter().count());
}

#[spacetimedb::reducer]
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
    sync_content_inner(ctx);
    Ok(())
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender;
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.character().entity_id().delete(p.entity_id);
        ctx.db.player().identity().delete(me);
    }
}

/// Join: one `player` (identity from `ctx.sender`) + one `character` at the
/// authoritative spawn. Rejects a double-join.
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
    let map = zone_map(zone);
    // Snapshot ids BEFORE mutating (never mutate the table mid-iteration).
    let ids: Vec<u64> = ctx.db.character().zone_id().filter(zone).map(|c| c.entity_id).collect();
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
        let next = apply_move(&char_state(&row), input, &map, now);
        apply_state(&mut row, &next);
        // position + drained move_queue written in ONE update (atomic, ADR-0013 §B).
        ctx.db.character().entity_id().update(row);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_state, char_state, validate_name, Character};
    use game_core::{ActionState, CharacterState, Direction, Millis, TilePos};

    fn row() -> Character {
        Character {
            entity_id: 1,
            zone_id: 0,
            tile_x: 3,
            tile_y: 4,
            facing: Direction::East,
            action: ActionState::Walking,
            move_started_at_ms: 123,
            sprite_id: 0,
            move_queue: Vec::new(),
        }
    }

    #[test]
    fn convert_seam_round_trips() {
        let r = row();
        let s = char_state(&r);
        assert_eq!(s.pos, TilePos { x: 3, y: 4 });
        assert_eq!(s.facing, Direction::East);
        assert_eq!(s.move_started_at, Millis(123));
        let mut r2 = row();
        let next = CharacterState {
            pos: TilePos { x: 9, y: 9 },
            facing: Direction::North,
            action: ActionState::Idle,
            move_started_at: Millis(500),
        };
        apply_state(&mut r2, &next);
        assert_eq!((r2.tile_x, r2.tile_y), (9, 9));
        assert_eq!(r2.facing, Direction::North);
        assert_eq!(r2.move_started_at_ms, 500);
    }

    #[test]
    fn validate_name_rejects_bad() {
        assert!(validate_name("  ").is_err());
        assert!(validate_name(&"x".repeat(25)).is_err());
        assert_eq!(validate_name("  Ash ").as_deref(), Ok("Ash"));
    }
}
