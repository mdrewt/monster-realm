# 0976 — Fixture: target with two repeated Amended-by lines

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0974
**Amended-by:** ADR-0975
**Subsystems:** tooling-docs
**Decision:** Answer both amenders with one repeated relation line each, the form a second slice produces when it appends its own back-link.

## Context

Fixture for TOOTH 24a of `evals/adr-backlink-integrity.eval.mjs`.

Both amenders are named, so this directory is clean and the run must exit 0.

This is the shape an author produces by appending a line rather than editing
the existing one, and 12r-f itself produced it while repairing the real corpus.
Relation extraction must collect EVERY matching line, not just the first.
