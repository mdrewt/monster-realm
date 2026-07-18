---
type: SpacetimeDB Reducer
title: confirm_trade
slug: reducers/confirm_trade
updated: 2026-07-18
tags: [reducer, spacetimedb, trading]
abstract: "Initiator confirms a ConfirmedByCounterparty offer → atomic swap. Role + status authorization is delegated to the pure …"
resource: server-module/src/trading.rs#L432
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String>
```
