---
type: SpacetimeDB Reducer
title: complete_guest_claim
slug: reducers/complete_guest_claim
updated: 2026-08-15
tags: [reducer, spacetimedb, accounts]
abstract: "Complete a guest→account claim: re-key the guest's game data onto the caller, consume the code (single-use), stamp prov…"
resource: server-module/src/accounts.rs#L377
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn complete_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String>
```
