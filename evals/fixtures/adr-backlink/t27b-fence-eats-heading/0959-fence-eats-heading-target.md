# 0959 — Fixture: fence-swallowed level-two heading (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Carry no back-link in the header; the document's only level-two heading lives inside a fenced block, and a reciprocal-looking line sits after that fence.

### Context

Fixture for TOOTH 27b of `evals/adr-backlink-integrity.eval.mjs`.

Every real subhead in this document is level THREE. The one and only level-two
ATX heading is the illustrative sample inside the fenced block below — the
fence opens before it and closes after it, so the heading is code, not
structure.

That is the whole point of the fixture. Bound the view FIRST and the preamble
ends at that level-two heading — everything from the fence onwards, including
the line after the fence, is outside the view. Strip the fence FIRST and the
heading is deleted along with it: no boundary survives anywhere in the
document, the preamble becomes the whole file, and the line after the fence is
pulled into the view.

```markdown
## Context

Illustrative template text: this is how an ADR section heading is written.
```

**Amended-by:** ADR-0999

### Notes

Under the specified composition the line above is NOT a header field of this
ADR and must not satisfy the reciprocal back-link requirement for the sibling
fixture that amends this one.
