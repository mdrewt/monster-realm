# 0917 — Fixture: bare-form reciprocal pair (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** 0916
**Subsystems:** tooling-docs
**Decision:** Answer the amending fixture with a reciprocal back-link written in the bare four-digit form.

## Context

Fixture for TOOTH 5 of `evals/adr-backlink-integrity.eval.mjs`.

Half-normalisation — resolving bare ids on the `**Amends:**` side but requiring
the `ADR-` prefix on the `**Amended-by:**` side — reports this reciprocal pair
as a violation. Real corpus pairs are written this way, so a half-normalised
implementation floods the gate with false reds.
