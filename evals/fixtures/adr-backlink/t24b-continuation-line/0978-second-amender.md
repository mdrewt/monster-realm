# 0978 — Fixture: second of two amenders (continuation-line form)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0979
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the same target as the sibling fixture, appearing on the wrapped continuation line of the target's back-link list.

## Context

Fixture for TOOTH 24b of `evals/adr-backlink-integrity.eval.mjs`.

This pair is fully reciprocal and the run must exit 0. This id sits on the
target's WRAPPED continuation line — an indented fragment with no bold marker
of its own. A reader that slices a relation value from the marker to the first
newline never sees it and reports this leg as a gap.
