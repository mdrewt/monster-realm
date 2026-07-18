---
type: SpacetimeDB Table
title: pvp_deadline_schedule
slug: tables/pvp_deadline_schedule
updated: 2026-07-17
tags: [schema, spacetimedb, private]
abstract: "One-shot reaper: fires `PVP_TURN_DEADLINE_MS` after a PvP turn starts. PRIVATE (no `public`) — scheduling information i…"
resource: server-module/src/pvp.rs#L65
source: scripts/okf-export.mjs@server-module/src/pvp.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `scheduled_id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
| `battle_id` | `u64` | — |
| `turn_number` | `u16` | — |
