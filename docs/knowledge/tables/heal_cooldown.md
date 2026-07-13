---
type: SpacetimeDB Table
title: heal_cooldown
slug: tables/heal_cooldown
updated: 2026-07-13
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-player heal cooldown anchor. Must-never-leak: timestamp reveals heal timing (ADR-0015, ADR-0069)."
resource: server-module/src/schema.rs#L432
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `last_heal_at_ms` | `i64` | — |

## Privacy

Private table — ADR-0015/0069 — heal timing is private; must-never-leak.
