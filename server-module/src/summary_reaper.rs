//! `summary_reaper` — server-module domain submodule.
//! Caps the private `battle_summary` telemetry table at its newest `BATTLE_SUMMARY_CAP` rows by
//! `battle_id`. The reaper runs only when something is owed, in `playtest.rs`'s on-demand shape:
//! one one-shot schedule row while the table is over the cap, none otherwise. A row whose battle is
//! still held by a `battle` or `battle_tactical` row is never reaped: the oldest battle can be an
//! idle or long one that is still live, and `tactics_settle` re-inserts a zeroed summary for a
//! battle whose row is missing.
use crate::marshal::now_ms;
use crate::playtest::{firing_one_shot, ms_to_schedule, one_shot_ms, plan_wake};
use crate::schema::{battle, battle_summary, battle_tactical};
use spacetimedb::{ReducerContext, ScheduleAt, Table};

pub(crate) const BATTLE_SUMMARY_CAP: u64 = 100_000;
pub(crate) const BATTLE_SUMMARY_REAP_MAX_DELETE_PER_RUN: usize = 8192;
// How long after "work is owed" a run happens (an insert took the table over the cap, a run hit
// its delete limit). It batches the rows that arrive in between into one run and holds the
// reaper, a full-table scan and sort, to at most one run per five minutes.
pub(crate) const BATTLE_SUMMARY_REAP_RETRY_MS: i64 = 300_000;

// PRIVATE scheduled table colocated with its reducer.
#[spacetimedb::table(accessor = battle_summary_reaper_schedule, scheduled(battle_summary_reaper))]
pub struct BattleSummaryReaperSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

// Pure delete-selection over every battle id in ascending order: walking up from the lowest id,
// the first `min(len - cap, max_delete)` ids that `held` does not claim. Stops as soon as it has
// them, so `held` is asked only about the ids it walked.
pub(crate) fn plan_summary_reap(
    ids_asc: &[u64],
    cap: u64,
    max_delete: usize,
    mut held: impl FnMut(u64) -> bool,
) -> Vec<u64> {
    // `cap as usize` would truncate on wasm32; saturate instead.
    let cap = usize::try_from(cap).unwrap_or(usize::MAX);
    let need = ids_asc.len().saturating_sub(cap).min(max_delete);
    let mut out = Vec::with_capacity(need);
    for &id in ids_asc {
        if out.len() == need {
            break;
        }
        if !held(id) {
            out.push(id);
        }
    }
    out
}

// The run a table of `row_count` rows is owed: one retry delay from now while it is over the cap.
pub(crate) fn summary_wake_ms(row_count: u64, cap: u64, now_ms: i64, retry_ms: i64) -> Option<i64> {
    (row_count > cap).then(|| now_ms.saturating_add(retry_ms))
}

// The next run as armed by a run that has just finished: only when the table is still over the
// cap and the run stopped at its delete limit, so more rows may be deletable. A run that walked
// every row and is still over the cap left only held rows; it does not re-arm, and the next
// summary insert over the cap arms the next run.
pub(crate) fn summary_rearm_ms(
    rows_left: u64,
    deleted: usize,
    cap: u64,
    max_delete: usize,
    now_ms: i64,
    retry_ms: i64,
) -> Option<i64> {
    if deleted == max_delete {
        summary_wake_ms(rows_left, cap, now_ms, retry_ms)
    } else {
        None
    }
}

// Sole writer of `battle_summary_reaper_schedule`: apply `plan_wake`. `firing` is the row the
// running reaper was called with, which the runtime deletes once the reducer returns.
fn set_summary_wake(ctx: &ReducerContext, wanted_at_ms: Option<i64>, firing: Option<u64>) {
    let existing: Vec<(u64, Option<i64>)> = ctx
        .db
        .battle_summary_reaper_schedule()
        .iter()
        .filter(|s| Some(s.id) != firing)
        .map(|s| (s.id, one_shot_ms(&s.scheduled_at)))
        .collect();
    let plan = plan_wake(&existing, wanted_at_ms);
    for id in plan.delete_ids {
        ctx.db.battle_summary_reaper_schedule().id().delete(id);
    }
    if let Some(at_ms) = plan.insert_at_ms {
        ctx.db
            .battle_summary_reaper_schedule()
            .insert(BattleSummaryReaperSchedule {
                id: 0,
                scheduled_at: ms_to_schedule(at_ms),
            });
    }
}

// Called by `tactics_settle` after it inserts a summary row. At or below the cap it reads only the
// row count. Over it, a run already armed is kept, so only the insert that crosses the cap (or the
// first one after a lost run) writes a schedule row.
pub(crate) fn arm_battle_summary_reaper(ctx: &ReducerContext) {
    let wanted = summary_wake_ms(
        ctx.db.battle_summary().count(),
        BATTLE_SUMMARY_CAP,
        now_ms(ctx),
        BATTLE_SUMMARY_REAP_RETRY_MS,
    );
    if wanted.is_some() {
        set_summary_wake(ctx, wanted, None);
    }
}

// The reaper's body after its guard, with the cap and the delete limit as arguments.
pub(crate) fn reap_battle_summaries(
    ctx: &ReducerContext,
    cap: u64,
    max_delete: usize,
    firing: Option<u64>,
) {
    let mut ids: Vec<u64> = ctx
        .db
        .battle_summary()
        .iter()
        .map(|s| s.battle_id)
        .collect();
    ids.sort_unstable();
    let to_delete = plan_summary_reap(&ids, cap, max_delete, |id| {
        ctx.db.battle().battle_id().find(id).is_some()
            || ctx.db.battle_tactical().battle_id().find(id).is_some()
    });
    for &id in &to_delete {
        ctx.db.battle_summary().battle_id().delete(id);
    }
    let rows_left = (ids.len() - to_delete.len()) as u64;
    set_summary_wake(
        ctx,
        summary_rearm_ms(
            rows_left,
            to_delete.len(),
            cap,
            max_delete,
            now_ms(ctx),
            BATTLE_SUMMARY_REAP_RETRY_MS,
        ),
        firing,
    );
}

// Scheduler-only reducer. GUARD FIRST (before any read or delete).
#[spacetimedb::reducer]
pub fn battle_summary_reaper(
    ctx: &ReducerContext,
    sched: BattleSummaryReaperSchedule,
) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("battle_summary_reaper is scheduler-only".to_string());
    }
    reap_battle_summaries(
        ctx,
        BATTLE_SUMMARY_CAP,
        BATTLE_SUMMARY_REAP_MAX_DELETE_PER_RUN,
        firing_one_shot(sched.id, &sched.scheduled_at),
    );
    Ok(())
}

// Called from `init` and `sync_content`: bring the schedule in line with the table. One one-shot
// while the table is over the cap (so a database already over it at publish is reaped), no row
// at or below it, and never an interval row.
pub(crate) fn ensure_battle_summary_reaper(ctx: &ReducerContext) {
    set_summary_wake(
        ctx,
        summary_wake_ms(
            ctx.db.battle_summary().count(),
            BATTLE_SUMMARY_CAP,
            now_ms(ctx),
            BATTLE_SUMMARY_REAP_RETRY_MS,
        ),
        None,
    );
}

#[cfg(test)]
#[path = "summary_reaper_tests.rs"]
mod summary_reaper_tests;
