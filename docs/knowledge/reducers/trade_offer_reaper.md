---
type: SpacetimeDB Reducer
title: trade_offer_reaper
slug: reducers/trade_offer_reaper
updated: 2026-07-19
tags: [reducer, spacetimedb, trading]
abstract: "Scheduled reaper: delete a trade offer that has outlived `TRADE_OFFER_TTL_MS`. This is a SCHEDULER-ONLY reducer — clien…"
resource: server-module/src/trading.rs#L151
source: scripts/okf-export.mjs@server-module/src/trading.rs
---

## Signature

```rust
pub fn trade_offer_reaper(
    ctx: &ReducerContext,
    args: TradeOfferReaperSchedule,
) -> Result<(), String>
```
