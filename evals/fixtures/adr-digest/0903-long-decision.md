# ADR-0903 — Long-decision fixture

**Status:** Accepted
**Date:** 2026-07-13
**Slice:** m-infra-d
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** This fixture has a decision field that is intentionally longer than two hundred and forty characters so that the adr-digest validator gate can prove it bites correctly on over-long decision strings and must therefore reject this ADR with an appropriate error.

## Context

Fixture only.
