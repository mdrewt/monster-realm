# 0913 — Fixture: reciprocal pair (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0912 (clamps the review window)
**Subsystems:** tooling-docs
**Decision:** Carry the reciprocal back-link with a trailing parenthetical gloss, the real corpus shape.

## Context

Fixture for TOOTH 2 of `evals/adr-backlink-integrity.eval.mjs`.

The parenthetical gloss is load-bearing: `resolveRelationIds` must truncate each
comma-separated token at the first `(` before matching the four-digit id. An
implementation that requires the whole token to be `ADR-NNNN` resolves this
field to nothing and false-REDs an ADR pair that is in fact reciprocal.
