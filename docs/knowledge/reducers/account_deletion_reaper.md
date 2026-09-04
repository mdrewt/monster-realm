---
type: SpacetimeDB Reducer
title: account_deletion_reaper
slug: reducers/account_deletion_reaper
updated: 2026-09-01
tags: [reducer, spacetimedb, accounts]
abstract: "Deletion-grace reaper — the M22 §4.4 five-step cascade (m22-s3b, ADR-0228). Scheduler-only first statement, then a re-r…"
resource: server-module/src/accounts.rs#L946
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn account_deletion_reaper(
    ctx: &ReducerContext,
    args: AccountDeletionReaperSchedule,
) -> Result<(), String>
```
