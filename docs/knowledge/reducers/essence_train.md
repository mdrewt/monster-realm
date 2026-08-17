---
type: SpacetimeDB Reducer
title: essence_train
slug: reducers/essence_train
updated: 2026-08-17
tags: [reducer, spacetimedb, raising]
abstract: "Essence-train a monster: +ESSENCE_TRAIN_AMOUNT to ONE pool, gated by the shared 5 h cooldown (EG2-3). Full care-shaped …"
resource: server-module/src/raising.rs#L625
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn essence_train(
    ctx: &ReducerContext,
    monster_id: u64,
    affinity: Affinity,
) -> Result<(), String>
```
