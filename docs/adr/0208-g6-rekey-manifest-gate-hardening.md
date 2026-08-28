# 0208 — The G6 re-key manifest gate hardening: an explicit policy discriminator, an own-property boundary, and alias resolution in the column walker

**Status:** Accepted
**Date:** 2026-08-28
**Slice:** rb-4 (residual R-m22-s0-X3; also records the rb-2 / rb-3 decisions both sibling ledgers deferred to this ADR)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz, schema-persistence
**Decision:** G6 reads an explicit `policy` field via one parser, asks membership of own-property Maps only, and resolves Rust type aliases (union of every `type`/`use … as` binding in the tree, fail-closed on ambiguity) before matching Identity.

---

## Context and problem statement

ADR-0179 D6 fixed the rule that every `Identity` / `Option<Identity>` column in the module carries an
explicit re-key policy — REKEY (carried from the guest onto the claiming account), BLOCKED (a guard
rejects the claim while such a row exists) or EXEMPT (never a foreign reference) — because an
unclassified column is data a successful guest claim silently orphans under the abandoned guest
identity. M21a shipped no Rust manifest const, so the only mechanical copy of that table is
`REKEY_MANIFEST` in `evals/guest-claim-integrity.eval.mjs`, and the only mechanical enforcement is that
eval's `checkRekeyCompleteness` (clauses `[G6/policy]`, `[G6/parse]`, `[G6/declared]`, `[G6/live]`,
`[G6/anchors]`, `[G6/consumed]`) over the column set produced by `findIdentityColumns`. M22 slice 0
(PR #359) froze both the manifest and the walker as an EXPORTED contract that the deletion cascade
consumes (`evals/rekey-contract-surface.eval.mjs` is the seam-freeze eval), which turned every
weakness of the walker into a weakness of every downstream consumer.

Three residuals were measured against that gate, each of the same shape — a column, or a policy, that
the gate cannot see while every count it prints stays unchanged:

- **R-m22-s0-X1 (rb-2, PR #378).** `checkRekeyCompleteness` inferred REKEY from
  `typeof policy === 'string'`, so ANY object-valued entry was REKEY by definition; rewriting one
  BLOCKED string entry as a record kept the seam eval green and redded this file with
  `[G6/consumed] … as REKEY via undefined`. The only green workaround was to advertise a BLOCKED column
  as re-keyed — a lie in the security manifest.
- **R-m22-s0-X2 (rb-3, PR #379).** `[G6/declared]` was literally `key in manifest`. `Object.freeze`
  does not seal the prototype chain and every eval shares ONE realm under `evals/run.mjs`, so a
  co-resident eval's `Object.prototype['table.col']` classified a genuinely unpoliced column while
  `Object.keys` and the detail-string counts stayed at 24. rb-2's Map had closed it incidentally;
  nothing pinned it, and two `.error !== undefined` chain reads still flipped a GOOD verdict under an
  ambient `Object.prototype.error`.
- **R-m22-s0-X3 (rb-4, this slice).** `findIdentityColumns` matched the literal type TEXT of a column,
  so `pub type OwnerId = Identity;` + `pub delegate: OwnerId,` — and every other alias spelling:
  transitive chains, `Option<Alias>`, an alias of `Option<Identity>`, any visibility, a qualified RHS,
  a `use spacetimedb::Identity as Who;` import rename, `r#`-prefixed and non-ASCII alias names, a
  rustfmt-wrapped declaration — left the column outside the walker's set and therefore outside
  `[G6/declared]`, `[G6/live]` and `[G6/anchors]`, with no D6 policy enforced. Measured on the live
  tree at e112ce6 for every spelling above.

## Considered alternatives

### For the policy discriminator (rb-2)
- **Keep string entries, infer REKEY from needle presence** (`'rekey' in entry`) — rejected: a
  second implicit discriminator, and a BLOCKED entry that borrows another table's needles reads as
  REKEY.
- **Dual form** (strings still legal via their `BLOCKED: ` / `EXEMPT: ` prefix) — rejected: the
  prefix parse remains a second, implicit discriminator, and a one-letter `BLOKED:` slip silently
  un-polices a column.
- **Constructor helpers** (`rekey(...)`, `blocked(...)`) — rejected: `accounts_tests.rs` reads the
  manifest as TEXT (the T9 cross-manifest proof), and a helper hides the policy word from that
  reader while adding a second place to lie.

### For the own-property boundary (rb-3)
- **Null-prototype manifest** — rejected: kills the T9 text anchor and the FG70 co-scan.
- **Map-valued export** — rejected: breaks the frozen T1 contract shape, every spread copy, and T9.
- **`Object.hasOwn` guards at the declared clause** — rejected: a SECOND boundary contradicts
  "the key space is read in one place".

### For alias resolution (rb-4)
- **Gate the alias out at the schema** (ban `type … = …Identity…` and `Identity as` in
  server-module) — rejected: a ban is a second rule about the same column set with its own blind
  spots (a cross-file `use crate::t::Alias`, a rename chain), and the residual's owner asked for
  resolution, not prohibition.
- **A positive allowlist of column types** — the doctrine ADR-0195 D6 chose for reducer
  PARAMETERS (`is_wire_safe_type`, `accounts_tests.rs`), where the domain is the closed set of wire
  scalars and a `type Ident = Identity` parameter is rejected because `Ident` is not on the list.
  Rejected for COLUMNS because the column-type domain is open: `game_core::TradeStatus`,
  `game_core::PvpAction`, `Vec<EncounterEntryRow>`, `ScheduleAt`, every future SpacetimeType. An
  allowlist would be red-on-arrival for every new column type, so the two gates deliberately carry
  opposite doctrines for the same defect class, and this paragraph is the record of why.
- **Per-file alias precedence, then a tree-wide fallback** (the plan's first cut) — rejected after the
  red-team MEASURED a compile-clean, warning-free, rustfmt-clean hide: the collector is
  namespace-blind, so a decoy `impl Tagged for Decoy { type OwnerId = u64; }` or
  `mod scratch { pub type OwnerId = u64; }` in the declaring file overrode the real
  `pub type OwnerId = Identity;` in `ids.rs`, and a column typed `crate::ids::OwnerId` resolved to
  `u64`.
- **An error channel or a throw from the walker** on an ambiguous or unresolvable alias — rejected:
  the seam eval pins `instanceof Map` and the M22 consumer would have to catch a contract exception
  on legal Rust.
- **A `replaceIdent` helper with a bounded fixpoint and a length cap** — rejected by `/simplify`: a
  token-driven expansion needs no identifier-boundary replacement, and termination is structural
  (a name already on the expansion path is terminal), which also makes the idiomatic self-referential
  re-export `pub(crate) type Timestamp = spacetimedb::Timestamp;` resolve to a fixed point instead
  of hitting a bound.

## Decision outcome

### D1 — Every manifest entry carries an explicit `policy` discriminator, read by one parser (rb-2)

`REKEY_MANIFEST` entries are objects `{ policy: 'REKEY', rekey, exists }`,
`{ policy: 'BLOCKED', reason }` or `{ policy: 'EXEMPT', reason }`, objects-only, `reason` verbatim
from ADR-0179 D6 minus the retired prefix. `classifyPolicy` is the ONE reader (exact equality against
a closed shape table, closed field set per kind, non-blank fields, helper-call needle shape, no policy
word inside a reason, never throws) and runs first as `[G6/policy]`, before the manifest is compared
to the tree; `[G6/declared]`, `[G6/anchors]` and `[G6/consumed]` read its parsed Map. The eight D6
REKEY columns are additionally pinned REKEY by value (`G6_REKEY_ANCHORS`). FG70 re-implements the
Rust T9 text scan in-file so a key list the `include_str!` reader would silently truncate (a
biome-emitted `\'` above its ≥20 floor) reds here.

### D2 — Inside `checkRekeyCompleteness` every membership question is asked of an own-property Map (rb-3)

The manifest's key space is read exactly once — `classifyManifest`, over `Object.keys`, into a Map —
and every later clause reads that Map; the column key space is read exactly once too, by
`findIdentityColumns`, into a second Map, and both sides of the completeness JOIN are own-property
membership. Banned, each measured green-and-wrong: the `in` operator or a bare property read as a
membership test, an own-key test widened with a chain fallback, `for…in` over the manifest in ANY
clause, reading the frozen export instead of the injected parameter, preferring an inherited entry
over an own one, and rebuilding either side as a plain object. Classifier RESULT records are read
with `Object.hasOwn`, never `!== undefined`. FG72c performs the eval suite's one real
`Object.prototype` write — pre-existence refusal, assignment inside `try`, `Reflect.deleteProperty` in
`finally`, an in-process leak post-assert — because ambient pollution has no `Object.create`
stand-in; this rebuts the older in-repo rule at `evals/append-only-ids.eval.mjs` ("never assign to
Object.prototype"), which was written for a tooth that HAD an injection alternative.

### D3 — `findIdentityColumns` resolves type aliases before matching `Identity`, fail-closed (rb-4)

1. **Collection.** Over every source in `treeSrcs` (STRIPPED per file, never compacted — compaction
   destroys the `type` keyword boundary — and never over raw text, where a string literal could
   declare a phantom alias), the walker collects every `type NAME … = RHS;` item at any visibility
   (name class `(?:r#)?[\p{XID_Start}_][\p{XID_Continue}]*`, RHS spanning newlines) and every
   `TOKEN as NAME` pair inside each `use … ;` span, into ONE `Map<name, Array<{name, rhs, path}>>` —
   a union, duplicates kept, no per-file precedence. Alias tables are `Map`s because `constructor`
   and `__proto__` are legal Rust identifiers and D2 applies to derived structures.
2. **Resolution.** A column's declared type text is split into identifier tokens; each bound token is
   expanded recursively through EVERY binding of its name, a name already on the current expansion
   path being terminal (structural termination). If any expansion is Identity-bearing the column is
   reported with that expansion as `resolved` — ambiguity fails CLOSED and the failure message names
   every binding and its file, so the over-report is a one-line human fix (rename one).
3. **Record.** The walker returns `{ path, type, resolved, via }`: `type` is the DECLARED text
   (unchanged meaning; provenance), `resolved` the expansion (`=== type` when direct — the M22
   consumer reads `Option<…>`-ness from it, never resolving aliases itself), `via` the ARRAY of
   binding records consulted (`[]` when direct) — structured data for the `[G6/declared]` message,
   never a prose discriminator. The field set is closed and pinned; every read is `Object.hasOwn`.
4. **`[G6/alias]`.** A stripped source that contains both `macro_rules!` and the byte string `type $`
   declares an alias the resolver cannot read; the clause fails loud naming the file (the alias
   analogue of `[G6/parse]`'s table-level non-vacuity).
5. **The seam.** `rekey-contract-surface` T2 gains an alias-declared fixture column; `[T2/type]`
   asserts `resolved` mentions Identity (own property) and `[T2/alias]` pins `resolved === type` for
   every unaliased fixture column — the equality is what proves the move is not a loosening.

### Accepted limits (recorded, routed to the residual backlog, never silent)

- **Product-type columns carrying an Identity** — a named-field SpacetimeType struct, an enum payload,
  a generic wrapper, or a `Vec<T>` of any of these (compile-verified under 2.8.1; the tuple form
  `struct Owner(pub Identity)` does not compile) — are invisible: `parseTableSchemas` deliberately
  reads only table blocks. LIVE-REACHABLE today through `encounter.entries: Vec<EncounterEntryRow>`.
  rb-4 ledger X10 → backlog.
- **Field-level parse non-vacuity** — `owner_backup: Identity,` without `pub` compiles (the 2.8.1
  macro maps `Visibility::Inherited` to `pub(super)`), two fields on one line, and a
  `#[rustfmt::skip]`-wrapped type are all invisible; `[G6/parse]` counts tables, not fields.
  rb-4 ledger X11 → backlog.
- **Aliases declared outside the scanned input set** — `game-core` carries an optional `spacetimedb`
  dependency, so `pub type Owner = spacetimedb::Identity;` there + `use game_core::Owner;` is
  invisible; the INPUT-SET RULE is `server-module/src/**/*.rs` and S0 forbids widening it inside the
  frozen seam. rb-4 ledger X12 → backlog.
- **Proc-macro-generated aliases** from an external crate leave no `type` text at all; only the
  `macro_rules!` form is detected.
- A `__proto__`-named FIELD vanishes from `parseTableSchemas`' plain-object column map with no
  fail-close (rb-3 ledger X10 → backlog, `evals/battle-schema-snapshot.eval.mjs`).

### Consequences

- Positive: one gate, three hardening passes, each pinned by a proof-of-teeth family that is RED on the
  fork and by a per-mutant tooth-pinned mutation probe in the slice ledger; the walker's contract is
  now TRUE for aliased columns, and the M22 cascade consumes `resolved` rather than re-walking.
- Negative: fail-closed over-report on an ambiguous alias name (or on an associated type sharing a
  bare name with a column's type) is a false RED that a human resolves by renaming — accepted, because
  under-report IS the residual. The walker performs a second pass over `treeSrcs` (alias collection
  before table parsing); measured cost is negligible against the eval's existing per-file stripping.
- Follow-ups: the three backlog residuals above; promoting the resolver to `evals/rust-scan.mjs` if a
  second eval ever needs alias resolution.

## References

ADR-0179 D6 (the manifest) · ADR-0195 D6 (the parameter allowlist doctrine this ADR contrasts) ·
M22 slice 0 PR #359 (the seam freeze) · rb-2 PR #378 · rb-3 PR #379 · residual backlog
`specs/monster-realm-v2/M-residual-backlog.spec.md` (rb-2, rb-3, rb-4) · ledgers
`memory/projects/gates/rb-2.gates.md`, `rb-3.gates.md`, `rb-4.gates.md`.
