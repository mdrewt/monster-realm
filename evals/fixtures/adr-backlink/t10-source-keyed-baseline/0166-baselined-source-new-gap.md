<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  This file reuses the real id 0166 because 0166 is the SOURCE side of the real
  baseline entry "0166->0156". TOOTH 10 checks that the tolerance is keyed on the
  PAIR, not on the source id: a source-keyed set would blanket-exempt every
  future declaration made by 0166 (and by 0174/0176, the spec's own ADRs).

  0156 is deliberately NOT in this directory, so no baseline entry has both
  endpoints present and the ratchet must stay silent here.
-->
# 0166 — Fixture: baselined source with a brand-new gap

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0955
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare a fresh amendment that is not covered by any baseline entry, from an id that is a baselined source.

## Context

Fixture for TOOTH 10 of `evals/adr-backlink-integrity.eval.mjs`. The pair here
is not a baselined pair, so it must be reported even though the source id
appears on the left-hand side of a baseline entry.
