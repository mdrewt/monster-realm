# 0974 — Fixture: first of two amenders (repeated-field form)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0976
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend a target that answers with one repeated back-link line per amender, the first of the two natural multi-amender house forms.

## Context

Fixture for TOOTH 24a of `evals/adr-backlink-integrity.eval.mjs`.

This pair is fully reciprocal and the run must exit 0. A reader who resolves
only the FIRST matching relation line sees the target back-link the other
amender and reports this one as a gap — a false RED that tells the next author
to add a back-link they have already added.
