---
type: SpacetimeDB Reducer
title: on_connect
slug: reducers/on_connect
updated: 2026-08-23
tags: [reducer, spacetimedb, lib]
abstract: "Lifecycle: lazy-provision or touch an `account` on connect (M21, ADR-0179 D4). Anonymous play is FIRST-CLASS. Returning…"
resource: server-module/src/lib.rs#L206
source: scripts/okf-export.mjs@server-module/src/lib.rs
---

## Signature

```rust
pub fn on_connect(ctx: &ReducerContext) -> Result<(), String>
```
