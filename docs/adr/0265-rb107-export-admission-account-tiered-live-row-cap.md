# ADR-0265 — Export admission control: a global `export_bundle` live-row cap sized to the reaper's one-TTL drain, halved for callers with no account row, enforced by two pure-predicate gates after the purge (rb-107)

**Status:** Accepted
**Date:** 2026-09-21
**Slice:** rb-107 (residual R-rb-85-EXPORTADMIT, promoted from source slice rb-85; M-residual-backlog.spec.md#rb-107)
**Supersedes:** —
**Amends:** —
**Extends:** 0238, 0226, 0189
**Subsystems:** schema-persistence, security-authz
**Decision:** `request_data_export` is admitted against a global `export_bundle` live-row cap (43 008 = the reaper's one-TTL drain), halved for callers with no `account` row, by two pure-predicate gates after the purge; reject, never clamp.

---

## Context

ADR-0226 shipped `request_data_export`; ADR-0238 (rb-48) added the TTL reaper and rb-85/rb-86
bounded its READ side — a tick reads a bounded btree range, deletes at most
`EXPORT_REAP_MAX_DELETE_PER_TICK` rows and at most `EXPORT_REAP_MAX_STAMPS_PER_TICK` creation
stamps. Nothing bounded the WRITE side. That gap is residual R-rb-85-EXPORTADMIT, promoted to this
slice.

`join_game` requires no JWT — anonymous play is a product decision, not an oversight — so an
unbounded number of identities can each ask for an export. Every accepted request writes at least
one chunk per exportable manifest table (17 today, empty tables included, because
`plan_export_chunks` pushes an empty chunk rather than skipping the table), and each chunk carries
up to `game_core::EXPORT_CHUNK_ROWS` = 500 serialized rows
(`game-core/src/accounts/deletion.rs:145`). The two per-identity controls that exist are already
maximal and are both blind to this: purge-before-write means one identity holds at most one bundle
at a time, and `EXPORT_REQUEST_COOLDOWN_MS` (`privacy.rs:1199`) rate-limits that identity — neither
can see a thousand identities.

Two facts fixed the design space before planning. First, the native test host
(`server-module/src/native_host_tests.rs:14-18`) defines exactly ten (eleven since rb-109) `#[no_mangle]` syscall
symbols and `datastore_table_row_count` is not among them, so any admission logic that reads a
table can never execute in an ordinary `#[test]` — and after this slice a test that so much as
names `request_data_export` fails the LINK of the whole `monster-realm-module` lib-test binary
rather than redding one test. Second, a new table is a STOP: ADR-0221's automigration freeze,
`DATA_LIFECYCLE_MANIFEST` set-equality, the schema-snapshot baselines, bindings regen and the
client all move for it.

## Decision

**D1 — One global ceiling, derived from the drain, not chosen.**
`EXPORT_LIVE_ROW_CAP = EXPORT_REAP_MAX_DELETE_PER_TICK × (EXPORT_BUNDLE_TTL_MS /
EXPORT_REAP_INTERVAL) = 256 × 168 = 43 008` — what the reaper retires in one whole retention
window. The derivation, not a taste: whenever at least `EXPORT_REAP_MAX_DELETE_PER_TICK` expired
rows exist, a tick READS that many (the range is keyed at or below the cutoff, so every row it
reads has expired) and deletes every creation stamp it read WHOLE, so it retires **at least** as
many rows as it read. The stamp cap cannot truncate first, because a bundle is at least one chunk
per exportable table, which is exactly the inequality

    EXPORT_REAP_MAX_STAMPS_PER_TICK × EXPORT_MIN_BUNDLE_ROWS ≥ EXPORT_REAP_MAX_DELETE_PER_TICK
    (16 × 17 = 272 ≥ 256)

that `[rb86/stamp-cap-throughput]` (`privacy_tests.rs:16799-16812`) already asserts at runtime off
the live manifest. Because stamps are deleted whole, no bundle is ever partly reaped and the floor
holds whatever order the window arrives in. Hold the live population at or below one TTL of that
drain and every expired row leaves within one TTL of expiring: the write side structurally cannot
outpace the drain, however many anonymous identities ask. That is the residual's EARS, discharged.

The constant is **private**, on the `EXPORT_REQUEST_COOLDOWN_MS` precedent: a DoS knob, not a legal
figure, and nothing outside this module decides who may write a bundle. `pub(crate)` would be an
unused widening and would make the cap read as a retention rule. `privacy_tests` is a child module,
so a private const is still test-visible.

**D1b — Two thresholds over ONE count: the anonymous tier.** A single flat cap is defeated by the
thing it exists to stop: ~2 530 anonymous identities holding 43 008 rows lock every export out for
as long as the attacker keeps paying one `join_game` + `request_data_export` pair every ~239 s, and
"it self-heals in seven days" is false while that price is being paid. rb-107 therefore ships
`EXPORT_ANON_LIVE_ROW_CAP = EXPORT_LIVE_ROW_CAP / 2 = 21 504` for callers with no `account` row.
The shed order is what buys the property: an anonymous caller is refused while an account holder
still has headroom, so **21 504 rows — about 1 264 minimum-size bundles — are structurally
unreachable without a verified allowed-issuer token.**

The subject test is `crate::accounts::is_account_holder(ctx, me)` (`accounts.rs:474-479`), the
crate SSOT for exactly this question (ADR-0189 D2), **never `has_jwt()`**: the host mints its own
token, so `has_jwt()` is true for every connection (`accounts.rs:30-33`), while an `account` row
exists only for a token whose issuer is in `ALLOWED_ISSUERS` and whose audience verified
(`accounts.rs:613-669`). privacy.rs already calls the sibling
`crate::accounts::is_pending_deletion(ctx, me)` at `:1516`, so the call shape is idiomatic, and it
adds no new `ctx.db.` text to privacy.rs — `m22s4 [X9/accessors]`, `m22s4_db_accessors` and every
account-read census stay untouched. The cost is one additional unique-index point read on the same
`account` table and index the subject guard probed one statement earlier: a warm lookup, not a
scan.

State plainly what tiering does **not** buy: an account holder's own admission still counts ALL
live rows, so a full store rejects everyone. The guarantee is only that JWT-less identities alone
cannot push the total past half.

Rejected here, each for one reason: **binding `has_account` inside the subject guard** (saves one
syscall but reopens ADR-0226's frozen security-boundary statement at `privacy.rs:1511-1512`); **an
inline `ctx.db.account().identity().find(me).is_some()`** (a second spelling of the account gate
inside a module that would then own two of them, and the shape `guards_tests.rs:2378-2380` calls "a
direct account-table read"); **account-gated export only** (a portability regression and a
behaviour change for every guest, far beyond the residual); **a shorter TTL for anonymous bundles**
(a second retention policy, a new column or a second reaper path, and ADR-0221's freeze); **a
single flat cap** (the lockout above).

**D1c — `EXPORT_MIN_BUNDLE_ROWS = EXPORTERS.len() as u32` = 17, derived, never transcribed.** One
chunk per exportable table is the smallest bundle this reducer can write, and the const totality
assertion already makes `EXPORTERS.len()` exactly the manifest's exportable count. A transcribed
`17` would silently stop tracking the manifest; the test additionally cross-checks the value
against `DATA_LIFECYCLE_MANIFEST.iter().filter(|e| e.exportable).count()`, so a
registry/manifest divergence reds rather than shrinking the floor. The number is load-bearing
twice: it is the pre-gate's request size, and it is the left-hand side of D1's inequality, which
collapses at 15 or fewer exportable tables.

**D2 — The admission decision is a pure predicate.**

    fn export_admission_open(live_rows: u64, requested: u32, cap: u64) -> bool {
        live_rows.saturating_add(u64::from(requested)) <= cap
    }

Purity is a CONSTRAINT here, not a style preference: the shells around it reach a table, so they
can never run in the native host, and a `ctx` inside the predicate would turn every value-oracle
call into a link failure of the whole test binary. Scalar in, `bool` out, it has an ordinary value
oracle.

**EXACT rather than approximate.** The request's own row count is added, so a request is admitted
only if the WHOLE bundle fits and the live population can never EXCEED the cap. The headroom form
`live_rows < CAP` was rejected: it overshoots by one whole request and loses a hard ceiling for
nothing, since the exact size is already bound one statement above the second gate.

**SATURATING, because the failure direction matters.** The release profile enables overflow checks;
an addition that wrapped would both abort the reducer and — worse — ADMIT, since `u64::MAX + 1`
wraps to 0 and compares under any cap. Every arithmetic error in this predicate must fall on the
refusing side.

**D2b — Tier selection is its own pure seam.** `fn export_live_row_cap(has_account: bool) -> u64`
returns `EXPORT_LIVE_ROW_CAP` or `EXPORT_ANON_LIVE_ROW_CAP`. It has one caller and could be inlined
as an `if` in the `let cap` binding; it is kept as a named exception to that simplification because
as a seam its swapped-arms and tier-collapse mutants die on a VALUE oracle instead of a text pin.

**D3 — Two gates, both after the purge, one reason, one cap binding.** The reducer's statement
order becomes: subject guard, deletion gate, cooldown, purge-before-write, **admission pre-gate**,
manifest-order walk, **admission exact gate**, insert loop, rb-48 self-arm, rb-65 observation line.

- The **pre-gate** follows `let purged = purge_export_bundles(ctx, me);` (`privacy.rs:1530`) and
  asks whether even the SMALLEST possible bundle fits: `export_admission_open(count,
  EXPORT_MIN_BUNDLE_ROWS, cap)`. A caller who cannot be served at all is refused BEFORE the
  manifest walk, which includes two unindexed own-row scans (`privacy.rs:1385`, `:1429`).
- The **exact gate** sits between `let total = plan.len() as u32;` (`:1555`) and the insert loop
  and re-asks with this request's exact row count, so the population can never exceed the cap.
- Both share ONE static reason (`stringify!(export_reject_admission)`, pinned at exactly two
  occurrences) and ONE `let cap` binding (pinned at exactly one): two reasons or two bindings is
  how the anonymous tier would get quietly lifted for the second gate.

Both gates follow the purge, for two reasons. The count then excludes the caller's own prior
bundle, which this same transaction has already deleted — the fair reading, and the one the runtime
gives (below). And the three pre-purge rejects keep their shape: `m22s4 [X9/returns]` = 3 and the
`[X9/reason]` three-name roster are unchanged, and rb-107 cites `[X9/returns]` as the prefix guard
rather than widening it. Placing a fourth reject among the guards was rejected for exactly that:
it charges a re-exporting caller for rows about to disappear and moves two frozen censuses. (In
revision 1 the same row was rejected for inbound-citation drift; that rule is void — see the
staleness record in Consequences — and the placement stands on its own terms.)

An `Err` from either gate rolls the purge back with it. That is not a hazard but the documented
semantics: one reducer, one transaction, ADR-0106 D8 (TOCTOU non-issue). A rejected caller
therefore keeps the bundle they already had.

The live population is read with `ctx.db.export_bundle().count()`. `Table::count()` is
`datastore_table_row_count`: constant-time datastore metadata that **takes the current
transaction's modifications into account** (`spacetimedb-2.8.1 src/table.rs:24-30`), so the
pre-gate's count already reflects the purge one statement above. Its `.expect(...)`
(`table.rs:132`) means a host error panics — the reducer fails closed, which is again the refusing
direction.

**D4 — What this slice deliberately does not build.**

| Rejected | Why not |
|---|---|
| A new admission/counter table (per-hour singleton) | ADR-0221's automigration freeze, manifest set-equality, schema-snapshot baselines, bindings regen and the client — to store a number the datastore already knows in O(1). |
| A sliding window over the `created_at_ms` btree | Materialises up to cap+1 payload rows on EVERY call, rejects included — exactly the cost rb-85 removed from the reaper (`[rb85/no-sweep]`). |
| A tighter per-identity cap | Already exists and is already maximal: purge-before-write bounds an identity to one bundle and the cooldown rate-limits it; neither sees sybils, which is the whole residual. |
| A cap sized to ONE DAY of drain (6 144) | ~361 concurrent minimum bundles — a denial surface for legitimate users at a fraction of the benefit, and a number with no derivation behind it. |
| A cap sized to TWO TTLs (86 016) | More headroom, but a full store then needs two retention windows to drain and "never outpaces the drain" weakens to "outpaces it by two". |
| Evicting the oldest bundle instead of rejecting | Breaks the seven-day retention promise for a third party who did nothing wrong, tears a client mid-assembly, and inverts reject-not-clamp. |
| Clamping the plan to the remaining headroom | Ships a SHORT bundle under a success return — the exact k-of-N tear rb-86 closed. |
| A range scan or an `.iter()` anywhere on this path | `[rb85/no-sweep]` = 0, `[rb85/iter-census]` = 3 and `[rb85/range-census]` = 1 are budgets; `.iter().count()` is a full sweep wearing a count. |
| Reject reason `export_reject_capacity` | `export_reject_admission` keeps one vocabulary with `export_admission_open` and the pre-gate/exact-gate language; no client enumerates reject strings, so the wire value is free either way. |

**D5 — A reject is silent on the wire beyond the `Err`.** Both admission rejects return only
`Err(stringify!(export_reject_admission).to_string())`, as the three existing rejects do. No
observation row is emitted on the reject path: that is ADR-0243's no-emission-on-reject doctrine
(that ADR carries no `D<n>` labels; it is cited by topic), whose amplification argument applies
here in its anonymous form — an emission per reject hands an attacker a write per rejected read.
The rb-65 `data_export` observation line stays success-only and textually unchanged, and
`export_fields` is not grown. The cost of that silence is stated, not hidden: see R-rb-107-CAPOBS.

## Consequences

**The lockout is scoped, not closed, and it does not self-heal while sustained.** Any global
control lets whoever fills the budget deny the people behind it; per-identity fairness against
anonymous sybils is impossible without authentication, and `join_game` is anonymous by design.
Tiering scopes the denial to anonymous subjects and roughly doubles its sustaining cost per row
denied: the anonymous share is ≈ 1 264 minimum bundles, and refreshing them across one TTL is about
181 `join_game` + `request_data_export` pairs per day — one pair per ~478 s — which keeps every
anonymous export rejected for as long as the attacker keeps paying. Account holders retain 21 504
rows of headroom no JWT-less identity can take. Registered as **R-rb-107-LOCKOUT** (HIGH).

**Worst-case row age is about two retention windows, and the seven-day TTL is a TTL, not a
ceiling.** A full store drains at up to `EXPORT_REAP_MAX_STAMPS_PER_TICK × EXPORT_MIN_BUNDLE_ROWS`
= 272 rows per tick, so 43 008 rows take about 158 hourly ticks ≈ 6.6 days to clear — on top of the
seven days a row waits to expire. Nothing is evicted early: every deletion remains the reaper's TTL
decision. The cap counts rows on disk, expired-but-unreaped rows included, and that is deliberate —
those rows occupy the store whatever their expiry says.

**The exact gate has a narrow rejecting band, and a caller inside it pays nothing.** It rejects
only for `live ∈ (cap − total, cap − EXPORT_MIN_BUNDLE_ROWS]`, i.e. only callers whose bundle
exceeds the minimum, and only AFTER the manifest walk with its two unindexed own-row scans. Such a
caller writes no chunk, and the 60 s cooldown derives its state from the caller's own WRITTEN rows,
so it engages only within 60 s of their last successful export; otherwise they can re-walk at line
rate. A minimum-size identity has an empty band and never reaches the walk. Registered as
**R-rb-107-REJECTWALK** (MED).

**The bound is on ROWS, not bytes.** A chunk carries up to `game_core::EXPORT_CHUNK_ROWS` (500)
serialized rows, so the byte ceiling is the row cap times the widest chunk, and nothing measures or
bounds it — `Table::count` is O(1) metadata, while a byte total needs a scan. This slice retruths
`privacy.rs:1832-1834`, which said the byte-level bound was R-rb-85-EXPORTADMIT; the byte ceiling
is now **R-rb-107-BYTEBOUND** (MED).

**A reject is invisible to operators.** The rb-65 `data_export` line is success-only, no live-row
or rejected-request metric exists, and the reaper's `read`/`reaped` counts are a
necessary-not-sufficient hint, so a sustained lockout looks exactly like nobody exporting. A reject
line was deliberately not added (D5) and `export_fields` was deliberately not grown. Registered as
**R-rb-107-CAPOBS** (MED).

**A capped reject skips the reaper self-arm.** Both gates return before
`ensure_export_bundle_reaper(ctx)`, and their `Err` rolls back any arm made in the same
transaction, so while the store sits at the cap no write path re-arms the TTL singleton. ADR-0238's
invariant "a chunk exists ⇒ the singleton is armed" survives literally — the chunks that exist were
armed when written — but its self-healing reading does not: only `init`/`sync_content` restore an
absent schedule row. Registered as **R-rb-107-ARMSKIP** (MED).

**A net-neutral re-export at exactly the cap is rejected.** Because `count()` reflects the purge and
the gate then adds the whole new bundle, a caller who purges N rows and would write N rows is
refused at a full store. That is the exact-not-approximate rule applied consistently; admitting it
would require a headroom predicate that gives up the hard ceiling.

**The anonymous arm has no live proof.** `evals/account-e2e.eval.mjs:3448-3449` calls
`requestDataExport()` on the success path against a live SpacetimeDB 2.8.1 host with a JWT-bearing
connection and bails if the call is rejected, so CI proves that `datastore_table_row_count` exists
in the deployed `spacetime_10.0` ABI, that the ACCOUNT-HOLDER arm admits on a near-empty store, and
that the S9 flow is unregressed. The anonymous arm rests on the value oracles of
`rb107_admission_is_exact_at_both_caps_and_saturates` and
`rb107_cap_selection_is_tiered_by_account` plus the source pins. Disclosed, not gated.

**R-rb-86-TICKBOUND stays open and out of scope.** A single oversized bundle wedging one reaper
tick is a different residual: this cap bounds how many rows exist, not how many bytes one stamp's
tail carries into one tick's delete.

**Citation-staleness record.** Revision 1 of the plan forbade adding any line above
`privacy.rs:1555` to protect inbound `privacy.rs:<line>` citations. Every one of those citations was
already stale at HEAD: `:1481-1483` (`client/src/ui/privacyModel.test.ts:1023`, `docs/adr/0231:110`)
now points at `rows_character` while the deletion gate is at `:1516`; `:1496-1499`
(`client/src/ui/exportAssembly.test.ts:8,445`, `docs/adr/0231:62`) points at the pre-reducer comment
while the manifest filter is at `:1532-1535`; `:1519-1531`
(`client/src/ui/exportAssembly.test.ts:14,359`) points at the cooldown read while the insert loop is
at `:1556-1567`; `:1092-1094` points nowhere useful since `plan_export_chunks` moved to `:1163`; and
`:1565-1567` (`docs/adr/0231:394`) points above the view, now at `:1604`. Nothing enforces line
citations — the eval surface is declaration-shaped and matches marker STRINGS. Placement was
therefore free, and the pre-gate was placed where the design wants it. The module header
(`privacy.rs:1-44`) is still not edited: it makes no claim this slice falsifies.

**Boundary.** No new table, no `schema.rs` or `lib.rs` change, no bindings regen, no client change;
`accounts.rs` is read, never edited. This ADR uses `**Extends:**` rather than `**Amends:**` because
an `Amends:` would force a reciprocal back-link edit in ADR-0238, outside this slice's touch set.

## Proof of teeth (ADR-0224: ordinary Rust tests, no eval)

Six tests in `server-module/src/privacy_tests.rs`, all executable or source-scanning in the native
host — nothing here reaches the reducer:

- **`rb107_admission_is_exact_at_both_caps_and_saturates`** — a value table over BOTH caps (exact
  fit, one over, top ±1 pairs, requested-dominant rows, and the cross-tier discriminators that kill
  a predicate ignoring its `cap` argument), then `u64::MAX` saturation rows that kill
  `wrapping_add`; anti-vacuity asserts both expectations, both caps and a disagreeing pair before
  the loop.
- **`rb107_caps_are_the_reapers_drain_and_the_manifest_minimum`** — `EXPORT_MIN_BUNDLE_ROWS` = 17
  from two independent sources, the D1 drain inequality asserted before the cap clauses (citing
  `[rb86/stamp-cap-throughput]` as the shipped owner rather than restating it), the cap's value AND
  its derivation through the intermediate `ticks == 168`, the anonymous value, its `/2` relation and
  the strict `anon < full` ordering that kills a tiering-removed mutant, the private-visibility
  windows, and the three frozen declaration texts.
- **`rb107_cap_selection_is_tiered_by_account`** — exhaustive over `bool` against both constants
  *and* both literals, so a swapped-arms mutant dies on a value rather than a name, plus the
  ordering and the frozen body.
- **`rb107_admission_seams_are_pure_and_frozen`** — the predicate declared exactly once, private,
  free of `ctx` (that clause runs before the body pin: a `ctx` here is a link failure of the whole
  binary and must be attributable), with a frozen signature and a body equality that backstops a
  literal cap, a `<`, a dropped argument and any prefix `return`.
- **`rb107_reducer_admits_twice_before_the_first_write`** — the seam censuses (definitions and call
  sites, file-wide and inside the reducer body), exactly one `let cap` binding, brace depth 0 at
  both gates, the offset ordering purge → `let cap` → pre-gate → manifest walk and `let total` →
  exact gate → insert loop, the reject token counted as exactly 2 over two views that disagree on an
  interior-space respelling, `.count()` counted as exactly 2, the exit shape, and last the two
  two-sided adjacency needles with a positive control and a blindness fixture each. The pre-gate
  control carries the rb-86 one-trailing-comma tolerance (`privacy_tests.rs:16826-16832`) because
  that argument list sits at 59 of rustfmt's 60 columns.
- **`rb107_test_roster_is_closed`** — the rb-87 roster shape: vacuity, duplicate and name checks, a
  closed adjacency walk with its own walker control, and an attributed `#[test]` count against a
  closed helper roster.

Eight existing pins move, every one as an ATTRIBUTION rather than a relaxation:
`[rb85/bundle-census]` 7 → 9 with `[rb85/bundle-scope]`'s `request_data_export` entry 2 → 4 in the
same diff, the `attributed_total == file_wide` equality re-closing the set; the two rb-65 censuses
`[emit/reachable-nested]` and `[emit/nested-is-err]` 1 → 3, both messages naming
`[rb107/exit-shape]` as the shape owner that pins which three nested returns those are (2 admission
rejects spelling the one static reason, 1 fail-loud `return Err(msg)`, zero `return Ok`), so a
widened number never travels alone; `[emit/reachable]` keeps its value of 0 with a retruthed
message; and four prose sites in privacy.rs and privacy_tests.rs whose claims this slice falsifies.
`m22s4 [X9/returns]` = 3, `[X9/reason]`, `[emit/nested-not-ok]` = 0, `[rb85/no-sweep]` = 0,
`[rb85/iter-census]` = 3 and `[rb86/stamp-site]` do not move; rb-107 cites them.

The suite goes 1002 → 1008 (1003 → 1009 with `--features dev_reducers`). The criterion gate is
roster-shaped rather than prefix-shaped — a prefix filter is forgeable by rename-out plus a
same-prefix `#[ignore]` stub — and it carries `rb22p_no_bare_quote_in_privacy` alongside the six,
because that raw-text census is now load-bearing for the entire pin surface: a bare quote in a
comment blanks spans and would defeat every squashed clause.

RED-before is recorded at `memory/projects/gates/rb-107.red-before.md`. Stage 1 (pristine
production code, the six tests plus the eight pin revisions, the four symbol-naming tests
`#[cfg(any())]`-stripped): 1004 tests run, 3 failed, each on the clause the tester predicted —
`[rb107/seam-counts]` reading zero definitions of the admission seam, `[emit/reachable-nested]` at
1 ≠ 3, `[rb85/bundle-census]` at 7 ≠ 9. Stage 2 (unstripped, still pristine): build failure,
`error[E0425]` ×9 over exactly the predicted symbol set.

The mutant register is `memory/projects/gates/rb-107.mutants.py` with its manual run written up in
`memory/projects/gates/rb-107.x7-register.md`; both are cited from the acceptance ledger
`memory/projects/gates/rb-107.gates.md` (X7 the manual live register on the real privacy.rs, X8 an
automated four-row subset at merge across four tests and four mutant families, reporting row ids as
well as labels). See the register for row counts and verdicts.
