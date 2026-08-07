<!--
  DELIBERATE REAL-ID REUSE (fixture ids are normally >= 0900).
  This file reuses the real id 0168 because TOOTH 8 exercises the ratchet on the
  REAL baseline entry "0168->0166" in KNOWN_BACKLINK_GAPS. The ratchet is keyed
  on that literal string, so no >=0900 stand-in can trigger it.
  Nothing outside evals/fixtures/adr-backlink/ reads this file; the scanned ADR
  directory for this tooth is a tmpdir containing only these two files.

  PIN: this fixture is pinned to baseline entry "0168->0166". If a future slice
  fixes that real back-link and deletes the entry from KNOWN_BACKLINK_GAPS,
  re-pin TOOTH 8 to another surviving baseline entry (and update the reciprocal
  note in scripts/adr-digest.mjs).
-->
# 0168 — Fixture: baselined gap now fixed (source)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0166
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Declare the amendment that the baseline entry records as one-sided, but here the target answers reciprocally.

## Context

Fixture for TOOTH 8 of `evals/adr-backlink-integrity.eval.mjs`. In this
directory the baselined violation no longer holds, so the tolerance entry is
obsolete and the ratchet must say so.
