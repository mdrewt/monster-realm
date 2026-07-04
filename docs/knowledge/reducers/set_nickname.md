---
type: SpacetimeDB Reducer
title: set_nickname
slug: reducers/set_nickname
updated: 2026-07-04
tags: [reducer, spacetimedb, monster_mgmt]
abstract: "Set or clear a monster's nickname. Empty string clears the nickname. Ownership-checked: only the monster's owner may re…"
resource: server-module/src/monster_mgmt.rs#L21
source: scripts/okf-export.mjs@server-module/src/monster_mgmt.rs
---

## Signature

```rust
pub fn set_nickname(ctx: &ReducerContext, monster_id: u64, nickname: String) -> Result<(), String>
```
