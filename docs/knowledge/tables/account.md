---
type: SpacetimeDB Table
title: account
slug: tables/account
updated: 2026-08-08
tags: [schema, spacetimedb, private]
abstract: "PRIVATE account record (no `public`) — one row per authenticated identity (ADR-0179 D2). No email, no email hash, no ra…"
resource: server-module/src/schema.rs#L684
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `identity` | `Identity` | yes |
| `auth_issuer` | `String` | — |
| `created_at_ms` | `i64` | — |
| `last_login_at_ms` | `i64` | — |
| `status` | `AccountStatus` | — |
| `deletion_requested_at_ms` | `Option<i64>` | — |
| `claimed_from` | `Option<Identity>` | — |
| `claimed_at_ms` | `Option<i64>` | — |
