<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  This file reuses the real id 0172 because TOOTH 8 exercises the ratchet on the
  REAL baseline entry "0172->0157" in KNOWN_BACKLINK_GAPS. The ratchet is keyed
  on that literal string, so no >=0900 stand-in can trigger it.

  0172 is the SECOND simultaneously-obsolete entry in this directory (0168->0166
  is the first). It is obsolete by the DECLARATION-GONE branch: the Amends field
  below is an em-dash, so the recorded violation 0172->0157 cannot hold. That
  makes this directory pin BOTH obsolete reason clauses at once, and it proves
  the ratchet loop visits every baseline entry rather than breaking after the
  first hit or slicing the set.

  The Amends field is an em-dash rather than the real 0172's pointer for a
  second reason as well: naming an id that is absent from this tmpdir would
  raise a pre-existing dangling-reference error and TOOTH 8 would pass for the
  wrong reason (TOOTH 0 guards exactly that).

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0172 — Fixture: baselined amendment declaration removed

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare no amendment at all, so the baselined violation 0172->0157 cannot hold and its tolerance entry is dead debt the ratchet must report.

## Context

Fixture for TOOTH 8 of `evals/adr-backlink-integrity.eval.mjs`. Paired with
`0157-baseline-target-present.md`; together they make a SECOND baseline entry
obsolete in this directory, by a different branch than 0168->0166.
