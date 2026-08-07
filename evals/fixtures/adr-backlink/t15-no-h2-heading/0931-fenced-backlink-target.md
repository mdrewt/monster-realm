# 0931 — Fixture: fenced back-link, no level-two heading (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Carry no header back-link at all; the only occurrence is illustrative template text inside a fenced code block.

### Context

Fixture for TOOTH 15 of `evals/adr-backlink-integrity.eval.mjs`.

This document deliberately uses ONLY level-three subheads and contains no
level-two ATX heading anywhere. `headerPreamble` in `scripts/adr-digest.mjs`
splits on a newline followed by a level-two heading marker, so with no such
heading present the entire document is treated as the header block.

The fence below is illustrative documentation of the canonical header shape. It
is NOT a header field of this ADR, and it must NOT satisfy the reciprocal
back-link requirement for the sibling fixture that amends this one.

```markdown
**Amended-by:** ADR-0930
```

### Notes

This is the same bypass shape that TOOTH 8 of `evals/adr-digest.eval.mjs` guards
for the `Status` field.
