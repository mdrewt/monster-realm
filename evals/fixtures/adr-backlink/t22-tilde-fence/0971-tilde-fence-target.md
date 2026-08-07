# 0971 — Fixture: tilde-fenced back-link, no level-two heading (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Carry no header back-link at all; the only occurrence is illustrative template text inside a tilde-delimited fenced block.

### Context

Fixture for TOOTH 22 of `evals/adr-backlink-integrity.eval.mjs`.

This document deliberately uses ONLY level-three subheads and contains no
level-two ATX heading anywhere, so the header view is the entire file — exactly
as in the TOOTH 15 fixture.

The difference is the fence delimiter. CommonMark accepts a run of three or
more tildes as a fenced code block on equal footing with backticks, and authors
reach for the tilde form precisely when the block itself contains backticks.
The block below is illustrative documentation of the canonical header shape. It
is NOT a header field of this ADR and must NOT satisfy the reciprocal back-link
requirement for the sibling fixture that amends this one.

~~~markdown
**Amended-by:** ADR-0970
~~~

### Notes

If fence stripping is ever narrowed back to backticks alone, the line above
becomes a header field again and the bypass that TOOTH 15 closed reopens under
a different delimiter.
