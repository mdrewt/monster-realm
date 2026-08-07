<!--
  TOOTH 19 — SECOND target of 0940's amendment, listed AFTER the parenthetical
  gloss that contains a comma. It exists to pin the comma-split-then-truncate
  ordering: an implementation that truncates the whole Amends value at the first
  "(" never reaches this id, and the 0940->0944 gap silently disappears.

  Ordinary >= 0900 fixture id, in-era, not an endpoint of any
  KNOWN_BACKLINK_GAPS entry.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0944 — Fixture: second target listed after a comma-bearing parenthetical

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Answer nothing, so the trailing element of 0940's comma list is a real gap that a truncate-before-split resolver would drop.

## Context

Fixture for TOOTH 19 of `evals/adr-backlink-integrity.eval.mjs`.
