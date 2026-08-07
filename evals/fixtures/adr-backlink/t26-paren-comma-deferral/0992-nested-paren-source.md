# 0992 — Fixture: nested-parenthesis deferral (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0993
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment whose target defers the back-link in a NESTED aside, so the comma before this id follows an inner closing parenthesis.

## Context

Fixture for TOOTH 26b of `evals/adr-backlink-integrity.eval.mjs`.

The amended ADR's aside closes an inner parenthetical before the comma that
precedes this id. A depth COUNTER is still inside the outer aside at that
comma; a boolean in-parenthesis FLAG has already been cleared by the inner
`)`, so the flag splits there, manufactures a token beginning with these four
digits, and the deferral note satisfies reciprocity.
