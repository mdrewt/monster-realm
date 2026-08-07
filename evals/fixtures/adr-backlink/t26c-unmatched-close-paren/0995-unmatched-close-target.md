# 0995 — Fixture: first amended target, no back-link (unmatched-close)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Carry no back-link at all, so the first reference of the amending ADR's relation list is an unreciprocated gap.

## Context

Fixture for TOOTH 26c of `evals/adr-backlink-integrity.eval.mjs`.

This is the FIRST reference in 0994's relation list. It resolves under every
splitting rule considered, so its gap is the control: it proves the directory
is being scanned at all, which is what makes the absence of the second
reference's gap diagnostic rather than ambiguous.
