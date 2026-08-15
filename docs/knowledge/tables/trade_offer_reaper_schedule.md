---
type: SpacetimeDB Table
title: trade_offer_reaper_schedule
slug: tables/trade_offer_reaper_schedule
updated: 2026-08-15
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table trade_offer_reaper_schedule."
resource: server-module/src/trading.rs#L113
source: scripts/okf-export.mjs@server-module/src/trading.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `scheduled_id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
| `trade_id` | `u64` | — |
