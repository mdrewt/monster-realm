# 0984 — Fixture: parenthetical-id back-link decoy (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0985
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment whose target defers the back-link and names this id only inside a multi-clause parenthetical aside.

## Context

Fixture for TOOTH 25 of `evals/adr-backlink-integrity.eval.mjs`.

The amended ADR answers with an em-dash sentinel followed by a parenthetical
that names this id AND contains an internal comma. A resolver that scrapes any
four-digit run out of a comma token — rather than reading only a token's
LEADING four-digit run — treats the deferral note as a real back-link and the
gap disappears.
