<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  Reuses the real id 0166 so that this directory reproduces the exact pair key
  "0168->0166" from KNOWN_BACKLINK_GAPS, with the gap CLOSED.

  Note the Amends field below is an em-dash rather than the real 0166's
  "ADR-0156": 0156 is deliberately absent from this directory, so naming it
  would raise a pre-existing dangling-reference error and TOOTH 8 would pass for
  the wrong reason (TOOTH 0 guards exactly that).

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field on the line below.
-->
# 0166 — Fixture: baselined gap now fixed (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0168
**Subsystems:** tooling-docs
**Decision:** Answer the amending fixture with the reciprocal back-link that the baseline entry says is missing.

## Context

Fixture for TOOTH 8 of `evals/adr-backlink-integrity.eval.mjs`.
