---
type: SpacetimeDB Table
title: account_deletion_reaper_schedule
slug: tables/account_deletion_reaper_schedule
updated: 2026-08-31
tags: [schema, spacetimedb, private]
abstract: "PRIVATE scheduled table colocated with its reducer (ADR-0056 exception), mirroring `guest_claim_reaper_schedule` exactl…"
resource: server-module/src/accounts.rs#L757
source: scripts/okf-export.mjs@server-module/src/accounts.rs
visibility: private
---

## Columns

| Column | Type | PK |
|--------|------|----|
| `scheduled_id` | `u64` | yes |
| `scheduled_at` | `ScheduleAt` | — |
| `account_identity` | `Identity` | — |
