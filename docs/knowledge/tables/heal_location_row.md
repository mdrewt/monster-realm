---
type: SpacetimeDB Table
title: heal_location_row
slug: tables/heal_location_row
updated: 2026-07-03
tags: [schema, spacetimedb, public]
abstract: "Healing location content seeded by `sync_content`. Public (world-readable)."
resource: server-module/src/schema.rs#L363
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `location_id` | `u32` | yes |
| `zone_id` | `u32` | — |
| `tile_x` | `i32` | — |
| `tile_y` | `i32` | — |
| `cost_item_id` | `Option<u32>` | — |
| `cost_qty` | `u32` | — |
| `cooldown_ms` | `i64` | — |
