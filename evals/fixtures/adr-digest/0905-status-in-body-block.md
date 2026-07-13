# ADR-0905 — Body-embedded Status fixture

**Date:** 2026-07-13
**Slice:** m-infra-d
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** The required header field is absent from the header block; an occurrence in the body code block must not satisfy the validation requirement.

## Context

This fixture omits the required header field from the canonical header block above.
The occurrence below is inside a fenced code block in the body and must be ignored.

```
**Status:** Accepted
```

Fixture only — proves field extraction must not pick up body occurrences.
