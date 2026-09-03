# ADR-0234 — Module-write attribution: a rooted receiver chain, or a loud refusal

**Status:** Accepted
**Date:** 2026-09-03
**Slice:** rb-39 (residual R-rb-22-EO-11, `M-residual-backlog.spec.md#rb-39`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0179 (G5 module-write isolation), ADR-0195 (Rust test-mirror parity), ADR-0224 (proof-of-teeth as ordinary tests)
**Subsystems:** ci-gates, security-authz
**Decision:** G5 write attribution walks back from each write verb over its receiver chain and requires the head to be `ctx.db.<accessor>(`; anything else (aliased handle, bare local, UFCS spelling) is Unattributable and fails G5 loud.

## Context and problem statement

`write_target_accessors` in `server-module/src/accounts_tests.rs` is the Rust twin of the
guest-claim-integrity eval's `[W/write-target]` scan and the helper behind G5 (ADR-0179 D0:
`accounts.rs` may write only the tables it owns; every other write is delegated to the owning
module). Until rb-39 it attributed each `.insert(`/`.update(`/`.delete(` verb to the **nearest
earlier** `ctx.db.` in the whole file, with no same-statement check and no else-branch.

rb-22's red-team measured the two consequences (ledger EO-11, `ADR-0220` §3): a foreign write
reached through an aliased handle — `let db = &ctx.db; db.account().identity().delete(owner);`
after an `export_bundle` read — is credited to the previous statement's accessor and passes G5
green, clippy-clean; and a write with no `ctx.db.` before it at all is silently dropped from the
census. Module-write isolation exists because a foreign-table write from the accounts module is
the account-takeover shape the codebase already fixed once (ADR-0179 E1/E2), so a gate that is
green on exactly that shape is decorative. rb-22 closed the class for `privacy.rs` locally
(hardened port + alias bans + exact-body pin in `privacy_tests.rs`) and deferred the shared
helper, because tightening it re-baselines `accounts.rs`'s existing write census.

Measured before any edit (probe of the pre-rb-39 helper, recorded in the harness ledger
`memory/projects/gates/rb-39.red-before.md`): the alias, cross-statement-handle and
same-statement-foreign shapes all return `["account"]`; the anchorless `Vec::insert` and the UFCS
`UniqueColumn::delete(&ctx.db.monster()…, k)` return `[]`; the real `accounts.rs` census is 13
inline `ctx.db.<accessor>()…` writes.

## Considered alternatives

- **(i) rb22p shape — nearest-earlier `rfind` plus a `;`-boundary poison marker** (the
  `privacy_tests.rs` prior art). Closes the measured alias shape but is still GREEN (misattributed)
  on `if ctx.db.account().identity().find(x).is_some() { db.monster().monster_id().delete(y); }`
  (no `;` between anchor and verb), on `foo(ctx.db.a().identity().find(x), t.identity().delete(y))`,
  and on a write inside a closure passed to an owned chain. Its verdict depends on what happens to
  precede the verb in the file, so the contract cannot be stated in one sentence.
- **(ii) Backward receiver-chain walk (chosen).** From the verb, walk back over
  `.segment(balanced-args)` hops; the chain head must be exactly `ctx.db.<accessor>(` (with the
  byte before `ctx` not a word byte). Any other head — an aliased `db`, a bound column handle, a
  bare local container, a parenthesised receiver — is `Unattributable`. UFCS spellings
  (`::insert(`/`::update(`/`::delete(`) are always `Unattributable`. The verdict depends only on
  the verb's own receiver, which is what makes the rule statable, order-independent, and
  reproducible on the census.
- **String poison markers vs a typed fault.** rb22p returns `Vec<String>` with `<<marker>>`
  strings. Chosen instead: `Vec<Result<String, WriteAttrFault>>` with
  `enum WriteAttrFault { UnrootedChain, EmptyAccessor, UfcsSpelling }` — an unattributable write
  is a distinct state the type carries (illegal states unrepresentable, exhaustive `match` at
  every consumer), fixtures assert with `assert_eq!` rather than `starts_with("<<")`, and rb22p's
  marker vocabulary (`no-anchor`, `statement-boundary`) would be a lie under a rule that has
  neither anchors nor statement boundaries. A dedicated `WriteTarget` wrapper enum was considered
  and cut at plan review as isomorphic to `Result`.
- **A frozen census count / accessor multiset pin.** Rejected: a bare numeric floor whose only
  job is proving other tests have not decayed is the ratchet pattern ADR-0224's amendment retires,
  and it taxes every legitimate future write. The before/after multiset is recorded as a
  measurement in the ledger evidence, not asserted as a gate.
- **Also banning `__TableHandle`/`__ViewHandle` type names (the eval's `[W/handle-type]`).**
  Rejected: under (ii) a write reached through such a handle inside `accounts.rs` is already
  `Unattributable`, and a handle crossing into another file takes the write out of any per-file
  scan with or without the clause — zero marginal coverage.
- **Sharing the hardened helper with `privacy_tests.rs`.** Rejected: the two `_tests.rs` files
  are `#[path]`-declared private `#![cfg(test)]` modules of different parents, so sharing means
  `pub(crate)` module wiring in two production files for a 30-line helper, against the per-module
  local-copy convention stated in each file's header. `privacy.rs` cannot exhibit the shapes the
  weaker rb22p rule misses because `rb22p_purge_body_exact` forbids any statement in the helper
  beyond the two sanctioned ones; the divergence is bounded and documented, not a debt.

## Decision outcome

- `write_target_accessors(squashed) -> Vec<Result<String, WriteAttrFault>>` implements (ii),
  source-ordered; the walk is bounds-guarded (a chain that runs into the start of the source is
  `UnrootedChain`, never an index panic).
- `g5_write_isolation_violation(squashed) -> Result<(), String>` carries the three G5 clauses
  (at least one attributed write — non-vacuity; any unattributable write is an `Err` naming the
  fault and the measured alias shape; every attributed accessor is in `allowed_write_tables()`), so
  the fail-loud arm is testable on fixtures without mutating `accounts.rs`. The shipped
  `g5_writes_only_owned_tables` unwraps it over the real file.
- `g5_alias_violation(squashed) -> Result<(), String>` is the Rust-side port of the eval's
  `[W/db-binding]` (every `ctx.db` not preceded by a word byte must be immediately followed by
  `.`) and `[W/ctx-binding]` (every `:&ReducerContext` parameter is named exactly `ctx`; the
  alias forms `=ctx;` `=ctx,` `=&ctx;` `=&ctx,` `=ctx.clone()` are banned; at least one
  `:&ReducerContext` must exist). It is applied to `accounts.rs` by its own test and is
  deliberately not folded into the write predicate, so neither tooth can shadow the other. The
  JS twin also accepts `_ctx`; the Rust side is deliberately stricter (`ctx` only, matching
  `privacy_tests.rs`) because the walk's anchor is the literal `ctx.db.` — accepting `_ctx` in the
  ban while the walk refuses `_ctx.db.` would be a latent false-RED (plan red-team finding).
- Implementation review added two shapes to the walk before merge, each with its own tooth:
  `try_insert` joined the verb vocabulary (the reducer-security-auditor measured a foreign
  `ctx.db.monster().try_insert(row)` producing no census entry at all), and every receiver
  segment before the verb must be a zero-argument call (a combinator segment was measured to
  launder a foreign handle into an owned attribution).
- Proof-of-teeth assertions pin fault variants with `matches!`, never `assert_eq!`: the plan
  red-team measured that a hand-written always-true `impl PartialEq` is clippy-clean and would
  make every equality tooth — and the mutation bite-proof itself — vacuous. The ledger CHECKs
  run nextest with `--run-ignored all` because an `#[ignore]`d test otherwise hides inside the
  filtered-out `skipped` count.
- Language-level backstop (plan red-team, compiled PoC): `ctx.db.<accessor>()` is a trait method
  the table macro wires onto `Local`, and a function-local `trait account` that returns a foreign
  handle does not compile (`E0034: multiple applicable items in scope`) — so an owned NAME cannot
  be made to reach a foreign TABLE at one call site under the scanner's nose.
- The eval's `[W/write-target]` / `[W/db-binding]` / `[W/ctx-binding]` clauses over `accounts.rs`
  stay live and un-narrowed: `evals/` is outside this slice's `touches:`, and under ADR-0224's
  opportunistic model the Rust side now being strictly more precise is not a residual — the
  eval's portion is deleted whenever a slice next legitimately touches that file.
- Proof-of-teeth per ADR-0224, applied once: the `rb39_*` gating tests were authored before the
  fix, the RED was measured on the pre-fix helper (five defect fixtures misattributed or
  dropped), and a single post-green mutation bite-proof (pre-fix body restored) confirms they
  bite. No follow-up audit of the walk for further theoretical blind spots is scheduled.
- ADR-0224's delete-on-touch clause does not apply: nothing is migrated from an eval here — the
  Rust twin predates this slice.

### Honest limits (the terminal statement, not a backlog)

Measured at implementation review (artifact red-team + reducer-security-auditor), stated once:

- A turbofish or any non-identifier byte before a segment's `(` reports `EmptyAccessor`; a
  parenthesised receiver `(ctx.db.account()).identity().delete(x)` does too — loud, not silent.
- A `Vec`/`HashMap` `.insert(` anywhere in `accounts.rs` is a loud false-RED whose sanctioned fix
  is `.push(`.
- Every receiver segment between the root and the verb must be a zero-argument call (a table
  handle or a column/index handle — all 13 shipped writes are `accessor().column().verb(`), so a
  combinator segment (`.find(x).map(|_| ctx.db.monster()).unwrap().delete(row)`) is refused
  rather than credited to the first rooted segment; a same-file helper returning a foreign handle
  is likewise refused (an ergonomics cost on a hypothetical refactor, in the loud direction).
- The verb vocabulary is `insert`, `try_insert`, `update`, `delete` in both the dotted and the UFCS
  spelling. The `insert_or_update`/`try_insert_or_update` upserts exist only behind the crate's
  `unstable` feature, which this workspace does not enable. Renaming a trait method at import
  (`use Table::delete as remove`) does not compile on the pinned stable 1.96 toolchain (unstable
  `use` of associated items), and the keyed `.delete(key)`/`.update(row)` column methods are
  inherent, not trait methods, so no import can rename them.
- A `macro_rules!` DEFINED in `accounts.rs` is scanned like any other text and its write is
  attributed; only a macro defined in a sibling file and merely invoked here carries no verb text.
- A per-table handle passed by value to a function in ANOTHER file
  (`crate::shared::write_row(ctx.db.monster(), row)`) carries no verb text at its call site: both
  Rust predicates are green on it. `g5_alias_violation` bans only the raw `ctx.db` handle escaping,
  not a derived per-table handle. This shape IS caught in CI today by the JS twin's
  `[W/split-binding]` clause (a foreign accessor whose own chain reaches no read terminal), which
  stays live because `evals/` is outside this slice; review (reducer-security-auditor) covers the
  rest of what a per-file scan cannot.
- `privacy_tests.rs`'s local copy keeps the weaker rb22p `;`-boundary rule and is therefore green
  on a same-statement foreign write inside a NEW `privacy.rs` fn (the hardened walk was measured
  to produce no false-RED there: two `Ok(export_bundle)`); porting it is recorded as a residual,
  not widened into this slice.

### Consequences

- Positive: the measured account-takeover-shaped bypass now fails G5 with a message naming the
  fault; the contract is one sentence; the `accounts.rs` census is unchanged (13 writes, zero
  `Unattributable`), so no production edit was needed.
- Negative / accepted: future `accounts.rs` code must spell every table write as an inline
  `ctx.db.<table>()…` chain and use `.push(` for non-table containers — a one-line constraint the
  failure message states.
