# ADR-0268 — The export bundle creation stamp is unique per LIVE request: `request_data_export` mints it by probing the `created_at_ms` btree, so a reaper tick's sixteen stamps are sixteen bundles (rb-111)

**Status:** Accepted
**Date:** 2026-09-25
**Slice:** rb-111 (residual R-rb-86-SAMEMS, promoted from source slice rb-86; M-residual-backlog.spec.md#rb-111)
**Supersedes:** —
**Amends:** —
**Extends:** 0238
**Subsystems:** schema-persistence, security-authz
**Decision:** request_data_export mints a creation stamp no live export_bundle row carries (the clock or the first free millisecond within 16), rejecting on contention, so one stamp is one live bundle and a tick's 16 stamps are 16 bundles.

---

## Context and problem statement

rb-86 (ADR-0238, dated amendment of 2026-09-18) made the PRV1-14 TTL reaper delete export bundles
WHOLE, keyed on the creation stamp: every chunk `request_data_export` writes carries the reducer's
single `now` as both `request_id` and `created_at_ms`, so one index-point delete on the
`created_at_ms` btree takes exactly the chunks of one request — the read window can no longer
tear a bundle k-of-N. The tick's WRITE bound became `EXPORT_REAP_MAX_STAMPS_PER_TICK = 16`
creation stamps.

That bound was stated honestly and disclosed as residual **R-rb-86-SAMEMS**: the invariant rb-86
pinned is `one request ⇒ one stamp`, not the converse. Every bundle committed inside the SAME
millisecond shares a stamp, and the host serialises reducers at millisecond granularity while
`request_data_export` is cheap for a low-state anonymous identity (seventeen empty chunks). A burst
of N same-millisecond exports therefore expires as ONE delete unit seven days later, and the
per-tick write set was really `16 × (bundles per stamp)` — soft-bounded in the attacker's
direction. rb-107 (ADR-0265) capped the LIVE population, which bounds that product, but a single
stamp carrying a thousand bundles is still one transaction's worth of deletes, and a tick that
exceeds the transaction budget aborts and retries the identical head-of-range work every hour —
silently retaining expired personal data past the seven-day ceiling (the abort-loop hazard
ADR-0238's rb-86 amendment records under R-rb-86-TICKBOUND).

The spec's EARS line for this slice is the residual's own sentence — "same-millisecond export
bursts form one reaper delete unit" — with an ADR-0224 proof obligation: an ordinary Rust test in
`privacy_tests.rs` that is RED before the fix and GREEN after, no new eval.

Two constraints shaped the fix:

- **The schema is frozen for this purpose.** `export_bundle` (schema.rs) carries a synthetic
  `chunk_id` primary key, an `owner_identity` btree and a `created_at_ms` btree. A multi-column
  unique constraint is inexpressible in the 2.8.1 module macro, and adding `#[unique]` to a live
  table is an automigration-FORBIDDEN change (schema.rs says so on the table). A composite
  `(owner_identity, created_at_ms)` btree would be additive, but it is a table migration that
  touches schema.rs, the table-schema eval baseline and the native test host's single-key row
  model — three files outside this slice's declared touches.
- **The native test host executes ctx-bound helpers only through the syscalls it models.**
  Since rb-109 (ADR-0222 amendment) it models single-column index POINT and RANGE reads and the
  index-point delete on registered indexes; it does not model `.count()`, inserts or the module
  identity, so `request_data_export` itself can never run there. A fix whose new logic is a
  small ctx-bound helper that only reads the `created_at_ms` index CAN be executed for real, the
  way rb-109 executes the reaper's bounded read.

## Decision

**D1 — the write site mints a stamp no LIVE row carries.** A new PRIVATE helper in privacy.rs,
`mint_export_stamp(ctx: &ReducerContext, now_ms: i64) -> Result<i64, String>`, returns the
injected clock, or the first later millisecond for which an index-POINT read on the
`created_at_ms` btree (`ctx.db.export_bundle().created_at_ms().filter(candidate).next()`, which
the 2.8.1 SDK lowers to `datastore_index_scan_point_bsatn`) finds no row. It probes at most
`EXPORT_STAMP_PROBE_WINDOW_MS = 16` consecutive milliseconds, written as an explicit `for` loop
over an offset range (never an iterator chain over the table: `[rb85/iter-census]` budgets
`.iter()` in this file), with saturating arithmetic (the release profile enables overflow checks).
`now_ms` is a parameter that shadows the imported clock fn, the rb-85 idiom, so a second clock read
inside the helper is a compile error. The helper READS only: no insert, no delete, no `.count()`.

**D2 — reject, never fall back.** When the whole window is occupied the helper returns
`Err(export_reject_stamp_contention)`, one more static reason in the `export_reject_*` family
(reject-not-clamp, this project's Postel inversion). Falling back to the shared clock stamp was
rejected because it restores exactly the unbounded delete unit the slice removes, one request at a
time, in the case that matters (a burst). The refusal is retryable: the `?` rolls the caller's purge
back with it (ADR-0106 D8), the caller's previous bundle survives with its ≥ 60 s-old stamp, and the
cooldown does not penalise the refused call.

**D3 — the call sits between the admission pre-gate and the manifest walk.**
`let stamp = mint_export_stamp(ctx, now)?;` runs AFTER rb-107's tier-one admission check, so a
caller who cannot be served pays no probe reads, and BEFORE the manifest walk, so contention is
refused before the two unindexed own-row scans of ADR-0226. The insert loop then writes
`request_id: stamp as u64` and `created_at_ms: stamp` — every chunk of the request carries the one
minted stamp, so rb-86's `one request ⇒ one stamp` still holds, and D1 supplies the converse. `now`
remains the clock for the cooldown; `stamp` is the mint's return. The `?` is the region's first
depth-0 early exit that is not a `return`, and `privacy_tests.rs` counts it by depth.

**D4 — the bounds, stated honestly.** A successful mint returns a stamp in
`[now, now + EXPORT_STAMP_PROBE_WINDOW_MS)` by construction, so a stamp never sits more than
15 ms ahead of the clock, unconditionally. SUSTAINING a refusal needs about one successful bundle
per millisecond from distinct subject identities (the 60 s per-identity cooldown, each identity
needing an `account` or `player` row) after a sixteen-bundle fill; the anonymous admission budget
of ADR-0265 (21 504 rows, 1 264 minimum bundles) ends such a burst in about 1.25 s, once per
retention window, because the planted rows then hold the anonymous half of the store for seven
days. The window's width buys NO resistance against that attacker — the sustained rate is one per
millisecond whatever the width — so `EXPORT_STAMP_PROBE_WINDOW_MS` is not derived from anything:
it is the assumed ceiling on LEGITIMATE exports per millisecond, kept far below the 60 s cooldown
so the run-ahead can never interact with flood control; sixteen is generosity, and it imposes a
global ceiling of sixteen successful exports per millisecond (the legitimate sustainable rate under
the admission cap and the cooldown is about 42 per second, some 380× lower).

**D5 — the bijection rests on reducer serialisation, not on a constraint.** The probe and the
insert run inside one reducer transaction, and reducer transactions do not interleave, which is
what makes `probe-then-insert` sound. There is NO datastore constraint behind it (the schema cannot
express one, above). A `#[procedure]` on this path, or any future optimistic-concurrency retry,
would reopen the collision; a break degrades to the status-quo shared stamp — the pre-rb-111 tear
rb-86 already argued is never data loss — never to destroying a live export, because the reaper's
delete is still keyed on stamps the SSOT expiry predicate planned.

**What stays byte-identical:** schema.rs, native_host_tests.rs, the reaper (`export_bundle_reaper`,
`reap_expired_export_bundles`, `plan_export_reap`, `plan_export_reap_stamps`,
`export_reap_cutoff_ms`, `reap_fields`), every constant value, `purge_export_bundles`,
`my_export_bundle`, the arm, the reducer's signature and its eight-column row literal's column
names, the S8 client (`exportAssembly.ts` still groups by `request_id`, now unique per live bundle,
and picks the maximum, which stays monotone per owner because the run-ahead is far under the
cooldown), and every eval.

## Rejected alternatives

- **(a) A composite `(owner_identity, created_at_ms)` btree with a composite point delete in the
  reaper.** Structurally the cleanest — the delete unit becomes the request by construction — but
  a schema change (schema.rs, the table-schema baseline eval, and multi-key rows in the native host
  are three files outside this slice's touches), fan-out-ineligible, and it re-shapes the reaper's
  seams and every rb-86 pin for a property the write site can supply alone.
- **(b) An owner-keyed delete in the reaper.** Rejected by rb-86 and still wrong: atomic only while
  one owner holds one bundle, and a broken invariant there destroys a FRESH, unexpired export.
- **(c) A monotonic global stamp (`max(live) + 1`).** Needs a reverse-ordered index read the SDK
  does not offer, or a decode of every row above the clock; and its run-ahead is unbounded.
- **(d) Fall back to the clock stamp when the window is full.** Restores the unbounded delete unit
  in exactly the burst case (D2).
- **(e) A wider window.** More index reads under the global write lock per contended request for
  tolerance of legitimate bursts no real client produces; no attacker-facing gain (D4).
- **(f) A count-typed knob (`EXPORT_STAMP_PROBE_MAX: usize`).** Hides that the unit is the clock's;
  the `i64` window also removes an `as` cast from the loop.
- **(g) Closing R-rb-86-TICKBOUND in the same slice.** Rows per BUNDLE stay unbounded (a bundle can
  run to hundreds of chunks at `EXPORT_CHUNK_ROWS`); a row-aware cap is its own design (rb-112).
  This slice turns "16 stamps × bundles-per-stamp" into "16 bundles"; **R-rb-86-TICKBOUND stays
  open**.

## Consequences

- **Cost.** The common case is ONE index-point read that decodes nothing. A contended probe costs
  at most sixteen point reads; each read that hits an occupied stamp may cost the host one buffer
  fill of that stamp's rows (the SDK's row iterator fills a 64 KiB buffer with whole rows), though
  the module decodes at most one row per probe. A refused caller has no cooldown (a caller with
  zero live rows is always past it), so under a fully occupied window every request pays those
  reads at an unbounded rate behind the write lock; the admission pre-gate above the mint is the
  only bound on that, and it binds only near the cap (residual R-rb-111-CONTENTION).
- **The window is untiered.** An anonymous burst can refuse ACCOUNT HOLDERS for about 1.25 s once
  per retention window — a partial regression of ADR-0265 D1b's promise that anonymous traffic
  cannot crowd out account holders. LOW, retryable, and strictly better than the status quo in
  which the same burst succeeded and formed one unbounded delete unit.
- **The bijection is prospective.** Rows committed before this module version keep whatever stamp
  they have, so for one `EXPORT_BUNDLE_TTL_MS + EXPORT_REAP_INTERVAL` a pre-deploy same-millisecond
  group is still one delete unit (residual R-rb-111-LEGACYSTAMP, self-clearing).
- **Stamp semantics.** `created_at_ms` and `request_id` are now "the request's unique creation
  stamp, at or up to 15 ms after the clock". TTL expiry and the caller's next cooldown shift by the
  same amount. `request_id: stamp as u64` still wraps a negative stamp to a huge value (pre-existing
  `now as u64` behaviour; the client selects the maximum), unchanged here. The probe is global,
  not owner-scoped, so a caller's own `request_id` (readable back through `my_export_bundle`) encodes
  how many of the preceding fifteen milliseconds carried some OTHER owner's live bundle — at most four
  bits, no identity and no content, behind the 60 s per-identity cooldown; accepted as outside the
  row-level leak class ADR-0231 governs.
- **Retention correctness improves on the reaper side with no reaper change:** a tick's write set is
  sixteen whole bundles minted since rb-111, so the write-side cap of ADR-0265 and the drain of
  ADR-0238 now reason about the same unit. **R-rb-86-TICKBOUND stays open** (rows per bundle).
- **No constraint backs the invariant** (D5; residual R-rb-111-NOCONSTRAINT): a future
  cross-transaction construct on this path must re-establish it.
- **privacy.rs grows** (about forty lines); the three `docs/knowledge/**` anchors into it are
  regenerated, and the pre-existing `privacy.rs:<line>` citations in ADR-0231/ADR-0265, already
  drifted at the parent commit, drift further (residual R-rb-111-ADRCITE).

## Residuals

- **R-rb-111-CONTENTION** (LOW) — while a sixteen-millisecond window is fully occupied, a
  legitimate request (account holder or not) is refused with `export_reject_stamp_contention`;
  retryable; reachable only under a ≥ 1 bundle/ms multi-identity burst, for ≈ 1.25 s once per TTL;
  and each refused request costs up to sixteen index-point reads with no cooldown of its own.
- **R-rb-111-LEGACYSTAMP** (LOW) — pre-deploy rows keep shared stamps for one retention window.
- **R-rb-111-NOCONSTRAINT** (LOW) — the uniqueness rests on reducer serialisation alone.
- **R-rb-111-ADRCITE** (LOW) — stale `privacy.rs:<line>` citations in ADR-0231/ADR-0265.
- **R-rb-86-TICKBOUND stays open** — rows per bundle are still unbounded (rb-112).

## Confirmation

ADR-0224: ordinary Rust tests, no eval. An `rb111_` block in `privacy_tests.rs`, executed in the
native host where it is behavioural: the mint's value table (empty → clock; occupied → next free;
gaps; the window's last free slot; a full window → the static reason; the clock at `i64::MAX`),
the residual's own sentence (sixteen same-millisecond mints take sixteen distinct stamps and the
seventeenth is refused until the clock advances), the criterion end-to-end (eighteen bundles minted
through the helper at one clock and then one reaper tick: 256 read, 16 planned, 272 reaped —
sixteen BUNDLES, with the two newest surviving whole — RED as 1 planned / 306 reaped under the
status-quo stamp), a proptest that the minted stamp is the minimum free stamp at or after the
clock over random occupancy, and source pins: the reducer's single `let stamp =` binding, the whole
mint statement with its `?` welded between the pre-gate and the walk, the row literal reading
`stamp` in both fields, the helper declared once and private with a frozen signature and body, the
probe an index POINT (`filter(candidate)`), the constant declared once at sixteen, the reason
spelled once, the creation-stamp index reached exactly three times file-wide (range read, point
delete, mint probe), and the closed roster. Re-frozen in the same diff, each a reviewed event:
`[X9/now-request-id]`, `[X9/now-stamp]`, the rb-86 insert-loop needle and its control,
`[X9/dispatch-args]` (admits `(ctx, now)` only for the mint), `[rb85/range-census]` 1 → 2 and
`[rb85/bundle-census]` 9 → 10 with attribution, `[rb86/stamp-index-reaches]` 2 → 3, rb-107's N1
adjacency needle and its control (now welding the mint), and `[rb107/exit-shape]` gaining a
`?`-by-depth census. The RED record (stages: pins alone; build; status-quo body; no-fallback;
loop-bound drifts; wiring left on `now`; `unwrap_or(now)` at the call site) lives in the harness
ledger at `memory/projects/gates/rb-111.red-before.md`.
