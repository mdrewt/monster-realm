# 0981 — Fixture: amender the target's back-link does NOT name

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0982
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the shared target without being named by its existing back-link, which is the violation this fixture must report.

## Context

Fixture for TOOTH 21 of `evals/adr-backlink-integrity.eval.mjs`.

This ADR is the SECOND amender of the shared target. The target's
`**Amended-by:**` field is NOT empty — it already names the first amender — but
it does not name this id, so this leg is a real forward gap.

Every other "gap must be reported" fixture in this directory tree has a target
whose back-link field resolves to the EMPTY set. This one does not, which is
the whole point: a membership test degraded into an emptiness test still passes
all of those, and still greens the real corpus, while silently accepting the
next ADR that amends an already-amended one.
