//! Tactical battles (M-battle-tactics bt-8) — the wild engine's imperative shell.
//!
//! Every rule lives in `game_core::tactics`: this module hydrates the bt-7 rows into a
//! [`TacticalBattle`], hands it ONE input (`start` / `advance` / `submit_queue` /
//! `cancel_queue` / `expire` / `conclude`), writes the rows back, and arms or disarms the
//! schedule rows the step asks for (a clock window → one `tactical_deadline_sched` row
//! pinned by `(battle_id, unit_id, window_seq)`; a round boundary → one zero-delay
//! `tactical_advance_sched` row pinned by `(battle_id, round)`; a finish → one
//! `battle_gc_sched` row 24 h out). The planner, the inventory and the delegated
//! entries reach the executor only through `queue::Hooks`, implemented here over rows.
//!
//! Identity comes from `ctx.sender()` on every client reducer; the scheduled reducers
//! refuse any sender but the database identity; every refusal is an `Err` (never a
//! clamp) that also goes through `guards::log_reject`.

#![allow(dead_code, unused_variables, clippy::unnecessary_wraps)] // API freeze: stubs land before the tests

use crate::schema::DeployPick;
use game_core::tactics::types::QueuedAction;
use game_core::tactics::TacticalBattle;
use spacetimedb::{Identity, ReducerContext, ScheduleAt};

/// Delay between a battle's finish and the sweep of its per-battle rows (design §8.1).
pub(crate) const GC_DELAY_MS: i64 = 86_400_000;
/// The Deploying window's deadline row carries this `unit_id` (unit ids are `auto_inc`
/// from 1) and `window_seq` 0. Frozen once shipped: a fired row is matched on it.
pub(crate) const DEPLOY_WINDOW_UNIT: u32 = 0;
/// `battle_secret.seed = splitmix64(encounter_seed ^ BATTLE_SEED_SALT)`: the roll stream
/// must never equal the per-wild individuality seeds (`encounter::wild_seed` is the same
/// mixer over the raw encounter seed).
pub(crate) const BATTLE_SEED_SALT: u64 = 0x7A57_1C5B_A771_E5EE;

// ===========================================================================
// Scheduled tables (colocated with their reducers; PRIVATE)
// ===========================================================================

/// One-shot clock-window deadline (design §2.3): one row per window, pinned by
/// `(battle_id, unit_id, window_seq)`; the Deploying window rides it with
/// `unit_id == DEPLOY_WINDOW_UNIT`, `window_seq == 0`. A stale fire is a no-op.
#[spacetimedb::table(accessor = tactical_deadline_sched, scheduled(tactical_deadline_fire))]
pub struct TacticalDeadlineSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
    pub unit_id: u32,
    pub window_seq: u32,
}

/// Zero-delay round-boundary continuation (design §2.2 chain rule), pinned by
/// `(battle_id, round)` — `round` is the round about to start.
#[spacetimedb::table(accessor = tactical_advance_sched, scheduled(tactical_advance))]
pub struct TacticalAdvanceSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
    pub round: u16,
}

/// The 24 h sweep of a finished battle's per-battle rows (design §8.1 GC).
#[spacetimedb::table(accessor = battle_gc_sched, scheduled(battle_gc))]
pub struct BattleGcSched {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    #[index(btree)]
    pub battle_id: u64,
}

// ===========================================================================
// Hydration (API freeze — bodies land with the implementation)
// ===========================================================================

/// A tactical battle composed from its rows for one transaction.
struct Loaded {
    anchor: crate::schema::Battle,
    tactical: crate::schema::BattleTactical,
    units: Vec<crate::schema::BattleUnit>,
    map: &'static game_core::tactics::BattleMapDef,
    tb: TacticalBattle,
}

fn load(ctx: &ReducerContext, battle_id: u64) -> Result<Loaded, String> {
    Err("tactics: not implemented".to_string())
}

/// The remembered formation resolved against the live party (design §3.3): distinct
/// remembered ids that are in the party AND conscious, in remembered order, then filled
/// from party order with conscious members not already chosen, up to `cap`.
fn resolve_formation(remembered: &[u64], party_in_order: &[(u64, bool)], cap: usize) -> Vec<u64> {
    Vec::new()
}

// ===========================================================================
// Reducers (API freeze)
// ===========================================================================

#[spacetimedb::reducer]
pub fn deploy_units(
    ctx: &ReducerContext,
    battle_id: u64,
    picks: Vec<DeployPick>,
) -> Result<(), String> {
    Err("tactics: not implemented".to_string())
}

#[spacetimedb::reducer]
pub fn submit_queue(
    ctx: &ReducerContext,
    battle_id: u64,
    unit_id: u32,
    entries: Vec<QueuedAction>,
) -> Result<(), String> {
    Err("tactics: not implemented".to_string())
}

#[spacetimedb::reducer]
pub fn cancel_queue(ctx: &ReducerContext, battle_id: u64, unit_id: u32) -> Result<(), String> {
    Err("tactics: not implemented".to_string())
}

/// DEV/TEST entrypoint for the build phase (the live encounter path flips in bt-16).
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn dev_start_tactical_wild(
    ctx: &ReducerContext,
    player: Identity,
    pack: Option<u8>,
) -> Result<(), String> {
    Err("tactics: not implemented".to_string())
}

#[spacetimedb::reducer]
pub fn tactical_deadline_fire(
    ctx: &ReducerContext,
    args: TacticalDeadlineSched,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tactical_deadline_fire is scheduler-only".to_string());
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn tactical_advance(ctx: &ReducerContext, args: TacticalAdvanceSched) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("tactical_advance is scheduler-only".to_string());
    }
    Ok(())
}

#[spacetimedb::reducer]
pub fn battle_gc(ctx: &ReducerContext, args: BattleGcSched) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("battle_gc is scheduler-only".to_string());
    }
    Ok(())
}

/// Start a wild tactical battle for `player` (the only writer of a new tactical battle;
/// bt-16 calls it from the grass path).
pub(crate) fn start_wild_tactical(
    ctx: &ReducerContext,
    player: Identity,
    encounter_seed: u64,
    forced_pack: Option<u8>,
) -> Result<u64, String> {
    Err("tactics: not implemented".to_string())
}

/// Disconnect / forced-terminal resolver for `identity`'s tactical battles. Runs FIRST in
/// `crate::resolve_all_live_interactions`, before the legacy wild resolver.
pub(crate) fn resolve_tactical_on_disconnect(ctx: &ReducerContext, identity: Identity) {}
