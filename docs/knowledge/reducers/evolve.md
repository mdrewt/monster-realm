---
type: SpacetimeDB Reducer
title: evolve
slug: reducers/evolve
updated: 2026-07-19
tags: [reducer, spacetimedb, evolution]
abstract: "Evolve a monster into its passive-eligible target species (M10b, ADR-0061). Steps: 1. Look up Monster + Species (reject…"
resource: server-module/src/evolution.rs#L60
source: scripts/okf-export.mjs@server-module/src/evolution.rs
---

## Signature

```rust
pub fn evolve(ctx: &ReducerContext, monster_id: u64) -> Result<(), String>
```
