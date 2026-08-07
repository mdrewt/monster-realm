<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  Reuses the real id 0156 because a target-keyed tolerance cheat is keyed on the
  literal target ids of KNOWN_BACKLINK_GAPS; no >=0900 stand-in can trip it.

  0166 is deliberately ABSENT from this directory. If it were present, the
  baseline entry 0166->0156 would have BOTH endpoints present as files, the
  ratchet's precondition would be met, and an "obsolete" line could green TOOTH
  18 for a reason that has nothing to do with target-keyed tolerance. With 0166
  absent, no baseline entry has both endpoints here and the ratchet must stay
  silent (TOOTH 0 enforces that separately).

  Both relation fields are em-dashes: the amendment declared by 0956 must go
  unanswered, and this file must not create any other violation.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0156 — Fixture: baselined target id, freshly amended and silent

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Answer nothing, so the un-baselined pair 0956->0156 is a genuine one-sided gap that only a target-keyed tolerance cheat could swallow.

## Context

Fixture for TOOTH 18 of `evals/adr-backlink-integrity.eval.mjs`.
