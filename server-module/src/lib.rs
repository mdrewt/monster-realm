//! monster-realm server module (SpacetimeDB 2.6 / `spacetimedb` crate 1.12).
//!
//! The imperative shell: tables + reducers validate `ctx.sender` + legality,
//! delegate rules to `game-core` (the SSOT), and write tables — rejecting with
//! `Err`, never silently clamping. Reducers are THIN.
//!
//! M0b — the `presence` walking-skeleton vertical: a client `join`s, gets exactly
//! one `presence` row keyed by its `ctx.sender` identity, `heartbeat`s to stay
//! alive, and a scheduler-only `presence_reaper` reaps the stale. Time columns are
//! `i64` ms since the unix epoch (round-trip with `game_core::Millis`). Syntax is
//! for `spacetimedb` 1.12 (CLI 2.6): `name =`, `ctx.sender`, `ctx.identity()`.

use game_core::{clamp_position, load_zones, validate_zones};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

const ZONE_DEFAULT: u32 = 0;
const MAX_NAME_LEN: usize = 24;
/// Reap presence rows not seen for this long (ghost-dot TTL).
const PRESENCE_TTL_MS: i64 = 30_000;
/// How often the scheduler runs the reaper.
const REAP_INTERVAL_MS: u64 = 10_000;

// --- Tables --------------------------------------------------------------------

/// One renderable presence dot. Keyed by the connection `Identity`, set by the
/// server from `ctx.sender` — NEVER a client-passed field. Public: clients
/// subscribe to render everyone. Carries an indexed `zone_id` (the zoned-schema
/// convention, ADR-0007; per-zone subscriptions/tick arrive at M2/M11).
#[spacetimedb::table(name = presence, public)]
pub struct Presence {
    #[primary_key]
    pub identity: Identity,
    #[index(btree)]
    pub zone_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub name: String,
    pub last_seen_ms: i64,
}

/// Singleton world config (content version for the sync-content story).
#[spacetimedb::table(name = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub content_version: u32,
}

/// Zone definitions, seeded from the `game-core` RON registry by `sync_content`.
/// Public read-only content (only the module writes it); mirrors `ZoneDef`.
#[spacetimedb::table(name = zone_def, public)]
pub struct ZoneDefRow {
    #[primary_key]
    pub zone_id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

/// Interval schedule driving `presence_reaper`.
#[spacetimedb::table(name = presence_reaper_schedule, scheduled(presence_reaper))]
pub struct PresenceReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

// --- Helpers (no game rules — pure marshaling) ---------------------------------

/// The server clock in milliseconds since the unix epoch (`ctx.timestamp`, never
/// `std::time` — the determinism gate bans wall-clock reads).
fn now_ms(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) / 1000
}

/// One structured (JSON) rejection log line: level, reducer, correlation id
/// (`sender`), reason. No PII; never a silent swallow (observability Layer 1).
fn log_reject(reducer: &str, sender: Identity, reason: &str) {
    log::warn!("{{\"evt\":\"reject\",\"reducer\":\"{reducer}\",\"sender\":\"{sender}\",\"reason\":\"{reason}\"}}");
}

/// Validate + normalize a display name (reject, don't clamp).
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

/// Idempotent upsert-by-stable-id of the zone registry (ADR-0006). Callable on
/// republish; a second call over unchanged content produces no row churn.
fn sync_content_inner(ctx: &ReducerContext) {
    let zones = match load_zones() {
        Ok(z) => z,
        Err(e) => {
            log::error!("{{\"evt\":\"sync_content_error\",\"reason\":\"{e}\"}}");
            return;
        }
    };
    if let Err(e) = validate_zones(&zones) {
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

// --- Reducers ------------------------------------------------------------------

/// First boot: seed config, sync content, and schedule the reaper.
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config { id: 0, content_version: 1 });
    sync_content_inner(ctx);
    ctx.db.presence_reaper_schedule().insert(PresenceReaperSchedule {
        id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(REAP_INTERVAL_MS).into()),
    });
    log::info!("{{\"evt\":\"init\",\"zones\":{}}}", ctx.db.zone_def().iter().count());
}

/// Re-sync content on demand (idempotent) — the republish path (ADR-0006).
#[spacetimedb::reducer]
pub fn sync_content(ctx: &ReducerContext) -> Result<(), String> {
    sync_content_inner(ctx);
    Ok(())
}

/// Remove a client's presence on disconnect (no ghost dots).
#[spacetimedb::reducer(client_disconnected)]
pub fn on_disconnect(ctx: &ReducerContext) {
    ctx.db.presence().identity().delete(ctx.sender);
}

/// Join: create EXACTLY one presence row keyed by `ctx.sender` (identity from
/// `ctx.sender` only, never a client field). Re-join updates the existing row.
#[spacetimedb::reducer]
pub fn join(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name = validate_name(&name).inspect_err(|e| log_reject("join", ctx.sender, e))?;
    let me = ctx.sender;
    let now = now_ms(ctx);
    // Default spawn at origin, clamped via game-core (proves the SSOT delegation).
    let tile_x = clamp_position(0, 1000);
    let tile_y = clamp_position(0, 1000);
    let row = Presence {
        identity: me,
        zone_id: ZONE_DEFAULT,
        tile_x,
        tile_y,
        name,
        last_seen_ms: now,
    };
    if ctx.db.presence().identity().find(me).is_some() {
        ctx.db.presence().identity().update(row);
    } else {
        ctx.db.presence().insert(row);
    }
    log::info!("{{\"evt\":\"join\",\"sender\":\"{me}\"}}");
    Ok(())
}

/// Heartbeat: refresh the caller's `last_seen_ms`. Rejects (never clamps) if the
/// caller has no presence row.
#[spacetimedb::reducer]
pub fn heartbeat(ctx: &ReducerContext) -> Result<(), String> {
    let me = ctx.sender;
    let Some(p) = ctx.db.presence().identity().find(me) else {
        let reason = "no presence row for sender (join first)";
        log_reject("heartbeat", me, reason);
        return Err(reason.to_string());
    };
    ctx.db.presence().identity().update(Presence {
        last_seen_ms: now_ms(ctx),
        ..p
    });
    Ok(())
}

/// Scheduler-only: reap presence rows older than the TTL. Scheduled reducers are
/// private-by-default in 2.x, but we defend in depth: a client `ctx.sender` is
/// never the module identity (Tier-1 #2 — accessor is `ctx.identity()`).
#[spacetimedb::reducer]
pub fn presence_reaper(
    ctx: &ReducerContext,
    _schedule: PresenceReaperSchedule,
) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("presence_reaper is scheduler-only".to_string());
    }
    let cutoff = now_ms(ctx) - PRESENCE_TTL_MS;
    let stale: Vec<Identity> = ctx
        .db
        .presence()
        .iter()
        .filter(|p| p.last_seen_ms < cutoff)
        .map(|p| p.identity)
        .collect();
    for id in stale {
        ctx.db.presence().identity().delete(id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_name;

    #[test]
    fn validate_name_trims_and_accepts() {
        assert_eq!(validate_name("  Ash  ").as_deref(), Ok("Ash"));
    }

    #[test]
    fn validate_name_rejects_empty() {
        assert!(validate_name("   ").is_err());
    }

    #[test]
    fn validate_name_rejects_overlong() {
        assert!(validate_name(&"x".repeat(25)).is_err());
    }

    #[test]
    fn validate_name_rejects_control_chars() {
        assert!(validate_name("ab\u{0007}cd").is_err());
    }

    #[test]
    fn clamp_delegates_to_game_core() {
        assert_eq!(super::clamp_position(5000, 1000), 1000);
    }
}
