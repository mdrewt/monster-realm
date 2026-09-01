# 0228 — S3b: the §4.4 deletion cascade via per-module erase/anonymize delegation, one-shot re-arm + sweep, and PRV1-8(b) fresh re-registration

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s3b
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, schema-persistence, ci-gates
**Decision:** S3b lands the §4.4 cascade via per-module `erase_*`/`anonymize_*` delegation, re-arms the one-shot reaper (not-due branch + init/sync sweep), ships PRV1-8(b) fresh re-registration, and re-pins the reaper body pin.

---

## Context and problem statement

ADR-0225 right-sized m22-s3 and handed this slice an atomic remainder: the
`resolve_all_live_interactions` extraction, per-module erase/anonymize helpers (G5
MODULE_WRITE_ISOLATION closes `accounts.rs`'s write set at its four owned tables), the five-step
cascade in `account_deletion_reaper`'s fall-through, PRV1-19, the PRV1-6e terminal stamp, the
one-shot re-arm obligation, the frozen-body tripwire, and — per ADR-0225's sequencing constraint —
PRV1-8, resolved by the operator on 2026-09-01 as Option B (issue #403: "A fully deleted account
should leave no orphaned data... treat all unrecognized OAuth identities like fresh accounts").

## Decision

1. **D1 — helper naming/shape convention.** Owning modules gain `pub(crate) fn erase_<noun>(ctx,
   owner: Identity)` / `anonymize_<noun>(ctx, owner: Identity)`, mirroring the `rekey_*` delegation
   precedent, placed beside their `rekey_*` siblings, **infallible `-> ()`** (a reducer is one
   transaction; an `Err` mid-cascade buys only a skippable branch — `rekey_monsters` is fallible
   solely for its `monster_pub` tier copy-forward, which an erase does not have). Banned substrings
   in every new identifier: `rekey`, `purge_export_bundles`, `tombstoned_profile` (census-perturbing
   or sentinel-confusing). Every helper's row mutation goes through a pure seam (the
   `zeroed_wallet`/`profile_with_carried_stats` precedent) so its property is a behavioral test.
   `export_bundle`'s erase REUSES `privacy::purge_export_bundles` (rb-22) — no new helper.
   Two ownership notes: `player` has no single owning module (accounts.rs's own doc says so) — its
   display-name anonymize lives in `ranking.rs`, the module that already owns the display-name
   write path (`set_profile_name`); and `pvp_deadline_schedule`'s sweep is a
   `pvp::disarm_pvp_deadlines(ctx, battle_id)` helper (pvp.rs is its sole writer), called from
   `battle::anonymize_battles` — the delegation doctrine is not broken for that one table.

2. **D2 — cascade order, and two deliberate deviations from a literal 6b→6c→6d split.**
   The reaper body: scheduler guard → row lookup → one clock read → recheck (with re-arm, D3) →
   6a `resolve_all_live_interactions` (extracted into `lib.rs`, the four calls verbatim in the
   `on_disconnect` order; shared by both callers so a future fifth resolver is picked up by both) →
   6b the delegated ERASE calls in manifest order → `erase_character_rows` **before**
   `anonymize_display_names` (the §4.4 character-before-player pin) → `battle::anonymize_battles` →
   6e `update(terminal_account(anonymized_account(account), now))` **last**. Deviations: (a) a
   JOIN_ONLY *schedule* table is swept inside its parent's erase helper (the existing
   `disarm_trade_reaper`/challenge-disarm orphan-prevention idiom); (b) `battle`'s joins
   (`battle_wild`, `pvp_deadline_schedule`) are swept **per row, before that row's identity swap**
   — after the swap the join key no longer names the deleting identity, so a literal 6c-then-6d
   order is unimplementable. PRV1-19: battle rows are collected dedup-by-construction
   (`player_identity` filter, then `opponent_identity` filter excluding rows already matched), and
   the pure `battle_with_tombstoned_party` swaps **each** matching side — a practice battle gets
   both sides swapped in one visit, one update. `anonymize_battles` processes **only battles with a
   settled/terminal outcome** and collects both filter passes before any mutation: an `Ongoing` row
   at step 6c means step 6a's resolver failed on it (an already-logged anomaly), and sweeping its
   live `pvp_deadline_schedule` row would remove the only mechanism that can ever settle it,
   soft-locking the surviving opponent. Such a row is skipped (identity un-tombstoned) — a named
   failure-path residual, not silent.

3. **D3 — re-arm design.** The runtime deletes a fired one-shot schedule row regardless of reducer
   outcome, so: (a) the not-yet-due recheck branch re-arms via `arm_deletion_reaper` from the row's
   **own** `deletion_requested_at_ms` (never `now + GRACE`, which would extend the window on every
   fire). `reaper_rearm_at_ms` resolves the request stamp FIRST (`let requested =
   account.deletion_requested_at_ms?;`) — on the illegal `PendingDeletion` + `None` shape it
   returns `None` (no re-arm, fail-closed; `.unwrap_or(..)` spellings are each a disguised
   `now`-relative re-arm or an epoch-past hot loop), and it is defined directly
   (`PendingDeletion && !marker && !is_deletion_due`), never as `!reaper_should_run_cascade`,
   which is also true for Active and terminal rows and would re-arm an erased account forever.
   Loop-freedom holds for every wall-clock-representable stamp: not-due ⟺ `now - requested <
   GRACE` ⟺ `deletion_fire_at_ms(requested) > now`, saturating on both sides. The one divergence
   band (`requested > i64::MAX - GRACE`, ADR-0221 Known limits) clamps the fire instant to
   `i64::MAX` — the row simply never fires again (a permanent no-op, not a hot loop), unreachable
   for real stamps since only `delete_account` writes the column from `now_ms(ctx)`. (b) The ADR-0221 R2 population (rows already `PendingDeletion` with
   their one-shot long fired) is swept by `accounts::ensure_deletion_reapers_armed`, called from
   `init` and `sync_content` beside `ensure_playtest_reaper`/`ensure_mr_heartbeat`; the body lives
   in `accounts.rs` because the sole-writer teeth close the schedule table to every other module.
   Idempotent via the pure `plan_deletion_rearms` seam (the `plan_schedule_reconcile` shape): never
   arms an identity that already has a schedule row, skips Active and terminal rows. A past-due
   fire time is legal (`ScheduleAt::Time` in the past fires immediately).

4. **D4 — PRV1-8(b), the operator's Option B.** `provision_or_touch_account`'s `Some` branch gains
   a first match-guard arm: a row carrying the terminal marker is reset via
   `update(new_account_row(ctx.sender(), issuer.to_string(), now))` — every field at fresh
   defaults, `identity`/`auth_issuer` supplied by the live connection, NO pre-deletion value
   carried forward (created/last-login stamps, claim provenance, deletion stamps all reset). The
   marker **half** (`account_has_terminal_marker`), not §4.1's conjunction, keys the guard — on the
   illegal `Active`+marker shape a fresh reset is the fail-closed direction (the erased account
   stays erased; nothing pre-deletion survives). This lands in the SAME slice that first stamps
   `terminal_at_ms: Some` (this one, PRV1-6e), per ADR-0225's arming constraint.
   Two named deviations this reset creates, each bounded: (i) AUTH-14's "one claim per account,
   ever" becomes per-incarnation — the reset clears `claimed_from`, so a delete→reap→re-register
   cycle restores a spent claim slot; the yield is at most one starter monster per grace window per
   OAuth identity, no better than minting a new OAuth account, which is exactly the equivalence
   Option B accepts (and any identity with a surviving `profile` row is blocked from claiming by
   Guard 11 anyway). (ii) The surviving `profile` row (ANONYMIZE, never deleted per ADR-0119) makes
   `account_has_game_data` true forever, so a re-registered identity can never complete a guest
   claim — correct fail-closed behavior given the surviving ladder row, recorded as an Option-B
   limitation rather than papered over.

5. **D5 — `account_state_is_legal` stays `debug_assert!`; no release `debug-assertions`, no `Err`
   promotion** (resolves R-m22-s2-S3-CANCEL-TERMINAL's re-pointed half). The terminal write's
   legality is a theorem: `reaper_should_run_cascade` establishes `PendingDeletion` with a `Some`
   request stamp, and neither `anonymized_account` nor `terminal_account` touches `status`, the
   request stamp, or the claim pair — legality holds by field-disjointness, and both constructors
   carry the same `debug_assert!` as their siblings. Rejected: (a) enabling `debug-assertions` in
   the release module profile arms every `debug_assert` in the crate as a production abort (e.g.
   battle.rs's per-row assertion inside a delete loop) — out of proportion for one theorem;
   (b) promoting to `Err` rewrites seven constructor signatures and every call site for a state the
   recheck already excludes. The reachability worry is closed on the reachability axis instead: the
   re-pinned body test asserts `terminal_account(` appears exactly once, after the recheck, as the
   last account update.

6. **D6 — AUTH-13 message split** (discharges the ADR-0225 obligation). `complete_guest_claim`
   Guard 3 discriminates: a terminal-marker destination is refused with the distinct
   `REJECT_ALREADY_DELETED` reason; the mid-grace state keeps the generic "account pending
   deletion". Guard order (caller-state before code-resolution) is unchanged.

7. **D7 — gate loosenings, each paid for.** (a) The rb-24 frozen-noop reaper pin is RE-PINNED (not
   retired) to the cascade body under the accurate name
   `rb24_deletion_reaper_body_is_pinned_cascade`, with plan-authored polarity/subject/ordering
   needles asserted before the exact-equality literal. (b) `accounts.rs`'s
   `purge_export_bundles` naming budget widens 1→2 (claim purge + cascade), compensated by a
   scoped pin (one call in `complete_guest_claim`, one in the reaper, zero elsewhere). (c) The ux2
   wallet never-delete gate gains a single-fn exemption for `erase_wallet` **by name**, with an
   exact-body pin on the sanctioned PK delete and an exercised (non-vacuity) clause — the
   `player_wallet` manifest policy is ERASE (spec §3), so the M22 cascade is the one sanctioned
   deleter. (d) `ea_pvp_05`/`ptc5b_4` are TIGHTENED from whole-file `lib.rs` scans to the extracted
   resolver's body, restoring the gate strength the extraction would otherwise silently dilute.
   (e) TR-18 is deleted from `trade-reducer-security.eval.mjs` (17→16 criteria) and ported as the
   two-link Rust chain test `m22s3b_resolver_extraction_chain` (on_disconnect→resolver AND
   resolver→cancel_trades_on_disconnect) per ADR-0224 — the scanner is not patched; this is a
   declared spec-§7.2 shared-eval-edit WARN for the supervisor to reconcile, and the
   on_disconnect→resolver link is twinned into `pvp_tests.rs` so a pvp-side regression fails in the
   pvp file. (f) The rb-24 arm-call census widens 2→4 (`delete_account` + the reaper's not-due
   re-arm + `ensure_deletion_reapers_armed`), compensated by per-site scoped pins with pinned
   argument lists — never a bare bumped number. (g) `ranking.rs`'s whole-file
   `profile().identity().update(` backstop widens 4→5, compensated by a per-fn pin
   (`anonymize_display_names` exactly 1). (h) `set_profile_name` gains the §4.7 deletion gate
   (`guards::require_not_deleting`, the ADR-0227 call-site shape): it writes an
   ANONYMIZE-classified table, and without the gate a connected terminal session un-tombstones its
   own display name one call after the cascade — hollowing PRV1-6c. `join_game` (movement.rs, out
   of this slice's touches) has the same §4.7 exposure and is recorded as a residual for the S6
   [DEL-06] enforcement, not silently absorbed.

## Considered alternatives

- **Widen G5's OWNED_TABLES so the cascade writes live in `accounts.rs`** — rejected in ADR-0225
  already; delegation follows the `rekey_all` precedent.
- **Zero-out the wallet instead of deleting** (avoiding the ux2 exemption) — rejected: spec §3 and
  `DATA_LIFECYCLE_MANIFEST` classify `player_wallet` ERASE; a surviving zeroed row is exactly the
  "orphaned data" Option B rules out, and the exemption is single-fn, shape-pinned, exercised.
- **A durable cursor / multi-invocation cascade** — rejected now (YAGNI, spec §4.5): one reducer,
  one transaction, matching `rekey_all`'s proven walk; volume risk stays escalated (§8.3).
- **Adding btree indexes for the unindexed sweeps** (`playtest_event.identity`,
  `battle_action.player_identity`, `pvp_deadline_schedule.battle_id`) — rejected: no schema changes
  in this slice; linear scans are correct and the volume concern is the same §8.3 residual.

## Consequences

- The reaper actually deletes: M22's §7.2 spine (S6/S7 → S8 → S9) is unblocked; `terminal_at_ms:
  Some` becomes reachable, and every terminal-guard shipped in m22-s3 goes live.
- The §9.1 pseudonymization limitation stands: direct name/display fields are severed on deletion;
  the `Identity` key and behavioral history on multi-user/historical rows are tombstone-swapped or
  retained per the manifest — documented as pseudonymization, not full erasure.
- The `player`/`character` cascade steps are usually no-ops (presence rows are deleted on
  disconnect, and a deleting account is typically offline) — they exist for the connected-at-fire
  edge and the §4.4 order pin; a reviewer should not read the no-op as a bug.
- Two full-table linear sweeps (`playtest_event`, `battle_action`/`pvp_deadline_schedule`) ride the
  cascade transaction — accepted under the §8.3 escalated volume risk.
- The `ensure_deletion_reapers_armed` sweep runs on every `sync_content` publish — idempotent, and
  exposure is nil until `ALLOWED_ISSUERS` leaves its fail-closed placeholder. A publish that
  re-arms N overdue accounts fires N cascades back-to-back, each with two unindexed full-table
  sweeps — inside §8.3's escalated volume residual, multiplied by publish frequency.
- PRV1-7's crate-wide [DEL-06] enforcement mechanism remains deferred to S6 pending the
  supervisor's ADR-0224 ruling (gate X18 DEFER in this slice's ledger).
- **Deletion-completeness limitations, named (the §9.1 pseudonymization class):**
  (i) `profile.rating`/`wins`/`losses` survive (spec §3 anonymizes `name` only) and, after a
  PRV1-8(b) re-registration, the ADR-0125 passive mirror (`refresh_profile_name`) overwrites the
  tombstone with the new live name on the next rated game — the ladder history re-attaches to the
  new incarnation of the same Identity. (ii) `account.last_login_at_ms` (plus the deletion
  ceremony's own `deletion_requested_at_ms`/`terminal_at_ms` stamps) is retained — spec §3's
  retained-column list is silent on it; scrubbing it would deviate from the shipped manifest basis,
  so it is recorded instead. (iii) A third party's `export_bundle` snapshot can contain the deleted
  player's identity and monster nicknames (`trade_offer` chunks); the owner-scoped purge cannot
  reach it, so the S4b PRV1-14 TTL reaper is a deletion-completeness dependency, not mere hygiene.
  (iv) Third parties can still open TTL-bounded commitments (`battle_challenge`/`trade_offer`)
  NAMING a deleted identity — the §4.7 gate is caller-only by design. (v) A settled battle between
  two deleted accounts carries the tombstone on both sides, which `is_ranked_pvp`'s
  `player != opponent` test reclassifies as practice — data-only today, no live consumer.
- **The ux2 wallet-delete exemption knowingly breaks the ADR-0154 client wallet contract on this
  one path**: a view UPDATE is delivered as onInsert+onDelete, so the client wallet slot has no
  remove path and a connected-at-fire session renders a stale balance. Accepted because the only
  subscriber of the deleted row is the terminal account's own doomed session; S8 (client
  deletion/export UX) owns any client-side handling.
- **Online-at-fire is a real state, not a no-op**: against a connected session the cascade
  force-resolves live battles/trades, erases monsters/inventory/wallet, deletes `character` while
  `player` survives (a pairing no other code path produces — verified panic-free: every
  `character` read in the tree is `let Some(..) else`), and renames the live player to the
  tombstone. The client experience of that session is S8's concern; the server-side state is
  correct and terminal.
- **Double-fire is a clean no-op**: a second schedule row for the same identity finds the terminal
  marker — `reaper_should_run_cascade` false, `reaper_rearm_at_ms` None — so it neither cascades,
  re-arms, nor needs a self-disarm (the D6 anti-pattern stays intact).
- S6's `[DEL-04]` contract changes shape under delegation: the reaper body names helpers, not
  table identifiers, so the eval's per-table presence check must consume the totality-driven
  table→helper map that `m22s3b_cascade_covers_manifest` pins (exhaustive `DeletionPolicy` match,
  fail-loud on an unmapped entry) — the map is a named drift surface of the same class as
  `JOIN_ONLY_TABLES` (spec §9 residual 3).
