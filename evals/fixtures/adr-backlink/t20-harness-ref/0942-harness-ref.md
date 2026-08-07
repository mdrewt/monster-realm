<!--
  TOOTH 20 (half A) — a reference to an id that is a VALID member of allIds but
  is NOT a file in the scanned directory.

  scripts/adr-digest.mjs:502-508 seeds allIds with the synthetic harness ids
  0002-0034 and every H-NNNN entry of design-corpus.json. None of those has a
  file. Resolving relations against allIds instead of against the SCANNED FILE
  ids therefore invents pairs whose target cannot be opened, read, or repaired —
  on the real corpus that turns 0177's "Amends ADR-0006" into a permanently
  unfixable violation.

  ADR-0020 is in allIds, so the pre-existing dangling-reference check stays
  quiet and this fixture produces no foreign diagnostic (TOOTH 0 guards that).

  HONEST SCOPE OF THIS HALF: because every allIds-only id (0002-0034) sorts
  BELOW BACKLINK_ERA_MIN, the era clause already tolerates this pair even under
  an allIds-based resolver, so half A on its own does not distinguish the two
  resolvers. What it does bite is an implementation that resolves the id and
  then dereferences the absent target record (`byId.get('0020').amendedBy`)
  before the era test — a crash, i.e. a non-zero exit. Half B
  (0943-missing-file-ref.md) is the half that pins the file-existence clause
  itself, with an IN-ERA target.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0942 — Fixture: amendment of a harness id that has no file

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0020
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Reference a synthetic harness id that is valid for dangling-reference purposes but has no file, so a resolver keyed on allIds invents an unrepairable pair.

## Context

Fixture for TOOTH 20 of `evals/adr-backlink-integrity.eval.mjs`.
