---
type: SpacetimeDB Table
title: playtest_reaper_schedule
slug: tables/playtest_reaper_schedule
updated: 2026-07-19
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table playtest_reaper_schedule."
resource: server-module/src/playtest.rs#L32
source: scripts/okf-export.mjs@server-module/src/playtest.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
