---
type: SpacetimeDB Reducer
title: swap_active
slug: reducers/swap_active
updated: 2026-07-10
tags: [reducer, spacetimedb, battle]
abstract: "Swap the player's active monster. Ownership + outcome guards enforced."
resource: server-module/src/battle.rs#L628
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn swap_active(ctx: &ReducerContext, battle_id: u64, team_index: u32) -> Result<(), String>
```
