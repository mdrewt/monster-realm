---
type: SpacetimeDB Reducer
title: delete_account
slug: reducers/delete_account
updated: 2026-08-17
tags: [reducer, spacetimedb, accounts]
abstract: "Request account deletion (M21 half only — sets `PendingDeletion`; M22 extends this same body with the grace window + ca…"
resource: server-module/src/accounts.rs#L499
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn delete_account(ctx: &ReducerContext) -> Result<(), String>
```
