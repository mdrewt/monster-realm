# 0918 — Fixture: em-dash sentinel with prose id (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** — (none yet; 0919 deferred the back-link)
**Subsystems:** tooling-docs
**Decision:** Carry an em-dash sentinel whose trailing parenthetical mentions the amending ADR in prose only.

## Context

Fixture for TOOTH 6 of `evals/adr-backlink-integrity.eval.mjs`. This is the real
corpus shape seen at `docs/adr/0139-*.md:7`.

Two mutations die here:

1. Treating the field as "no relation" only when the value is exactly `—`.
   It is not exactly `—` here, so a value-equality test mis-classifies it.
2. Scraping every four-digit run out of the field value. The amending ADR's id
   appears inside the parenthetical prose, so a scraper concludes the back-link
   is present and the gap goes unreported.
