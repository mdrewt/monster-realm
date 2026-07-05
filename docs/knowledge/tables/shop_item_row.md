---
type: SpacetimeDB Table
title: shop_item_row
slug: tables/shop_item_row
updated: 2026-07-05
tags: [schema, spacetimedb, public]
abstract: "Shop stock entries seeded from the `game-core` RON registry. One row per (shop, item) pair. Looked up by shop_id index …"
resource: server-module/src/schema.rs#L151
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `shop_item_id` | `u64` | yes |
| `shop_id` | `u32` | — |
| `item_id` | `u32` | — |
| `buy_price` | `u64` | — |
