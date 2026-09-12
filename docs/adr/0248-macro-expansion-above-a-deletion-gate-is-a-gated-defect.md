# ADR-0248 — No macro invocation may sit between a reducer's item boundary and a deletion-gate call; `format!(` is the one admitted spelling and its identifier has exactly one legal spelling crate-wide

**Status:** Accepted
**Date:** 2026-09-12
**Slice:** rb-78 (residual R-rb-46-MACRORET, `M-residual-backlog.spec.md#rb-78`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0236 (rb-46 — clause I's disclosed macro residual is this slice's origin; reciprocal `Extended-by:` appended to its header)
**Subsystems:** security-authz, ci-gates
**Decision:** rb-78 pins in one ordinary Rust test that no macro invocation sits between a reducer's item boundary and any of the ten deletion-gate call sites, admitting only `format!(` and banning every respelling of that identifier crate-wide.

---

## Context and problem statement

rb-46 (ADR-0236 D4) closed the above-the-gate class its artifact red-team measured — a depth-0 early
`return` routing real clients around the deletion gate — with a counting rule at
`server-module/src/battle_tests.rs:6886-6929` (clause I): in the squashed region above the gate the count
of `return` must equal the count of `return Err(e);`, because an early exit above a security gate is only
ever legitimate as a REJECTION. The clause discloses its own hole in its failure message
(`battle_tests.rs:6922-6924`): "HONEST RESIDUAL, registered in the slice ledger rather than papered over:
a `macro_rules!` expanding to a conditional return contains no textual `return` and evades this clause."
ADR-0236 repeats it under **Residuals (disclosed; reviewer-checklist class under ADR-0224 — no new
scanner)**: "a `macro_rules!` that expands to a conditional early return carries no textual `return` and
evades the early-exit clause". That is residual R-rb-46-MACRORET, which this slice closes.

It is not theoretical. Measured 2026-09-12 in this worktree at commit 79e3432, before any rb-78 test
existed (evidence: `rb-78.red-before.md` §1, memory/projects/gates in the harness repo): a module-scope
`macro_rules!` expanding to `if $ctx.sender() != crate::WILD_IDENTITY { return Ok(()); }`, invoked
directly above `server-module/src/battle.rs:124`, is CI-clean — `cargo fmt --check` exit 0, `cargo nextest
run -p monster-realm-module` → `900 tests run: 900 passed, 0 skipped`, clippy `--all-targets
--all-features -- -D warnings` exit 0. Every real player (any non-zero sender) returns `Ok(())` before the
gate and before every other check; only the native host's fixed all-zero sender reaches it, so every
executed rb-46 test still observes the gate firing. Nothing else reds: clauses A-H constrain the untouched
gate STATEMENT; clause I counts a textual `return` that now lives in the macro definition, outside the
body; the m22-s5 pins, rb-76 and rb-77 read `guards.rs`, `begin_encounter`'s frozen prefix and `lib.rs`,
none of them touched. Two of the ten gate sites are already macro-closed in passing
by whole-prefix EQUALITY — `begin_encounter` (rb-76, `battle_tests.rs:7859`) and `respond_trade` (rb-47,
`trading_tests.rs:4600`) — and the other eight are open. The question, as in ADR-0247, is not whether the
review checklist should say "look above the gate", but whether an ordinary test can say it mechanically,
once, in the crate the code lives in, without becoming the scanner-hardening spiral ADR-0224 retired.

## Decision

### D1 — Scope: all ten deletion-gate call sites, derived from three needles, not enumerated

The class is "something between a reducer's item boundary and its deletion-gate call expands to code the
text does not show"; nothing about it is specific to `start_battle`. The oracle covers every fully
qualified call to any member of the deletion-gate family, DERIVED by three needles —
`crate::guards::require_not_deleting(`, `crate::guards::require_subject_not_deleting(`,
`crate::guards::require_commitment_predates_deletion(` — over the roster `rb76_scanned_module_names()`
(`server-module/src/guards_tests.rs:3345`, derived from `lib.rs`'s module declarations and seeded with the
crate root) plus `guards`. Today that resolves to ten sites: `battle.rs:124` (`start_battle`),
`battle.rs:411` (`begin_encounter`), `battle.rs:558` (`start_wild_battle`), `economy.rs:119` (`buy`),
`economy.rs:213` (`sell`), `pvp.rs:818` (`challenge_pvp`), `pvp.rs:1004` (`accept_challenge`),
`ranking.rs:152` (`set_profile_name`), `trading.rs:252` (`propose_trade`), `trading.rs:468`
(`respond_trade`). An eleventh site inherits the rule the moment it is written.

The two already-closed sites stay in scope, because equality cannot supply what D3 does. A frozen prefix
is a hand-typed literal compared against the squashed text of THAT region: it proves bytes, and the bytes
it freezes legitimately include a macro invocation — `battle_tests.rs:7865` ends the frozen
`begin_encounter` prefix with `Err(format!());`. Equality accepts that call forever and is structurally
blind to what `format` RESOLVES to; a shadowing definition, an aliased import or a glob-imported twin
changes the expansion while leaving both frozen prefixes byte-identical.

### D2 — The grammar: one pure verdict over the squashed view of every production module

`rb78_macro_verdict(sources: &[(String, String)]) -> Result<(), String>`
(`server-module/src/guards_tests.rs:5510`) is a non-short-circuiting label collector (the rb-77 shape)
over `rb78_squashed` (`guards_tests.rs:5320`) — this file's own `strip_comments_and_strings`
(`guards_tests.rs:888`) composed with `m22s5_squash` (`guards_tests.rs:1646`), the SAME two shared
primitives `rb76_module_squashed` (`guards_tests.rs:3317`) composes, so no third stripper is introduced
(ADR-0003, the harness design decision that a rule is spelled once). `*tests` modules are `cfg(test)` and
are not in the roster, so "every production module" is the scan's reach, not the crate's file list.

`rb76_module_squashed` itself is deliberately NOT reused: it ASSERTS its preconditions through
`m22s5_assert_source_is_scannable` (`guards_tests.rs:1662`) and therefore PANICS, and a fixture matrix
cannot observe a panic. The three substrate preconditions are re-raised inside the verdict as
`[rb78/scan-substrate:<file>]` LABELS instead, which is what lets F16, F21 and F22 prove they fire.

**Region.** For each needle occurrence, from the last bracket-depth-0 item boundary (`;` or `}`, or start
of file) before it, up to the needle (`rb78_region_texts`, `guards_tests.rs:5348`) — so it holds the
reducer's attributes, signature and whole body prefix, and a whole-function wrapper macro and a
macro-GENERATED function both put their own `ident!(` / `ident!{` INSIDE it without needing a clause of
their own. **Depth** counts braces only; a `(` or `[` char literal is inert to a brace counter and cannot
form a `!`-plus-delimiter pair, which is why the char-literal ban below is exactly rb-46 clause 0c's set.

**Clauses** — the verdict collects all of them, never the first:

- `[rb78/scan-substrate:<file>]`, on every scanned file and every fixture, for each of the three
  preconditions: (a) a raw-string opener with three or more hashes, measured on the RAW text — the
  byte-sequential stripper handles hash depths zero to two only, so a deeper one blanks the wrong byte
  range and every clause below reads text nobody wrote; (b) unequal block-comment opener and closer
  counts, also measured on the RAW text, because an unpaired opener makes the stripper blank the file to
  its LAST BYTE — the gate needle vanishes with it, the region set is empty, every region clause is
  skipped, and the verdict returns `Ok(())` about a file it never looked at, which is the one failure
  that lets a macro ban pass by looking at nothing; (c) a block-comment CLOSE marker surviving the strip,
  meaning a NESTED comment, which the stripper cannot model (it stops at the first closer and hands the
  outer comment's tail to the scan as code).
- `[rb78/char-literal-bracket:<file>]` — a `{` or `}` char literal in a file carrying at least one gate
  needle: the stripper keeps char literals, so one brace literal strands the depth counter and every
  region below it silently moves. Gate-bearing files only, because `privacy.rs`, `content.rs` and
  `observability.rs` spell brace literals legitimately and carry no gate.
- `[rb78/macro-above-gate:<file>:<macro>]` — a `!` immediately followed by `(`, `{` or `[` inside a
  region, the name read by walking back over identifier bytes. The label quotes the first ~48 squashed
  bytes of the region, which shows the signature; there is no function-name recovery and so no clause
  that can go quietly blind on an unreadable one.
- `[rb78/raw-ident:<file>]` — the two bytes `r#` in a region; raw strings are blanked first, so the only
  survivor is a raw identifier, the one spelling that turns every literal needle into a no-op.
- `[rb78/format-respelt:<file>]`, `[rb78/format-alias:<file>]`, `[rb78/macro-use:<file>]`,
  `[rb78/glob-import:<file>]` — the four WHOLE-FILE clauses of D3, which run over every production
  module whether or not it carries a gate (F10 is exactly that case).

**The keyword exemption.** A `!` before a delimiter is also unary negation, so the walked-back name is
EXEMPT when empty or exactly one of `if while match return break in` — `break !(x)` is legal Rust, and
each of the six can be immediately followed by a negated delimited expression once whitespace squashes
away. An attacker cannot claim it: a macro cannot bear a keyword as its name, and the one spelling that
would is `r#`-prefixed, which is its own clause in the same region. `else` is deliberately excluded — it
cannot precede a unary expression.

### D3 — One trust decision: the six bytes `format` are the only admitted macro, so that identifier gets exactly one legal spelling crate-wide

`format!(` is the only macro invoked above any gate today (three times in `start_battle`'s region, once in
`begin_encounter`'s), it is the standard-library formatter, it cannot early-return from its caller, and
banning it would red the shipped tree. It is admitted as a BYTE SEQUENCE, not a resolved path: exactly the
six bytes `format`, directly before the `!`, followed by `(`, with the byte before `format` neither an
identifier byte nor `:`. Nesting is not sheltered — every other `!`-plus-delimiter pair in the region is
its own site, including one written inside the admitted call's argument list.

A byte-sequence allow-list is worth exactly what the identifier's uniqueness is worth, so admitting it and
banning every respelling of it are ONE decision. The four clauses below run over every production module
in the derived roster — which is what "crate-wide" means here, the `*tests` modules being `cfg(test)` and
unscanned. The shadow routes and their closures, each measured at zero occurrences today:

- **A definition anywhere in the crate** (`macro_rules! format { .. }`, in a body or any rostered module)
  → `[rb78/format-respelt]`: squashed, the definition reads `macro_rules!format{`, so that `format` is not
  followed by `!(`.
- **An alias**, `use x::evil as format;` → `[rb78/format-alias]`: the bytes `asformat` with no identifier
  byte to their left (squashing glues `as` onto the preceding token) and a boundary to their right — the
  rb-77 mod-alias shape.
- **A plain or path-qualified import**, `use x::format;`, `std::format!(`, `crate::format!(` →
  `[rb78/format-respelt]`: an identifier-bounded `format` either preceded by `:` or not followed by `!(`.
- **`#[macro_use] extern crate <c>;`**, which injects a sibling crate's exported macros with no import
  line at all → `[rb78/macro-use]`, the bytes `macro_use`.
- **A glob import**, `use game_core::*;` re-importing a `#[macro_export] macro_rules! format` from the
  workspace sibling → `[rb78/glob-import]`: any `::*` whose root identifier is not exactly `super`, `self`
  or `crate` (those three re-import from files this scan already reads). Live cost zero: the crate's only
  glob is `server-module/src/content.rs:907` (`use super::*;`, an inline test module).

Two fail-closed false-RED classes fall out of spelling those two clauses as byte sequences. Both are zero
on the tree today, both are loud on the first run, and the response to either is to re-derive the rule in
a slice that owns an ADR — never to widen a needle:

- The glob clause walks back over identifier bytes from `::*` and therefore reads the LAST path segment,
  so the admitted roots are the DEPTH-1 spellings only: `super`, `self`, `crate`, plus their `use`-glued
  and `pub use`-glued forms as the squash produces them — the nine literals of `rb78_glob_roots`
  (`guards_tests.rs:5298`), listed explicitly so that `mysuper` or `notcrate` is still refused. A
  legitimate multi-segment in-crate glob, `use crate::schema::*;`, presents `schema` and is rejected.
- The respelt clause reads a byte sequence, not a binding, so a variable, field or parameter named
  exactly `format` and used as DATA in any production module is an identifier-bounded occurrence that is
  not followed by `!(`, and reds as `[rb78/format-respelt]`.

### D4 — Vehicle: the pure verdict, one live test, one fixture matrix, one live mutant register

**Live test** `rb78_no_macro_expands_above_any_deletion_gate` (`guards_tests.rs:6475`): the verdict is
`Ok` over the live sources, and three positive controls stand behind it — controls, not floors, because
nothing is pinned whose only job is to notice a deleted assertion (ADR-0224's amendment).

1. Each of the three needles matches at least one live site. A needle that silently stops matching
   contributes no region, and every clause behind it is vacuous.
2. SEVEN fragment-assembled region anchors — `fnstart_battle(`, `fnbegin_encounter(`,
   `fnstart_wild_battle(`, `fnrespond_trade(`, `fnbuy(`, `fnchallenge_pvp(`, `fnset_profile_name(`
   (`rb78_region_anchors`, `guards_tests.rs:6415`) — must each fall inside some region, so every
   gate-bearing module contributes at least one region. The needle control cannot see this: `battle.rs`
   alone satisfies all three needles, so a whole other module could stop being fully qualified, drop out
   of the region scan, and take every macro clause for it with it in silence. `accept_challenge` and
   `propose_trade` are deliberately unanchored — this is one anchor per MODULE, and the site SETS belong
   to rb-46 and rb-76.
3. The note clause is ORDERING-ONLY: `guards.rs` carries exactly one raw line beginning
   `// rb-78 (ADR-0248)`, and its line index is strictly between the unique line beginning
   `pub(crate) fn deletion_gate(` and the unique line beginning `pub(crate) fn require_not_deleting(`.
   Both anchors are asserted unique FIRST, so the placement check cannot pass by looking between nothing
   and nothing. No line distance is asserted: a distance would re-red on any legitimate edit to the seam
   above the note.

**Source provenance.** `rb78_live_sources` (`guards_tests.rs:6370`) mixes two compile-time `include_str!`
embeds — `lib.rs` and `guards.rs`, the same ones the sibling rb-76/rb-77 blocks use — with a runtime
`read_to_string` of the other twenty crate-root modules: twenty-two sources, and an unreadable module
PANICS rather than being skipped. The mix is sound because same-crate membership forces a rebuild on any
edit to a file this crate compiles, and rb-76's path-attribute clause keeps the derived roster honest
about which file each declared module maps to. Its one consequence: a STALE test binary run over edited
sources reports on bytes it did not compile, which constrains mutation runners (they must rebuild between
rows), not CI.

**Fixture matrix** `rb78_macro_divert_fixtures_are_rejected_by_clause` (`guards_tests.rs:6620`) —
TWENTY-THREE rows: two clean controls asserted `Ok`, and twenty-one rejecting rows asserted by label
MEMBERSHIP, each written from fragments as its own full text (no shared builder can make the matrix
vacuous), with the expected labels hand-written in the test and produced independently by the collector.

- The two controls carry the matrix. `F0`: the admitted builder above the gate, macros BELOW the gate, a
  macro-laden reducer with no gate at all, `if!(a)`, `!=`, `!seen.insert(`, `use super::*;` in an inline
  test module, and a `'('` char literal — inert to a brace-only counter, and it must stay admitted.
  `F19`: `break !(x)` above a gate, the one keyword exemption reachable from honest code.
- `F1` a statement-position `bail!(ctx);`, the residual's literal shape · `F2` an expression-position
  `let _x = admit!(ctx);`, above the SUBJECT-keyed gate · `F3` an invocation nested inside the admitted
  builder's own argument list · `F4` a brace-delimited invocation · `F5` a square-bracket-delimited one.
- `F6` an in-body `macro_rules!` definition plus its invocation · `F7` a whole-reducer wrapper macro ·
  `F8` a reducer generated from a rule body, which pins that the region reaches INTO a rule body at all ·
  `F9` a path-qualified `std::format!(`, two clauses at once · `F10` a `macro_rules! format` shadow in a
  second, gate-less file.
- `F11` an aliased import `use x::evil as format;` · `F12` a by-name import `use x::format;` · `F13` a
  raw-identifier invocation `r#bail!(`, two clauses at once · `F14` a `#[macro_use] extern crate` pair ·
  `F15` a `'{'` char literal in a gate-bearing file · `F16` a nested block comment · `F17` a
  signature-position `v: ty!()` · `F18` a dependency glob `use game_core::*;`.
- `F20` a builder call glued to a preceding `return` — the disclosed fail-closed false RED of D3,
  asserted so the disclosure is MEASURED rather than promised · `F21` a three-hash raw-string opener ·
  `F22` an unpaired block-comment opener, the row that proves the verdict would otherwise return `Ok(())`
  for a file blanked to its last byte.

No numeric floor stands on twenty-three anywhere in the code (ADR-0224's amendment): the count is prose
here and in the test's own doc comment, and both are to be kept true when a row is added.

**Live mutant register** (ledger gate X5, MANUAL): thirteen compilable mutants applied to the REAL
sources one at a time and restored from byte copies, never via `git checkout`; a non-building mutant
scores INVALID, never KILLED (rb-72's lesson), and KILLED requires the row's own label in the failure
output. `M1` the literal PoC above `start_battle`'s gate · `M2` the same rule DEFINED in `lib.rs` above
the module list and invoked above that gate (rb-77's live test must stay green) · `M3` expression
position above `buy`'s gate · `M4` brace form above `sell`'s gate · `M5` a macro nested in
`start_battle`'s admitted-builder argument through an `$e:expr` parameter, the row the allow-list must
not shelter · `M6` a path-qualified `std::format!(` in `battle.rs` · `M7` `#[macro_use] extern crate
game_core;` in `lib.rs` · `M8` a whole-reducer wrapper around `set_profile_name` · `M9` a
hygiene-correct `$ctx:ident` rule above `challenge_pvp`'s gate · `M10` a `macro_rules! format` shadow
inside `start_battle`'s body · `M11` a divert above `begin_encounter`'s subject gate · `M12` a divert
above `start_wild_battle`'s gate, which the test build never compiles at all (`battle.rs:546` is
`#[cfg(feature = "dev_reducers")]` — precisely the text scan's gain over execution) · `M13`
`use game_core::*;` in `battle.rs`. Three controls must stay GREEN: a pristine BASELINE, `C1` a second
admitted builder call above a gate, `C2` a divert-shaped macro BELOW a gate.

**MEASURED** (`rb-78.red-before.md` §3): the thirteen-row sweep at commit `adfc37c`, with `M7` and `M10`
re-measured at `1286bfa` after each was made to BUILD — `M7` needed `#[allow(unused_imports)]` because
`game-core` exports no macro, and `M10`'s shadow delegates to `::std::format!` because the first spelling
left the reducer's own binding unused under `-D warnings`. Result: **13/13 KILLED, 0 INVALID**,
BASELINE/C1/C2 GREEN, tree clean. TWELVE rows are CI-clean against every pre-existing pin
(`others: none`) and are caught only by the rb-78 live test; `M11` additionally reds rb-76's two
`begin_encounter` tests, which is the measured basis for D1's "two of ten already closed" claim
(`respond_trade`'s rb-47 equality is the same mechanism and was not mutated). Two plan predictions were
measured WRONG and are corrected here rather than dropped: `M10` was predicted to be caught by rb-46
clause I, but a delegating shadow contains no `return`, so clause I stays green and only
`[rb78/format-respelt]` sees it; `M8` was predicted to red other pins and did not — ranking's m22-s3b pin
constrains the gate statement only. Runner and per-row record live in the harness repo
(`rb-78.mutants.py`, `rb-78.red-before.md` under memory/projects/gates), never in this ADR body.

**RED-before, argued.** On a clean tree every macro clause is green BY CONSTRUCTION, so the live test's red
at HEAD is the note clause alone — the rb-77 shape: an ordinary TDD red proving the test runs and reads the
real `guards.rs` (`rb-78.red-before.md` §2, RUN 1: `2 tests run: 1 passed, 1 failed`, the fixture matrix
green). Proof-of-teeth (ADR-0224) is discharged deliberately elsewhere: by the pre-slice measurement in
Context, by RUN 2 of the same record — the §1 PoC re-applied by hand, which moves the red onto the VERDICT
with the label `[rb78/macro-above-gate:battle.rs:rb78_admit]` — and by the X5 register above, all three on
the real sources.

### D5 — The reviewer note is a mid-file `//` block, not a trailing comment

The note is seven lines, `server-module/src/guards.rs:96-102`, sitting between `deletion_gate`'s closing
brace and `require_not_deleting`'s doc block — in the file the wrappers live in, immediately above the
first of them, and outside the doc comment (a doc comment is part of the item it documents). It says
"enclosing item boundary" rather than "reducer prefix", because `begin_encounter` is a crate-private
helper and not a reducer; it says "every bang-macro invocation", because the ban is delimiter-agnostic;
and it names `R-rb-78-PROCMACRO` in its own text, so the reviewer half of the disposition carries the
same limit the machine-checked half discloses. ADR-0247
D5 chose a TRAILING comment on `lib.rs:31` for a reason that does not apply here: four
`docs/knowledge/reducers/*.md` line stamps point into `lib.rs`, so a block above that line forces a bundle
regeneration for prose, whereas no knowledge-bundle line stamp points into `guards.rs` at all — a mid-file
block shifts nothing gated. The text is constrained by its neighbours, not by taste: no double quote (one
census strips strings BEFORE comments, so a quote opens a phantom string); none of rb-77's raw-source
needles, since ADR-0247 D2/D3 counts the conditional-compilation macro, the file-inclusion macro, `r#` and
`#[cfg` on the RAW text of this file; no contiguous block-comment marker; and no contiguous spelling of
the admitted macro, because neighbouring censuses count raw bytes where this slice reads a stripped view.

### D6 — Anti-decisions

- No prefix equality on the other eight sites: ten hand-typed literals, each owed a hand re-derivation
  whenever a legitimate pure check is added above a gate (ADR-0246's recorded limit), and all ten blind to
  the respelling class of D3.
- No crate-wide `macro_rules!` DEFINITION ban: every route that matters passes through a region or through
  `format-respelt`, and a ban would red the first legitimate helper macro in the crate for no reach.
- No `#[cfg` or statement-boundary clause on the gate STATEMENT — rb-79 owns that class for `trading.rs`,
  which ADR-0236's residual bullet names, and deferring a named class to the slice that owns it is the
  ADR-0247 D6 precedent. No pin of the site total at ten either: the rb-46 and rb-76 censuses own the
  gated SETS, and a second count here would be a check on another check.
- No edit to rb-46 clause I, to rb-76's frozen `begin_encounter` prefix or to rb-47's frozen
  `respond_trade` prefix; they stay as written. No numeric fixture floor (ADR-0224's amendment).

## Considered alternatives

- **Compiler-enforced (illegal states unrepresentable)** — ADR-0224's preferred rank. Inapplicable:
  expansion happens before name resolution and type checking, so it precedes every rule a type, trait or
  visibility can express. No type's existence can forbid an expansion above a call.
- **Prefix EQUALITY on all ten sites** (the rb-76 / rb-47 vehicle, generalised) — rejected: ten hand-typed
  literals to maintain, ten re-derivations owed on every legitimate change, and — decisively — equality
  freezes bytes, not meaning, so it is blind to a respelt `format` on exactly the two sites that have it.
- **An AST parse via `syn`** — ADR-0224's escape hatch: a new dependency for a grammar four sibling
  censuses already express in the squashed view, and useless here anyway, because `syn` parses tokens and
  does not EXPAND macros; it would see the same unexpanded invocation this scan sees.
- **`cargo expand` in CI** — a new toolchain in the build graph, and self-defeating: the expansion is
  produced by the very macro the check is meant to catch. **A clippy lint** — none exists, and
  `-D warnings` is already on.
- **Do nothing — reviewer checklist only** (the residual's own disposition in ADR-0236). Rejected on
  ADR-0224's materiality test, not on principle: the defect is MEASURED CI-clean, on a player-data
  authorization gate, with every real client routed around it and only the test harness reaching it —
  player-data security, not a hypothetical refactor. The D5 note keeps the checklist half; the test makes
  it mechanical.
- **A new `evals/*.eval.mjs`** — barred by ADR-0224.

## Consequences and residuals

- Positive: every macro route measured across the plan review, the plan red-team and the artifact
  red-team is refused by a NAMED clause — the twenty-one rejecting fixture rows, and the thirteen X5 rows
  on the real sources — and the note says why to a reader who never runs the tests.
- The bound, restated from ADR-0247 D3: this scan proves what a file SPELLS, not what it expands to. A
  macro reached by a path the clauses admit, or injected by a procedural macro, is outside it. Its reach
  is every PRODUCTION module — the roster is derived from `lib.rs`'s declarations, and the `*tests`
  modules are `cfg(test)` and unscanned.
- **A Cyrillic-confusable macro name needs no clause, and the reason is measured.** Respelling the
  admitted identifier with the Cyrillic U+0430 in place of its Latin `a` is refused by rustc's
  `mixed_script_confusables` lint, denied by the `-D warnings` the lint gate already runs with — so that
  route never reaches a review, let alone a merge. Measured by this slice's artifact red-team; no clause
  is owed for it.
- **`?` is not a bypass route, and nobody should re-open it.** A `?` above the gate can only exit with an
  `Err`, which is a REJECTION — the one early exit rb-46 clause I exists to permit. It cannot route a
  caller into the happy path around the gate, so it needs no clause here.
- Disclosed fail-closed false REDs, each zero on the tree today and loud on the first run; the response
  is to re-derive the rule in a slice that owns an ADR, never to widen a needle:
  - **Keyword glue**, the general form of the `returnformat!(` case and the one F20 measures. The squash
    removes the space between a keyword and what follows it, so the name walked back from a `!` can
    contain the keyword: `return format!(..)` reads `returnformat!(` and is refused because the admitted
    byte sequence must start the name. The exemption list is not a way out of this — it holds whole
    keywords only, so `else if !(x)` reads `elseif!(` and `for x in !(y)` reads `forxin!(`, and both are
    refused as well. The alternative, matching the admitted bytes as a SUFFIX, would admit the builder's
    name wearing any prefix an attacker cares to glue in front of it.
  - The `format!{` and `format![` delimiter forms, which are not allow-listed; a new `assert!`, `vec!` or
    `log::warn!` above a gate; a `'{'` or `'}'` char literal in a gate-bearing file; the two D3 classes
    (a multi-segment in-crate glob, and `format` used as a data identifier); and a `c"…"` / `cr"…"`
    C-string, unknown to the shared stripper (it handles the `"`, `b`, `r` and `br` prefixes) and leaving
    a stray `c` byte — a false RED if it directly precedes the admitted call. That stripper serves other
    gates and is deliberately not modified here.
- **Residual `R-rb-78-PROCMACRO` (backlog):** an attribute or derive procedural macro rewriting a reducer
  body leaves no `macro_rules!`, no `!`-plus-delimiter in the region and no respelt identifier, but needs
  a `Cargo.toml` dependency edit — the `R-rb-77-CARGOSWAP` class: visible in any touches audit, not
  chased per ADR-0224. The D5 note names it.
- **Residual `R-rb-78-PLAINRETURN` (backlog), MEASURED**, by this slice's artifact red-team and confirmed
  independently by the reducer-security auditor: a plain, macro-free
  `if me != crate::WILD_IDENTITY { return Ok(()); }` above `pvp.rs:818` (`challenge_pvp`), `pvp.rs:1004`
  (`accept_challenge`) or `ranking.rs:152` (`set_profile_name`) passes `cargo fmt --check`, clippy with
  `-D warnings` and 901 of 902 tests — the single red being rb-78's own note clause at the time of
  measurement, i.e. nothing that looks at those files. The reason is coverage, not subtlety: those two
  modules carry no per-reducer textual-return census. rb-46 clause I exists for `battle.rs` and
  `economy.rs` only; prefix EQUALITY covers `respond_trade` (rb-47) and `begin_encounter` (rb-76) only;
  and `trading.rs:252` (`propose_trade`) belongs to rb-79. It is deferred under ADR-0224's
  one-named-class-per-slice rule and D6's "no edit to rb-46 clause I" — NOT merely because those files
  are outside this slice's `touches:`. `rb78_region_texts` already computes exactly the regions such a
  census needs; the open design question is which region definition it should use — rb-46's body
  extractor or rb-78's item boundary — and how it admits `respond_trade`'s legitimate `return Ok(())`.
- **Residual `R-rb-78-NESTEDMOD` (backlog):** a `mod nested;` declared INSIDE a rostered production file,
  resolving to `src/pvp/nested.rs`, is invisible to every `lib.rs`-derived census in this crate —
  rb-46's, rb-76's, rb-77's and this one's — because all four map a crate-root declaration to
  `src/<name>.rs` and none recurses. ADR-0246 disclosed the shape as "a class no census in this crate
  covers today" and no slice registered it; it is registered here. The cheapest closure is one level of
  recursion in the roster, or a refusal on a bare `mod` declaration in any rostered file.
- `R-rb-78-GLOBMACRO` is deliberately NOT registered: the glob-import clause of D3 closes the
  `#[macro_export]`-plus-glob route mechanically and at zero live cost, so there is nothing to carry.
- `R-rb-77-CFGROSTER` is unchanged: rb-78 adds macro-spelling clauses only and no target-selection
  discipline to any module, so the crate-wide cfg class that slice names is still owed.
- ADR-0236's disclosed macro residual is discharged; its header gains the reciprocal `**Extended-by:**
  ADR-0248` entry (the rb-77 precedent — one line, no amendment paragraph, because nothing in that ADR's
  text becomes false: it disclosed a residual and a slice has now closed it). The other half of the same
  bullet, the `lib.rs` module swap, was discharged by ADR-0247.
- Accepted friction: a legitimate new macro above a deletion gate must edit the allow-list in the test and
  argue an ADR. That friction is the point.

## Confirmation

Measured at slice close on the committed tree: `cargo nextest run -p monster-realm-module -E
'test(/rb78_/)'` → `2 tests run: 2 passed`; the twenty-three-row fixture matrix green, its twenty-one
rejecting rows each by the clause label it exists to exercise; the live mutant register
(`memory/projects/gates/rb-78.mutants.py`, evidence `memory/projects/gates/rb-78.red-before.md` §3 in the
harness repo) → **13/13 KILLED, 0 INVALID**, the three control rows GREEN, tree clean, twelve of the
thirteen rows CI-clean against every pre-existing pin; the note-clause red-before and its bite-proof
re-application recorded in §2 of the same file; the full server-module suite `902 tests run: 902 passed,
0 skipped`; `cargo fmt --check` and clippy `--all-targets --all-features -- -D warnings` clean; and the
verifier's independent re-derivation of the grammar plus one mutant of its own choosing. The full
`just ci` is recorded as ledger gate X4 (`memory/projects/gates/rb-78.gates.md` in the harness repo, run once on the final tree from the slice worktree). The gating tests are the two `rb78_` tests
in `server-module/src/guards_tests.rs`; the reviewer note they assert lives in
`server-module/src/guards.rs:96-102`.
