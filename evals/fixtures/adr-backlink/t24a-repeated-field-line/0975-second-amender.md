# 0975 — Fixture: second of two amenders (repeated-field form)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0976
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the same target as the sibling fixture, so the target must carry two back-links for the directory to be clean.

## Context

Fixture for TOOTH 24a of `evals/adr-backlink-integrity.eval.mjs`.

This pair is fully reciprocal and the run must exit 0. This id is named on the
target's SECOND `**Amended-by:**` line, so it is the leg that dies first if
relation extraction stops at the first match.
