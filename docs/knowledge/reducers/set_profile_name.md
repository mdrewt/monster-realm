---
type: SpacetimeDB Reducer
title: set_profile_name
slug: reducers/set_profile_name
updated: 2026-07-19
tags: [reducer, spacetimedb, ranking]
abstract: "Rename the caller's display name (ADR-0132 D1). The single client-callable reducer in this module — it is **profile-unt…"
resource: server-module/src/ranking.rs#L139
source: scripts/okf-export.mjs@server-module/src/ranking.rs
---

## Signature

```rust
pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String>
```
