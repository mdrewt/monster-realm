---
type: SpacetimeDB Reducer
title: care
slug: reducers/care
updated: 2026-07-04
tags: [reducer, spacetimedb, raising]
abstract: "Raise a monster's bond, gated by a per-monster cooldown measured from the server clock (`ctx.timestamp`, never a client…"
resource: server-module/src/raising.rs#L65
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String>
```
