# 0912 — Fixture: reciprocal pair (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0913
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the sibling fixture ADR, which carries the matching reciprocal back-link.

## Context

Fixture for TOOTH 2 (false-positive guard) of
`evals/adr-backlink-integrity.eval.mjs`. This pair is fully reciprocal, so a
correct back-link check must stay silent on it.
