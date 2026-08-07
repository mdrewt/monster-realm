# 0910 — Fixture: forward back-link gap (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0911
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment to the sibling fixture so the forward back-link check has a pair to enforce.

## Context

Fixture for TOOTH 1 and TOOTH 3 of `evals/adr-backlink-integrity.eval.mjs`.
The amended ADR in this directory deliberately omits the reciprocal
`**Amended-by:**` declaration, so this pair is a forward violation.
