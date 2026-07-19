---
type: SpacetimeDB Table
title: playtest_event
slug: tables/playtest_event
updated: 2026-07-19
tags: [schema, spacetimedb, private]
abstract: "SpacetimeDB private table playtest_event."
resource: server-module/src/playtest.rs#L16
source: scripts/okf-export.mjs@server-module/src/playtest.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `event_id` | `u64` | yes |
| `identity` | `Identity` | — |
| `kind` | `u16` | — |
| `created_at_ms` | `i64` | — |
| `battle_id` | `u64` | — |
| `species_id` | `u32` | — |
| `hp_permille` | `u16` | — |
| `bait_item_id` | `u32` | — |
| `success` | `bool` | — |
