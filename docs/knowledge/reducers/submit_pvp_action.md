---
type: SpacetimeDB Reducer
title: submit_pvp_action
slug: reducers/submit_pvp_action
updated: 2026-07-18
tags: [reducer, spacetimedb, pvp]
abstract: "Submit a PvP action (Attack or Swap) for the current turn. Guard order: 1. Battle exists. 2. ctx.sender is player_ident…"
resource: server-module/src/pvp.rs#L974
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn submit_pvp_action(
    ctx: &ReducerContext,
    battle_id: u64,
    action: PvpAction,
) -> Result<(), String>
```
