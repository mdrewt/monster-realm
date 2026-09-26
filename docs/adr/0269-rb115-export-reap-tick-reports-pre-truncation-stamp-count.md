# ADR-0269 — The export reaper's tick record reports the window's pre-truncation stamp count: `due`, from a pure `count_export_reap_stamps` that runs the frozen bundle seam uncapped (rb-115)

**Status:** Accepted
**Date:** 2026-09-26
**Slice:** rb-115 (residual R-rb-87-BACKLOGAMBIG, promoted from source slice rb-87; M-residual-backlog.spec.md#rb-115)
**Supersedes:** —
**Amends:** —
**Extends:** 0238
**Subsystems:** schema-persistence, security-authz
**Decision:** export_bundle_reaper's tick record gains due: the read window's distinct expired stamps before the stamp cap, counted by a pure count_export_reap_stamps running the frozen bundle seam uncapped; due > planned means the cap bound.

---

## Context and problem statement

rb-87 (ADR-0238, dated amendment of 2026-09-18) gave the hourly PRV1-14 TTL reaper one terminal
observation line, rendered from a private three-field record `ExportReapTick { read, planned, reaped }`:
the chunk rows the bounded window decoded (at most `EXPORT_REAP_MAX_READ_PER_TICK`, 256), the creation
stamps the bundle seam selected (at most `EXPORT_REAP_MAX_STAMPS_PER_TICK`, 16), and the datastore's
own count of the rows the tick deleted, tails beyond the window included. The same amendment disclosed
that a cap at its bound is only a backlog HINT: `planned` at 16 may mean the stamp plan was truncated or
that exactly sixteen stamps expired; `read` at 256 may still have drained every expired row, because a
whole-stamp delete takes its tail beyond the window; and a saturated stamp cap can show `read` far below
256 (twenty expired stamps of five chunks). It named the missing number — the window's distinct-stamp
count BEFORE `truncate(max_stamps)`, swallowed inside rb-86's frozen `plan_export_reap_stamps` — and
deferred it as residual **R-rb-87-BACKLOGAMBIG**, because exposing it looked like reshaping that seam.

The spec's EARS line for this slice is the residual's own sentence (the read/planned counts are a
necessary-not-sufficient HINT; the pre-truncation count is swallowed inside the frozen seam), with an
ADR-0224 proof obligation: an ordinary Rust test in `privacy_tests.rs` that is RED before the fix and
GREEN after, no new eval.

Two constraints shaped the fix:

- **The seam is frozen, and it is the only definition of the stamp set.**
  `plan_export_reap_stamps(rows, now_ms, ttl_ms, max_stamps) -> Vec<i64>` runs `plan_export_reap` (the
  SSOT expiry predicate) over the whole window, keeps the stamps of the ids it plans, sorts and dedups
  them, and truncates to `max_stamps`. rb-86 pins its signature and body by equality. A second
  definition of "which stamps are due" would be a second retention rule.
- **The census budget and the native host shape the new code.** `[rb85/iter-census]` budgets `.iter()`
  in privacy.rs against three sanctioned table reads, which is why the seam is an explicit loop; new
  code must not spend a slot on an iterator chain. The native test host executes the helper only
  through the syscalls it models (since rb-109: the range read and the index-point delete on registered
  indexes), so new logic must be pure — executable on its own — or a plain binding inside the helper
  that `rb109_tick` already executes.

## Findings

Recorded before the decision because they bound what the new field can claim.

**F1 — on shipped constants the stamp cap binds only on a short stamp or an interleaving read.**
Truncation needs at least seventeen distinct stamps in the 256-row window. When the read yields each
stamp's rows together (the ascending yield the native host models), the sixteen oldest stamps lie
wholly inside the window with at least one row of a seventeenth after them. Those sixteen therefore
total at most 255 rows, which needs a stamp of **at most fifteen rows**: sixteen stamps of sixteen rows
fill the window with no seventeenth. The smallest bundle this module writes is seventeen rows
(`EXPORT_MIN_BUNDLE_ROWS`, one chunk per exportable table; 16 × 17 = 272 ≥ 256 is the throughput floor
rb-86 pins off the live manifest). A short stamp can still exist: a torn leftover from before rb-86, a
bundle written by an older module with a smaller exporter set, or rows removed by out-of-band owner
SQL. The plan red-team's tick model measured the threshold: with a fifteen-row minimum 45 of 20 000
ticks bound, with a sixteen-row minimum none did. So on a live tick `due > planned` implies either a
stamp of at most fifteen rows or a range read that interleaves stamps, which the modelled ascending
yield never does. The evidence about ORDER is one-directional: an interleaving read can produce
`due > planned` (same model: 12 073 of 20 000 shuffled trials), but a reversed-yet-grouped (descending)
read of bundles of sixteen rows or more never does (0 of 20 000). `due` can reveal a non-ascending
yield; it cannot rule one out.

**F2 — the three counts already decided WHETHER truncation happened on the ascending host; they cannot
say HOW MANY stamps the window held.** One direction holds in any read order: if nothing was truncated,
every stamp in the window was planned and deleted whole, so every window row is among the reaped rows
and `reaped ≥ read`; hence `reaped < read` proves truncation. The reverse reading — `reaped ≥ read` as
"not truncated" — needs the planned stamps to lie wholly inside the window. The ascending yield
guarantees that (sixteen whole stamps deleted, at least one row of a seventeenth left in the window, so
`reaped ≤ read − 1`); other orders do not. So the residual's "planned==16 may be exactly-sixteen" is
true of `planned` alone, not of the full record on the ascending host. What `due` adds is the direct,
order-independent observation of HOW MANY stamps the window held, which no function of the three
counts can recover. Two ascending populations with byte-identical three counts prove it:

- **A** — 20 expired bundles × 13 rows (+ 2 live; rb-109's stamp-cap population): the window is nineteen
  whole bundles and nine rows of a twentieth → `(read, planned, reaped) = (256, 16, 208)`, `due` **20**.
- **A′** — 16 expired bundles × 13 rows + one newest expired 60-row bundle: the window is 208 + 48 rows →
  `(256, 16, 208)`, `due` **17**.

Off the ascending order, the exactly-sixteen-versus-truncated ambiguity the residual named is real even
for the full record. **P1** (sixteen 15-row bundles above one 31-row oldest bundle) and **P2** (fifteen
16-row bundles above one 16-row oldest bundle), each read DESCENDING, both give `(256, 16, 256)`: P1 is
truncated with `due` 17, P2 is not, with `due` 16. Stated here, not tested — the native host models
the ascending yield only (R-rb-109-ORDERMODEL), so such a test could only restate this arithmetic.

**F3 — the window edge is out of reach of any count taken over the window.** When a tick reads a full
window and plans every stamp it saw, rows expired at that instant may remain past the window's edge.
`due` is taken over the window and inherits that blindness: on live data (bundles of seventeen rows or
more, grouped yield) `due == planned` on every well-formed tick, so `due` never shows a partly drained
window. rb-109's oversized population is the measured case: one tick of `(256, 16, 272)` with `due` 16
leaves four expired bundles in the store. That half of the residual is R-rb-115-X8, which
stays open (Residuals).

## Decision

**D1 — a pure count runs the frozen seam uncapped.** A new PRIVATE fn in privacy.rs, declared once,
directly above the helper: `count_export_reap_stamps(rows: &[(u64, i64)], now_ms: i64, ttl_ms: i64) -> usize`,
whose one-line body is `plan_export_reap_stamps(rows, now_ms, ttl_ms, rows.len()).len()`. The seam stays
the only definition of the stamp set and `plan_export_reap` the only expiry predicate. The seam's
signature, body and explicit-loop idiom are untouched, and the count adds no loop, no iterator chain
and no second truncation site. The cap `rows.len()` is one the window cannot reach, spelled the way the
seam itself calls `plan_export_reap(rows, now_ms, ttl_ms, rows.len())`. PURE and ONE LINE, so it has a
value oracle of its own. Its result is only ever a count, never a plan.

**D2 — the record gains `due`, in data-flow order, bound in the helper over the same window.**
`ExportReapTick` becomes `{ read, due, planned, reaped }`, four `usize` fields, still private with
private fields and the same derive. `due` is WINDOW-scoped by definition: the distinct creation stamps
the window holds that the SSOT predicate calls expired, before the write bound — never what the store
owes. `reap_expired_export_bundles` binds
`let due = count_export_reap_stamps(&rows, now_ms, EXPORT_BUNDLE_TTL_MS);` directly after the bounded
read and before the capped seam call. It runs over the same rows, the same instant and the same TTL as
the capped call, and the record literal gains `due`. By construction
`planned == min(due, EXPORT_REAP_MAX_STAMPS_PER_TICK)` and `due ≤ read`. The reducer shell (guard →
helper → `reap_fields` → `mr_log` → `Ok(())`) is byte-identical.

**D3 — one more bare number on the line.** `reap_fields` renders `due` between `read` and `planned`
through the same JSON micro-builder (a `stringify!` key, a bare `usize`). The fragment is
`"read":N,"due":D,"planned":K,"reaped":M`, and the line composes to
`{"evt":"export_bundle_reap","read":N,"due":D,"planned":K,"reaped":M}`. It still has no subject, is
still unconditional on the success path, and is still the reducer's last statement before `Ok(())`.

**D4 — what the four counts mean to an operator.** They are still raw counts, with no derived verdict.

- `due > planned`: the stamp cap bound this tick, and `due − planned` expired stamps inside the window
  were left for later ticks. On shipped constants that implies a stamp of at most fifteen rows or a
  read that interleaves stamps (F1). It can reveal, but cannot rule out, a non-ascending yield.
- `read < EXPORT_REAP_MAX_READ_PER_TICK` with `due == planned`: the range read ran out before the
  window filled and every stamp in it was deleted whole, so every row expired at that tick's instant
  is gone. This holds in any read order. The rb-87 residual's own "twenty expired stamps of five
  chunks" tick (read 100, due 20, planned 16, reaped 80) shows why the `due == planned` half is needed:
  `read` alone is far below the window while four bundles remain.
- `read == EXPORT_REAP_MAX_READ_PER_TICK`: SILENT past the window edge, with or without `due` (F3). On
  live data `due` is therefore a tripwire, not a backlog signal. Consecutive full-window ticks remain
  the backlog heuristic rb-87 named, and making either one an alert belongs to the rb-87 X10 alarm
  backlog item.

**D5 — the seam has exactly one uncapped caller.** `plan_export_reap_stamps` is named three times in
privacy.rs's code: its declaration, the helper's capped call (the write bound), and the uncapped call
inside `count_export_reap_stamps`. The only uncapped caller consumes the result with `.len()` and never
plans from it; the delete loop iterates the capped plan alone. The rb-86 seam-scope census's privacy.rs
count moves 2 → 3 by attribution, not by relaxation.

**D6 — the test fixtures widen append-only.** `rb109_tick` is the one test-side call site of the
helper. It returns a four-tuple `(read, planned, reaped, due)` with `due` LAST: existing tests read
`.0/.1/.2` by position, and a mid-tuple insert would compile and silently re-point `.2`. The rb-87
constructor takes record order, `rb87_tick(read, due, planned, reaped)`, and both fixtures' docs record
the mismatch. rb-109's stamp-cap test binds the new field to `_` because its label roster is closed;
the new native-host test asserts `due == 20` on the identical population (A).

**What stays byte-identical:** `plan_export_reap_stamps`, `plan_export_reap`, `export_reap_cutoff_ms`,
the reducer shell, the helper's read, plan and delete statements, both bounds and every constant value,
the schema, the native test host, the client and every eval. The privacy.rs comments that described the
three-count record or the HINT are retruthed, as is the section banner's claim that the native host
models no range scan and no writes (false since rb-109); the edits above the reducer are
line-count-neutral, so the `docs/knowledge/**` anchors into privacy.rs do not move.

## Rejected alternatives

- **(a) A wrapper that truncates itself.** The helper would call the seam once uncapped, take its
  length, then truncate the same vector to the write bound itself. It keeps the SSOT, but the seam's
  `max_stamps` parameter goes dead in production (the parameter the seam's comment calls the tick's
  write bound), the cap moves out of the seam call rb-86's cap-wiring pin freezes, and a second
  truncation site appears.
- **(b) An independent recount.** A second loop or chain over the window that collects distinct
  expired stamps would put a second definition of the stamp set beside the seam — the SSOT break D1
  exists to avoid — and its likeliest spelling spends an `.iter()` slot.
- **(c) Reshaping the frozen seam** to return the pre-truncation count beside the plan (a tuple or an
  out-parameter). That re-opens rb-86's equality pins for a number that calling the seam uncapped
  already yields.
- **(d) A derived `backlog: bool`.** Rejected again for rb-87's reason: the thresholds belong in
  ops/observability, where they can change without a module publish, and a boolean the module
  computes is a second retention policy nobody reviewed.
- **(e) A `.take(EXPORT_REAP_MAX_READ_PER_TICK + 1)` peek** to see past the window edge. It changes the
  tick's read bound (257 decoded rows) and about six pins, and it answers only the edge question, not
  the stamp count.
- **(f) Calling the seam with `max_stamps + 1`.** That answers only "was there a seventeenth stamp?",
  which is a boolean, not a count.
- **(g) Deriving truncation from `reaped < read`.** The reverse reading is order-dependent (F2, P1),
  and it is arithmetic over `read` and `reaped`, which the rb-87 record says an operator panel must
  never subtract.
- **(h) `usize::MAX` as the count's cap.** It gives the same value; `rows.len()` is kept because it
  mirrors the seam's own `plan_export_reap(rows, now_ms, ttl_ms, rows.len())`.
- **(i) `**Amends:** 0238` instead of `**Extends:** 0238`.** `Amends` forces a reciprocal
  `**Amended-by:**` line into ADR-0238's header block. That insert shifts every line below it and makes
  the five self-citations in that record's rb-110 amendment stale. No gate catches that prose drift,
  so it is not a gate break. ADR-0267 and ADR-0268 set the lineage precedent: `**Extends:**` plus a
  dated body amendment.

## Consequences

- **Cost.** Each hourly tick makes one more uncapped seam pass over at most 256 decoded rows: two sorts
  of at most 256 elements, at most 256 × 256 = 65 536 `contains` comparisons, and one dedup. There is
  no syscall and no decode, so the cost is negligible next to the up to sixteen index-point deletes
  the tick already issues under the write lock.
- **The line grows by one bare number.** Nothing consumes `evt="export_bundle_reap"` yet (ADR-0238,
  rb-87 amendment). The obvious first alerts — `due > planned`, and N consecutive ticks with
  `read == EXPORT_REAP_MAX_READ_PER_TICK` — belong to the rb-87 X10 alarm backlog item.
- **`due` counts stamps, not bundles.** Pre-rb-111 shared stamps stay alive for one retention window
  (R-rb-111-LEGACYSTAMP). Until then, a shared stamp counts once in `due` just as it does in `planned`.
- **R-rb-87-BACKLOGAMBIG is discharged on its truncation half.** Its window-edge half is not
  discharged; it continues as R-rb-115-X8.

## Residuals

- **R-rb-115-X8** (MED) — stays open. A tick that reads a full window
  (`read == EXPORT_REAP_MAX_READ_PER_TICK`) and plans every stamp it saw cannot say whether expired rows
  remain past the window's edge; `due` is taken over the window and inherits that blindness. Measured
  case: rb-109's oversized population — one tick of `(256, 16, 272)` with `due` 16 still leaves four
  expired bundles. Candidate fix: after the delete loop, one probe
  `ctx.db.export_bundle().created_at_ms().filter(..=cutoff).next().is_some()`, reported as a raw
  observation. It costs one range syscall and at most one buffer fill of the SDK's row iterator, and the
  native host already models the range read. It would re-freeze the range and index-reach censuses and
  the helper body pin. Zero-cost interim: an ops rule on consecutive full-window ticks. Until one of
  those lands, R-rb-115-X8 stays open.
- **R-rb-109-ORDERMODEL stays open.** `due > planned` can reveal an interleaving read but cannot rule
  out a grouped non-ascending one (F1). Closing it still needs a live-instance probe, as the rb-109
  record says.

## Confirmation

ADR-0224: ordinary Rust tests, no eval. There are five `rb115_` tests in
`server-module/src/privacy_tests.rs` (their subject is `server-module/src/privacy.rs`):

- **T1 — the pure count's value table:** empty, all-live, one bundle, sixteen and twenty stamps, the
  cutoff boundary, a 300-row window past the read cap, both `i64` extremes, and a row at a NON-shipped
  TTL, so a body that hard-codes `EXPORT_BUNDLE_TTL_MS` reds by value. It also checks order
  independence and count versus capped plan.
- **T2 — native-host ticks through the shipped helper:**
  - A and A′: `(read, planned, reaped)` identical and `due` 20 versus 17, so no function of the three
    counts yields it.
  - B, rb-109's oversized population: `(256, 16, 272)` with `due` 16, and four expired bundles surviving
    as the WINDOWEDGE disclosure.
  - C, twenty expired five-row bundles: read 100, due 20, planned 16, reaped 80.
- **T3 — source pins:** the new fn declared once, private, with frozen signature and body; the seam
  named three times, attributed per body in both the paren and the bare-identifier form; the helper's
  single `let due` binding over the same window arguments as the capped call.
- **T4 — the docs census** over this record, ADR-0238's rb-115 amendment and the `**rb-115**` line of
  `ARCHITECTURE.md`.
- **T5 — a closed roster.**

These pins are re-frozen in the same diff, each a reviewed event:

- `rb85_helper_body_exact`, with its independently spelled source control
- the rb-86 seam-scope census, 2 → 3 attributed
- the rb-87 record-shape, fragment-body, value-table, quote-census and envelope pins, and the helper's
  `let` census, 5 → 6
- the rb-109 tuple sites

`rb87_reap_fields_renders_three_bare_counts` keeps its name, which ADR-0238 cites, while it now pins
four counts.

The RED record (stages and mutant register) is in the harness ledger at
`memory/projects/gates/rb-115.red-before.md`. Suite 1031 → 1036 (1032 → 1037 with `dev_reducers`)
(provisional; confirmed at merge).
