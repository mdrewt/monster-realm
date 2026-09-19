---
type: SpacetimeDB Table
title: pending_evolution_notice
slug: tables/pending_evolution_notice
updated: 2026-09-18
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-owner queue of evolution reveals the player has not dismissed yet (20r-d, ADR-0254 D2). One row per owner, …"
resource: server-module/src/schema.rs#L565
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `entries` | `Vec<EvolutionRevealRow>` | — |
