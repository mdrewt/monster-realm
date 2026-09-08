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

## Amendment (rb-43, 2026-09-04)

Self-amendment; no new ADR number was minted and no `Amends:` / `Amended-by:`
header field was added on either side (a reciprocity obligation the generator
validates, and this record amends itself).

**What changed.** `scripts/adr-digest.mjs` now DERIVES the next free project ADR
number — `max(collected id) + 1`, zero-padded to four digits, `0001` on an empty
corpus — and renders it into the generated `DIGEST.md` as the first line after
the `Generated from N project ADRs …` line. Because it is part of the payload
`--check` byte-compares, it is drift-gated by the same `just ci` →
`evals/adr-digest.eval.mjs` leg as the rest of the digest. `docs/adr/README.md`
no longer hand-maintains the number at all: its next-free paragraph now points
at `DIGEST.md` and states where the value comes from. A new ordinary test,
`scripts/adr-digest.test.mjs`, gates the derivation, the exact rendered line and
position, payload membership, the band guard, and README's freedom from a
hand-maintained digit; it is wired into `just test` behind its own fail-closed
summary-parsing block (ADR-0224 forbids a new eval or a new clause in an
existing one, so an ordinary test is the sanctioned proof).

**Why.** The hand-maintained `Next free number` in README had drifted 51 numbers
behind the top of the corpus (it read `0184` while the directory ran to `0235`;
as a *next-free* value it was 52 off) and nothing gated it. The
README's own ⚠ blockquote had already named the fix — "deriving it in the digest
generator is a known follow-up" — and that blockquote is now deleted, since the
defect it described no longer exists.

**Disclosed limits.**

- It is a MEASUREMENT of the files on disk, not a RESERVATION. Two slices
  reading the same rendered number will pick the same id.
- It is NON-MONOTONE. Reverting a merge, renaming the top ADR, or deleting it
  moves the rendered number BACKWARDS onto an id that has already been used and
  retired, with CI fully green — the digest is consistent with the corpus, and
  the corpus is what shrank. Nothing in this repo remembers spent numbers.
- The supervisor ledger (`mr-state.json`, key `.adr_next_free`) remains
  authoritative whenever a number has been reserved for an in-flight slice; it
  is ahead of the rendered line by construction.
- A band guard narrows, but does not close, the filename namespace.
  `collectAdrIds` deliberately keeps a loose four-digit-prefix filter, so a
  date-named retro (`2026-…`) or a five-digit note (`10000-…`) IS collected; the
  guard rejects every collected id outside the band — not just the maximum — in
  generate AND in `--check` mode, before any file is opened and before any write.
  What it does NOT catch, measured: a prefix that truncates back INTO the band
  (`02361-…` collects as `0236`), a duplicate id (two files may both claim
  `0236` and the digest renders both rows without complaint), a filename prefix
  that disagrees with the file's own `# ADR-NNNN` heading, and a real ADR the
  filter silently MISSES (`.MD` casing, or a nested subdirectory — `readdir` is
  not recursive), which under-reports the maximum. Each of those still yields a
  wrong number with green CI. They are pre-existing properties of the collector
  that this amendment makes load-bearing rather than cosmetic, and they are
  filed as residuals rather than fixed here.
- The band is not exhaustion-aware. At a corpus maximum of `0999` the rendered
  value would be `1000`, which the guard itself then refuses to admit — the
  digest would name a number that cannot be minted. That is ~760 ADRs away and
  is deliberately left unhandled rather than speculatively coded.
- The `just test` block that runs the new suite has no tooth on its OWN wiring:
  deleting that block is CI-clean, and the suite would then gate nothing. The
  obvious remedy — a check whose only purpose is proving another check has not
  decayed — is the pattern ADR-0224 retires by name, so it is disclosed here
  instead of built.

**Residuals closed.** This closes `R-rb-26-X11-adr-readme-next-free`. Three
escalation records that recorded the defect as OPEN are hereby discharged:
`docs/adr/0202-obsolete-residual-prose-corrected.md:314`,
`docs/adr/0223-g6-policy-decisions-recorded-once-in-0208.md:169`, and
`docs/adr/0166-pvp-server-guard-parity.md:234` (R8, which named the same stale
line and noted it was "gated by nothing"; its `README.md:16` citation now
resolves to the resolution rule, the next-free clause having moved). Those files are
append-only record and were deliberately NOT edited; this section is the
forward-dated correction.

**Follow-up left undone (out of repo).** The harness's `/adr` command and its
doc-keeper guidance still instruct an agent to read and update README's "Next
free number" heading. That value no longer exists in README; the instruction now
points at nothing and should be repointed at `docs/adr/DIGEST.md`. That edit is
outside this repository and outside this slice's declared `touches:` set.

## Amendment (rb-70, 2026-09-08)

Self-amendment, following the rb-43 precedent above: no new ADR number was
minted and no `Amends:` / `Amended-by:` header field was added on either side.

**What changed.** `**Extends:**` and `**Extended-by:**` become first-class,
modelled header fields. D1's "Conditional fields" block above lists only
`**Superseded-by:**` and `**Amended-by:**`; the corpus has been writing
`**Extends:**` since ADR-0208 without the generator knowing about it. Read that
block as also admitting:

```
**Extends:** ADR-NNNN        (this decision builds on ADR-NNNN)
**Extended-by:** ADR-MMMM    (when a later ADR extends this one)
```

Both are **conditional** — their absence is never an error. 190 of the 210
project ADRs declare neither.

`scripts/adr-digest.mjs` now enforces exactly two things about them:

1. **Dangling references.** A `**Extends:**` / `**Extended-by:**` naming an id
   that resolves nowhere is an error, on the same footing as a dangling
   `**Supersedes:**`. Before rb-70 a `**Extends:** ADR-9999` passed
   `just adr-digest-check` green (measured, rb-42).
2. **Reverse reciprocity only.** `**Extended-by:** ADR-X` in ADR-Y obliges ADR-X
   to declare `**Extends:** ADR-Y`. Corpus-wide: no era window, no tolerance
   set, no ratchet. The corpus is already clean in this direction, so the rule
   costs nothing and was adopted at full strength.

**Why the asymmetry — FORWARD reciprocity is deliberately NOT enforced.**
`**Extends:** ADR-Y` does **not** oblige ADR-Y to carry `**Extended-by:**`.
Counted 2026-09-07: 49 raw ADR references appear in `**Extends:**` values, 47 of
which resolve to a project ADR file; exactly 6 are reciprocated, so 41 are
one-directional. 17 ADRs declare `**Extends:**` and only 4 declare
`**Extended-by:**` — ADR-0224 alone is extended by eight ADRs and lists none.

`**Extends:**` is used in this corpus as a many-to-one **citation** ("this
decision builds on ADR-NNNN"), not as a symmetric relation, and it was adopted
*precisely because it forces no reciprocal edit* — `**Amends:**` does, and under
the supervised build loop that reciprocal edit is a hidden-dependency STOP when
the target ADR is outside the slice's `touches:` set. Enforcing forward
reciprocity would re-create that STOP for every future `**Extends:**` line and
would demand 41 back-link edits that are each a semantic claim about two
documents, not a formatting fix. rb-70 dispositions it `wontfix` under this
ADR's own successor policy (ADR-0224: genuine uncertainty about whether a check
is worth adding resolves toward not adding one).

`**Extended-by:**` is the opposite kind of statement: it is an assertion *about
another file*, so that file must corroborate it or the assertion is simply
false. That is what the reverse rule checks.

**Known limits, recorded rather than fixed.** Field matching is case-exact and
column-0, so `**extends:**` or an indented marker declares nothing — the
pre-existing behaviour for `**Amends:**`, deliberately not widened (widening a
gate matcher loosens it). `extractBoldField` stops at end-of-line while
`extractBacklinkField` absorbs indented continuations, so an id wrapped onto a
continuation line is dangling-checked by neither. Two `NNNN-*.md` files sharing
a four-digit prefix shadow each other in `collectAdrIds`; that predates rb-70
and affects the `Amends` leg identically.

**Confirmation.** `just adr-digest-check` (`node scripts/adr-digest.mjs --check`)
fails on a dangling relation or a reverse-reciprocity gap. The proof-of-teeth is
`scripts/adr-digest.test.mjs` — X7 (synthetic corpora: dangling, reverse gap,
membership-not-emptiness, view scoping on both legs, multiplicity, mode and
scale independence), X8 (the six committed edges frozen by roster, both legs),
and X9 (the rule running against the real corpus with no flags at all, which is
the only clause that can distinguish a live rule from one gated on test-shaped
input). `justfile` pins that suite at exactly nine passing tests.
