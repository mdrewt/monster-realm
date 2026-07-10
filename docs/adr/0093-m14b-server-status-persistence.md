# ADR-0093 — M14b: Server-side status-effect persistence

**Status:** Accepted  
**Date:** 2026-07-10  
**Deciders:** Drew Teter  
**Relates to:** ADR-0092 (M14a pure game-core status layer)

---

## Context

M14a (ADR-0092) shipped `StatusEffect`, `BattleStatusStore`, `StatusVariance`, and
`resolve_full_turn` as a pure game-core module with **no schema changes**.  Status
state lived only in memory for the duration of a single reducer call.

M14b persists that state to the SpacetimeDB `battle` table so it survives between
turns.

---

## Decisions

### 1. `StatusEffect` moved from `status.rs` to `types.rs`

`BattleMonster` (defined in `types.rs`) gains a `status: Option<StatusEffect>` field.
If `StatusEffect` stayed in `status.rs`, which already imports from `types.rs`, a
circular import would result.  Moving it to `types.rs` breaks the cycle.
`status.rs` re-exports it via `pub use super::types::StatusEffect` for backward
compatibility.

### 2. `BattleMonster.status` is additive with `#[serde(default)]`

The field is appended as the **last** field of `BattleMonster` and tagged
`#[serde(default)]`.  Old rows deserialise with `status = None` (no status effect),
preserving backward compatibility per ADR-0006.

### 3. `StatusCured` gains `slot: u32` (RT-S14-01 fix)

The `BattleEvent::StatusCured` variant previously carried only `side: SideId`.
When a bench-slot monster's status expired, the emitted event was indistinguishable
from an active-slot cure.  Adding `slot: u32` (zero-indexed team position) resolves
the ambiguity.  Test `rt_s14_01_bench_slot_status_cure_carries_correct_slot_index`
pins the fix with a teeth assertion on `slot == 1` for a bench cure.

### 4. `StatusVariance::from_ctx_random(seed: u32)`

Uses the same splitmix64 mixing as `TurnVariance::from_ctx_random` so a single
`ctx.random()` call deterministically seeds all six rolls.  The reducer calls
`ctx.random()` twice — once for `TurnVariance`, once for `StatusVariance` — keeping
the two variance sources independent.

### 5. `submit_attack` wires `resolve_full_turn` + status store

Build the store before the call:
```rust
let mut status = BattleStatusStore {
    side_a: battle.state.side_a.team.iter().map(|m| m.status).collect(),
    side_b: battle.state.side_b.team.iter().map(|m| m.status).collect(),
};
```
Call `resolve_full_turn` instead of `resolve_turn`.  Persist back via `zip`:
```rust
for (m, s) in battle.state.side_a.team.iter_mut().zip(status.side_a.iter()) {
    m.status = *s;
}
```
Full-team size (not active-only) so slot indices remain stable across switches.

`swap_active` does **not** call `resolve_full_turn` — it resolves only a monster
switch with no attack, so no status tick is needed.

### 6. Bindings-drift = 0

`just gen` regenerates `client/src/module_bindings/types.ts` to include:
- `StatusEffect` enum (`Poison`, `Burn`, `Paralysis`, `Sleep(u8)`, `Freeze`)
- `BattleMonster.status: option(StatusEffect)`

### 7. spacetime-types.json baseline bumped to 15 types

`StatusEffect` is now a `#[cfg_attr(feature="spacetimedb", derive(spacetimedb::SpacetimeType))]`
type tracked by the spacetime-type-snapshot eval (ADR-0076).  The baseline is
regenerated from source.

---

## Consequences

- Status effects now survive between turns — Poison/Burn DoT, Paralysis blocks,
  Sleep countdown, and Freeze thaw all persist across reducer calls.
- `BattleEvent::StatusCured` is a **breaking change** for any consumer that
  pattern-matches `StatusCured { side }` without `..`.  All in-repo match arms
  updated.
- Old `battle` rows without `status` fields deserialise safely to `None` per
  `#[serde(default)]`.
- Next free ADR number: **0094**.
