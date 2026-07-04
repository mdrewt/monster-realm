---
type: SpacetimeDB Reducer
title: movement_tick
slug: reducers/movement_tick
updated: 2026-07-03
tags: [reducer, spacetimedb, movement]
abstract: "Per-zone, server-paced tick: drain ≤1 move per character in THIS zone, compute the outcome via `game_core::apply_move`,…"
resource: server-module/src/movement.rs#L154
source: scripts/okf-export.mjs@server-module/src/movement.rs
---

## Signature

```rust
pub fn movement_tick(ctx: &ReducerContext, sched: MovementTickSchedule) -> Result<(), String>
```
