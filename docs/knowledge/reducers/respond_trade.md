---
type: SpacetimeDB Reducer
title: respond_trade
slug: reducers/respond_trade
updated: 2026-07-15
tags: [reducer, spacetimedb, trading]
abstract: "Counterparty responds to a Pending offer. Role + status authorization is delegated to the pure `authorize_respond` (rol…"
resource: server-module/src/trading.rs#L393
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn respond_trade(ctx: &ReducerContext, trade_id: u64, accepted: bool) -> Result<(), String>
```
