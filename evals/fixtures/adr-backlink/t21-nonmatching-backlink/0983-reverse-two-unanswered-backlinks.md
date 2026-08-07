# 0983 — Fixture: two back-links, neither answered by an Amends declaration

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0980, ADR-0981
**Subsystems:** tooling-docs
**Decision:** Claim two amenders that both declare an amendment of a different ADR, giving the reverse direction the same non-matching-set shape.

## Context

Fixture for TOOTH 21 of `evals/adr-backlink-integrity.eval.mjs` — the REVERSE
leg.

Both ids named above do carry a non-empty `**Amends:**` field, but both point
at a different ADR (0982), not at this one. So on the reverse side too, the
counterpart set is non-empty and simply does not contain the id under test —
the shape that an emptiness test, a "has at least two entries" test, or an
ordering test all mis-classify as satisfied.
