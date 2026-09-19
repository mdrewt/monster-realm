---
type: SpacetimeDB Reducer
title: advance_dialogue
slug: reducers/advance_dialogue
updated: 2026-09-18
tags: [reducer, spacetimedb, npc]
abstract: "Advance dialogue by selecting a choice. Security gate: `apply_choice` re-checks conditions internally. `player_conversa…"
resource: server-module/src/npc.rs#L360
source: scripts/okf-export.mjs@server-module/src/npc.rs
---

## Signature

```rust
pub fn advance_dialogue(ctx: &ReducerContext, choice_idx: u32) -> Result<(), String>
```
