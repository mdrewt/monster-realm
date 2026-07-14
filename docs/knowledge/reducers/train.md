---
type: SpacetimeDB Reducer
title: train
slug: reducers/train
updated: 2026-07-14
tags: [reducer, spacetimedb, raising]
abstract: "Spend a training food to grant EVs toward its target stat and re-derive the monster's stats (server-authoritative, reje…"
resource: server-module/src/raising.rs#L133
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn train(ctx: &ReducerContext, monster_id: u64, food_item_id: u32) -> Result<(), String>
```
