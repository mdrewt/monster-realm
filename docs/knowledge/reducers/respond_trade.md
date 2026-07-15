---
type: SpacetimeDB Reducer
title: respond_trade
slug: reducers/respond_trade
updated: 2026-07-14
tags: [reducer, spacetimedb, trading]
abstract: "Counterparty responds to a Pending offer. - `accepted = false` → row deleted (escrow released, no assets moved, TR-13).…"
resource: server-module/src/trading.rs#L268
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String>
```
