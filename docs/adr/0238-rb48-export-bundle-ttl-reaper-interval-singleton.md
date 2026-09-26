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
only agree if the caller happens to pass sorted input. `EXPORT_REAP_MAX_READ_PER_TICK = 256`, not
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
- `docs/adr/0226-*.md` gains an `Extended-by: ADR-0238` back-link. When this ADR was written,
  `Extends:`/`Extended-by:` were unmodelled by `adr-digest` and the pairing was convention-only.
  **Since rb-70 that is no longer true of this edge.** `adr-digest` now dangling-checks both fields
  and enforces REVERSE reciprocity corpus-wide: an `**Extended-by:** ADR-X` obliges ADR-X to carry
  the matching `**Extends:**`. This 0226/0238 pair is one of the six edges rb-70 freezes, and the
  two legs are caught by different gates: deleting **this ADR's** `**Extends:** ADR-0226` fails
  `just adr-digest-check` (the reciprocity rule), while deleting **ADR-0226's** `**Extended-by:**
  ADR-0238` is invisible to that gate — the reverse rule's premise goes with it — and is caught
  instead by the frozen roster in `scripts/adr-digest.test.mjs` (X8), i.e. by `just test`. What
  remains convention-only is the
  FORWARD direction — writing `**Extends:** ADR-NNNN` still obliges nobody to add the back-link
  (rb-70 deferred that as `wontfix`; see the `## Amendment (rb-70)` section of ADR-0104).

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

## Amendment (2026-09-13, rb-84 — residual R-rb-48-SLOCLASS closed)

The "R-rb-48-SLOCLASS" bullet under Residuals above is discharged by rb-84, which was assigned no
ADR number; the classification and its rationale are recorded in the artifact itself, the rb-66
precedent (`ops/observability/rules/recording.rules.yml`, mr-scheduler provenance item (5)). Both
reapers are now EXPLICITLY EXCLUDED from the scheduled-function lateness allowlist:
`export_bundle_reaper` (this ADR's hourly interval singleton) and rb-24's `account_deletion_reaper`
(ADR-0221's one-shot, armed at delete time for the end of the days-long deletion grace) are the same
long-horizon class as the already-excluded `guest_claim_reaper` — a start delayed by minutes is
invisible on an hourly or multi-day cadence — and the instrument the allowlist feeds,
`spacetime_scheduled_function_delay_seconds_bucket`, measures scheduler dispatch delay only, so the
exclusion forfeits no observability of whether a bundle or an account was actually reaped (that gap
is R-rb-48-OBS, promoted as rb-87). Allowlisting was also out of reach: the eval G13a pin
(`evals/observability-stack-config.eval.mjs` `SCHEDULED_FN_NAMES`) is outside rb-84's touches. The
exclusion prose became a machine-readable bullet block, and one ordinary Rust test
(`server-module/src/observability_tests.rs`,
`rb84_every_scheduled_function_is_classified_in_recording_rules`) derives the module's
scheduled-function roster from its `scheduled(...)` table attributes and asserts every name appears
in exactly one of the two lists, so a tenth scheduled function fails CI until it is classified
there.

## Amendment (2026-09-13, rb-85 — residual R-rb-48-SCANCOST closed)

The "R-rb-48-SCANCOST" bullet under Residuals above (the paragraph beginning "The hourly
`export_bundle().iter()` scan is unindexed and full-table") is discharged by rb-85, which was assigned no
ADR number; this amendment is its decision record. Three sentences of the body above are SUPERSEDED and
left in place as history: D3's "12× fewer unindexed full-table scans", the Consequences bullet "The hourly,
unindexed `export_bundle().iter()` scan runs in perpetuity under the crate's single global write lock",
and the Rejected alternative "A `created_at_ms` btree index + range filter … pushes the expiry decision
into the database where no native test can observe it". That rejection is REVERSED, and the reason it
was given no longer holds: the expiry decision did not move. `plan_export_reap` stays the SSOT expiry
predicate over the PRE-FILTERED rows, and the index range is an optimisation constrained to be a
superset of the seam's expired set — proved as a property (`rb85_cutoff_range_matches_the_seam_expired_set`:
two-sided on the reachable domain `0..=2^53` with the shipped TTL, superset over all of `i64`), so the
pure-seam proof rb-48 valued is untouched. What outweighed it is that the cost was never a tuning matter:
`join_game` needs no JWT, so unlimited anonymous identities can each write ≥17 chunks, the scan
materialised every `payload_json` under the global write lock, and its failure mode was a retention
control silently disabled every tick.

**Decision.** `ExportBundle.created_at_ms` carries a FIELD-level `#[index(btree)]` (schema.rs) — adding an
index is an always-allowed automigration; the table is private, so `spacetime generate` emits no
bindings change and `evals/baselines/table-schemas.json` (pk/visibility/columns/order only) does not move;
the attribute is field-level and not a table-level `index(...)` argument because the out-of-touches
account-e2e citation marker `accessor = export_bundle)` must stay byte-identical. `export_bundle_reaper`'s
body is re-frozen to guard → `reap_expired_export_bundles(ctx, now_ms(ctx));` → `Ok(())`. Two PRIVATE fns
(plain `fn`, compiler-enforced unreachability from every other module; the descendant test module reaches
them as `crate::privacy::…`) sit between the reducer and the arm: `export_reap_cutoff_ms(now_ms, ttl_ms) =
now_ms.saturating_sub(ttl_ms)` — pure and one line so it has a return-value oracle AND a body-equality pin
(a band-keyed cutoff that returns the clock inside the live wall-clock band was MEASURED to re-open the
full read with every value table and text pin green); and `reap_expired_export_bundles(ctx, now_ms) ->
usize`, which reads `ctx.db.export_bundle().created_at_ms().filter(..=cutoff).take(EXPORT_REAP_MAX_DELETE_PER_TICK)` [rb-110: this constant is now `EXPORT_REAP_MAX_READ_PER_TICK` — ADR-0267]
— the FIRST range-terminated index read in the crate — runs the seam over those rows, deletes by primary
key, and REPORTS its count (rb-40 idiom; consumers: the deferred native execution test and rb-86's
one-shot drain). The read bound equals the delete cap, so a tick decodes at most 256 rows however large
the table grows (the host may fill at most one further iterator buffer beyond the last decoded row); the
seam's own `truncate(batch)` can no longer bind and is kept as defence in depth. `now_ms` is a PARAMETER
(a trust input) so the reducer stays the single clock reader (`m22s4_now_bound_once` is byte-identical)
and a future native test can inject its instant below the guard; the parameter deliberately shadows the
imported fn, which makes an in-helper clock read a compile error.

**What this changes and does not change.** The bound is on ROWS, not bytes: a sybil still costs
256 × max chunk bytes per tick (≈25 MB in the pathological `EXPORT_CHUNK_ROWS` = 500 case, ≈25 KB for
empty anonymous exports) — reduced, not eliminated. Selection shifts from "lowest ids among all expired"
to "oldest `created_at_ms` among expired, then id"; `chunk_id` is `#[auto_inc]` and every chunk of one
request shares its stamp, so the orders agree except inside a same-millisecond tie group; progress never
depends on order (every row taken is deleted), only fairness does, and fairness now rests on the btree
range's ascending key order — btree-backed and therefore expected, but neither a documented SDK contract
nor something this slice observed (the execution proof is deferred, below). Storage growth is NOT
closed: unlimited anonymous identities × one 17-chunk bundle each outgrows the unchanged 256/h drain
(≈361 bundles/day); the failure mode becomes "bounded drain with unbounded storage growth", which is the
condition the operator alarm must watch. Removing the index is NOT compile-coupled: an extension trait
providing `created_at_ms()` over a full sweep compiles clippy-clean with the helper body byte-identical, so
the index pin in privacy_tests.rs is what keeps it. The generated `created_at_ms()` accessor is a new
crate-wide time-ordered read over every owner's chunks; it is census-guarded (seven sanctioned
`ctx.db.export_bundle()` uses, all in privacy.rs, attributed body by body; a RAW-text, call-or-path-aware,
per-file ratchet asserts no other module spells the accessor call, a `::export_bundle` path to it, or the
generated handle type — a comment-split call and a fn-item binding through that path were each measured
green under a contiguous needle. A second artifact-lens pass then measured a brace-list trait import plus a
`macro_rules!` splice of the accessor name into a receiver position sweeping the table from movement.rs under
that rule; closed by a brace-list-aware path rule, a crate-wide ban on a metavariable in method or path
position, a ban on glob-importing the schema module from production files, and no-macro / no-re-export pins
on privacy.rs itself. A bounded re-probe of those closures then measured a production module placed OUTSIDE
`src/` through a `#[path = "../…"]` declaration (the walk never reads it) — closed by a path-escape ban (no `..`
or leading `/` in any `#[path]` literal) and an `include!` ban over every file, which is what makes the `src/`
walk a complete account of the crate's modules. The disclosed remaining limit is a proc-macro splice, which needs
a new dependency — a Cargo.toml diff and an ADR, a reviewed event).

**Proof of teeth (ADR-0224: ordinary Rust tests, no eval).** Ten `rb85_` tests in privacy_tests.rs: the
cutoff value table (with a realistic wall-clock row), the proptest above, body-equality pins on the cutoff,
the helper (with its one-comma rustfmt twin), `plan_export_reap` and `marshal::now_ms` (the last two closed
MEASURED band-keyed bypasses one level outside the frozen bodies: a seam predicate gated to the live band
and a clock returning seconds inside it both passed the whole suite), the field-level index adjacency pin,
private seams declared once with frozen signatures, the zero-sweep census with the range chain attributed
to the helper and the receiver-agnostic `.iter()` arithmetic (a full sweep through the constructible
`export_bundle__TableHandle` ZST behind an extension trait was measured green until the handle-type ban
landed), the crate-wide ratchet, the helper-never-named-outside-privacy.rs clause, a value table for
`marshal::now_ms` (the crate's first), and a closed roster with an attribute-AWARE walker plus a declaration
total pinned to the ten tests and a closed helper roster (an eleventh test behind a multi-line attribute was
measured to run unseen by a line-prefix walker), and the test file itself pinned macro-free with no file-level
module or `#[path =` declarations (a `macro_rules!`-synthesized eleventh test was measured to run with the roster
green). Pin revisions:
`rb22p_owner_scoped_filter_never_iter`'s file-wide sweep census 1 → 0 (a tightening that restores rb-22's
original ban; its two per-body clauses were provably unreachable at zero and were deleted),
`rb48_reaper_body_exact` re-frozen with its twin deleted (accepted set 2 → 1), prose-only retruths
elsewhere. RED-before: 949 run / 941 passed / 8 failed on the predicted clauses with the cutoff-calling
tests cfg-stripped, then a build failure (E0425 ×5) with all ten enabled; GREEN: 951 run (942 + 10 with
`dev_reducers`). Register (harness `memory/projects/gates/rb-85.mutants.py`, 37 rows, run 2026-09-18 on the
final tree, runner exit 0): 32 mutants killed on their designated clause — including the eight lens-measured
survivors closed on the resume: the band-keyed clock (band opening one second past T10's sampled row, so only
the body pin sees it), the band-keyed seam, the comment-split call and the fn-item path from observability.rs,
the brace-list import plus macro splice from movement.rs, the multi-line-attribute eleventh test, the
`#[path]`-escaped module outside src/, and the macro-synthesized eleventh test — two INVALID by mechanism (bare index removal →
E0599; a test calling the helper → `rust-lld: undefined symbol: datastore_index_scan_range_bsatn`, the whole
lib-test binary), three controls green; evidence `memory/projects/gates/rb-85.x7-register.md`.

**Rejected here.** `RangedIndex::delete(..=cutoff)` — deletes by range without materialising a row, but
is uncapped and drops `plan_export_reap` as SSOT. A per-request one-shot, `playtest::plan_reap` reuse, and a
native end-to-end test remain rejected for the reasons above. Widening the helper to `pub(crate)` — an
unguarded delete path with a caller-supplied clock would then be reachable from any module.

**Deferred (ledger gates/rb-85.gates.md).** X9 → backlog: the oversized-population EXECUTION proof needs
`server-module/src/native_host_tests.rs` (outside rb-85's touches) to model `datastore_index_scan_range_bsatn`
over its row store in key order and `datastore_delete_by_index_scan_point_bsatn`; today a test reaching
the helper fails the whole lib-test binary at link time, and `ReducerContext::__dummy()` cannot pass
`ctx.database_identity()`; the helper's `(ctx, now_ms) -> usize` shape is built for that test, and
`rb85_helper_is_never_named_outside_privacy_rs` must be re-attributed 0 → 1 by that slice. X10 → rb-87: the
operator alarm on `export_bundle` row/byte counts (ops/observability, outside touches).

**Disclosed.** Hidden dependency found at planning and APPLIED on the 2026-09-17 resume, once the
supervisor added the file to `touches:`: `server-module/src/accounts_tests.rs:4491-4517`
(`export_bundle_struct_shape_and_privacy`) pins the ExportBundle field span by squashed equality and
redded on the new attribute; the widening is one `"#[index(btree)]",` fragment before
`"pubcreated_at_ms:i64,"` plus one `Kills:` line (numstat 2 added, 0 deleted). The plan's three "prose
citations that drift by one line" (:11230, :11343, :11504, and a fourth at :12789) were already stale on
master before rb-85 — rb-73's `player_session` insertion had moved those schema.rs lines — so they are
left as history rather than chased. Also stale and left: ADR-0220:15,31 (`schema.rs:1073-1079`, now
thirteen lines lower — the ExportBundle doc block grew, not just the attribute line). `docs/knowledge/**`
stamps regenerated. Residual candidates: R-rb-85-EXPORTADMIT (no global admission control on
`request_data_export`; the write side of the sybil vector), and a correction to rb-86's deferral premise —
"no client subscribes to `my_export_bundle`" has been false since rb-53 (`client/src/net/connection.ts:653`),
so the k-of-N tear is client-observable today.

## Amendment (2026-09-18, rb-86 — residual R-rb-48-PARTIALREAP closed)

The "R-rb-48-PARTIALREAP" bullet under Residuals above is discharged by rb-86, which was assigned no
usable ADR number (the supervisor-reserved 0251 had already been taken by rb-81 when the slice ran — the
same reservation race ADR-0225 hit — so, per the rb-84/rb-85 precedent, this dated amendment is the
decision record). Two facts in that bullet were already false when the slice started and are corrected
here: the tear has been CLIENT-OBSERVABLE since rb-53 (`client/src/net/connection.ts` subscribes
`my_export_bundle`; `client/src/ui/exportAssembly.ts` reports a bundle with a missing chunk index as
`incomplete`, a wait state that could only resolve at the next hourly tick), and the "one-shot
`ScheduleAt::Time` drain" follow-up the bullet proposed is not a fix at all — see Rejected below.

**The defect, precisely.** Every chunk of one `request_data_export` call carries the reducer's single `now`
as both `request_id` and `created_at_ms`, so a BUNDLE is the set of chunks sharing one creation stamp — and
that is also the client's own notion of a bundle (`exportAssembly.ts` groups by `request_id`). rb-85's
helper deleted the first 256 EXPIRED CHUNKS by primary key, so a tick could commit k of a bundle's N
chunks deleted and leave the rest for an hour.

**Decision: reap per BUNDLE, atomically, keyed on the creation stamp.** Three sentences of the rb-85
amendment above are SUPERSEDED and left in place as history: "deletes by primary key, and REPORTS its
count (… consumers: the deferred native execution test and rb-86's one-shot drain)", "The read bound
equals the delete cap", and "outgrows the unchanged 256/h drain (≈361 bundles/day)". What ships:

- A new PRIVATE pure seam, `plan_export_reap_stamps(rows: &[(u64, i64)], now_ms, ttl_ms, max_stamps)
  -> Vec<i64>`, directly below `plan_export_reap`: it runs `plan_export_reap` — still the SSOT expiry
  predicate — over the WHOLE window (`rows.len()`, not a row cap: the read is already bounded), keeps only
  the creation stamps of the ids the seam plans, makes them distinct, sorts them oldest first regardless
  of the window's order, and truncates to `max_stamps`. Every stamp it returns is at or below the cutoff,
  i.e. expired.
- `reap_expired_export_bundles(ctx, now_ms) -> usize` keeps rb-85's bounded range read byte-for-byte as
  the WINDOW (`.created_at_ms().filter(..=cutoff).take(EXPORT_REAP_MAX_READ_PER_TICK)`, ≤ 256 decoded
  rows) and then, for each planned stamp, issues ONE
  `ctx.db.export_bundle().created_at_ms().delete(stamp)` — a `RangedIndex::delete` with a point key on
  the btree index rb-85 added, which the SDK routes to `datastore_delete_by_index_scan_point_bsatn`: every
  row carrying that stamp is deleted in the same transaction, window rows and tail alike, and NOTHING is
  decoded. It returns the datastore's own row count (`u64`, cast to the frozen `usize` signature). This is
  this MODULE's first `RangedIndex::delete` on a non-unique index (the crate's precedent is rb-73's
  `erase_player_sessions` in lib.rs, `player_session().identity().delete(owner)`) — every other
  `.<column>().delete(x)` site in privacy.rs sits on a `#[primary_key]` column and is
  `UniqueColumn::delete -> bool` — and the chain text is indistinguishable from the unique form, which is
  why privacy_tests.rs pins the delete's ARGUMENT by equality (`stamp`, a point: a range there would be an
  uncapped delete).
- A new constant `EXPORT_REAP_MAX_STAMPS_PER_TICK: usize = 16` — the tick's WRITE bound, counted in
  creation STAMPS: one stamp is one request's bundle, or every bundle committed inside that same
  millisecond (see Bounds). The row cap `EXPORT_REAP_MAX_READ_PER_TICK` [rb-110 renamed it from `EXPORT_REAP_MAX_DELETE_PER_TICK`
  (ADR-0267; residual R-rb-86-READCAP-NAME closed) — see the amendment below] is now the READ window
  only, and its doc comment says so. Sixteen minimum-size bundles (17 chunks each, one per exportable
  table, empty tables included) is 272 rows — the drain rate of the 256-row cap it replaces (≈384
  bundles/day, was ≈361) — and a 256-row window in ascending stamp order holds at most fifteen whole
  bundles and one straddler anyway, so the cap binds only when the window's order is not what the btree
  is expected to give.
- The reducer shell (guard → helper → `Ok(())`), `plan_export_reap`, `export_reap_cutoff_ms`,
  `purge_export_bundles`, `request_data_export`, the arm, schema.rs and the client are unchanged.

**Why the stamp and not the owner.** An owner-keyed whole-bundle delete (`owner_identity().delete(owner)`)
was the planned shape and was rejected at plan review: it is atomic only while one owner holds at most one
bundle, and if a future slice ever breaks that (a guest-claim RE-KEY instead of a purge, say) it deletes
the owner's FRESH, unexpired export — silent personal-data loss, strictly worse than the tear it fixes.
The stamp-keyed delete fails safe: every stamp the seam returns is expired under the SSOT predicate, so the
helper can only ever delete expired rows; the only invariant its ATOMICITY needs is one request ⇔ one
stamp — pinned by `m22s4_now_bound_once`'s one-clock-read and `created_at_ms: now,` clauses (the latter
retightened by rb-86 from a prefix match that admitted a per-chunk offset) and, because a `let now = now +
…` shadow, a `zip(now..)` and a closure parameter were each MEASURED to pass those clauses, by an rb-86
test that freezes the export reducer's whole insert-loop write site by adjacency and pins its single `now`
binding — and a break of that invariant degrades to the status-quo k-of-N tear, never to destruction of a
live export. It also keeps the window
row shape and the rb-85 read chain byte-identical, serves the read and the delete from one index, and makes
ordering independent of the btree range's order (the seam sorts).

**Bounds, stated honestly.** READ: at most 256 decoded rows per tick, unchanged. WRITE: at most 16
creation stamps per tick. A stamp is normally one bundle — the size of the single `request_data_export`
transaction that created it — but every bundle committed inside the SAME millisecond shares that stamp
and is reaped in the same delete (all of them expired, all of them whole), so the write set is 16 × (the
bundles committed in each of those milliseconds), soft-bounded rather than hard-bounded in the attacker's
direction: `request_data_export` is cheap for a low-state identity and the host serialises reducers at
millisecond granularity, so a burst of N same-millisecond anonymous exports expires as one unit seven days
later (residual R-rb-86-SAMEMS, MED — the operator alarm rb-87 owns is the watch). And the write set is
counted in stamps, not rows: rb-85's 256-row delete cap is gone, and sixteen large bundles (a bundle can run
to hundreds of chunks at `EXPORT_CHUNK_ROWS`) are more rows than one tick used to delete — if that ever
exceeds the transaction budget the tick aborts and retries the identical head-of-range work every hour
(residual R-rb-86-TICKBOUND, MED). The security audit sharpened that: a smaller stamp cap helps only the
aggregate case — the stamp is the atomic unit, so a single oversized stamp wedges the reaper at any cap —
and the real mitigations are admission control at write time (R-rb-85-EXPORTADMIT) or a row-aware cap that
gives the atomicity back; and no watch exists yet — rb-84 classified this reaper as an SLO EXCLUSION and
the reducer emits nothing, so an abort loop is silent until rb-87 lands, and its consequence is expired
personal data retained past the seven-day ceiling. Reachability is low: a bundle is Σ over the exportable
tables of max(1, ⌈rows / EXPORT_CHUNK_ROWS⌉), and the 60 s per-identity cooldown keeps a same-millisecond
burst a multi-identity move. Storage growth under sybil pressure is still NOT closed (R-rb-85-EXPORTADMIT); the drain is
now measured in stamps.

**Rejected.** (a) The one-shot `ScheduleAt::Time` drain the residual proposed: it still COMMITS the k-of-N
state (the client would see `incomplete` for seconds instead of an hour), and a second row in
`export_bundle_reaper_schedule` is surplus by construction under `playtest::plan_reaper_arm`, which keeps
`existing_ids[0]` and deletes the rest — if the collect order ever put the one-shot first, the next
`request_data_export` would delete the hourly interval row and silently disarm the retention control. (b1)
Reusing `purge_export_bundles` per owner: it collects primary keys through the owner index, decoding every
purged row's `payload_json` — the byte cost rb-85 exists to remove, paid a second time. (c) Widening the
read window to finish a straddling bundle: a second decode of the same payloads. (d) The owner-keyed delete:
above. (e) `created_at_ms().delete(..=cutoff)` as a single range delete: uncapped, and it drops
`plan_export_reap` as SSOT — the rejection recorded by rb-48 still stands.

**Proof of teeth (ADR-0224: ordinary Rust tests, no eval).** Recorded at slice close in the rb-86 paragraph
of ARCHITECTURE.md and the harness ledger (`memory/projects/gates/rb-86.gates.md`, RED record
`rb-86.red-before.md`, register `rb-86.mutants.py` / `rb-86.x7-register.md`): a `rb86_` block in
privacy_tests.rs — the seam's value table (cap+1 straddle, same-millisecond tie, mixed expired/fresh
window, the 16-of-17 cap, the whole-window plan), its distinct/oldest-first/subset structure, an
all-or-nothing SIMULATION over oversized populations at a toy cap and at the shipped constants with
progress and no-collateral clauses and an old-rule split control, two proptests (plan-agrees-with-the-seam;
tick-leaves-every-bundle-whole under shuffled window order), the seam declared once and private with a
frozen signature and body, the helper's delete attributed by stamp and by argument with zero chunk-id
deletes, one loop with no conditional and no `break`/`continue`, the stamp index reached exactly twice, seam
scope crate-wide, a value pin on the stamp cap (its throughput floor derived from the manifest's exportable
count), the export reducer's whole insert-loop write site frozen by adjacency with exactly one `now`
binding (the tests red-team MEASURED three CI-clean per-chunk-stamp spellings that passed every earlier
pin), and a closed roster — ten tests. The rb-85 helper-body equality pin is re-frozen (the one-comma twin
now keys on the stamp constant); `m22s4_now_bound_once` is TIGHTENED; the module's `.iter()` budget stays
at exactly three because the seam is written as a loop (its first iterator-chain spelling was measured to
trip that receiver-agnostic census); every other rb48_/rb85_ pin is byte-identical. The native execution proof stays deferred (R-rb-85-X9: the range syscall is undefined in
the native host and the point delete aborts there).

## Amendment (2026-09-18, rb-87 — residual R-rb-48-OBS closed)

The "R-rb-48-OBS" bullet under Residuals above, and decision **D6** that it records, are discharged by
rb-87, which was assigned no usable ADR number (the supervisor-reserved 0251 had already been taken by
rb-81 when the slice ran — the same reservation race ADR-0225 and rb-86 hit — so, per the rb-84/85/86
precedent, this dated amendment is the decision record).

**The premise of D6 was wrong, and this amendment reverses it.** D6 said privacy.rs's header contract
"bans logging in this module" and that "there is no other module here to carry" the observation. Neither
half holds. The contract (`privacy.rs:29-44`) bans bare `log::` tokens, print macros, block comments,
raw strings and every `"` byte beyond the one `#[path]` attribute — it has never banned the blessed
wrapper: `crate::observability::mr_log` is a function, not a `log::` token, and `request_data_export` has
called it from this file since rb-65 (ADR-0243 D9: "the contract keeps the module scanner-inert; it never
said the module may not observe its own reducer"). And the crate doctrine that "the helper REPORTS, the
CALLING REDUCER owns the observation line" (rb-40 / ADR-0235, generalised by ADR-0243) needs no other
module here, because **for a scheduled reducer the calling reducer is the scheduled reducer itself**. So
the "crate-level decision" the residual asked for is neither of the two options it named: no
`observability.rs` hook is added (privacy.rs would still have to name it — every census cost identical,
plus a crate API with one caller), and no ban is lifted (nothing was in the way).

**Decision: `export_bundle_reaper` emits ONE terminal observation line.** What ships in privacy.rs:

- A private `#[derive(Debug, Clone, Copy)] struct ExportReapTick { read: usize, planned: usize, reaped:
  usize }` — the one-tick record. `read` is how many chunk rows the bounded window decoded (at most
  `EXPORT_REAP_MAX_READ_PER_TICK`, 256); `planned` how many creation stamps the bundle seam selected
  (at most `EXPORT_REAP_MAX_STAMPS_PER_TICK`, 16); `reaped` the datastore's own count of the rows the
  tick deleted, tails beyond the window included. Three RAW counts, never a derived verdict.
- `reap_expired_export_bundles(ctx, now_ms) -> ExportReapTick` (was `-> usize`). Its read, plan and
  delete text is byte-identical to rb-86's; it binds `planned` from the stamp plan BEFORE the delete loop
  moves it and returns the record. It still never emits — the rb-40 posture is unchanged — and its named
  consumer is now the reducer's line, not the deferred native execution test (that sentence of the rb-85
  amendment above is superseded).
- A pure private `reap_fields(tick) -> String`, the `export_fields` shape, rendering
  `"read":N,"planned":K,"reaped":M` through the module's JSON micro-builder (every key a `stringify!`
  token; bare numbers, the ADR-0226 width rule). NO SUBJECT: a scheduled tick has no caller, and the rows
  it deletes belong to whoever happened to expire — a per-tick list of who exported would be a disclosure
  in a 30-day store for a job that is about none of them (PRV1-17/20 by analogy).
- The reducer shell becomes guard → `let tick = reap_expired_export_bundles(ctx, now_ms(ctx));` →
  `let fields = reap_fields(tick);` → `crate::observability::mr_log(stringify!(export_bundle_reap),
  &fields);` → `Ok(())`. The line composes to `{"evt":"export_bundle_reap","read":N,"planned":K,"reaped":M}`.
  It is UNCONDITIONAL on the success path (a zero-count line is the negative an operator needs and the
  beat the dead-man reads), placed after the helper — the last WRITE, whose point deletes can still abort
  the transaction — and before `Ok(())`, the last STATEMENT: ADR-0243 D2's rollback rule, applied to a
  scheduled reducer. The guard-reject path emits nothing. On the deployed 2.x host a scheduled function
  is PRIVATE by default — only the database owner and team collaborators can bypass the schedule table
  and invoke it manually (the 2.0 migration guide; the repo's own `spacetimedb-reducer` skill card) — so
  the `ctx.sender() != ctx.database_identity()` guard is belt-and-braces rather than the sole defence
  (it stays: it is pinned by rb-48 and by the crate-wide scheduler-guard censuses, and removing it is an
  ADR-level posture change). The reject line stays absent for ADR-0243 D7's reason in its weaker,
  authenticated form: an owner-drivable reject line is still an unbounded write into a 30-day store,
  and a line there would record ticks that never ran. (The rb-87 security audit corrected an earlier
  draft of this paragraph that called the reduction client-drivable — 1.x behaviour, not 2.x.)
  This beat is a RETENTION / LIVENESS signal and deliberately NOT per-subject erasure evidence: with
  aggregate counts only it cannot say that subject X's snapshot was destroyed at time T — that evidence
  is the subject-bearing `data_export` / cascade lines (ADR-0243) plus the TTL invariant, never this
  line, and a subject must not be added here (audit N1).
- The evt vocabulary grows by one closed value, `export_bundle_reap`, mirroring the shipped
  `{reducer="mr_heartbeat", evt="heartbeat"}` pair; Alloy labels `{reducer, evt}` dynamically and no evt
  roster exists in `ops/` or `evals/`, so no ops-side edit accompanies it.

**What the line means — and what it does not.** *Abort loop → ABSENCE of the hourly line.* Because the
emission is the LAST statement, a tick that aborts anywhere before it — a point delete past the
transaction budget (R-rb-86-TICKBOUND), a panic — writes no line, so the hourly `export_bundle_reap` beat
stops: the `mr_heartbeat` dead-man idiom applied to one scheduled function, at an hourly rather than a
60 s cadence (so a different alert instrument than `mr:heartbeat:rate5m`, and one that needs a startup
grace — the singleton is armed by `init`/`sync_content`, so a fresh publish's first beat is up to an hour
out). That is what makes the abort loop R-rb-48-OBS called invisible observable. *Backlog → a cap at its
bound, as a HINT that is necessary-not-sufficient and sound only across consecutive ticks.* `planned` at
16 means the stamp plan MAY have been truncated — or exactly sixteen stamps expired; `read` at 256 means
the window filled, but whole-stamp deletes take the tails beyond it, so the tick may still have drained
every expired row (`reaped` can EXCEED `read`); and a saturated stamp cap can show `read` far below 256
(twenty expired stamps of five chunks). The one unambiguous signal — the window's distinct-stamp count
BEFORE `truncate(max_stamps)` — is swallowed inside rb-86's frozen `plan_export_reap_stamps` and is
deliberately not reshaped here (residual R-rb-87-BACKLOGAMBIG). The thresholds are NOT derived in the
module: a `backlog: bool` was rejected because the caps belong to ops/observability, where they can change
without a module publish, and a boolean the module computes is a second retention policy nobody reviewed.
Like the ADR-0243 D5 lines, the beat is written PRE-COMMIT and is AT-LEAST-ONCE: a host crash after the
reducer returns leaves a line for a reap that did not durably land. Absence of a line means nothing while
the log pipeline is down — the pipeline's own liveness is `mr:heartbeat:rate5m`, not this beat. And a line is an OBSERVATION, not an alarm: nothing consumes `evt="export_bundle_reap"` yet. The
alarm half — the missing-beat rule, the consecutive-cap rule, and R-rb-85-X10's row/byte growth threshold
— is a distinct file family (`ops/observability/rules`, Grafana alerting provisioning, their
stack-config-checks and the G13a eval pin) outside this slice's inherited touches, and it cannot precede
the line it consumes; it is deferred through the rb-87 acceptance ledger's X10 `DEFER: -> backlog` line,
from which the supervisor mints the residual. R-rb-86-SAMEMS and R-rb-86-TICKBOUND stay open as bounds;
what changes is that both are now VISIBLE — `planned` counts same-millisecond bundles as one stamp and a
wedged tick shows as a missing beat.

**Rejected.** (a) An `observability.rs` hook: above. (b) Lifting the privacy.rs ban for scheduled reducers:
above — it would delete measured protections (`rb22p_no_bare_quote_in_privacy`) to solve a problem that
does not exist. (c) An enter/exit breadcrumb pair to make the abort itself positive: `mr_log_breadcrumb(`
is pinned at zero in this file (`rb65p [emit/no-breadcrumb]`), privacy.rs cannot spell the `"enter"` /
`"exit"` literals m20e's G9 scanner requires at the call site, and a causeless INFO line does not belong
on the trace-pair surface. (d) A pre-delete "planned" line: the host writes a line as the reducer runs and
it survives a later rollback, so a line above the deletes records ticks that aborted, and two lines double
every operator count of one event. (e) Emitting on the guard reject: ADR-0243 D7 in its authenticated form (above). (f) A derived `backlog`
flag: above. (g) A counter instead of a line: Alloy derives `mr_log_events_total{reducer,evt}` from the
line — the line IS the metric.

**ADR-0243 D10 is superseded on one sentence.** "The same identifier census holds privacy.rs at one" was
true of rb-65's tree; since rb-87 the module makes exactly TWO emissions, attributed per body (one
`data_export` in `request_data_export`, one `export_bundle_reap` in `export_bundle_reaper`), with the D10
repayment re-applied in privacy_tests.rs: per-body counts, the file total, `total − scoped == 0` as
arithmetic, the bare-call and bare-identifier equalities and the alias ban all at two. ADR-0243 itself is
outside this slice's touches and is not edited; the supervisor may widen touches for a one-paragraph
dated amendment there.

**Proof of teeth (ADR-0224: ordinary Rust tests, no eval).** Recorded in the rb-87 paragraph of
ARCHITECTURE.md and the harness ledger (`memory/projects/gates/rb-87.gates.md`, RED record
`rb-87.red-before.md`, register `rb-87.mutants.py` / `rb-87.x7-register.md`): eight `rb87_` tests in
privacy_tests.rs — `rb87_reap_fields_renders_three_bare_counts` (the fragment BY VALUE over five rows:
the quiet-hour zeros, pairwise-distinct middle rows, an above-u32 row per field and an all-`usize::MAX`
row) and `rb87_reap_line_is_the_exact_json_envelope` (the exact composed line through the shipped
`build_log_line`) are the first EXECUTABLE oracles this reaper has had — the native host still cannot run
the reducer (R-rb-85-X9); `rb87_tick_record_declared_once_private_with_frozen_shape` (derive adjacency,
privacy, field shape), `rb87_reap_fields_is_pure` (declared once, the rb-85 24-byte `pub` window, frozen
signature and body, zero `ctx`), `rb87_helper_reports_the_whole_tick` (the signature re-frozen to return
the record, no constant counts, `planned` sourced from the stamp plan and bound before the loop header,
a left-bounded `let` binding census of exactly five — the tests red-team MEASURED a type-annotated
stamp-plan shadow that published `planned:16, reaped:0` forever with every other clause green),
`rb87_reaper_emits_one_terminal_observation` (the ONE emission counted first, at depth zero, with the
fields binding, ordered after the helper and before `Ok`, after the guard, reachable — zero `return` at
any depth, zero `?`, zero diverging `abort`/`panic!`/`unreachable!`/`todo!`/`unimplemented!`/`exit` in
the guard→Ok region — no breadcrumb form, the frozen terminal tail LAST as the backstop; clause order is
load-bearing because the register requires the designated label inside the designated test's own panic
block), `rb87_module_emits_exactly_two_observations_attributed` (per-body counts over a named roster,
`total − Σ roster == 0`, and the two-evt partition plus the reject token over the whitespace-PRESERVING
view — interior-space spellings are byte-identical in every squashed view), and a closed roster. The rb-48
reducer-shell and rb-85 helper-body equality pins are re-frozen IN PLACE over more text with independently
spelled controls; `rb65p [emit/count-in-file]` is widened 1 → 2 and repaid as above; the privacy.rs header
contract's calling-reducer sentence gains the reaper as a LINE-COUNT-NEUTRAL reflow, because sixteen
inbound `privacy.rs:<line>` citations (ADR-0231, ADR-0252, the client export-assembly tests) point below
it and thirteen of them live outside this slice's touches. Suite 961 → 969 (962 → 970 with
`dev_reducers`). RED proof: Stage 1 (the three new-symbol items cfg-stripped) 967 run / 958 passed / 9
failed — the four revised pins plus five rb87_ tests, each on its predicted clause; Stage 2 build failure
E0425 ×6 + E0422 ×1; the honest fix was green on the first attempt with zero test edits. Register: thirty
mutants and three controls on the final tree, runner exit 0 — every mutant KILLED on its designated clause,
every control GREEN, the tree restored byte-exact after every row (`rb-87.x7-register.md`).

## Amendment (2026-09-21, rb-109 — residual R-rb-85-X9 closed)

The **Deferred (ledger gates/rb-85.gates.md) X9 → backlog** paragraph of the rb-85 amendment above is
discharged by rb-109 (promoted from residual R-rb-85-X9; no ADR number was allocated, so per the
rb-84/85/86/87 precedent this dated amendment is the decision record for the CLOSURE — the native
HOST record, which is the mechanism, is the rb-109 amendment on ADR-0222). Nothing in `privacy.rs`
changed except two comments; the helper body `rb85_helper_body_exact` freezes is byte-identical.

**What is now EXECUTED.** `server-module/src/privacy_tests.rs` runs the SHIPPED private helper
`reap_expired_export_bundles(ctx, now_ms)` — the one call site is `rb109_tick`, exactly the 0 → 1
re-attribution of `rb85_helper_is_never_named_outside_privacy_rs` that its own doc pre-authorised (the
paren-bearing count, plus a new paren-less count that closes the fn-item-binding second call) — over
seeded `export_bundle` rows in the native host, with an injected `now_ms` below the reducer's guard.
Eight `rb109_` tests (1011 → 1019; 1012 → 1020 with `dev_reducers`), every clause a VALUE oracle:

- The oversized population the criterion names — 26 owners × 17 chunks × 8 KiB payload (442 rows; 340
  expired across 20 stamps, one exactly AT the cutoff; 102 live), seeded in a deterministic
  INTERLEAVED order that a guard clause proves is not the sorted order — and one tick returns
  `read == 256`, `planned == 16`, `reaped == 272` (> read: the sixteenth stamp's tail lies past the
  window), and the survivor set compared as sorted `(owner, stamp, chunk_id)` triples is exactly the
  102 live rows plus the four NEWEST expired bundles. An unsorted host leaves a disjoint four with
  every count unchanged; a host that capped its own scan is caught by a direct `filter(lo..=cutoff)`
  count of 340 (which is also what keeps the production `.take` mutant loud).
- The exact-delete case (85 expired incl. the at-cutoff stamp, 51 live → `(85, 5, 85)`, survivors ==
  the live set), the drain (`(256,16,272)`, `(68,4,68)`, `(0,0,0)`, bounds held every tick, iterators
  closed every tick), the zero tick with a positive readability control, and the STAMP-CAP binding
  case — 20 bundles × 13 chunks, where a 256-row window holds twenty distinct stamps, so
  `planned == 16` and `reaped == 208` is the only value oracle for `EXPORT_REAP_MAX_STAMPS_PER_TICK`
  (in the 17-chunk population the window holds exactly sixteen stamps and the truncation cannot bind).
- Two host-model controls: every bound kind on each side incl. an Excluded START and the plain `a..b`
  Range, negative keys (BSATN i64 is little-endian — a byte comparator sorts −1 above every positive),
  a same-stamp pair in seed order; and the iterator lifecycle — two live interleaved scans without
  aliasing, the fixture SEEING one open iterator (the one non-zero reading that makes every zero
  meaningful), the abandoned scan closed, a 70 000-byte row read back through the buffer-grow leg.
- A closed roster with rb-107's nine clause families (per-name, dup, adjacency, attribute walker with
  controls, label census, declaration total over closed rosters, a squashed declaration count, the
  body floor, a dependency roster).

**RED, measured (harness `memory/projects/gates/rb-109.red-before.md`).** Stage 1: the pin revision
alone on the pre-slice tree → 1011 run / 1010 passed / 1 failed on `[rb85/helper-name-tests]`. Stage 2:
the test block on the unchanged host → E0599 ×6 (`Handle::rows`, `Fixture::open_iters`), zero tests
run. Stage 2b: the read-back APIs without the syscall bodies → `rust-lld: undefined symbol:
datastore_index_scan_range_bsatn`, the whole lib-test binary — the mechanism the X9 DEFER line named.
**The criterion's "RED on the pre-slice `.iter()` body" is mutant M1**: the tree at 786c222 already
ships rb-85's bounded read, so the rb-48 full `.iter()` sweep was spliced back into the helper and the
five helper-reaching tests ABORTED the process on the unmodelled table scan (nextest: 5 failed / 3
passed) — GREEN on restore. Register (`rb-109.mutants.py`, 17 rows): every production and host mutant
with a value oracle died on its predicted label — `.take` dropped (340), `..cutoff` (68/4/68), the
stamp truncation dropped (planned 20), the host's sort removed (the survivor set), a delete reporting
0, a delete ignoring its key, an end bound ignored, a byte comparator, a host-side 256 cap, Excluded
parsed as Included, a stubbed iterator count, a body wrapped in `if false`. Disclosed survivors: the
out-param written as `usize` (UB), a host that reports 0 on BUFFER_TOO_SMALL (a HANG, not a red — run
under a timeout), an unregistered-index delete that returns 0 instead of aborting (the wall is
prose-pinned), and `sort_by` → `sort_unstable_by` (at eight rows both are insertion sorts).

**What is now MEASURED, and what is not.** The fairness property rb-85 could not observe — that a
tick plans the sixteen OLDEST stamps — holds against the modelled host. Stated honestly: the
ascending yield is a MODEL of the btree contract, verified against `native_host_tests.rs`, NOT an
observation of a live SpacetimeDB instance; the model also compares with a comparator the FIXTURE
typed (`table_keyed::<_, i64>`), not the index's `AlgebraicType`, and it materialises the sorted
candidate list eagerly — so E1's "materialise no more than 256 rows" is proven of the module's own
decode count `read`, made credible by the 340-row scan the host offers beside the frozen body pin.
Residual **R-rb-109-ORDERMODEL**: closing it needs a live-instance probe (account-e2e tier), not a
unit test. Also disclosed: a range-argued `delete(..=stamp)` (the cross-bundle wipe the helper's own
comment names) and an at-or-below delete relation are INDISTINGUISHABLE to these oracles, because the
tick issues its deletes oldest-first — the argument pin in `rb85_helper_body_exact` owns that shape. And the verifier's own probe: deleting the bundle seam's defensive
`stamps.sort_unstable()` (so `dedup` becomes adjacency-only and planning silently DEPENDS on the
datastore's order) survives all eight `rb109_` tests under the modelled ascending host and is killed
only by the rb-86 family (five tests) — the rb-109 proof pins the MODEL's order, not the module's
independence from it; that independence is owned by rb-86, and X2's full-suite run is what makes it a
merge gate.

**Superseded sentences in this ADR** (its own convention; none edited in place): under *What this
changes and does not change*, "neither a documented SDK contract nor something this slice observed
(the execution proof is deferred, below)"; the rb-85 amendment's X9 deferral paragraph and its
"consumers: the deferred native execution test"; the rb-86 amendment's "The native execution proof
stays deferred (R-rb-85-X9 …)"; the rb-87 amendment's "the native host still cannot run the reducer"
— the HELPER is executable now; the REDUCER still is not (`ctx.database_identity()` and the metadata
row-count syscall remain unstubbed, so a test reaching either is still a LINK failure of the whole
lib-test binary, which is why no test names the reducer).

**Rejected.** Modelling `datastore_table_scan_bsatn` (the abort IS the ban, and it is what makes M1
loud); calling `export_bundle_reaper` from a test (a LINK failure, not a red test); a `Host` field or a
second static for the comparator (either shifts the four out-of-touches line citations into
`native_host_tests.rs` — see the ADR-0222 amendment, D1); growing the T6 fixture past the
insertion-sort threshold to make the stable-sort claim testable (tie order is no datastore contract
and nothing may depend on it — the claim was retruthed instead).

## Amendment (2026-09-25, rb-110 — residual R-rb-86-READCAP-NAME closed)

The per-tick row cap this ADR introduced, `EXPORT_REAP_MAX_DELETE_PER_TICK`, is renamed by rb-110 to
`EXPORT_REAP_MAX_READ_PER_TICK` (ADR-0267, which **Extends** this record; no ADR amends it, so per the
rb-84/85/86/87/109 precedent this dated amendment is the closure record here). **Value, type, visibility
and every consumer are unchanged; there is no alias and no deprecation shim (ADR-0267 D2).** rb-86 above
split the tick's two bounds — the read window stayed this constant, the write side became
`EXPORT_REAP_MAX_STAMPS_PER_TICK = 16` — and from that day the cap bounded only what a tick READS while
its rb-48 spelling still said DELETE. rb-86 recorded the misnomer and deferred the fix as residual
**R-rb-86-READCAP-NAME**; ADR-0265 (rb-107) then derived a second production constant from it
(`EXPORT_LIVE_ROW_CAP = 256 × 168 = 43 008`), so the wrong name had begun to shape new reasoning about the
WRITE side — which is what promoted the residual. It is DISCHARGED here.

**Edited in place (identifier citations only; no decision text reworded):** `:59` (the rb-48 Decision's
value-and-rationale citation), `:423` (the rb-86 amendment's WINDOW chain), `:437` (the rb-86 amendment's
retention parenthetical, replaced by a bracket note that records the rename) and `:537` (the rb-87
amendment's `ExportReapTick.read` bound). The same citations are renamed in ADR-0231 (one site, whose
surrounding "so it can cut across one owner's request" sentence rb-86 had already made false and which is
retruthed with it), in ADR-0265 (three sites in the D1 derivation and one in its Context) and in ARCHITECTURE.md (the rb-85 and
rb-107 slice paragraphs; the rb-86 paragraph keeps one marked mention of the retired spelling, and a new
rb-110 paragraph records this slice).

**Left as history with a bracket note (not edited):** `:302`, whose sentence the rb-86 amendment above had
already listed as SUPERSEDED. It keeps its wording, retired spelling included, and gains a same-line
`[rb-110: …]` note naming the constant today. The rb-109 amendment's convention statement — superseded
sentences are listed, none edited in place — therefore stays true.

**Proof.** `server-module/src/privacy_tests.rs`: four `rb110_` tests — the value read plus the single
squashed declaration; the raw, identifier-only and transitive crate-wide zero-occurrence census with three
exact family counts; the four documents' new-name floors, retired-name ceilings, per-line marker rule,
split-token cross-check and stale-claim ban; and a closed roster — plus seven re-frozen frozen-text pins
and ten re-frozen value reads. RED before the rename (harness
`memory/projects/gates/rb-110.red-before.md`), GREEN after with no further test edit; suite 1019 → 1023
(1020 → 1024 with `dev_reducers`); `just ci`.

## Amendment (2026-09-25, rb-111 — residual R-rb-86-SAMEMS closed)

The "Bounds, stated honestly" paragraph of the rb-86 amendment above disclosed **R-rb-86-SAMEMS**: every
bundle committed inside the same millisecond shared a creation stamp, so the tick's WRITE bound was sixteen
stamps × (the bundles under each), soft-bounded in the attacker's direction. rb-111 (ADR-0268, which
**Extends** this record) closes it at the WRITE SITE, with no change to the reaper, the schema, the native
test host or the client: `request_data_export` now mints a creation stamp no LIVE `export_bundle` row
carries — the injected clock, or the first later millisecond within `EXPORT_STAMP_PROBE_WINDOW_MS = 16`
for which an index-POINT read on the `created_at_ms` btree finds nothing (`mint_export_stamp`, private,
reads only) — and REFUSES with the static reason `export_reject_stamp_contention` when the whole window is
occupied, never falling back on a shared stamp. Every chunk of the request carries that one stamp as
`request_id` and `created_at_ms`. **`one request ⇔ one live stamp` is now a bijection**, so the per-tick
WRITE bound is sixteen BUNDLES minted since rb-111 — the reaper's bound semantics change without a byte of
the reaper changing.

**Superseded sentences in the rb-86 amendment above (this ADR's convention: listed, none edited in
place):** "A stamp is normally one bundle … but every bundle committed inside the SAME millisecond shares
that stamp and is reaped in the same delete … so the write set is 16 × (the bundles committed in each of
those milliseconds), soft-bounded rather than hard-bounded in the attacker's direction" and "a burst of N
same-millisecond anonymous exports expires as one unit seven days later (residual R-rb-86-SAMEMS, MED …)"
— true of every bundle minted BEFORE rb-111 (such rows keep their stamps for one retention window:
residual R-rb-111-LEGACYSTAMP), false of every bundle minted after it. The constant's description in the
same amendment — "one stamp is one request's bundle, or every bundle committed inside that same
millisecond" — is superseded the same way; privacy.rs's own comments were retruthed in place.

**What does NOT change, and stays open:** the write set is still counted in stamps, not rows — a bundle can
run to hundreds of chunks at `EXPORT_CHUNK_ROWS`, and sixteen large bundles may exceed the transaction
budget, so **R-rb-86-TICKBOUND stays open** (rb-112). The rb-87 observation line's `planned` count now
counts bundles minted since rb-111 exactly, which sharpens the backlog HINT it publishes without changing
its shape.

**Bounds after rb-111.** READ: at most 256 decoded rows per tick, unchanged. WRITE: at most 16 stamps per
tick, each exactly one bundle minted since rb-111. A minted stamp sits at most 15 ms ahead of the clock,
by construction. Sustaining a contention refusal needs about one successful bundle per millisecond from
distinct subject identities, which the ADR-0265 anonymous budget ends in about 1.25 s once per retention
window — during which account holders can be refused too (a partial regression of ADR-0265 D1b; residual
R-rb-111-CONTENTION, LOW, retryable). The bijection rests on reducer-transaction serialisation, not on a
datastore constraint (residual R-rb-111-NOCONSTRAINT); the minted stamp a caller reads back is a ≤ 4-bit
anonymous timing channel (R-rb-111-STAMPORACLE); an unreachable `i64::MAX` clock would collapse the window
(R-rb-111-SATURATE); and the pre-existing `privacy.rs:<line>` citations in ADR-0231/ADR-0265 drift further
(R-rb-111-ADRCITE). ADR-0268 records the derivation, the rejected
alternatives (a composite index, an owner-keyed delete, a monotonic global stamp, a fallback stamp, a wider
window) and every residual.

**Proof (ADR-0224: ordinary Rust tests, no eval).** `server-module/src/privacy_tests.rs`: eight `rb111_`
tests — the mint's value table, the same-millisecond burst (sixteen distinct stamps, the seventeenth
refused until the clock advances), the criterion end-to-end (eighteen bundles minted at one clock, one
tick: 256 read / 16 planned / 272 reaped, the two newest surviving whole — RED as 1 planned / 306 reaped
under the status-quo stamp), a minimum-free-stamp proptest, the reducer write-site pins, the frozen helper,
the docs census and a closed roster — plus the re-frozen `[X9/now-request-id]` / `[X9/now-stamp]`
needles, the rb-86 insert-loop needle and its control, `[X9/dispatch-args]` (admits `(ctx, now)` only for
the mint), `[rb85/range-census]` 1 → 2 and `[rb85/bundle-census]` 9 → 10 with attribution,
`[rb86/stamp-index-reaches]` 2 → 3, rb-107's N1 needle welding the mint, `[rb107/exit-shape]`
counting `?` by depth, and `rb65p [emit/no-try]` 0 → 1 attributed to the mint's `?`. RED record: harness `memory/projects/gates/rb-111.red-before.md`. Suite
1023 → 1031 (1024 → 1032 with `dev_reducers`); `just ci`.

## Amendment (2026-09-26, rb-115 — residual R-rb-87-BACKLOGAMBIG closed on the truncation half; R-rb-115-WINDOWEDGE opened)

The rb-87 amendment above published the tick as three raw counts, disclosed that a cap at its bound is only
a backlog HINT, and named the window's distinct-stamp count before `truncate(max_stamps)` as the number
rb-86's frozen seam swallowed. rb-115 publishes that number and closes R-rb-87-BACKLOGAMBIG on its
truncation half (ADR-0269, which **Extends** this record; no ADR amends it, so per the rb-110/rb-111
precedent this dated amendment is the closure record here). A new private, pure, one-line
`count_export_reap_stamps(rows, now_ms, ttl_ms) -> usize` runs the frozen `plan_export_reap_stamps` with
the cap `rows.len()` — a cap the window cannot reach — and returns the length, so the seam is not
reshaped and stays the only definition of the stamp set. `ExportReapTick` gains `due` in data-flow order
(`read, due, planned, reaped`), bound in `reap_expired_export_bundles` over the same rows, instant and
TTL as the capped call, and `reap_fields` renders it between `read` and `planned`. `due` is WINDOW-scoped
— the distinct expired creation stamps the window holds before the write bound — so
`planned == min(due, EXPORT_REAP_MAX_STAMPS_PER_TICK)` and `due > planned` means the stamp cap bound.

**Superseded sentences in the rb-87 amendment above (listed, none edited in place):**

- "*Backlog → a cap at its bound, as a HINT that is necessary-not-sufficient and sound only across
  consecutive ticks.* `planned` at 16 means the stamp plan MAY have been truncated — or exactly sixteen
  stamps expired; … and a saturated stamp cap can show `read` far below 256 (twenty expired stamps of
  five chunks). The one unambiguous signal — the window's distinct-stamp count BEFORE
  `truncate(max_stamps)` — is swallowed inside rb-86's frozen `plan_export_reap_stamps` and is
  deliberately not reshaped here (residual R-rb-87-BACKLOGAMBIG)." What is true now: that count is
  published as `due` without reshaping the seam. `due > planned` shows a truncation and `due == planned`
  shows an exactly-that-many plan. The "twenty expired stamps of five chunks" tick reads read 100, due 20,
  planned 16, reaped 80. The elided middle clause ("`read` at 256 means the window filled, but
  whole-stamp deletes take the tails beyond it, so the tick may still have drained every expired row")
  stays TRUE. "The one unambiguous signal" over-stated: the count is unambiguous about truncation INSIDE
  the window and silent about rows past its edge (R-rb-115-WINDOWEDGE, below).
- The first bullet's `struct ExportReapTick { read: usize, planned: usize, reaped: usize }` … "Three RAW
  counts, never a derived verdict." What is true now: four raw counts, `{ read, due, planned, reaped }`,
  still never a derived verdict.
- The third bullet's fragment `"read":N,"planned":K,"reaped":M` and the fourth bullet's composed line
  `{"evt":"export_bundle_reap","read":N,"planned":K,"reaped":M}`. What is true now:
  `"read":N,"due":D,"planned":K,"reaped":M` and
  `{"evt":"export_bundle_reap","read":N,"due":D,"planned":K,"reaped":M}`.
- One sentence in the rb-111 amendment above: "which sharpens the backlog HINT it publishes without
  changing its shape". What is true now: the shape changes by one field. What that amendment says of
  `planned` (it counts bundles minted since rb-111 exactly) holds for `due` as well.

**What does NOT change:** the seam (`plan_export_reap_stamps`'s signature, body and explicit-loop idiom)
and `plan_export_reap`, the SSOT expiry predicate; the reducer shell (guard → helper → `reap_fields` →
`mr_log` → `Ok(())`), byte-identical; both bounds — READ ≤ `EXPORT_REAP_MAX_READ_PER_TICK` (256 decoded
rows), WRITE ≤ `EXPORT_REAP_MAX_STAMPS_PER_TICK` (16 stamps); the delete loop, which iterates the capped
plan alone (the seam's one uncapped caller only takes `.len()`); and the absence of any derived verdict —
a `backlog` flag stays rejected for rb-87's reason. The line gains one bare number; nothing consumes it
yet, and the alarm half is still the rb-87 X10 backlog item.

**Bounds, stated honestly.** On the ascending host the three counts already decided WHETHER truncation
happened (`reaped < read` proves it in any read order); `due` is the direct, order-independent observation
of HOW MANY stamps the window held, which no function of the three counts can recover (ADR-0269's
populations A and A′ both read `(read, planned, reaped) = (256, 16, 208)`, with `due` 20 versus 17). On
shipped constants the cap can bind only when the window's sixteen oldest stamps total at most 255 rows — a
stamp of at most fifteen rows, where this module writes seventeen or more — or when the range read
interleaves stamps, so on live data `due` is a tripwire, not a backlog signal. It can reveal, but cannot
rule out, a non-ascending yield: a descending read that keeps each stamp's rows together never produces
`due > planned`, so **R-rb-109-ORDERMODEL stays open**. And a tick that reads a full window and plans
every stamp it saw still cannot say whether expired rows remain past the window's edge: `due`, taken over
the window, inherits that blindness (rb-109's oversized population, `(256, 16, 272)` with `due` 16, leaves
four expired bundles). **R-rb-115-WINDOWEDGE stays open** (MED); consecutive full-window ticks remain the
backlog heuristic, and ADR-0269 records the candidate fix (a post-delete range probe) and the zero-cost
interim (an ops rule).

**Proof (ADR-0224: ordinary Rust tests, no eval).** `server-module/src/privacy_tests.rs`: five `rb115_`
tests — the count's value table (including a row at a non-shipped TTL); the native-host ticks through the
shipped helper (A and A′ byte-identical in the three counts with `due` 20 versus 17; B `(256, 16, 272)`
with `due` 16; C read 100, due 20, planned 16, reaped 80); source pins on the new fn and its one binding;
the docs census; and a closed roster — plus the re-frozen `rb85_helper_body_exact`, the rb-86 seam-scope
census 2 → 3 attributed, the rb-87 record, fragment and envelope pins with the helper's `let` census
5 → 6, and the rb-109 tuple sites (`rb109_tick` widened with `due` last). RED record: harness
`memory/projects/gates/rb-115.red-before.md`. Suite 1031 → 1036 (1032 → 1037 with `dev_reducers`)
(provisional; confirmed at merge).
