---
type: SpacetimeDB Reducer
title: pvp_deadline_reaper
slug: reducers/pvp_deadline_reaper
updated: 2026-07-14
tags: [reducer, spacetimedb, pvp]
abstract: "Scheduled reaper: forfeit the non-submitting side when the turn deadline fires. This is a SCHEDULER-ONLY reducer — clie…"
resource: server-module/src/pvp.rs#L1008
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn pvp_deadline_reaper(ctx: &ReducerContext, args: PvpDeadlineSchedule) -> Result<(), String>
```
