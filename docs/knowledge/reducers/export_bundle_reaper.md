---
type: SpacetimeDB Reducer
title: export_bundle_reaper
slug: reducers/export_bundle_reaper
updated: 2026-09-05
tags: [reducer, spacetimedb, privacy]
abstract: "SpacetimeDB reducer export_bundle_reaper."
resource: server-module/src/privacy.rs#L1626
source: scripts/okf-export.mjs@server-module/src/privacy.rs
---

## Signature

```rust
pub fn export_bundle_reaper(
    ctx: &ReducerContext,
    _sched: ExportBundleReaperSchedule,
) -> Result<(), String>
```
