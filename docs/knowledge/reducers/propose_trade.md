---
type: SpacetimeDB Reducer
title: propose_trade
slug: reducers/propose_trade
updated: 2026-07-15
tags: [reducer, spacetimedb, trading]
abstract: "Propose a trade: escrow the listed assets and await the counterparty's response. Guards (in order): 1. Caller must be j…"
resource: server-module/src/trading.rs#L187
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn propose_trade(
    ctx: &ReducerContext,
    counterparty: Identity,
    initiator_monster_ids: Vec<u64>,
    initiator_items: Vec<TradeItem>,
    initiator_currency: u64,
    counterparty_monster_ids: Vec<u64>,
    counterparty_items: Vec<TradeItem>,
    counterparty_currency: u64,
) -> Result<(), String>
```
