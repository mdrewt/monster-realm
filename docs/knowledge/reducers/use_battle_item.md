---
type: SpacetimeDB Reducer
title: use_battle_item
slug: reducers/use_battle_item
updated: 2026-07-14
tags: [reducer, spacetimedb, battle]
abstract: "Use a battle item (e.g. Antidote) on the player's active monster during an ongoing battle (m14e, ADR-0096). Guard order…"
resource: server-module/src/battle.rs#L832
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn use_battle_item(ctx: &ReducerContext, battle_id: u64, item_id: u32) -> Result<(), String>
```
