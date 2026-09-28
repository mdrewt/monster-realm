//! monster-realm server module (`spacetimedb` crate 2.8.1, lockstep with the 2.8.1 host).
//!
//! The authoritative imperative shell: tables hold the world's truth; reducers are
//! the ONLY writers. Reducers are THIN — validate `ctx.sender()` + legality, delegate
//! the rule to `game-core` (the SSOT `apply_move`), write tables; reject with `Err`,
//! never clamp. Movement is **server-paced and per-zone**: clients
//! buffer intent; a per-zone scheduled `movement_tick` drains one move/character/tick.
//! Time columns are `i64` ms (round-trip `game_core::Millis`). Syntax: crate 2.x.
//!
//! The former monolith is split into cohesive domain submodules.
//! This `lib.rs` is reduced to module wiring + crate-wide constants + the three
//! lifecycle reducers (`init` / `sync_content` / `on_disconnect`).

use crate::content::sync_content_inner;
use crate::movement::{movement_tick_schedule, MovementTickSchedule};
use crate::schema::{
    character, config, player, player_conversation, player_session, zone_def, Config, PlayerSession,
};
use game_core::STEP_MS;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

// --- Domain modules ---------
mod accounts;
mod battle;
mod content;
mod content_cache;
mod economy;
mod evolution;
mod guards; // Bare and unconditional by contract — a target-selected wasm twin of this module is a review stop; gated by the rb77_ tests in guards_tests.rs
mod inventory;
mod marshal;
mod monster_mgmt;
mod movement;
mod npc;
mod observability;
mod playtest;
mod privacy;
mod pvp;
mod raising;
mod ranking;
mod schema;
mod taming;
mod trading;

#[cfg(test)]
#[path = "native_host_tests.rs"]
mod native_host_tests;

#[cfg(test)]
#[path = "privacy_enforcement_tests.rs"]
mod privacy_enforcement_tests;

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

// --- Crate-wide constants ---------------------------------------------------
pub(crate) const ZONE_0: u32 = 0;
/// SSOT for the seeded-content version; bump when game-core RON content changes.
pub(crate) const CONTENT_VERSION: u32 = 23;
pub(crate) const SPRITE_PLAYER: u32 = 0;
pub(crate) const MAX_NAME_LEN: usize = 24;
pub(crate) const MAX_PARTY_SIZE: u8 = game_core::PARTY_SIZE; // SSOT
pub(crate) const STARTER_SPECIES_ID: u32 = 1;
/// 255 sentinel = monster is in the box (not in any party slot).
pub(crate) const PARTY_SLOT_NONE: u8 = game_core::PARTY_SLOT_NONE; // SSOT
/// Zero-byte sentinel identity for the unowned wild opponent of a grass encounter.
/// No real connection holds this identity, so a wild battle's
/// `opponent_identity` can never collide with a player's.
pub(crate) const WILD_IDENTITY: Identity = Identity::from_byte_array([0u8; 32]);
/// anonymization sentinel: the identity stamped onto
/// a deleted party's side of a surviving `battle` row. The VALUE is game-core's
/// `TOMBSTONE_IDENTITY_BYTES` SSOT (all 0xFF) — distinct by construction from
/// the all-zero `WILD_IDENTITY` above, so an anonymized PvP battle can never be
/// reclassified as wild by the `guards.rs` wild checks. Declared HERE, not in
/// accounts.rs, whose guest-claim gate bans the byte-array constructor.
pub(crate) const TOMBSTONE_IDENTITY: Identity =
    Identity::from_byte_array(game_core::TOMBSTONE_IDENTITY_BYTES);

// --- Private helpers --------------------------------------------------------

/// Pure reconcile seam: given the live zone ids and the currently
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

/// Idempotent per-zone schedule management: inserts a
/// `MovementTickSchedule` row for every zone that does not yet have one, and
/// removes orphaned rows for zones that no longer exist in `zone_def` (orphaned
/// rows fire `map_for` errors every tick — remove them to prevent log-flood).
/// Called from both `init` and `sync_content`. Imperative shell: the diff is
/// owned by the pure `plan_schedule_reconcile` seam above.
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
        owner_identity: ctx.sender(),
    });
    sync_content_inner(ctx).expect("content seeding failed on init");
    ensure_zone_schedules(ctx);
    crate::playtest::ensure_playtest_reaper(ctx);
    crate::observability::ensure_mr_heartbeat(ctx);
    crate::accounts::ensure_deletion_reapers_armed(ctx);
    crate::privacy::ensure_export_bundle_reaper(ctx);
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
    // `spacetime publish --delete-data` (destructive), which re-runs `init`.
    if cfg.owner_identity == Identity::from_byte_array([0u8; 32]) {
        return Err(
            "sync_content: owner_identity not registered — module was published before \
             M12.5b; `init` only runs at DB creation, so recovery requires \
             `spacetime publish --delete-data` (destructive: wipes all data) to re-run \
             init and register the owner"
                .to_string(),
        );
    }
    if ctx.sender() != cfg.owner_identity {
        return Err("sync_content: caller is not the module owner".to_string());
    }
    sync_content_inner(ctx)?;
    ensure_zone_schedules(ctx);
    crate::playtest::ensure_playtest_reaper(ctx);
    crate::observability::ensure_mr_heartbeat(ctx);
    crate::accounts::ensure_deletion_reapers_armed(ctx);
    crate::privacy::ensure_export_bundle_reaper(ctx);
    Ok(())
}

/// Lifecycle: record the live connection, then lazy-provision or touch an
/// `account`. Anonymous play is FIRST-CLASS. Returning `Err`
/// from this hook DISCONNECTS the client (crate doc), so no fallible statement
/// precedes the `has_jwt()` early return: the JWT test is hoisted
/// into a bool, the session record (`open_player_session`
/// runs for EVERY connection including anonymous ones, and only then does the
/// JWT-less path return `Ok`.
/// The vendor's canonical example for this hook REJECTS JWT-less connections —
/// that pattern is NOT copied here. All provisioning logic lives in
/// `accounts.rs`; this hook only branches on presence of a
/// JWT and delegates.
#[spacetimedb::reducer(client_connected)]
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String> {
    let jwt = ctx.sender_auth().has_jwt();
    open_player_session(ctx);
    if !jwt {
        return Ok(());
    }
    accounts::provision_or_touch_account(ctx)
}

/// Force-resolve every live interaction for `identity` — the four resolver
/// calls verbatim, in the original `on_disconnect` order.
/// Shared by BOTH `on_disconnect` and the deletion cascade
/// (`accounts::account_deletion_reaper`), so a future fifth resolver added to
/// this bundle is picked up by both callers automatically. The bundle is the
/// DISPATCH list, never a table-census-derived wrapper set — a census-derived
/// list silently drops the wild-battle resolve (no reaper covers wild rows)
/// and soft-locks the abandoned battle forever. Performs no row write itself;
/// each callee owns its own tables' writes. Call order notes, unchanged from
/// the original body: trades cancel before any player-row deletion so the
/// offer lookup still resolves identity (no assets move —
/// never physically escrowed); the PvP forfeit and the
/// wild resolve both need identity lookups in write_back to resolve; the
/// challenge-cancel is order-immaterial vs the other three (disjoint row
/// classes).
pub(crate) fn resolve_all_live_interactions(ctx: &ReducerContext, identity: Identity) {
    trading::cancel_trades_on_disconnect(ctx, identity);
    pvp::forfeit_on_disconnect(ctx, identity);
    battle::resolve_wild_battle_on_disconnect(ctx, identity);
    pvp::cancel_challenges_on_disconnect(ctx, identity);
}

/// erase the `character` row reachable via the live `player` anchor's
/// `entity_id` join — strictly BEFORE the player display-name tombstone
/// write (the spec's character-before-player order pin). Usually a no-op:
/// presence rows are deleted on disconnect, so only a connected-at-fire
/// session has one. Never touches the `player` row itself (it survives as
/// the anchor).
pub(crate) fn erase_character_rows(ctx: &ReducerContext, owner: Identity) {
    if let Some(p) = ctx.db.player().identity().find(owner) {
        ctx.db.character().entity_id().delete(p.entity_id);
    }
}

/// Record the connection that just opened. Infallible on
/// purpose — it runs BEFORE `on_connect`'s anonymous early return, where an
/// `Err` or a panic would reject the connection. `client_connected` always
/// carries a connection id (vendor lifecycle contract); the `None` arm is the
/// native-test/`init`-style context and records nothing. Delete-before-insert
/// keeps a re-entrant hook for an id that already holds a row from panicking on
/// the PK (the vendor's `insert_or_update` is `unstable`-gated). Names ONLY the
/// `player_session` accessor — the wiring pin freezes that.
fn open_player_session(ctx: &ReducerContext) {
    let Some(conn) = ctx.connection_id() else {
        return;
    };
    ctx.db.player_session().connection_id().delete(conn);
    ctx.db.player_session().insert(PlayerSession {
        connection_id: conn,
        identity: ctx.sender(),
    });
}

/// Does `identity` still have a live connection on record? THE decision
/// `on_disconnect` makes: the disconnecting connection's
/// own row is deleted first, so a `true` here means ANOTHER socket — a second
/// tab, a reconnect that overlapped the old socket's lagging close, or a real
/// session shadowed by an ephemeral HTTP reducer call — is still live and the
/// force-resolves must not fire. Read-only, so the native host executes it.
pub(crate) fn has_live_session(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db
        .player_session()
        .identity()
        .filter(identity)
        .next()
        .is_some()
}

/// erase every `player_session` row `owner` holds — presence bookkeeping
/// goes with the presence rows. A subject deleted while connected keeps
/// such a row until this step; afterwards that socket's own close is
/// last-out and runs the legacy cleanup, which is right for a tombstoned
/// account.
pub(crate) fn erase_player_sessions(ctx: &ReducerContext, owner: Identity) {
    ctx.db.player_session().identity().delete(owner);
}

/// Lifecycle: the disconnecting socket's row goes first; the trade / PvP /
/// wild-battle / challenge force-resolves and the presence deletes run ONLY
/// when no other connection of this identity is on record.
/// A lone ephemeral connection is still last-out, so a CLI `join_game` still
/// leaves no presence row.
#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    let me = ctx.sender();
    let leaving = ctx.connection_id();
    if let Some(conn) = leaving {
        ctx.db.player_session().connection_id().delete(conn);
    }
    if has_live_session(ctx, me) {
        return;
    }
    // Resolve live trades / PvP / wild battles / challenges.
    // Must run before the player-row deletion below so identity lookups still
    // resolve.
    resolve_all_live_interactions(ctx, me);
    // Clean up transient conversation row so a reconnecting player cannot
    // advance a stale dialogue from a different zone/position.
    ctx.db.player_conversation().owner_identity().delete(me);
    if let Some(p) = ctx.db.player().identity().find(me) {
        ctx.db.character().entity_id().delete(p.entity_id);
        ctx.db.player().identity().delete(me);
    }
}
