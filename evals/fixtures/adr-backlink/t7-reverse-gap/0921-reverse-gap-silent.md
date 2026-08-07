# 0921 — Fixture: reverse back-link gap (silent amender)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare no amendment at all, contradicting the sibling fixture's Amended-by claim.

## Context

Fixture for TOOTH 7 of `evals/adr-backlink-integrity.eval.mjs`. This body names
no four-digit id, so a whole-document scraper cannot invent the missing
`**Amends:**` declaration from prose.
