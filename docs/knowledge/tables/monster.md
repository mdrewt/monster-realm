---
type: SpacetimeDB Table
title: monster
slug: tables/monster
updated: 2026-08-17
tags: [schema, spacetimedb, private]
abstract: "The authoritative monster record — PRIVATE (no `public`). Contains hidden genes (IVs, EVs, nature) that must NEVER reac…"
resource: server-module/src/schema.rs#L207
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
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
| `iv_hp` | `u8` | — |
| `iv_attack` | `u8` | — |
| `iv_defense` | `u8` | — |
| `iv_speed` | `u8` | — |
| `iv_sp_attack` | `u8` | — |
| `iv_sp_defense` | `u8` | — |
| `nature_kind` | `NatureKind` | — |
| `ev_hp` | `u16` | — |
| `ev_attack` | `u16` | — |
| `ev_defense` | `u16` | — |
| `ev_speed` | `u16` | — |
| `ev_sp_attack` | `u16` | — |
| `ev_sp_defense` | `u16` | — |
| `stat_hp` | `u16` | — |
| `stat_attack` | `u16` | — |
| `stat_defense` | `u16` | — |
| `stat_speed` | `u16` | — |
| `stat_sp_attack` | `u16` | — |
| `stat_sp_defense` | `u16` | — |
| `current_hp` | `u16` | — |
| `party_slot` | `u8` | — |
| `last_care_at_ms` | `i64` | — |
| `essence_fire` | `u32` | — |
| `essence_water` | `u32` | — |
| `essence_plant` | `u32` | — |
| `essence_electric` | `u32` | — |
| `essence_earth` | `u32` | — |
| `essence_wind` | `u32` | — |
| `essence_light` | `u32` | — |
| `essence_dark` | `u32` | — |
| `trust_favorable_count` | `u32` | — |
| `trust_unfavorable_count` | `u32` | — |
| `trust_favorable_battle_day_epoch` | `u32` | — |
| `quality_time_ticks_total` | `u32` | — |
| `quality_time_accum_ms` | `u32` | — |
| `quality_time_window_ms` | `u32` | — |
| `quality_time_window_start_ms` | `i64` | — |
| `last_essence_train_at_ms` | `i64` | — |

## Privacy

Private table — ADR-0015/0040 — hidden genes (IVs/EVs/nature) must never reach non-owner clients.

Public projection: [monster_pub](monster_pub.md).
