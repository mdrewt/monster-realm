# 0193 — Append-at-end schema-gate generalization: order-aware, re-baseline-proof additive-schema enforcement

**Status:** Accepted
**Date:** 2026-08-15
**Slice:** 13r-d (M-postgate thirteenth-review residuals §13r-d)
**Supersedes:** —
**Amends:** —
**Subsystems:** evals, schema
**Decision:** `battle-schema-snapshot` gains column-ORDER awareness — the baseline records each table's column order, five in-tree rules police source-vs-baseline order and the `#[default(...)]` shape, and a sixth rule compares the working-tree baseline against the **previously committed** baseline resolved via git (ADR-0116 D3 precedent), so a mid-struct insert stays RED even after a full, sanctioned re-baseline.

## Context

Live spacetime 2.6.0 accepts an automatic migration ONLY as **tail-appended columns each
carrying an explicit `#[default(...)]`** (measured, ADR-0173 D5; restated at
`server-module/src/schema.rs:251-254`). A mid-struct insert is rejected twice over — as a
reordering and for want of a default — and a column or table removal is never accepted by
automigration at all (ADR-0177 runbook).

The gate that is supposed to protect that invariant, `evals/battle-schema-snapshot.eval.mjs`,
compared columns as an **unordered name→type map** (`checkSchemaDrift`). It could see an
added, removed, retyped column and a changed PK — but never a column's *position*.
Order-aware checking existed only as three hardcoded EG1 anchors in
`bsatn-compat-smoke.eval.mjs` (fixed column lists for one specific migration).

The thirteenth review reproduced the hole empirically: a mid-struct insert **plus the
sanctioned re-baseline workflow** passes the gate green, deferring the failure to
`spacetime publish` against the live self-hosted DB.

Two review lenses (a plan reviewer and a red-team prototype run against the real 38-table
corpus) then killed the obvious fix. Any rule keyed on "a column present in source but absent
from the **working-tree** baseline" is **empty by construction** after a re-baseline: the
regeneration step writes the new column into the baseline before the eval ever reads it.
Measured on the prototype: a tail append with **no** `#[default(...)]` — a change live
spacetime rejects — was GREEN on 33 of 38 tables. An "append-only ledger" maintained by
discipline is a comment, not a gate; nothing in-tree can police an in-tree rewrite.

## Decision

**D1 — Parse once, project twice.** A file-local `parseTableFields()` owns the single table
regex and field-line regex and returns ordered fields with a per-field `hasDefault`.
`parseTableSchemas()` becomes a thin projection over it. Its **return shape and its `columns`
key insertion order are unchanged** — `scripts/okf-export.mjs` renders `docs/knowledge/**`
from that insertion order, and `evals/gate-teeth.eval.mjs` / `evals/guest-claim-integrity.eval.mjs`
import it. `hasDefault` is derived from the field's own preceding attribute lines, never from
a file-level search (`content_tests.rs` and `marshal_tests.rs` carry `#[default(` inside Rust
string literals, and this eval concatenates every `.rs` under `server-module/src`).

**D2 — The baseline records column order.** Each table entry gains a nested
`"order": ["col", ...]`, written after `columns`. `JSON.stringify(x, null, 2) + "\n"`
round-trips the existing file byte-identically, and JSON is excluded from the formatter, so
the diff is purely additive.

**D3 — Six always-on, individually tagged rules**, each a pure function that never throws:

| tag | rule |
|---|---|
| `[parse-shape]` | every non-blank line in a table body is an attribute or a parsable field (kills one-line attr+field, two fields per line, raw identifiers, multi-line attributes/types) |
| `[table-count]` | `#[spacetimedb::table(name` occurrences in string-and-comment-stripped source == parsed table count (kills a table hidden behind `columns = [...]` in the table attribute, a two-table struct, and a stray `/*` swallowing a struct) |
| `[order-shape]` | `order` exists and is a duplicate-free permutation of `Object.keys(columns)` |
| `[order-mismatch]` | source column order equals the recorded order |
| `[order-append]` | a source column absent from the recorded order sits after every recorded column and carries `#[default(` |
| `[defaults-not-suffix]` | within baseline-known tables, no non-defaulted column follows a defaulted one |

**D4 — The re-baseline-proof rule.** `checkBaselineAppendOnly(prev, next, parsedFields)`
requires each table's previously committed `order` to be a positional **prefix** of the new
one, with every column beyond that prefix carrying `#[default(` in source; a table present in
`prev` and missing from `next` is flagged. The previous baseline is resolved from git —
`merge-base HEAD origin/master` → `origin/master` → give up — via
`execFileSync('git', [constant args])`, never a shell string. This is the same shape, in the
same directory, as `evals/spacetime-type-snapshot.eval.mjs`'s `checkAppendOnly` /
`readPrevBaseline` (ADR-0116 D2/D3). Resolution failure is **fail-open-LOUD**: the eval states
in `detail` that the append-only layer did not run and why; the five in-tree rules still bite,
so a worktree or offline run is never silently unprotected.

**D5 — No exemption mechanism for `[defaults-not-suffix]`.** The rule is scoped to
baseline-known tables (a brand-new table cannot break a migration — it has no live rows), and
its message names the two sanctioned escapes: move the column to the tail / give it a default,
or perform a delete-data migration per the ADR-0177 runbook and drop the stale defaults in the
same change. An allowlist parameter would be an unclosable blacklist.

**D6 — Regeneration stays "re-derive from source".** No merge helper, no append-only-by-
discipline instruction — D4 polices the *result*, so the workflow needs no new rule its author
can forget.

## Considered alternatives

- **Implicit ordering via `columns` key order** (JSON preserves insertion order, so the
  baseline arguably already records it). Rejected: the ordering would be invisible in review,
  silently destroyed by any re-serializer (`jq -S`), and "this table has no recorded order"
  becomes unrepresentable, so the fail-loud state of `[order-shape]` could not exist. The spec
  also mandates recording order explicitly.
- **A separate `evals/baselines/table-column-order.json`.** Rejected: outside the slice's
  declared file set, and it splits one table's truth across two files.
- **An append-only ledger maintained by a `mergeColumnOrder()` helper, with no git layer.**
  Rejected — measured dead (see Context).
- **Tombstones (`retired: [...]`) to make removals visible.** Rejected as redundant: D4's
  prefix rule already flags a removal.
- **`[defaults-not-suffix]` alone (no baseline change).** Rejected: vacuous on the 33 tables
  that carry no defaulted column, and blind to a non-defaulted mid-struct insert.

## Consequences

- A mid-struct insert, a reorder, a removal, a rename and a no-default tail append are all RED
  after a full re-baseline, in the eval, before `spacetime publish` is ever reached.
- The gate now has a false-RED surface it did not have: `#[default (0)]` (with a space) and
  `cfg_attr`-wrapped defaults are not recognised as defaults. All 32 default sites in the tree
  use the plain `#[default(` form; the failure message states the expected form.
- `[parse-shape]` and `[table-count]` make previously-silent parser blindness loud. Both are
  green on the current corpus (0 unparsable body lines; 38 attributes == 38 parsed tables).
- **Residual, out of scope:** adding `order` to the same JSON object means a bare column-name
  needle can now be satisfied by the order array in
  `server-module/src/content_tests.rs:2500` and `server-module/src/m14_5d_1a_tests.rs:264`.
  Both tests retain a typed assertion that still bites; tightening the name-only needles is a
  follow-up outside this slice's file set.
- `bsatn-compat-smoke.eval.mjs` keeps its struct-keyed `parseStructFieldOrder` /
  `checkAppendedColumns` and the three EG1 anchors: they pin one specific migration's exact
  column list and order, which the generalized shape rule cannot express. Cross-reference
  comments were added in both directions.
