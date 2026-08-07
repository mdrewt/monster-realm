<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  Reuses the real id 0157 so this directory reproduces the exact pair key
  "0172->0157" from KNOWN_BACKLINK_GAPS. Its only job is to be PRESENT: the
  ratchet's precondition is "both endpoints of the baseline entry exist as files
  in the scanned directory", so without this file the 0172->0157 entry would be
  skipped and the "exactly 2 obsolete lines" assertion in TOOTH 8 would be
  unsatisfiable.

  Both relation fields are em-dashes: this file must not itself create a new
  back-link violation (an Amended-by pointer at 0172 would raise the reverse
  gap 0157<-0172, which is NOT the baselined key and would fail TOOTH 8's
  foreign-diagnostic guard in TOOTH 0).

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0157 — Fixture: baselined target present but unamended

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Exist as a file with no relations, satisfying the ratchet's both-endpoints-present precondition for baseline entry 0172->0157 without creating any new violation.

## Context

Fixture for TOOTH 8 of `evals/adr-backlink-integrity.eval.mjs`.
