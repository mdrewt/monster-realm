# 0997 — Fixture: body back-link below the first heading (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0998
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend a sibling whose only reciprocal-looking line sits in the body, below the first level-two heading, unfenced and at column 0.

## Context

Fixture for TOOTH 27 of `evals/adr-backlink-integrity.eval.mjs`.

The sibling ADR-0998 carries a complete canonical header with NO back-link in
it. The reciprocal-looking line lives in its body. This amendment is therefore
unreciprocated and the gate must report the pair key (0997->0998).
