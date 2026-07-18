---
type: SpacetimeDB Reducer
title: battle_challenge_reaper
slug: reducers/battle_challenge_reaper
updated: 2026-07-17
tags: [reducer, spacetimedb, pvp]
abstract: "Scheduled reaper: delete a Pending battle challenge that has outlived `CHALLENGE_TTL_MS` (17.5e-1, ADR-0126). This is a…"
resource: server-module/src/pvp.rs#L1087
source: scripts/okf-export.mjs@server-module/src/pvp.rs
---

## Signature

```rust
pub fn battle_challenge_reaper(
    ctx: &ReducerContext,
    args: BattleChallengeReaperSchedule,
) -> Result<(), String>
```
