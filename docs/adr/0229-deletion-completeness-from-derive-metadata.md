# ADR-0229 — S6 deletion completeness: prove it from the derive metadata, in-crate, not from a source scan

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s6 (M22 §7.2 S6 — PRV1-15, PRV1-16)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0224, ADR-0228
**Subsystems:** ci-gates, security-authz
**Decision:** S6 ships five in-crate `#[test]`s in `accounts_tests.rs` — not new eval scanner scripts, not a `server-module/tests/` target (the manifest is crate-private); the Identity-column half reads SpacetimeDB's own derive metadata, not source text.

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
   exact-pinned and each of the 13 helpers carries a hand-written shape pin. Of the three tables
   reachable only through a *second* hop, two are in fact already proven end to end
   (`battle_challenge_reaper_schedule` via `pvp_tests.rs:5277` + `pvp_tests.rs:2336`;
   `pvp_deadline_schedule` via `battle_tests.rs:6401` + `pvp_tests.rs:5359`). **Exactly one is
   genuinely unproven:** `trade_offer_reaper_schedule` — `trading_tests.rs:3308` pins that
   `erase_trade_offers` calls `disarm_trade_reaper(`, but nothing extracts that helper's own body
   (`trading.rs:148-162`) and asserts it deletes anything, so gutting it to a no-op is green.
   The structural point survives that correction, and it is the real justification: **every one of
   those pins names its accessors BY HAND**, not from the manifest, so the coverage is a coincidence
   of authorship maintained by reviewers rather than a checked correspondence. A table classified for
   the cascade whose helper never touches it is invisible by construction.

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
  interning, so no `Ref` resolution is needed) yields each row struct's `AlgebraicType::Product`.
  No comment stripper, no string-literal parser, no regex — the failure class ADR-0224 names is
  structurally absent, and the check reads the same bytes the host will.
- **A column counts as identity-bearing at ANY depth, not just as a bare leaf.**
  `AlgebraicType::is_identity()` is a shallow shape check (`ProductType::is_identity()` demands
  exactly one field named `IDENTITY_TAG`); the plan red-team measured that `Option<Identity>` lowers
  to a `Sum`, `Vec<Identity>` to an `Array`, and a `#[derive(SpacetimeType)]` newtype to a
  differently-named `Product` — all three invisible to it. Since `Option<Identity>` is a completely
  natural column shape ("assigned_to", "banned_by", "co_owner"), a shallow check would let a new
  owner-keyed table be classified `NotOwned` with **no exception-list edit at all** — reopening the
  very hole this ADR exists to close. The classifier therefore recurses through `Sum` variants,
  `Array` element types and nested `Product` fields. Measured across all 40 live tables, the deep
  walk changes exactly one verdict (`account.claimed_from: Option<Identity>`, on a table already
  classified `Anonymize`), so every rule below holds today with no exception-set change.
- **The recursion carries a depth cap that panics by name.** The inline `TypespaceBuilder` never
  interns, so a future self-referential column type would otherwise stack-overflow and `SIGABRT` the
  whole nextest process rather than failing loud — measured by the red-team in a scratch crate. No
  live table has such a type today; the cap is forward defence.
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
  mutating call **within the same statement**. Statement scoping is load-bearing, not tidiness:
  `erase_monsters` is the entry helper for both `monster` and `monster_pub`, so a body-wide
  "contains the accessor AND contains a mutation" conjunction is satisfied by replacing
  `ctx.db.monster_pub().monster_id().delete(id);` with a `.find(id)` read — the accessor stays, the
  `.delete(` is borrowed from the sibling `monster` line, the gate is green, and every `monster_pub`
  row of every deleted account survives forever. That is a measured red-team bypass of the
  unscoped form, and it is one of this slice's proof-of-teeth fixtures. The entry helper's
  declaration is also asserted to occur exactly once in its module, so a decoy second declaration
  cannot steer the first-hit anchor. An unmapped classified table panics rather than being skipped:
  an unmapped table is an unerased table.
- **The mutating call's ARGUMENT must be keyed, not a bare numeric literal.** The artifact red-team
  measured the whole suite (767/767) GREEN on a diff rewriting `disarm_trade_reaper`'s
  `.scheduled_id().delete(sid)` to `.delete(0)`: `scheduled_id` is `#[auto_inc]` starting at 1, so
  that is a permanent no-op and every `trade_offer_reaper_schedule` row of every deleted account
  survives forever — while the accessor, the `.delete(` token and the statement scope all still
  read correctly. Nothing reachable from `cargo nextest` executes a reducer against a database, so
  a presence check can only ever say a delete-shaped token is nearby, never which row it removes;
  requiring the argument to NAME something is the cheapest available step back toward a claim about
  rows. The same clause closes the identical shape in `disarm_challenge_reaper` and
  `disarm_pvp_deadlines`, whose own pre-existing pins are presence-only.
- **Consequences.** (+) The two remaining deletion-completeness holes are closed by checks that
  cannot suffer the scanner failure class. (+) A new owner-keyed table now cannot be classified
  `NotOwned` by accident. (-) Two new hand-maintained drift surfaces (the 40-entry type registry and
  the 22-entry chain map), both census-pinned and both fail-loud — the same class as, and adjacent
  to, `m22s3b_cascade_covers_manifest`'s existing map. (-) `accounts_tests.rs` grows further; a
  dedicated `src/deletion_completeness_tests.rs` is the natural home once a slice legitimately owns
  `accounts.rs`'s module declarations. (o) The spec's S6 row and its `evals/account-privacy.eval.mjs`
  seed-set extension are dropped as retired work, not deferred.
- **Residual, named rather than papered over.** The four-table `NotOwned` exception set is itself a
  *declared* fact living in the same test file a slice ships, so one self-consistent commit can add a
  genuinely owner-keyed table, register its row type, append its accessor to the exception array and
  bump the census from 4 to 5. That is the same defect class this ADR rejects `owner_keyed: bool`
  for, one file over, and it is **not closable in-test** — it is a review-gate obligation. The
  guarantee this ADR actually buys is therefore narrower than "a fifth identity-bearing `NotOwned`
  table fails CI": an *unagreed* fifth table fails CI, and an agreed one is forced to be visible as a
  census bump plus an exception-array edit in the diff, where a reviewer must sign it off. Reviewers
  of any diff touching `DATA_LIFECYCLE_MANIFEST` should treat a change to that census as a
  privacy-classification decision, not a test-maintenance edit.
- **Second residual: the rules key on `Identity`, not on "personal data".** A future table holding
  PII with NO `Identity` column — a report row keyed only by `#[auto_inc] id`, carrying free text,
  an email or a device id — passes the `NotOwned` arm with zero friction, because the check
  short-circuits on a zero column count before the frozen-exception check runs. Worse, the rule set
  actively pushes an author that way: classifying such a table `Erase` HARD-FAILS R1 (no Identity
  column), so the gate makes the safe classification the inconvenient one. Nothing here fixes that
  — it is a review obligation on the `basis` prose, and the X3 failure message says so in as many
  words rather than letting a reader over-read the gate.
- **Third residual: a keyed argument is not the RIGHT key.** `.delete(some_other_bound_id)` still
  passes. Closing it would need a per-body pin on each helper's own loop variable — a second
  hand-maintained map of the class this ADR is already paying for once. Deliberately not built.
- **Scope of a green X5:** it proves a keyed mutating call is REACHED in the terminal body, not
  that every row is swept. `battle::anonymize_battles` deliberately skips battles still `Ongoing`,
  and that branch is reachable, so a deleted identity can persist in the public `battle` table —
  a residual m22-s3b named and accepted, structurally invisible to this test. The X5 doc comment
  says so at the assertion site.

## Confirmation

Enforced by five ordinary `#[test]`s in `server-module/src/accounts_tests.rs`, run by
`cargo nextest run -p monster-realm-module` inside `just ci`:
`m22s6_table_row_registry_matches_manifest`, `m22s6_owner_keyed_tables_are_erase_or_anonymize`,
`m22s6_via_join_tables_carry_no_identity_column`,
`m22s6_not_owned_identity_exceptions_are_frozen`,
`m22s6_cascade_chain_reaches_every_classified_table`. Each was shown to fail on a real mutation of
production source before it passed on the shipped tree; the four-mutant record is
`memory/projects/gates/m22-s6.x6-mutant-register.md` in the harness repo, and the acceptance ledger
is `memory/projects/gates/m22-s6.gates.md` (gates X1-X8).
