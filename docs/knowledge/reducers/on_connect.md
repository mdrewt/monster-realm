---
type: SpacetimeDB Reducer
title: on_connect
slug: reducers/on_connect
updated: 2026-09-11
tags: [reducer, spacetimedb, lib]
abstract: "Lifecycle: record the live connection, then lazy-provision or touch an `account` (M21, ADR-0179 D4). Anonymous play is …"
resource: server-module/src/lib.rs#L233
source: scripts/okf-export.mjs@server-module/src/lib.rs
---

## Signature

```rust
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String>
```
