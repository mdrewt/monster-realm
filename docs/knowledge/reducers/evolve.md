---
type: SpacetimeDB Reducer
title: evolve
slug: reducers/evolve
updated: 2026-08-17
tags: [reducer, spacetimedb, evolution]
abstract: "Evolve a monster along one authored evolution-graph edge (EG2-1 shape). Steps: 1. Look up the Monster row (loud reject …"
resource: server-module/src/evolution.rs#L50
source: scripts/okf-export.mjs@server-module/src/evolution.rs
---

## Signature

```rust
pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String>
```
