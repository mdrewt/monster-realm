---
type: SpacetimeDB Table
title: config
slug: tables/config
updated: 2026-07-15
tags: [schema, spacetimedb, public]
abstract: "Singleton world config."
resource: server-module/src/schema.rs#L56
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `id` | `u32` | yes |
| `content_version` | `u32` | — |
| `owner_identity` | `Identity` | — |
