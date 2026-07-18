---
type: SpacetimeDB Reducer
title: attempt_recruit
slug: reducers/attempt_recruit
updated: 2026-07-18
tags: [reducer, spacetimedb, taming]
abstract: "Attempt to recruit the wild monster in a wild battle (M8d, ADR-0047). The roll is injected (`ctx.random()`), never a cl…"
resource: server-module/src/taming.rs#L45
source: scripts/okf-export.mjs@server-module/src/taming.rs
---

## Signature

```rust
pub fn attempt_recruit(
    ctx: &ReducerContext,
    battle_id: u64,
    bait_item_id: Option<u32>,
) -> Result<(), String>
```
