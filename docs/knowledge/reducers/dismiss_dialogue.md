---
type: SpacetimeDB Reducer
title: dismiss_dialogue
slug: reducers/dismiss_dialogue
updated: 2026-07-14
tags: [reducer, spacetimedb, npc]
abstract: "Dismiss the current dialogue (no-op if no active conversation)."
resource: server-module/src/npc.rs#L375
source: scripts/okf-export.mjs@server-module/src/npc.rs
---

## Signature

```rust
pub fn dismiss_dialogue(ctx: &ReducerContext) -> Result<(), String>
```
