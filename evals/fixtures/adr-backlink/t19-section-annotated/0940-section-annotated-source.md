<!--
  TOOTH 19 — the SECTION-ANNOTATED reference form, which is the real corpus's
  dominant annotated shape (0105, 0109, 0111-0117, 0119, 0123, 0127, 0136, 0137,
  0147 and 0149 all use it).

  The Amends value below is a two-element comma list where the FIRST element
  carries a section annotation AND a parenthetical gloss that itself contains a
  comma, and the SECOND element carries a bare section annotation:

    ADR-0941 §D2 (widens the guard, per the weekly review), ADR-0944 §B1

  Two resolver clauses are pinned by that one value:
    (a) LAXNESS. Split on commas, truncate each token at the first "(", trim,
        then take the LEADING exactly-4-digit run (the character after it must
        be a non-digit or end-of-token). "0941 §D2" resolves to 0941. A STRICT
        resolver that demands the whole token be four digits resolves nothing,
        and every section-annotated pair in the corpus goes silently unenforced.
    (b) ORDERING. Comma-split FIRST, then truncate each token at "(". An
        implementation that truncates the WHOLE value at the first "(" before
        splitting keeps only "ADR-0941 §D2 " and loses ADR-0944 entirely, so the
        0940->0944 gap disappears. Asserting BOTH pair keys is what catches it.

  Both targets are present as files and neither answers, so both pairs are
  genuine one-sided gaps and both endpoints are in-era.

  No bold field marker may appear inside this comment: extractBoldField scans
  the whole header preamble with indexOf, so a marker here would shadow the real
  header field below.
-->
# 0940 — Fixture: section-annotated multi-reference amendment

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** ADR-0941 §D2 (widens the guard, per the weekly review), ADR-0944 §B1
**Amended-by:** —
**Subsystems:** tooling-docs
**Decision:** Amend two ADRs in the corpus's dominant annotated house form, so the resolver must handle section suffixes and comma-separated multi-references together.

## Context

Fixture for TOOTH 19 of `evals/adr-backlink-integrity.eval.mjs`.
