# 0980 — Fixture: amender that IS named by the target's back-link

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0982
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend the shared target and be named by its back-link, so this leg is the reciprocal half of the fixture and must stay silent.

## Context

Fixture for TOOTH 21 of `evals/adr-backlink-integrity.eval.mjs`.

This ADR is the FIRST amender of the shared target. The target names this id in
its back-link field, so this leg is fully reciprocal and no diagnostic may
mention it. It exists to give the fixture a false-positive guard in the same
directory as the violation, which is what kills the "the target already has a
back-link (or two), so any further amendment is fine" family of shortcuts.

This is the real corpus shape: `docs/adr/0174-*.md` carries
`ADR-0175, ADR-0176` and `docs/adr/0162-*.md` carries `ADR-0163, ADR-0164`.
