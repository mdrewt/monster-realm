# 0001. Record architecture decisions

**Status:** Accepted
**Date:** 2026-06-23
**Slice:** m0
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Use MADR-format ADRs in docs/adr/, authored by the doc-keeper, as the durable rationale record for non-obvious architectural choices.

- Status: accepted
- Date: 2026-06-23

## Context and problem statement
We need durable, automatic records of why decisions were made.

## Considered alternatives
- No ADRs (rely on memory) — rejected: goes stale.
- Wiki — rejected: drifts from the code.

## Decision outcome
- Chosen: MADR-format ADRs in `docs/adr/`, written by the doc-keeper.
- Consequences: rationale stays with the code and is diffable.
