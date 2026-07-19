---
type: SpacetimeDB Table
title: zone_def
slug: tables/zone_def
updated: 2026-07-19
tags: [schema, spacetimedb, public]
abstract: "Zone definitions seeded from the `game-core` RON registry by `sync_content`."
resource: server-module/src/schema.rs#L66
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `zone_id` | `u32` | yes |
| `name` | `String` | — |
| `width` | `u32` | — |
| `height` | `u32` | — |
