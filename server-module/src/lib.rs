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
use crate::schema::{character, config, player, zone_def, Config};
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
mod raising;
mod schema;
mod taming;

// --- Crate-wide constants ---------------------------------------------------
pub(crate) const ZONE_0: u32 = 0;
/// SSOT for the seeded-content version; bump when game-core RON content changes (ADR-0054).
/// v2 (M9b-tail): items registry gained the "Power Root" training food + the
/// `train_stat`/`train_amount` columns, so deployed DBs must re-seed.
pub(crate) const CONTENT_VERSION: u32 = 3; // M10b: fusion table seeding added
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
    // One schedule row per initial zone (M2: zone 0).
    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            zone_id: ZONE_0,
            scheduled_at: ScheduleAt::Interval(
                Duration::from_millis(STEP_MS.unsigned_abs()).into(),
            ),
        });
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
