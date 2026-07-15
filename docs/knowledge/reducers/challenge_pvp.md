---
type: SpacetimeDB Reducer
title: challenge_pvp
slug: reducers/challenge_pvp
updated: 2026-07-15
tags: [reducer, spacetimedb, pvp]
abstract: "Send a PvP battle challenge to another online player. Guard order (reject-not-clamp, decision-before-irreversible): 1. …"
resource: server-module/src/pvp.rs#L589
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn challenge_pvp(
    ctx: &ReducerContext,
    target: Identity,
    party_ids: Vec<u64>,
) -> Result<(), String>
```
