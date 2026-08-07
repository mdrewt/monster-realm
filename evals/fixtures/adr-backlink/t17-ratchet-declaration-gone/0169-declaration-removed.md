<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  This file reuses the real id 0169 because TOOTH 17 exercises the ratchet's
  SECOND obsolescence branch on the REAL baseline entry "0169->0154" in
  KNOWN_BACKLINK_GAPS. The ratchet is keyed on that literal string, so no
  >= 0900 stand-in can trigger it.

  The baselined violation was "0169 amends 0154 but 0154 does not answer". Here
  the amendment DECLARATION itself is gone (the field below is an em-dash), so
  the violation no longer holds for a reason that has nothing to do with
  reciprocity — the most common real-world reason, an ADR being rewritten. The
  entry is dead debt and the ratchet must say so.

  COLLISION CHECK: this directory contains exactly 0169 and 0154. Of the five
  baseline entries — 0166->0156, 0168->0166, 0169->0154, 0172->0157,
  0177->0173 — only "0169->0154" has BOTH endpoints present as files here, so
  exactly one obsolete line may fire and the "exactly 1" assertion cannot be
  satisfied by some other entry.

  PIN: pinned to baseline entry "0169->0154". If a future slice fixes that real
  back-link and deletes the entry from KNOWN_BACKLINK_GAPS, re-pin TOOTH 17 to
  another surviving entry (and update the reciprocal note in
  scripts/adr-digest.mjs).

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0169 — Fixture: baselined amendment declaration removed (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare no amendment at all, so the baselined violation 0169->0154 cannot hold and its tolerance entry is obsolete.

## Context

Fixture for TOOTH 17 of `evals/adr-backlink-integrity.eval.mjs`. The pair is not
reciprocal here — it simply does not exist any more. A ratchet that only asks
"is the pair now reciprocal?" keeps the entry alive forever.
