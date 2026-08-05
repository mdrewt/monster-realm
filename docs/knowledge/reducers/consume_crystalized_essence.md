---
type: SpacetimeDB Reducer
title: consume_crystalized_essence
slug: reducers/consume_crystalized_essence
updated: 2026-08-04
tags: [reducer, spacetimedb, raising]
abstract: "Consume a crystalized-essence item: grant the ITEM's essence to the matching pool, sharing `essence_train`'s cooldown c…"
resource: server-module/src/raising.rs#L674
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn consume_crystalized_essence(
    ctx: &ReducerContext,
    monster_id: u64,
    item_id: u32,
) -> Result<(), String>
```
