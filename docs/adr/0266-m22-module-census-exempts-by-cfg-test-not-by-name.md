# ADR-0266 — The M22 module census exempts a `mod` by its own `#[cfg(test)]` attribute, never by a name suffix (rb-108)

**Status:** Accepted
**Date:** 2026-09-21
**Slice:** rb-108 (residual R-rb-85-MODCENSUS, promoted from source slice rb-85; M-residual-backlog.spec.md#rb-108)
**Supersedes:** —
**Amends:** —
**Extends:** 0224, 0229
**Subsystems:** ci-gates, schema-persistence
**Decision:** `m22_declared_mod_names` drops a `mod x;` from the deletion-policy census only when its own contiguous attribute run contains exactly `#[cfg(test)]`; a `tests` name suffix is never evidence and every other cfg form counts as production.

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
   turns line comments, NESTED block comments, string literals, raw strings with ANY number of
   hashes, and char literals into spaces while keeping every newline (same byte length, same
   newline positions). The pre-existing strings-then-comments pipeline swallows across lines
   when a comment carries an unbalanced `"` or a char literal is `'"'`, closes a nested comment
   at its first `*/`, and caps raw strings at six hashes — under rule 1 each of those either
   glued an earlier `#[cfg(test)]` onto a later production `mod` or hid the `mod` outright
   (all five measured by the slice's red-team lenses; see the proof of teeth). A blanker that
   never merges lines makes the attachment impossible by construction.
4. **Raw identifiers are reported bare.** `pub(crate) mod r#name;` names the file `name.rs`; the
   `r#` prefix is stripped before the identifier check (it used to fail the check and the
   declaration vanished from the census — the opposite of fail-toward-coverage).
5. **Not widened.** A same-line attribute run (`#[cfg(test)] mod x;`, or several attributes on
   one line) squashes to a non-exact attribute and counts as production under rule 2; two `mod`
   items on one physical line are not parsed at all, and `cargo fmt --check` (a `just lint`
   gate) keeps both layouts out of the tree. Neither is parsed on purpose: more parser is more
   forgeable surface.

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

Three `rb108_` tests in accounts_tests.rs against the pure seam, each with one exact-vec oracle
in declaration order:
- `rb108_mod_census_exempts_by_cfg_test_not_by_name` — the measured cheat
  (`pub(crate) mod reach_privacy_tests;` under a `#[path]`, no cfg) is returned; a
  `#[cfg(test)]`-gated `bench_support` is dropped; a `#[cfg(test)]` above a `use` does not gate the
  `mod` after it; a commented-out gate does not gate; whitespace variants of `#[cfg(test)]` do;
  a raw identifier is returned bare.
- `rb108_mod_census_other_cfg_forms_count_as_production` — `cfg(any(test, ..))`,
  `cfg(all(test))`, `cfg_attr(test, ..)`, `cfg(not(test))`, a multi-line `#[cfg(` / `test` / `)]`
  and a two-attributes-on-one-line run are all returned; the exact `#[cfg(test)]` control is not.
- `rb108_mod_census_blanking_never_merges_lines` — a stray `"` in a `//` comment, a nested block
  comment whose outer `*/` shares the `mod` line, a `'"'` char literal, `r#"…"#` and multi-line
  string phantoms, lifetimes, a seven-hash raw string and a zero-hash raw string ending in `\`.

RED was recorded against the extracted-but-unchanged suffix rule and the old blanking pipeline
before the predicate changed (memory/projects/gates/rb-108.red-before.md: all three failed on
`assert_eq`); the acceptance ledger's X5/X6 re-derive that RED mechanically by reinstating the old
predicate / the old pipeline on their single anchor lines and requiring the tests to fail, and the
verifier's own mutant (zero-hash raw strings unrecognised) survived until the last fixture was added.
