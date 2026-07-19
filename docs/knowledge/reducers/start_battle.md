---
type: SpacetimeDB Reducer
title: start_battle
slug: reducers/start_battle
updated: 2026-07-19
tags: [reducer, spacetimedb, battle]
abstract: "Start a PvE battle: build BattleMonsters from the player's party and the opponent's party (owned by opponent_identity),…"
resource: server-module/src/battle.rs#L53
source: scripts/okf-export.mjs@server-module/src/battle.rs
---

## Signature

```rust
pub fn start_battle(
    ctx: &ReducerContext,
    opponent_identity: Identity,
    party_monster_ids: Vec<u64>,
    opponent_monster_ids: Vec<u64>,
) -> Result<(), String>
```
