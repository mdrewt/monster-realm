---
type: SpacetimeDB Reducer
title: cancel_challenge
slug: reducers/cancel_challenge
updated: 2026-07-14
tags: [reducer, spacetimedb, pvp]
abstract: "Cancel a pending PvP challenge (initiator-only)."
resource: server-module/src/pvp.rs#L845
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn cancel_challenge(ctx: &ReducerContext, challenge_id: u64) -> Result<(), String>
```
