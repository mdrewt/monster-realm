---
type: SpacetimeDB Table
title: inventory
slug: tables/inventory
updated: 2026-07-03
tags: [schema, spacetimedb, public]
abstract: "Player item inventory (M8d, ADR-0046). PUBLIC / world-readable counts: there is NO transport RLS (no `client_visibility…"
resource: server-module/src/schema.rs#L284
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
