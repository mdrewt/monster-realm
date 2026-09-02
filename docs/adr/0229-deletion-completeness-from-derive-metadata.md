# ADR-0229 — S6 deletion completeness: prove it from the derive metadata, in-crate, not from a source scan

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s6 (M22 §7.2 S6 — PRV1-15, PRV1-16)
**Supersedes:** —
**Extends:** ADR-0224, ADR-0228
**Subsystems:** ci-gates, security-authz
**Decision:** S6's completeness checks ship as two in-crate `#[test]`s in `accounts_tests.rs`, not as the spec's two new `evals/*.eval.mjs` files and not as a `server-module/tests/` integration target. The Identity-column half is derived from SpacetimeDB's own derive metadata rather than from source text.

## Context and problem statement

M22 §7.2's S6 row predates S2 and S3b, and its two criteria are now *partly already shipped*:

* **PRV1-15** ("a new table without a `deletion_policy` + non-empty `basis` fails CI") is met by
  `data_lifecycle_manifest_totality_bidirectional` (bidirectional set equality between the live
  table census and `DATA_LIFECYCLE_MANIFEST`, plus a `>= 40` ratchet and a `mod` census) and by
  `data_lifecycle_basis_nonempty_config_singleton` (a 20-byte basis floor).
* **PRV1-16** ("a cascade delete/update removed, or moved behind an always-false branch, fails CI")
  is met *for the reaper body* by `rb24_deletion_reaper_body_is_pinned_cascade`, which pins that
  body by EXACT equality — an equality pin catches deletion and an `if false { .. }` wrapper alike.

Two holes remained, both measured while planning this slice:

1. **Nothing correlates a table's actual columns with its policy.** A new owner-keyed table
   classified `NotOwned` satisfies totality (it has an entry) and the basis floor (prose is prose),
   and is then skipped outright by `m22s3b_cascade_covers_manifest`, whose walk returns early for
   `NotOwned`. Its rows survive account deletion with every gate green. PRV1-15's "**with a direct
   `Identity` column**" clause is exactly about this, and nothing implemented it.
2. **Nothing ties the manifest to the far end of the delegated cascade.** Under ADR-0228 the
   cascade is `reaper -> 13 helpers -> (sometimes) a sub-helper -> the row write`. The reaper end is
   exact-pinned and each helper carries a hand-written shape pin, but those pins name accessors
   chosen by hand rather than derived from the manifest. Three of the 22 classified tables are only
   reachable through a second hop (`trade_offer_reaper_schedule` via `trading::disarm_trade_reaper`,
   `battle_challenge_reaper_schedule` via `pvp::disarm_challenge_reaper`, `pvp_deadline_schedule`
   via `pvp::disarm_pvp_deadlines`, called cross-module from `battle::anonymize_battles`) — a chain
   nothing proved end to end.

ADR-0224 forbids new `evals/*.eval.mjs` scanner scripts outright, so the spec's stated S6 vehicle
(`deletion-completeness.eval.mjs` + `pending-deletion-gate.eval.mjs`) is unavailable.

## Considered alternatives

- **`server-module/tests/deletion_completeness.rs`, the integration target the slice brief names.**
  Rejected as **not viable**, not merely as a preference: `lib.rs` declares every domain module
  privately (`mod schema;`, `mod accounts;` — nothing is `pub`), so an external test target cannot
  reference `DATA_LIFECYCLE_MANIFEST`, `DeletionPolicy` or any row struct. Publishing those modules
  is a `lib.rs` edit, outside this slice's declared `touches:` and a hidden-dependency stop. What an
  integration target *could* do is `include_str!` the sources and re-derive a scanner — which is the
  exact mechanism ADR-0224 retires. Placement is therefore forced, not chosen.
- **A new `src/deletion_completeness_tests.rs` sibling module.** Declaring it needs a `#[cfg(test)]
  mod` line in `accounts.rs` or `schema.rs`, both of which this slice holds read-only. Rejected for
  the same scope reason; ADR-0228/RT-4 already set the precedent of homing such pins in
  `accounts_tests.rs` "rather than in a new file this slice would have to create".
- **Scanning `schema.rs` for `: Identity` fields.** The obvious implementation, and the one the
  original eval would have used. Rejected: it is the string-matching approximation of a parser that
  ADR-0224 retires, and this repo has already paid for that class four separate times (a regex
  literal blinding a comment stripper, a bare quote in a comment swallowing code, an unpaired `/*`
  blanking a later function, biome's `\'` rewrite truncating a key scan).
- **Declaring `owner_keyed: bool` per manifest entry.** Compile-checked and cheap, but a *declared*
  fact: a new table whose author writes `false` is exactly the failure being guarded against, and
  the entry lives in `schema.rs`, which this slice holds read-only.

## Decision outcome

- **Chosen: two ordinary in-crate `#[test]`s in `accounts_tests.rs`.**
- **The Identity-column half is computed from the real derive metadata.** `#[spacetimedb::table]`
  derives `SpacetimeType`; a throwaway inline `TypespaceBuilder` (whose `add` inlines rather than
  interning, so no `Ref` resolution is needed) yields each row struct's `AlgebraicType::Product`,
  and `AlgebraicType::is_identity()` answers per column. No comment stripper, no string-literal
  parser, no regex — the failure class ADR-0224 names is structurally absent, and the check reads
  the same bytes the host will. Verified across all 40 tables while planning.
- **The registry that drives it names row TYPES, not strings**, so a renamed or removed struct is a
  compile error rather than a silent skip, and it is totality-checked against
  `DATA_LIFECYCLE_MANIFEST` in both directions with the census pinned at 40.
- **Three structural rules, one frozen exception set.** `Erase`/`Anonymize` => at least one direct
  `Identity` column; `ViaJoin(_)` => exactly zero (the variant's own doc comment, stated as a
  checked fact); `NotOwned` => exactly zero, except a census-pinned four-table exception set
  (`config`, `guest_claim`, `guest_claim_reaper_schedule`, `account_deletion_reaper_schedule`),
  each of which already carries a deliberate `basis`. A fifth identity-bearing `NotOwned` table
  hard-fails and forces a human decision.
- **The cascade half is a manifest-driven chain proof**, allowing exactly one optional `via` hop per
  table, ending in an assertion that the terminal body names the table's own accessor AND performs a
  mutating call. An unmapped classified table panics rather than being skipped: an unmapped table is
  an unerased table.
- **Consequences.** (+) The two remaining deletion-completeness holes are closed by checks that
  cannot suffer the scanner failure class. (+) A new owner-keyed table now cannot be classified
  `NotOwned` by accident. (-) Two new hand-maintained drift surfaces (the 40-entry type registry and
  the 22-entry chain map), both census-pinned and both fail-loud — the same class as, and adjacent
  to, `m22s3b_cascade_covers_manifest`'s existing map. (-) `accounts_tests.rs` grows further; a
  dedicated `src/deletion_completeness_tests.rs` is the natural home once a slice legitimately owns
  `accounts.rs`'s module declarations. (o) The spec's S6 row and its `evals/account-privacy.eval.mjs`
  seed-set extension are dropped as retired work, not deferred.
