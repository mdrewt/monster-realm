<!--
  TOOTH 16b — MIXED-ERA pair. The SOURCE is in-era (0955 >= '0151'); the TARGET
  is not (0120 < '0151'). The era clause is specified as "enforce only when BOTH
  endpoints are >= BACKLINK_ERA_MIN", so this pair must be tolerated.

  0955 is an ordinary >= 0900 fixture id. 0120 is a deliberate real-range id: no
  id >= 0900 can sort below the era threshold, so the below-era endpoint has to
  come from the real range. 0120 is NOT an endpoint of any KNOWN_BACKLINK_GAPS
  entry (the five baselined pairs are 0166->0156, 0168->0166, 0169->0154,
  0172->0157 and 0177->0173), so nothing collides and the ratchet stays silent.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0955 — Fixture: in-era source amending a below-era target

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0120
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare a one-sided amendment from an in-era source to a below-era target, the exact shape a source-only era test would wrongly report.

## Context

Fixture for TOOTH 16b of `evals/adr-backlink-integrity.eval.mjs`. A source-only
era test (`source >= ERA`) reports this pair; the specified both-endpoints test
tolerates it. That difference is the whole tooth.
