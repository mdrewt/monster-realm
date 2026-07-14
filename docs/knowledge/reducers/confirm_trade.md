---
type: SpacetimeDB Reducer
title: confirm_trade
slug: reducers/confirm_trade
updated: 2026-07-13
tags: [reducer, spacetimedb, trading]
abstract: "Initiator confirms a ConfirmedByCounterparty offer → atomic swap. Re-reads all live rows, verifies ownership still matc…"
resource: server-module/src/trading.rs#L279
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn confirm_trade(ctx: &ReducerContext, trade_id: u64) -> Result<(), String>
```
