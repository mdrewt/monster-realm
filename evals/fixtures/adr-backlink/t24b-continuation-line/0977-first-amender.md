# 0977 — Fixture: first of two amenders (continuation-line form)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0979
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend a target that answers both amenders with one comma-wrapped list, the second of the two natural multi-amender house forms.

## Context

Fixture for TOOTH 24b of `evals/adr-backlink-integrity.eval.mjs`.

This pair is fully reciprocal and the run must exit 0. This id is named on the
target's first physical line, so it survives even a line-scoped reader — the
sibling fixture is the leg that dies.
