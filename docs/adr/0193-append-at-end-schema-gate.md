# 0193 — Append-at-end schema-gate generalization: order-aware, re-baseline-proof additive-schema enforcement

**Status:** Accepted
**Date:** 2026-08-15
**Slice:** 13r-d (M-postgate thirteenth-review residuals §13r-d)
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0199
**Subsystems:** ci-gates, schema-persistence
**Decision:** The schema-snapshot gate becomes column-ORDER aware: the baseline records each table column order, and a git-resolved comparison against the prior committed baseline keeps a mid-struct insert RED even after a full re-baseline.

## Context

As a change to an **existing table's columns**, live spacetime 2.6.0 accepts an automatic
migration ONLY as **tail-appended columns each carrying an explicit `#[default(...)]`**
(measured, ADR-0173 D5; restated at
`server-module/src/schema.rs:251-254`). A mid-struct insert is rejected twice over — as a
reordering and for want of a default — and a column or table removal is never accepted by
automigration at all (ADR-0177 runbook). Adding a whole new table, adding or removing an
index, and `#[auto_inc]` changes are separately safe and are deliberately not gated here.

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
| `[parse-shape]` | every non-blank line in a table body is an attribute or a parsable field (kills attr+field on one line **including the no-whitespace spelling `#[attr]pub x: T,`**, two fields per line, raw identifiers, multi-line attributes/types) |
| `[table-count]` | `#[spacetimedb::table(` occurrences in whitespace-compacted, string-and-comment-stripped source == parsed table count. Whitespace-insensitive on purpose: the parser needs the attribute on one line with `name` first, so a rustfmt-wrapped or argument-reordered attribute would otherwise vanish from *both* sides at once and the counts would agree vacuously (kills a table hidden behind `columns = [...]`, a wrapped attribute, a reordered attribute, a two-table struct) |
| `[order-shape]` | `order` exists and is a duplicate-free permutation of `Object.keys(columns)` |
| `[order-mismatch]` | source column order equals the recorded order |
| `[order-append]` | a source column absent from the recorded order sits after every recorded column and carries `#[default(` |
| `[defaults-not-suffix]` | within baseline-known tables, no non-defaulted column follows a defaulted one |

**D4 — The re-baseline-proof rule.** `checkBaselineAppendOnly(prev, next, parsedFields)`
requires each table's previously committed `order` to be a positional **prefix** of the new
one, with every column beyond that prefix carrying `#[default(` in source. It also compares
what the position rule alone would miss and `checkSchemaDrift` can no longer see once the
baseline is regenerated: a **persisted column's declared type** and the table's **primary
key** (both are live-DB rejections, ADR-0177 runbook). A table present in `prev` and missing
from `next` is flagged.

The previous baseline is resolved from git — `merge-base HEAD origin/master` → `origin/master`
→ give up — via `execFileSync('git', [constant args])`, never a shell string, mirroring
`evals/spacetime-type-snapshot.eval.mjs`'s `checkAppendOnly` / `readPrevBaseline`
(ADR-0116 D2/D3). Two things that pattern gets right and a naive port would miss:

- **The self-compare branch (D3's third element).** On a master-**push** run the merge-base
  IS `HEAD`, so the resolved baseline deep-equals the working one and the comparison is
  vacuous while still reporting "the layer ran". When the resolved prev is byte-identical to
  the working baseline, validate the last **transition** (`HEAD~1` vs `HEAD`) instead.
- **Fail-CLOSED inside a git work tree.** ADR-0116 D2's fail-open is right when there is no
  repo at all. It is wrong when there *is* one and the prior baseline still cannot be
  resolved (shallow clone, renamed default branch, pruned remote ref): for the 33 of 38 tables
  that carry no defaulted column, this layer is the ONLY rule that survives a full
  re-baseline, so a quiet skip disarms the gate while it reports green. In a repo, an
  unresolvable prev is a `[append-only]` violation naming the fix (`git fetch origin master`);
  outside a repo the run passes with a loud `detail` warning.

The eval duplicates ~35 lines of git-resolution policy with `spacetime-type-snapshot.eval.mjs`
rather than sharing them: extracting a module is a cross-file change outside this slice's
declared file set. Recorded here so the duplication is a decision, not an accident — the two
copies now differ (self-compare handling, fail-closed), so a future consolidation must
reconcile them deliberately.

**D5 — No allowlist for `[defaults-not-suffix]`; the scope comes from the PREVIOUS baseline.**
The rule applies only to tables that already exist in the published schema — a brand-new table
cannot break a migration, it has no live rows. The *working-tree* baseline cannot express that
(the mandatory regeneration writes a new table into it before the eval reads it), so the scope
is taken from the git-resolved previous baseline whenever it is available. The message names
the two sanctioned escapes: move the column to the tail / give it a default, or perform a
delete-data migration per the ADR-0177 runbook and drop the stale defaults in the same change.
An allowlist parameter would be an unclosable blacklist.

**D6 — Regeneration stays "re-derive from source".** No merge helper, no append-only-by-
discipline instruction — D4 polices the *result*, so the workflow needs no new rule its author
can forget.

**D7 — One escape, and it expires by itself.** A removal, a retype or a PK move is legal
exactly once: through the ADR-0177 delete-data runbook. Recording that on the table —
`"manual_migration": "ADR-0177 …"` in its baseline entry — suppresses **that table's**
`[append-only]` findings for the single commit that lands the migration. Once merged, `prev`
equals `next`, there is nothing left to suppress, and a marker with nothing to suppress is
itself a `[append-only]` violation. So the escape is per-table, visible in the reviewed diff,
justified in prose, and cannot be left behind to silently disarm the rule. Without it the gate
would deadlock the very runbook it points authors at: `prev` keeps the removed column forever,
so the removal commit could never reach master.


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
- **Tombstones (`retired: [...]`) listing every removed column forever.** Rejected in favour of
  D7's self-expiring `manual_migration` marker: a permanent tombstone list grows without bound
  and, unlike the marker, is never required to be cleaned up, so it cannot be distinguished
  from an escape someone left behind.
- **`[defaults-not-suffix]` alone (no baseline change).** Rejected: vacuous on the 33 tables
  that carry no defaulted column, and blind to a non-defaulted mid-struct insert.
- **Pure fail-open when git cannot resolve the prior baseline** (a literal port of ADR-0116
  D2). Rejected inside a git work tree — see D4; it is the mode in which the gate reports green
  while its only re-baseline-proof rule is switched off.

## Consequences

- A mid-struct insert, a reorder, a removal, a rename, a retype at a persisted position, a PK
  move and a no-default tail append are all RED after a full re-baseline, in the eval, before
  `spacetime publish` is ever reached.
- **What the gate still does not see:** adding a `#[unique]` or a `scheduled(...)` change to an
  existing table (both engine-forbidden) are outside the baseline's vocabulary — it records
  `pk`, `columns` and `order` only. Index add/remove and `#[auto_inc]` changes are deliberately
  untracked because the engine accepts them. Read this gate as *column* additive-safety, not
  as complete migration coverage.
- `[order-append]` is the one rule with no reachable production path: `checkSchemaDrift`
  returns first on any source column absent from the working baseline, which is exactly its
  precondition. It is retained as the pure-function rule for sub-baseline callers and is
  covered by teeth; in the wired gate `checkBaselineAppendOnly` owns "a new column must be a
  tail append carrying a default".
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
