---
type: SpacetimeDB Table
title: export_bundle
slug: tables/export_bundle
updated: 2026-08-31
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-owner data-export chunk (M22 §5, ADR-0207). One row per `(owner_identity, request_id, table_name)`, sub-chu…"
resource: server-module/src/schema.rs#L929
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `chunk_id` | `u64` | yes |
| `owner_identity` | `Identity` | — |
| `request_id` | `u64` | — |
| `table_name` | `String` | — |
| `chunk_index` | `u32` | — |
| `total_chunks` | `u32` | — |
| `payload_json` | `String` | — |
| `created_at_ms` | `i64` | — |
