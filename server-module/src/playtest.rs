//! `playtest` — server-module domain submodule (pt-b2, ADR-0131).
//! Server-only playtest OBSERVABILITY (not a game rule). Additive PRIVATE
//! append-only `playtest_event` table fed by attempt_recruit at the H1 decision
//! point; bounded by an interval-singleton TTL+cap reaper. This file name extends
//! the canonical touches: vocabulary (ADR-0056) — keep it stable.
use crate::marshal::now_ms;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

pub(crate) const PLAYTEST_EVENT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 days
pub(crate) const PLAYTEST_EVENT_CAP: u64 = 20_000;
const PLAYTEST_REAP_INTERVAL: Duration = Duration::from_secs(300); // 5 min
pub(crate) const PLAYTEST_REAP_MAX_DELETE_PER_TICK: usize = 8192;

// PRIVATE table (NO `public`): must-never-leak per-identity behaviour data (ADR-0015).
#[spacetimedb::table(name = playtest_event)]
pub struct PlaytestEvent {
    #[primary_key]
    #[auto_inc]
    pub event_id: u64,
    pub identity: Identity,
    pub kind: u16,
    pub created_at_ms: i64,
    pub battle_id: u64,
    pub species_id: u32,
    pub hp_permille: u16,
    pub bait_item_id: u32,
    pub success: bool,
}

// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception).
#[spacetimedb::table(name = playtest_reaper_schedule, scheduled(playtest_reaper))]
pub struct PlaytestReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

// Observability taxonomy. NOT a wire-format derive (stored as u16 `code`).
pub(crate) enum PlaytestKind {
    RecruitAttempt,
}
impl PlaytestKind {
    // EXPLICIT literal — never `self as u16` (codes must be reorder-stable). Codes
    // 2..=5 reserved for pt-b2b (SessionStart/BattleEnd/TradeConfirm/RankedMatch).
    pub(crate) fn code(self) -> u16 {
        match self {
            PlaytestKind::RecruitAttempt => 1,
        }
    }
}

pub(crate) fn hp_permille(current_hp: u16, max_hp: u16) -> u16 {
    if max_hp == 0 {
        return 0;
    }
    ((current_hp as u64 * 1000) / max_hp as u64).min(1000) as u16
}

// Pure delete-selection. Input sorted ascending by event_id (oldest first).
pub(crate) fn plan_reap(
    rows_sorted_by_id_asc: &[(u64, i64)],
    now_ms: i64,
    ttl_ms: i64,
    cap: u64,
    batch: usize,
) -> Vec<u64> {
    let mut expired = Vec::new();
    let mut fresh = Vec::new();
    for &(id, created) in rows_sorted_by_id_asc {
        if now_ms.saturating_sub(created) >= ttl_ms {
            expired.push(id);
        } else {
            fresh.push(id);
        }
    }
    let mut to_delete = expired;
    // `cap as usize` would truncate on a 32-bit target (server-module compiles to
    // wasm32 → usize is 32-bit); saturate instead so a future large cap is safe.
    let cap_usize = usize::try_from(cap).unwrap_or(usize::MAX);
    if fresh.len() > cap_usize {
        let over = fresh.len() - cap_usize;
        to_delete.extend_from_slice(&fresh[..over]);
    }
    to_delete.sort_unstable();
    to_delete.truncate(batch);
    to_delete
}

pub(crate) struct ArmPlan {
    pub insert_one: bool,
    pub delete_ids: Vec<u64>,
}
pub(crate) fn plan_reaper_arm(existing_ids: &[u64]) -> ArmPlan {
    if existing_ids.is_empty() {
        ArmPlan {
            insert_one: true,
            delete_ids: Vec::new(),
        }
    } else {
        ArmPlan {
            insert_one: false,
            delete_ids: existing_ids[1..].to_vec(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_playtest_event(
    identity: Identity,
    kind: u16,
    now_ms: i64,
    battle_id: u64,
    species_id: u32,
    hp_permille: u16,
    bait_item_id: Option<u32>,
    success: bool,
) -> PlaytestEvent {
    PlaytestEvent {
        event_id: 0,
        identity,
        kind,
        created_at_ms: now_ms,
        battle_id,
        species_id,
        hp_permille,
        bait_item_id: bait_item_id.unwrap_or(0),
        success,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_recruit_event(
    ctx: &ReducerContext,
    identity: Identity,
    battle_id: u64,
    species_id: u32,
    hp_permille: u16,
    bait_item_id: Option<u32>,
    success: bool,
) {
    let ev = build_playtest_event(
        identity,
        PlaytestKind::RecruitAttempt.code(),
        now_ms(ctx),
        battle_id,
        species_id,
        hp_permille,
        bait_item_id,
        success,
    );
    ctx.db.playtest_event().insert(ev);
}

// Scheduler-only reducer. GUARD FIRST (before any delete). Interval singleton.
#[spacetimedb::reducer]
pub fn playtest_reaper(ctx: &ReducerContext, _sched: PlaytestReaperSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("playtest_reaper is scheduler-only".to_string());
    }
    let mut rows: Vec<(u64, i64)> = ctx
        .db
        .playtest_event()
        .iter()
        .map(|e| (e.event_id, e.created_at_ms))
        .collect();
    rows.sort_unstable_by_key(|&(id, _)| id);
    let to_delete = plan_reap(
        &rows,
        now_ms(ctx),
        PLAYTEST_EVENT_TTL_MS,
        PLAYTEST_EVENT_CAP,
        PLAYTEST_REAP_MAX_DELETE_PER_TICK,
    );
    for id in to_delete {
        ctx.db.playtest_event().event_id().delete(id);
    }
    Ok(())
}

// Idempotent self-healing singleton arm (delegates to plan_reaper_arm).
pub(crate) fn ensure_playtest_reaper(ctx: &ReducerContext) {
    let existing: Vec<u64> = ctx
        .db
        .playtest_reaper_schedule()
        .iter()
        .map(|s| s.id)
        .collect();
    let plan = plan_reaper_arm(&existing);
    if plan.insert_one {
        ctx.db
            .playtest_reaper_schedule()
            .insert(PlaytestReaperSchedule {
                id: 0,
                scheduled_at: ScheduleAt::Interval(PLAYTEST_REAP_INTERVAL.into()),
            });
    }
    for id in plan.delete_ids {
        ctx.db.playtest_reaper_schedule().id().delete(id);
    }
}

#[cfg(test)]
#[path = "playtest_tests.rs"]
mod playtest_tests;
