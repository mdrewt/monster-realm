# 0991 — Fixture: deferral aside with an internal comma (target)

**Status:** Accepted
**Date:** 2026-08-07
**Slice:** 12r-f-fixture
**Supersedes:** —
**Amends:** —
**Amended-by:** — (deferred, 0990 lands next slice)
**Subsystems:** tooling-docs
**Decision:** Defer the back-link in an aside whose internal comma sits directly before the amending id, so a naive comma split resolves that id.

## Context

Fixture for TOOTH 26 of `evals/adr-backlink-integrity.eval.mjs`.

A deferral note is not a back-link. The comma in this aside is INSIDE the
parentheses, so a top-level-comma split leaves the whole value as one token,
that token truncates at its first `(` down to the em dash alone, and the
relation resolves to the empty set — the amendment declared against this ADR
is unreciprocated.

This is the shape TOOTH 25 could not pin. There the id shared its comma token
with the leading em dash, so the leading-four-digit-run rule rejected it with
or without any splitting or truncation refinement. Here the parenthesised comma
manufactures a token that BEGINS with the four digits, which is the only way
the splitting rule becomes observable at all.
