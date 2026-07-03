//! monster-realm server module (SpacetimeDB 2.6 / `spacetimedb` crate 1.12).
//!
//! The authoritative imperative shell: tables hold the world's truth; reducers are
//! the ONLY writers. Reducers are THIN — validate `ctx.sender` + legality, delegate
//! the rule to `game-core` (the SSOT `apply_move`), write tables; reject with `Err`,
//! never clamp. Movement is **server-paced and per-zone** (ADR-0011/0007): clients
//! buffer intent; a per-zone scheduled `movement_tick` drains one move/character/tick.
//! Time columns are `i64` ms (round-trip `game_core::Millis`). Syntax: crate 1.12.
//!
//! M8.9 (ADR-0056): the former monolith is split into cohesive domain submodules.
//! This `lib.rs` is reduced to module wiring + crate-wide constants + the three
//! lifecycle reducers (`init` / `sync_content` / `on_disconnect`). The module map
//! below is the canonical `touches:` vocabulary — keep the file names stable.

use crate::content::sync_content_inner;
use crate::movement::{movement_tick_schedule, MovementTickSchedule};
use crate::schema::{character, config, player, player_conversation, zone_def, Config};
use game_core::STEP_MS;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

// --- Domain modules (the canonical `touches:` vocabulary, ADR-0056) ---------
mod battle;
mod content;
mod evolution;
mod guards;
mod inventory;
mod marshal;
mod monster_mgmt;
mod movement;
mod npc;
mod raising;
mod schema;
mod taming;

// --- Crate-wide constants ---------------------------------------------------
pub(crate) const ZONE_0: u32 = 0;
/// SSOT for the seeded-content version; bump when game-core RON content changes (ADR-0054).
/// v2 (M9b-tail): items registry gained the "Power Root" training food + the
/// `train_stat`/`train_amount` columns, so deployed DBs must re-seed.
pub(crate) const CONTENT_VERSION: u32 = 4; // M12b: NPC + dialogue + quest + heal location seeding
pub(crate) const SPRITE_PLAYER: u32 = 0;
pub(crate) const MAX_NAME_LEN: usize = 24;
pub(crate) const MAX_PARTY_SIZE: u8 = game_core::PARTY_SIZE; // SSOT (ADR-0052)
pub(crate) const STARTER_SPECIES_ID: u32 = 1;
/// 255 sentinel = monster is in the box (not in any party slot).
pub(crate) const PARTY_SLOT_NONE: u8 = game_core::PARTY_SLOT_NONE; // SSOT (ADR-0052)
/// Zero-byte sentinel identity for the unowned wild opponent of a grass encounter
/// (ADR-0045). No real connection holds this identity, so a wild battle's
/// `opponent_identity` can never collide with a player's.
pub(crate) const WILD_IDENTITY: Identity = Identity::from_byte_array([0u8; 32]);

// --- Private helpers --------------------------------------------------------

/// Idempotent per-zone schedule management (ADR-0066): inserts a
/// `MovementTickSchedule` row for every zone that does not yet have one, and
/// removes orphaned rows for zones that no longer exist in `zone_def` (orphaned
/// rows fire `map_for` errors every tick — remove them to prevent log-flood).
/// Called from both `init` and `sync_content`.
fn ensure_zone_schedules(ctx: &ReducerContext) {
    let zone_ids: std::collections::HashSet<u32> =
        ctx.db.zone_def().iter().map(|z| z.zone_id).collect();
    let scheduled_rows: Vec<_> = ctx.db.movement_tick_schedule().iter().collect();
    let scheduled: std::collections::HashSet<u32> =
        scheduled_rows.iter().map(|s| s.zone_id).collect();
    // Remove orphaned schedule rows (zone removed from content).
    for s in &scheduled_rows {
        if !zone_ids.contains(&s.zone_id) {
            ctx.db.movement_tick_schedule().id().delete(s.id);
        }
    }
    // Insert missing schedule rows (zone newly added to content).
    for zone_id in &zone_ids {
        if !scheduled.contains(zone_id) {
            ctx.db
                .movement_tick_schedule()
                .insert(MovementTickSchedule {
                    id: 0,
                    zone_id: *zone_id,
                    scheduled_at: ScheduleAt::Interval(
                        Duration::from_millis(STEP_MS.unsigned_abs()).into(),
                    ),
                });
        }
    }
}

// --- Lifecycle reducers -----------------------------------------------------
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        // Unseeded sentinel (0 != CONTENT_VERSION) so sync_content_inner ALWAYS
        // seeds on first init; the early-return only fires on a redundant re-sync.
        content_version: 0,
    });
    sync_content_inner(ctx);
    ensure_zone_schedules(ctx);
    log::info!(
        "{{\"evt\":\"init\",\"zones\":{}}}",
        ctx.db.zone_def().iter().count()
    );
}

#[spacetimedb::reducer]
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("sync_content is module-only".to_string());
    }
    sync_content_inner(ctx);
    ensure_zone_schedules(ctx); // idempotent schedule management (ADR-0066)
    Ok(())
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender;
    // Clean up transient conversation row so a reconnecting player cannot
    // advance a stale dialogue from a different zone/position (RT-ADV-01).
    ctx.db.player_conversation().owner_identity().delete(me);
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.character().entity_id().delete(p.entity_id);
        ctx.db.player().identity().delete(me);
    }
}
