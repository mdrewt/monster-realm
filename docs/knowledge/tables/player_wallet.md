---
type: SpacetimeDB Table
title: player_wallet
slug: tables/player_wallet
updated: 2026-07-15
tags: [schema, spacetimedb, private]
abstract: "PRIVATE per-player wallet — one row per player (PK = owner_identity). Balance is MUST-NEVER-LEAK: no `public`, no proje…"
resource: server-module/src/schema.rs#L514
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `owner_identity` | `Identity` | yes |
| `balance` | `u64` | — |
