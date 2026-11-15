//! `load_dev` — server-module domain submodule.
//!
//! Load-test placement: `dev_place_in_load_zone` lets a load-driver bot move its own character to
//! one of game-core's generated load-test zones, so a run spreads its bots over many zones. Every
//! item compiles only with the `load_test_zones` feature (the `just load-host` build, which implies
//! `dev_reducers`), so no release, playtest or e2e build holds the reducer.

// Each import is gated like its only user: ungated, it would be an unused-import warning in every
// other build.
#[cfg(feature = "load_test_zones")]
use crate::guards::{is_in_ongoing_battle, log_reject};
#[cfg(feature = "load_test_zones")]
use crate::movement::dev_place_character;
#[cfg(feature = "load_test_zones")]
use crate::schema::player;
#[cfg(feature = "load_test_zones")]
use game_core::load_test_zones::{LOAD_ZONE_IDS, LOAD_ZONE_SPAWN};
#[cfg(feature = "load_test_zones")]
use spacetimedb::ReducerContext;

/// DEV/LOAD TEST: put the caller's own character on the spawn tile of load-test zone `zone_id`,
/// as a warp does: Idle, its queued moves cleared and published with the accepted seq, and the
/// zone's tick armed as a join does. Any caller may call it, for itself only (`ctx.sender()`).
///
/// It refuses an id outside the load band (so no shipped zone is reachable through it), a caller
/// with no character, and a caller in an ongoing battle, which a warp also skips. Every refusal is
/// logged and writes nothing.
#[cfg(feature = "load_test_zones")]
#[spacetimedb::reducer]
pub fn dev_place_in_load_zone(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    // Deletion gate: the first check, before any read.
    crate::guards::require_not_deleting(ctx, "dev_place_in_load_zone")?;
    let me = ctx.sender();
    let reject = |reason: &str| -> Result<(), String> {
        log_reject("dev_place_in_load_zone", me, reason);
        Err(reason.to_string())
    };
    if !LOAD_ZONE_IDS.contains(&zone_id) {
        return reject("zone is not a load zone");
    }
    let Some(caller) = ctx.db.player().identity().find(me) else {
        return reject("caller has no character");
    };
    if is_in_ongoing_battle(ctx, me) {
        return reject("cannot move during an ongoing battle");
    }
    if !dev_place_character(ctx, caller.entity_id, zone_id, LOAD_ZONE_SPAWN) {
        return reject("caller has no character");
    }
    Ok(())
}

#[cfg(test)]
#[path = "load_dev_tests.rs"]
mod load_dev_tests;
