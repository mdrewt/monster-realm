# ADR-0906 — H-namespace reference in Supersedes fixture

**Status:** Accepted
**Date:** 2026-07-13
**Slice:** m-infra-d
**Supersedes:** H-0099
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Supersedes field contains an H- prefixed reference to a non-existent harness ADR to prove extractAllAdrIds cannot see H- IDs.

## Context

This fixture references H-0099 in its Supersedes field. H-0099 does not exist in the
design-corpus.json. The dangling-reference gate must detect this and fail with an error.

Fixture only.
