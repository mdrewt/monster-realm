---
type: SpacetimeDB Table
title: player_dialogue_state
slug: tables/player_dialogue_state
updated: 2026-07-10
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-player dialogue state: flags + done-quest history. Must-never-leak: flags gate content branches (ADR-0015, …"
resource: server-module/src/schema.rs#L362
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `flags` | `Vec<String>` | — |
| `done_quests` | `Vec<String>` | — |

## Privacy

Private table — ADR-0015/0069 — dialogue flags gate content branches; must-never-leak.
