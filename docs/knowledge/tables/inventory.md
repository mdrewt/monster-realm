---
type: SpacetimeDB Table
title: inventory
slug: tables/inventory
updated: 2026-08-17
tags: [schema, spacetimedb, public]
abstract: "Player item inventory (M8d, ADR-0046). PUBLIC / world-readable counts: transport RLS is unavailable — `client_visibilit…"
resource: server-module/src/schema.rs#L472
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `inv_id` | `u64` | yes |
| `owner_identity` | `Identity` | — |
| `item_id` | `u32` | — |
| `count` | `u32` | — |
