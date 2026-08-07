<!--
  TOOTH 20 (half B) — the half with teeth: an IN-ERA reference to an id that is
  not a file anywhere.

  The Amends value is the BARE form "0958". That form matters twice over:
    * scripts/adr-digest.mjs:282 extractAllAdrIds only recognises "ADR-NNNN" and
      "H-NNNN", so the pre-existing dangling-reference check does NOT fire on a
      bare id — this directory stays free of foreign diagnostics (TOOTH 0).
    * the back-link resolver DOES resolve bare ids (TOOTH 4), so 0958 reaches
      the file-existence clause and nothing else.

  0958 is >= BACKLINK_ERA_MIN, so the era clause cannot tolerate the pair. The
  ONLY rule that can keep the gate quiet here is "the resolved id must be a file
  in the scanned directory". Drop that clause and the generator reports
  (0943->0958) — a violation with no file to fix.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0943 — Fixture: in-era bare reference to a non-existent file

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** 0958
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Name an in-era id that has no file in the scanned directory, so only the file-existence clause of the resolver can keep the back-link gate silent.

## Context

Fixture for TOOTH 20 of `evals/adr-backlink-integrity.eval.mjs`.
