---
type: SpacetimeDB Table
title: battle_wild
slug: tables/battle_wild
updated: 2026-07-03
tags: [schema, spacetimedb, private]
abstract: "PRIVATE wild-individuality side-table (M8c, ADR-0045). Keyed 1:1 by `battle_id`. Stores the splitmix32 `individuality_s…"
resource: server-module/src/schema.rs#L266
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `battle_id` | `u64` | yes |
| `wild_species_id` | `u32` | — |
| `wild_level` | `u8` | — |
| `individuality_seed` | `u32` | — |
## Privacy

Private table — ADR-0045 — RNG individuality seed must never reach any client; no projection.
