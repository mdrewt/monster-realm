# ADR-0247 — The crate root wires every domain module bare and unconditional, and the TEXT of the guards seam carries no conditional compilation: a target-selected module twin is a gated defect, not a reviewer convention

**Status:** Accepted
**Date:** 2026-09-11
**Slice:** rb-77 (residual R-rb-46-LIBRSMOD, `M-residual-backlog.spec.md#rb-77`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — its artifact red-team PoC X4 is this residual's origin; reciprocal `Extended-by:` appended to its header)
**Subsystems:** security-authz, ci-gates
**Decision:** rb-77 pins in one ordinary Rust test that lib.rs declares every production module bare and the TEXT of lib.rs and guards.rs carries no conditional compilation beyond the cfg(test) test-module hook.

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
single-line form is unparsed, and this slice's plan red-team measured six further routes that leave rb-76
and every other pin byte-identically green: the single-line `#[cfg(..)] #[path = ..] mod guards;`;
`#[cfg_attr(target_arch = "wasm32", path = "guards_wasm.rs")] mod guards;`; deleting `mod guards;` in
favour of `mod guards_wasm;` + `use guards_wasm as guards;`; a nested `mod native { #[path = ..] pub mod
guards; } use native::guards;`; a `wire! { ; mod guards; }` token tree in place of the declaration; and,
inside `guards.rs` itself, `#[cfg(target_arch = "wasm32")] include!("guards_wasm.rs");` (rb-76's
`include!` ban loops over a roster that excludes `guards`). Two
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
  file. One comparison rejects an attribute (`]`) and a visibility (`pub`, `)`); a macro token tree or an
  inline block never reaches this comparison, because sites are counted only at bracket depth zero — that
  route presents as `[rb77/guards-anchor]`.
- `[rb77/cfg-not-test]`, `[rb77/cfg-inner]`, `[rb77/cfg-macro]` — any `#[cfg` that does not start
  `#[cfg(test)]` (this also catches `#[cfg_attr(`), any `#![cfg`, any `cfg!`. The macro needle is the four
  bytes `cfg!` with no delimiter attached, and that is a MEASURED requirement, not a stylistic one: the
  artifact red-team ran `cfg! {target_arch = "wasm32"}` against the first draft's paren-bound `cfg!(`
  needle — braces compile, pass rustfmt and clippy, and shipped an unconditional `require_owner` bypass
  into the wasm build while every test in the crate stayed green.
- `[rb77/include-macro]` — the eight bytes `include!`, delimiter-agnostic for the same measured reason
  (`include! {"…"}` is the identical attack), counted on the RAW source (a fragment hidden in a string) and
  on the squashed view (a whitespace-split `include !(`), either firing.
- `[rb77/char-literal-bracket]` — a char literal whose content is a bracket character, in either file. The
  file-local stripper blanks strings but deliberately KEEPS char literals, so a `'{'` at bracket depth zero
  strands the depth counter: every declaration below it stops being a depth-zero site and simply vanishes
  from the roster. The live floors do not notice, because they count what is left. Zero occurrences today.
- `[rb77/raw-ident]` — the two bytes `r#` anywhere in the squashed view. Raw STRINGS are blanked before
  this runs, so the only survivor is a raw identifier, and a raw identifier is exactly the spelling that
  turns every literal needle above into a no-op. Zero occurrences in every production file today.

For `lib.rs` only: `[rb77/guards-anchor]` — exactly one production site named `guards` (absence is how
the alias and macro attacks present); `[rb77/mod-alias:<name>]` — `as<name>` with no left boundary
(squashing glues `as` onto the preceding identifier) and no identifier byte after it, checked for the
frozen name `guards` and every derived production name. Declaration sites are counted only at bracket
depth zero, so a `mod guards;` inside a macro invocation's token tree or an inline module body is not an
anchor.

### D3 — The TEXT of `guards.rs` is free of conditional compilation, file-wide

The same clauses run over `guards.rs`. It carries one `#[cfg` today — the `#[cfg(test)]` on its
`mod guards_tests;` hook, which is a `*tests` site under the same class rule — and the grammar admits only
the exact `#[cfg(test)]` spelling, so a SECOND test-configured item would pass, which is harmless: a
`cfg(test)` item never reaches the wasm build. Nothing else conditional survives the clauses: no `cfg!`,
no `include!`, no raw identifier, no bracket char literal. The m22-s5 and rb-76
body pins already ban a `#[cfg` INSIDE the two wrapper bodies and count each wrapper's declaration marker
once; this closes the file-scope route those pins structurally cannot see.

What this proves is what `guards.rs` itself SPELLS, not what `crate::guards::*` compiles to. A target split
can live in any other rostered module — a `cfg`-paired helper `fn` in `schema.rs` that a wrapper here
calls, or an exported macro — and both scanned files stay byte-identical while the wasm build takes a
different branch. That is the residual recorded below, not a defect in this scan.

### D4 — Vehicle: the pure verdict, one live test, one fixture matrix, one live mutant register

- **Live test** `rb77_crate_root_wires_every_module_bare_and_unconditional`: the verdict is `Ok` over
  the real `include_str!` sources; the derived roster has at least twenty production sites and at least one
  test-class site per file (the positive controls that prove both needle families still match something
  real — rb-76's clause (d) names the same modules line-by-line; this parse is byte-level and INCLUDES
  `guards`, which rb-76's roster deliberately excludes); and the raw `lib.rs` carries exactly one line
  beginning `mod guards;` that names this ADR — the reviewer note of D5 is a deliverable, and this is an
  ordinary assertion that it exists, not a ratchet.
- **Fixture matrix** `rb77_module_swap_fixtures_are_rejected_by_clause`: sixteen frozen inputs — the
  literal rb-46 PoC, `cfg_attr`, the alias trio, the nested re-export, the macro token tree, `pub`,
  test-framing on a production name, a cfg'd `include!` alongside a paren-delimited `cfg!`, raw
  identifiers, the nested-comment phantom, a
  spaced `include !(`, an unframed test module, `#![cfg` paired with a brace-delimited `cfg!`, a
  brace-delimited `include!`, a bracket char literal, and a clean control — each asserted to produce (or,
  for the control, not produce) its named label. The single-line spelling of the PoC is deliberately NOT
  its own fixture: whitespace squashing makes it the same input as the two-line form, so a separate row
  would assert the same bytes twice and read as coverage it is not. Every fixture is an independent
  function assembled from fragments, so no shared builder can make the matrix vacuous and no contiguous
  production marker enters the test file's source text. This is an ordinary unit test of a pure function's
  return value against known inputs (ADR-0224's endorsed shape); it carries no numeric floor, because a
  floor whose only job is to notice a deleted fixture is the meta-check ADR-0224's amendment retires by
  name.
- **Live mutant register** (ledger gate X5, MANUAL): twelve compilable mutants applied to the REAL
  `lib.rs` / `guards.rs` one at a time and restored from a byte copy, plus three control rows — a pristine
  baseline plus two benign mutations — that must stay GREEN. Fixture-only teeth never prove the test reads
  the real tree; a mutant
  that fails to build is scored INVALID, never KILLED (rb-72's lesson). The measured result is recorded in
  Confirmation at slice close.

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
  native file. That is player-data security, not a hypothetical refactor. The materiality is measured, not
  argued: this slice's artifact red-team shipped a real wasm-only `require_owner` bypass through this very
  class (a brace-delimited `cfg!`) with the whole crate green. The note in D5 keeps the checklist half; the
  test makes it mechanical.
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

- Positive: every route measured across both red-team passes — two-line and single-line, `cfg_attr`,
  alias, nested re-export, macro token tree, in-file `include!` in both paren and brace spellings,
  brace-delimited `cfg!`, raw identifiers, nested-comment phantom, bracket char literal — reds the live
  test on a named clause (measured by the X5 register recorded in the ledger at slice close), and the note
  on `lib.rs:31` says why to a reader who never runs it.
- Accepted friction: a legitimate conditional production module must edit the class rule and argue an ADR.
- Correction to ADR-0236's residual bullet, measured: rb-76 does red an UNDECLARED `src/guards_wasm.rs`
  through its on-disk superset check, but that check EXEMPTS any twin file whose stem ends in `tests`, so a
  twin named for the test class rides through it; and a bare `mod guards_wasm;` reds rb-76 clause (a) only
  when the twin file itself names the subject gate, which a twin that merely re-exports does not. rb-77
  closes both by the `guards` anchor and the alias clause, not by rb-76's counts.
- Residual `R-rb-77-CFGROSTER` (backlog): this scan reads two files, and the discipline it enforces —
  target-selection predicates, `target_arch` and its family, and by extension `debug_assertions` and
  cargo-feature cfgs, all of which differ between the native test build and the published wasm — is owed
  by every rostered module and by every crate the module links. Four measured facts define that slice,
  which is the rb-79-shaped crate-wide one and is not attempted here. (a) `game-core` is inside the class:
  its `build.rs` already generates source that `game-core/src/content.rs:283` pulls in through
  `include!(concat!(env!("OUT_DIR"), "/content_parts.rs"))`, so a `cargo::rustc-cfg` emission or a change
  to the generated source alters the rules the server enforces with ZERO diff in `server-module`. (b) The
  real build matrix must be modelled before any crate-wide "every `#[cfg` is `#[cfg(test)]`" rule can be
  true: tests run `cargo nextest run --workspace` with DEFAULT features (`justfile:41`), only clippy passes
  `--all-features` (`justfile:23`), and `.github/workflows/ci.yml:157` builds a SECOND wasm with
  `--features dev_reducers`; six live `#[cfg(feature = "dev_reducers")]` sites exist (`battle.rs:40,42,44`
  and `:546`; `taming.rs:18,280`), and `start_wild_battle` at `battle.rs:546` is proven by source pin alone
  precisely because it is never compiled into the test build (`battle_tests.rs:6647`). (c) rb-76's
  crate-wide `include!` ban (`guards_tests.rs:3886`) is still paren-bound and raw-only, so
  `include! {"twin.rs"}` or a spaced `include !(` in any of the other twenty rostered modules is open; the
  CFGROSTER slice sweeps a delimiter-agnostic `include!` over every rostered module. (d) A consumer-side
  alias — `mod guards_wasm;` plus `use crate::guards_wasm as guards;` INSIDE one consumer module, which
  rebinds that module's unqualified `guards::` calls — is outside `lib.rs`'s alias clause; it is
  UNCONDITIONAL, so any executed native-host authz test over that consumer catches it, leaving the
  pin-only reducers as the exposure, the same set as (b). The artifact red-team measured the simplest
  instance of the class: a `cfg`-paired helper in another rostered module, called from a wrapper here,
  leaves `lib.rs` and `guards.rs` byte-identical and every `rb77_` clause green.
- Residual `R-rb-77-CARGOSWAP` (backlog): crate-root selection is the `[lib]` `path` key (absent from
  `server-module/Cargo.toml` today, so adding one is a one-line swap) or a `--cfg` flag, reached through
  `[build] rustflags` in a `.cargo/config.toml` — the directory already exists, for `mutants.toml` —
  or through `RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS`; zero occurrences measured across `justfile`,
  `.github/workflows/*.yml` and `scripts/*.sh`. A `build.rs` does NOT select a crate root: it injects cfgs
  and `OUT_DIR` source, which is the CFGROSTER class above. Either way both scanned files stay
  byte-identical. Not chased per ADR-0224; visible in any touches audit.
- Related classes already promoted, cited rather than re-minted: rb-78 (macro-generated wiring),
  rb-79 (a `#[cfg(test)]` on a gate STATEMENT inside a rostered module).
- Disclosed, one line each: `#[cfg(test)] #[path = "<any>.rs"] mod x_tests;` can pull any file into the
  TEST build — not a wasm route, but a GATE-DISABLING one, because the tests-class check compares only the
  squashed prefix and the path STRING is blanked, so re-pointing `guards.rs`'s own hook at another file
  swaps the whole source-scan corpus out of the test build while the wasm stays untouched, and rb-76's
  `*tests` stem exemption never flags the replacement; the `include!` clause counts the RAW source, so
  PROSE in either scanned file that spells that macro reds the live test, and both of this slice's notes
  are worded around it deliberately; a `cr#"…"#` C raw string would false-RED `[rb77/raw-ident]`, loudly
  and on the first run, because the shared stripper knows only the `"`, `b`, `r` and `br` prefixes (zero
  occurrences today, and the stripper is shared with other gates so it is deliberately not modified here);
  a string literal containing a block-comment opener panics the scan, inherited from rb-76's precondition
  and equally loud.

## Confirmation

Filled at slice close from the ledger: the two `rb77_` tests green on the real tree, the fixture matrix
count, the live mutant register result (KILLED / INVALID / controls GREEN), and the full `just ci`.
