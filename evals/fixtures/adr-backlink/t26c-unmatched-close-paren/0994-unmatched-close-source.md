# 0994 — Fixture: unmatched closing parenthesis in a relation list (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0995 §D2 — see notes a) and b), ADR-0996
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Name two amended ADRs in one list whose first gloss carries enumerator parentheses that close without ever opening.

## Context

Fixture for TOOTH 26c of `evals/adr-backlink-integrity.eval.mjs`.

Neither amended ADR answers, so BOTH references must be reported. The comma
separating them is a top-level comma, but it follows two closing parentheses
that were never opened. A parenthesis-depth counter that decrements without a
floor is at depth minus two by then, never returns to zero, and silently drops
the second reference — the same loss of bite TOOTH 19 pins for the
truncate-before-split ordering, reached through a different door.
