---
type: SpacetimeDB Table
title: battle
slug: tables/battle
updated: 2026-09-01
tags: [schema, spacetimedb, private]
abstract: "A single PvE or PvP battle. The `state` column holds the full `BattleState` (pure data from `game-core`); the server mo…"
resource: server-module/src/schema.rs#L401
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
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

## Privacy

Private table — ADR-0198 — need-to-know: participants read their own rows via the my_battle view; no world-readable battle state.
