# 0990 — Fixture: parenthesised-comma deferral (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0991
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment whose target defers the back-link in a parenthetical aside carrying a comma immediately before this id.

## Context

Fixture for TOOTH 26 of `evals/adr-backlink-integrity.eval.mjs`.

The amended ADR answers with an em-dash sentinel plus the aside
`(deferred, 0990 lands next slice)`. A resolver that splits the relation value
on EVERY comma rather than on its top-level commas manufactures a fresh token
`0990 lands next slice)` whose first four characters are digits and which has
no opening parenthesis left to truncate at — so the deferral note resolves this
id, satisfies reciprocity, and the gap disappears.
