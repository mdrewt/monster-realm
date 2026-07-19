---
type: SpacetimeDB Table
title: type_relation_row
slug: tables/type_relation_row
updated: 2026-07-19
tags: [schema, spacetimedb, public]
abstract: "Type effectiveness chart seeded from the `game-core` RON registry."
resource: server-module/src/schema.rs#L108
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u64` | yes |
| `attacker` | `Affinity` | — |
| `defender` | `Affinity` | — |
| `effectiveness` | `u8` | — |
