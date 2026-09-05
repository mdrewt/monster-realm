---
type: SpacetimeDB Table
title: export_bundle_reaper_schedule
slug: tables/export_bundle_reaper_schedule
updated: 2026-09-01
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table export_bundle_reaper_schedule."
resource: server-module/src/privacy.rs#L1594
source: scripts/okf-export.mjs@server-module/src/privacy.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
