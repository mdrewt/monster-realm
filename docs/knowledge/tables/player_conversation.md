---
type: SpacetimeDB Table
title: player_conversation
slug: tables/player_conversation
updated: 2026-07-15
tags: [schema, spacetimedb, private]
abstract: "In-progress dialogue node. Single row per player (PK = owner_identity). PRIVATE since M13.5c (ADR-0087): `npc_entity_id…"
resource: server-module/src/schema.rs#L403
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `npc_entity_id` | `u64` | — |
| `current_node_id` | `String` | — |
