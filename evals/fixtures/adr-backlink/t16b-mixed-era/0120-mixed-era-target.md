<!--
  DELIBERATE REAL-RANGE ID REUSE (fixture ids are normally >= 0900).
  TOOTH 16b needs a target that sorts BELOW BACKLINK_ERA_MIN = '0151', which no
  id >= 0900 can do. 0120 is not an endpoint of any KNOWN_BACKLINK_GAPS entry,
  so the ratchet must stay silent here.

  This file is a separate copy from the 0120 in t16a-below-era/: each fixture
  directory is copied into its own tmpdir, so the two never share a corpus.
-->
# 0120 — Fixture: below-era target of an in-era amendment

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Carry no reciprocal back-link, so only the both-endpoints era clause can keep the gate quiet about this mixed-era pair.

## Context

Fixture for TOOTH 16b of `evals/adr-backlink-integrity.eval.mjs`.
