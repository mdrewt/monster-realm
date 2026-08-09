//! `mr_load_driver` — the m20d load driver (OBS-27 breaking-point measurement).
//!
//! # Usage
//!
//! ```text
//! cargo run -q -p sim-harness --bin mr_load_driver -- \
//!     --run-id "20260809T120000Z-pairing-off" \
//!     --server http://127.0.0.1:3000 --db monster-realm \
//!     --clients-start 5 --clients-step 5 --clients-max 50 \
//!     --hold-scrapes 10 --scrape-interval-ms 1000 --move-rate 5
//! ```
//!
//! ## Flags (frozen CLI contract — G11/OBS-51 depend on it)
//!
//! | Flag | Default | Bounds |
//! |---|---|---|
//! | `--server <url>` | `http://127.0.0.1:3000` | `http://` scheme only (no TLS in this driver) |
//! | `--db <name>` | `monster-realm` | database NAME; resolved to an identity at startup (AM26) |
//! | `--scenario movement\|chat-flood` | `movement` | `chat-flood` ⇒ exit 2, no report (OBS-28/M19) |
//! | `--clients-start <n>` | `5` | ≥1 |
//! | `--clients-step <n>` | `5` | ≥1 |
//! | `--clients-max <n>` | `50` | ≥ start, ≤ `MAX_CLIENTS` (500) |
//! | `--hold-scrapes <n>` | `10` | ≥ `MIN_HOLD_SCRAPES` (4) |
//! | `--scrape-interval-ms <n>` | `1000` | ≥100 |
//! | `--move-rate <n>` | `5` | 1..=100 intents/sec/client |
//! | `--seed <u64>` | `0x5EED_0D20` | seeds WS masks + per-client walk phase |
//! | `--run-id <string>` | **required** | the injected wall-clock label (the driver never reads a clock) |
//! | `--report <path>` | — | optional; default is stdout |
//!
//! There is deliberately **no** `--transport` (AM25: WS is the only viable
//! transport — see below), **no** `--queue-metric` (AM17: `QUEUE_FAMILIES` is a
//! const), and **no** `--label` (AM18: `--run-id` already carries the pairing
//! label by convention). All three are rejected as unknown flags.
//!
//! `--clients-start N --clients-max N` ⇒ exactly one level. That is how G11 runs
//! the fixed-concurrency pairing-on / pairing-off A/B:
//! `--run-id "$(date -u +%Y%m%dT%H%M%SZ)-pairing-on"` (AM18 convention — the
//! run-id is free text and the ONLY place a timestamp enters this tool).
//!
//! # The criteria this tool encodes
//!
//! - **OBS-27** — "WHEN `mr-load-driver` runs against a target concurrency THE
//!   SYSTEM SHALL record the concurrency level at which movement-tick p95 first
//!   crosses `STEP_MS`, or any queue-depth metric begins monotonically growing,
//!   as the measured breaking point." Exactly TWO breach reasons exist here:
//!   `movement_tick_p95_over_step_ms` and `queue_growth:<family>`. Guard
//!   rejections are NEVER a breach reason and are never blended into an error
//!   rate (D8).
//! - **OBS-24** — the movement-tick latency SLO is p95 of
//!   `spacetime_txn_elapsed_time_sec{reducer="movement_tick"}` staying under
//!   `STEP_MS`. Healthy iff `p95_s < STEP_MS/1000`; the breach comparator is
//!   therefore INCLUSIVE: breach iff `p95_s >= STEP_MS/1000` (AM9).
//! - **OBS-28** — chat-flood load scenarios stay stubbed until M19 exists.
//!   `--scenario chat-flood` is accepted by the CLI grammar and rejected at
//!   parse time with [`SCENARIO_RESERVED_ERR`], exit code 2. It freezes the seam
//!   M19 will extend; it never produces a report.
//!
//! # Determinism posture (ADR-0003 / `clippy.toml`)
//!
//! This binary reads NO clock. There is no `Instant::now`, no `SystemTime::now`,
//! no `elapsed`, and no `#[allow(clippy::disallowed_methods)]` — in the shell or
//! in the tests. Consequences, all deliberate:
//!
//! - The report's timestamp is `--run-id`, injected by the operator.
//! - Pacing is **open-loop** (AM1): each client iteration is
//!   `bounded drain → send one intent → thread::sleep(pacing_sleep_ms(rate))`,
//!   where the sleep is a pure function of `--move-rate`. The real per-client
//!   rate is therefore ≤ nominal and is never measured or corrected locally.
//!   The honesty instrument is `attempted_sends` (AM3) versus the server-side
//!   `enqueue_move` accepted+rejected deltas: a gap means driver-side starvation,
//!   not server rejection. Sleep-loop re-synchronisation makes the offered load
//!   bursty; that is a documented limitation (AM21), not a corrected one.
//! - Randomness is seeded: WS masks, the `Sec-WebSocket-Key`, and the per-client
//!   walk phase all come from `game_core::tick_seed` (no OS entropy).
//!
//! # Why WebSocket only (AM25)
//!
//! HTTP reducer calls are structurally dead for load: each
//! `POST /v1/database/<db>/call/<reducer>` is an ephemeral connection, and
//! `on_disconnect` (`server-module/src/lib.rs:213-239`) deletes the player and
//! character rows BY IDENTITY when it closes. Live-verified: `join_game` returns
//! 200, then `enqueue_move` 5 ms later returns 530 "not joined". An HTTP call
//! would also destroy a concurrent WS session's join state for the same
//! identity. On top of that, the dominant server cost at concurrency N is
//! subscription fan-out (every accepted move updates a `character` row broadcast
//! to N subscribers); with zero subscriptions,
//! `spacetime_subscription_send_queue_length` is flat at 0 forever and one of
//! OBS-27's two named signals is blind. The report carries a fixed
//! `"transport":"ws"` literal.
//!
//! # Report schema (`schema:1`, stable key order, stdout by default)
//!
//! ```text
//! { "tool":"mr_load_driver", "schema":1, "run_id":…, "server":…, "db":…,
//!   "db_identity":…, "transport":"ws", "scenario":"movement",
//!   "step_ms":<game_core::STEP_MS>, "scrape_interval_ms":…, "hold_scrapes":…,
//!   "move_rate":…, "seed":…,
//!   "breaking_point": {"concurrency":K,"reason":"movement_tick_p95_over_step_ms"
//!                                            | "queue_growth:<family>"} | null,
//!   "not_reached": <bool>,
//!   "levels":[ {"concurrency":N,"scrapes":M,"clients_connected":…,
//!               "movement_tick_p95_s":<f64>|null, "p95_state":"value|above_top|too_few|reset",
//!               "p95_top_finite_s":<f64>|null, "p95_bucket_width_s":<f64>|null,
//!               "queues":{"<family>":[v0,v1,…]}, "queue_growth":["<family>",…],
//!               "plateau":{"<family>":<f64>|null},
//!               "enqueue_move_accepted_delta":…, "enqueue_move_rejected_delta":…,
//!               "movement_tick_txn_delta":…, "attempted_sends":…,
//!               "drain_cap_hits":…, "send_errors":…,
//!               "valid":<bool>, "invalid_reason":null|"…", "notes":[…] } ],
//!   "notes":[…] }
//! ```
//!
//! The JSON is compact (no whitespace outside string values) and contains **no
//! newline**. The bearer token NEVER appears in it — [`Run`] carries
//! `auth_token` for the shell, and [`render_report`] deliberately omits it.
//!
//! ## Measurement semantics
//!
//! - Budget = [`BUDGET_MS`], which IS `game_core::STEP_MS` (SSOT — never a literal).
//! - p95 per level = ONE windowed histogram delta (AM8): cumulative buckets at
//!   the last usable scrape minus the first usable scrape, then linear
//!   interpolation inside the containing bucket — the same computation
//!   Prometheus `histogram_quantile` performs over the same series (D9), with
//!   bucket bounds READ FROM the exposition, never hard-coded.
//! - The live host's `le` set for `spacetime_txn_elapsed_time_sec_bucket` is
//!   `.00001 .00005 .0001 .0005 .001 .005 .01 .05 .1 .5 1 5 10 +Inf`, so
//!   `STEP_MS`=0.2 s sits inside a 400 ms-wide `(0.1, 0.5]` bucket. Every level
//!   reports `p95_bucket_width_s` as the resolution/uncertainty indicator (AM10).
//! - `+Inf` honesty: a p95 above the top finite bound is `AboveTop(top_finite)`,
//!   never silently reported as that bound. It is a breach iff
//!   `top_finite >= STEP_MS/1000`, otherwise the level is invalid
//!   (`p95_indeterminate`) — indeterminate, never quietly healthy.
//! - Warm-up (AM6): the FIRST raw reading of every per-level series — histogram
//!   snapshots AND queue gauges alike — is discarded ([`usable_window`]); it
//!   contains the connect burst. Hence `--hold-scrapes` ≥ 4.
//! - Growth (AM7): within-level strict monotonic growth over the usable window
//!   is the OBS-27 breach signal. Cross-level plateau growth is a REPORTED
//!   DIAGNOSTIC (`cross_level_growth` note), never a breach — a queue flat at an
//!   elevated plateau means the server keeps up at that concurrency.
//! - Label pinning (AM26/AM27): `--db` is resolved name→identity at startup via
//!   `GET /v1/database/<name>` (`__identity__`, `0x` stripped) and pinned on
//!   every series match. Note the live label-name asymmetry: txn families use
//!   `db=`, queue gauges use `database_identity=`. All txn matches also pin
//!   `txn_type="Reducer"` — an `txn_type="Update"` row exists per reducer and
//!   would double-count accepted/rejected deltas.
//! - Accept/reject truth comes from `spacetime_num_txns_total` deltas alone
//!   (S1), so the WS reader never parses a data payload.
//!
//! ## Level validity (AM5) — an invalid level can never be the breaking point
//!
//! - `join_failed` — the cumulative `join_game{committed="true"}` delta is short
//!   of the level's client count. A driver-side auth/name/validation drift, and
//!   therefore a LOUD tool error, never a server verdict.
//! - `no_load_reached` — accepted + rejected `enqueue_move` delta is 0: nothing
//!   reached the server (driver stall / connection collapse).
//! - `counter_reset` — a cumulative counter decreased (host restart).
//! - `insufficient_samples` / `p95_indeterminate` — no usable p95.
//!
//! A level with `accepted == 0` but `rejected > 0` is a queue-full storm at
//! saturation. It stays **VALID** — its p95 and queue readings are real
//! measurements of a saturated server — and gains a `rejection_storm` note.
//!
//! ## Co-location caveat (AM4)
//!
//! When the driver's own thread count exceeds
//! `std::thread::available_parallelism()`, the report gains
//! [`CO_LOCATION_NOTE`]: a loopback run can be contaminated by the driver's own
//! scheduling. The OBS-27 number of record should come from a driver on a
//! separate host wherever possible, and Phase-3 verification watches the DRIVER
//! process's CPU alongside the server's (AM21).
//!
//! ## This binary never runs in CI
//!
//! It needs a live SpacetimeDB host and a published module, the same
//! skip-by-design posture as the metrics-contract eval's live half. What CI runs
//! is the `#[cfg(test)] mod tests` below: the whole pure core (CLI, Prometheus
//! parser, estimators, verdict machine, renderer, bot model, WS codec, envelope
//! builders) with zero sockets and zero clocks. The bot model's one map
//! assumption — zone-0 row 1 is grass-free — is proven by feeding the generated
//! walk through the REAL `game_core::apply_move` on the REAL zone-0 content
//! (T13), not by runtime logic: this driver models no game rules (AM23 records
//! that no occupancy/collision rule exists anywhere in the movement pipeline, so
//! N bots stack freely on row 1).
//!
//! Protocol-real, not SDK-real: `spacetimedb-sdk` would drag in tokio +
//! tokio-tungstenite + generated bindings, all outside this touch set. The
//! deviation from D9's literal "real SDK clients" is recorded in ADR-0180; the
//! core intent — all measurement off S1 — is preserved.

#![forbid(unsafe_code)]

use game_core::{Direction, MoveInput, STEP_MS};

// ===========================================================================
// §1 CONSTANTS
// ===========================================================================

/// Tool name echoed in the report.
pub const TOOL_NAME: &str = "mr_load_driver";

/// Report schema version.
pub const SCHEMA_VERSION: u32 = 1;

/// The only transport (AM25). A fixed literal in the report.
pub const TRANSPORT: &str = "ws";

/// The movement-tick latency budget in ms. This IS `game_core::STEP_MS`
/// (ADR-0003 SSOT) — never re-spell it as a literal `200`.
pub const BUDGET_MS: i64 = STEP_MS;

/// The same budget in SECONDS, the unit of the Prometheus histogram.
pub const BUDGET_S: f64 = BUDGET_MS as f64 / 1000.0;

/// Queue-depth gauges watched for within-level monotonic growth (AM17,
/// cited to OBS-26/OBS-27). Hard-coded on purpose: a repeatable flag has no
/// consumer today.
pub const QUEUE_FAMILIES: [&str; 2] = [
    "spacetime_subscription_send_queue_length",
    "spacetime_worker_instance_operation_queue_length",
];

/// The subscription set each bot opens — the single hot, per-move-updated
/// public table, and the real client's own first query
/// (`client/src/net/connection.ts:611-632`).
pub const SUBSCRIBE_QUERIES: [&str; 1] = ["SELECT * FROM character"];

/// Hard client cap (fail-loud above it): thread + FD ceilings, 256 KiB stacks.
pub const MAX_CLIENTS: u32 = 500;

/// Highest accepted `--move-rate` (intents/sec/client).
pub const MAX_MOVE_RATE: u32 = 100;

/// AM6: raw readings discarded from the FRONT of every per-level series (the
/// connect burst). Fixed, never a flag.
pub const WARMUP_SCRAPES: usize = 1;

/// `--hold-scrapes` floor: 1 warm-up discard + ≥3 usable readings for a growth
/// judgement.
pub const MIN_HOLD_SCRAPES: u32 = 4;

/// `--scrape-interval-ms` floor.
pub const MIN_SCRAPE_INTERVAL_MS: u64 = 100;

/// Per-iteration socket read timeout (ms) — the drain runs until a read would
/// block. Also the allowance subtracted from the open-loop pacing sleep (AM1).
pub const READ_TIMEOUT_MS: u64 = 5;

/// AM2 safety ceiling: frames drained per iteration before giving up and
/// incrementing `drain_cap_hits` (a receive-lag signal, not an error).
pub const DRAIN_FRAME_CAP: usize = 4096;

/// Prometheus family: movement-tick latency histogram (OBS-24).
pub const TXN_ELAPSED_BUCKET_FAMILY: &str = "spacetime_txn_elapsed_time_sec_bucket";

/// Prometheus family: per-reducer transaction counter (accept/reject truth, S1).
pub const TXN_COUNT_FAMILY: &str = "spacetime_num_txns_total";

/// AM27: the only `txn_type` this driver ever matches. An `txn_type="Update"`
/// row exists per reducer and would double-count every delta.
pub const TXN_TYPE_REDUCER: &str = "Reducer";

/// Reducer names read from / driven at the server.
pub const REDUCER_MOVEMENT_TICK: &str = "movement_tick";
/// See [`REDUCER_MOVEMENT_TICK`].
pub const REDUCER_ENQUEUE_MOVE: &str = "enqueue_move";
/// See [`REDUCER_MOVEMENT_TICK`].
pub const REDUCER_JOIN_GAME: &str = "join_game";

/// The `v1.json` WS subprotocol (live-verified).
pub const WS_SUBPROTOCOL: &str = "v1.json.spacetimedb";

/// The single p95 breach reason (OBS-27 signal 1).
pub const P95_BREACH_REASON: &str = "movement_tick_p95_over_step_ms";

/// Prefix of the queue-growth breach reason (OBS-27 signal 2); the family name
/// is appended, e.g. `queue_growth:spacetime_subscription_send_queue_length`.
pub const QUEUE_BREACH_PREFIX: &str = "queue_growth:";

/// AM5: a saturated level that accepted nothing but rejected something is a
/// REAL measurement, not an invalid level. It gains this note.
pub const REJECTION_STORM_NOTE: &str = "rejection_storm";

/// AM4: emitted when driver threads outnumber host parallelism.
pub const CO_LOCATION_NOTE: &str =
    "driver thread count exceeds host parallelism; co-located results may be contaminated by the driver's own scheduling";

/// AM16/OBS-28: the exact parse error for `--scenario chat-flood`. Exit code 2.
pub const SCENARIO_RESERVED_ERR: &str =
    "scenario 'chat-flood' is reserved for M19 (chat) and stubbed by OBS-28; mr_load_driver implements only --scenario movement";

// ===========================================================================
// §2 CONFIG / CLI PARSE
// ===========================================================================

/// The load scenario. Only `movement` exists in m20d; `chat-flood` is rejected
/// at parse time (OBS-28/M19) rather than modelled here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scenario {
    /// Bots walk row 1 of zone 0 and stream `enqueue_move` intents.
    Movement,
}

/// The fully validated CLI contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub server: String,
    pub db: String,
    pub scenario: Scenario,
    pub clients_start: u32,
    pub clients_step: u32,
    pub clients_max: u32,
    pub hold_scrapes: u32,
    pub scrape_interval_ms: u64,
    pub move_rate: u32,
    pub seed: u64,
    pub run_id: String,
    pub report_path: Option<String>,
}

/// Parse + validate argv (WITHOUT argv[0]).
///
/// # Errors
/// Any unknown flag, missing value, unparsable number, out-of-bounds value, or
/// a missing `--run-id`. `--scenario chat-flood` yields exactly
/// [`SCENARIO_RESERVED_ERR`].
pub fn parse_args(args: &[String]) -> Result<Config, String> {
    let _ = args;
    todo!("m20d I1: CLI parse + validate")
}

/// Process exit code for a top-level error message: 2 for the reserved-scenario
/// error (OBS-28), 1 otherwise.
#[must_use]
pub fn exit_code_for_error(msg: &str) -> i32 {
    let _ = msg;
    todo!("m20d I1: exit-code mapping")
}

/// Open-loop pacing sleep in ms, derived purely from `--move-rate` (AM1): the
/// nominal period minus a fixed drain allowance, saturating at 0. Total over
/// `rate == 0` (which `parse_args` rejects) — returns 0.
#[must_use]
pub fn pacing_sleep_ms(move_rate: u32) -> u64 {
    let _ = move_rate;
    todo!("m20d I1: open-loop pacing constant")
}

/// `http://127.0.0.1:3000` → `127.0.0.1:3000`.
///
/// # Errors
/// Any scheme other than `http://` (this driver has no TLS), or an empty host.
pub fn server_host(server_url: &str) -> Result<String, String> {
    let _ = server_url;
    todo!("m20d I1: host extraction")
}

// ===========================================================================
// §3 PROMETHEUS TEXT PARSE
// ===========================================================================

/// One exposition line: family name, labels in text order, value.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub name: String,
    pub labels: Vec<(String, String)>,
    pub value: f64,
}

/// Parse one exposition line. `Ok(None)` for a comment (`#…`) or a blank line.
///
/// An optional trailing timestamp is accepted and ignored.
///
/// # Errors
/// Malformed input — unbalanced label braces, a missing value, an unparsable
/// value, or a bad escape (fail loud; never a silent skip).
pub fn parse_line(line: &str) -> Result<Option<Sample>, String> {
    let _ = line;
    todo!("m20d I2: exposition line parse")
}

/// Parse a whole `/metrics` body.
///
/// # Errors
/// Propagates the first [`parse_line`] error, naming the offending line.
pub fn parse_exposition(text: &str) -> Result<Vec<Sample>, String> {
    let _ = text;
    todo!("m20d I2: exposition parse")
}

/// Unescape a Prometheus label value (`\\`, `\"`, `\n` are the only legal
/// escapes).
///
/// # Errors
/// An unknown escape sequence or a trailing backslash.
pub fn label_unescape(raw: &str) -> Result<String, String> {
    let _ = raw;
    todo!("m20d I2: label unescape")
}

/// The value of `key` on this sample, if present.
#[must_use]
pub fn label_value<'a>(sample: &'a Sample, key: &str) -> Option<&'a str> {
    let _ = (sample, key);
    todo!("m20d I2: label lookup")
}

/// SUBSET match: every `(key, value)` in `required` must be present and equal.
/// Extra labels on the sample are ignored (never exact-label-set equality).
#[must_use]
pub fn matches_labels(sample: &Sample, required: &[(&str, &str)]) -> bool {
    let _ = (sample, required);
    todo!("m20d I2: subset label match")
}

/// All samples with this family name whose labels satisfy `required`.
#[must_use]
pub fn select_subset<'a>(
    samples: &'a [Sample],
    name: &str,
    required: &[(&str, &str)],
) -> Vec<&'a Sample> {
    let _ = (samples, name, required);
    todo!("m20d I2: series selection")
}

/// AM26/AM27: the pinned label subset for a txn family. Note `db=` (NOT
/// `database_identity=`) and the mandatory `txn_type="Reducer"`.
#[must_use]
pub fn txn_match<'a>(db_identity: &'a str, reducer: &'a str) -> [(&'a str, &'a str); 3] {
    let _ = (db_identity, reducer);
    todo!("m20d I2: txn label pin")
}

/// [`txn_match`] plus the `committed` discriminator, for accept/reject deltas.
#[must_use]
pub fn txn_count_match<'a>(
    db_identity: &'a str,
    reducer: &'a str,
    committed: &'a str,
) -> [(&'a str, &'a str); 4] {
    let _ = (db_identity, reducer, committed);
    todo!("m20d I2: txn counter label pin")
}

/// AM26: the pinned label subset for a queue gauge. Note `database_identity=`
/// (NOT `db=`) — the live label-name asymmetry.
#[must_use]
pub fn queue_match<'a>(db_identity: &'a str) -> [(&'a str, &'a str); 1] {
    let _ = db_identity;
    todo!("m20d I2: queue gauge label pin")
}

/// Sum every matching counter series.
///
/// # Errors
/// ZERO matching series — fail loud (AM26); an absent family is never "0".
pub fn counter_sum(
    samples: &[Sample],
    name: &str,
    required: &[(&str, &str)],
) -> Result<f64, String> {
    let _ = (samples, name, required);
    todo!("m20d I2: counter sum")
}

/// Read one gauge value.
///
/// # Errors
/// Zero matching series (fail loud), as for [`counter_sum`].
pub fn gauge_sum(samples: &[Sample], name: &str, required: &[(&str, &str)]) -> Result<f64, String> {
    let _ = (samples, name, required);
    todo!("m20d I2: gauge sum")
}

/// A cumulative histogram reading: bucket upper bounds ASCENDING (last is
/// `f64::INFINITY` for `+Inf`) and the parallel cumulative counts.
#[derive(Debug, Clone, PartialEq)]
pub struct BucketSnapshot {
    pub bounds: Vec<f64>,
    pub counts: Vec<f64>,
}

/// Build a [`BucketSnapshot`] from `_bucket` series, reading every bound from
/// the `le` label in the TEXT (never a hard-coded bound set). Matching series
/// are summed bucket-wise.
///
/// # Errors
/// Zero matching series (AM26 fail loud), or matching series whose `le` sets
/// differ (AM14 — summing them would be a silent lie).
pub fn histogram_snapshot(
    samples: &[Sample],
    name: &str,
    required: &[(&str, &str)],
) -> Result<BucketSnapshot, String> {
    let _ = (samples, name, required);
    todo!("m20d I2: histogram snapshot")
}

/// `{"database_identity":{"__identity__":"0x<hex>"}}` → `<hex>` (AM26).
///
/// # Errors
/// The field is missing or malformed.
pub fn database_identity_from_json(json: &str) -> Result<String, String> {
    let _ = json;
    todo!("m20d I2: db identity resolution")
}

/// Strip a leading `0x`, if present. Label values carry the hex WITHOUT it.
#[must_use]
pub fn strip_0x(hex: &str) -> &str {
    let _ = hex;
    todo!("m20d I2: 0x strip")
}

// ===========================================================================
// §4 ESTIMATORS
// ===========================================================================

/// The p95 outcome for one level.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum P95 {
    /// Interpolated seconds inside a finite bucket.
    Value(f64),
    /// The 95th percentile fell above the top FINITE bound, whose value this
    /// carries. Never reported as the p95 itself.
    AboveTop(f64),
    /// Fewer than two usable scrapes, or a zero-count window.
    TooFew,
    /// A cumulative bucket count decreased (host restart).
    Reset,
}

/// Whether a p95 breaches the OBS-24 budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Breach {
    No,
    Yes,
    /// No honest verdict is possible — the level is invalid, never healthy.
    Indeterminate,
}

/// AM6: drop the first [`WARMUP_SCRAPES`] raw readings of a per-level series.
/// The SAME discard applies to histogram snapshots and queue gauges alike.
#[must_use]
pub fn usable_window<T: Clone>(readings: &[T]) -> Vec<T> {
    let _ = readings;
    todo!("m20d I3: warm-up discard")
}

/// AM8: ONE windowed cumulative delta per level — last usable snapshot minus
/// first usable snapshot. `Ok(None)` when fewer than two usable readings exist.
///
/// # Errors
/// The two snapshots disagree on their `le` set (AM14).
pub fn window_delta(raw: &[BucketSnapshot]) -> Result<Option<BucketSnapshot>, String> {
    let _ = raw;
    todo!("m20d I3: windowed histogram delta")
}

/// Linear-interpolated p95 over ONE cumulative-count delta — the computation
/// Prometheus `histogram_quantile` performs:
///
/// ```text
/// total = counts[last]                      (the +Inf cumulative count)
/// total <= 0                                -> TooFew
/// any count < 0                             -> Reset
/// rank  = 0.95 * total
/// i     = smallest index with counts[i] >= rank
/// bounds[i] is +Inf                         -> AboveTop(bounds[len-2])
/// lower       = if i == 0 { 0.0 } else { bounds[i-1] }
/// lower_count = if i == 0 { 0.0 } else { counts[i-1] }
/// Value(lower + (bounds[i] - lower) * (rank - lower_count) / (counts[i] - lower_count))
/// ```
#[must_use]
pub fn p95_from_delta(delta: &BucketSnapshot) -> P95 {
    let _ = delta;
    todo!("m20d I3: p95 interpolation")
}

/// [`usable_window`] + [`window_delta`] + [`p95_from_delta`] for a whole level.
///
/// # Errors
/// Propagates the [`window_delta`] `le`-mismatch error.
pub fn p95_windowed(raw: &[BucketSnapshot]) -> Result<P95, String> {
    let _ = raw;
    todo!("m20d I3: level p95")
}

/// AM10: the WIDTH of the bucket the p95 landed in — the resolution/uncertainty
/// indicator. `None` unless the outcome is [`P95::Value`].
#[must_use]
pub fn p95_bucket_width_s(delta: &BucketSnapshot) -> Option<f64> {
    let _ = delta;
    todo!("m20d I3: p95 bucket width")
}

/// AM9: the ONE breach comparator. `Value(v)` breaches iff `v >= BUDGET_S`
/// (inclusive — OBS-24 is healthy only strictly UNDER the budget);
/// `AboveTop(t)` breaches iff `t >= BUDGET_S`, else it is indeterminate;
/// `TooFew`/`Reset` are indeterminate.
#[must_use]
pub fn p95_breaches_budget(p95: P95) -> Breach {
    let _ = p95;
    todo!("m20d I3: breach comparator")
}

/// Report field: the p95 seconds, or `None` for every non-`Value` outcome
/// (`AboveTop` must NEVER be reported as its top finite bound).
#[must_use]
pub fn p95_value_s(p95: P95) -> Option<f64> {
    let _ = p95;
    todo!("m20d I3: p95 report value")
}

/// Report field: the top finite bound of an [`P95::AboveTop`], else `None`.
#[must_use]
pub fn p95_top_finite_s(p95: P95) -> Option<f64> {
    let _ = p95;
    todo!("m20d I3: p95 top finite")
}

/// Report field: `"value" | "above_top" | "too_few" | "reset"`.
#[must_use]
pub fn p95_state_name(p95: P95) -> &'static str {
    let _ = p95;
    todo!("m20d I3: p95 state name")
}

/// Operational definition of "begins monotonically growing" over an ALREADY
/// windowed series: at least 3 readings, strictly increasing across EVERY
/// consecutive pair, AND `last - first >= 1.0`. Noise-immune by construction —
/// an oscillating series with a net gain is NOT growth.
#[must_use]
pub fn is_monotonic_growth(window: &[f64]) -> bool {
    let _ = window;
    todo!("m20d I3: growth detector")
}

/// Within-level growth judgement for one family's RAW per-level series:
/// [`usable_window`] then [`is_monotonic_growth`] (AM6 + AM7).
#[must_use]
pub fn level_growth(raw: &[f64]) -> bool {
    let _ = raw;
    todo!("m20d I3: within-level growth")
}

/// Median of a slice (input order irrelevant); `None` when empty.
#[must_use]
pub fn median(values: &[f64]) -> Option<f64> {
    let _ = values;
    todo!("m20d I3: median")
}

// ===========================================================================
// §5 RAMP + VERDICT
// ===========================================================================

/// Cumulative concurrency levels: `start, start+step, …` while `<= max`.
/// `start == max` yields exactly one level (the G11 fixed-concurrency A/B).
#[must_use]
pub fn ramp_levels(start: u32, step: u32, max: u32) -> Vec<u32> {
    let _ = (start, step, max);
    todo!("m20d I4: ramp planner")
}

/// Everything the verdict machine needs about ONE held level — plain data, no
/// IO, no clock. Every series is RAW (warm-up NOT yet discarded); the estimators
/// own the AM6 window so the discard cannot be forgotten at a call site.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelSample {
    pub concurrency: u32,
    pub clients_connected: u32,
    /// Cumulative `join_game{committed="true"}` delta since RUN start (AM5).
    pub join_committed_total_delta: f64,
    pub enqueue_accepted_delta: f64,
    pub enqueue_rejected_delta: f64,
    pub movement_tick_txn_delta: f64,
    /// Per-scrape cumulative histogram readings, oldest first.
    pub p95_snapshots: Vec<BucketSnapshot>,
    /// Per-scrape gauge readings per family, in [`QUEUE_FAMILIES`] order.
    pub queue_readings: Vec<(String, Vec<f64>)>,
    /// AM3: driver-side attempted sends (vs the server's accepted+rejected).
    pub attempted_sends: u64,
    /// AM2: iterations that hit [`DRAIN_FRAME_CAP`] (receive-lag signal).
    pub drain_cap_hits: u64,
    pub send_errors: u64,
    /// A cumulative counter decreased between scrapes (host restart).
    pub counter_decreased: bool,
}

/// The judged level.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelVerdict {
    pub concurrency: u32,
    pub valid: bool,
    pub invalid_reason: Option<String>,
    pub p95: P95,
    pub p95_bucket_width_s: Option<f64>,
    /// Families growing WITHIN this held level (the OBS-27 signal), in input order.
    pub queue_growth: Vec<String>,
    /// AM7 diagnostic: per-family median of the usable window.
    pub plateau_by_family: Vec<(String, Option<f64>)>,
    pub notes: Vec<String>,
}

/// Judge one level (AM5 validity semantics + AM6/AM7/AM8 estimators).
///
/// Validity is decided in this fixed precedence, so a level with two problems
/// reports the more fundamental one:
///
/// 1. `counter_reset` — `counter_decreased`, or the p95 window saw a decrease.
/// 2. `join_failed` — `join_committed_total_delta < concurrency`.
/// 3. `no_load_reached` — `accepted + rejected == 0`.
/// 4. `insufficient_samples` — [`P95::TooFew`].
/// 5. `p95_indeterminate` — [`P95::AboveTop`] below the budget.
///
/// `accepted == 0 && rejected > 0` is VALID and gains [`REJECTION_STORM_NOTE`]:
/// a saturated server's readings are real measurements, and rejection volume is
/// never a breach reason (OBS-27 names exactly two) and never an error rate (D8).
///
/// # Errors
/// Propagates the [`window_delta`] `le`-mismatch error (AM14 fail loud).
pub fn evaluate_level(sample: &LevelSample) -> Result<LevelVerdict, String> {
    let _ = sample;
    todo!("m20d I4: level verdict")
}

/// The measured breaking point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakingPoint {
    pub concurrency: u32,
    pub reason: String,
}

/// OBS-27: the FIRST level that crosses, in ramp order. Invalid levels are
/// skipped entirely and can never be the breaking point. When both signals fire
/// at the same level the p95 reason wins (it is the SLO of record). The breach
/// comparator is [`p95_breaches_budget`] — inclusive at the budget (AM9).
#[must_use]
pub fn breaking_point(verdicts: &[LevelVerdict]) -> Option<BreakingPoint> {
    let _ = verdicts;
    todo!("m20d I4: breaking-point state machine")
}

/// AM7 DIAGNOSTIC (never a breach reason): families whose per-level plateau is
/// strictly increasing across ≥3 CONSECUTIVE levels. No magnitude threshold —
/// humans and G11 re-judge from the raw series in the report.
#[must_use]
pub fn cross_level_growth(verdicts: &[LevelVerdict]) -> Vec<String> {
    let _ = verdicts;
    todo!("m20d I4: cross-level plateau diagnostic")
}

/// Total threads this run will spawn: one per client plus the scraper.
#[must_use]
pub fn total_driver_threads(clients: u32) -> usize {
    let _ = clients;
    todo!("m20d I4: thread count")
}

/// AM4: [`CO_LOCATION_NOTE`] iff the driver outnumbers the host's parallelism.
/// Parallelism is INJECTED so this stays a pure, tested function.
#[must_use]
pub fn co_location_note(driver_threads: usize, available_parallelism: usize) -> Option<String> {
    let _ = (driver_threads, available_parallelism);
    todo!("m20d I4: co-location note")
}

// ===========================================================================
// §6 REPORT
// ===========================================================================

/// Escape a Rust string for a JSON string literal: `"` → `\"`, `\` → `\\`,
/// newline/CR/tab to their shorthands, every other control char to `\u00XX`.
/// Non-ASCII passes through unchanged (the output is UTF-8 JSON).
///
/// This is the driver's OWN copy (AM20): `server-module`'s `guards::json_escape`
/// is behind a crate boundary, and DRY-across-boundaries is not a goal here.
#[must_use]
pub fn json_escape(s: &str) -> String {
    let _ = s;
    todo!("m20d I5: json escape")
}

/// Render an `f64` as a JSON number, or `null` when it is not finite (a `+Inf`
/// bucket width must never emit the invalid JSON token `inf`).
#[must_use]
pub fn json_number(v: f64) -> String {
    let _ = v;
    todo!("m20d I5: json number")
}

/// One level's raw sample paired with its verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelReport {
    pub sample: LevelSample,
    pub verdict: LevelVerdict,
}

/// The complete run record. NOTE: `auth_token` is part of the RECORD, never of
/// the REPORT — [`render_report`] omits it deliberately.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub config: Config,
    /// The resolved database identity hex, without `0x` (non-secret evidence).
    pub db_identity: String,
    /// The bearer token acquired at startup. NEVER rendered.
    pub auth_token: String,
    pub levels: Vec<LevelReport>,
    pub notes: Vec<String>,
}

/// Render the `schema:1` report: compact JSON, fixed key order, no newline, no
/// token. The breaking point is computed HERE from the level verdicts via
/// [`breaking_point`], so the report can never disagree with the state machine.
#[must_use]
pub fn render_report(run: &Run) -> String {
    let _ = run;
    todo!("m20d I5: report renderer")
}

// ===========================================================================
// §7 BOT MODEL
// ===========================================================================

/// Conservative ASCII bot name — `"LoadBot <i>"`, alphanumeric + a single
/// interior space, far inside `server-module/src/guards.rs::validate_name`'s
/// NFC/allowlist/24-char rules (AM15: the rule is NOT duplicated here; AM5's
/// `join_failed` guard turns any future drift into a loud tool error).
#[must_use]
pub fn bot_name(i: u32) -> String {
    let _ = i;
    todo!("m20d I6: bot name")
}

/// Per-client monotonic `seq` for the `step_index`-th intent: starts at 1
/// (the server rejects `seq <= last_input_seq`).
#[must_use]
pub fn seq_for(step_index: u64) -> u64 {
    let _ = step_index;
    todo!("m20d I6: intent seq")
}

/// The walk: East/West ONLY, so `y` never changes and the bot can never step
/// onto tall grass from row 1 of zone 0 (a wild encounter would battle-lock the
/// bot forever — `server-module/src/movement.rs:133-137` — and silently kill the
/// offered load). `client_index` + `seed` set a phase offset via
/// `game_core::tick_seed` so clients are not in lockstep. The driver models NO
/// game rule: bumping a wall is a legal server-side no-op, and T13 proves the
/// grass invariant against the REAL map and the REAL `apply_move`.
#[must_use]
pub fn next_input(client_index: u32, seq: u64, seed: u64) -> MoveInput {
    let _ = (client_index, seq, seed);
    todo!("m20d I6: bot walk")
}

// ===========================================================================
// §8 WIRE (pure)
// ===========================================================================

/// Standard base64 with `=` padding (only used for `Sec-WebSocket-Key`).
#[must_use]
pub fn b64_encode(bytes: &[u8]) -> String {
    let _ = bytes;
    todo!("m20d I7: base64")
}

/// A seeded 16-byte `Sec-WebSocket-Key` (24 base64 chars ending `==`). The
/// server's `Sec-WebSocket-Accept` is deliberately NOT verified (that would need
/// SHA-1); the 101 status line is the handshake proof.
#[must_use]
pub fn ws_key_from_seed(seed: u64) -> String {
    let _ = seed;
    todo!("m20d I7: ws key")
}

/// Seeded 4-byte client mask for frame `frame_index` (RFC 6455 requires every
/// client→server frame to be masked). Seeded, so a run replays byte-identically.
#[must_use]
pub fn mask_from_seed(seed: u64, frame_index: u64) -> [u8; 4] {
    let _ = (seed, frame_index);
    todo!("m20d I7: frame mask")
}

/// XOR the payload with the mask, in place. An involution: applying it twice
/// restores the original bytes.
pub fn apply_mask(payload: &mut [u8], mask: [u8; 4]) {
    let _ = (payload, mask);
    todo!("m20d I7: mask/unmask")
}

/// A complete masked client→server TEXT frame (`FIN|opcode 1` = `0x81`), using
/// the 7-bit / 16-bit / 64-bit payload-length encoding as required.
#[must_use]
pub fn encode_text_frame(payload: &str, mask: [u8; 4]) -> Vec<u8> {
    let _ = (payload, mask);
    todo!("m20d I7: text frame")
}

/// A masked PONG (`0x8A`) echoing the ping payload.
#[must_use]
pub fn encode_pong(payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let _ = (payload, mask);
    todo!("m20d I7: pong frame")
}

/// A masked, empty-payload CLOSE (`0x88`).
#[must_use]
pub fn encode_close(mask: [u8; 4]) -> Vec<u8> {
    let _ = mask;
    todo!("m20d I7: close frame")
}

/// A parsed RFC 6455 frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub fin: bool,
    pub opcode: u8,
    pub masked: bool,
    pub payload_len: u64,
    /// Total header bytes, INCLUDING the extended length and the 4 mask bytes
    /// when present.
    pub header_len: usize,
}

/// Parse a frame header from the front of `buf`.
///
/// `Ok(None)` means "need more bytes" — never an error, and never consumes.
///
/// # Errors
/// A 64-bit length with the high bit set (RFC 6455 forbids it).
pub fn parse_frame_header(buf: &[u8]) -> Result<Option<FrameHeader>, String> {
    let _ = buf;
    todo!("m20d I7: frame header parse")
}

/// A complete control frame surfaced by the drain (always ≤125 bytes per RFC).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlFrame {
    Ping(Vec<u8>),
    Pong(Vec<u8>),
    Close,
}

/// AM2: the streaming skip machine. The reader NEVER parses a data payload
/// (accept/reject truth comes from S1 counters), so it needs no fragment
/// reassembly — just a remaining-bytes-to-skip counter that survives partial
/// reads, plus a leftover buffer for a split header.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainState {
    /// Payload bytes of the current DATA frame still to be discarded.
    pub skip_remaining: u64,
    /// Bytes received but not yet consumed (a partial header or control frame).
    pub buf: Vec<u8>,
}

/// What one feed of bytes produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainOutcome {
    /// Complete control frames needing an answer, in arrival order.
    pub control: Vec<ControlFrame>,
    /// DATA frames fully skipped during THIS feed.
    pub data_frames_skipped: u64,
    /// The peer sent a Close.
    pub closed: bool,
}

/// Feed bytes into the drain machine.
///
/// Order of work, repeated until the buffer is exhausted or a header/control
/// frame is incomplete:
/// 1. If `skip_remaining > 0`, discard `min(skip_remaining, available)` bytes;
///    reaching 0 counts one skipped data frame.
/// 2. Otherwise parse a header. Incomplete ⇒ stop, consume nothing.
/// 3. Control opcode (`0x8`/`0x9`/`0xA`): wait for the WHOLE frame, then surface
///    it (a truncated ping must never be answered).
/// 4. Data opcode (`0x0`/`0x1`/`0x2`): consume the header and set
///    `skip_remaining` (a zero-length data frame counts immediately).
///
/// # Errors
/// An unknown opcode, a control frame longer than 125 bytes, or an illegal
/// 64-bit length — fail loud rather than desynchronise the stream.
pub fn drain_feed(state: &mut DrainState, bytes: &[u8]) -> Result<DrainOutcome, String> {
    let _ = (state, bytes);
    todo!("m20d I7: streaming drain")
}

/// `/v1/database/<db>/subscribe` — the WS upgrade path.
#[must_use]
pub fn ws_path(db: &str) -> String {
    let _ = db;
    todo!("m20d I7: ws path")
}

/// The full WS upgrade request, terminated by a blank line. The token appears
/// ONLY in the `Authorization: Bearer` header — never in the path or a query
/// param (`?token=` also works on this host but would leak into access logs).
#[must_use]
pub fn handshake_request(host: &str, db: &str, token: &str, ws_key: &str) -> String {
    let _ = (host, db, token, ws_key);
    todo!("m20d I7: handshake request")
}

/// `true` only for a `101 Switching Protocols` status line.
#[must_use]
pub fn handshake_is_101(response_head: &str) -> bool {
    let _ = response_head;
    todo!("m20d I7: handshake status")
}

/// An HTTP/1.1 POST with a JSON body and `Connection: close`.
/// `Content-Length` is the BYTE length of the body.
#[must_use]
pub fn http_post_request(host: &str, path: &str, body: &str, token: Option<&str>) -> String {
    let _ = (host, path, body, token);
    todo!("m20d I7: http post")
}

/// An HTTP/1.1 GET with `Connection: close` (identity resolution + `/metrics`).
#[must_use]
pub fn http_get_request(host: &str, path: &str, token: Option<&str>) -> String {
    let _ = (host, path, token);
    todo!("m20d I7: http get")
}

/// The status code from a response head.
///
/// # Errors
/// A missing or non-numeric status line (fail loud; never a default 200).
pub fn http_status(response_head: &str) -> Result<u16, String> {
    let _ = response_head;
    todo!("m20d I7: http status")
}

/// Extract a STRING field by key from a JSON document, at ANY nesting depth,
/// returning the UNESCAPED value. String-aware: a key-shaped substring inside
/// another field's VALUE must never be mistaken for the key.
///
/// # Errors
/// The key is absent, its value is not a string, or the document is truncated.
pub fn extract_json_string_field(json: &str, key: &str) -> Result<String, String> {
    let _ = (json, key);
    todo!("m20d I7: json field extract")
}

/// SATS-JSON name of a direction (externally-tagged enum variant).
#[must_use]
pub fn sats_direction(d: Direction) -> &'static str {
    let _ = d;
    todo!("m20d I7: direction name")
}

/// SATS-JSON for a `MoveInput`: `{"Step":{"East":[]}}` / `{"Jump":[]}`
/// (live-verified end-to-end — the bot moved (1,1)→(2,1)).
#[must_use]
pub fn sats_move_input(input: MoveInput) -> String {
    let _ = input;
    todo!("m20d I7: MoveInput encoding")
}

/// `join_game` args ARRAY: `["LoadBot 3"]`.
#[must_use]
pub fn args_join_game(name: &str) -> String {
    let _ = name;
    todo!("m20d I7: join_game args")
}

/// `enqueue_move` args ARRAY: `[{"Step":{"East":[]}},7]`.
#[must_use]
pub fn args_enqueue_move(input: MoveInput, seq: u64) -> String {
    let _ = (input, seq);
    todo!("m20d I7: enqueue_move args")
}

/// `{"Subscribe":{"query_strings":[…],"request_id":N}}` over [`SUBSCRIBE_QUERIES`].
#[must_use]
pub fn client_msg_subscribe(request_id: u32) -> String {
    let _ = request_id;
    todo!("m20d I7: Subscribe envelope")
}

/// `{"CallReducer":{"reducer":…,"args":…,"request_id":N,"flags":0}}` where
/// `args` is a JSON **string** CONTAINING the args array (live-verified: it is
/// not a raw array), and `flags` is the number 0.
#[must_use]
pub fn client_msg_call_reducer(reducer: &str, args: &str, request_id: u32) -> String {
    let _ = (reducer, args, request_id);
    todo!("m20d I7: CallReducer envelope")
}

// ===========================================================================
// §9 SHELL (the only IO; NOT gated by the test module — the implementer may
// adjust these signatures freely as long as the pure core above is untouched)
// ===========================================================================

/// Cross-thread counters (no mpsc — YAGNI).
#[derive(Debug, Default)]
pub struct ClientCounters {
    pub connected: std::sync::atomic::AtomicU64,
    pub attempted_sends: std::sync::atomic::AtomicU64,
    pub send_errors: std::sync::atomic::AtomicU64,
    pub drain_cap_hits: std::sync::atomic::AtomicU64,
}

/// Open a WS connection, handshake, subscribe, and `join_game`.
/// AM11: sets BOTH a read timeout ([`READ_TIMEOUT_MS`]) and a write timeout.
fn connect_client(
    host: &str,
    cfg: &Config,
    client_index: u32,
    token: &str,
) -> Result<std::net::TcpStream, String> {
    let _ = (host, cfg, client_index, token);
    todo!("m20d I8: connect + handshake + subscribe + join")
}

/// One thread per client: bounded drain (AM2) → one intent → open-loop sleep (AM1).
fn client_thread(cfg: &Config, client_index: u32, token: &str, counters: &ClientCounters) {
    let _ = (cfg, client_index, token, counters);
    todo!("m20d I8: client loop")
}

/// The single scraper thread: `GET /metrics` with explicit timeouts and bounded
/// retries (AM12) — exhaustion aborts the run LOUDLY with a partial report.
fn scraper_thread(
    cfg: &Config,
    db_identity: &str,
    scrapes: &std::sync::Mutex<Vec<Vec<Sample>>>,
) -> Result<(), String> {
    let _ = (cfg, db_identity, scrapes);
    todo!("m20d I8: scraper loop")
}

/// The whole run: parse → resolve identity → ramp → judge → report. Returns the
/// process exit code.
fn run(args: &[String]) -> Result<i32, String> {
    let _ = args;
    todo!("m20d I8: run")
}

fn main() {
    // Thin wrapper: argv in, exit code out (no-logic-in-wrapper, ADR-0051).
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => std::process::exit(code),
        Err(msg) => {
            eprintln!("mr_load_driver: {msg}");
            std::process::exit(exit_code_for_error(&msg));
        }
    }
}

// ===========================================================================
// §10 TESTS — tester-owned (T1–T18). The implementer NEVER edits this module.
//
// Every test is pure: no socket, no clock, no OS entropy, no new dependency.
// "Property" tests are deterministic seeded loops over `game_core::tick_seed`.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use game_core::{
        apply_move, load_zone_maps, map_for, spawn, tick_seed, ActionState, CharacterState, Millis,
        TilePos,
    };

    /// f64 comparison tolerance. Every fixture below is engineered so that a
    /// WRONG implementation is off by ≥1e-3, far outside this window.
    const EPS: f64 = 1e-12;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < EPS
    }

    fn argv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_string()).collect()
    }

    /// Minimal valid argv: only the required `--run-id`.
    fn min_args() -> Vec<String> {
        argv(&["--run-id", "T-0001"])
    }

    /// `min_args()` plus one extra flag pair.
    fn args_with(flag: &str, value: &str) -> Vec<String> {
        argv(&["--run-id", "T-0001", flag, value])
    }

    fn sample(name: &str, labels: &[(&str, &str)], value: f64) -> Sample {
        Sample {
            name: name.to_string(),
            labels: labels
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            value,
        }
    }

    fn snap(bounds: &[f64], counts: &[f64]) -> BucketSnapshot {
        BucketSnapshot {
            bounds: bounds.to_vec(),
            counts: counts.to_vec(),
        }
    }

    const INF: f64 = f64::INFINITY;

    /// The `le` set the LIVE host exposes for `spacetime_txn_elapsed_time_sec`
    /// (Phase-0 verified — NOT the prometheus crate's DEFAULT_BUCKETS).
    /// `STEP_MS` = 0.2 s sits inside the 400 ms-wide `(0.1, 0.5]` bucket.
    const LIVE_BOUNDS: [f64; 14] = [
        0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, INF,
    ];

    /// The literal `le` strings as they appear in the live exposition text.
    const LIVE_LE_TEXT: [&str; 14] = [
        ".00001", ".00005", ".0001", ".0005", ".001", ".005", ".01", ".05", ".1", ".5", "1", "5",
        "10", "+Inf",
    ];

    fn extract_p95_value(p: P95) -> f64 {
        match p {
            P95::Value(v) => v,
            other => panic!("expected P95::Value, got {other:?}"),
        }
    }

    /// Test-local: the ordered keys DIRECTLY inside the first JSON object at or
    /// after `from`. Nesting- and string-aware, so nested object keys and
    /// key-shaped substrings inside values are not counted.
    fn object_keys(s: &str, from: usize) -> Vec<String> {
        let chars: Vec<char> = s[from..].chars().collect();
        let mut i = 0usize;
        while i < chars.len() && chars[i] != '{' {
            i += 1;
        }
        assert!(i < chars.len(), "no JSON object found in the rendered report");
        let mut keys: Vec<String> = Vec::new();
        let mut depth = 0usize;
        while i < chars.len() {
            match chars[i] {
                '{' | '[' => {
                    depth += 1;
                    i += 1;
                }
                '}' | ']' => {
                    depth -= 1;
                    i += 1;
                    if depth == 0 {
                        break;
                    }
                }
                '"' => {
                    let mut j = i + 1;
                    let mut lit = String::new();
                    while j < chars.len() && chars[j] != '"' {
                        if chars[j] == '\\' {
                            lit.push(chars[j]);
                            if j + 1 < chars.len() {
                                lit.push(chars[j + 1]);
                            }
                            j += 2;
                            continue;
                        }
                        lit.push(chars[j]);
                        j += 1;
                    }
                    assert!(j < chars.len(), "unterminated string in the rendered report");
                    let mut k = j + 1;
                    while k < chars.len() && chars[k].is_whitespace() {
                        k += 1;
                    }
                    if depth == 1 && k < chars.len() && chars[k] == ':' {
                        keys.push(lit);
                    }
                    i = j + 1;
                }
                _ => i += 1,
            }
        }
        keys
    }

    // =======================================================================
    // T1 — parse_args: happy path and EVERY bound.
    // =======================================================================

    /// T1: only `--run-id` is required; every other flag has the documented
    /// default. Kills a parser that silently defaults `--run-id` too.
    #[test]
    fn t01_parse_args_defaults_are_exact() {
        let cfg = parse_args(&min_args()).expect("--run-id alone must be sufficient");
        assert_eq!(cfg.server, "http://127.0.0.1:3000");
        assert_eq!(cfg.db, "monster-realm");
        assert_eq!(cfg.scenario, Scenario::Movement);
        assert_eq!(cfg.clients_start, 5);
        assert_eq!(cfg.clients_step, 5);
        assert_eq!(cfg.clients_max, 50);
        assert_eq!(cfg.hold_scrapes, 10);
        assert_eq!(cfg.scrape_interval_ms, 1000);
        assert_eq!(cfg.move_rate, 5);
        assert_eq!(cfg.seed, 0x5EED_0D20);
        assert_eq!(cfg.run_id, "T-0001");
        assert_eq!(cfg.report_path, None);
    }

    /// T1: every flag is read into the field it names (kills a parser that
    /// crosses two numeric flags, e.g. step into start).
    #[test]
    fn t01_parse_args_reads_every_flag_into_its_own_field() {
        let args = argv(&[
            "--server",
            "http://10.0.0.4:3001",
            "--db",
            "mr-scratch",
            "--scenario",
            "movement",
            "--clients-start",
            "3",
            "--clients-step",
            "7",
            "--clients-max",
            "31",
            "--hold-scrapes",
            "12",
            "--scrape-interval-ms",
            "250",
            "--move-rate",
            "9",
            "--seed",
            "12345",
            "--run-id",
            "20260809T120000Z-pairing-on",
            "--report",
            "/tmp/mr-load.json",
        ]);
        let cfg = parse_args(&args).expect("all flags valid");
        assert_eq!(cfg.server, "http://10.0.0.4:3001");
        assert_eq!(cfg.db, "mr-scratch");
        assert_eq!(cfg.scenario, Scenario::Movement);
        assert_eq!(cfg.clients_start, 3);
        assert_eq!(cfg.clients_step, 7);
        assert_eq!(cfg.clients_max, 31);
        assert_eq!(cfg.hold_scrapes, 12);
        assert_eq!(cfg.scrape_interval_ms, 250);
        assert_eq!(cfg.move_rate, 9);
        assert_eq!(cfg.seed, 12345);
        assert_eq!(cfg.run_id, "20260809T120000Z-pairing-on");
        assert_eq!(cfg.report_path.as_deref(), Some("/tmp/mr-load.json"));
    }

    /// T1: `--run-id` is REQUIRED. Kills a parser that invents a default label
    /// (which would silently un-pair every G11 A/B run).
    #[test]
    fn t01_run_id_is_required() {
        let err = parse_args(&argv(&["--clients-start", "5"]))
            .expect_err("a run without --run-id must be rejected");
        assert!(
            err.contains("--run-id"),
            "the error must name the missing flag, got: {err}"
        );
        assert!(
            parse_args(&[]).is_err(),
            "an empty argv must be rejected (no --run-id)"
        );
    }

    /// T1: an empty `--run-id` is not a label.
    #[test]
    fn t01_run_id_must_be_non_empty() {
        assert!(parse_args(&argv(&["--run-id", ""])).is_err());
    }

    /// T1: `--clients-start` boundary — 0 rejected, 1 accepted.
    #[test]
    fn t01_clients_start_lower_bound() {
        assert!(parse_args(&args_with("--clients-start", "0")).is_err());
        let cfg = parse_args(&argv(&[
            "--run-id",
            "T",
            "--clients-start",
            "1",
            "--clients-max",
            "50",
        ]))
        .expect("clients-start 1 is the minimum valid value");
        assert_eq!(cfg.clients_start, 1);
    }

    /// T1: `--clients-step` boundary — 0 rejected (an infinite ramp), 1 accepted.
    #[test]
    fn t01_clients_step_lower_bound() {
        assert!(parse_args(&args_with("--clients-step", "0")).is_err());
        assert!(parse_args(&args_with("--clients-step", "1")).is_ok());
    }

    /// T1: `--clients-max` must be ≥ start; equal is legal and is exactly how
    /// G11 runs a fixed-concurrency A/B.
    #[test]
    fn t01_clients_max_must_not_be_below_start() {
        let bad = argv(&["--run-id", "T", "--clients-start", "20", "--clients-max", "19"]);
        assert!(parse_args(&bad).is_err(), "max < start must be rejected");
        let equal = argv(&["--run-id", "T", "--clients-start", "20", "--clients-max", "20"]);
        let cfg = parse_args(&equal).expect("max == start is the single-level G11 case");
        assert_eq!(cfg.clients_start, cfg.clients_max);
    }

    /// T1: the hard client cap. 500 accepted, 501 rejected — kills a `>=` flip
    /// on the cap and any parser that ignores MAX_CLIENTS entirely.
    #[test]
    fn t01_clients_max_cap_is_exactly_max_clients() {
        assert_eq!(MAX_CLIENTS, 500);
        let ok = argv(&["--run-id", "T", "--clients-max", "500"]);
        assert!(
            parse_args(&ok).is_ok(),
            "clients-max == MAX_CLIENTS must be accepted"
        );
        let bad = argv(&["--run-id", "T", "--clients-max", "501"]);
        assert!(
            parse_args(&bad).is_err(),
            "clients-max above MAX_CLIENTS must be rejected"
        );
    }

    /// T1 + AM6: `--hold-scrapes` ≥ 4 (1 warm-up discard + ≥3 usable readings).
    /// 3 MUST be rejected — that is the value a naive "≥3 readings" reading of
    /// the growth rule would allow, and it leaves only 2 usable readings.
    #[test]
    fn t01_hold_scrapes_floor_rejects_three_accepts_four() {
        assert_eq!(MIN_HOLD_SCRAPES, 4);
        assert!(
            parse_args(&args_with("--hold-scrapes", "3")).is_err(),
            "hold-scrapes 3 leaves only 2 usable readings after the warm-up discard"
        );
        let cfg = parse_args(&args_with("--hold-scrapes", "4")).expect("4 is the floor");
        assert_eq!(cfg.hold_scrapes, 4);
    }

    /// T1: `--scrape-interval-ms` ≥ 100.
    #[test]
    fn t01_scrape_interval_floor() {
        assert!(parse_args(&args_with("--scrape-interval-ms", "99")).is_err());
        let cfg = parse_args(&args_with("--scrape-interval-ms", "100")).expect("100 is the floor");
        assert_eq!(cfg.scrape_interval_ms, MIN_SCRAPE_INTERVAL_MS);
    }

    /// T1: `--move-rate` bounds, both ends.
    #[test]
    fn t01_move_rate_bounds() {
        assert!(parse_args(&args_with("--move-rate", "0")).is_err());
        assert!(parse_args(&args_with("--move-rate", "1")).is_ok());
        assert!(parse_args(&args_with("--move-rate", "100")).is_ok());
        assert!(parse_args(&args_with("--move-rate", "101")).is_err());
    }

    /// T1: an unknown flag is a loud error, never ignored.
    #[test]
    fn t01_unknown_flag_is_rejected() {
        let err = parse_args(&argv(&["--run-id", "T", "--turbo", "1"]))
            .expect_err("an unknown flag must be rejected");
        assert!(
            err.contains("--turbo"),
            "the error must name the offending flag, got: {err}"
        );
    }

    /// T1 + AM25: `--transport` DOES NOT EXIST. WS is the only viable transport
    /// (HTTP calls are swept by `on_disconnect`), so the flag must be rejected
    /// as unknown — not accepted-and-ignored, and not silently defaulted.
    #[test]
    fn t01_transport_flag_does_not_exist_am25() {
        assert!(
            parse_args(&argv(&["--run-id", "T", "--transport", "ws"])).is_err(),
            "--transport was deleted by AM25; it must be an unknown flag"
        );
        assert!(
            parse_args(&argv(&["--run-id", "T", "--transport", "http"])).is_err(),
            "--transport http must not be resurrectable through the CLI"
        );
    }

    /// T1 + AM17/AM18: neither `--queue-metric` nor `--label` exists.
    #[test]
    fn t01_queue_metric_and_label_flags_do_not_exist() {
        assert!(
            parse_args(&argv(&[
                "--run-id",
                "T",
                "--queue-metric",
                "spacetime_subscription_send_queue_length"
            ]))
            .is_err(),
            "--queue-metric was cut by AM17 (QUEUE_FAMILIES is a const)"
        );
        assert!(
            parse_args(&argv(&["--run-id", "T", "--label", "pairing=on"])).is_err(),
            "--label was rejected by AM18 (--run-id carries the label by convention)"
        );
    }

    /// T1: a flag whose value is missing is an error, not a silent default.
    #[test]
    fn t01_missing_flag_value_is_rejected() {
        assert!(parse_args(&argv(&["--run-id"])).is_err());
        assert!(parse_args(&argv(&["--run-id", "T", "--clients-max"])).is_err());
    }

    /// T1: a non-numeric value for a numeric flag is an error.
    #[test]
    fn t01_non_numeric_value_is_rejected() {
        assert!(parse_args(&args_with("--clients-max", "many")).is_err());
        assert!(parse_args(&args_with("--seed", "0xdead")).is_err());
        assert!(parse_args(&args_with("--hold-scrapes", "-4")).is_err());
    }

    /// T1: a bare positional argument is not a flag.
    #[test]
    fn t01_positional_argument_is_rejected() {
        assert!(parse_args(&argv(&["--run-id", "T", "extra"])).is_err());
    }

    /// T1: `--server` must be non-empty (the host is derived from it).
    #[test]
    fn t01_empty_server_is_rejected() {
        assert!(parse_args(&args_with("--server", "")).is_err());
    }

    /// T1: `server_host` strips the scheme, rejects TLS and non-HTTP schemes
    /// (this driver has no TLS — silently connecting in the clear would be worse).
    #[test]
    fn t01_server_host_extraction_and_scheme_guard() {
        assert_eq!(
            server_host("http://127.0.0.1:3000").expect("plain http is supported"),
            "127.0.0.1:3000"
        );
        assert_eq!(
            server_host("http://127.0.0.1:3000/").expect("a trailing slash is tolerated"),
            "127.0.0.1:3000"
        );
        assert!(
            server_host("https://127.0.0.1:3000").is_err(),
            "https must fail loud — this driver cannot do TLS"
        );
        assert!(server_host("ws://127.0.0.1:3000").is_err());
        assert!(server_host("127.0.0.1:3000").is_err(), "a scheme is required");
        assert!(server_host("http://").is_err(), "an empty host is an error");
    }

    /// T1 + AM1: pacing is a pure function of `--move-rate`, clock-free.
    /// 5/sec ⇒ one intent per STEP_MS minus the drain allowance.
    #[test]
    fn t01_pacing_sleep_is_a_pure_function_of_move_rate() {
        assert_eq!(pacing_sleep_ms(5), 1000 / 5 - READ_TIMEOUT_MS);
        assert_eq!(pacing_sleep_ms(1), 1000 - READ_TIMEOUT_MS);
        assert_eq!(
            pacing_sleep_ms(100),
            0,
            "at 100/sec the 10 ms period saturates against the 5 ms drain allowance"
        );
        assert_eq!(pacing_sleep_ms(0), 0, "must be total, never divide by zero");
    }

    // =======================================================================
    // T2 — the reserved chat-flood scenario (OBS-28 / M19).
    // =======================================================================

    /// T2: `--scenario chat-flood` is rejected AT PARSE with the exact reserved
    /// message. Pinned by equality, not `contains`, so the message cannot drift
    /// into something that no longer names its criterion.
    #[test]
    fn t02_chat_flood_is_rejected_with_the_reserved_error() {
        let err = parse_args(&args_with("--scenario", "chat-flood"))
            .expect_err("chat-flood must not produce a Config");
        assert_eq!(err, SCENARIO_RESERVED_ERR);
    }

    /// T2: the reserved message names both the criterion and the milestone, so
    /// an operator learns WHY without reading the source.
    #[test]
    fn t02_reserved_error_names_obs28_and_m19() {
        assert!(SCENARIO_RESERVED_ERR.contains("OBS-28"));
        assert!(SCENARIO_RESERVED_ERR.contains("M19"));
        assert!(SCENARIO_RESERVED_ERR.contains("chat-flood"));
    }

    /// T2: the reserved scenario exits 2 — distinct from a generic usage error,
    /// so a harness can tell "not implemented yet" from "you typed it wrong".
    #[test]
    fn t02_chat_flood_maps_to_exit_code_two() {
        assert_eq!(exit_code_for_error(SCENARIO_RESERVED_ERR), 2);
        assert_eq!(exit_code_for_error("unknown flag: --turbo"), 1);
        assert_eq!(exit_code_for_error("--run-id is required"), 1);
    }

    /// T2: `movement` is accepted; an unknown scenario is a plain usage error
    /// (exit 1), NOT the reserved one.
    #[test]
    fn t02_movement_accepted_unknown_scenario_is_a_plain_error() {
        assert_eq!(
            parse_args(&args_with("--scenario", "movement"))
                .expect("movement is the implemented scenario")
                .scenario,
            Scenario::Movement
        );
        let err = parse_args(&args_with("--scenario", "pvp-storm"))
            .expect_err("an unknown scenario must be rejected");
        assert_ne!(
            err, SCENARIO_RESERVED_ERR,
            "an unknown scenario is not the reserved chat-flood case"
        );
        assert_eq!(exit_code_for_error(&err), 1);
    }

    // =======================================================================
    // T3 — Prometheus exposition parse + SUBSET label matching + label pins.
    // =======================================================================

    /// T3: comments and blank lines are skipped, not errors.
    #[test]
    fn t03_parse_line_skips_comments_and_blanks() {
        assert_eq!(parse_line("# HELP spacetime_num_txns_total total"), Ok(None));
        assert_eq!(parse_line("# TYPE spacetime_num_txns_total counter"), Ok(None));
        assert_eq!(parse_line(""), Ok(None));
        assert_eq!(parse_line("   "), Ok(None));
    }

    /// T3: a label-less series parses.
    #[test]
    fn t03_parse_line_without_labels() {
        let s = parse_line("spacetime_worker_wasm_memory_bytes 1048576")
            .expect("a valid label-less line")
            .expect("not a comment");
        assert_eq!(s.name, "spacetime_worker_wasm_memory_bytes");
        assert!(s.labels.is_empty());
        assert!(close(s.value, 1_048_576.0));
    }

    /// T3: labels parse in text order, with the value after the closing brace.
    #[test]
    fn t03_parse_line_with_labels() {
        let s = parse_line(
            "spacetime_num_txns_total{committed=\"true\",db=\"c200ab\",reducer=\"enqueue_move\",txn_type=\"Reducer\"} 42",
        )
        .expect("a valid labelled line")
        .expect("not a comment");
        assert_eq!(s.name, "spacetime_num_txns_total");
        assert_eq!(s.labels.len(), 4);
        assert_eq!(label_value(&s, "committed"), Some("true"));
        assert_eq!(label_value(&s, "db"), Some("c200ab"));
        assert_eq!(label_value(&s, "reducer"), Some("enqueue_move"));
        assert_eq!(label_value(&s, "txn_type"), Some("Reducer"));
        assert_eq!(label_value(&s, "absent"), None);
        assert!(close(s.value, 42.0));
    }

    /// T3: exponent notation and an optional trailing timestamp — both appear in
    /// real exposition. Kills a parser that treats the timestamp as the value.
    #[test]
    fn t03_parse_line_handles_exponents_and_trailing_timestamp() {
        let s = parse_line("spacetime_x 1.5e+07")
            .expect("exponent notation is legal")
            .expect("not a comment");
        assert!(close(s.value, 15_000_000.0));
        let s = parse_line("spacetime_x{a=\"b\"} 7 1620000000000")
            .expect("a trailing timestamp is legal and ignored")
            .expect("not a comment");
        assert!(
            close(s.value, 7.0),
            "the VALUE is 7; the trailing token is a timestamp, not the value"
        );
    }

    /// T3: malformed lines fail LOUD. A silent skip would turn a broken scrape
    /// into a fake "0" and then into a fake breaking point.
    #[test]
    fn t03_parse_line_fails_loud_on_malformed_input() {
        assert!(parse_line("spacetime_x{a=\"b\"").is_err(), "unbalanced brace");
        assert!(parse_line("spacetime_x").is_err(), "no value");
        assert!(parse_line("spacetime_x{a=\"b\"} notanumber").is_err());
        assert!(parse_line("{a=\"b\"} 1").is_err(), "no family name");
    }

    /// T3: the three legal label escapes round-trip; anything else fails loud
    /// (memory: fail loud on parse ambiguity, never guess).
    #[test]
    fn t03_label_unescape_handles_the_three_legal_escapes() {
        assert_eq!(label_unescape("plain"), Ok("plain".to_string()));
        assert_eq!(label_unescape("a\\\"b"), Ok("a\"b".to_string()));
        assert_eq!(label_unescape("a\\\\b"), Ok("a\\b".to_string()));
        assert_eq!(label_unescape("a\\nb"), Ok("a\nb".to_string()));
        assert!(label_unescape("a\\tb").is_err(), "\\t is not a legal label escape");
        assert!(label_unescape("a\\").is_err(), "a trailing backslash is an error");
    }

    /// T3: a label value containing an escaped quote and a comma must not split
    /// the label list early.
    #[test]
    fn t03_parse_line_label_value_may_contain_escaped_quotes_and_commas() {
        let s = parse_line("spacetime_x{note=\"a\\\"b,c\",k=\"v\"} 3")
            .expect("escaped quotes inside a label value are legal")
            .expect("not a comment");
        assert_eq!(s.labels.len(), 2, "the comma inside the value must not split labels");
        assert_eq!(label_value(&s, "note"), Some("a\"b,c"));
        assert_eq!(label_value(&s, "k"), Some("v"));
    }

    /// T3: matching is SUBSET-based. Exact-label-set equality is the classic
    /// vacuous-green shape here — real exposition carries extra labels
    /// (`db`, `txn_type`, `le`) that we do not always constrain.
    #[test]
    fn t03_label_matching_is_subset_not_exact_set() {
        let s = sample(
            "spacetime_num_txns_total",
            &[
                ("committed", "true"),
                ("db", "c200ab"),
                ("reducer", "enqueue_move"),
                ("txn_type", "Reducer"),
            ],
            42.0,
        );
        assert!(
            matches_labels(&s, &[("reducer", "enqueue_move")]),
            "a subset of one label must match a four-label series"
        );
        assert!(matches_labels(&s, &[]), "an empty requirement matches anything");
        assert!(
            !matches_labels(&s, &[("reducer", "join_game")]),
            "a value mismatch must not match"
        );
        assert!(
            !matches_labels(&s, &[("reducer", "enqueue_move"), ("zone", "0")]),
            "a required label that is ABSENT must not match"
        );
    }

    /// T3: selection filters on family name AND labels.
    #[test]
    fn t03_select_subset_filters_on_name_and_labels() {
        let samples = vec![
            sample("a", &[("k", "1")], 1.0),
            sample("a", &[("k", "2")], 2.0),
            sample("b", &[("k", "1")], 3.0),
        ];
        let hits = select_subset(&samples, "a", &[("k", "1")]);
        assert_eq!(hits.len(), 1);
        assert!(close(hits[0].value, 1.0));
        assert!(select_subset(&samples, "zzz", &[]).is_empty());
    }

    /// T3 + AM26: an ABSENT family (or an over-pinned match) is a LOUD error,
    /// never a silent 0. A zero would read as "no queue growth" / "no load".
    #[test]
    fn t03_counter_sum_fails_loud_when_nothing_matches() {
        let samples = vec![sample("a", &[("k", "1")], 1.0)];
        assert!(
            counter_sum(&samples, "missing_family", &[]).is_err(),
            "an absent family must fail loud, never return 0"
        );
        assert!(
            counter_sum(&samples, "a", &[("k", "9")]).is_err(),
            "zero matching series after pinning must fail loud (AM26)"
        );
        assert!(gauge_sum(&samples, "missing_family", &[]).is_err());
    }

    /// T3: multiple matching series are summed, so silent aggregation is at
    /// least arithmetically honest.
    #[test]
    fn t03_counter_sum_adds_every_matching_series() {
        let samples = vec![
            sample("a", &[("k", "1"), ("z", "x")], 10.0),
            sample("a", &[("k", "1"), ("z", "y")], 5.0),
            sample("a", &[("k", "2")], 100.0),
        ];
        assert!(close(
            counter_sum(&samples, "a", &[("k", "1")]).expect("two series match"),
            15.0
        ));
    }

    /// T3 + AM27 TEETH: the live host exposes an `txn_type="Update"` row
    /// ALONGSIDE `txn_type="Reducer"` for every reducer. A match that forgets to
    /// pin `txn_type` double-counts every accept/reject delta and halves the
    /// apparent breaking point. This fixture returns 10, never 17.
    #[test]
    fn t03_txn_match_pins_reducer_txn_type_and_excludes_update_rows() {
        let samples = vec![
            sample(
                TXN_COUNT_FAMILY,
                &[
                    ("committed", "true"),
                    ("db", "c200ab"),
                    ("reducer", "enqueue_move"),
                    ("txn_type", "Reducer"),
                ],
                10.0,
            ),
            sample(
                TXN_COUNT_FAMILY,
                &[
                    ("committed", "true"),
                    ("db", "c200ab"),
                    ("reducer", "enqueue_move"),
                    ("txn_type", "Update"),
                ],
                7.0,
            ),
        ];
        let pinned = txn_count_match("c200ab", "enqueue_move", "true");
        let total = counter_sum(&samples, TXN_COUNT_FAMILY, &pinned).expect("one series matches");
        assert!(
            close(total, 10.0),
            "expected only the txn_type=Reducer row (10), got {total} — an unpinned match sums the Update row too"
        );
    }

    /// T3 + AM26 TEETH: two databases on one host. Pinning the resolved identity
    /// must exclude the other database's series entirely.
    #[test]
    fn t03_identity_pinning_excludes_other_databases() {
        let samples = vec![
            sample(
                TXN_COUNT_FAMILY,
                &[
                    ("committed", "true"),
                    ("db", "aaaa"),
                    ("reducer", "enqueue_move"),
                    ("txn_type", "Reducer"),
                ],
                100.0,
            ),
            sample(
                TXN_COUNT_FAMILY,
                &[
                    ("committed", "true"),
                    ("db", "bbbb"),
                    ("reducer", "enqueue_move"),
                    ("txn_type", "Reducer"),
                ],
                200.0,
            ),
        ];
        let pinned = txn_count_match("aaaa", "enqueue_move", "true");
        let total = counter_sum(&samples, TXN_COUNT_FAMILY, &pinned).expect("one series matches");
        assert!(
            close(total, 100.0),
            "expected only db=aaaa (100), got {total} — an unpinned match sums both databases"
        );
    }

    /// T3 + AM26: the live LABEL-NAME ASYMMETRY. txn families use `db=`; the
    /// queue gauges use `database_identity=`. Swapping them yields zero matches
    /// and (thanks to the fail-loud rule) an aborted run rather than a lie.
    #[test]
    fn t03_label_pins_encode_the_live_label_name_asymmetry() {
        assert_eq!(
            txn_match("c200ab", REDUCER_MOVEMENT_TICK),
            [
                ("db", "c200ab"),
                ("reducer", "movement_tick"),
                ("txn_type", "Reducer"),
            ]
        );
        assert_eq!(
            txn_count_match("c200ab", REDUCER_ENQUEUE_MOVE, "false"),
            [
                ("db", "c200ab"),
                ("reducer", "enqueue_move"),
                ("txn_type", "Reducer"),
                ("committed", "false"),
            ]
        );
        assert_eq!(queue_match("c200ab"), [("database_identity", "c200ab")]);
        assert_eq!(TXN_TYPE_REDUCER, "Reducer");
    }

    /// T3: the queue gauge families are the two OBS-26/27 names, in order.
    #[test]
    fn t03_queue_families_are_the_two_obs26_gauges() {
        assert_eq!(
            QUEUE_FAMILIES,
            [
                "spacetime_subscription_send_queue_length",
                "spacetime_worker_instance_operation_queue_length",
            ]
        );
        assert_eq!(SUBSCRIBE_QUERIES, ["SELECT * FROM character"]);
    }

    /// T3: whole-body parse keeps every series and propagates a bad line.
    #[test]
    fn t03_parse_exposition_round_trip_and_failure() {
        let text = "# HELP x help\n# TYPE x gauge\nx{a=\"1\"} 1\nx{a=\"2\"} 2\n";
        let samples = parse_exposition(text).expect("a well-formed body");
        assert_eq!(samples.len(), 2);
        assert!(
            parse_exposition("x{a=\"1\"} 1\nbroken line here\n").is_err(),
            "one malformed line must fail the whole scrape, loudly"
        );
    }

    /// T3 + AM26: name→identity resolution, `0x` stripped for label matching.
    #[test]
    fn t03_database_identity_resolution_strips_0x() {
        let body = "{\"database_identity\":{\"__identity__\":\"0xc200abcdef\"},\"owner_identity\":{\"__identity__\":\"0xdead\"}}";
        assert_eq!(
            database_identity_from_json(body).expect("the live GET /v1/database/<name> shape"),
            "c200abcdef"
        );
        assert_eq!(strip_0x("0xabc"), "abc");
        assert_eq!(strip_0x("abc"), "abc", "already-stripped input is unchanged");
        assert!(database_identity_from_json("{\"other\":1}").is_err());
    }

    // =======================================================================
    // T4 — histogram bounds READ FROM THE TEXT (never hard-coded).
    // =======================================================================

    /// Build a `_bucket` exposition body with arbitrary `le` strings.
    fn hist_text(db: &str, reducer: &str, txn_type: &str, le: &[&str], counts: &[u64]) -> String {
        assert_eq!(le.len(), counts.len());
        let mut out = String::new();
        for (bound, count) in le.iter().zip(counts.iter()) {
            out.push_str(&format!(
                "{TXN_ELAPSED_BUCKET_FAMILY}{{db=\"{db}\",reducer=\"{reducer}\",txn_type=\"{txn_type}\",le=\"{bound}\"}} {count}\n"
            ));
        }
        out
    }

    /// T4: the bound set comes from the `le` labels in the text — including the
    /// live host's NON-default bounds and `+Inf`. Kills any hard-coded bound
    /// array (the prometheus-crate DEFAULT_BUCKETS guess was wrong for this
    /// family, so a hard-coded set would silently mis-bucket every p95).
    #[test]
    fn t04_bucket_bounds_are_read_from_the_exposition_text() {
        let counts: Vec<u64> = vec![0, 0, 0, 0, 0, 0, 0, 0, 90, 100, 100, 100, 100, 100];
        let text = hist_text("c200ab", REDUCER_MOVEMENT_TICK, "Reducer", &LIVE_LE_TEXT, &counts);
        let samples = parse_exposition(&text).expect("valid exposition");
        let pinned = txn_match("c200ab", REDUCER_MOVEMENT_TICK);
        let s = histogram_snapshot(&samples, TXN_ELAPSED_BUCKET_FAMILY, &pinned)
            .expect("14 matching bucket series");
        assert_eq!(s.bounds.len(), 14);
        assert_eq!(s.counts.len(), 14);
        for (i, want) in LIVE_BOUNDS.iter().enumerate() {
            if want.is_infinite() {
                assert!(s.bounds[i].is_infinite(), "bound {i} must be +Inf");
            } else {
                assert!(close(s.bounds[i], *want), "bound {i}: got {}", s.bounds[i]);
            }
        }
        assert!(close(s.counts[8], 90.0));
        assert!(close(s.counts[13], 100.0));
    }

    /// T4: bounds come back ASCENDING even when the text order is shuffled —
    /// Prometheus does not promise bucket-line ordering.
    #[test]
    fn t04_bucket_bounds_are_sorted_ascending_regardless_of_text_order() {
        let text = hist_text("d", "r", "Reducer", &["+Inf", "1", "0.1"], &[30, 20, 10]);
        let samples = parse_exposition(&text).expect("valid exposition");
        let s = histogram_snapshot(&samples, TXN_ELAPSED_BUCKET_FAMILY, &txn_match("d", "r"))
            .expect("three matching series");
        assert!(close(s.bounds[0], 0.1));
        assert!(close(s.bounds[1], 1.0));
        assert!(s.bounds[2].is_infinite());
        assert!(close(s.counts[0], 10.0));
        assert!(close(s.counts[1], 20.0));
        assert!(close(s.counts[2], 30.0));
    }

    /// T4: two series sharing an `le` set are summed bucket-wise.
    #[test]
    fn t04_matching_series_are_summed_bucket_wise() {
        let mut text = hist_text("d", "r", "Reducer", &["0.1", "+Inf"], &[1, 2]);
        text.push_str(&format!(
            "{TXN_ELAPSED_BUCKET_FAMILY}{{db=\"d\",reducer=\"r\",txn_type=\"Reducer\",worker=\"2\",le=\"0.1\"}} 10\n{TXN_ELAPSED_BUCKET_FAMILY}{{db=\"d\",reducer=\"r\",txn_type=\"Reducer\",worker=\"2\",le=\"+Inf\"}} 20\n"
        ));
        let samples = parse_exposition(&text).expect("valid exposition");
        let s = histogram_snapshot(&samples, TXN_ELAPSED_BUCKET_FAMILY, &txn_match("d", "r"))
            .expect("two series, identical le sets");
        assert!(close(s.counts[0], 11.0));
        assert!(close(s.counts[1], 22.0));
    }

    /// T4 + AM14 TEETH: summing series whose `le` sets DIFFER is a silent lie
    /// (the sum would describe a histogram that never existed). Fail loud.
    #[test]
    fn t04_mismatched_le_sets_fail_loud() {
        let mut text = hist_text("d", "r", "Reducer", &["0.1", "+Inf"], &[1, 2]);
        text.push_str(&format!(
            "{TXN_ELAPSED_BUCKET_FAMILY}{{db=\"d\",reducer=\"r\",txn_type=\"Reducer\",worker=\"2\",le=\"0.25\"}} 10\n{TXN_ELAPSED_BUCKET_FAMILY}{{db=\"d\",reducer=\"r\",txn_type=\"Reducer\",worker=\"2\",le=\"+Inf\"}} 20\n"
        ));
        let samples = parse_exposition(&text).expect("valid exposition");
        assert!(
            histogram_snapshot(&samples, TXN_ELAPSED_BUCKET_FAMILY, &txn_match("d", "r")).is_err(),
            "series with different le sets must never be summed"
        );
    }

    /// T4 + AM26: zero matching bucket series is fatal, not an empty histogram.
    #[test]
    fn t04_absent_histogram_family_fails_loud() {
        let samples = parse_exposition("other_family 1\n").expect("valid exposition");
        assert!(
            histogram_snapshot(&samples, TXN_ELAPSED_BUCKET_FAMILY, &txn_match("d", "r")).is_err()
        );
    }

    // =======================================================================
    // T5 — p95 estimation: interpolation, AboveTop, TooFew, Reset, the budget
    //      boundary, and the AM6 warm-up discard inside the window.
    // =======================================================================

    /// T5 + AM10: the REAL live bucket bounds, with a delta whose p95 lands in
    /// the 400 ms-wide `(0.1, 0.5]` bucket that straddles STEP_MS.
    ///
    /// rank = 0.95·100 = 95; cum(0.1) = 90, cum(0.5) = 100
    /// ⇒ 0.1 + (0.5−0.1)·(95−90)/10 = **0.30 s**.
    ///
    /// Kills: returning the bucket's upper bound (0.5), its lower bound (0.1),
    /// or a midpoint (0.3 by luck only — see the second fixture below), and
    /// kills any fixture-set that only uses convenient evenly-spaced bounds.
    #[test]
    fn t05_p95_interpolates_within_real_live_bucket_bounds() {
        let delta = snap(
            &LIVE_BOUNDS,
            &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 90.0, 100.0, 100.0, 100.0, 100.0, 100.0],
        );
        let v = extract_p95_value(p95_from_delta(&delta));
        assert!(
            close(v, 0.3),
            "expected the interpolated 0.30 s inside the (0.1, 0.5] bucket, got {v}"
        );
        assert_eq!(
            p95_breaches_budget(P95::Value(v)),
            Breach::Yes,
            "0.30 s is over the {BUDGET_MS} ms budget"
        );
    }

    /// T5 + AM10: the resolution indicator for that same fixture is the FULL
    /// 400 ms bucket width — the honest statement of how coarse this p95 is.
    #[test]
    fn t05_p95_bucket_width_exposes_the_400ms_live_bucket() {
        let delta = snap(
            &LIVE_BOUNDS,
            &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 90.0, 100.0, 100.0, 100.0, 100.0, 100.0],
        );
        let w = p95_bucket_width_s(&delta).expect("a Value outcome has a containing bucket");
        assert!(close(w, 0.4), "expected the (0.1, 0.5] width 0.4, got {w}");
    }

    /// T5: evenly spaced bounds with a HAND-COMPUTED expected value.
    /// rank = 0.95·20 = 19; cum(1) = 10, cum(2) = 20
    /// ⇒ 1 + (2−1)·(19−10)/10 = **1.9**.
    /// Kills a midpoint estimator (1.5) and a "return the upper bound" (2.0).
    #[test]
    fn t05_p95_linear_interpolation_hand_computed() {
        let delta = snap(&[1.0, 2.0, 3.0, INF], &[10.0, 20.0, 20.0, 20.0]);
        let v = extract_p95_value(p95_from_delta(&delta));
        assert!(close(v, 1.9), "expected 1.9, got {v}");
        assert!(close(
            p95_bucket_width_s(&delta).expect("Value has a width"),
            1.0
        ));
    }

    /// T5: when the p95 falls in the FIRST bucket the lower edge is 0, not
    /// `bounds[-1]`. rank = 19 of 20 in `(0, 1]` ⇒ 0 + 1·19/20 = **0.95**.
    /// Kills an off-by-one that indexes `bounds[i-1]` at i == 0.
    #[test]
    fn t05_p95_first_bucket_interpolates_from_zero() {
        let delta = snap(&[1.0, 2.0, INF], &[20.0, 20.0, 20.0]);
        let v = extract_p95_value(p95_from_delta(&delta));
        assert!(close(v, 0.95), "expected 0.95, got {v}");
        assert!(close(
            p95_bucket_width_s(&delta).expect("Value has a width"),
            1.0
        ));
    }

    /// T5: more than 5 % of observations above the top finite bound ⇒ AboveTop,
    /// carrying that bound. It is NEVER reported as the p95 value itself.
    #[test]
    fn t05_p95_above_top_is_never_reported_as_the_top_bound() {
        let delta = snap(&[0.1, 0.5, INF], &[10.0, 90.0, 100.0]);
        let p = p95_from_delta(&delta);
        assert_eq!(p, P95::AboveTop(0.5));
        assert_eq!(
            p95_value_s(p),
            None,
            "an AboveTop outcome must not surface a numeric p95"
        );
        assert_eq!(p95_top_finite_s(p), Some(0.5));
        assert_eq!(p95_state_name(p), "above_top");
        assert_eq!(
            p95_bucket_width_s(&delta),
            None,
            "an unbounded bucket has no meaningful width"
        );
    }

    /// T5: AboveTop is a breach only when the top finite bound is already at or
    /// over the budget; below it, the reading is INDETERMINATE — never silently
    /// healthy.
    #[test]
    fn t05_above_top_breach_rule() {
        assert_eq!(p95_breaches_budget(P95::AboveTop(BUDGET_S)), Breach::Yes);
        assert_eq!(p95_breaches_budget(P95::AboveTop(10.0)), Breach::Yes);
        assert_eq!(
            p95_breaches_budget(P95::AboveTop(BUDGET_S - 1e-9)),
            Breach::Indeterminate,
            "a top bound under the budget cannot decide the question"
        );
    }

    /// T5: an all-zero delta means nothing was observed in the window.
    #[test]
    fn t05_p95_too_few_on_an_empty_window() {
        let delta = snap(&[1.0, 2.0, INF], &[0.0, 0.0, 0.0]);
        assert_eq!(p95_from_delta(&delta), P95::TooFew);
        assert_eq!(p95_value_s(P95::TooFew), None);
        assert_eq!(p95_state_name(P95::TooFew), "too_few");
        assert_eq!(p95_bucket_width_s(&delta), None);
    }

    /// T5: a NEGATIVE component means the cumulative counter went backwards —
    /// the host restarted mid-level. Reset, never a (nonsense) percentile.
    #[test]
    fn t05_p95_reset_on_a_decreasing_counter() {
        let delta = snap(&[1.0, 2.0, INF], &[-5.0, 10.0, 10.0]);
        assert_eq!(p95_from_delta(&delta), P95::Reset);
        assert_eq!(p95_state_name(P95::Reset), "reset");
        assert_eq!(p95_value_s(P95::Reset), None);
    }

    /// T5 + AM9 BOUNDARY: the breach comparator is INCLUSIVE. p95 exactly at
    /// STEP_MS is a BREACH, because OBS-24 is satisfied only by staying UNDER
    /// the budget. Kills a `>` comparator.
    #[test]
    fn t05_p95_exactly_at_step_ms_is_a_breach() {
        assert_eq!(
            p95_breaches_budget(P95::Value(BUDGET_S)),
            Breach::Yes,
            "p95 == STEP_MS must breach (inclusive comparator, AM9)"
        );
        assert_eq!(
            p95_breaches_budget(P95::Value(BUDGET_S - 1e-9)),
            Breach::No,
            "strictly under the budget is healthy"
        );
        assert_eq!(p95_breaches_budget(P95::Value(BUDGET_S + 1e-9)), Breach::Yes);
    }

    /// T5: a healthy p95 well under the budget is not a breach, and
    /// TooFew/Reset are indeterminate (they make the LEVEL invalid rather than
    /// quietly passing as healthy).
    #[test]
    fn t05_non_value_outcomes_are_indeterminate_not_healthy() {
        assert_eq!(p95_breaches_budget(P95::Value(0.001)), Breach::No);
        assert_eq!(p95_breaches_budget(P95::TooFew), Breach::Indeterminate);
        assert_eq!(p95_breaches_budget(P95::Reset), Breach::Indeterminate);
    }

    /// T5 + AM6/AM8 TEETH: the level p95 is ONE delta over the USABLE window —
    /// last usable minus FIRST USABLE, with the warm-up reading discarded.
    ///
    /// Correct (c − a): counts [0,100,100] ⇒ 1 + 1·(95−0)/100 = **1.95**.
    /// Forgetting the discard (c − warm-up): [100,200,200] ⇒ 1 + 1·(190−100)/100
    /// = 1.90. This assertion separates the two.
    #[test]
    fn t05_p95_window_drops_the_warmup_reading() {
        let raw = vec![
            snap(&[1.0, 2.0, INF], &[0.0, 0.0, 0.0]),
            snap(&[1.0, 2.0, INF], &[100.0, 100.0, 100.0]),
            snap(&[1.0, 2.0, INF], &[100.0, 200.0, 200.0]),
        ];
        let delta = window_delta(&raw)
            .expect("consistent le sets")
            .expect("two usable readings");
        assert!(close(delta.counts[0], 0.0), "the first bucket delta is 0, not 100");
        assert!(close(delta.counts[1], 100.0));
        let v = extract_p95_value(p95_windowed(&raw).expect("consistent le sets"));
        assert!(
            close(v, 1.95),
            "expected 1.95 from the warm-up-discarded window; 1.90 means the connect-burst reading was included. got {v}"
        );
    }

    /// T5: fewer than two USABLE readings cannot make a delta.
    #[test]
    fn t05_p95_window_needs_two_usable_readings() {
        let one = vec![snap(&[1.0, INF], &[1.0, 1.0])];
        assert_eq!(window_delta(&one).expect("no le conflict"), None);
        assert_eq!(p95_windowed(&one).expect("no le conflict"), P95::TooFew);
        let two = vec![
            snap(&[1.0, INF], &[1.0, 1.0]),
            snap(&[1.0, INF], &[2.0, 2.0]),
        ];
        assert_eq!(
            window_delta(&two).expect("no le conflict"),
            None,
            "2 raw readings leave only 1 usable after the warm-up discard"
        );
    }

    /// T5 + AM14: a bound set that changes mid-level (a re-published module)
    /// must fail loud rather than subtract mismatched buckets.
    #[test]
    fn t05_window_delta_fails_loud_on_changed_bounds() {
        let raw = vec![
            snap(&[1.0, INF], &[0.0, 0.0]),
            snap(&[1.0, INF], &[1.0, 1.0]),
            snap(&[1.0, 2.0, INF], &[1.0, 2.0, 2.0]),
        ];
        assert!(window_delta(&raw).is_err());
        assert!(p95_windowed(&raw).is_err());
    }

    /// T5: `Value` reports its number and its state name.
    #[test]
    fn t05_value_state_reporting() {
        assert_eq!(p95_state_name(P95::Value(0.25)), "value");
        assert_eq!(p95_value_s(P95::Value(0.25)), Some(0.25));
        assert_eq!(p95_top_finite_s(P95::Value(0.25)), None);
    }

    // =======================================================================
    // T6 — the monotonic-growth detector and the AM6 warm-up window.
    // =======================================================================

    /// T6 + AM22 CHEAT-SHAPE FIXTURE: an oscillating series with a NET GAIN.
    /// `last > first` is true (2 > 1), so a "compare the ends" detector calls
    /// this growth. It is not: the queue drains twice. Kills that detector.
    #[test]
    fn t06_oscillating_series_with_net_gain_is_not_growth() {
        assert!(
            !is_monotonic_growth(&[1.0, 100.0, 1.0, 100.0, 2.0]),
            "an oscillating queue is a server keeping up, not divergence — \
             a last>first detector wrongly reports growth here"
        );
    }

    /// T6: a flat queue — even a flat queue at a high plateau — is not growth
    /// (AM7: the server keeps up at that concurrency).
    #[test]
    fn t06_flat_series_is_not_growth() {
        assert!(!is_monotonic_growth(&[5.0, 5.0, 5.0, 5.0]));
        assert!(!is_monotonic_growth(&[900.0, 900.0, 900.0]));
    }

    /// T6: strictly increasing with a real gain IS growth.
    #[test]
    fn t06_strictly_increasing_series_is_growth() {
        assert!(is_monotonic_growth(&[1.0, 2.0, 3.0]));
        assert!(is_monotonic_growth(&[0.0, 10.0, 40.0, 90.0]));
    }

    /// T6: a single flat pair anywhere breaks strictness.
    #[test]
    fn t06_one_flat_pair_breaks_strictness() {
        assert!(!is_monotonic_growth(&[1.0, 2.0, 2.0, 3.0]));
        assert!(!is_monotonic_growth(&[3.0, 2.0, 1.0]));
    }

    /// T6: fewer than three readings cannot establish a trend.
    #[test]
    fn t06_fewer_than_three_readings_is_not_growth() {
        assert!(!is_monotonic_growth(&[]));
        assert!(!is_monotonic_growth(&[1.0]));
        assert!(!is_monotonic_growth(&[1.0, 99.0]));
    }

    /// T6: increasing but by less than one whole queued item is float noise on
    /// an integer-valued gauge, not growth.
    #[test]
    fn t06_sub_unit_drift_is_not_growth() {
        assert!(
            !is_monotonic_growth(&[1.0, 1.2, 1.4]),
            "a total gain of 0.4 on an integer gauge is noise"
        );
        assert!(
            is_monotonic_growth(&[1.0, 1.5, 2.0]),
            "a total gain of exactly 1.0 qualifies"
        );
    }

    /// T6 + AM6: the window function drops exactly WARMUP_SCRAPES readings from
    /// the FRONT, uniformly, for any series type.
    #[test]
    fn t06_usable_window_drops_exactly_the_warmup_readings() {
        assert_eq!(WARMUP_SCRAPES, 1);
        assert_eq!(usable_window(&[1.0, 2.0, 3.0, 4.0]), vec![2.0, 3.0, 4.0]);
        assert_eq!(usable_window(&[9.0]), Vec::<f64>::new());
        assert_eq!(usable_window::<f64>(&[]), Vec::<f64>::new());
        assert_eq!(
            usable_window(&[snap(&[1.0], &[7.0]), snap(&[1.0], &[8.0])]),
            vec![snap(&[1.0], &[8.0])],
            "the same discard applies to histogram snapshots"
        );
    }

    /// T6 + AM6 CONNECT-BURST FIXTURE: the first raw reading holds the connect
    /// burst (500 queued sends). Judged raw, the series is NOT increasing, so
    /// real divergence afterwards would be missed. With the warm-up discarded,
    /// `[1, 2, 3]` is growth. The two assertions together prove the discard is
    /// actually applied inside `level_growth`.
    #[test]
    fn t06_connect_burst_first_reading_is_excluded_from_the_growth_window() {
        let raw = [500.0, 1.0, 2.0, 3.0];
        assert!(
            !is_monotonic_growth(&raw),
            "precondition: the RAW series is not monotonic (500 → 1 falls)"
        );
        assert!(
            level_growth(&raw),
            "after the AM6 warm-up discard the level IS diverging: [1, 2, 3]"
        );
    }

    /// T6 + AM6 TEETH (the other direction): a series whose only "growth" is the
    /// discarded warm-up reading must NOT count. Raw `[1, 2, 3]` looks like
    /// growth; the usable window is only `[2, 3]` — two readings, no verdict.
    /// Kills an implementation that forgets the discard in `level_growth`.
    #[test]
    fn t06_growth_that_depends_on_the_discarded_reading_does_not_count() {
        assert!(
            is_monotonic_growth(&[1.0, 2.0, 3.0]),
            "precondition: the raw series would qualify"
        );
        assert!(
            !level_growth(&[1.0, 2.0, 3.0]),
            "only [2, 3] survives the warm-up discard — too few readings to judge"
        );
    }

    /// T6: a queue that spikes on connect and then sits flat is a server keeping
    /// up — the most common false positive this rule must refuse.
    #[test]
    fn t06_spike_then_plateau_is_not_growth() {
        assert!(!level_growth(&[0.0, 50.0, 50.0, 50.0]));
        assert!(!level_growth(&[0.0, 5.0, 4.0, 6.0, 5.0]));
    }

    /// T6: median over the usable window (the AM7 plateau statistic).
    #[test]
    fn t06_median_is_order_independent() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), Some(2.5));
        assert_eq!(median(&[7.0]), Some(7.0));
        assert_eq!(median(&[]), None);
    }

    // =======================================================================
    // T7 — the breaking-point state machine (OBS-27).
    // =======================================================================

    /// A healthy, valid verdict at `n`.
    fn ok_verdict(n: u32) -> LevelVerdict {
        LevelVerdict {
            concurrency: n,
            valid: true,
            invalid_reason: None,
            p95: P95::Value(0.01),
            p95_bucket_width_s: Some(0.1),
            queue_growth: Vec::new(),
            plateau_by_family: vec![
                (QUEUE_FAMILIES[0].to_string(), Some(1.0)),
                (QUEUE_FAMILIES[1].to_string(), Some(0.0)),
            ],
            notes: Vec::new(),
        }
    }

    fn verdict_with_p95(n: u32, p95: P95) -> LevelVerdict {
        LevelVerdict { p95, ..ok_verdict(n) }
    }

    fn verdict_with_queue_growth(n: u32, family: &str) -> LevelVerdict {
        LevelVerdict {
            queue_growth: vec![family.to_string()],
            ..ok_verdict(n)
        }
    }

    /// T7: the FIRST crossing is the answer, and it is that level's exact
    /// concurrency — not the previous level, not the next one.
    #[test]
    fn t07_first_crossing_reports_exactly_that_level() {
        let verdicts = vec![
            ok_verdict(5),
            ok_verdict(10),
            verdict_with_p95(15, P95::Value(0.9)),
            verdict_with_p95(20, P95::Value(1.9)),
        ];
        let bp = breaking_point(&verdicts).expect("level 15 crosses");
        assert_eq!(bp.concurrency, 15);
        assert_eq!(bp.reason, P95_BREACH_REASON);
    }

    /// T7: no crossing ⇒ None (the `not_reached` outcome, a legitimate result
    /// on a dev box that must never be massaged into a number).
    #[test]
    fn t07_no_crossing_is_none() {
        let verdicts = vec![ok_verdict(5), ok_verdict(10), ok_verdict(15)];
        assert_eq!(breaking_point(&verdicts), None);
        assert_eq!(breaking_point(&[]), None);
    }

    /// T7: a queue-growth crossing names the offending family.
    #[test]
    fn t07_queue_growth_crossing_names_the_family() {
        let verdicts = vec![
            ok_verdict(5),
            verdict_with_queue_growth(10, QUEUE_FAMILIES[1]),
        ];
        let bp = breaking_point(&verdicts).expect("level 10 crosses on the queue signal");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(
            bp.reason,
            format!("{QUEUE_BREACH_PREFIX}{}", QUEUE_FAMILIES[1])
        );
    }

    /// T7: an EARLIER p95 breach wins over a LATER queue breach — "first
    /// crosses" is about ramp order, not signal preference.
    #[test]
    fn t07_earlier_p95_breach_beats_a_later_queue_breach() {
        let verdicts = vec![
            ok_verdict(5),
            verdict_with_p95(10, P95::Value(0.5)),
            verdict_with_queue_growth(15, QUEUE_FAMILIES[0]),
        ];
        let bp = breaking_point(&verdicts).expect("level 10 crosses first");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(bp.reason, P95_BREACH_REASON);
    }

    /// T7: an EARLIER queue breach wins over a LATER p95 breach, symmetrically.
    /// Kills an implementation that scans for p95 breaches first and only then
    /// looks at queues.
    #[test]
    fn t07_earlier_queue_breach_beats_a_later_p95_breach() {
        let verdicts = vec![
            ok_verdict(5),
            verdict_with_queue_growth(10, QUEUE_FAMILIES[0]),
            verdict_with_p95(15, P95::Value(0.5)),
        ];
        let bp = breaking_point(&verdicts).expect("level 10 crosses first");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(
            bp.reason,
            format!("{QUEUE_BREACH_PREFIX}{}", QUEUE_FAMILIES[0])
        );
    }

    /// T7: both signals at the SAME level ⇒ the p95 reason is reported (it is
    /// the SLO of record, OBS-24).
    #[test]
    fn t07_p95_reason_wins_when_both_fire_at_one_level() {
        let both = LevelVerdict {
            p95: P95::Value(0.5),
            queue_growth: vec![QUEUE_FAMILIES[0].to_string()],
            ..ok_verdict(10)
        };
        let bp = breaking_point(&[ok_verdict(5), both]).expect("level 10 crosses");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(bp.reason, P95_BREACH_REASON);
    }

    /// T7 TEETH: an INVALID level can never be the breaking point, however
    /// alarming its numbers look. The run continues to the next valid level.
    #[test]
    fn t07_invalid_level_is_never_the_breaking_point() {
        let broken = LevelVerdict {
            valid: false,
            invalid_reason: Some("join_failed".to_string()),
            p95: P95::Value(9.9),
            queue_growth: vec![QUEUE_FAMILIES[0].to_string()],
            ..ok_verdict(10)
        };
        let bp = breaking_point(&[ok_verdict(5), broken, verdict_with_p95(15, P95::Value(0.4))])
            .expect("the next VALID breaching level is the answer");
        assert_eq!(
            bp.concurrency, 15,
            "a level invalidated by a tool error must be skipped, not reported"
        );
    }

    /// T7 TEETH: if the ONLY breaching level is invalid, the honest answer is
    /// None — never "the number we happened to see".
    #[test]
    fn t07_only_invalid_breaches_yield_no_breaking_point() {
        let broken = LevelVerdict {
            valid: false,
            invalid_reason: Some("counter_reset".to_string()),
            p95: P95::Value(9.9),
            ..ok_verdict(10)
        };
        assert_eq!(breaking_point(&[ok_verdict(5), broken, ok_verdict(15)]), None);
    }

    /// T7 + AM9: a p95 sitting EXACTLY on STEP_MS crosses. This is the same
    /// inclusive rule as T5, exercised through the state machine.
    #[test]
    fn t07_p95_exactly_at_the_budget_crosses() {
        let verdicts = vec![ok_verdict(5), verdict_with_p95(10, P95::Value(BUDGET_S))];
        let bp = breaking_point(&verdicts).expect("p95 == STEP_MS is a crossing");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(bp.reason, P95_BREACH_REASON);
    }

    /// T7: an `AboveTop` whose top bound is already over the budget crosses; a
    /// `TooFew`/`Reset` outcome never does (those levels are invalid anyway).
    #[test]
    fn t07_above_top_over_budget_crosses() {
        let bp = breaking_point(&[verdict_with_p95(10, P95::AboveTop(10.0))])
            .expect("a p95 above a 10 s top bound is unambiguously over budget");
        assert_eq!(bp.concurrency, 10);
        assert_eq!(bp.reason, P95_BREACH_REASON);
        assert_eq!(breaking_point(&[verdict_with_p95(10, P95::TooFew)]), None);
    }

    /// T7 + AM7 DIAGNOSTIC: cross-level plateau growth over ≥3 consecutive
    /// levels is reported, and is NOT a breach reason.
    #[test]
    fn t07_cross_level_plateau_growth_is_a_note_not_a_breach() {
        let plateau = |n: u32, v: f64| LevelVerdict {
            plateau_by_family: vec![
                (QUEUE_FAMILIES[0].to_string(), Some(v)),
                (QUEUE_FAMILIES[1].to_string(), Some(0.0)),
            ],
            ..ok_verdict(n)
        };
        let verdicts = vec![plateau(5, 1.0), plateau(10, 4.0), plateau(15, 9.0)];
        assert_eq!(cross_level_growth(&verdicts), vec![QUEUE_FAMILIES[0].to_string()]);
        assert_eq!(
            breaking_point(&verdicts),
            None,
            "a rising plateau across levels is evidence, never the OBS-27 crossing"
        );
    }

    /// T7 + AM7: two rising levels are not enough, and a non-consecutive rise
    /// does not count.
    #[test]
    fn t07_cross_level_growth_needs_three_consecutive_levels() {
        let plateau = |n: u32, v: f64| LevelVerdict {
            plateau_by_family: vec![(QUEUE_FAMILIES[0].to_string(), Some(v))],
            ..ok_verdict(n)
        };
        assert!(cross_level_growth(&[plateau(5, 1.0), plateau(10, 2.0)]).is_empty());
        assert!(
            cross_level_growth(&[plateau(5, 1.0), plateau(10, 2.0), plateau(15, 2.0)]).is_empty(),
            "the third level must be strictly higher"
        );
        assert_eq!(
            cross_level_growth(&[
                plateau(5, 9.0),
                plateau(10, 1.0),
                plateau(15, 2.0),
                plateau(20, 3.0),
            ]),
            vec![QUEUE_FAMILIES[0].to_string()],
            "a rising run of three anywhere in the ramp counts"
        );
    }

    // =======================================================================
    // T8 — evaluate_level: the AM5 validity semantics.
    // =======================================================================

    /// A healthy level: 10 clients all joined, load flowing, p95 ≈ 0.095 s,
    /// queues flat. Bounds are the live `(0, 0.1]` / `(0.1, 0.5]` shape.
    fn base_sample(concurrency: u32) -> LevelSample {
        LevelSample {
            concurrency,
            clients_connected: concurrency,
            join_committed_total_delta: f64::from(concurrency),
            enqueue_accepted_delta: 100.0,
            enqueue_rejected_delta: 0.0,
            movement_tick_txn_delta: 50.0,
            p95_snapshots: vec![
                snap(&[0.1, 0.5, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.1, 0.5, INF], &[10.0, 10.0, 10.0]),
                snap(&[0.1, 0.5, INF], &[110.0, 110.0, 110.0]),
            ],
            queue_readings: vec![
                (QUEUE_FAMILIES[0].to_string(), vec![9.0, 1.0, 1.0, 1.0]),
                (QUEUE_FAMILIES[1].to_string(), vec![0.0, 0.0, 0.0, 0.0]),
            ],
            attempted_sends: 120,
            drain_cap_hits: 0,
            send_errors: 0,
            counter_decreased: false,
        }
    }

    /// T8: the healthy baseline is valid, unremarkable, and under budget.
    #[test]
    fn t08_healthy_level_is_valid_with_no_notes() {
        let v = evaluate_level(&base_sample(10)).expect("consistent bounds");
        assert!(v.valid);
        assert_eq!(v.invalid_reason, None);
        assert_eq!(v.concurrency, 10);
        assert!(close(extract_p95_value(v.p95), 0.095), "p95 = 0.1 · 0.95");
        assert_eq!(p95_breaches_budget(v.p95), Breach::No);
        assert!(v.queue_growth.is_empty());
        assert!(v.notes.is_empty());
    }

    /// T8 + AM5/AM22 THE CHEAT-SHAPE KILLER: `accepted == 0` with
    /// `rejected > 0` is a queue-full storm at saturation. Its p95 and queue
    /// readings are REAL measurements of a saturated server, so the level stays
    /// VALID and merely gains a note. Kills the literal
    /// `accepted == 0 → invalid` implementation, which would discard exactly the
    /// levels where the breaking point lives.
    #[test]
    fn t08_rejection_storm_level_stays_valid_with_a_note() {
        let s = LevelSample {
            enqueue_accepted_delta: 0.0,
            enqueue_rejected_delta: 4200.0,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(
            v.valid,
            "a saturated server that rejects everything is still measurable — \
             this level must NOT be invalidated"
        );
        assert_eq!(v.invalid_reason, None);
        assert!(
            v.notes.contains(&REJECTION_STORM_NOTE.to_string()),
            "the storm must be annotated, got notes {:?}",
            v.notes
        );
    }

    /// T8 + D8: rejections are never blended into a health signal. A level with
    /// both accepts and rejects is ordinary, and gets no storm note.
    #[test]
    fn t08_mixed_accepts_and_rejects_is_not_a_storm() {
        let s = LevelSample {
            enqueue_accepted_delta: 900.0,
            enqueue_rejected_delta: 100.0,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(v.valid);
        assert!(!v.notes.contains(&REJECTION_STORM_NOTE.to_string()));
    }

    /// T8 + AM5: NOTHING reached the server — a driver stall or a connection
    /// collapse. Invalid, and therefore never a breaking point.
    #[test]
    fn t08_zero_offered_load_is_invalid_no_load_reached() {
        let s = LevelSample {
            enqueue_accepted_delta: 0.0,
            enqueue_rejected_delta: 0.0,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("no_load_reached"));
    }

    /// T8 + AM5: the join wave came up short — driver-side auth/name/validation
    /// drift. A LOUD TOOL ERROR, never a server verdict.
    #[test]
    fn t08_join_shortfall_is_invalid_join_failed() {
        let s = LevelSample {
            join_committed_total_delta: 9.0,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("join_failed"));
    }

    /// T8 BOUNDARY: exactly enough joins is enough. Kills a `<=` flip that would
    /// invalidate every well-behaved run.
    #[test]
    fn t08_join_count_exactly_equal_to_concurrency_is_valid() {
        let s = LevelSample {
            join_committed_total_delta: 10.0,
            ..base_sample(10)
        };
        assert!(evaluate_level(&s).expect("consistent bounds").valid);
        let more = LevelSample {
            join_committed_total_delta: 11.0,
            ..base_sample(10)
        };
        assert!(
            evaluate_level(&more).expect("consistent bounds").valid,
            "a cumulative delta ABOVE the level's client count is normal — \
             earlier levels' joins are included"
        );
    }

    /// T8 + AM5: a decreasing cumulative counter means the host restarted.
    #[test]
    fn t08_counter_decrease_is_invalid_counter_reset() {
        let s = LevelSample {
            counter_decreased: true,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("counter_reset"));
    }

    /// T8: a histogram window that goes backwards is the same restart, seen
    /// through the p95 path.
    #[test]
    fn t08_histogram_reset_is_invalid_counter_reset() {
        let s = LevelSample {
            p95_snapshots: vec![
                snap(&[0.1, 0.5, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.1, 0.5, INF], &[500.0, 500.0, 500.0]),
                snap(&[0.1, 0.5, INF], &[10.0, 10.0, 10.0]),
            ],
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("counter_reset"));
        assert_eq!(v.p95, P95::Reset);
    }

    /// T8: no usable p95 window ⇒ invalid, never "healthy by default".
    #[test]
    fn t08_too_few_p95_samples_is_invalid() {
        let s = LevelSample {
            p95_snapshots: vec![snap(&[0.1, 0.5, INF], &[1.0, 1.0, 1.0])],
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("insufficient_samples"));
    }

    /// T8: an `AboveTop` under the budget is INDETERMINATE — the level is
    /// invalid rather than silently reported as healthy or as a breach.
    #[test]
    fn t08_indeterminate_above_top_is_invalid() {
        let s = LevelSample {
            p95_snapshots: vec![
                snap(&[0.001, 0.01, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.001, 0.01, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.001, 0.01, INF], &[1.0, 2.0, 100.0]),
            ],
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert_eq!(v.p95, P95::AboveTop(0.01));
        assert!(!v.valid);
        assert_eq!(v.invalid_reason.as_deref(), Some("p95_indeterminate"));
    }

    /// T8: precedence — a host restart explains everything else, so it is
    /// reported instead of the join shortfall it caused.
    #[test]
    fn t08_counter_reset_takes_precedence_over_join_failed() {
        let s = LevelSample {
            counter_decreased: true,
            join_committed_total_delta: 0.0,
            enqueue_accepted_delta: 0.0,
            enqueue_rejected_delta: 0.0,
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert_eq!(v.invalid_reason.as_deref(), Some("counter_reset"));
    }

    /// T8 + AM6/AM7: within-level growth is computed from the RAW gauge series
    /// with the warm-up reading discarded. The first family's raw series here is
    /// `[9, 1, 5, 20]`: raw it is not monotonic, but the usable `[1, 5, 20]` is.
    #[test]
    fn t08_queue_growth_is_detected_over_the_usable_window() {
        let s = LevelSample {
            queue_readings: vec![
                (QUEUE_FAMILIES[0].to_string(), vec![9.0, 1.0, 5.0, 20.0]),
                (QUEUE_FAMILIES[1].to_string(), vec![0.0, 3.0, 3.0, 3.0]),
            ],
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert_eq!(
            v.queue_growth,
            vec![QUEUE_FAMILIES[0].to_string()],
            "only the diverging family may be listed"
        );
    }

    /// T8 + AM7: the plateau statistic is the median of the USABLE window, per
    /// family, in input order. `[9, 1, 5, 20]` → median of `[1, 5, 20]` = 5.
    #[test]
    fn t08_plateau_is_the_median_of_the_usable_window() {
        let s = LevelSample {
            queue_readings: vec![
                (QUEUE_FAMILIES[0].to_string(), vec![9.0, 1.0, 5.0, 20.0]),
                (QUEUE_FAMILIES[1].to_string(), vec![0.0, 3.0, 3.0, 3.0]),
            ],
            ..base_sample(10)
        };
        let v = evaluate_level(&s).expect("consistent bounds");
        assert_eq!(v.plateau_by_family.len(), 2);
        assert_eq!(v.plateau_by_family[0].0, QUEUE_FAMILIES[0]);
        assert!(close(
            v.plateau_by_family[0].1.expect("three usable readings"),
            5.0
        ));
        assert!(close(
            v.plateau_by_family[1].1.expect("three usable readings"),
            3.0
        ));
    }

    /// T8: the AM10 resolution indicator rides along on every valid level.
    #[test]
    fn t08_verdict_carries_the_p95_bucket_width() {
        let v = evaluate_level(&base_sample(10)).expect("consistent bounds");
        assert!(close(
            v.p95_bucket_width_s.expect("a Value outcome has a width"),
            0.1
        ));
    }

    /// T8 + AM14: an `le` set that changes mid-level is a TOOL error, surfaced
    /// as `Err` rather than folded into a level verdict.
    #[test]
    fn t08_changed_bounds_mid_level_is_an_error_not_a_verdict() {
        let s = LevelSample {
            p95_snapshots: vec![
                snap(&[0.1, INF], &[0.0, 0.0]),
                snap(&[0.1, INF], &[1.0, 1.0]),
                snap(&[0.1, 0.5, INF], &[1.0, 2.0, 2.0]),
            ],
            ..base_sample(10)
        };
        assert!(evaluate_level(&s).is_err());
    }

    // =======================================================================
    // T9 — the report renderer: key order, escaping, and secret hygiene.
    // =======================================================================

    /// The exact top-level key order of a `schema:1` report.
    const TOP_KEYS: [&str; 17] = [
        "tool",
        "schema",
        "run_id",
        "server",
        "db",
        "db_identity",
        "transport",
        "scenario",
        "step_ms",
        "scrape_interval_ms",
        "hold_scrapes",
        "move_rate",
        "seed",
        "breaking_point",
        "not_reached",
        "levels",
        "notes",
    ];

    /// The exact per-level key order.
    const LEVEL_KEYS: [&str; 19] = [
        "concurrency",
        "scrapes",
        "clients_connected",
        "movement_tick_p95_s",
        "p95_state",
        "p95_top_finite_s",
        "p95_bucket_width_s",
        "queues",
        "queue_growth",
        "plateau",
        "enqueue_move_accepted_delta",
        "enqueue_move_rejected_delta",
        "movement_tick_txn_delta",
        "attempted_sends",
        "drain_cap_hits",
        "send_errors",
        "valid",
        "invalid_reason",
        "notes",
    ];

    /// The token fixture. Deliberately NOT JWT-shaped: the live
    /// `/v1/identity` token is a real JWT and gitleaks scans the diff remotely,
    /// where a local `just ci` cannot catch it.
    const TOKEN_FIXTURE: &str = "TOKEN-PLACEHOLDER-abc123";

    fn run_fixture(run_id: &str, samples: Vec<LevelSample>) -> Run {
        let cfg = parse_args(&argv(&["--run-id", run_id])).expect("valid argv");
        let levels = samples
            .into_iter()
            .map(|s| {
                let verdict = evaluate_level(&s).expect("consistent bounds");
                LevelReport { sample: s, verdict }
            })
            .collect();
        Run {
            config: cfg,
            db_identity: "c200abcdef".to_string(),
            auth_token: TOKEN_FIXTURE.to_string(),
            levels,
            notes: vec![CO_LOCATION_NOTE.to_string()],
        }
    }

    /// T9: the top-level key ORDER is fixed. A stable order is what makes two
    /// runs diffable and the G11 A/B comparable.
    #[test]
    fn t09_top_level_key_order_is_exact() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5)]));
        assert_eq!(object_keys(&report, 0), TOP_KEYS.to_vec());
    }

    /// T9: the per-level key order is fixed too.
    #[test]
    fn t09_level_key_order_is_exact() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5)]));
        let at = report
            .find("\"levels\":[")
            .expect("the report must carry a compact \"levels\":[ array");
        assert_eq!(object_keys(&report, at), LEVEL_KEYS.to_vec());
    }

    /// T9: the fixed header values, including the `"transport":"ws"` literal
    /// (AM25 — there is no other transport to report).
    #[test]
    fn t09_fixed_header_values() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5)]));
        assert!(report.starts_with("{\"tool\":\"mr_load_driver\",\"schema\":1,"));
        assert!(report.contains("\"transport\":\"ws\""));
        assert!(report.contains("\"scenario\":\"movement\""));
        assert!(report.contains(&format!("\"step_ms\":{BUDGET_MS}")));
        assert!(report.contains("\"db_identity\":\"c200abcdef\""));
        assert!(report.ends_with('}'));
        assert!(
            !report.contains('\n'),
            "the report is compact single-line JSON"
        );
    }

    /// T9 SECRET HYGIENE: neither the bearer token nor the word `Bearer` may
    /// appear anywhere in the report. Kills a renderer that serialises the whole
    /// `Run` (which CARRIES the token) instead of the redacted view.
    #[test]
    fn t09_report_never_contains_the_token_or_the_word_bearer() {
        let run = run_fixture("T-9", vec![base_sample(5)]);
        let report = render_report(&run);
        assert!(
            !report.contains(TOKEN_FIXTURE),
            "the auth token leaked into the report"
        );
        assert!(
            !report.contains("Bearer"),
            "no Authorization material may reach the report"
        );
        assert!(
            !report.contains("auth_token"),
            "not even the field name belongs in the report"
        );
    }

    /// T9: run_id escaping — quote, backslash, and control characters. The
    /// run_id is operator-supplied free text and is the ONLY unconstrained
    /// string in the report.
    #[test]
    fn t09_run_id_is_json_escaped() {
        let raw_run_id = "run\"1\\2\u{0001}3\n4";
        let report = render_report(&run_fixture(raw_run_id, vec![base_sample(5)]));
        // Assembled from `bs` so this source file carries no bare unicode escape.
        // Expected: run, quote, 1, backslash, 2, the SOH control char in its
        // six-character escaped form, 3, the newline in its escaped form, 4.
        let bs = '\\';
        let expected = format!("\"run_id\":\"run{bs}\"1{bs}{bs}2{bs}u00013{bs}n4\"");
        assert!(
            report.contains(&expected),
            "run_id must be escaped exactly as {expected}, got: {report}"
        );
        assert!(
            !report.contains('\u{0001}'),
            "a raw control character must never reach the output"
        );
    }

    /// T9: `json_escape` unit vectors.
    #[test]
    fn t09_json_escape_vectors() {
        assert_eq!(json_escape("plain"), "plain");
        assert_eq!(json_escape("a\"b"), "a\\\"b");
        assert_eq!(json_escape("a\\b"), "a\\\\b");
        assert_eq!(json_escape("a\nb"), "a\\nb");
        assert_eq!(json_escape("a\rb"), "a\\rb");
        assert_eq!(json_escape("a\tb"), "a\\tb");
        assert_eq!(json_escape("a\u{0001}b"), "a\\u0001b");
        assert_eq!(json_escape("a\u{001F}b"), "a\\u001fb");
        assert_eq!(json_escape("Poké"), "Poké", "non-ASCII passes through");
    }

    /// T9: non-finite floats render as `null`, never as the invalid JSON token
    /// `inf` or `NaN` (a `+Inf` bucket width is a real possibility).
    #[test]
    fn t09_json_number_renders_non_finite_as_null() {
        assert_eq!(json_number(1.5), "1.5");
        assert_eq!(json_number(12.0), "12");
        assert_eq!(json_number(0.0), "0");
        assert_eq!(json_number(f64::INFINITY), "null");
        assert_eq!(json_number(f64::NEG_INFINITY), "null");
        assert_eq!(json_number(f64::NAN), "null");
    }

    /// T9: with no crossing, `breaking_point` is literal `null` and
    /// `not_reached` is `true` — the legitimate dev-box outcome, reported as
    /// such rather than massaged into a number.
    #[test]
    fn t09_null_breaking_point_and_not_reached_true() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5), base_sample(10)]));
        assert!(report.contains("\"breaking_point\":null"));
        assert!(report.contains("\"not_reached\":true"));
    }

    /// T9: with a crossing, the object form carries the concurrency and reason,
    /// and `not_reached` flips. The renderer derives this from the SAME state
    /// machine the verdicts came from, so the two can never disagree.
    #[test]
    fn t09_breaking_point_object_form() {
        let breaching = LevelSample {
            p95_snapshots: vec![
                snap(&[0.1, 0.5, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.1, 0.5, INF], &[0.0, 0.0, 0.0]),
                snap(&[0.1, 0.5, INF], &[90.0, 100.0, 100.0]),
            ],
            ..base_sample(10)
        };
        let report = render_report(&run_fixture("T-9", vec![base_sample(5), breaching]));
        assert!(
            report.contains(&format!(
                "\"breaking_point\":{{\"concurrency\":10,\"reason\":\"{P95_BREACH_REASON}\"}}"
            )),
            "expected the level-10 p95 crossing, got: {report}"
        );
        assert!(report.contains("\"not_reached\":false"));
    }

    /// T9: level payload values — the raw queue series, the counts, and the
    /// validity fields all reach the report.
    #[test]
    fn t09_level_payload_carries_the_raw_series_and_counters() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5)]));
        assert!(report.contains("\"concurrency\":5"));
        assert!(report.contains("\"scrapes\":3"));
        assert!(report.contains("\"clients_connected\":5"));
        assert!(
            report.contains(&format!(
                "\"{}\":[9,1,1,1]",
                QUEUE_FAMILIES[0]
            )),
            "the RAW per-scrape gauge series (warm-up reading included) must be \
             emitted so a human can re-judge, got: {report}"
        );
        assert!(report.contains("\"attempted_sends\":120"));
        assert!(report.contains("\"drain_cap_hits\":0"));
        assert!(report.contains("\"send_errors\":0"));
        assert!(report.contains("\"valid\":true"));
        assert!(report.contains("\"invalid_reason\":null"));
        assert!(report.contains("\"queue_growth\":[]"));
    }

    /// T9: an invalid level renders its reason as a STRING, not `null`.
    #[test]
    fn t09_invalid_reason_renders_as_a_string() {
        let broken = LevelSample {
            join_committed_total_delta: 0.0,
            ..base_sample(5)
        };
        let report = render_report(&run_fixture("T-9", vec![broken]));
        assert!(report.contains("\"valid\":false"));
        assert!(report.contains("\"invalid_reason\":\"join_failed\""));
    }

    /// T9: run-level notes are emitted (the AM4 co-location caveat is one).
    #[test]
    fn t09_run_notes_are_emitted() {
        let report = render_report(&run_fixture("T-9", vec![base_sample(5)]));
        assert!(report.contains(&format!("\"notes\":[\"{CO_LOCATION_NOTE}\"]")));
    }

    /// T9: every level appears, in ramp order.
    #[test]
    fn t09_every_level_is_reported_in_order() {
        let report = render_report(&run_fixture(
            "T-9",
            vec![base_sample(5), base_sample(10), base_sample(15)],
        ));
        let at5 = report.find("\"concurrency\":5").expect("level 5 present");
        let at10 = report.find("\"concurrency\":10").expect("level 10 present");
        let at15 = report.find("\"concurrency\":15").expect("level 15 present");
        assert!(at5 < at10 && at10 < at15, "levels must keep ramp order");
    }

    // =======================================================================
    // T10 — the budget constant IS game_core::STEP_MS.
    // =======================================================================

    /// T10: the driver's budget is the imported `STEP_MS` (ADR-0003 SSOT), not
    /// a re-spelled literal that could silently drift from the tick cadence.
    #[test]
    fn t10_budget_is_game_core_step_ms() {
        assert_eq!(
            BUDGET_MS,
            game_core::STEP_MS,
            "BUDGET_MS must be defined AS the game_core::STEP_MS import"
        );
        assert!(close(BUDGET_S, game_core::STEP_MS as f64 / 1000.0));
    }

    /// T10: the budget is what the comparator actually uses — a constant nobody
    /// reads would be a decoration, not an SSOT.
    #[test]
    fn t10_the_comparator_uses_the_step_ms_budget() {
        let just_under = game_core::STEP_MS as f64 / 1000.0 - 1e-9;
        let just_over = game_core::STEP_MS as f64 / 1000.0 + 1e-9;
        assert_eq!(p95_breaches_budget(P95::Value(just_under)), Breach::No);
        assert_eq!(p95_breaches_budget(P95::Value(just_over)), Breach::Yes);
    }

    // =======================================================================
    // T11 — ramp planning (seeded deterministic property loop, 256 cases).
    // =======================================================================

    /// T11: the documented default ramp and the G11 single-level shape.
    #[test]
    fn t11_ramp_levels_known_vectors() {
        assert_eq!(
            ramp_levels(5, 5, 50),
            vec![5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
        );
        assert_eq!(
            ramp_levels(7, 5, 20),
            vec![7, 12, 17],
            "the ramp stops BELOW max when the step overshoots — it never exceeds max"
        );
        assert_eq!(
            ramp_levels(10, 5, 10),
            vec![10],
            "start == max is the single-level G11 pairing A/B"
        );
        assert_eq!(ramp_levels(5, 5, 7), vec![5]);
        assert_eq!(ramp_levels(1, 1, 3), vec![1, 2, 3]);
    }

    /// T11: 256 deterministic seeded cases. Every invariant is asserted in a
    /// block body so a failure names the case.
    #[test]
    fn t11_ramp_levels_seeded_property_loop() {
        for case in 0..256u64 {
            let h = tick_seed(case, 0xA1, 0x5EED_0D20);
            let start = u32::try_from(h % 50).expect("in range") + 1;
            let step = u32::try_from((h >> 16) % 25).expect("in range") + 1;
            let extra = u32::try_from((h >> 32) % 200).expect("in range");
            let max = (start + extra).min(MAX_CLIENTS);
            let levels = ramp_levels(start, step, max);
            assert!(
                !levels.is_empty(),
                "case {case}: start={start} step={step} max={max} must yield ≥1 level"
            );
            assert_eq!(levels[0], start, "case {case}: the ramp starts at --clients-start");
            for w in levels.windows(2) {
                assert_eq!(
                    w[1] - w[0],
                    step,
                    "case {case}: levels advance by exactly --clients-step"
                );
            }
            for l in &levels {
                assert!(*l <= max, "case {case}: level {l} exceeds max {max}");
                assert!(*l >= start, "case {case}: level {l} is below start {start}");
            }
            let last = *levels.last().expect("non-empty");
            assert!(
                last + step > max,
                "case {case}: the ramp stopped early — {last}+{step} still fits under {max}"
            );
            assert_eq!(
                levels.len(),
                ((max - start) / step + 1) as usize,
                "case {case}: level count"
            );
        }
    }

    /// T11: the planner is referentially deterministic.
    #[test]
    fn t11_ramp_levels_is_deterministic() {
        assert_eq!(ramp_levels(3, 7, 40), ramp_levels(3, 7, 40));
    }

    // =======================================================================
    // T12 — the bot model: names, seqs, and the East/West walk.
    // =======================================================================

    /// T12 + AM15: generated names stay far inside
    /// `server-module/src/guards.rs::validate_name` — alphanumeric + space only,
    /// NFC-stable ASCII, trimmed, and ≤ 12 chars over the whole client range.
    /// (MAX_NAME_LEN there is 24; the charset allowlist is letters/numbers/space.)
    #[test]
    fn t12_bot_names_satisfy_the_server_name_rules() {
        for i in 0..10_000u32 {
            let name = bot_name(i);
            assert!(!name.is_empty(), "bot_name({i}) is empty");
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' '),
                "bot_name({i}) = {name:?} leaves the letters/numbers/space allowlist"
            );
            assert_eq!(name.trim(), name, "bot_name({i}) = {name:?} is not trimmed");
            assert!(
                name.chars().count() <= 12,
                "bot_name({i}) = {name:?} is longer than 12 chars"
            );
        }
    }

    /// T12: names are distinct per client (each bot is its own player).
    #[test]
    fn t12_bot_names_are_distinct() {
        let set: std::collections::BTreeSet<String> = (0..1000u32).map(bot_name).collect();
        assert_eq!(set.len(), 1000, "bot names collide across clients");
    }

    /// T12: the exact name shape, pinned so the T17 envelope fixture and the
    /// live-verified wire string cannot drift apart.
    #[test]
    fn t12_bot_name_shape_is_pinned() {
        assert_eq!(bot_name(0), "LoadBot 0");
        assert_eq!(bot_name(3), "LoadBot 3");
        assert_eq!(bot_name(499), "LoadBot 499");
    }

    /// T12: `seq` starts at 1 and is strictly increasing — the server rejects
    /// `seq <= last_input_seq`, so a 0-based or repeating seq would turn every
    /// intent into a "stale seq" rejection and fake a saturated server.
    #[test]
    fn t12_seq_starts_at_one_and_strictly_increases() {
        assert_eq!(seq_for(0), 1, "the FIRST intent must carry seq 1, not 0");
        let mut prev = 0u64;
        for step_index in 0..1000u64 {
            let seq = seq_for(step_index);
            assert!(
                seq > prev,
                "seq must strictly increase: seq_for({step_index}) = {seq} after {prev}"
            );
            prev = seq;
        }
    }

    /// T12: the walk alphabet is East/West ONLY. A North or South intent would
    /// step the bot off row 1 and onto tall grass, where a wild encounter
    /// battle-locks it forever and silently kills the offered load.
    #[test]
    fn t12_walk_alphabet_is_east_west_only() {
        for client in 0..16u32 {
            for step_index in 0..512u64 {
                let input = next_input(client, seq_for(step_index), 0x5EED_0D20);
                assert!(
                    matches!(
                        input,
                        MoveInput::Step(Direction::East) | MoveInput::Step(Direction::West)
                    ),
                    "client {client} step {step_index} emitted {input:?}; only East/West are safe on row 1"
                );
            }
        }
    }

    /// T12: the walk OSCILLATES — within any window of 32 consecutive intents a
    /// client emits both directions. Kills a one-way walker that pins itself
    /// against the wall and stops generating position updates (which would
    /// silently zero the subscription fan-out this test exists to create).
    #[test]
    fn t12_walk_oscillates_within_a_bounded_window() {
        for client in 0..8u32 {
            for window_start in 0..8u64 {
                let mut east = false;
                let mut west = false;
                for step_index in window_start * 32..window_start * 32 + 32 {
                    match next_input(client, seq_for(step_index), 0x5EED_0D20) {
                        MoveInput::Step(Direction::East) => east = true,
                        MoveInput::Step(Direction::West) => west = true,
                        _ => {}
                    }
                }
                assert!(
                    east && west,
                    "client {client} window {window_start}: the walk must reverse within 32 steps \
                     (east={east}, west={west})"
                );
            }
        }
    }

    /// T12: the walk is a pure function of (client, seq, seed) — a run replays
    /// identically, and two clients are not forced into lockstep.
    #[test]
    fn t12_walk_is_deterministic_per_client_and_seed() {
        for client in 0..8u32 {
            for step_index in 0..64u64 {
                let seq = seq_for(step_index);
                assert_eq!(
                    next_input(client, seq, 0x5EED_0D20),
                    next_input(client, seq, 0x5EED_0D20),
                    "next_input must be referentially deterministic"
                );
            }
        }
    }

    // =======================================================================
    // T13 — the grass oracle: the generated walk, the REAL zone-0 content, and
    //       the REAL game_core::apply_move. The driver models no game rule; this
    //       test is the only place the map is consulted.
    // =======================================================================

    fn zone_0_real() -> game_core::TileMap {
        let maps = load_zone_maps().expect("embedded zone_maps RON must parse");
        map_for(0, &maps).expect("zone 0 must have a ZoneMapDef in the embedded RON")
    }

    fn at_spawn() -> CharacterState {
        CharacterState {
            pos: spawn(),
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        }
    }

    /// T13: ≥200 generated intents per client, fed through the REAL rule on the
    /// REAL map, never land on tall grass and never leave row 1.
    ///
    /// Kills: any walk that emits North/South (row 2 of zone 0 is `#.~~....~#`,
    /// so a single South-then-East reaches grass — see the teeth test below),
    /// and any walk that wanders off the spawn row.
    #[test]
    fn t13_generated_walk_never_lands_on_tall_grass() {
        let map = zone_0_real();
        assert_eq!(spawn(), TilePos { x: 1, y: 1 }, "the spawn premise");
        for client in 0..8u32 {
            let mut state = at_spawn();
            let mut visited_x: std::collections::BTreeSet<i32> = std::collections::BTreeSet::new();
            for step_index in 0..256u64 {
                let input = next_input(client, seq_for(step_index), 0x5EED_0D20);
                let now = Millis(BUDGET_MS * (i64::try_from(step_index).expect("fits") + 1));
                state = apply_move(&state, input, &map, now);
                assert!(
                    !map.is_grass(state.pos),
                    "client {client} step {step_index}: landed on tall grass at {:?} — \
                     a wild encounter battle-locks the bot and silently kills the offered load",
                    state.pos
                );
                assert_eq!(
                    state.pos.y, 1,
                    "client {client} step {step_index}: left the spawn row at {:?}",
                    state.pos
                );
                assert!(
                    state.pos.x >= 1 && state.pos.x <= 8,
                    "client {client} step {step_index}: left the walkable span at {:?}",
                    state.pos
                );
                visited_x.insert(state.pos.x);
            }
            assert!(
                visited_x.len() >= 2,
                "client {client} never actually moved (visited x = {visited_x:?}) — \
                 a bot bumping a wall forever generates no position updates and no fan-out"
            );
        }
    }

    /// T13 PROOF-OF-TEETH: the oracle CAN fail. Two steps off the generated
    /// alphabet — South then East — reach a grass tile on the real map, so the
    /// assertion above is not vacuous.
    #[test]
    fn t13_oracle_has_teeth_south_then_east_reaches_grass() {
        let map = zone_0_real();
        let mut state = at_spawn();
        state = apply_move(&state, MoveInput::Step(Direction::South), &map, Millis(200));
        assert_eq!(state.pos, TilePos { x: 1, y: 2 }, "row 2 is walkable at x=1");
        assert!(!map.is_grass(state.pos), "(1,2) itself is plain floor");
        state = apply_move(&state, MoveInput::Step(Direction::East), &map, Millis(400));
        assert_eq!(state.pos, TilePos { x: 2, y: 2 });
        assert!(
            map.is_grass(state.pos),
            "(2,2) IS tall grass on the real zone-0 map — the grass oracle has teeth"
        );
    }

    /// T13: row 1 of the real map is entirely grass-free and walkable from x=1
    /// to x=8, with walls at both ends. This is the single map fact the bot
    /// model depends on; if content drifts, this fails before the walk test.
    #[test]
    fn t13_real_zone_0_row_1_is_grass_free_between_the_walls() {
        let map = zone_0_real();
        for x in 1..=8 {
            let p = TilePos { x, y: 1 };
            assert!(map.is_walkable(p), "({x},1) must be walkable");
            assert!(!map.is_grass(p), "({x},1) must not be tall grass");
        }
        assert!(!map.is_walkable(TilePos { x: 0, y: 1 }), "(0,1) is the west wall");
        assert!(!map.is_walkable(TilePos { x: 9, y: 1 }), "(9,1) is the east wall");
    }

    // =======================================================================
    // T14 — base64 + the hand-rolled RFC 6455 codec and the AM2 drain machine.
    // =======================================================================

    /// A fixed, obviously-non-zero mask for the encoder vectors.
    const M: [u8; 4] = [0x01, 0x02, 0x03, 0x04];

    /// Unmask the payload region of an encoded client frame.
    fn unmask_payload(frame: &[u8], header_len: usize, mask: [u8; 4]) -> Vec<u8> {
        let mut payload = frame[header_len..].to_vec();
        apply_mask(&mut payload, mask);
        payload
    }

    /// An UNMASKED server→client frame (servers must not mask, RFC 6455 §5.1).
    fn server_frame(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![if fin { 0x80 | opcode } else { opcode }];
        let n = payload.len();
        if n < 126 {
            f.push(u8::try_from(n).expect("under 126"));
        } else if n <= 65535 {
            f.push(126);
            f.extend_from_slice(&u16::try_from(n).expect("fits u16").to_be_bytes());
        } else {
            f.push(127);
            f.extend_from_slice(&u64::try_from(n).expect("fits u64").to_be_bytes());
        }
        f.extend_from_slice(payload);
        f
    }

    /// T14: RFC 4648 base64 vectors.
    #[test]
    fn t14_b64_encode_known_vectors() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_encode(&[0x00, 0x00, 0x00]), "AAAA");
        assert_eq!(b64_encode(&[0xFF, 0xFF, 0xFF]), "////");
    }

    /// T14: the `Sec-WebSocket-Key` is 16 seeded bytes ⇒ 24 base64 chars ending
    /// `==`, deterministic per seed, and not a constant across seeds.
    #[test]
    fn t14_ws_key_shape_and_seeding() {
        let key = ws_key_from_seed(0x5EED_0D20);
        assert_eq!(key.len(), 24, "16 bytes base64-encode to 24 chars");
        assert!(key.ends_with("=="), "16 bytes leave two pad chars");
        assert!(
            key.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='),
            "the key must be plain base64, got {key}"
        );
        assert_eq!(key, ws_key_from_seed(0x5EED_0D20), "seeded, so replayable");
        let distinct: std::collections::BTreeSet<String> =
            (0..64u64).map(ws_key_from_seed).collect();
        assert!(distinct.len() > 1, "the key must actually depend on the seed");
    }

    /// T14: masks are seeded and vary per frame — a constant mask (or an
    /// all-zero one) would leave the payload in plaintext on the wire.
    #[test]
    fn t14_masks_are_seeded_and_vary_per_frame() {
        assert_eq!(mask_from_seed(7, 3), mask_from_seed(7, 3), "deterministic");
        let masks: std::collections::BTreeSet<[u8; 4]> =
            (0..64u64).map(|i| mask_from_seed(0x5EED_0D20, i)).collect();
        assert!(masks.len() > 1, "the mask must vary across frames");
        assert!(
            masks.iter().any(|m| m != &[0, 0, 0, 0]),
            "an all-zero mask is not masking"
        );
    }

    /// T14: masking is an involution — the same XOR restores the bytes. This is
    /// exactly how the reader would unmask, and it pins the 4-byte cycle.
    #[test]
    fn t14_masking_twice_is_the_identity() {
        let original: Vec<u8> = (0..37u8).collect();
        let mut buf = original.clone();
        apply_mask(&mut buf, M);
        assert_ne!(buf, original, "masking must actually change the bytes");
        apply_mask(&mut buf, M);
        assert_eq!(buf, original, "unmasking must restore the payload exactly");
    }

    /// T14: the 7-bit length form with an EMPTY payload — the smallest legal
    /// client frame is exactly 6 bytes.
    #[test]
    fn t14_text_frame_zero_length_uses_the_7bit_form() {
        let f = encode_text_frame("", M);
        assert_eq!(f, vec![0x81, 0x80, 0x01, 0x02, 0x03, 0x04]);
    }

    /// T14: 125 bytes is the LAST 7-bit length. Kills an off-by-one that
    /// switches to the 16-bit form one byte early.
    #[test]
    fn t14_text_frame_125_bytes_is_the_last_7bit_length() {
        let payload = "a".repeat(125);
        let f = encode_text_frame(&payload, M);
        assert_eq!(f[0], 0x81, "FIN + text opcode");
        assert_eq!(f[1], 0x80 | 125, "mask bit + the literal length 125");
        assert_eq!(f.len(), 2 + 4 + 125);
        assert_eq!(unmask_payload(&f, 6, M), payload.as_bytes());
    }

    /// T14: 126 bytes is the FIRST 16-bit length (`0x7E` + two big-endian bytes).
    #[test]
    fn t14_text_frame_126_bytes_switches_to_the_16bit_form() {
        let payload = "a".repeat(126);
        let f = encode_text_frame(&payload, M);
        assert_eq!(&f[0..4], &[0x81, 0x80 | 126, 0x00, 0x7E]);
        assert_eq!(f.len(), 2 + 2 + 4 + 126);
        assert_eq!(unmask_payload(&f, 8, M), payload.as_bytes());
    }

    /// T14: 65535 bytes is the LAST 16-bit length.
    #[test]
    fn t14_text_frame_65535_bytes_is_the_last_16bit_length() {
        let payload = "a".repeat(65535);
        let f = encode_text_frame(&payload, M);
        assert_eq!(&f[0..4], &[0x81, 0x80 | 126, 0xFF, 0xFF]);
        assert_eq!(f.len(), 2 + 2 + 4 + 65535);
    }

    /// T14: 65536 bytes is the FIRST 64-bit length (`0x7F` + eight big-endian
    /// bytes). Kills a 16-bit truncation that would silently corrupt the stream.
    #[test]
    fn t14_text_frame_65536_bytes_switches_to_the_64bit_form() {
        let payload = "a".repeat(65536);
        let f = encode_text_frame(&payload, M);
        assert_eq!(
            &f[0..10],
            &[0x81, 0x80 | 127, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]
        );
        assert_eq!(f.len(), 2 + 8 + 4 + 65536);
        assert_eq!(unmask_payload(&f, 14, M), payload.as_bytes());
    }

    /// T14: every client→server frame is MASKED and the payload is not sent in
    /// the clear. A server closes the connection on an unmasked client frame.
    #[test]
    fn t14_client_frames_are_masked_not_plaintext() {
        let payload = "{\"Jump\":[]}";
        let f = encode_text_frame(payload, M);
        assert_eq!(f[1] & 0x80, 0x80, "the mask bit must be set");
        assert_eq!(&f[2..6], &M, "the mask key follows the length");
        assert_ne!(
            &f[6..],
            payload.as_bytes(),
            "the payload must be masked on the wire, not sent verbatim"
        );
        assert_eq!(unmask_payload(&f, 6, M), payload.as_bytes());
    }

    /// T14: pong echoes the ping payload; close is a bare masked control frame.
    #[test]
    fn t14_pong_and_close_frames() {
        let pong = encode_pong(&[0xDE, 0xAD], M);
        assert_eq!(pong[0], 0x8A, "FIN + pong opcode");
        assert_eq!(pong[1], 0x80 | 2);
        assert_eq!(unmask_payload(&pong, 6, M), vec![0xDE, 0xAD]);
        let close = encode_close(M);
        assert_eq!(close, vec![0x88, 0x80, 0x01, 0x02, 0x03, 0x04]);
    }

    /// T14: a complete 7-bit header parses, reporting its own length so the
    /// caller knows where the payload starts.
    #[test]
    fn t14_parse_header_7bit() {
        let h = parse_frame_header(&[0x81, 0x05])
            .expect("well formed")
            .expect("complete");
        assert_eq!(
            h,
            FrameHeader {
                fin: true,
                opcode: 1,
                masked: false,
                payload_len: 5,
                header_len: 2,
            }
        );
    }

    /// T14: the 16-bit and 64-bit forms, and a non-FIN continuation.
    #[test]
    fn t14_parse_header_extended_lengths() {
        let h = parse_frame_header(&[0x81, 0x7E, 0x01, 0x00])
            .expect("well formed")
            .expect("complete");
        assert_eq!(h.payload_len, 256);
        assert_eq!(h.header_len, 4);
        let h = parse_frame_header(&[0x82, 0x7F, 0, 0, 0, 0, 0, 1, 0, 0])
            .expect("well formed")
            .expect("complete");
        assert_eq!(h.payload_len, 65536, "the 64-bit length is big-endian");
        assert_eq!(h.header_len, 10);
        assert_eq!(h.opcode, 2);
        let h = parse_frame_header(&[0x01, 0x00])
            .expect("well formed")
            .expect("complete");
        assert!(!h.fin, "a fragment carries FIN = 0");
        assert_eq!(h.opcode, 1);
    }

    /// T14: truncated input is "need more bytes", NEVER an error and never a
    /// guess — a mis-parse here desynchronises the whole stream.
    #[test]
    fn t14_parse_header_needs_more_bytes() {
        assert_eq!(parse_frame_header(&[]), Ok(None));
        assert_eq!(parse_frame_header(&[0x81]), Ok(None));
        assert_eq!(
            parse_frame_header(&[0x81, 0x7E, 0x01]),
            Ok(None),
            "one byte of the 16-bit length is missing"
        );
        assert_eq!(
            parse_frame_header(&[0x82, 0x7F, 0, 0, 0, 0, 0, 1, 0]),
            Ok(None),
            "one byte of the 64-bit length is missing"
        );
        assert_eq!(
            parse_frame_header(&[0x81, 0x85, 0x01, 0x02]),
            Ok(None),
            "a masked header needs all four mask bytes"
        );
    }

    /// T14: a masked header reports the mask bytes in its length.
    #[test]
    fn t14_parse_header_masked_includes_the_mask_bytes() {
        let h = parse_frame_header(&[0x81, 0x85, 0x01, 0x02, 0x03, 0x04])
            .expect("well formed")
            .expect("complete");
        assert!(h.masked);
        assert_eq!(h.payload_len, 5);
        assert_eq!(h.header_len, 6, "2 header + 4 mask bytes");
    }

    /// T14: a 64-bit length with the high bit set is illegal (RFC 6455 §5.2).
    /// Fail loud rather than allocate a nonsense skip counter.
    #[test]
    fn t14_parse_header_rejects_illegal_64bit_length() {
        assert!(parse_frame_header(&[0x82, 0x7F, 0x80, 0, 0, 0, 0, 0, 0, 0]).is_err());
    }

    /// T14 + AM2: a header SPLIT across two reads resumes on the next feed —
    /// the buffer survives, nothing is dropped.
    #[test]
    fn t14_drain_resumes_a_header_split_across_feeds() {
        let frame = server_frame(1, true, &[b'x'; 256]);
        let mut st = DrainState::default();
        let first = drain_feed(&mut st, &frame[0..2]).expect("valid stream");
        assert_eq!(
            first.data_frames_skipped, 0,
            "only two bytes of a 4-byte header arrived"
        );
        let second = drain_feed(&mut st, &frame[2..]).expect("valid stream");
        assert_eq!(second.data_frames_skipped, 1, "the frame completes here");
        assert_eq!(st.skip_remaining, 0);
        assert!(st.buf.is_empty(), "a fully consumed frame leaves no residue");
    }

    /// T14 + AM2: the skip counter RESUMES across feeds — this is the whole
    /// point of the streaming reader (no reassembly, no unbounded buffer).
    #[test]
    fn t14_drain_skip_counter_resumes_across_three_feeds() {
        let frame = server_frame(1, true, &[b'y'; 300]);
        let mut st = DrainState::default();
        let a = drain_feed(&mut st, &frame[0..100]).expect("valid stream");
        assert_eq!(a.data_frames_skipped, 0);
        assert_eq!(st.skip_remaining, 204, "300 payload − 96 payload bytes seen");
        let b = drain_feed(&mut st, &frame[100..200]).expect("valid stream");
        assert_eq!(b.data_frames_skipped, 0);
        assert_eq!(st.skip_remaining, 104);
        let c = drain_feed(&mut st, &frame[200..]).expect("valid stream");
        assert_eq!(c.data_frames_skipped, 1);
        assert_eq!(st.skip_remaining, 0);
        assert!(
            st.buf.is_empty(),
            "the payload must be DISCARDED, never accumulated"
        );
    }

    /// T14 + AM2: a control frame interleaved BETWEEN data fragments is
    /// surfaced for a pong while the data stream keeps being skipped. Kills a
    /// reader that treats every frame as data and silently stops answering
    /// pings (the server then closes the connection mid-level).
    #[test]
    fn t14_drain_surfaces_a_ping_interleaved_between_data_fragments() {
        let mut stream = server_frame(1, false, b"first fragment");
        stream.extend_from_slice(&server_frame(9, true, b"PINGDATA"));
        stream.extend_from_slice(&server_frame(0, true, b"continuation"));
        let mut st = DrainState::default();
        let out = drain_feed(&mut st, &stream).expect("valid stream");
        assert_eq!(
            out.control,
            vec![ControlFrame::Ping(b"PINGDATA".to_vec())],
            "the ping must be surfaced with its payload so the pong can echo it"
        );
        assert_eq!(
            out.data_frames_skipped, 2,
            "both the fragment and the continuation are skipped"
        );
        assert!(!out.closed);
        assert!(st.buf.is_empty());
    }

    /// T14 + AM2: a control frame split across feeds is NOT surfaced until it is
    /// complete — answering a truncated ping would send garbage.
    #[test]
    fn t14_drain_waits_for_a_complete_control_frame() {
        let ping = server_frame(9, true, b"ABCD");
        let mut st = DrainState::default();
        let a = drain_feed(&mut st, &ping[0..4]).expect("valid stream");
        assert!(
            a.control.is_empty(),
            "two of four payload bytes: nothing may be surfaced yet"
        );
        let b = drain_feed(&mut st, &ping[4..]).expect("valid stream");
        assert_eq!(b.control, vec![ControlFrame::Ping(b"ABCD".to_vec())]);
    }

    /// T14 + AM2: a close frame is surfaced and flagged.
    #[test]
    fn t14_drain_surfaces_close() {
        let mut st = DrainState::default();
        let out = drain_feed(&mut st, &server_frame(8, true, b"")).expect("valid stream");
        assert_eq!(out.control, vec![ControlFrame::Close]);
        assert!(out.closed, "the caller must stop using this socket");
    }

    /// T14 + AM2: a zero-length data frame counts immediately (no payload to
    /// wait for) — kills a machine that stalls on `skip_remaining == 0`.
    #[test]
    fn t14_drain_counts_a_zero_length_data_frame() {
        let mut st = DrainState::default();
        let out = drain_feed(&mut st, &server_frame(1, true, b"")).expect("valid stream");
        assert_eq!(out.data_frames_skipped, 1);
        assert_eq!(st.skip_remaining, 0);
    }

    /// T14 + AM2: many frames in ONE feed are all drained (the per-iteration
    /// drain runs until the socket would block).
    #[test]
    fn t14_drain_handles_many_frames_in_one_feed() {
        let mut stream = Vec::new();
        for i in 0..50u8 {
            stream.extend_from_slice(&server_frame(1, true, &[i; 10]));
        }
        let mut st = DrainState::default();
        let out = drain_feed(&mut st, &stream).expect("valid stream");
        assert_eq!(out.data_frames_skipped, 50);
        assert!(st.buf.is_empty());
    }

    /// T14 + AM2: protocol violations fail loud rather than desynchronise.
    #[test]
    fn t14_drain_fails_loud_on_protocol_violations() {
        let mut st = DrainState::default();
        assert!(
            drain_feed(&mut st, &[0x8B, 0x00]).is_err(),
            "opcode 0xB is undefined"
        );
        let mut st = DrainState::default();
        let mut oversized = vec![0x89, 200];
        oversized.extend_from_slice(&[0u8; 200]);
        assert!(
            drain_feed(&mut st, &oversized).is_err(),
            "a control frame may not exceed 125 bytes (RFC 6455 §5.5)"
        );
    }

    // =======================================================================
    // T15 — the WS handshake request and its status check.
    // =======================================================================

    fn handshake_fixture() -> String {
        handshake_request(
            "127.0.0.1:3000",
            "monster-realm",
            TOKEN_FIXTURE,
            "dGhlIHNhbXBsZSBub25jZQ==",
        )
    }

    /// T15: the request line names the live subscribe path.
    #[test]
    fn t15_handshake_request_line() {
        let req = handshake_fixture();
        assert!(
            req.starts_with("GET /v1/database/monster-realm/subscribe HTTP/1.1\r\n"),
            "got: {req}"
        );
        assert_eq!(ws_path("mr-scratch"), "/v1/database/mr-scratch/subscribe");
    }

    /// T15: every header RFC 6455 and this host require.
    #[test]
    fn t15_handshake_carries_every_required_header() {
        let req = handshake_fixture();
        assert!(req.contains("\r\nHost: 127.0.0.1:3000\r\n"));
        assert!(req.contains("\r\nUpgrade: websocket\r\n"));
        assert!(req.contains("\r\nConnection: Upgrade\r\n"));
        assert!(req.contains("\r\nSec-WebSocket-Version: 13\r\n"));
        assert!(req.contains("\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"));
        assert!(
            req.contains(&format!("\r\nSec-WebSocket-Protocol: {WS_SUBPROTOCOL}\r\n")),
            "the v1.json subprotocol is what makes the server speak JSON"
        );
        assert!(req.ends_with("\r\n\r\n"), "the head must be terminated");
    }

    /// T15 SECRET HYGIENE: the token appears exactly once, on the Authorization
    /// line, and NOWHERE else — not in the path, not as a `?token=` query param
    /// (which the host also accepts but which leaks into access logs).
    #[test]
    fn t15_token_appears_only_on_the_authorization_line() {
        let req = handshake_fixture();
        assert_eq!(
            req.matches("Bearer ").count(),
            1,
            "exactly one Authorization header"
        );
        assert!(req.contains(&format!("\r\nAuthorization: Bearer {TOKEN_FIXTURE}\r\n")));
        assert_eq!(
            req.matches(TOKEN_FIXTURE).count(),
            1,
            "the token must not be repeated anywhere in the request"
        );
        for line in req.split("\r\n") {
            if line.contains(TOKEN_FIXTURE) {
                assert!(
                    line.starts_with("Authorization:"),
                    "the token leaked onto a non-Authorization line: {line}"
                );
            }
        }
        let request_line = req.split("\r\n").next().expect("a request line");
        assert!(!request_line.contains('?'), "no query string on the path");
        assert!(!request_line.contains("token"), "no ?token= auth");
    }

    /// T15: only a real `101` counts. `HTTP/1.1 1011` must NOT — that kills a
    /// `starts_with("HTTP/1.1 101")` check, which would accept a bogus status
    /// and then read garbage as frames.
    #[test]
    fn t15_handshake_is_101_only_for_a_real_101() {
        assert!(handshake_is_101(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
        ));
        assert!(!handshake_is_101("HTTP/1.1 401 Unauthorized\r\n\r\n"));
        assert!(!handshake_is_101("HTTP/1.1 404 Not Found\r\n\r\n"));
        assert!(!handshake_is_101("HTTP/1.1 200 OK\r\n\r\n"));
        assert!(
            !handshake_is_101("HTTP/1.1 1011 Nope\r\n\r\n"),
            "1011 is not 101"
        );
        assert!(!handshake_is_101("garbage"));
        assert!(!handshake_is_101(""));
    }

    /// T15: HTTP request builders — `Content-Length` is the BYTE length (kills
    /// a `chars().count()`), and no token means no Authorization header at all.
    #[test]
    fn t15_http_request_builders() {
        let body = "[\"Poké\"]";
        assert_eq!(body.chars().count(), 8, "8 chars");
        assert_eq!(body.len(), 9, "but 9 BYTES (é is two bytes)");
        let post = http_post_request("h:1", "/v1/identity", body, None);
        assert!(post.starts_with("POST /v1/identity HTTP/1.1\r\n"));
        assert!(post.contains("\r\nHost: h:1\r\n"));
        assert!(post.contains("\r\nContent-Type: application/json\r\n"));
        assert!(
            post.contains("\r\nContent-Length: 9\r\n"),
            "Content-Length must count BYTES, got: {post}"
        );
        assert!(post.ends_with(body), "the body follows the blank line");
        assert!(
            !post.contains("Authorization"),
            "no token was supplied, so no Authorization header may appear"
        );
        assert!(!post.contains("Bearer"));
        let get = http_get_request("h:1", "/metrics", Some(TOKEN_FIXTURE));
        assert!(get.starts_with("GET /metrics HTTP/1.1\r\n"));
        assert!(get.contains(&format!("\r\nAuthorization: Bearer {TOKEN_FIXTURE}\r\n")));
        assert!(get.ends_with("\r\n\r\n"));
    }

    /// T15: status extraction, including the live 530 reducer-error code.
    #[test]
    fn t15_http_status_extraction() {
        assert_eq!(http_status("HTTP/1.1 200 OK\r\n\r\n"), Ok(200));
        assert_eq!(
            http_status("HTTP/1.1 530 \r\nContent-Type: text/plain\r\n\r\nnot joined"),
            Ok(530),
            "a reducer Err comes back as 530 with a plain-text body"
        );
        assert_eq!(http_status("HTTP/1.1 404 Not Found\r\n\r\n"), Ok(404));
        assert!(http_status("garbage").is_err());
        assert!(http_status("").is_err());
        assert!(
            http_status("HTTP/1.1 20X OK\r\n\r\n").is_err(),
            "a non-numeric status must fail loud, never default to 200"
        );
    }

    // =======================================================================
    // T16 — JSON string-field extraction (identity + token + db identity).
    //
    // NOTE ON FIXTURES: the live POST /v1/identity token IS a real JWT.
    // Every fixture here uses a TOKEN-PLACEHOLDER shape instead, because
    // gitleaks scans the pushed diff remotely and a JWT-shaped fixture would
    // block the PR where a local `just ci` cannot see it.
    // =======================================================================

    /// T16: the live `POST /v1/identity` response shape.
    #[test]
    fn t16_extract_identity_and_token_happy_path() {
        let body = r#"{"identity":"c200deadbeef","token":"TOKEN-PLACEHOLDER-abc123"}"#;
        assert_eq!(
            extract_json_string_field(body, "identity"),
            Ok("c200deadbeef".to_string())
        );
        assert_eq!(
            extract_json_string_field(body, "token"),
            Ok("TOKEN-PLACEHOLDER-abc123".to_string())
        );
    }

    /// T16: the NESTED `__identity__` form from `GET /v1/database/<name>` —
    /// extraction must reach into a nested object, not only the top level.
    #[test]
    fn t16_extract_nested_identity_field() {
        let body = r#"{"database_identity":{"__identity__":"0xc200abcdef"},"host_type":"wasm"}"#;
        assert_eq!(
            extract_json_string_field(body, "__identity__"),
            Ok("0xc200abcdef".to_string())
        );
        assert_eq!(
            database_identity_from_json(body),
            Ok("c200abcdef".to_string()),
            "the label form carries the hex WITHOUT the 0x prefix"
        );
    }

    /// T16 DECOY: the word `token` appears inside ANOTHER field's value. A
    /// naive substring search finds the decoy first and returns the wrong value
    /// (or garbage).
    #[test]
    fn t16_decoy_word_in_a_neighbouring_value() {
        let body = r#"{"note":"the token is here","token":"TOKEN-PLACEHOLDER-real"}"#;
        assert_eq!(
            extract_json_string_field(body, "token"),
            Ok("TOKEN-PLACEHOLDER-real".to_string())
        );
    }

    /// T16 DECOY, sharper: a KEY-SHAPED substring (quoted, colon-suffixed) sits
    /// inside another field's value. Only a string-aware scanner survives this;
    /// a `find("\"token\":")` implementation extracts ` inside` or errors.
    #[test]
    fn t16_decoy_key_shaped_substring_inside_a_value() {
        let body = r#"{"note":"contains \"token\": inside","token":"TOKEN-PLACEHOLDER-real"}"#;
        assert_eq!(
            extract_json_string_field(body, "token"),
            Ok("TOKEN-PLACEHOLDER-real".to_string()),
            "a key-shaped substring inside a VALUE is not a key"
        );
    }

    /// T16: the returned value is UNESCAPED.
    #[test]
    fn t16_value_escapes_are_decoded() {
        assert_eq!(
            extract_json_string_field(r#"{"token":"TOKEN-PLACEHOLDER-a\"b"}"#, "token"),
            Ok("TOKEN-PLACEHOLDER-a\"b".to_string()),
            "an escaped quote is part of the value, not its terminator"
        );
        assert_eq!(
            extract_json_string_field(r#"{"k":"line1\nline2"}"#, "k"),
            Ok("line1\nline2".to_string())
        );
        assert_eq!(
            extract_json_string_field(r#"{"k":"a\\b"}"#, "k"),
            Ok("a\\b".to_string())
        );
    }

    /// T16: failures are LOUD — a missing key, a non-string value, and a
    /// truncated document must never yield an empty string.
    #[test]
    fn t16_extraction_failures_are_loud() {
        assert!(extract_json_string_field(r#"{"identity":"x"}"#, "token").is_err());
        assert!(
            extract_json_string_field(r#"{"token":123}"#, "token").is_err(),
            "a numeric value is not a string field"
        );
        assert!(
            extract_json_string_field(r#"{"token":"abc"#, "token").is_err(),
            "an unterminated value must fail, not return the partial text"
        );
        assert!(extract_json_string_field("", "token").is_err());
        assert!(extract_json_string_field("not json at all", "token").is_err());
    }

    // =======================================================================
    // T17 — the client-message envelopes, byte-for-byte as live-verified.
    // =======================================================================

    /// T17: the `Subscribe` envelope, exactly as accepted by the live host.
    #[test]
    fn t17_subscribe_envelope_is_byte_exact() {
        assert_eq!(
            client_msg_subscribe(1),
            r#"{"Subscribe":{"query_strings":["SELECT * FROM character"],"request_id":1}}"#
        );
    }

    /// T17: the `join_game` call, including the crucial detail that `args` is a
    /// JSON **string** containing the args array — not a raw array — and that
    /// `flags` is the number 0.
    #[test]
    fn t17_join_game_call_reducer_envelope_is_byte_exact() {
        assert_eq!(args_join_game("LoadBot 3"), r#"["LoadBot 3"]"#);
        assert_eq!(
            client_msg_call_reducer("join_game", &args_join_game("LoadBot 3"), 2),
            r#"{"CallReducer":{"reducer":"join_game","args":"[\"LoadBot 3\"]","request_id":2,"flags":0}}"#
        );
    }

    /// T17: the `enqueue_move` call with a `MoveInput` and a seq.
    #[test]
    fn t17_enqueue_move_call_reducer_envelope_is_byte_exact() {
        let args = args_enqueue_move(MoveInput::Step(Direction::East), 7);
        assert_eq!(args, r#"[{"Step":{"East":[]}},7]"#);
        assert_eq!(
            client_msg_call_reducer("enqueue_move", &args, 3),
            r#"{"CallReducer":{"reducer":"enqueue_move","args":"[{\"Step\":{\"East\":[]}},7]","request_id":3,"flags":0}}"#
        );
    }

    /// T17: the SATS-JSON encoding of every `MoveInput` — externally tagged,
    /// with `[]` for the unit payload. Decode-verified against the live module
    /// (the bot moved (1,1)→(2,1) under `movement_tick`).
    #[test]
    fn t17_move_input_sats_encoding() {
        assert_eq!(
            sats_move_input(MoveInput::Step(Direction::East)),
            r#"{"Step":{"East":[]}}"#
        );
        assert_eq!(
            sats_move_input(MoveInput::Step(Direction::West)),
            r#"{"Step":{"West":[]}}"#
        );
        assert_eq!(
            sats_move_input(MoveInput::Step(Direction::North)),
            r#"{"Step":{"North":[]}}"#
        );
        assert_eq!(
            sats_move_input(MoveInput::Step(Direction::South)),
            r#"{"Step":{"South":[]}}"#
        );
        assert_eq!(sats_move_input(MoveInput::Jump), r#"{"Jump":[]}"#);
    }

    /// T17: the direction names are exact and distinct — a swapped pair would
    /// send bots north into grass while every local test still passed.
    #[test]
    fn t17_direction_names_are_exact() {
        assert_eq!(sats_direction(Direction::North), "North");
        assert_eq!(sats_direction(Direction::South), "South");
        assert_eq!(sats_direction(Direction::East), "East");
        assert_eq!(sats_direction(Direction::West), "West");
    }

    /// T17: a name needing escapes still produces a valid nested-string
    /// envelope (the driver's own names never do, but the builder must not be
    /// the place that breaks).
    #[test]
    fn t17_call_reducer_escapes_the_nested_args_string() {
        let envelope = client_msg_call_reducer("join_game", r#"["a\"b"]"#, 9);
        assert!(
            envelope.contains(r#""args":"[\"a\\\"b\"]""#),
            "the args string must be escaped ONCE for its JSON-string slot, got: {envelope}"
        );
    }

    /// T17: the envelope a real client sends for its first two messages, in
    /// order, using the driver's own bot name — proving the pieces compose.
    #[test]
    fn t17_per_connection_message_sequence() {
        let subscribe = client_msg_subscribe(1);
        let join = client_msg_call_reducer(REDUCER_JOIN_GAME, &args_join_game(&bot_name(3)), 2);
        assert!(subscribe.starts_with(r#"{"Subscribe":"#));
        assert_eq!(
            join,
            r#"{"CallReducer":{"reducer":"join_game","args":"[\"LoadBot 3\"]","request_id":2,"flags":0}}"#
        );
    }

    // =======================================================================
    // T18 — determinism: identical inputs render byte-identical reports.
    // =======================================================================

    /// T18: rendering the SAME run twice is byte-identical. Any set/map
    /// iteration order leaking into the output would break this.
    #[test]
    fn t18_rendering_the_same_run_twice_is_byte_identical() {
        let run = run_fixture(
            "T-18",
            vec![base_sample(5), base_sample(10), base_sample(15)],
        );
        assert_eq!(render_report(&run), render_report(&run));
    }

    /// T18: two INDEPENDENTLY built but equal runs render identically — this is
    /// what makes a G11 pairing-on / pairing-off A/B comparable at all.
    #[test]
    fn t18_independently_built_equal_runs_render_identically() {
        let a = run_fixture("T-18", vec![base_sample(5), base_sample(10)]);
        let b = run_fixture("T-18", vec![base_sample(5), base_sample(10)]);
        assert_eq!(a, b, "the fixtures must be structurally equal");
        assert_eq!(render_report(&a), render_report(&b));
    }

    /// T18: the verdict machine is referentially transparent too.
    #[test]
    fn t18_level_evaluation_is_deterministic() {
        let s = base_sample(25);
        assert_eq!(
            evaluate_level(&s).expect("consistent bounds"),
            evaluate_level(&s).expect("consistent bounds")
        );
    }

    /// T18: a report with a breaking point is stable as well (the state machine
    /// runs inside the renderer).
    #[test]
    fn t18_breaching_report_is_stable() {
        let breaching = LevelSample {
            queue_readings: vec![
                (QUEUE_FAMILIES[0].to_string(), vec![9.0, 1.0, 5.0, 20.0]),
                (QUEUE_FAMILIES[1].to_string(), vec![0.0, 0.0, 0.0, 0.0]),
            ],
            ..base_sample(10)
        };
        let run = run_fixture("T-18", vec![base_sample(5), breaching]);
        let first = render_report(&run);
        assert!(
            first.contains(&format!(
                "\"breaking_point\":{{\"concurrency\":10,\"reason\":\"{QUEUE_BREACH_PREFIX}{}\"}}",
                QUEUE_FAMILIES[0]
            )),
            "expected the level-10 queue crossing, got: {first}"
        );
        assert_eq!(first, render_report(&run));
    }

    // =======================================================================
    // AM4 — the co-location caveat (pure; parallelism is injected, never read).
    // =======================================================================

    /// AM4: more driver threads than host parallelism ⇒ the fixed caveat note.
    #[test]
    fn am04_co_location_note_fires_only_when_the_driver_outnumbers_the_host() {
        assert_eq!(
            co_location_note(9, 8),
            Some(CO_LOCATION_NOTE.to_string()),
            "a loopback run that oversubscribes the host must say so"
        );
        assert_eq!(
            co_location_note(8, 8),
            None,
            "exactly at parallelism is not oversubscribed"
        );
        assert_eq!(co_location_note(2, 8), None);
    }

    /// AM4: the thread count is clients + the single scraper thread.
    #[test]
    fn am04_thread_count_includes_the_scraper() {
        assert_eq!(total_driver_threads(0), 1);
        assert_eq!(total_driver_threads(50), 51);
        assert_eq!(total_driver_threads(MAX_CLIENTS), 501);
    }

    /// The remaining frozen constants, pinned so a rename or a re-tune is a
    /// deliberate, reviewed change rather than a silent drift.
    #[test]
    fn constants_are_frozen() {
        assert_eq!(TOOL_NAME, "mr_load_driver");
        assert_eq!(SCHEMA_VERSION, 1);
        assert_eq!(TRANSPORT, "ws", "AM25: there is no other transport");
        assert_eq!(MAX_MOVE_RATE, 100);
        assert_eq!(READ_TIMEOUT_MS, 5);
        assert_eq!(
            DRAIN_FRAME_CAP, 4096,
            "AM2: a generous ceiling against a pathological server, not a pacing knob"
        );
        assert_eq!(WS_SUBPROTOCOL, "v1.json.spacetimedb");
        assert_eq!(TXN_ELAPSED_BUCKET_FAMILY, "spacetime_txn_elapsed_time_sec_bucket");
        assert_eq!(TXN_COUNT_FAMILY, "spacetime_num_txns_total");
        assert_eq!(REDUCER_MOVEMENT_TICK, "movement_tick");
        assert_eq!(REDUCER_ENQUEUE_MOVE, "enqueue_move");
        assert_eq!(REDUCER_JOIN_GAME, "join_game");
        assert_eq!(P95_BREACH_REASON, "movement_tick_p95_over_step_ms");
        assert_eq!(QUEUE_BREACH_PREFIX, "queue_growth:");
        assert_eq!(REJECTION_STORM_NOTE, "rejection_storm");
    }
}
