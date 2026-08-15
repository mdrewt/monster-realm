---
type: SpacetimeDB Table
title: guest_claim
slug: tables/guest_claim
updated: 2026-08-15
tags: [schema, spacetimedb, private]
abstract: "PRIVATE in-flight guest→account claim (no `public`) — one row per guest identity (ADR-0179 D2/D3). `code` is CLIENT-min…"
resource: server-module/src/schema.rs#L743
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `guest_identity` | `Identity` | yes |
| `code` | `String` | — |
| `guest_name` | `String` | — |
| `created_at_ms` | `i64` | — |
| `expires_at_ms` | `i64` | — |
