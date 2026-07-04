---
type: SpacetimeDB Table
title: monster
slug: tables/monster
updated: 2026-07-03
tags: [schema, spacetimedb, private]
abstract: "The authoritative monster record — PRIVATE (no `public`). Contains hidden genes (IVs, EVs, nature) that must NEVER reac…"
resource: server-module/src/schema.rs#L162
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
| `bond` | `u8` | — |
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
| `evolves_to` | `Option<u32>` | — |

## Privacy

Private table — ADR-0015/0040 — hidden genes (IVs/EVs/nature) must never reach non-owner clients.

Public projection: [monster_pub](monster_pub.md).
