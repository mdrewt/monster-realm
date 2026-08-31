---
type: SpacetimeDB Reducer
title: account_deletion_reaper
slug: reducers/account_deletion_reaper
updated: 2026-08-31
tags: [reducer, spacetimedb, accounts]
abstract: "Deletion-grace reaper — THIS SLICE SHIPS A DELIBERATE NO-OP (rb-24, ADR-0221). The table and the reducer must land atom…"
resource: server-module/src/accounts.rs#L707
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    _args: AccountDeletionReaperSchedule,
) -> Result<(), String>
```
