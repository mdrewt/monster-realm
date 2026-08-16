---
type: SpacetimeDB Reducer
title: care
slug: reducers/care
updated: 2026-08-16
tags: [reducer, spacetimedb, raising]
abstract: "Care for a monster (Trust-favorable credit, EG2-5/ADR-0175), gated by a per-monster cooldown measured from the server c…"
resource: server-module/src/raising.rs#L75
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn care(ctx: &ReducerContext, monster_id: u64) -> Result<(), String>
```
