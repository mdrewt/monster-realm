---
type: SpacetimeDB Table
title: battle
slug: tables/battle
updated: 2026-07-19
tags: [schema, spacetimedb, public]
abstract: "A single PvE or PvP battle. The `state` column holds the full `BattleState` (pure data from `game-core`); the server mo…"
resource: server-module/src/schema.rs#L291
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `battle_id` | `u64` | yes |
| `player_identity` | `Identity` | — |
| `opponent_identity` | `Identity` | — |
| `state` | `BattleState` | — |
| `party_monster_ids` | `Vec<u64>` | — |
| `opponent_monster_ids` | `Vec<u64>` | — |
| `created_at_ms` | `i64` | — |
