---
type: SpacetimeDB Table
title: shop_row
slug: tables/shop_row
updated: 2026-07-13
tags: [schema, spacetimedb, public]
abstract: "Shop definitions seeded from the `game-core` RON registry. Public (world-readable content, like `item_row` — shop names…"
resource: server-module/src/schema.rs#L150
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `shop_id` | `u32` | yes |
| `name` | `String` | — |
