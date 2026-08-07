<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  Reuses the real id 0154 so that this directory has BOTH endpoints of the
  baseline entry "0169->0154" present as files — the precondition the ratchet
  requires before it may declare an entry obsolete. Without this file the entry
  would simply be skipped and TOOTH 17 would prove nothing.

  This ADR answers nothing (the back-link field below is an em-dash): the entry
  is obsolete because the DECLARATION on 0169 is gone, not because the pair
  became reciprocal.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0154 — Fixture: baseline target still present, still silent

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Be present as a file without carrying any reciprocal back-link, so the ratchet's both-endpoints-present precondition is met.

## Context

Fixture for TOOTH 17 of `evals/adr-backlink-integrity.eval.mjs`.
