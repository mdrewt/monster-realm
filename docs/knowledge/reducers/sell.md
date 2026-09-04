---
type: SpacetimeDB Reducer
title: sell
slug: reducers/sell
updated: 2026-09-01
tags: [reducer, spacetimedb, economy]
abstract: "Sell `qty` units of `item_id` from the caller's inventory. Server flow (reject-not-clamp, server-priced, atomic): 1. Ve…"
resource: server-module/src/economy.rs#L198
source: scripts/okf-export.mjs@server-module/src/economy.rs
---

## Signature

```rust
pub fn sell(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String>
```
