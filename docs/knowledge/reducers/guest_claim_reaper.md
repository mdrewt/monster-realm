---
type: SpacetimeDB Reducer
title: guest_claim_reaper
slug: reducers/guest_claim_reaper
updated: 2026-09-01
tags: [reducer, spacetimedb, accounts]
abstract: "Reap a single expired `guest_claim` row (AUTH-27). Scheduler-only. Deletes exactly the PK row named by `args` (a PK del…"
resource: server-module/src/accounts.rs#L883
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn guest_claim_reaper(
    ctx: &ReducerContext,
    args: GuestClaimReaperSchedule,
) -> Result<(), String>
```
