---
type: SpacetimeDB Reducer
title: enqueue_move
slug: reducers/enqueue_move
updated: 2026-07-10
tags: [reducer, spacetimedb, movement]
abstract: "Append one intent to the bounded queue (anti-flood: reject when full). Buffers intent only — NEVER computes movement. A…"
resource: server-module/src/movement.rs#L119
source: scripts/okf-export.mjs@server-module/src/movement.rs
---

## Signature

```rust
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String>
```
