---
type: SpacetimeDB Table
title: player
slug: tables/player
updated: 2026-07-13
tags: [schema, spacetimedb, public]
abstract: "Links a connection identity to its character. `last_input_seq` is the reconciliation ack (set at accept-time) — NEVER t…"
resource: server-module/src/schema.rs#L44
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `identity` | `Identity` | yes |
| `entity_id` | `u64` | — |
| `name` | `String` | — |
| `online` | `bool` | — |
| `last_input_seq` | `u64` | — |
