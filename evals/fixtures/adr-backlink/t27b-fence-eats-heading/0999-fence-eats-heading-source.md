# 0999 — Fixture: fence-swallowed heading (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0959
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend a sibling whose only level-two heading lives inside a fenced block, with a reciprocal-looking line after that fence.

## Context

Fixture for TOOTH 27b of `evals/adr-backlink-integrity.eval.mjs`.

ADR-0959 carries a complete canonical header with no back-link in it. Its only
reciprocal-looking line sits after a fenced block that contains the document's
only level-two heading, so under the specified composition it is outside the
back-link view and this amendment is unreciprocated: the gate must report the
pair key (0999->0959).
