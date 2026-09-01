---
type: SpacetimeDB Reducer
title: delete_account
slug: reducers/delete_account
updated: 2026-08-31
tags: [reducer, spacetimedb, accounts]
abstract: "Request account deletion — sets `PendingDeletion` and arms the deletion-grace reaper LAST (rb-24/ADR-0221: spec para 4.…"
resource: server-module/src/accounts.rs#L639
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String>
```
