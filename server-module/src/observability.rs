//! `observability` — server-module domain submodule (m20a, ADR-0180 D6/D15).
//!
//! Layer-1 observability: the ONE blessed structured-log emission point for new
//! server code (`mr_log` / `mr_log_breadcrumb` over the pure `build_log_line`
//! envelope builder) plus the 60s `mr_heartbeat` scheduled reducer — a
//! write-free dead-man beat carrying the deployed `content_version`
//! (OBS-1/OBS-3/OBS-4). Existing bare `log::` call sites are grandfathered by
//! the OBS-2 ratchet (`.log-baseline`, gates G1/G7); every NEW emission routes
//! through here. The heartbeat's scheduled `#[table]` lives HERE (not
//! `schema.rs`) so the `scheduled(mr_heartbeat)` attribute reference resolves
//! within the module (ADR-0056 / macro hygiene, the `movement.rs` precedent).
//!
//! This file name extends the canonical `touches:` vocabulary (ADR-0056) —
//! keep it stable.

use crate::guards::json_escape;
use crate::schema::config;
use spacetimedb::{ReducerContext, ScheduleAt, Table};
use std::time::Duration;

/// Optional structured breadcrumbs appended to a log line by
/// `mr_log_breadcrumb` (ADR-0180 D15). Every field defaults to absent.
///
/// `phase` is one of the call-site literals `"enter"` / `"exit"` / `"event"`:
/// m20e's G9 statically scans call sites for paired enter/exit literals, so
/// the value must be spelled AT the call site, never rendered from an enum
/// here. The trace-pair set is EMPTY in m20a — zero instrumented reducers;
/// this is capability only (OBS-50/AM7).
#[derive(Default)]
pub(crate) struct Breadcrumb<'a> {
    /// A natural key already present in the domain (a zone id, a battle id)
    /// naming what CAUSED this event.
    pub cause: Option<&'a str>,
    /// `(target_reducer, scheduled_at_ms)` when the event enqueues scheduled
    /// work (mirrors `marshal::now_ms` — the i64 is structurally quote-safe).
    pub sched: Option<(&'a str, i64)>,
    /// `"enter"` / `"exit"` / `"event"` — see the type-level doc.
    pub phase: Option<&'a str>,
}

/// Render the canonical envelope: `evt` first, then the caller's pre-rendered
/// `extra_fields_json` fragment verbatim, then `cause` / `sched` / `phase` in
/// that fixed order, each emitted only when present, each comma-prefixed (an
/// empty fragment leaves no dangling comma). Pure and deterministic.
///
/// Every caller-controlled string position goes through `guards::json_escape`.
/// `extra_fields_json` is a TRUSTED pre-rendered fragment (the same posture as
/// every existing hand-rolled site): callers escape their own values.
pub(crate) fn build_log_line(evt: &str, extra_fields_json: &str, bc: Breadcrumb<'_>) -> String {
    let mut line = format!("{{\"evt\":\"{}\"", json_escape(evt));
    if !extra_fields_json.is_empty() {
        line.push(',');
        line.push_str(extra_fields_json);
    }
    if let Some(cause) = bc.cause {
        line.push_str(&format!(",\"cause\":\"{}\"", json_escape(cause)));
    }
    if let Some((target_reducer, scheduled_at_ms)) = bc.sched {
        line.push_str(&format!(
            ",\"sched\":{{\"target_reducer\":\"{}\",\"scheduled_at\":{scheduled_at_ms}}}",
            json_escape(target_reducer)
        ));
    }
    if let Some(phase) = bc.phase {
        line.push_str(&format!(",\"phase\":\"{}\"", json_escape(phase)));
    }
    line.push('}');
    line
}

/// Emit an `evt` line with no breadcrumbs — the common case.
pub(crate) fn mr_log(evt: &str, extra_fields_json: &str) {
    mr_log_breadcrumb(evt, extra_fields_json, Breadcrumb::default());
}

/// The single blessed emission point (ADR-0180 D6): build the envelope, hand
/// it to the host's log facade. AM6: the pre-rendered fragment must not
/// smuggle a reserved structural key — downstream JSON parsing is
/// last-key-wins, so a duplicate would silently forge the event type or a
/// breadcrumb. The assert compiles out of the release wasm.
pub(crate) fn mr_log_breadcrumb(evt: &str, extra_fields_json: &str, bc: Breadcrumb<'_>) {
    debug_assert!(
        ["\"evt\":", "\"cause\":", "\"sched\":", "\"phase\":"]
            .iter()
            .all(|reserved| !extra_fields_json.contains(reserved)),
        "extra_fields_json must not carry a reserved envelope key (evt/cause/sched/phase)"
    );
    log::info!("{}", build_log_line(evt, extra_fields_json, bc));
}

/// The heartbeat's one field (OBS-4): the deployed content version, read from
/// the Config ROW (not the compile-time const) so the line answers "is the
/// deployed data at the expected version". Unquoted numeric on purpose.
pub(crate) fn heartbeat_fields(content_version: u32) -> String {
    format!("\"content_version\":{content_version}")
}

/// 60s: four Prometheus scrapes per beat at the 15s scrape interval (ADR-0180
/// D2) gives the dead-man alert resolution without putting a write-free
/// reducer on the scheduler every tick. Name mirrors `PLAYTEST_REAP_INTERVAL`.
pub(crate) const MR_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(60);

// PRIVATE scheduled table colocated with its reducer (ADR-0056 exception).
#[spacetimedb::table(name = mr_heartbeat_schedule, scheduled(mr_heartbeat))]
pub struct MrHeartbeatSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

/// Scheduler-only, write-free dead-man beat (OBS-1/OBS-3). GUARD FIRST
/// (`playtest_reaper` precedent); exactly one emission; never a row write.
#[spacetimedb::reducer]
pub fn mr_heartbeat(ctx: &ReducerContext, _sched: MrHeartbeatSchedule) -> Result<(), String> {
    if ctx.sender != ctx.identity() {
        return Err("mr_heartbeat is scheduler-only".to_string());
    }
    let content_version = ctx
        .db
        .config()
        .id()
        .find(0)
        .map(|c| c.content_version)
        .unwrap_or(0);
    mr_log("heartbeat", &heartbeat_fields(content_version));
    Ok(())
}

/// Idempotent self-healing singleton arm (mirrors `ensure_playtest_reaper`;
/// reuses `playtest::plan_reaper_arm`). The ONLY writer in this module.
pub(crate) fn ensure_mr_heartbeat(ctx: &ReducerContext) {
    let existing: Vec<u64> = ctx
        .db
        .mr_heartbeat_schedule()
        .iter()
        .map(|s| s.id)
        .collect();
    let plan = crate::playtest::plan_reaper_arm(&existing);
    if plan.insert_one {
        ctx.db.mr_heartbeat_schedule().insert(MrHeartbeatSchedule {
            id: 0,
            scheduled_at: ScheduleAt::Interval(MR_HEARTBEAT_INTERVAL.into()),
        });
    }
    for id in plan.delete_ids {
        ctx.db.mr_heartbeat_schedule().id().delete(id);
    }
}

#[cfg(test)]
#[path = "observability_tests.rs"]
mod observability_tests;
