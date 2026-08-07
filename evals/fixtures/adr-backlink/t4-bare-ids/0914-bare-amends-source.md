# 0914 — Fixture: bare (un-prefixed) Amends id, gap

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** 0915
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare an amendment using the bare four-digit form with no ADR- prefix, the shape several real corpus ADRs use.

## Context

Fixture for TOOTH 4 of `evals/adr-backlink-integrity.eval.mjs`.

`extractAllAdrIds` only recognises the `ADR-NNNN` and `H-NNNN` prefixed forms,
so reusing it for relation resolution makes this declaration invisible and the
gap goes unreported.
