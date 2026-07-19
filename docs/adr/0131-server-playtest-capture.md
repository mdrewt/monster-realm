# ADR-0131 — Server-side playtest capture: additive `playtest_event` table + interval-singleton reaper + H1 report

**Status:** Accepted
**Date:** 2026-07-19
**Slice:** pt-b2
**Supersedes:** —
**Amends:** —
**Subsystems:** schema-persistence, security-authz, tooling-docs

**Decision:** An additive PRIVATE append-only `playtest_event` table, fed by the existing `attempt_recruit` reducer at the H1 decision point and bounded by an interval-singleton TTL+cap reaper, gives the fun-gate its server-authoritative H1 (weaken-first) + H2 (re-catch) proxy stream, aggregated by `just playtest-report`.

---

## Context

The playtest-first replan (2026-07) needs the fun gate's H1/H2/H3 hypotheses (`game-design.md` §4) to
have **measurement**. `pt-b1` (ADR-0130) shipped the *client* half — a local error overlay, event ring,
and F9 bug bundle — and pre-committed the full 14-variant proxy taxonomy. This slice (`pt-b2`) ships the
**server** half: an additive capture table fed by existing reducers at the H1/H2/H3 decision points, a
reaper for bounded growth, and `just playtest-report` that aggregates the table into the §4 proxy report.

`pt-b2` is **SERIAL/structural** (it adds schema) — never fanned out.

### Right-size: H1 recruit spine now; H3 parked to pt-b2b

The structural risk lives entirely in the spine: a new private additive table, a **novel interval-singleton
reaper topology** (every existing reaper — `trade_offer_reaper` ADR-0117, `battle_challenge_reaper`
ADR-0126 — is a per-row one-shot `ScheduleAt::Time`; this is the first `ScheduleAt::Interval` reaper), the
arm-site in `init`/`sync_content`, and a live-DB report with a pure-aggregation seam. `pt-b2` wires **one**
emit site — `attempt_recruit` (the H1 decision point) — which alone yields **both** the H1 weaken-first
rate (`hp_permille` at attempt time) **and** the H2 re-catch rate (same owner + same `species_id`
appearing ≥2×), proving the whole capture→cap→TTL-reap→dump→aggregate pipeline for two of three
hypotheses from a single decision point. **Parked to pt-b2b** (pure-additive: reuses the unchanged
table/helper/reaper): the H3 emit sites (`join_game`→session, `confirm_trade`→trade, `apply_pvp_rating`→
ranked) + `battle_end` outcome + their report sections, added as additive columns (ADR-0006) + call
sites — mirroring how ADR-0130 §2 parked its own 8 emit sites into pt-b1b. Smaller focused PRs review
better.

## Decision

### 1. `playtest_event` — additive PRIVATE table (`server-module/src/playtest.rs`)

Columns: `event_id: u64` (PK, `auto_inc` — monotonic; oldest = min id), `identity: Identity`, `kind: u16`,
`created_at_ms: i64`, `battle_id: u64`, `species_id: u32`, `hp_permille: u16`, `bait_item_id: u32`
(`0` = no bait), `success: bool`.

- **PRIVATE (no `public`, no view, no `client_visibility_filter`)** — this is per-identity *behaviour*
  data (who recruited what, when, at what HP%); it is must-never-leak server-only truth (ADR-0015,
  mirrors `encounter` / `battle_action` / `player_wallet`). Private tables generate **no** client
  binding, so the existing `bindings-drift` eval already bites if it is ever made public; the new
  `playtest-event-privacy` eval is the direct proof-of-teeth.
- **`identity` is stored, deliberately** — H2 re-catch requires grouping recruit records by owner. For
  the closed-test privacy posture this is acceptable because the table never leaves the server (private),
  and the **report output never emits raw identity** (see §5) — `aggregateReport` returns only counts and
  rates, never an identity/hex string. Storing a session token instead would break cross-session H2
  grouping. (Accepted risk, documented; RT-PTB2-03.)
- **No `CONTENT_VERSION` bump** — a runtime table, not seeded content (precedent: `profile` /
  `trade_offer`, ADR-0106 D7).
- **Additive-schema re-baseline** — the `battle-schema-snapshot` eval exact-matches every parsed table
  against `evals/baselines/table-schemas.json`; adding a table requires appending it to that baseline
  (the standard ADR-0006 additive-schema step every table-adding slice performs; the append-only check
  allows new keys).

### 2. `kind` as a `u16` code, not a `SpacetimeType` enum column

`kind` is a plain `u16` written **only** via an internal exhaustive Rust enum `PlaytestKind` (in
`playtest.rs`, **not** game-core — this is observability, not a game rule). Two reasons:

- **CI:** a new `#[derive(SpacetimeType)]` type would drift `evals/baselines/spacetime-types.json`
  (off this slice's touch-set); a `u16` adds no new SpacetimeType.
- **Report:** `spacetime sql --json` renders a `u16` as a plain number; a `SpacetimeType` enum renders as
  a brittle tagged object. A scalar is trivially JS-aggregatable.

`PlaytestKind::code(self) -> u16` is an exhaustive `match` returning **explicit literal codes**
(`RecruitAttempt => 1`) — never `self as u16` (which would silently shift historical codes on a variant
reorder, RT-PTB2-09). Codes **2–5 are reserved** for pt-b2b (`SessionStart`, `BattleEnd`, `TradeConfirm`,
`RankedMatch`); code `0` is invalid/never-written. A future variant is a compile error at `code()` until
it is assigned a code. Illegal states are unrepresentable at the write boundary: only `code()` ever
produces the `u16`.

### 3. Interval-singleton TTL + cap reaper (bounded growth)

A per-row `ScheduleAt::Time` schedule (the trade/pvp pattern) is wrong for a high-volume append-only table
(one schedule row per event — unbounded). Instead **one** `ScheduleAt::Interval` singleton row
(`playtest_reaper_schedule`, PRIVATE, colocated with its reducer per the ADR-0056 exception, mirroring
`movement_tick_schedule`). Interval rows **persist** and re-fire (unlike one-shot `Time` rows the runtime
auto-deletes) — an `include_str!` scan pins `ScheduleAt::Interval` (RT-PTB2-02/M-2).

Each `playtest_reaper` tick (scheduler-only guard `if ctx.sender != ctx.identity() { return Err(...) }` —
a client must never delete gate evidence): partition rows (sorted ascending by `event_id`) into
TTL-expired (`now_ms - created_at_ms >= PLAYTEST_EVENT_TTL_MS`) vs fresh; the delete set = all expired ids
+ the oldest `(fresh − CAP)` fresh ids when fresh exceeds `PLAYTEST_EVENT_CAP`; **truncated to
`PLAYTEST_REAP_MAX_DELETE_PER_TICK`** so a pathological burst drains over several ticks rather than
timing-out-and-rolling-back into a livelock (RT-PTB2-04/08). Collect-before-delete (never mutate
mid-iteration). Consts (in `playtest.rs`): `PLAYTEST_EVENT_TTL_MS` = 7 days (survive multi-day sessions —
contrast the 1 h trade *liveness* TTL), `PLAYTEST_EVENT_CAP` = 20 000, interval = 5 min, batch = 8192.
Peak in-flight ≈ `CAP + one interval's writes`, drained at `batch`/tick — ample for a solo tester.

**Arming** — `ensure_playtest_reaper(ctx)` from both `init` and `sync_content` (where `ensure_zone_schedules`
is called). SpacetimeDB reducers execute serially, so a re-`sync_content` sees the committed prior row; the
guard is nonetheless **self-healing**: it inserts one row only when none exists, else deletes all but the
first (defensive dedup → exactly one row after every call; RT-PTB2-02, reviewer M-3). Like zone schedules,
a republish without `--delete-data` requires an owner `sync_content` to (re)arm — an accepted, documented
gap.

### 4. Emit — single site, after the roll (`attempt_recruit`, taming.rs)

`record_recruit_event(ctx, sender, battle_id, wild_species_id, hp_permille(pre_roll_current, pre_roll_max),
bait_item_id, success)` is called **once**, immediately after `let success = game_core::attempt_recruit(...)`
and **before** the success/fail branches. This is strictly safer than emitting at both `return Ok(())`
sites: there is no `?`-propagating call between the roll and the record, so no completed attempt is silently
dropped (RT-PTB2-01), no double-record is possible, and the record is atomic with the reducer transaction
(if any later `?` aborts, the record rolls back with the bait-consumption — no "bait gone, no event"
inconsistency). It uses the **pre-roll** HP captured into owned locals before any battle-state mutation
(taming.rs already reads `wild_max_hp`/`wild_current_hp` there), so `hp_permille` is the wild's HP at the
moment of the attempt — the H1 weaken lever, pre-counterattack. `record_recruit_event` returns `()`
(infallible) — observability never changes the reducer's `Result`. Early-reject paths (not owner / not
ongoing / not wild / bad bait) return before the roll and record nothing.

`hp_permille(current, max)` = `0` when `max == 0`, else `min(1000, current*1000 / max)` (integer floor —
the conservative direction for a weaken-first threshold; div-by-zero-safe; clamped 0..=1000).

### 5. `just playtest-report` — dump-and-aggregate, fail-loud, no PII in output

`scripts/playtest-report.mjs`: an **exported pure** `aggregateReport(rows, {weakenThresholdPermille=500})`
(no I/O, no globals) computing — over `kind === RecruitAttempt` rows — H1 (`weakenFirstRate` = fraction at
`hp_permille <= threshold`, plus bait-usage and success rates) and H2 (`recatchRate` from `(identity,
species_id)` pairs appearing ≥2×). It is **division-by-zero-safe**: an empty row set returns zeroed rates
(NaN-free). The return shape carries **only numbers** — never an identity/hex string (PII firewall,
RT-PTB2-03). A main-guarded driver dumps the table via `execFileSync('spacetime', ['sql', db, SQL,
'--json'])` — **array args, no shell string interpolation** of the DB name (no shell/SQL injection,
RT-PTB2-07). It distinguishes **errored/unparseable** `spacetime sql` (→ `console.error` + `process.exit(1)`,
fail-loud) from a **legitimately empty** table (valid `[]` → a prominent "0 events captured" banner + zeroed
report, exit 0 — a fresh DB must not hard-fail; RT-PTB2-10). The `just playtest-report` recipe (env
`STDB_SERVER` / `MR_PLAYTEST_DB` defaults, mirroring pt-a2) is **not** in `just ci` (live-DB dependent, like
`playtest-up`); the pure `aggregateReport` + the wiring are gated by the new `playtest-report` eval.

### 6. Proof-of-teeth (evals/** is touched only for this additive slice; SERIAL → no sibling collision)

- **Rust in-tree** (`server-module/src/playtest_tests.rs`, `taming_tests.rs` — siblings, in-scope):
  `hp_permille` boundaries; `code()` pinned literal; reaper cap eviction asserts the **surviving set**
  (newest CAP by contents, not `.len()`); TTL boundary; scheduler-only guard rejects a non-scheduler
  sender; singleton arm idempotency (two calls / pre-seeded extras → exactly one row); `record_recruit_event`
  payload + bait `None→0`; and the recruit emit teeth (success→`success=true` + pre-roll `hp_permille`,
  fail→`success=false`, early-reject→no record, recording does not change the `Result`).
- **New slice-own evals** (auto-discovered by `evals/run.mjs` — no registry edit):
  `playtest-event-privacy.eval.mjs` (imports `parseTables`/`stripComments` from `encounter-privacy`;
  asserts both tables PRIVATE + no public `playtest*` projection + no `client_visibility_filter` + no client
  binding + the reaper scheduler guard present + `PlaytestKind` is not `SpacetimeType` and has no `as u16`
  cast) and `playtest-report.eval.mjs` (aggregator teeth + recipe/script structural scans incl. the
  `execFileSync`/`process.exit(1)`/no-identity-in-output invariants). No new `RegExp` (Semgrep
  `detect-non-literal-regexp`) — `indexOf`/literal patterns only.

## Consequences

- The fun gate gets a server-authoritative H1 (weaken-first) + H2 (re-catch) proxy stream that survives
  client-side loss; the report is pre-committed, not post-hoc.
- Determinism (ADR-0003) is untouched: the record is written in the shell after the roll; it consumes no
  RNG and does not reorder any `ctx.random()` draw, so client prediction cannot desync.
- `game-core` is not touched (observability is a shell concern) — no cross-crate signature impact.
- pt-b2b adds the H3/battle emit sites + additive columns + report sections, reusing this table/reaper.

## Alternatives considered

- **Per-row `ScheduleAt::Time` reaper (trade pattern).** Rejected: one schedule row per event is unbounded
  for a high-volume table; an interval singleton is the correct topology.
- **`kind` as a `SpacetimeType` enum column.** Rejected: drifts the spacetime-types baseline and renders as
  a brittle tagged object in `spacetime sql --json`.
- **Put `PlaytestKind`/`hp_permille` in game-core.** Rejected: it is server-only observability, not a rule;
  the client's `hpPermille` lives in TS (never shared via game-core), so game-core placement buys no SSOT
  and adds caller-impact cost (YAGNI).
- **Wire all H1/H2/H3 emit sites now.** Rejected: doubles the emit-site + test surface for zero spine-risk
  reduction; H3 is a clean pure-additive follow-up (pt-b2b).
- **Exit non-zero on an empty table.** Rejected: a fresh DB legitimately has zero events; a banner + exit 0
  is correct, while an errored/unparseable dump is the real fail-loud case.
