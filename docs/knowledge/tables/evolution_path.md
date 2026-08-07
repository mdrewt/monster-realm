---
type: SpacetimeDB Table
title: evolution_path
slug: tables/evolution_path
updated: 2026-08-04
tags: [schema, spacetimedb, public]
abstract: "PUBLIC evolution-graph edge table (EG1-4), seeded clear-and-reinsert from the game-core evolution_paths registry by syn…"
resource: server-module/src/schema.rs#L457
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `path_id` | `u64` | yes |
| `edge_id` | `u32` | — |
| `from_species` | `u32` | — |
| `to_species` | `u32` | — |
| `min_level` | `u8` | — |
| `essence` | `Vec<EssenceRequirementRow>` | — |
| `min_trust_tier` | `Option<TrustTier>` | — |
| `min_quality_time_tier` | `Option<u8>` | — |
| `min_nutrition_pct` | `Option<u8>` | — |
