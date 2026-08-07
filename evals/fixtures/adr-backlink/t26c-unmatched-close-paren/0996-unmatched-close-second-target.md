# 0996 — Fixture: second amended target, no back-link (unmatched-close)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Carry no back-link at all, so the second reference of the amending ADR's relation list is an unreciprocated gap.

## Context

Fixture for TOOTH 26c of `evals/adr-backlink-integrity.eval.mjs`.

This is the SECOND reference in 0994's relation list, and the one with teeth.
It is reachable only if the top-level comma that precedes it still splits after
two unmatched closing parentheses — i.e. only if the depth counter is clamped
at zero rather than allowed to go negative. Under an unclamped decrement this
reference is never resolved and its gap silently vanishes.
