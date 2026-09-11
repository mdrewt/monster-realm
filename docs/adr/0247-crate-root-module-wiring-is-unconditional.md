# ADR-0247 — The crate root wires every domain module bare and unconditional, and the guards seam carries no conditional compilation: a target-selected module twin is a gated defect, not a reviewer convention

**Status:** Accepted
**Date:** 2026-09-11
**Slice:** rb-77 (residual R-rb-46-LIBRSMOD, `M-residual-backlog.spec.md#rb-77`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — its artifact red-team PoC X4 is this residual's origin; reciprocal `Extended-by:` appended to its header)
**Subsystems:** security-authz, ci-gates
**Decision:** rb-77 pins in one ordinary Rust test that lib.rs declares every production module bare and that lib.rs and guards.rs carry no conditional compilation beyond the cfg(test) test-module hook; no new eval.

---

## Context and problem statement

`server-module/src/guards.rs` holds the authorization wrappers every reducer module delegates to — the
ownership preamble, the move authorizer, the three deletion-gate wrappers (ADR-0227, ADR-0237, ADR-0246).
Since m22-s5 those wrappers are pinned byte-for-byte by source-scan tests over `include_str!("guards.rs")`,
and since rb-41 (ADR-0222) their verdicts are executed under the native host. Every one of those pins reads
the file `guards.rs`; none of them reads how the crate root selects it.

rb-46's artifact red-team executed PoC X4 and confirmed the gap: replace `lib.rs:31` (`mod guards;`) with
`#[cfg(not(target_arch = "wasm32"))] mod guards;` plus `#[cfg(target_arch = "wasm32")] #[path =
"guards_wasm.rs"] mod guards;`, and the SHIPPED wasm compiles a twin file while `cargo test` — built for the
native target — compiles, scans and executes the honest one. All 8 rb-46 tests and the m22-s5 pins stay
green. `lib.rs` was outside rb-46's declared touches, so the finding was registered as residual
R-rb-46-LIBRSMOD and classified reviewer-checklist class under ADR-0224 (no new scanner script).

rb-76 (ADR-0246, merged the same day this slice started) partially closed the literal PoC in passing: its
crate-wide containment census asserts that every line beginning `#[path` in `lib.rs` is followed by a
module whose name ends in `tests` (`guards_tests.rs`, clause (e)). Its own doc comment concedes the
single-line form is unparsed, and this slice's plan red-team measured five further routes that leave rb-76
and every other pin byte-identically green: the single-line `#[cfg(..)] #[path = ..] mod guards;`;
`#[cfg_attr(target_arch = "wasm32", path = "guards_wasm.rs")] mod guards;`; deleting `mod guards;` in
favour of `mod guards_wasm;` + `use guards_wasm as guards;`; a nested `mod native { #[path = ..] pub mod
guards; } use native::guards;`; and, inside `guards.rs` itself, `#[cfg(target_arch = "wasm32")]
include!("guards_wasm.rs");` (rb-76's `include!` ban loops over a roster that excludes `guards`). Two
further findings shaped the oracle: raw identifiers — `#[r#cfg(..)]`, `#[r#path = ..]`, `mod r#guards;`,
`r#include!(` — compile, pass rustfmt and clippy, and defeat every needle spelled with the literal `#[cfg`;
and a nested block comment `/* /* */ ; mod guards; */` is handed to the file-local stripper as CODE past
the first close marker, so it can forge a bare `mod guards;` out of comment text.

The question is not whether the review checklist should say "look at the `mod` lines". It is whether an
ordinary test can say it mechanically, once, in the crate the code lives in, without becoming the
scanner-hardening spiral ADR-0224 retired.

## Decision

### D1 — Scope: every production module in the crate root, not only `guards`

The class is "the name a fully qualified call resolves to is bound, under a non-test configuration, to
something other than `src/<name>.rs` as written". Nothing about it is specific to `guards`: `accounts.rs`
owns the deletion predicates the wrappers delegate to, and a target-selected twin of it is a strictly worse
instance of the same defect. The oracle therefore covers every `mod` declaration in `lib.rs`, with
`guards` as the named anti-vacuity anchor. Guards-only would be the same parser, the same fixtures and the
same ADR with a loop body that runs once instead of twenty-one times.

The declaration classes are DERIVED from the name, not enumerated: a module whose name ends in `tests` is
a test module and must be declared with exactly the squashed prefix `#[cfg(test)]#[path=]`; every other
module is a production module and must be declared BARE — private, unattributed, unnested, unaliased, as a
file module — at bracket depth zero of the crate root. There is no name-keyed exception table. A future
legitimate conditional module (the crate already declares a `dev_reducers` feature in
`server-module/Cargo.toml`, so `#[cfg(feature = "dev_reducers")] mod dev;` is a live shape, not a
hypothetical) cannot land without editing the class rule in the test, and that edit is the moment an ADR is
owed. That friction is the point.

### D2 — The grammar: one pure verdict over the squashed view of both files

`rb77_wiring_verdict(lib_src, guards_src) -> Result<(), String>` in `guards_tests.rs` is a non-short-
circuiting label collector over the comments-stripped, strings-blanked, whitespace-squashed view that the
file's existing m22-s5 / rb-76 helpers already produce (no third stripper — ADR-0003). Per file:

- `[rb77/scan-substrate]` — a block-comment close marker surviving the strip means a NESTED block comment,
  which the byte-sequential stripper cannot model; the file is refused rather than scanned wrong. This is
  the check `guards.rs` has carried since 11r-c, extended to `lib.rs` and to every fixture.
- `[rb77/mod-unparsed]` — a `mod` token at an item boundary and bracket depth zero whose `mod<ident>` +
  delimiter shape cannot be read. The parser never skips silently: `mod r#guards;` is a real declaration
  to rustc and an unreadable one to a text scan, and skipping is how a census goes quietly blind.
- `[rb77/mod-inline-body:<name>]` — a `mod x {` block.
- `[rb77/testmod-prefix:<name>]` — a `*tests` module not immediately preceded by exactly
  `#[cfg(test)]#[path=]`, itself preceded by an item terminator.
- `[rb77/mod-not-bare:<name>]` — a production module whose preceding byte is not `;`, `}` or start of
  file. One comparison rejects an attribute (`]`), a visibility (`pub`, `)`), a macro or block (`(`, `{`).
- `[rb77/cfg-not-test]`, `[rb77/cfg-inner]`, `[rb77/cfg-macro]` — any `#[cfg` that does not start
  `#[cfg(test)]` (this also catches `#[cfg_attr(`), any `#![cfg`, any `cfg!(`.
- `[rb77/include-macro]` — `include!(` counted on the RAW source (a fragment hidden in a string) and on
  the squashed view (a whitespace-split `include !(`), either firing.
- `[rb77/raw-ident]` — the two bytes `r#` anywhere in the squashed view. Raw STRINGS are blanked before
  this runs, so the only survivor is a raw identifier, and a raw identifier is exactly the spelling that
  turns every literal needle above into a no-op. Zero occurrences in every production file today.

For `lib.rs` only: `[rb77/guards-anchor]` — exactly one production site named `guards` (absence is how
the alias and macro attacks present); `[rb77/mod-alias:<name>]` — `as<name>` with no left boundary
(squashing glues `as` onto the preceding identifier) and no identifier byte after it, checked for the
frozen name `guards` and every derived production name. Declaration sites are counted only at bracket
depth zero, so a `mod guards;` inside a macro invocation's token tree or an inline module body is not an
anchor.

### D3 — `guards.rs` is free of conditional compilation, file-wide

The same clauses run over `guards.rs`. It carries exactly one `#[cfg` — the `#[cfg(test)]` on its
`mod guards_tests;` hook, which is a `*tests` site under the same class rule — and nothing else
conditional: no `cfg!(`, no `include!(`, no raw identifier. The m22-s5 and rb-76 body pins already ban a
`#[cfg` INSIDE the two wrapper bodies and count each wrapper's declaration marker once; this closes the
file-scope route those pins structurally cannot see.

### D4 — Vehicle: the pure verdict, one live test, one fixture matrix, one live mutant register

- **Live test** `rb77_crate_root_wires_every_module_bare_and_unconditional`: the verdict is `Ok` over
  the real `include_str!` sources; the derived roster has at least twenty production sites and at least one
  test-class site per file (the positive controls that prove both needle families still match something
  real — rb-76's clause (d) names the same modules line-by-line; this parse is byte-level and INCLUDES
  `guards`, which rb-76's roster deliberately excludes); and the raw `lib.rs` carries exactly one line
  beginning `mod guards;` that names this ADR — the reviewer note of D5 is a deliverable, and this is an
  ordinary assertion that it exists, not a ratchet.
- **Fixture matrix** `rb77_module_swap_fixtures_are_rejected_by_clause`: thirteen frozen inputs — the
  literal rb-46 PoC, each measured variant above, the raw-identifier and nested-comment findings, and a
  clean control — each asserted to produce (or, for the control, not produce) its named label. Every
  fixture is an independent function assembled from fragments, so no shared builder can make the matrix
  vacuous and no contiguous production marker enters the test file's source text. This is an ordinary unit
  test of a pure function's return value against known inputs (ADR-0224's endorsed shape); it carries no
  numeric floor, because a floor whose only job is to notice a deleted fixture is the meta-check ADR-0224's
  amendment retires by name.
- **Live mutant register** (ledger gate X5, MANUAL): each compilable mutant applied to the REAL
  `lib.rs` / `guards.rs` one at a time, restored from a byte copy. Fixture-only teeth never prove the test
  reads the real tree; a mutant that fails to build is scored INVALID, never KILLED (rb-72's lesson).

### D5 — The reviewer note is one trailing comment, so no line moves

`mod guards; // rb-77 (ADR-0247): …` on `lib.rs:31`. A comment block above the line would shift every
later line, which moves the four `docs/knowledge/reducers/*.md` line stamps (`lib.rs#L168/189/233/329`)
and forces a bundle regeneration for prose — the cost rb-74 paid explicitly to avoid in this file. rustfmt
defaults (`wrap_comments = false`) leave a long trailing comment untouched. A matching four-line `//`
block sits directly above the `#[cfg(test)]` hook in `guards.rs`, never between it and `mod
guards_tests;` (an eval outside this slice's touches looks back 160 bytes from that declaration for the
attribute). Neither note contains a double quote: one census strips strings BEFORE comments.

### D6 — Anti-decisions

- No name-keyed allow-list of modules; the class is the `tests` suffix.
- No `macro_rules!` ban: rb-78 owns that class, and a macro cannot coexist with the bare depth-zero anchor
  without a duplicate-definition error, so replacing the anchor is its only move and absence fires.
- No end-of-file ordering pin on `guards.rs`: with raw identifiers banned, a conditional item anywhere in
  the file is caught by the cfg clauses, and an unconditional appended item is ordinary reviewable code.
- No change to rb-76's parsers or counts; rb-77 calls `rb76_module_squashed` and derives its own roster.

## Considered alternatives

- **Compiler-enforced (illegal states unrepresentable)** — ADR-0224's preferred rank. Inapplicable:
  which file a `mod` item resolves to is decided by attribute evaluation before name resolution, and no
  type, trait or visibility rule can express "this path attribute must not exist".
- **Do nothing — reviewer checklist only** (the residual's own disposition). Rejected on ADR-0224's
  materiality test, not on principle: the file this protects holds the authorization wrappers, the swap
  ships in the wasm the players connect to, and every executed and scanned pin in the crate reads the
  native file. That is player-data security, not a hypothetical refactor. The note in D5 keeps the
  checklist half; the test makes it mechanical.
- **A clippy lint.** None exists for conditional module selection, and `-D warnings` is already on.
- **A `build.rs` assertion.** Adds a build script to a crate published to SpacetimeDB and moves a review
  invariant into the build graph.
- **AST parse via `syn`.** ADR-0224's escape hatch; a new dependency for a forty-line grammar over one
  file, using the same technique four sibling censuses already apply in the squashed view.
- **A `wasm32` test job.** `cargo test` does not run on `wasm32-unknown-unknown` without a runner, and
  the twin is selected by the very cfg such a job would set — the honest half would never be compiled.
- **A new `evals/*.eval.mjs`.** Barred by ADR-0224.
- **Guards-only scope.** Same code, strictly less reach (D1).

## Consequences and residuals

- Positive: every route the plan red-team measured — two-line, single-line, `cfg_attr`, alias, nested
  re-export, macro token tree, in-file `include!`, raw identifiers, nested-comment phantom — reds the
  live test on a named clause, and the note on `lib.rs:31` says why to a reader who never runs it.
- Accepted friction: a legitimate conditional production module must edit the class rule and argue an ADR.
- Correction to ADR-0236's residual bullet: rb-76 already reds an UNDECLARED `src/guards_wasm.rs` through
  its on-disk superset check, but that check exempts any file whose stem ends in `tests`; and a bare
  `mod guards_wasm;` reds rb-76 clause (a) only when the twin names the subject gate. rb-77 closes both
  by the anchor and the alias clause, not by rb-76's counts.
- Residual `R-rb-77-CARGOSWAP` (backlog): `server-module/Cargo.toml`'s `[lib]` section carries no `path`
  key, so adding one — or a `build.rs`, or a `--cfg` from `.cargo/config.toml` — selects a different crate
  root while both scanned files stay byte-identical. Not chased per ADR-0224; visible in any touches
  audit.
- Related classes already promoted, cited rather than re-minted: rb-78 (macro-generated wiring),
  rb-79 (a `#[cfg(test)]` on a gate STATEMENT inside a rostered module).
- Disclosed, one line each: `#[cfg(test)] #[path = "<any>.rs"] mod x_tests;` can pull any file into the
  TEST build (not a wasm route); `c"…"` / `cr"…"` C-string literals are unhandled by the file-local
  stripper (zero occurrences).

## Confirmation

Filled at slice close from the ledger: the two `rb77_` tests green on the real tree, the fixture matrix
count, the live mutant register result (KILLED / INVALID / controls GREEN), and the full `just ci`.
