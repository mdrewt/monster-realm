---
type: SpacetimeDB Reducer
title: request_data_export
slug: reducers/request_data_export
updated: 2026-09-01
tags: [reducer, spacetimedb, privacy]
abstract: "Build the caller a fresh export: one chunk per exportable table (split at the game-core sub-chunk boundary), all sharin…"
resource: server-module/src/privacy.rs#L1496
source: scripts/okf-export.mjs@server-module/src/privacy.rs
---

## Signature

```rust
pub fn request_data_export(ctx: &ReducerContext) -> Result<(), String>
```
