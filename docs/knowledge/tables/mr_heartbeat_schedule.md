---
type: SpacetimeDB Table
title: mr_heartbeat_schedule
slug: tables/mr_heartbeat_schedule
updated: 2026-08-31
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table mr_heartbeat_schedule."
resource: server-module/src/observability.rs#L104
source: scripts/okf-export.mjs@server-module/src/observability.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
