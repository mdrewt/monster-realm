# 0979 — Fixture: target with a wrapped Amended-by list

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0977,
  ADR-0978
**Subsystems:** tooling-docs
**Decision:** Answer both amenders with one comma list wrapped onto a second, indented line, which markdown renders as a single paragraph.

## Context

Fixture for TOOTH 24b of `evals/adr-backlink-integrity.eval.mjs`.

Both amenders are named, so this directory is clean and the run must exit 0.

The wrapped form renders identically to the single-line form — markdown folds
the indented continuation into the same paragraph — so an author has no visual
cue that a line-scoped reader would drop the second id. Relation extraction
must absorb indented continuation lines that carry no bold marker of their own.
