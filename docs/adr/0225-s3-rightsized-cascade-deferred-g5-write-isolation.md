# 0225 — S3 right-sized: guards + recheck + gate predicate ship in accounts.rs; the PRV1-6 cascade defers to S3b behind G5 write isolation

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s3
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, schema-persistence, ci-gates
**Decision:** S3 ships the terminal-cancel guard, the reaper recheck skeleton and `should_reject_for_deletion` in accounts.rs; the PRV1-6 cascade defers to S3b — G5 write isolation demands per-module erase helpers outside S3's touches.

---

## Context and problem statement

The M22 spec (§7.2) declares S3's touches as `accounts.rs` (reducer bodies) + `lib.rs` (the
`resolve_all_live_interactions` extraction) and its scope as "cascade + reaper + cancel-disarm".
Building it surfaced a spec gap the M22 ceremony never reconciled:

1. **G5 MODULE_WRITE_ISOLATION** (ADR-0179 D0; live gate in `evals/guest-claim-integrity.eval.mjs`
   plus the Rust twin `[rb24/owned-set-closed]` in `accounts_tests.rs`) closes `accounts.rs`'s write
   set at exactly {`account`, `guest_claim`, `guest_claim_reaper_schedule`,
   `account_deletion_reaper_schedule`} and bans even the literal `ctx.db.battle(` in that file.
   Every foreign-table write must be delegated to the owning module — the `rekey_all` precedent.
   **No erase/anonymize helper exists in any owning module today** (the only lifecycle helper
   outside `accounts.rs` is `privacy.rs`'s `purge_export_bundles`, rb-22's export purge). So the
   PRV1-6b/c/d sweeps — and with them 6a's wiring, 6e's terminal stamp and PRV1-19 — structurally
   require new helpers in roughly ten modules outside S3's declared touches.
2. **The `lib.rs` extraction reds an out-of-touches eval.** `evals/trade-reducer-security.eval.mjs`
   TR-18 requires `on_disconnect`'s extracted body to contain the literal
   `cancel_trades_on_disconnect`; delegating the four resolver calls into
   `resolve_all_live_interactions` empties that needle. With the cascade (the seam's only new
   consumer) deferred, the extraction defers with it rather than shipping a one-caller seam.

Under the supervised loop's scope doctrine (an out-of-touches file the task requires is a
hidden-dependency stop) the slice was right-sized: ship every coherent, safe increment the declared
touches admit; defer the rest with explicit ledger targets so the supervisor re-serializes the
remainder as a properly-scoped slice (called **S3b** below).

## Decision

1. **Shipped in this slice** (all inside `accounts.rs` + `accounts_tests.rs`):
   - **PRV1-4** — `cancel_account_deletion` gains a terminal guard placed after the account lookup
     and before the AUTH-38 `needs_cancel_write` gate, rejecting with the distinct static reason
     `REJECT_ALREADY_DELETED` ("this account has already been permanently deleted"). On every legal
     state the placement is behaviorally neutral (a legal terminal row is `PendingDeletion` and
     passes the gate either way); guard-first is fail-closed on the *illegal* `Active` +
     `terminal_at_ms: Some` shape, whose only runtime defense (`debug_assert!` in
     `cancelled_deletion`) is compiled out in release. The name `REJECT_ACCOUNT_DELETED` is
     deliberately NOT used — the spec reserves it for the blocked PRV1-8(a) alternate.
   - **Defense-in-depth twin** — `delete_account` gains `if account_has_terminal_marker(&account)
     { return Ok(()); }` before its `needs_deletion_write` gate. The `Ok` shape (not a reject)
     preserves PRV1-2's letter (a terminal account IS status-`PendingDeletion`, so a second
     `delete_account` SHALL return `Ok(())`), while closing a measured laundering path: on the
     illegal `Active`+`Some` shape, `needs_deletion_write(Active)` is true, so the old body would
     rewrite the row into a *legal* `PendingDeletion`+terminal state and re-arm a second cascade
     against an already-erased account.
   - **PRV1-5 (decision seam + skeleton)** — pure
     `reaper_should_run_cascade(&Account, now_ms) -> bool`, defined DIRECTLY as
     `status == PendingDeletion && !account_has_terminal_marker(..) && is_deletion_due(..)`
     (mirroring spec §4.5 verbatim, deliberately NOT composed over `should_reject_for_deletion` so
     a future widening of the gameplay gate can never silently widen what the reaper erases), and
     the reaper body becomes: scheduler guard (unchanged first statement) → account lookup by
     `args.account_identity` (missing row → no-op) → recheck → deliberate documented no-op where
     S3b's §4.4 five-step cascade lands. The reaper stamps nothing and resolves nothing: stamping
     `terminal_at_ms` before the cascade exists is forbidden by PRV1-6e, and force-resolving live
     interactions without erasure would forfeit live battles/trades for zero deletion benefit.
   - **PRV1-7 (predicate half)** — pure `should_reject_for_deletion(&Account) -> bool`
     (`PendingDeletion` OR terminal marker, an explicit disjunction that never leans on the
     legal-state invariant), plus `is_pending_deletion`'s body delegating to it
     (`.is_some_and(|a| should_reject_for_deletion(&a))`). On all legal states the delegation is
     behavior-identical (terminal implies `PendingDeletion`); it makes `complete_guest_claim`'s
     Guard 3 terminal-aware and fail-closed on the illegal shape, and honors §4.7's "the same
     predicate problem, so one predicate".
2. **Predicate location is fixed here** (spec §7.3 wrongly implies game-core): the canonical
   symbol is `accounts::should_reject_for_deletion(&Account)`. It cannot live in `game-core`
   (it takes the server-module `Account` type). S5's `guards.rs` ctx-bound wrapper must DELEGATE
   to it, never re-derive the disjunction.
3. **Naming divergence, recorded:** spec §4.1 defines "terminal" as the conjunction
   `status == PendingDeletion && terminal_at_ms.is_some()`, while PRV1-4's own wording keys on the
   marker alone. The shipped helper is therefore named `account_has_terminal_marker` — deliberately
   the marker half, answering `true` on the illegal `Active`+`Some` shape (fail-closed at all three
   call sites) — and deliberately NOT `account_is_terminal`, which would collide with §4.1's
   defined term.
4. **Deliberate deviation from ADR-0221 R1:** that residual instructed S3 to *retire*
   `rb24_deletion_reaper_body_is_frozen_noop`. It is instead RE-PINNED to the new recheck skeleton
   (with plan-authored polarity and subject needles asserted before the exact-equality pin, so the
   pin cannot be regenerated around an inverted or mis-subjected body). The tripwire must survive
   until S3b lands the cascade; S3b retires or re-pins it WITH the cascade.
5. **Structure tests, justified once (ADR-0224):** reducer bodies have no runtime harness
   (`ReducerContext` is not constructible in unit tests), so the two wiring facts this slice must
   prove — guard order in cancel/delete, and the reaper skeleton's shape — are pinned by targeted
   source-structure assertions in `accounts_tests.rs`. Everything else ships as ordinary pure-fn
   behavioral tests. No new eval scripts, no meta-checks, no ratchets.

## Consequences and S3b handoff (the supervisor re-serializes these)

- **S3b owns, atomically:** the `resolve_all_live_interactions` extraction (+ the
  `trade-reducer-security` TR-18 migrate-or-edit under ADR-0224), per-module
  `erase_*`/`anonymize_*` helpers mirroring the `rekey_*` delegation precedent, the §4.4 five-step
  cascade in the reaper's fall-through, PRV1-19's practice-battle single visit, the PRV1-6e
  terminal stamp, and retiring/re-pinning the frozen-body tripwire. Touch list: `accounts.rs`,
  `accounts_tests.rs`, `lib.rs`, `trading/pvp/battle/monster_mgmt/inventory/economy/npc/raising/`
  `ranking/playtest/privacy` (+ their `_tests`), `evals/trade-reducer-security.eval.mjs`,
  `docs/knowledge/**`, `ARCHITECTURE.md`.
- **S3b must RE-ARM on the not-yet-due path.** The runtime deletes a fired one-shot schedule row
  regardless of what the reducer does, so the recheck's not-yet-due no-op drops the schedule; the
  natural S3b edit ("fill the cascade in below the recheck") would leave those accounts
  permanently unswept. Same for ADR-0221 R2's inherited population (accounts already sitting
  `PendingDeletion` with their one-shot long fired): S3b needs a sweep/re-arm. Exposure today is
  nil — `ALLOWED_ISSUERS` is still the fail-closed `.invalid` placeholder, so no real account can
  be provisioned yet.
- **The debug-assertions half of R-m22-s2-S3-CANCEL-TERMINAL re-points to S3b.** This slice ships
  the guard half plus the constructor-level `#[should_panic]` test; the "enable
  `debug-assertions` in the release module profile or promote `account_state_is_legal` to `Err`
  guards" decision belongs with S3b, the first slice that actually writes `terminal_at_ms: Some`.
- **PRV1-7's crate-wide enforcement** ([DEL-06]: every reducer writing a manifest-classified table
  either calls the gate or is in `STATE_TRANSITION_OWNERS`) defers to S5/S6 where the call sites
  land — and its *mechanism* needs a supervisor decision under ADR-0224 (no new eval scanners; a
  `syn`-based check or an explicit reviewer-checklist item are the candidates).
- **PRV1-8 remains BLOCKED** on the operator ruling (issue #403, spec §8.2).
  `provision_or_touch_account`'s `Some` branch is untouched by this slice; the reactivation hole
  (§4.6) remains open by explicit instruction, and the shipped predicates make either alternate a
  small, well-seamed follow-up.
- Positive: every shipped symbol has a production caller (no `dead_code` allowances); the S5
  fan-out is unblocked (only S3 could ship the predicate — S5's touches exclude `accounts.rs`);
  the illegal-state laundering and silent-cancel-success paths are closed ahead of the cascade.
- Negative / accepted: the reaper remains functionally a no-op when due — deletion is still not
  actually performed anywhere; M22's §7.2 spine (S4/S5 after S3) now depends on S3b being
  scheduled promptly. The spec's S3 row and §7.3 contract table need a supervisor-side amendment
  to reflect the S3/S3b split and the predicate's real home.
