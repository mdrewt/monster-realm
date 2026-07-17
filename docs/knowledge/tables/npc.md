---
type: SpacetimeDB Table
title: npc
slug: tables/npc
updated: 2026-07-17
tags: [schema, spacetimedb, public]
abstract: "NPC entity role row. Entity/component: an NPC is a `character` row + this. `zone_id` mirrors `character.zone_id` (kept …"
resource: server-module/src/schema.rs#L360
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `entity_id` | `u64` | yes |
| `npc_id` | `String` | — |
| `zone_id` | `u32` | — |
| `home_x` | `i32` | — |
| `home_y` | `i32` | — |
| `wander_radius` | `u8` | — |
| `dialogue_tree_id` | `String` | — |
