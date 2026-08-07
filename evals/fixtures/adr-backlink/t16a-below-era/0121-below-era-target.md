<!--
  DELIBERATE REAL-RANGE ID REUSE (fixture ids are normally >= 0900).
  See the sibling 0120 fixture: TOOTH 16a requires both endpoints to sort below
  BACKLINK_ERA_MIN = '0151', which no id >= 0900 can do.

  0121 is not an endpoint of any KNOWN_BACKLINK_GAPS entry, so the ratchet must
  stay silent here.
-->
# 0121 — Fixture: below-era amendment target (does not answer)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Carry no reciprocal back-link at all, so the pair is one-sided and only the era clause can keep the gate quiet.

## Context

Fixture for TOOTH 16a of `evals/adr-backlink-integrity.eval.mjs`.
