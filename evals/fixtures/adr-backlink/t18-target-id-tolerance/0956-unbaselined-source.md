<!--
  TOOTH 18 — the TARGET-KEYED mirror of TOOTH 10.

  0956 is an ordinary >= 0900 fixture id declaring a BRAND-NEW amendment of the
  real id 0156. 0156 is the TARGET side of the real baseline entry "0166->0156",
  but the pair 0956->0156 is not in KNOWN_BACKLINK_GAPS, so it must be reported.

  A target-keyed tolerance test — `new Set([...KNOWN_BACKLINK_GAPS].map(k =>
  k.slice(6))).has(v.b)` — exempts it, and with it every present and future
  amendment of 0154/0156/0157/0166/0173.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0956 — Fixture: un-baselined amendment of a baselined TARGET id

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0156
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare a fresh one-sided amendment of an id that appears only on the target side of the tolerance baseline, so only a pair-keyed tolerance test stays correct.

## Context

Fixture for TOOTH 18 of `evals/adr-backlink-integrity.eval.mjs`.
