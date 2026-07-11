---
type: SpacetimeDB Reducer
title: flee
slug: reducers/flee
updated: 2026-07-10
tags: [reducer, spacetimedb, battle]
abstract: "Flee from a battle. Sets outcome to `Fled`; no XP awarded."
resource: server-module/src/battle.rs#L623
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String>
```
