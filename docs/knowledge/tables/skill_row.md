---
type: SpacetimeDB Table
title: skill_row
slug: tables/skill_row
updated: 2026-07-10
tags: [schema, spacetimedb, public]
abstract: "Skill definitions seeded from the `game-core` RON registry."
resource: server-module/src/schema.rs#L94
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u32` | yes |
| `name` | `String` | — |
| `affinity` | `Affinity` | — |
| `power` | `u16` | — |
| `accuracy` | `u8` | — |
| `pp` | `u8` | — |
