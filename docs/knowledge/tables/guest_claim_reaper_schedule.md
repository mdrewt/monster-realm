---
type: SpacetimeDB Table
title: guest_claim_reaper_schedule
slug: tables/guest_claim_reaper_schedule
updated: 2026-09-01
tags: [schema, spacetimedb, private]
abstract: "PRIVATE scheduled table colocated with its reducer (ADR-0056 exception). `guest_identity` carries a btree index so the …"
resource: server-module/src/accounts.rs#L864
source: scripts/okf-export.mjs@server-module/src/accounts.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `scheduled_id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
| `guest_identity` | `Identity` | — |
