---
type: SpacetimeDB Reducer
title: cancel_trade
slug: reducers/cancel_trade
updated: 2026-07-13
tags: [reducer, spacetimedb, trading]
abstract: "Cancel a trade offer. Either party may cancel before the swap executes. Deletes the row → escrow released, no assets mo…"
resource: server-module/src/trading.rs#L329
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn cancel_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String>
```
