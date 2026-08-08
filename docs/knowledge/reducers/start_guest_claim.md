---
type: SpacetimeDB Reducer
title: start_guest_claim
slug: reducers/start_guest_claim
updated: 2026-08-08
tags: [reducer, spacetimedb, accounts]
abstract: "Bind a CLIENT-minted claim code to the anonymous caller (AUTH-7..11). The server performs zero randomness; the code is …"
resource: server-module/src/accounts.rs#L336
source: scripts/okf-export.mjs@server-module/src/accounts.rs
---

## Signature

```rust
pub fn start_guest_claim(ctx: &ReducerContext, code: String) -> Result<(), String>
```
