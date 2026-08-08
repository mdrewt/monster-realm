---
type: SpacetimeDB Reducer
title: submit_attack
slug: reducers/submit_attack
updated: 2026-08-07
tags: [reducer, spacetimedb, battle]
abstract: "Submit an attack: resolve one turn where the player attacks with `skill_id` and the opponent uses AI. Ownership + outco…"
resource: server-module/src/battle.rs#L596
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String>
```
