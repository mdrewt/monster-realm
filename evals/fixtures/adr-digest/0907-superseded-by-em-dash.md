# ADR-0907 — Superseded status with em-dash Superseded-by fixture

**Status:** Superseded
**Date:** 2026-07-13
**Slice:** m-infra-d
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Status is Superseded but Superseded-by is set to em-dash instead of an ADR ID, bypassing the pointer check.
**Superseded-by:** —

## Context

This fixture has Status=Superseded but Superseded-by=— (em-dash). The validator must
reject this because a Superseded ADR without a real ADR pointer is semantically broken.
The gate must not silently accept em-dash as a valid Superseded-by value.

Fixture only.
