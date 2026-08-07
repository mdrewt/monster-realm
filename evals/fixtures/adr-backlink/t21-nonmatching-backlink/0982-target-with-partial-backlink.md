# 0982 — Fixture: target whose back-link names only ONE of its two amenders

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0980
**Subsystems:** tooling-docs
**Decision:** Carry a non-empty back-link that names the first amender only, so the second amender's declaration is unreciprocated.

## Context

Fixture for TOOTH 21 of `evals/adr-backlink-integrity.eval.mjs`.

Two ADRs in this directory declare an amendment of this one. The back-link
above names only the first. The correct rule is MEMBERSHIP — "does the target's
resolved back-link set contain the source?" — not "is the target's back-link
set non-empty?", and not "does it contain something that sorts at or after the
source?".
