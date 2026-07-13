---
type: SpacetimeDB Table
title: movement_tick_schedule
slug: tables/movement_tick_schedule
updated: 2026-07-13
tags: [schema, spacetimedb, private]
abstract: "Per-zone movement schedule: one interval-row per active zone makes the scheduler call `movement_tick` for THAT zone eve…"
resource: server-module/src/movement.rs#L31
source: scripts/okf-export.mjs@server-module/src/movement.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u64` | yes |
| `zone_id` | `u32` | — |
| `scheduled_at` | `ScheduleAt` | — |

## Privacy

Private table — Server-only scheduled table for per-zone movement tick; no projection.
