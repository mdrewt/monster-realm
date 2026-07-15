---
type: SpacetimeDB Table
title: battle_challenge
slug: tables/battle_challenge
updated: 2026-07-15
tags: [schema, spacetimedb, public]
abstract: "A pending PvP challenge from one player to another (M16a, ADR-0109). PUBLIC so both the challenger and the target can s…"
resource: server-module/src/schema.rs#L542
source: scripts/okf-export.mjs@server-module/src/schema.rs
visibility: public
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `challenge_id` | `u64` | yes |
| `challenger` | `Identity` | — |
| `target` | `Identity` | — |
| `challenger_party_ids` | `Vec<u64>` | — |
| `status` | `ChallengeStatus` | — |
| `created_at_ms` | `i64` | — |
