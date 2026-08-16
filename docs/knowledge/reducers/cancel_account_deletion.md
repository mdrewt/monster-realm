---
type: SpacetimeDB Reducer
title: cancel_account_deletion
slug: reducers/cancel_account_deletion
updated: 2026-08-16
tags: [reducer, spacetimedb, accounts]
abstract: "Reverse a pending deletion. Idempotent no-op on an already-`Active` account (AUTH-38), so `PendingDeletion` is never a …"
resource: server-module/src/accounts.rs#L522
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn cancel_account_deletion(ctx: &ReducerContext) -> Result<(), String>
```
