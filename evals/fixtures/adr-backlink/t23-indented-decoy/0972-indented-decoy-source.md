# 0972 — Fixture: four-space-indented back-link decoy (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0973
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment whose target answers only from an indented markdown code block, which is not a header field.

## Context

Fixture for TOOTH 23 of `evals/adr-backlink-integrity.eval.mjs`.

The amended ADR in this directory has no level-two heading, so its whole file
is the header view, and its only reciprocal declaration is indented by four
spaces — a markdown code block with no fence to strip. Only the column-0
requirement on the marker keeps it out of the header view.
