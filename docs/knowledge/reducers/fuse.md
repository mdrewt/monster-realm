---
type: SpacetimeDB Reducer
title: fuse
slug: reducers/fuse
updated: 2026-07-13
tags: [reducer, spacetimedb, evolution]
abstract: "Fuse two owned monsters into a new offspring (M10b, ADR-0061). Steps: 1. Look up both Monster rows (reject loud if not …"
resource: server-module/src/evolution.rs#L181
source: scripts/okf-export.mjs@server-module/src/evolution.rs
---

## Signature

```rust
pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String>
```
