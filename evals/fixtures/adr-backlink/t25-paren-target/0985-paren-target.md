# 0985 — Fixture: deferred back-link with a parenthetical id (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** — (0984 pending, tracked in the next slice)
**Subsystems:** tooling-docs
**Decision:** Carry an em-dash sentinel whose multi-clause parenthetical names the amending ADR in prose only, so the relation resolves to nothing.

## Context

Fixture for TOOTH 25 of `evals/adr-backlink-integrity.eval.mjs`.

A deferral note is not a back-link. This value differs from the TOOTH 6 fixture
in one respect that matters: the parenthetical contains an internal COMMA, so
the value survives the comma split as two tokens rather than one. Neither token
has a leading four-digit run — the first begins with the em dash, the second
with prose — so the relation resolves to the empty set and the amendment
declared against this ADR is still unreciprocated.
