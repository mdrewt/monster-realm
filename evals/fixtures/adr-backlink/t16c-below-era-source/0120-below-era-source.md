<!--
  DELIBERATE REAL-RANGE ID REUSE (fixture ids are normally >= 0900).
  TOOTH 16c needs a SOURCE that sorts BELOW BACKLINK_ERA_MIN = '0151', which no
  id >= 0900 can do. 0120 is not an endpoint of any KNOWN_BACKLINK_GAPS entry
  (the five baselined pairs are 0166->0156, 0168->0166, 0169->0154, 0172->0157
  and 0177->0173), so the ratchet must stay silent here.

  This file is a separate copy from the 0120 in t16a-below-era/ and
  t16b-mixed-era/: each fixture directory is copied into its own tmpdir, so the
  three never share a corpus.

  Real-corpus relevance: 0037, 0068, 0075, 0085, 0090 and 0148 all carry
  Amended-by pointers into the in-era range, i.e. exactly this quadrant. They
  are reciprocal today; the first one that is not would red CI on a pre-0151
  file that is outside this slice's scope.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0120 — Fixture: below-era source amending an in-era target

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0956
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare a one-sided amendment from a below-era source to an in-era target, the exact shape a target-only era test would wrongly report.

## Context

Fixture for TOOTH 16c of `evals/adr-backlink-integrity.eval.mjs`. A target-only
era test (`target >= ERA`) reports this pair; the specified both-endpoints test
tolerates it. That difference is the whole tooth.
