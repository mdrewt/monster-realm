---
type: SpacetimeDB Reducer
title: set_move
slug: reducers/set_move
updated: 2026-07-15
tags: [reducer, spacetimedb, movement]
abstract: "Replace the ENTIRE undrained queue with one input (a responsive turn/direction change). Cap-safe (length 1)."
resource: server-module/src/movement.rs#L135
source: scripts/okf-export.mjs@server-module/src/movement.rs
---

## Signature

```rust
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String>
```
