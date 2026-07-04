---
type: SpacetimeDB Table
title: player_quest
slug: tables/player_quest
updated: 2026-07-03
tags: [schema, spacetimedb, public]
abstract: "Active quest progress. Public (quest log is world-readable like `inventory`). Per-owner transport RLS deferred to M16."
resource: server-module/src/schema.rs#L342
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `pq_id` | `u64` | yes |
| `owner_identity` | `Identity` | — |
| `quest_id` | `String` | — |
| `step_index` | `u32` | — |
