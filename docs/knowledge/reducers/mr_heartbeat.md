---
type: SpacetimeDB Reducer
title: mr_heartbeat
slug: reducers/mr_heartbeat
updated: 2026-08-23
tags: [reducer, spacetimedb, observability]
abstract: "Scheduler-only, write-free dead-man beat (OBS-1/OBS-3). GUARD FIRST (`playtest_reaper` precedent); exactly one emission…"
resource: server-module/src/observability.rs#L115
source: scripts/okf-export.mjs@server-module/src/observability.rs
---

## Signature

```rust
pub fn mr_heartbeat(ctx: &ReducerContext, _sched: MrHeartbeatSchedule) -> Result<(), String>
```
