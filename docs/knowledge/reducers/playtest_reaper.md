---
type: SpacetimeDB Reducer
title: playtest_reaper
slug: reducers/playtest_reaper
updated: 2026-07-19
tags: [reducer, spacetimedb, playtest_tests]
abstract: "SpacetimeDB reducer playtest_reaper."
resource: server-module/src/playtest_tests.rs#L951
source: scripts/okf-export.mjs@server-module/src/playtest_tests.rs
---

## Signature

```rust
pub fn playtest_reaper(ctx: &ReducerContext, _sched: PlaytestReaperSchedule) -> Result<(), String>
```
