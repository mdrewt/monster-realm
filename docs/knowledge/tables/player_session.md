---
type: SpacetimeDB Table
title: player_session
slug: tables/player_session
updated: 2026-09-11
tags: [schema, spacetimedb, private]
abstract: "One row per LIVE client connection (rb-73, ADR-0245): the host-minted `ConnectionId` of the socket and the identity it …"
resource: server-module/src/schema.rs#L966
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `connection_id` | `ConnectionId` | yes |
| `identity` | `Identity` | — |
