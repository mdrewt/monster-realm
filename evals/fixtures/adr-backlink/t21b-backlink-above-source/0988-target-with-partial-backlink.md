# 0988 — Fixture: target whose back-link names only the higher amender

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0987
**Subsystems:** tooling-docs
**Decision:** Carry a non-empty back-link naming only the higher-numbered of this ADR's two amenders, leaving the lower-numbered one unreciprocated.

## Context

Fixture for TOOTH 21b of `evals/adr-backlink-integrity.eval.mjs`.

Two ADRs in this directory amend this one. The back-link above names only the
higher-numbered of the two, so the surviving gap has a source that sorts BELOW
every id in the target's back-link set.
