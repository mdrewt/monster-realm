# ADR-0080 — Generated knowledge bundle (OKF-conformant schema projection, M8.95)

**Status:** Accepted
**Date:** 2026-07-04
**Slice:** m8.95d
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs, ci-gates
**Decision:** Generate an OKF-conformant knowledge bundle (docs/knowledge/**) from SpacetimeDB schema metadata via okf-export.mjs; gate its drift in CI.


**Status:** Accepted  
**Date:** 2026-07-04  
**Deciders:** Drew Teter  
**Spec:** `specs/monster-realm-v2/M8.95-knowledge-bundle.spec.md`  
**Corpus ADR:** `specs/monster-realm-v2/adr/0057-generated-knowledge-bundle.md`  
**Upholds:** ADR-0003 (SSOT), ADR-0006 (additive schema), ADR-0009 (drift-in-CI),
ADR-0010 (proof-of-teeth), ADR-0040/0044/0045/0046 (privacy posture)

## Context

Agents and humans working in monster-realm most need to understand the
**SpacetimeDB schema and reducer surface** — what tables exist, their columns/PKs,
which are public vs. private (ADR-0040 privacy split), and how they relate. That
knowledge was well-organized but scattered across `server-module/src/` (post-M8.9:
`schema.rs` + domain modules), `ARCHITECTURE.md`, ~20 ADRs, and the schema-snapshot
baseline (`evals/baselines/table-schemas.json`). No single, portable,
agent-navigable surface existed. Harness ADR-0008 (knowledge contract) adopts a
thin OKF-aligned subset to generate such a surface from source.

The hard constraint is **SSOT (ADR-0003)**: the bundle must not become a
second, drifting copy of the schema. A hand-maintained copy that diverges would
mislead agents with confident-but-stale facts — worse than no bundle.

## Considered alternatives

### Source of the bundle
- **Option A (chosen) — Generate from `server-module/src/schema.rs`** by reusing
  the **already-exported** `parseTableSchemas()` from
  `evals/battle-schema-snapshot.eval.mjs` plus a reducer-signature pass over the
  domain modules and ADR cross-references. The same parser that *gates* schema drift
  now *feeds* the bundle, so they cannot disagree. Reducers and visibility are read
  from source + the relevant ADRs.
- **Option B — Hand-author the concept files.** Rejected: a hand-maintained
  duplicate of the schema is exactly the SSOT violation ADR-0003 forbids; it would
  drift on the next additive migration.
- **Option C — Use Google's reference enrichment agent (Gemini/BigQuery).**
  Rejected: wrong source system; needs GCP; non-deterministic; over-built for a
  schema this size.

### Freshness / trust
- **Option F1 (chosen) — Commit the bundle as a generated artifact and
  drift-check it** (regenerate in `--check` → must equal committed), mirroring
  `bindings-drift` and the schema-snapshot pattern (ADR-0009/0050). Producer is the
  sole writer; a hand edit to any `docs/knowledge/**` file fails the drift gate.
- **Option F2 — Generate on demand, don't commit.** Rejected: loses diff review
  and the drift gate; a reader cannot verify freshness.

### Conformance
- **Option G1 (chosen) — Reuse the harness `okf-lint.mjs` + a
  `knowledge-bundle-conformance` eval with proof-of-teeth** (a malformed concept
  and a stale bundle must both be flagged — ADR-0010), auto-discovered by
  `evals/run.mjs`, wired into `just eval`/`just ci`.
- **Option G2 — Trust the producer, no gate.** Rejected: ADR-0010 requires every
  mechanical gate to ship a known-bad fixture it must reject.

## Decision outcome

**Chosen: A + F1 + G1.** A generated, committed, drift-checked OKF-conformant
bundle at `docs/knowledge/` — one `SpacetimeDB Table` concept per table (columns,
PK, `visibility`, `resource:` → source line, bundle-relative FK links to related
table concepts) + `SpacetimeDB Reducer` concepts for the reducer surface + a
generated `Schema Overview` concept + a generated `index.md`. Produced by
`scripts/okf-export.mjs`; linted and drift-gated under `just eval`/`just ci`.

The `docs/research/` library is brought to conformance in the same milestone by
adding `type: Research Note` to each `docs/research/*.md` (additive — no existing
fields removed).

## Implementation details

| Artifact | Role |
|---|---|
| `scripts/okf-export.mjs` | Sole producer; reuses `parseTableSchemas()` from the schema-snapshot eval; emits sorted, deterministic concept files |
| `docs/knowledge/` (51 files) | The committed bundle: 22 table concepts + index, 25 reducer concepts + index, `schema-overview.md`, root `index.md` |
| `.claude/hooks/okf-lint.mjs` | Vendored copy of harness `scripts/okf-lint.mjs`; no cross-repo import (WORKSPACE-PLAN §13) |
| `evals/knowledge-bundle-conformance.eval.mjs` | Lint + drift gate; proof-of-teeth: malformed concept rejected + stale bundle detected |
| `just knowledge` / `just knowledge-check` | Justfile recipes to regenerate and drift-check the bundle |
| `.claude/hooks/research-lint.mjs` | Type-aware research library linter (new, vendored); validates `type: Research Note` |
| `.claude/hooks/research-index.mjs` | Extended to carry/regenerate the `type` column in `docs/research/INDEX.md` |

## Consequences

- **Positive:** agents get one portable, navigable schema surface generated from
  truth; SSOT intact (drift fails CI); the privacy posture (ADR-0040/0044/0045/0046)
  is made explicit and machine-checkable in the bundle; reuses the schema-snapshot
  parser and the research-index/lint machinery; portable to a future memory backend
  or viewer.
- **Negative (accepted):** one more generated artifact + CI gate to maintain (cost
  bounded — the producer reuses existing parsing; the gate is one eval); the bundle
  is a *projection*, never a source of truth — ADRs and `ARCHITECTURE.md` remain
  authoritative for rationale; OKF v0.1 churn risk absorbed by keeping the concept
  shape minimal (one required field + link convention, behind `standards/knowledge-format.md`).

## Slices

- **M8.95a** (PR #102): producer `scripts/okf-export.mjs` + generated `docs/knowledge/` (51 files) + `just knowledge`/`knowledge-check` + vendored `okf-lint.mjs`
- **M8.95b** (PR #103): `evals/knowledge-bundle-conformance.eval.mjs` — lint + drift + proof-of-teeth
- **M8.95c** (PR #104): research-library conformance — `type: Research Note` on `docs/research/*.md` + vendored `research-lint.mjs` + regenerated `INDEX.md`
- **M8.95d** (this PR): doc-keeper — ARCHITECTURE.md, ADR-0080, CHANGELOG, memory + verifier gate
