# 0973 — Fixture: indented back-link, no level-two heading (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs
**Decision:** Carry no header back-link at all; the only occurrence is sample text in a four-space-indented markdown code block.

### Context

Fixture for TOOTH 23 of `evals/adr-backlink-integrity.eval.mjs`.

This document deliberately uses ONLY level-three subheads and contains no
level-two ATX heading anywhere, so the header view is the entire file.

The block below is indented by four spaces. CommonMark renders that as a code
block — literal sample text, exactly like a fenced block — but there is no
fence delimiter anywhere in it, so fence stripping is structurally incapable of
removing it. The single thing that keeps it out of the header view is the
requirement that a relation marker start at column 0, which every canonical ADR
header satisfies and no indented sample ever does.

    **Amended-by:** ADR-0972

### Notes

Drop the column-0 requirement and the indented sample above becomes a header
field, the pair looks reciprocal, and the gap disappears — the TOOTH 15 bypass
again, through the one door fence stripping cannot close.
