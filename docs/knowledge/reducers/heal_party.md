---
type: SpacetimeDB Reducer
title: heal_party
slug: reducers/heal_party
updated: 2026-07-19
tags: [reducer, spacetimedb, raising]
abstract: "Restore all party monsters to full HP at a heal location. Reject-never-burns: all checks run BEFORE the first DB write.…"
resource: server-module/src/raising.rs#L285
source: scripts/okf-export.mjs@server-module/src/raising.rs
---

## Signature

```rust
pub fn heal_party(ctx: &ReducerContext, location_id: u32) -> Result<(), String>
```
