---
type: SpacetimeDB Reducer
title: accept_challenge
slug: reducers/accept_challenge
updated: 2026-07-14
tags: [reducer, spacetimedb, pvp]
abstract: "Accept a pending PvP challenge. Creates the `battle` row and schedules the turn deadline. Guard order: 1. Challenge exi…"
resource: server-module/src/pvp.rs#L736
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn accept_challenge(
    ctx: &ReducerContext,
    challenge_id: u64,
    party_ids: Vec<u64>,
) -> Result<(), String>
```
