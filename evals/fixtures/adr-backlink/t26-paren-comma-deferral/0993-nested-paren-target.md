# 0993 — Fixture: nested aside, comma after the inner close (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** — (deferred (pending review, §D2), 0992 lands next slice)
**Subsystems:** tooling-docs
**Decision:** Defer the back-link in a nested aside so the comma before the amending id is still inside the outer parentheses but outside the inner ones.

## Context

Fixture for TOOTH 26b of `evals/adr-backlink-integrity.eval.mjs`.

Both commas in this value are nested at least one level deep, so neither is a
top-level comma and the whole value stays a single token that truncates at its
first opening parenthesis down to the em dash alone — the relation resolves to
the empty set and the amendment declared against this ADR is unreciprocated.

The distinguishing detail is the comma AFTER the inner closing parenthesis.
Tracking "am I inside parentheses?" as a boolean rather than as a depth count
clears the flag on that inner close and splits there; a depth counter is still
at depth one and does not.
