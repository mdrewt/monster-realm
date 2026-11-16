//! RED-PHASE STUB (sr-7): contract signatures only; every body is a no-op. Replaced by the
//! implementation after the gating tests are proven red.
#![allow(dead_code, unused_variables, unused_imports)]
use spacetimedb::{ReducerContext, ScheduleAt};

pub(crate) const BATTLE_SUMMARY_CAP: u64 = 100_000;
pub(crate) const BATTLE_SUMMARY_REAP_MAX_DELETE_PER_RUN: usize = 8192;
pub(crate) const BATTLE_SUMMARY_REAP_RETRY_MS: i64 = 300_000;

#[spacetimedb::table(accessor = battle_summary_reaper_schedule, scheduled(battle_summary_reaper))]
pub struct BattleSummaryReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

pub(crate) fn plan_summary_reap(
    ids_asc: &[u64],
    cap: u64,
    max_delete: usize,
    held: impl FnMut(u64) -> bool,
) -> Vec<u64> {
    Vec::new()
}

pub(crate) fn summary_wake_ms(row_count: u64, cap: u64, now_ms: i64, retry_ms: i64) -> Option<i64> {
    None
}

pub(crate) fn summary_rearm_ms(
    rows_left: u64,
    deleted: usize,
    cap: u64,
    max_delete: usize,
    now_ms: i64,
    retry_ms: i64,
) -> Option<i64> {
    None
}

pub(crate) fn arm_battle_summary_reaper(ctx: &ReducerContext) {}

pub(crate) fn reap_battle_summaries(
    ctx: &ReducerContext,
    cap: u64,
    max_delete: usize,
    firing: Option<u64>,
) {
}

#[spacetimedb::reducer]
pub fn battle_summary_reaper(
    ctx: &ReducerContext,
    sched: BattleSummaryReaperSchedule,
) -> Result<(), String> {
    Ok(())
}

pub(crate) fn ensure_battle_summary_reaper(ctx: &ReducerContext) {}

#[cfg(test)]
#[path = "summary_reaper_tests.rs"]
mod summary_reaper_tests;
