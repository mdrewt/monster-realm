---
type: SpacetimeDB Table
title: species_row
slug: tables/species_row
updated: 2026-07-15
tags: [schema, spacetimedb, public]
abstract: "Species definitions seeded from the `game-core` RON registry by `sync_content`."
resource: server-module/src/schema.rs#L79
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u32` | yes |
| `name` | `String` | — |
| `base_hp` | `u16` | — |
| `base_attack` | `u16` | — |
| `base_defense` | `u16` | — |
| `base_speed` | `u16` | — |
| `base_sp_attack` | `u16` | — |
| `base_sp_defense` | `u16` | — |
| `affinity` | `Affinity` | — |
| `learnable_skill_ids` | `Vec<u32>` | — |
| `ability` | `Option<u32>` | — |
