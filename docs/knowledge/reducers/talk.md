---
type: SpacetimeDB Reducer
title: talk
slug: reducers/talk
updated: 2026-07-12
tags: [reducer, spacetimedb, npc]
abstract: "Initiate a dialogue with an NPC. Creates/replaces the player_conversation row. Zone + range checked. auto_effects appli…"
resource: server-module/src/npc.rs#L195
source: scripts/okf-export.mjs@server-module/src/npc.rs
---

## Signature

```rust
pub fn talk(ctx: &ReducerContext, npc_entity_id: u64) -> Result<(), String>
```
