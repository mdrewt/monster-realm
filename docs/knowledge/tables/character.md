---
type: SpacetimeDB Table
title: character
slug: tables/character
updated: 2026-07-10
tags: [schema, spacetimedb, public]
abstract: "One renderable entity. The enum/queue columns are the EXACT M1 `game-core` types (the shared type IS the schema, never …"
resource: server-module/src/schema.rs#L24
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `entity_id` | `u64` | yes |
| `zone_id` | `u32` | — |
| `tile_x` | `i32` | — |
| `tile_y` | `i32` | — |
| `facing` | `Direction` | — |
| `action` | `ActionState` | — |
| `move_started_at_ms` | `i64` | — |
| `sprite_id` | `u32` | — |
| `move_queue` | `Vec<MoveInput>` | — |
