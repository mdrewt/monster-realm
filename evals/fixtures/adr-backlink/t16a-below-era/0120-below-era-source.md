<!--
  DELIBERATE REAL-RANGE ID REUSE (fixture ids are normally >= 0900).
  TOOTH 16a needs BOTH endpoints of the pair to sort BELOW the era threshold
  BACKLINK_ERA_MIN = '0151' (ids are 4-char zero-padded, so a plain string
  compare is a numeric compare). No id >= 0900 can ever be below the era, so a
  stand-in id is impossible here — the fixture must use real-range ids.

  0120 and 0121 are chosen deliberately: neither is an endpoint of ANY entry in
  KNOWN_BACKLINK_GAPS. The five baselined pairs are 0166->0156, 0168->0166,
  0169->0154, 0172->0157 and 0177->0173, so nothing collides and the ratchet
  stays silent in this directory (TOOTH 0 enforces that separately).

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0120 — Fixture: below-era amendment source

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0121
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare a one-sided amendment from an id below the back-link era threshold, where the target is also below the threshold.

## Context

Fixture for TOOTH 16a of `evals/adr-backlink-integrity.eval.mjs`. This pair is a
genuine forward back-link gap in shape, but both endpoints predate
`BACKLINK_ERA_MIN`, so the gate must tolerate it in silence.
