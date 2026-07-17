---
type: SpacetimeDB Reducer
title: decline_challenge
slug: reducers/decline_challenge
updated: 2026-07-17
tags: [reducer, spacetimedb, pvp]
abstract: "Decline a pending PvP challenge. Deletes the challenge row."
resource: server-module/src/pvp.rs#L823
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn decline_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String>
```
