---
type: SpacetimeDB Reducer
title: ack_evolution_notices
slug: reducers/ack_evolution_notices
updated: 2026-09-18
tags: [reducer, spacetimedb, evolution]
abstract: "Acknowledge the first `count` pending evolution reveals of the CALLER (20r-d, ADR-0254 D5). Owner-keyed by definition: …"
resource: server-module/src/evolution.rs#L359
source: scripts/okf-export.mjs@server-module/src/evolution.rs
---

## Signature

```rust
pub fn ack_evolution_notices(ctx: &ReducerContext, count: u32) -> Result<(), String>
```
