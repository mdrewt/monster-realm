---
type: SpacetimeDB Table
title: encounter
slug: tables/encounter
updated: 2026-07-04
tags: [schema, spacetimedb, private]
abstract: "PRIVATE encounter table (no `public`). Spawn weights/level bands are server-only truth that must NEVER reach any client…"
resource: server-module/src/schema.rs#L178
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `zone_id` | `u32` | yes |
| `encounter_rate` | `u16` | — |
| `entries` | `Vec<EncounterEntryRow>` | — |

## Privacy

Private table — ADR-0040 — spawn weights/level bands are server-only truth; no public projection.
