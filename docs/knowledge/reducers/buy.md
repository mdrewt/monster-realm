---
type: SpacetimeDB Reducer
title: buy
slug: reducers/buy
updated: 2026-07-14
tags: [reducer, spacetimedb, economy]
abstract: "Buy `qty` units of `item_id` from shop `shop_id`. Server flow (reject-not-clamp, server-priced, atomic): 1. Verify call…"
resource: server-module/src/economy.rs#L97
source: scripts/okf-export.mjs@server-module/src/economy.rs
---

## Signature

```rust
pub fn buy(ctx: &ReducerContext, shop_id: u32, item_id: u32, qty: u32) -> Result<(), String>
```
