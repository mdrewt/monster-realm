---
type: SpacetimeDB Table
title: item_row
slug: tables/item_row
updated: 2026-07-18
tags: [schema, spacetimedb, public]
abstract: "Item definitions seeded from the `game-core` RON registry."
resource: server-module/src/schema.rs#L119
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u32` | yes |
| `name` | `String` | — |
| `description` | `String` | — |
| `recruit_bonus` | `u16` | — |
| `train_stat` | `Option<StatKind>` | — |
| `train_amount` | `u16` | — |
| `sell_price` | `u64` | — |
| `cure_status` | `Option<StatusKind>` | — |
