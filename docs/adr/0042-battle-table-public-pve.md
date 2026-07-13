# 0042. Battle table is public (PvE scope)

**Status:** Accepted
**Date:** 2026-06-26
**Slice:** m7b
**Supersedes:** —
**Amends:** —
**Subsystems:** battle, security-authz
**Decision:** Battle table is public for PvE scope; derived stats are acceptable to expose for NPC opponents; revisit per-side privacy when PvP ships in M16.

- Status: accepted
- Date: 2026-06-26
- Milestone: M7b (server reducers + battle table)

## Context and problem statement
M7b introduces a `battle` table storing `BattleState` (which includes `BattleMonster` structs with
derived stats for both sides). The table must be accessible to the client so it can render battle UI.
SpacetimeDB offers two visibility modes: `public` (all subscribers see all rows) and `private` (only the
module can read rows; clients must use reducers to query).

The `BattleState` column contains derived stats (`stat_attack`, `stat_defense`, etc.) for both sides.
Derived stats are partially invertible to recover IV values (see ADR-0015, ADR-0040). For PvE, the
opponent is an NPC with no private genes, so leaking derived stats is acceptable. For PvP (M16), this
becomes a CRITICAL information disclosure — an opponent could infer another player's IVs.

## Decision
The `battle` table is **public** for M7b (PvE only).

Constraints:
- **PvP (M16) must not reuse this schema without mitigation.** Options include: a private battle table
  with reducer-mediated reads that redact opponent stats, or a split projection (public summary +
  private detail).
- `BattleEvent` is transient (returned by the resolver, never stored). It MUST NOT derive
  `SpacetimeType` — doing so would make new variants a breaking wire-format change. See the comment
  on `BattleEvent` in `game-core/src/combat/types.rs`.
- Event delivery (battle log / animation queue) is out of scope for M7b. The resolver's `Vec<BattleEvent>`
  is currently discarded at the server layer. M14 must decide whether to store events or push them
  via a separate mechanism.

## Consequences
- Clients can subscribe to the `battle` table and render battle UI directly from `BattleState`.
- NPC derived stats are visible to all subscribers — accepted for PvE.
- M16 PvP is blocked from using the current public schema without a privacy mitigation (tracked as a
  hard constraint).
- No additional RLS or row-level filtering is needed for M7b.

## Amendment (M8.5a, 2026-06-27): side-B no-write invariant

M8.5a (battle security & integrity) closes the `start_battle` opponent-provenance hole (ADR-0048).
While auditing the battle-end path, the **side-B no-write invariant** was made explicit and recorded
here, since it is the privacy/semantics rationale that lives with the battle table:

- **Invariant.** AFTER any battle ends (win / loss / flee / recruit), every **side-B (opponent)**
  `monster` and `monster_pub` row is left **byte-for-byte unchanged**. The post-battle write-back
  (`write_back_party_hp` / `write_back_battle_results` in `server-module/src/lib.rs`) mutates **only
  side-A** (the caller's party): HP write-back for everyone, XP for the winner's team. Side-B is
  never read for mutation.
- **Why this is intentional PvE semantics, not an omission.** Two reasons:
  1. **Today's opponents have no persistent rows to write.** A wild opponent is unowned
     (`opponent_identity == WILD_IDENTITY`, ADR-0045 — no `monster` row exists). A self/sandbox
     opponent (`opponent_identity == ctx.sender`, ADR-0048) shares the caller's own rows, which are
     already covered by the side-A write-back; double-writing them would be incoherent.
  2. **Symmetric side-B write-back would be a security regression on the current code, not a feature.**
     Persisting damage to side-B rows only makes sense with **per-side authority** (each side's owner
     consents and controls their own monsters). Without that — i.e. on every code path that exists
     today — writing side-B back would turn a bounded info-leak/grief bug into **persistent,
     non-consensual mutation** of a victim's monsters. The opponent-provenance fix (ADR-0048) removes
     the foreign-opponent path; symmetric write-back is the *opposite* direction and is **deferred to
     M16/ADR-0017 (real PvP + per-side authority)**. It is explicitly **NOT** added in M8.5a.
- **Mechanical guard.** `evals/battle-reducer-security.eval.mjs` statically asserts the write-back
  helpers reference only `side_a` for row mutation (it bites if a `side_b` write is added). The
  broader mechanical dual-write (`monster` ↔ `monster_pub`) parity proof-of-teeth is M8.5c.
- **Reference:** ADR-0048 (opponent provenance — the sibling fix), ADR-0045 (`WILD_IDENTITY` / wild
  opponent has no row), ADR-0017 (PvP — where symmetric per-side write-back belongs).
