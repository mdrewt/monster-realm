---
type: SpacetimeDB Reducer
title: join_game
slug: reducers/join_game
updated: 2026-07-15
tags: [reducer, spacetimedb, movement]
abstract: "Join: one `player` + one `character` at the spawn + one starter `monster` (idempotent: a returning player gets characte…"
resource: server-module/src/movement.rs#L44
source: scripts/okf-export.mjs@server-module/src/movement.rs
---

## Signature

```rust
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String>
```
