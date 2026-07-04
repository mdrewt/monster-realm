---
type: SpacetimeDB Table
title: player_conversation
slug: tables/player_conversation
updated: 2026-07-03
tags: [schema, spacetimedb, public]
abstract: "In-progress dialogue node. Single row per player (PK = owner_identity)."
resource: server-module/src/schema.rs#L354
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `npc_entity_id` | `u64` | — |
| `current_node_id` | `String` | — |
