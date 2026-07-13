---
type: SpacetimeDB Reducer
title: grant_bait
slug: reducers/grant_bait
updated: 2026-07-12
tags: [reducer, spacetimedb, taming]
abstract: "DEV/TEST: grant bait to the CALLER only (self-scoped to `ctx.sender`; no arbitrary-recipient parameter). Rejects non-ba…"
resource: server-module/src/taming.rs#L245
source: scripts/okf-export.mjs@server-module/src/taming.rs
---

## Signature

```rust
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String>
```
