---
type: SpacetimeDB Table
title: fusion
slug: tables/fusion
updated: 2026-07-18
tags: [schema, spacetimedb, public]
abstract: "Fusion recipes (M10b, ADR-0061): public content table seeded from game-core. Each row defines an order-independent reci…"
resource: server-module/src/schema.rs#L347
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `fusion_id` | `u64` | yes |
| `a_species` | `u32` | — |
| `b_species` | `u32` | — |
| `to_species` | `u32` | — |
