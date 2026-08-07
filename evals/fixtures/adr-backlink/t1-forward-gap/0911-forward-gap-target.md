# 0911 — Fixture: forward back-link gap (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Deliberately omit the reciprocal back-link to the amending fixture ADR.

## Context

Fixture for TOOTH 1 and TOOTH 3 of `evals/adr-backlink-integrity.eval.mjs`.

This body text intentionally names NO four-digit id: if it did, a
whole-document id scraper could mistake the prose mention for a real
`**Amended-by:**` declaration and false-green the tooth.
