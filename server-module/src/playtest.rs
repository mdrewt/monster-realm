//! `playtest` — server-module domain submodule.
//! Server-only playtest OBSERVABILITY (not a game rule). Additive PRIVATE
//! append-only `playtest_event` table fed by the tactical recruit glue;
//! bounded by a TTL+cap reaper that runs only when something is owed: one
//! one-shot schedule row at the oldest row's expiry, none while the table is empty.
use crate::marshal::now_ms;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table, Timestamp};

pub(crate) const PLAYTEST_EVENT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000; // 7 days
pub(crate) const PLAYTEST_EVENT_CAP: u64 = 20_000;
// How long after "work is owed now" the reaper runs: after an insert takes the table over the
// cap, and after a reap that hit its batch limit. Five minutes bounds both the time the table
// spends over the cap and the full-table scans a burst of inserts can cause.
pub(crate) const PLAYTEST_REAP_RETRY_MS: i64 = 300_000;
pub(crate) const PLAYTEST_REAP_MAX_DELETE_PER_TICK: usize = 8192;

// PRIVATE table (NO `public`): must-never-leak per-identity behaviour data.
#[spacetimedb::table(accessor = playtest_event)]
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

// PRIVATE scheduled table colocated with its reducer.
#[spacetimedb::table(accessor = playtest_reaper_schedule, scheduled(playtest_reaper))]
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
    // 2..=5 reserved for future capture codes (SessionStart/BattleEnd/TradeConfirm/RankedMatch).
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

// The reaper's next run for a table bounded by age, as a clock time in ms. `oldest_created_ms`
// is the oldest row left (`None` = empty table, nothing owed, no run). Work owed NOW — that
// row has already expired, or the table is over its cap — runs after `retry_ms`, never at once,
// so a reaper that could not finish in one batch does not spin. Otherwise the run is at the
// oldest row's expiry. The expiry test is `plan_reap`'s (`>=`), so the run at that instant reaps.
pub(crate) fn next_wake_ms(
    oldest_created_ms: Option<i64>,
    over_cap: bool,
    now_ms: i64,
    ttl_ms: i64,
    retry_ms: i64,
) -> Option<i64> {
    let oldest = oldest_created_ms?;
    if over_cap || now_ms.saturating_sub(oldest) >= ttl_ms {
        Some(now_ms.saturating_add(retry_ms))
    } else {
        Some(oldest.saturating_add(ttl_ms))
    }
}

// A schedule row's fire time in ms when it is a one-shot; `None` for an interval row.
pub(crate) fn one_shot_ms(at: &ScheduleAt) -> Option<i64> {
    match at {
        ScheduleAt::Time(t) => Some(t.to_micros_since_unix_epoch() / 1000),
        ScheduleAt::Interval(_) => None,
    }
}

pub(crate) fn ms_to_schedule(at_ms: i64) -> ScheduleAt {
    ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(
        at_ms.saturating_mul(1_000),
    ))
}

pub(crate) struct WakePlan {
    pub delete_ids: Vec<u64>,
    pub insert_at_ms: Option<i64>,
}

// The one-row rule for an on-demand reaper schedule. `existing` is every schedule row as
// (id, one-shot fire time; `None` = an interval row). `wanted_at_ms` is the latest acceptable
// run (`None` = nothing owed). The result leaves no row when nothing is owed, and otherwise
// exactly one one-shot row firing no later than `wanted_at_ms`: the earliest existing one-shot
// that is early enough is kept (so a repeat call writes nothing), every other row goes —
// interval rows always — and a row is inserted only when none was kept.
pub(crate) fn plan_wake(existing: &[(u64, Option<i64>)], wanted_at_ms: Option<i64>) -> WakePlan {
    let keep = wanted_at_ms.and_then(|wanted| {
        existing
            .iter()
            .filter_map(|&(id, at)| at.map(|at| (at, id)))
            .filter(|&(at, _)| at <= wanted)
            .min()
            .map(|(_, id)| id)
    });
    WakePlan {
        delete_ids: existing
            .iter()
            .map(|&(id, _)| id)
            .filter(|&id| Some(id) != keep)
            .collect(),
        insert_at_ms: if keep.is_some() { None } else { wanted_at_ms },
    }
}

// The schedule row a running reaper must not count as its next run: the runtime deletes a
// one-shot row once its reducer returns. An interval row is kept by the runtime, so it is
// counted (`None`) and `plan_wake` removes it.
pub(crate) fn firing_one_shot(id: u64, at: &ScheduleAt) -> Option<u64> {
    one_shot_ms(at).map(|_| id)
}

// The reaper's next run given the rows left in the table as (event_id, created_at_ms).
pub(crate) fn playtest_wake_ms(rows: &[(u64, i64)], now_ms: i64) -> Option<i64> {
    let cap = usize::try_from(PLAYTEST_EVENT_CAP).unwrap_or(usize::MAX);
    next_wake_ms(
        rows.iter().map(|&(_, created)| created).min(),
        rows.len() > cap,
        now_ms,
        PLAYTEST_EVENT_TTL_MS,
        PLAYTEST_REAP_RETRY_MS,
    )
}

// Sole writer of `playtest_reaper_schedule`: apply `plan_wake`. `firing` is the row the
// running reaper was called with, when the runtime is about to delete it.
fn set_playtest_wake(ctx: &ReducerContext, wanted_at_ms: Option<i64>, firing: Option<u64>) {
    let existing: Vec<(u64, Option<i64>)> = ctx
        .db
        .playtest_reaper_schedule()
        .iter()
        .filter(|s| Some(s.id) != firing)
        .map(|s| (s.id, one_shot_ms(&s.scheduled_at)))
        .collect();
    let plan = plan_wake(&existing, wanted_at_ms);
    for id in plan.delete_ids {
        ctx.db.playtest_reaper_schedule().id().delete(id);
    }
    if let Some(at_ms) = plan.insert_at_ms {
        ctx.db
            .playtest_reaper_schedule()
            .insert(PlaytestReaperSchedule {
                id: 0,
                scheduled_at: ms_to_schedule(at_ms),
            });
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
    let now = now_ms(ctx);
    let ev = build_playtest_event(
        identity,
        PlaytestKind::RecruitAttempt.code(),
        now,
        battle_id,
        species_id,
        hp_permille,
        bait_item_id,
        success,
    );
    ctx.db.playtest_event().insert(ev);
    // The row just written is owed a reap at its expiry, or sooner when it took the table
    // over the cap. An existing run that is early enough is kept, so this writes a schedule
    // row only for the first event and on crossing the cap. No scan: the new row stands in
    // for the oldest one, which the existing run already covers.
    let over_cap = ctx.db.playtest_event().count() > PLAYTEST_EVENT_CAP;
    let wanted = next_wake_ms(
        Some(now),
        over_cap,
        now,
        PLAYTEST_EVENT_TTL_MS,
        PLAYTEST_REAP_RETRY_MS,
    );
    set_playtest_wake(ctx, wanted, None);
}

// Scheduler-only reducer. GUARD FIRST (before any delete). It reaps, then arms its own next
// run from the rows it left: none when the table is empty.
#[spacetimedb::reducer]
pub fn playtest_reaper(ctx: &ReducerContext, sched: PlaytestReaperSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.database_identity() {
        return Err("playtest_reaper is scheduler-only".to_string());
    }
    let now = now_ms(ctx);
    let mut rows: Vec<(u64, i64)> = ctx
        .db
        .playtest_event()
        .iter()
        .map(|e| (e.event_id, e.created_at_ms))
        .collect();
    rows.sort_unstable_by_key(|&(id, _)| id);
    let to_delete = plan_reap(
        &rows,
        now,
        PLAYTEST_EVENT_TTL_MS,
        PLAYTEST_EVENT_CAP,
        PLAYTEST_REAP_MAX_DELETE_PER_TICK,
    );
    for id in &to_delete {
        ctx.db.playtest_event().event_id().delete(*id);
    }
    // `to_delete` is sorted ascending (plan_reap), so membership is a binary search.
    rows.retain(|(id, _)| to_delete.binary_search(id).is_err());
    set_playtest_wake(
        ctx,
        playtest_wake_ms(&rows, now),
        firing_one_shot(sched.id, &sched.scheduled_at),
    );
    Ok(())
}

// Called from `init` and `sync_content`: bring the schedule in line with the table. Removes an
// interval row left by an earlier version of the module, leaves no row for an empty table,
// and arms the one-shot when rows are waiting without one.
pub(crate) fn ensure_playtest_reaper(ctx: &ReducerContext) {
    let rows: Vec<(u64, i64)> = ctx
        .db
        .playtest_event()
        .iter()
        .map(|e| (e.event_id, e.created_at_ms))
        .collect();
    set_playtest_wake(ctx, playtest_wake_ms(&rows, now_ms(ctx)), None);
}

/// delete every `playtest_event`
/// row belonging to `owner` — identity-scoped and IMMEDIATE, deliberately
/// independent of the TTL reaper above (a row younger than its TTL
/// must not survive account deletion, and this sweep is uncapped: the cascade
/// deletes ALL of the identity's rows, never a per-tick batch). The column is
/// unindexed, so this is one of the cascade's two accepted linear scans.
/// Called only from `accounts::account_deletion_reaper`.
pub(crate) fn erase_playtest_events(ctx: &ReducerContext, owner: Identity) {
    let mut ids: Vec<u64> = Vec::new();
    let mut others = false;
    for e in ctx.db.playtest_event().iter() {
        if e.identity == owner {
            ids.push(e.event_id);
        } else {
            others = true;
        }
    }
    for id in ids {
        ctx.db.playtest_event().event_id().delete(id);
    }
    // An erase that empties the table leaves the reaper nothing to do.
    if !others {
        set_playtest_wake(ctx, None, None);
    }
}

#[cfg(test)]
#[path = "playtest_tests.rs"]
mod playtest_tests;
