# ADR-0104 — M-infra-d: ADR digest convention and agent-facing corpus compaction

**Status:** Accepted
**Date:** 2026-07-13
**Slice:** m-infra-d (infra slice, insertable any time after M14.5)
**Supersedes:** —
**Amends:** —
**Subsystems:** tooling-docs, ci-gates
**Decision:** Canonical header block (Status/Date/Slice/Supersedes/Amends/Subsystems/Decision) + generated drift-gated DIGEST.md compacting the 100+ ADR corpus for agent navigation.

## Context

The decision corpus grew to 104 ADRs (~620 KB across two locations: design `0002`–`0034`
in the harness spec corpus; implementation `0001`, `0035`+ in `docs/adr/`). Build-loop
agents consumed it by grepping raw prose, and nothing marked which ADRs were still
binding — supersession/amendment facts lived only inside individual files, in two
different header dialects (bold-field block in newer ADRs, `- Status:` list style in
older ones). The 0055–0057 harness/project numbering collision was tribal knowledge in a
README paragraph. Every planner/reviewer pass re-derived "what is still true" from raw
prose, and stale decisions got cited as live.

## Decision

### D1 — Canonical header block (infra-d-1/2/3)

All new ADRs (≥ 0104) MUST carry the canonical header block immediately after the title,
in this exact order:

```
**Status:** Accepted          (∈ {Accepted, Superseded, Deprecated})
**Date:** YYYY-MM-DD
**Slice:** <milestone-slug>
**Supersedes:** — or ADR-NNNN
**Amends:** — or ADR-NNNN
**Subsystems:** <vocab>        (1–3 values, comma-separated)
**Decision:** <sentence ≤240 chars>
```

Conditional fields (add ONLY when applicable):
```
**Superseded-by:** ADR-NNNN  (when Status = Superseded)
**Amended-by:** ADR-NNNN     (when a later ADR amends this one)
```

An ADR that only *amends* another stays `Accepted`; the amended ADR gains
`**Amended-by:**`. Status `Superseded` requires `**Superseded-by:**`.

### D2 — Subsystem vocabulary (infra-d-2, default D-infra-d-3 applied)

The controlled vocabulary is:

| Tag | Scope |
|-----|-------|
| `battle` | Turn resolution, status/ability/weather, battle reducers |
| `evolution-fusion` | Evolution transforms, fusion, species content |
| `movement-netcode` | Server-paced movement, prediction, reconciliation, zones |
| `content` | Content loading, RON registries, CONTENT_VERSION, seeding |
| `schema-persistence` | Table definitions, BSATN, additive migrations |
| `client-ui` | Client rendering, store, PixiJS, DOM shell |
| `ci-gates` | CI recipes, mutation, coverage, evals, proof-of-teeth |
| `tooling-docs` | Scripts, justfile recipes, ADRs, knowledge bundles, docs |
| `security-authz` | RLS, privacy tables, secret-scan, auth, Semgrep |
| `economy-quests` | Currency, shop, wallet, quests, dialogue flags |

The vocabulary may be amended by a future ADR (note amendment in `**Amends:**` /
`**Amended-by:**`). A value outside this vocabulary fails the CI drift gate.

### D3 — Generated DIGEST.md (infra-d-4)

`scripts/adr-digest.mjs` (Node, zero dependencies) generates `docs/adr/DIGEST.md`:
- One row per project ADR: id, status, slice, subsystems, decision one-liner
- Flat numeric master list first; then grouped by subsystem
- Dead (Superseded/Deprecated) ADRs rendered struck-through with supersession pointer
- H- namespace section for the harness design corpus (frozen `design-corpus.json`)
- DO-NOT-EDIT banner with recipe name; no wall-clock timestamps in the body

Output is byte-deterministic for a given corpus. `just adr-digest` regenerates;
`just ci` includes a drift check (via eval `adr-digest`).

### D4 — Legacy tolerance (backfill phased) (right-sizing note applied)

All project ADRs authored before this slice (0001–0103) are in a `LEGACY_TOLERANCE`
set in `scripts/adr-digest.mjs`. The generator:
- Warns (does NOT fail) on missing canonical fields in legacy ADRs
- Shows `PENDING` in DIGEST for missing subsystems/decision/slice
- Does NOT modify legacy ADR files (append-only record rule)

The follow-up backfill slice removes entries from `LEGACY_TOLERANCE` one-by-one by
editing the existing ADR files' headers; the gate shrinks to zero.

### D5 — Harness design corpus (infra-d-5)

`docs/adr/design-corpus.json` is a frozen snapshot of harness ADRs H-0002–H-0034
plus the H-0055/H-0056/H-0057 collision entries. The `collision_map` field encodes
the offset: `H-0055 → 0056`, `H-0056 → 0057`, `H-0057 → 0080`. The generator
resolves H- references against this file; a dangling H- reference fails the gate.

### D6 — Convention update (infra-d-8)

`AGENTS.md` gains a note: new ADRs must use the canonical header block (fields +
vocabulary) and run `just adr-digest` before commit; the DIGEST — not raw grep — is
the first stop for "is there a decision about X?".

## Considered alternatives

**D-infra-d-1 (decision one-liner):** extraction from the `## Decision` section at
generation time (option b) vs. explicit backfilled field (option a, chosen). Free-prose
extraction is brittle and non-deterministic across the two header dialects; an explicit
field is gate-checkable without heuristics.

**D-infra-d-2 (gate in ci vs. nightly):** digest gate in `just ci` via eval (chosen)
vs. nightly. The script is sub-second; drift caught at PR time is the point.

## Consequences

- New ADRs require all canonical fields; the CI gate will reject missing/unknown values
- The DIGEST becomes the agent entry point: scan ~15 KB instead of ~620 KB raw
- `LEGACY_TOLERANCE` must shrink to empty in the follow-up backfill slice
- The harness design corpus is vendored once and frozen; project CI never reads the
  harness repo; any future harness ADR update requires a manual corpus refresh
- The vocabulary is fixed at 10 subsystems; amendments go through a future ADR
