# 0042. Battle table is public (PvE scope)
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
