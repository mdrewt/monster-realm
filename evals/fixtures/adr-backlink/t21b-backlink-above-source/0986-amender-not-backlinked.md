# 0986 — Fixture: unanswered amender, target back-links a HIGHER id

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0988
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend a target whose only back-link names an id that sorts ABOVE this one, so an ordering test rather than a membership test would exempt the gap.

## Context

Fixture for TOOTH 21b of `evals/adr-backlink-integrity.eval.mjs`.

The mirror of TOOTH 21's ordering. There the target's non-matching back-link
sorts BELOW the unanswered source; here it sorts ABOVE it. Between the two
directories, both `some(id => id <= source)` and `some(id => id >= source)`
degradations of the membership test are dead.
