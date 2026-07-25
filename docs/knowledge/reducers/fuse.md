---
type: SpacetimeDB Reducer
title: fuse
slug: reducers/fuse
updated: 2026-07-19
tags: [reducer, spacetimedb, evolution]
abstract: "Fuse two owned monsters into a new offspring (M10b, ADR-0061; carry model ADR-0147). Steps: 1. Look up both Monster row…"
resource: server-module/src/evolution.rs#L233
source: scripts/okf-export.mjs@server-module/src/evolution.rs
---

## Signature

```rust
pub fn fuse(ctx: &ReducerContext, a_id: u64, b_id: u64) -> Result<(), String>
```
