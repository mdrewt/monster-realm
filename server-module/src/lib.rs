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
mod content_cache;
mod economy;
mod evolution;
mod guards;
mod inventory;
mod marshal;
mod monster_mgmt;
mod movement;
mod npc;
mod pvp;
mod raising;
mod ranking;
mod schema;
mod taming;
mod trading;

#[cfg(test)]
#[path = "m14_5d_1a_tests.rs"]
mod m14_5d_1a_tests;

// --- Crate-wide constants ---------------------------------------------------
pub(crate) const ZONE_0: u32 = 0;
/// SSOT for the seeded-content version; bump when game-core RON content changes (ADR-0054).
/// v2 (M9b-tail): items registry gained the "Power Root" training food + the
/// `train_stat`/`train_amount` columns, so deployed DBs must re-seed.
/// v3 (M10b): evolution/fusion content registries added to `sync_content` (ADR-0062).
/// v4 (M12b): NPC entity/heal_location content added to `sync_content` (ADR-0069).
/// v5 (M12c): RON-loaded NPC/dialogue/quest/heal content + NPC zone policy (ADR-0070).
/// v6 (M13b): shop items — `sell_price` added to `ItemDef` (ADR-0082).
/// v7 (M13c): quest_001 currency reward=50 (ADR-0083).
/// v8 (M14c): abilities registry added (ADR-0094).
/// v9 (M14d): weather-setting skills 7-10 added (ADR-0095).
/// v10 (M14e): status skill 11 (Toxic Sting) + Antidote item 3 (ADR-0096).
/// v11 (M14.5c): ability assignments on Flameling/Sproutlet in species content (ADR-0100).
/// v12 (M14.5d-1a): item_row gains cure_status column; re-seed required (ADR-0105).
pub(crate) const CONTENT_VERSION: u32 = 12;
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

/// Pure reconcile seam (13.5c-2): given the live zone ids and the currently
/// scheduled `(schedule row id, zone_id)` pairs, plan `(row ids to remove,
/// zone ids to add)`. Extracted from `ensure_zone_schedules` so "no schedule
/// row remains for a removed zone" is a behavioral test, not a structural one.
/// Both halves come back sorted ascending (deterministic apply order — HashSet
/// iteration order must not leak into row writes).
pub(crate) fn plan_schedule_reconcile(
    zone_ids: &[u32],
    scheduled: &[(u64, u32)],
) -> (Vec<u64>, Vec<u32>) {
    let live: std::collections::HashSet<u32> = zone_ids.iter().copied().collect();
    let scheduled_zones: std::collections::HashSet<u32> =
        scheduled.iter().map(|&(_, zone_id)| zone_id).collect();
    let mut to_remove: Vec<u64> = scheduled
        .iter()
        .filter(|&&(_, zone_id)| !live.contains(&zone_id))
        .map(|&(row_id, _)| row_id)
        .collect();
    to_remove.sort_unstable();
    let mut to_add: Vec<u32> = zone_ids
        .iter()
        .copied()
        .filter(|zone_id| !scheduled_zones.contains(zone_id))
        .collect();
    to_add.sort_unstable();
    (to_remove, to_add)
}

/// Idempotent per-zone schedule management (ADR-0066): inserts a
/// `MovementTickSchedule` row for every zone that does not yet have one, and
/// removes orphaned rows for zones that no longer exist in `zone_def` (orphaned
/// rows fire `map_for` errors every tick — remove them to prevent log-flood).
/// Called from both `init` and `sync_content`. Imperative shell: the diff is
/// owned by the pure `plan_schedule_reconcile` seam above (13.5c-2).
fn ensure_zone_schedules(ctx: &ReducerContext) {
    let zone_ids: Vec<u32> = ctx.db.zone_def().iter().map(|z| z.zone_id).collect();
    let scheduled: Vec<(u64, u32)> = ctx
        .db
        .movement_tick_schedule()
        .iter()
        .map(|s| (s.id, s.zone_id))
        .collect();
    let (to_remove, to_add) = plan_schedule_reconcile(&zone_ids, &scheduled);
    for row_id in to_remove {
        ctx.db.movement_tick_schedule().id().delete(row_id);
    }
    for zone_id in to_add {
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
}

// --- Lifecycle reducers -----------------------------------------------------
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        // Unseeded sentinel (0 != CONTENT_VERSION) so sync_content_inner ALWAYS
        // seeds on first init; the early-return only fires on a redundant re-sync.
        content_version: 0,
        owner_identity: ctx.sender,
    });
    sync_content_inner(ctx).expect("content seeding failed on init");
    ensure_zone_schedules(ctx);
    log::info!(
        "{{\"evt\":\"init\",\"zones\":{}}}",
        ctx.db.zone_def().iter().count()
    );
}

#[spacetimedb::reducer]
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
    let cfg = ctx
        .db
        .config()
        .id()
        .find(0)
        .ok_or_else(|| "sync_content: config row missing".to_string())?;
    // Zero-identity means the DB was published before M12.5b (owner_identity was not
    // yet stored in Config). `init` runs ONLY at DB creation, so a plain re-publish
    // never re-registers the owner — the only working remedy is
    // `spacetime publish --delete-data` (destructive), which re-runs `init` (13.5c-4).
    if cfg.owner_identity == Identity::from_byte_array([0u8; 32]) {
        return Err(
            "sync_content: owner_identity not registered — module was published before \
             M12.5b; `init` only runs at DB creation, so recovery requires \
             `spacetime publish --delete-data` (destructive: wipes all data) to re-run \
             init and register the owner"
                .to_string(),
        );
    }
    if ctx.sender != cfg.owner_identity {
        return Err("sync_content: caller is not the module owner".to_string());
    }
    sync_content_inner(ctx)?;
    ensure_zone_schedules(ctx);
    Ok(())
}

#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender;
    // Cancel any active trade offers (TR-18, ADR-0106). Must run before player row
    // deletion so the offer lookup still resolves player identity. No assets move —
    // assets are never physically escrowed (ADR-0106 D3). Uses indexed filters.
    trading::cancel_trades_on_disconnect(ctx, me);
    // Forfeit any ongoing PvP battle (M16, ADR-0109 D8). Must run before player row
    // deletion so identity lookups in write_back still resolve.
    pvp::forfeit_on_disconnect(ctx, me);
    // Cancel pending outgoing PvP challenges (M16, ADR-0109 D9).
    pvp::cancel_challenges_on_disconnect(ctx, me);
    // Clean up transient conversation row so a reconnecting player cannot
    // advance a stale dialogue from a different zone/position (RT-ADV-01).
    ctx.db.player_conversation().owner_identity().delete(me);
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.character().entity_id().delete(p.entity_id);
        ctx.db.player().identity().delete(me);
    }
}
