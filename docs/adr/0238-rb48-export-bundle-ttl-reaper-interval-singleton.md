# 0238 — PRV1-14 export TTL reaper: an hourly interval singleton in privacy.rs, armed by request_data_export and by init/sync_content, deleting through the pure plan_export_reap seam

**Status:** Accepted
**Date:** 2026-09-05
**Slice:** rb-48 (residual R-m22-s4-X17, M-residual-backlog.spec.md#rb-48)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0226 (discharges its S4b deferral), ADR-0221 (frozen-table one-publish ritual)
**Subsystems:** schema-persistence, security-authz
**Decision:** PRV1-14 ships in privacy.rs: an hourly interval singleton arms a scheduler-only export_bundle_reaper deleting export_bundle chunks past a 7-day TTL via the pure plan_export_reap seam; armed by request_data_export and by init/sync_content.

---

## Context and problem statement

ADR-0226 (m22-s4) shipped `request_data_export` and `my_export_bundle` but deferred the PRV1-14 TTL
reaper to "S4b" (ADR-0226 D9), citing the frozen-table ritual: a `scheduled(...)` table's
scheduled-ness is automigration-frozen (ADR-0221), so a `scheduled` table cannot be published
table-first with its reducer added later — the table and its reducer must land in the same publish.
S4's declared touch set (privacy.rs alone) could not absorb the resulting schema.rs manifest
entry, `evals/baselines/table-schemas.json`, and `battle-schema-snapshot` T-VIS-ANCHORS edits, so
the reaper was parked.

Two forcing constraints shaped this slice's design, both measured before planning:

- **G5/D0 write isolation forces the reaper into privacy.rs.** `export_bundle` writes are
  module-isolated there (`rb22_purge_naming_budget`, `rb22p_writes_only_export_bundle`); a new
  module file would trip the `mod` census and `m22_scanned_sources`. There is no alternative
  location.
- **The native fixture's limits force a functional-core/imperative-shell split.**
  `native_host_tests.rs` leaves `.iter()`, every write, and the `identity()` host syscall
  unmodelled, so a native `#[test]` cannot execute a scheduled reducer's admitted direction — the
  same split already used for `playtest_reaper`/`plan_reap`. The behavioural proof has to live in a
  pure seam; the shell is proven only by source pins.

## Decision

**D1 — Placement: end of file, zero citation drift.** The new section (constants → schedule table
→ `plan_export_reap` → `export_bundle_reaper` → `ensure_export_bundle_reaper`) is appended at the
end of privacy.rs, immediately before the frozen `#[cfg(test)] #[path = "privacy_tests.rs"] mod
privacy_tests;` trailer. The plan's original insertion point (after `:81`) would have drifted
~13 line-range citations, including two gating ones in `accounts_tests.rs`, plus citations in
`client/src/ui/exportAssembly.test.ts`, `client/src/ui/privacyModel.test.ts`, and
`docs/adr/0231-*.md` (reviewer finding M2). End-of-file placement avoids all of them.

**D2 — Global interval singleton; `NotOwned`; no Identity column; no REKEY entry.**
`ExportBundleReaperSchedule { id: u64 #[primary_key] #[auto_inc], scheduled_at: ScheduleAt }`,
accessor `export_bundle_reaper_schedule`, `scheduled(export_bundle_reaper)`, PRIVATE — the same
idiom already shipped twice (`playtest.rs`, `observability.rs:132-149`). No Identity column ⇒
`NotOwned` in the data-lifecycle manifest ⇒ no `REKEY_MANIFEST` entry (G6 keys on Identity columns
only) and no `[DEL-*]` cascade obligation (`m22s3b_cascade_covers_manifest` skips `NotOwned`).

**D3 — The frozen reaper body, via a pure seam that sorts internally, saturates age, caps at 256
per tick, on an hourly interval, against a 7-day TTL constant.**
`plan_export_reap(rows: &[(u64, i64)], now_ms: i64, ttl_ms: i64, batch: usize) -> Vec<u64>` collects
expired ids (`now_ms.saturating_sub(created) >= ttl_ms`), **sorts internally**, then truncates to
`batch`; the shell contains no sort statement, closing a hole the red-team measured (finding 12) and
the reviewer confirmed (M7): without an internal sort, "oldest-id-first" and "input order preserved"
only agree if the caller happens to pass sorted input. `EXPORT_REAP_MAX_DELETE_PER_TICK = 256`, not
the `playtest.rs`-analogous 8192: `export_bundle` rows carry `payload_json` chunks, not 40-byte
scalars, and reducers serialize under one global write lock — an oversized batch could exceed the
transaction budget and abort every tick, retrying forever (strictly worse than no reaper; red-team
finding 10). 256/hour is ~6.1k rows/day — at the ≥17 chunks every bundle carries (one per exportable table,
empty tables included) that is roughly 360 bundles/day, a DRAIN RATE rather than a ceiling: a burst
above it (a launch cohort exporting inside one window, or a sybil wave) drains over successive
ticks, during which the excess chunks persist past the TTL and a bundle can sit half-deleted for up
to an hour (residuals R-rb-48-PARTIALREAP and R-rb-48-SCANCOST).
`EXPORT_REAP_INTERVAL = Duration::from_secs(3600)` (hourly, not the sibling's 5 minutes): 168× finer
than the TTL, and 12× fewer unindexed full-table scans than a 5-minute interval (reviewer finding
m5). `EXPORT_BUNDLE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000` (604_800_000), declared in privacy.rs per
the `EXPORT_REQUEST_COOLDOWN_MS` precedent (game-core is out of touches).

**D4 — Arming from BOTH `request_data_export` AND `init`/`sync_content`.**
`request_data_export` calls `ensure_export_bundle_reaper(ctx);` as its last statement before
`Ok(())`, inside the same transaction as the chunk writes — invariant "a chunk exists ⇒ the
singleton is armed" — and the zero-chunk case is structurally unreachable: `plan_export_chunks`
emits at least one chunk even for an empty table across all 17 exportable tables, so
`plan.len() >= 17` whenever control reaches `Ok(())`. Additionally, `lib.rs`'s `init` and
`sync_content` each call `crate::privacy::ensure_export_bundle_reaper(ctx);` right after
`ensure_deletion_reapers_armed(ctx);`. Every other singleton reaper in the crate (zone schedules,
the playtest reaper, the mr heartbeat, the deletion reapers) is already publish-repaired this way
(reviewer finding M5); arming this one only from `request_data_export` would make it the crate's
sole singleton reaper NOT repaired by a publish, and would falsify the operator-facing runbook
promise that "publishing the module runs that sweep." `ensure_export_bundle_reaper` is therefore
`pub(crate)`, not private, and `server-module/src/lib.rs` (+2 lines) is a disclosed hidden
dependency.

**D5 — Scheduler guard first, with the prefix-free `stringify!` token.** The reducer's first
statement is `if ctx.sender() != ctx.database_identity() { return Err(stringify!(export_reaper_scheduler_only).to_string()); }`
— no bare string literal (`rb22p_no_bare_quote_in_privacy` bans every `"` byte in privacy.rs beyond
one `#[path]` literal). The reject token is `export_reaper_scheduler_only`, deliberately not
`export_bundle_reaper_scheduler_only`, which would contain the table accessor
`export_bundle_reaper_schedule` as a prefix and poison a bare-token census.

**D6 — No observation emitted (residual R-rb-48-OBS).** privacy.rs's own header contract bans
logging in this module, and the crate's doctrine puts the observation in the calling module — there
is no other module here to carry it.

**D7 — Six pin revisions, each an attribution, never a relaxation.**
`rb22p_owner_scoped_filter_never_iter` (count 1 file-wide, 1 inside the reaper body, purge body
untouched); `rb22p_writes_only_export_bundle` (closed two-name set `{export_bundle,
export_bundle_reaper_schedule}`, exact arithmetic 3/2/5, scoped to the arming function);
`m22s4_no_exportable_false_table_is_named` (a second named exempt with a stated reason; the schedule
accessor named exactly 3× file-wide, all inside `ensure_export_bundle_reaper`; floor ratcheted to
`>= 22`); `m22s4_reducer_signature_exact` (attribute count 1→2, both adjacencies, exhaustiveness over
every occurrence, plus a paren-tolerant `#[spacetimedb::reducer` count that also catches a
bracket-less third reducer); `m22s4_now_bound_once` (`now_ms(` count 2 file-wide, 1 per reducer
body); `m22s4_reducer_statement_order` (an addition — measured green today — gaining the arm-call
count/depth/order clauses). A seventh test, `m22s4_sender_bound_once_and_sole_identity_source`,
changed only its `[X9/dispatch-args]` failure message (four → five context-passing calls); no
assertion or floor moved, so that is prose retruth, not a pin revision.

**D8 — Byte-exact body, row-literal, and arg-list pins, plus a file-wide single-`#[cfg` clause.**
The reaper body is pinned by squashed EQUALITY, not containment: this module already measured
(`privacy_tests.rs:458-469`) that containment was insufficient for the strictly simpler
`purge_export_bundles` body (a dead `if false` branch, a shadowed empty `Vec`, an in-loop zeroed id,
and an aliased write all passed clippy-clean and green), and the red-team's hostile-mutant battery
against an unpinned arg list confirmed the same failure mode here: a wrong TTL/batch/now argument,
a transposed now/ttl pair, a sweep that reads every row as fresh forever, and a literal-keyed
`.chunk_id().delete(0)` (a shape measured 767/767 green elsewhere on an `#[auto_inc]` PK) all passed
containment-only clauses. The arm's row literal (`ExportBundleReaperSchedule { id: 0, scheduled_at:
ScheduleAt::Interval(EXPORT_REAP_INTERVAL.into()) }`) is pinned by the same equality discipline: an
unpinned interval expression is green under a 24-hour-cadence rewrite or a one-shot `ScheduleAt::Time`
swap. Separately, privacy.rs is pinned to exactly one `#[cfg` occurrence file-wide (the
`#[cfg(test)] #[path = ...]` trailer): the red-team measured that `#[cfg(not(target_arch =
"wasm32"))]` on the arm call ships an unarmed reaper that beats `-D warnings` on the host build and
is invisible to CI — `just ci`'s `wasm` recipe builds client-wasm only, and the module's own wasm32
build inside `spacetime generate` (bindings-drift) treats the dead arm as a warning, not an error — so lint,
every Rust test, and every eval stay green while the shipped module never arms. The artifact red-team then
measured the same family against `lib.rs`, where round 1 only counted the two arm calls: a `#[cfg]` on
either call, the `sync_content` call relocated into the dead zero-owner early-return branch or wrapped in
`if false {}`, and a decoy dead-code `fn init` stealing the first-hit scope all survived; and an
`as now_ms` alias onto a microsecond helper in `marshal.rs` left every frozen body byte-identical while
the TTL's unit silently became ~10 minutes. Round 2 closes them in the existing tests:
`rb48_arm_wired_from_init_and_sync_content` pins each arm call by ADJACENCY to the
`ensure_deletion_reapers_armed(ctx);` statement before it, requires `#[cfg`- and `cfg!(`-free bodies, a
`sync_content` tail of `…ensure_export_bundle_reaper(ctx);Ok(())`, exactly one `fn init(`/`fn
sync_content(` each and the `#[spacetimedb::reducer(init)]` attribute welded to `pub fn init(`; and
`m22s4_now_bound_once` pins the import `use crate::marshal::now_ms;` exactly once and bans `as now_ms`.

**D9 — Runbook §9.4 retruth and G24 needle retarget, as a roster retarget on an existing clause.**
`evals/account-e2e.eval.mjs`'s `checkDrRunbookDeletionSection` (G24 clause 4) requires the
runbook's §9 body to contain the literals `'no independent TTL'` and `'S4b'` — shipping the reaper
makes the runbook's current sentence ("There is no independent TTL. The PRV1-14 expiry reaper is
deferred to S4b") false and operator-facing, and the gate as shipped pins that falsehood. The
plan's first-choice retarget target (`'export_bundle_reaper'`) was rejected (reviewer finding M1):
it contains `export_bundle` as a substring, which would silently stop the `DOC_4_BOTH_NAMES`
fixture from biting (that fixture exists to prove BOTH `export_bundle` and `my_export_bundle` are
absent). The needles land instead on `'no independent TTL'` → `'7-day TTL'` (distinct from clause
2's `'7 days'`) and `'S4b'` → `'ADR-0238'`, both prefix-free against every existing needle; every
BAD fixture keeps its one-needle-deleted shape. This is a literal swap on an existing gate clause,
never a new `evals/*.eval.mjs` file and never a new clause added to an existing one — the two forms
ADR-0224 bans. Clause 5's `DELETION_CITATIONS` roster gains two declaration-shaped rows
(`pub fn export_bundle_reaper(`, `pub(crate) const EXPORT_BUNDLE_TTL_MS`) so the retruthed §9.4
cannot outlive the code it describes (red-team M-G4) — a roster row on an existing clause, not a
new clause.

## Rejected alternatives

- **Per-request one-shot expiry.** Needs an Identity column, which forces a `REKEY_MANIFEST` entry
  in an out-of-touches eval; the arm would sit inside the byte/statement-frozen
  `request_data_export` body; and it structurally cannot reach pre-slice legacy chunks.
- **A `created_at_ms` btree index + range filter.** Pushes the expiry decision into the database
  where no native test can observe it — the pure `plan_export_reap` seam is the point of the proof.
- **Reusing `playtest::plan_reap` with an unbounded population cap.** Behaviourally identical for
  `cap = u64::MAX`, but its fifth parameter deletes FRESH rows whenever the population exceeds the
  cap — a live footgun on personal-data chunks if that magic value is ever mis-set — and the export
  policy would become a caller of a five-parameter seam shaped for a different table. Two 15-line
  pure functions with different policy shapes is the cheaper, clearer arrangement.
- **Self-arm-only arming (arm from `request_data_export` alone; the original plan).** Rejected per
  reviewer M5: it would make this the crate's sole singleton reaper not repaired by a publish,
  falsify the runbook's "publishing the module runs that sweep" promise, and ship
  `ensure_export_bundle_reaper` private with a "not preceded by `pub`" pin that a later fix to close
  the gap would have to revise — exactly the pin-revision pattern D7 exists to avoid repeating.
- **`lib.rs`-only arming.** No export-triggering event exists in `lib.rs`'s own scope to bind the
  invariant "a chunk exists ⇒ armed" to; the arm must sit beside the writer.
- **A native end-to-end test.** `native_host_tests.rs` leaves `.iter()`, every write, and the
  `identity()` host syscall unmodelled, so no native `#[test]` can execute a scheduled reducer's
  admitted direction; proof is pure-seam plus source pins, as for `playtest_reaper`/`plan_reap`.
- **Parking the runbook/G24 conflict as a residual.** G24 clause 4 as shipped positively requires
  the false statement, so parking would ship a gate that enforces an operator-facing lie — the
  paired-pins-force-a-bug shape; retargeting in-slice is the minimum edit consistent with
  ADR-0224's ban on new or patched eval files.

## Consequences

- The data-lifecycle manifest grows to 41 entries (13 ERASE + 4 ANONYMIZE + 5 JOIN-ONLY + 19
  NOT-OWNED, up from 40/18 NOT-OWNED).
- Disclosed hidden dependencies, outside the slice's originally declared touches:
  `evals/battle-schema-snapshot.eval.mjs` (T-VIS-ANCHORS private-table count 22→23 and the
  `pinnedPrivateTables` roster); `evals/account-e2e.eval.mjs` (`M22S9_MANIFEST_TRANSCRIPTION` +1
  entry, the 40→41 census literals including `mkFix`'s loop bound, the G24 clause 4 needle
  retarget, and two clause-5 `DELETION_CITATIONS` roster rows); `client/src/module_bindings/types.ts` (`spacetime generate` emits
  `ExportBundleReaperSchedule`'s row type even though the table is private — row types are emitted
  for private tables too); `docs/observability-dr-runbook.md` (§9.4 retruth); and
  `server-module/src/lib.rs` (+2 lines, per D4).
- The hourly, unindexed `export_bundle().iter()` scan runs in perpetuity under the crate's single
  global write lock — the same lock privacy.rs already cites as the reason `request_data_export`
  has a cooldown.
- Legacy chunks (any predating this slice) are swept at the first reaper tick after the singleton
  is armed; because `init` arms it on database creation and `sync_content` arms it when the owner runs the post-publish sync, that is the first tick after that sync, not
  the first tick after some account's next export.
- `docs/adr/0226-*.md` gains an `Extended-by: ADR-0238` back-link. `Extends:`/`Extended-by:` are
  unmodelled by `adr-digest` (no reciprocity gate), so this is convention-only, not gate-enforced.

## Residuals

- **R-rb-48-OBS.** No observation is emitted on a reaper tick (D6). privacy.rs's own contract bans
  logging in this module and no other module owns this reducer's calling context. This is the
  amplifier for the two residuals below: a reaper stuck in an abort loop or working a week-long
  backlog is invisible to operators.
- **R-rb-48-SCANCOST.** The hourly `export_bundle().iter()` scan is unindexed and full-table, and it
  materialises every row INCLUDING `payload_json` to read two scalar columns — so the cost driver is
  total payload bytes, not row count, and it is inflatable for free: `join_game` needs no JWT, so
  unlimited anonymous identities can each call `request_data_export` and write ≥17 chunks. If the
  scan ever exceeds the transaction budget the reaper aborts every tick, silently disabling a
  retention control. Remediation: `#[index(btree)]` on `ExportBundle.created_at_ms` plus a bounded
  range read, or at minimum an operator alarm on `export_bundle` row count / bytes.
- **R-rb-48-PARTIALREAP.** The 256-per-tick cap is global across owners, so when the expiring set
  exceeds it a bundle can be deleted k-of-N and stay split for up to an hour; the client assembler
  (`client/src/ui/exportAssembly.ts`) reports such a bundle as `incomplete`, a wait state that only
  resolves at the next tick. Unreachable today (no client subscribes to `my_export_bundle` yet).
  Follow-up: when a tick returns exactly the cap, arm a one-shot `ScheduleAt::Time` follow-up to
  drain immediately, or reap per request atomically; either reshapes the frozen reaper body and
  re-pins it.
- **R-rb-48-SLOCLASS.** `ops/observability/rules/recording.rules.yml` lists three scheduled
  functions as deliberately excluded from the SLO allowlist so the exclusion is auditable;
  `export_bundle_reaper` is in neither list (nor is rb-24's `account_deletion_reaper`). Outside this
  slice's touches; classify both in a follow-up.
- **R-rb-48-G24NEG.** G24 clause 4 and the ledger X3 pin are substring checks: a §9.4 rewording that
  keeps the positive sentence and every needle but explicitly negates it passes both (measured,
  red-team M-G5). Not closable by substring matching; it is a reviewer-checklist obligation on
  runbook §9 edits. The structural half IS closed by the D9 roster rows.

## Confirmation

`server-module/src/privacy_tests.rs` (`rb48_*` tests plus the revised `rb22p_*`/`m22s4_*` pins),
`server-module/src/accounts_tests.rs` (manifest rosters), `evals/battle-schema-snapshot.eval.mjs`
(T-VIS-ANCHORS + baseline), `evals/account-e2e.eval.mjs` (transcription + G24 clause 4), the
acceptance ledger `memory/projects/gates/rb-48.gates.md` (harness), `just ci`.
