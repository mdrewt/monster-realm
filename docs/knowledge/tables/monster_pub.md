---
type: SpacetimeDB Table
title: monster_pub
slug: tables/monster_pub
updated: 2026-08-04
tags: [schema, spacetimedb, public]
abstract: "Public projection of the monster table — NO hidden fields (no IVs, EVs, nature). Clients subscribe to this for the box/…"
resource: server-module/src/schema.rs#L306
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `monster_id` | `u64` | yes |
| `owner_identity` | `Identity` | — |
| `species_id` | `u32` | — |
| `nickname` | `String` | — |
| `level` | `u8` | — |
| `xp` | `u32` | — |
| `current_hp` | `u16` | — |
| `stat_hp` | `u16` | — |
| `stat_attack` | `u16` | — |
| `stat_defense` | `u16` | — |
| `stat_speed` | `u16` | — |
| `stat_sp_attack` | `u16` | — |
| `stat_sp_defense` | `u16` | — |
| `party_slot` | `u8` | — |
| `tier` | `u8` | — |
| `essence_fire` | `u32` | — |
| `essence_water` | `u32` | — |
| `essence_plant` | `u32` | — |
| `essence_electric` | `u32` | — |
| `essence_earth` | `u32` | — |
| `essence_wind` | `u32` | — |
| `essence_light` | `u32` | — |
| `essence_dark` | `u32` | — |
| `trust_tier` | `TrustTier` | — |
| `quality_time_tier` | `u8` | — |
| `nutrition_pct` | `u8` | — |
