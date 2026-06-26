# 0040. RLS fallback: private table + public projection for monster privacy
- Status: accepted
- Date: 2026-06-26

## Context and problem statement

ADR-0015 specifies owner-scoped RLS (`client_visibility_filter`) as the primary
privacy mechanism for the `monster` table, with a split-table fallback (private
table + public projection) if RLS is insufficient or the stakes are too high.

M6b ships the monster tables. Before implementation, we confirmed the RLS status
of the pinned toolchain (SpacetimeDB crate 1.12 / CLI 2.6.0). Finding: the
`client_visibility_filter` proc-macro attribute **compiles** but the host
**does not enforce it** — the installed crate source contains
`#[doc(inline, hidden)] // TODO: RLS filters are currently unimplemented, and
are not enforced.` Monster genes (IVs, EVs, nature) are stakes-classified data
(ADR-0015) whose leak would undermine competitive integrity.

## Considered alternatives
- Option A — Ship monsters in a `public` table with `client_visibility_filter`
  and rely on RLS enforcement. Rejected: enforcement is confirmed absent in the
  pinned crate; hidden genes would be readable by any subscribing client.
- Option B — Wait for STDB to ship RLS enforcement before implementing monsters.
  Rejected: blocks the entire progression subsystem on an upstream dependency with
  no published timeline.
- Option C — Split-table architecture: a **private** `monster` table (hidden
  genes, not subscribable) plus a **public** `monster_pub` projection (safe
  fields only). Server maintains dual-write discipline. Codegen skips the private
  table (`spacetime generate` confirms: "Skipping private tables during codegen:
  monster, movement_tick_schedule.").

## Decision outcome
- Chosen: Option C (split-table fallback), because RLS is confirmed
  non-functional in the pinned version, the data is stakes-classified, and the
  fallback delivers the privacy guarantee without upstream dependency.
- Consequences:
  - **Positive:** Hidden genes never reach non-owner clients at the transport
    level (not just filtered in UI). A `monster-privacy` eval with proof-of-teeth
    mechanically enforces the invariant.
  - **Negative:** Dual-write discipline adds maintenance cost — every reducer
    that mutates `monster` must also update `monster_pub`. No schema-level FK or
    trigger enforces consistency; programmer discipline + eval gate only.
  - **Known residual risk:** Derived stats exposed in `monster_pub` are partially
    invertible (the stat formula is public and deterministic). At low levels with
    zero EVs, an attacker can recover a combat-equivalent IV set from the public
    stats. This is a design-level trade-off: stats must be visible for combat UI.
    Mitigations (stat obfuscation, owner-only stat visibility) are deferred to a
    future milestone when RLS enforcement ships or a per-client query mechanism
    becomes available.
  - **Follow-up:** When STDB ships RLS enforcement, re-evaluate merging the two
    tables back into one `public` table with `client_visibility_filter`. Track
    via the validation checklist (Tier-1 #1).
