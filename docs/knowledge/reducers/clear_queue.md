---
type: SpacetimeDB Reducer
title: clear_queue
slug: reducers/clear_queue
updated: 2026-07-12
tags: [reducer, spacetimedb, movement]
abstract: "Empty the queue (key release)."
resource: server-module/src/movement.rs#L145
source: scripts/okf-export.mjs@server-module/src/movement.rs
---

## Signature

```rust
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String>
```
