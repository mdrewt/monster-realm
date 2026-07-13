---
type: SpacetimeDB Reducer
title: start_wild_battle
slug: reducers/start_wild_battle
updated: 2026-07-10
tags: [reducer, spacetimedb, battle]
abstract: "DEV/TEST entrypoint (gate or remove at M9+): a faithful double of the grass path, since `movement_tick` is scheduler-on…"
resource: server-module/src/battle.rs#L432
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String>
```
