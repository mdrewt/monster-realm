---
type: SpacetimeDB Table
title: profile
slug: tables/profile
updated: 2026-07-19
tags: [schema, spacetimedb, public]
abstract: "Persistent per-player ranked-ladder record (M17, ADR-0119 D1) — the progression counterpart to the ephemeral `player` p…"
resource: server-module/src/schema.rs#L535
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `identity` | `Identity` | yes |
| `name` | `String` | — |
| `rating` | `i32` | — |
| `wins` | `u32` | — |
| `losses` | `u32` | — |
