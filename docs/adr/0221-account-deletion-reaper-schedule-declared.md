# 0221 — AccountDeletionReaperSchedule ships atomically with a guarded no-op reaper, classified NotOwned, armed/disarmed only by delete/cancel

**Status:** Accepted
**Date:** 2026-08-31
**Slice:** rb-24 (residual R-m22-s2-X15; the schema-declaration slice the M22 spec table named m22-s3)
**Supersedes:** —
**Amends:** ADR-0207
**Subsystems:** schema-persistence, security-authz, ci-gates
**Decision:** `account_deletion_reaper_schedule` lands additively WITH a scheduler-guarded no-op `account_deletion_reaper` (scheduled-ness is migration-frozen), classified NotOwned, armed only by delete_account, disarmed only by cancel_account_deletion.

---

## Context and problem statement

M22 S2 (ADR-0207, PR #373) shipped the data-lifecycle manifest, `Account.terminal_at_ms`, and
`export_bundle`, but deferred the `AccountDeletionReaperSchedule` declaration to its own slice
(residual X15; the spec's own table called that owner m22-s3, now tracked as rb-24). The M22 spec
section 4.4 fixes the row shape; PRV1-1 and PRV1-3 fix the wiring: `delete_account` inserts exactly
one pending row, `cancel_account_deletion` deletes that identity's pending row. The cascade, the
PRV1-5 fire-time recheck, and the terminal-cancel guard are S3's (and rb-21's) — NOT this slice.

The load-bearing platform constraint (measured, memory card + republish probe X9): a table's
`scheduled(...)` attribute is frozen by automigration — a table published without it cannot gain it
later without a destructive republish. So "declare the table now, add the reaper in S3" is
impossible; the reducer must exist in the same publish as the table.

## Decision

1. **Table exactly per spec section 4.4**, colocated PRIVATE in `accounts.rs` (the ADR-0056
   exception, mirroring `GuestClaimReaperSchedule` byte-for-byte in idiom): `scheduled_id`
   (pk, auto_inc), `scheduled_at: ScheduleAt`, `account_identity: Identity` with a btree index.
   Deliberately NO timestamp field (ADR-0126 D6): staleness can only ever derive from the live
   `account` row plus the injected clock, never from anything a caller could supply.
2. **A deliberate no-op reaper ships with it.** Body = scheduler-only guard (first statement,
   reject form) then `Ok(())`. S3 replaces the body with the PRV1-5 recheck + PRV1-6 cascade; the
   gating test `rb24_deletion_reaper_body_is_frozen_noop` pins the body by squashed EQUALITY and is
   DESIGNED to red when S3 lands — that red is S3's reminder to take ownership, not a regression.
   Until S3, a fired reaper no-ops and the runtime deletes the fired one-shot row: an account can
   then sit `PendingDeletion` unarmed. That is the expected S2-era shape; S3 inherits those
   accounts (Residuals R2).
3. **Fire time** = `deletion_requested_at_ms + game_core::DELETION_GRACE_MS_DEFAULT`, computed by a
   new pure seam `deletion_fire_at_ms(requested_at_ms)` in `accounts.rs`, converted saturating
   ms-to-us exactly like `arm_claim_reaper`. The reducer binds ONE `now = now_ms(ctx)` and feeds
   the SAME value to `requested_deletion` and `arm_deletion_reaper`, so the stamped timestamp and
   the fire time cannot diverge (gating tests pin the single binding — a shadowed `now` was a
   measured red-team cheat that nulls the grace window).
4. **Arm last, disarm gated.** The schedule insert is `delete_account`'s LAST step (after the
   status write); the disarm in `cancel_account_deletion` sits INSIDE the `needs_cancel_write`
   branch, after the account update — AUTH-38's "no write when already Active" contract survives,
   and an Active account owning a schedule row is unrepresentable in this slice by construction
   (sole inserter is the Active-to-Pending transition; sole other Active-setter is cancel itself).
5. **Manifest classification: `NotOwned`.** `Erase` would create a false S3 obligation: [DEL-04]
   would demand a cascade-body delete of the very table whose fired row the runtime already
   deletes — the C3 self-disarm anti-pattern AUTH-27 bans for the guest reaper. `NotOwned`'s basis
   is structural: the row is armed only by the account holder's own `delete_account`, deleted by
   cancel or consumed by its own firing, and never survives the cascade it triggers.
6. **Rekey policy: EXEMPT** for `account_deletion_reaper_schedule.account_identity`, with a
   truthful reason: the column always names a live account holder (arm is reachable only from
   `delete_account`, which requires an existing `account` row; `start_guest_claim` rejects account
   holders per AUTH-7), so a claim never retires an identity this column references. Verified — NOT
   an `export_bundle.owner_identity`-style honest-limit case.

## Rejected alternatives

- **An insert-if-missing re-drive branch in `delete_account`** (spec section 4.2's "always safely
  re-driveable by a repeat delete_account" sentence invites it). Rejected: a SpacetimeDB reducer is
  one transaction (ADR-0106 D8) — the status write and the schedule insert cannot separate, so the
  state "PendingDeletion + no schedule row" is unreachable by crash within this slice. The branch
  would break AUTH-28's "second call writes nothing" pin to defend against a state that cannot
  occur. (After a fired no-op reaper it CAN occur — see Residuals R2, owned by S3.)
- **`Erase` classification** — see Decision 5.
- **Table-only now, reducer in S3** — impossible; `scheduled` is automigration-frozen (X9 control
  measures the rejection).
- **A pre-gate defensive disarm in cancel** — breaks AUTH-38 in exactly the case it claims to
  defend; the state it defends against is unrepresentable here.
- **Putting `deletion_fire_at_ms` in game-core** — game-core is outside this slice's touches; the
  seam lives in `accounts.rs` with a parity test against `is_deletion_due`. Residual R5 flags the
  future single-owner consolidation.

## Known limits (measured)

- **Saturation divergence:** `deletion_fire_at_ms` saturates (`saturating_add`), while
  `is_deletion_due` computes `now.saturating_sub(requested) >= GRACE`; for
  `requested_at_ms > i64::MAX - GRACE` the armed fire time is NOT "due" by `is_deletion_due` —
  an account armed there would stick `PendingDeletion` forever once S3's recheck lands. Not
  reachable for real clock values; pinned by its own named test and scoped out of the parity test.
- **ADR number:** the launch brief assigned 220, which rb-22 consumed the same day
  (`docs/adr/0220-*`); this ADR takes 221 per `mr-state.json adr_next_free`. Supervisor flagged.

## Residuals (S3/rb-21 obligations this slice creates)

- **R1** S3 replaces the no-op body (PRV1-5 recheck + PRV1-6 cascade) and deliberately retires
  `rb24_deletion_reaper_body_is_frozen_noop`; it must factor `resolve_all_live_interactions` from
  `lib.rs:214-231`, never hand-roll the bundle (spec section 4.4 step 1).
- **R2** Accounts left `PendingDeletion`-and-unarmed by a fired no-op reaper during the rb-24 era:
  S3 must define the re-arm/recovery path.
- **R3** rb-21's terminal-cancel guard (PRV1-4) must be inserted BEFORE this slice's disarm in
  `cancel_account_deletion`.
- **R4** The `NotOwned` classification is truthful only while the reaper is the sole cascade
  driver; a non-reaper driver (admin path, PRV1-8b reactivation) forces re-classification, and
  PRV1-8b must also disarm on reactivation.
- **R5** Consolidate fire-time arithmetic into game-core when a slice owns that file (single-owner
  SSOT for `requested + GRACE`).
- **R6** The scheduler-guard needle used by the shipped gates is prefix-forgeable (`{return`
  matches `{returned_...(...)`); this slice hardens its own test and the shared eval clause —
  measured against the shipped `guest_claim_reaper` gate too.
