---
type: SpacetimeDB Table
title: trade_offer
slug: tables/trade_offer
updated: 2026-07-13
tags: [schema, spacetimedb, public]
abstract: "An active trade offer between two players (M15, ADR-0106). PUBLIC so both parties can subscribe and see the offer. The …"
resource: server-module/src/schema.rs#L459
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `trade_id` | `u64` | yes |
| `initiator` | `Identity` | — |
| `counterparty` | `Identity` | — |
| `initiator_monster_ids` | `Vec<u64>` | — |
| `initiator_items` | `Vec<game_core::TradeItem>` | — |
| `initiator_currency` | `u64` | — |
| `counterparty_monster_ids` | `Vec<u64>` | — |
| `counterparty_items` | `Vec<game_core::TradeItem>` | — |
| `counterparty_currency` | `u64` | — |
| `initiator_cards` | `Vec<game_core::MonsterCard>` | — |
| `counterparty_cards` | `Vec<game_core::MonsterCard>` | — |
| `status` | `game_core::TradeStatus` | — |
| `created_at_ms` | `i64` | — |
