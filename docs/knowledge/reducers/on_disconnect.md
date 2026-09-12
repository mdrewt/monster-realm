---
type: SpacetimeDB Reducer
title: on_disconnect
slug: reducers/on_disconnect
updated: 2026-09-11
tags: [reducer, spacetimedb, lib]
abstract: "Lifecycle: the disconnecting socket's row goes first; the trade / PvP / wild-battle / challenge force-resolves and the …"
resource: server-module/src/lib.rs#L331
source: scripts/okf-export.mjs@server-module/src/lib.rs
---

## Signature

```rust
pub fn on_disconnect(ctx: &ReducerContext)
```
