---
type: SpacetimeDB Reducer
title: set_party_slot
slug: reducers/set_party_slot
updated: 2026-07-04
tags: [reducer, spacetimedb, monster_mgmt]
abstract: "Set or clear a monster's party slot. `slot = 255` moves to box; `slot < 6` assigns a party position. Ownership-checked;…"
resource: server-module/src/monster_mgmt.rs#L45
source: scripts/okf-export.mjs@server-module/src/monster_mgmt.rs
---

## Signature

```rust
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String>
```
