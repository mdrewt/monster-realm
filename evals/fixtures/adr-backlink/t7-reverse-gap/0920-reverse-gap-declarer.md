# 0920 — Fixture: reverse back-link gap (Amended-by declarer)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0921
**Subsystems:** tooling-docs
**Decision:** Claim to be amended by the sibling fixture, which never declares the matching Amends.

## Context

Fixture for TOOTH 7 of `evals/adr-backlink-integrity.eval.mjs`. This is the
reverse direction: the violation is only visible if the check walks
`**Amended-by:**` outward as well as `**Amends:**`.
