---
type: SpacetimeDB Reducer
title: account_deletion_reaper
slug: reducers/account_deletion_reaper
updated: 2026-08-31
tags: [reducer, spacetimedb, accounts]
abstract: "Deletion-grace reaper — m22-s3 ships the PRV1-5 RECHECK SKELETON, still no cascade (ADR-0225). Scheduler-only first sta…"
resource: server-module/src/accounts.rs#L788
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    args: AccountDeletionReaperSchedule,
) -> Result<(), String>
```
