# 0970 — Fixture: tilde-fenced back-link decoy (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0971
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment whose target answers only from inside a tilde-delimited code fence, which is not a header field.

## Context

Fixture for TOOTH 22 of `evals/adr-backlink-integrity.eval.mjs`.

The amended ADR in this directory has no level-two heading, so its whole file
is the header view, and its only reciprocal declaration sits inside a `~~~`
fence. A fence stripper that knows about backticks only leaves that line
standing and the gap disappears.
