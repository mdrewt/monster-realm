---
type: SpacetimeDB Table
title: battle_challenge_reaper_schedule
slug: tables/battle_challenge_reaper_schedule
updated: 2026-07-17
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table battle_challenge_reaper_schedule."
resource: server-module/src/pvp.rs#L104
source: scripts/okf-export.mjs@server-module/src/pvp.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `scheduled_id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
| `challenge_id` | `u64` | — |
