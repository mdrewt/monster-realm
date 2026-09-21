# ADR-0266 — The M22 module census exempts a `mod` by its own `#[cfg(test)]` attribute, never by a name suffix (rb-108)

**Status:** Accepted
**Date:** 2026-09-21
**Slice:** rb-108 (residual R-rb-85-MODCENSUS, promoted from source slice rb-85; M-residual-backlog.spec.md#rb-108)
**Supersedes:** —
**Amends:** —
**Extends:** 0224, 0229
**Subsystems:** ci-gates, schema-persistence
**Decision:** `m22_declared_mod_names` drops a `mod x;` from the deletion-policy totality census only when the declaration's own contiguous attribute run contains exactly `#[cfg(test)]`; a name ending in `tests` is never evidence, and every other cfg form counts as production.

---

## Context

`data_lifecycle_manifest_totality_bidirectional` (accounts_tests.rs) is the M22 proof that every
table in the published wasm carries a `DATA_LIFECYCLE_MANIFEST` deletion policy. Its module census
half asserts that every `mod x;` declared anywhere in the crate has `x.rs` in the scanned source
list — that is what closes the "new file, new tables, no policy" blind spot. The census must
therefore exclude only modules that never reach the published wasm.

Until this slice the exclusion rule was a NAME test: any `mod` whose name ends in `tests` was
dropped. The rb-85 round-5 red-team measured the consequence: a production module declared as
`pub(crate) mod reach_privacy_tests;` (via `#[path]`, no `#[cfg(test)]`) was invisible to the
census, so the tables it could declare would carry no deletion policy and the totality proof would
stay green. That is residual R-rb-85-MODCENSUS.

## Decision

1. **Attribute, not name.** A `mod x;` line is exempt iff the contiguous attribute run immediately
   above it — walking upward over blank lines and lines that begin with `#[` and stopping at
   anything else — contains an attribute that, whitespace-squashed, equals exactly `#[cfg(test)]`.
   `#[cfg(test)]` is the one attribute that provably removes an item from the non-test build, so it
   is the exact semantic boundary the census cares about.
2. **Every other cfg form counts as production.** `cfg(any(test, ..))`, `cfg(all(test))`,
   `cfg_attr(test, ..)`, `cfg(not(test))`, a multi-line `#[cfg(\n test\n)]` and an attribute
   attached to a different item above the `mod` all leave the module IN the census, so the
   consumer demands its file be scanned. Failing toward coverage is the only safe direction for a
   totality proof.
3. **The scanner reads a newline-preserving view.** The per-source parse
   (`m22_declared_mod_names_in`) runs over `m22_blank_for_mod_scan`, a single-pass blanker that
   turns line comments, NESTED block comments, string literals, raw strings and char literals into
   spaces while keeping every newline. The pre-existing strings-then-comments pipeline swallows
   across lines when a comment carries an unbalanced `"`, which under rule 1 would let an earlier
   `#[cfg(test)]` attach to a later production `mod` (plan red-team #1/#2). A blanker that never
   merges lines makes that attachment impossible by construction.
4. **Not widened.** Same-line `#[cfg(test)] mod x;` and multi-attribute-per-line runs are
   rustfmt-impossible in this crate (fmt --check is a CI gate) and are deliberately not parsed;
   they fall under rule 2 (counted as production).

## Consequences

- The three sibling copies of the old suffix rule — `rb47_scanned_module_names`
  (trading_tests.rs), `rb76_scanned_module_names` (guards_tests.rs) and the 20r-d census in
  evolution_tests.rs — still exempt by name. They are outside this slice's `touches:` and are
  recorded as follow-ups in the handoff; this ADR is their citation target so the port is one
  mechanical change rather than a fresh design.
- `native_host_tests.rs`'s module doc narrates the old rule ("exempts only `*tests` names"); the
  module stays exempt because `lib.rs` gates it with `#[cfg(test)]`, so nothing breaks, but the
  prose is stale and is a follow-up flag (outside touches).
- A future test module declared WITHOUT `#[cfg(test)]` now fails the census loudly (its `.rs` is
  not scanned) instead of silently vanishing — which is the point.

## Proof of teeth (ADR-0224: ordinary Rust tests, no eval)

Three `rb108_` tests in accounts_tests.rs against the pure seam, each with an exact-vec oracle in
declaration order: the measured cheat is returned and a cfg(test)-gated non-`tests` name is not;
non-exact cfg forms count as production; the red-team line-merge fixtures still return the
production mod. RED was recorded against the extracted-but-unchanged suffix rule before the
predicate changed (memory/projects/gates/rb-108.red-before.md); the acceptance ledger's X5/X6
re-derive that RED mechanically by reinstating the old predicate / the old blanking pipeline on
their single anchor lines and requiring the tests to fail.
