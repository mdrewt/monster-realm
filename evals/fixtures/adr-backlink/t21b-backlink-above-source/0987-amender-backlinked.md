# 0987 — Fixture: amender that IS named by the target's back-link

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0988
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the shared target and be named by its back-link, giving this directory its in-place false-positive guard.

## Context

Fixture for TOOTH 21b of `evals/adr-backlink-integrity.eval.mjs`.

This leg is fully reciprocal in both directions and must stay silent. Its id
sorts ABOVE the unanswered amender in the same directory, which is what makes
the ordering shortcut visible.
