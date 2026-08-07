# 0998 — Fixture: body back-link below the first heading (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Carry no back-link in the header; the only reciprocal-looking line sits in the BODY, below the first level-two heading, unfenced and at column 0.

## Context

Fixture for TOOTH 27 of `evals/adr-backlink-integrity.eval.mjs`.

Unlike the TOOTH 15, 22 and 23 targets — which deliberately have NO level-two
heading at all, so that the whole file is the header view and their fenced or
indented decoys are the only thing keeping them out of it — this document HAS a
real level-two heading, and the relation line below it is neither fenced nor
indented. It is an ordinary column-0 body line.

Fence stripping cannot see it (there is no fence) and the column-0 rule cannot
see it (it IS at column 0). The only thing that keeps it out of the back-link
view is that the view is BOUNDED at the first level-two heading — i.e. that
`headerPreamble` is applied when the view is built.

**Amended-by:** ADR-0997

### Notes

Drop the preamble bound and the line above becomes a header field: the pair
looks reciprocal, and the gap the sibling fixture declares disappears.
