---
type: SpacetimeDB Table
title: battle_action
slug: tables/battle_action
updated: 2026-07-19
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-turn secret action submitted by one PvP player (M16a, ADR-0109). MUST-NEVER-LEAK (ADR-0015, ADR-0109 D2): a…"
resource: server-module/src/schema.rs#L596
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `action_id` | `u64` | yes |
| `battle_id` | `u64` | — |
| `player_identity` | `Identity` | — |
| `action` | `game_core::PvpAction` | — |
| `turn_number` | `u16` | — |
| `submitted_at_ms` | `i64` | — |
