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

### D2 — The grammar: one pure verdict over the squashed view of every rostered module

`rb78_macro_verdict(sources: &[(String, String)]) -> Result<(), String>` in `guards_tests.rs` is a
non-short-circuiting label collector (the rb-77 shape) over the comments-stripped, strings-blanked,
squashed view `rb76_module_squashed` (`guards_tests.rs:3317`) already produces — no third stripper
(ADR-0003, the harness design decision that a rule is spelled once).

**Region.** For each needle occurrence, from the last bracket-depth-0 item boundary (`;` or `}`, or start
of file) before it, up to the needle — so it holds the reducer's attributes, signature and whole body
prefix, and a whole-function wrapper macro and a macro-GENERATED function both put their own `ident!(` /
`ident!{` INSIDE it without needing a clause of their own. **Depth** counts braces only; a `(` or `[`
char literal is inert to a brace counter and cannot form a `!`-plus-delimiter pair, which is why the
char-literal ban below is exactly rb-46 clause 0c's set.

**Clauses** — the verdict collects all of them, never the first:

- `[rb78/scan-substrate:<file>]` — a block-comment close marker surviving the strip means a NESTED block
  comment, which the byte-sequential stripper cannot model; the file is refused rather than scanned wrong
  (the check `guards.rs` has had since 11r-c), on every scanned file and every fixture.
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
  `[rb78/glob-import:<file>]` — the four crate-wide clauses of D3.

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
banning every respelling of it are ONE decision. The shadow routes and their closures, each measured at
zero occurrences today:

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

### D4 — Vehicle: the pure verdict, one live test, one fixture matrix, one live mutant register

**Live test** `rb78_no_macro_expands_above_any_deletion_gate`: the verdict is `Ok` over the real
`include_str!` sources; each of the three needles matches at least one live site (a needle that silently
stops matching is a no-op); every gate-bearing module contributes at least one site (`battle.rs`,
`economy.rs`, `pvp.rs`, `ranking.rs`, `trading.rs`); and the D5 note exists exactly once, as a raw line
beginning `// rb-78 (ADR-0248)` within twelve lines above the unique line beginning
`pub(crate) fn require_not_deleting(`. These are positive controls, not floors: nothing is pinned whose
only job is to notice a deleted assertion (ADR-0224's amendment).

**Fixture matrix** `rb78_macro_divert_fixtures_are_rejected_by_clause` — eighteen frozen inputs, each
written from fragments as its own full text (no shared builder can make the matrix vacuous) and asserted
by label MEMBERSHIP:

- `F0` the clean control: an allow-listed `format!(` above the gate, macros BELOW the gate, a macro-laden
  reducer with no gate at all, and the near-misses `if!(a)`, `!=`, `!seen.insert(` — must be `Ok`.
- `F1` a statement-position `bail!(ctx);`, the residual's literal shape · `F2` an expression-position
  `let _x=admit!(ctx);` · `F3` an invocation nested inside the allowed `format!(..)` argument · `F4` a
  brace-delimited invocation · `F5` a square-bracket-delimited one.
- `F6` an in-body `macro_rules!` definition · `F7` a whole-function wrapper around the gated reducer ·
  `F8` a reducer GENERATED by a macro, gate and all · `F9` a path-qualified `std::format!(` · `F10` a
  `macro_rules!format{` shadow in another rostered module.
- `F11` an aliased import `use x as format;` · `F12` a plain import `use x::format;` · `F13` a
  raw-identifier invocation `r#bail!(` · `F14` a `#[macro_use]` attribute · `F15` a bracket char literal
  in a gate-bearing file · `F16` a nested block comment · `F17` a signature-position `ty!()`.

**Live mutant register** (ledger gate X5, MANUAL): compilable mutants applied to the REAL sources one at a
time and restored from byte copies, never via `git checkout`; a non-building mutant scores INVALID, never
KILLED (rb-72's lesson), and KILLED requires the row's own label in the failure output. Honest about which
rows the tree already catches: `M1` the literal PoC above `start_battle`'s gate (CI-clean, MEASURED before
the slice) · `M2` the same macro DEFINED in `lib.rs` above `mod battle;`, invoked above that gate
(CI-clean; rb-77's live test must stay green) · `M3` expression position above `buy`'s gate (CI-clean) ·
`M4` brace form above `sell`'s gate (CI-clean) · `M5` a macro nested in `start_battle`'s `format!`
argument through an `$e:expr` parameter (CI-clean — the row the allow-list must not shelter) · `M6` a
path-qualified `std::format!(` in `battle.rs` (prophylactic; proves `format-respelt` on the real tree) ·
`M7` `#[macro_use] extern crate game_core;` in `lib.rs` (prophylactic) · `M8` a whole-function wrapper
around `set_profile_name` (whichever other pins also red is reported, not hidden) · `M9` a
hygiene-correct `$ctx:ident` macro above `challenge_pvp`'s gate (CI-clean — `pvp.rs` has no per-reducer
prefix scan) · `M10` a `macro_rules! format` shadow inside `start_battle`'s body (NOT CI-clean — rb-46
clause I sees the textual `return`; defence in depth) · `M11` a macro above `begin_encounter`'s gate (NOT
CI-clean — rb-76's frozen prefix reds it; the row that MEASURES the "two of ten already closed" claim) ·
`M12` a macro above `start_wild_battle`'s gate (CI-clean and never compiled by the test build at all —
`battle.rs:546` is `#[cfg(feature = "dev_reducers")]`, precisely the text scan's gain over execution) ·
`M13` `use game_core::*;` in `battle.rs` (prophylactic). Three controls must stay GREEN: a pristine
BASELINE, `C1` a second allow-listed `format!(` above a gate, `C2` a bail-style macro BELOW a gate. Runner
and per-row record live in the harness repo (`rb-78.mutants.py`, `rb-78.red-before.md` under
memory/projects/gates), never in this ADR body.

**RED-before, argued.** On a clean tree every macro clause is green BY CONSTRUCTION, so the live test's red
at HEAD is the note clause alone — the rb-77 shape: an ordinary TDD red proving the test runs and reads the
real `guards.rs`. Proof-of-teeth (ADR-0224) is discharged deliberately elsewhere: by X5 row `M1` and by the
pre-slice measurement in Context, both on the real sources.

### D5 — The reviewer note is a mid-file `//` block, not a trailing comment

The note sits between `deletion_gate`'s closing brace and `require_not_deleting`'s doc block in
`server-module/src/guards.rs` — in the file the wrappers live in, immediately above the wrapper the
residual is about, and outside the doc comment (a doc comment is part of the item it documents). ADR-0247
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

- Positive: every macro route measured across the plan review and its red-team is refused by a NAMED
  clause — the seventeen rejecting fixture rows, and the X5 rows on the real sources, measured at slice
  close — and the note says why to a reader who never runs the tests.
- The bound, restated from ADR-0247 D3: this scan proves what a file SPELLS, not what it expands to. A
  macro reached by a path the clauses admit, or injected by a procedural macro, is outside it.
- **`?` is not a bypass route, and nobody should re-open it.** A `?` above the gate can only exit with an
  `Err`, which is a REJECTION — the one early exit rb-46 clause I exists to permit. It cannot route a
  caller into the happy path around the gate, so it needs no clause here.
- Disclosed fail-closed false REDs, each loud on the first run; the response is to re-derive the rule in a
  slice that owns an ADR, never to widen a needle: `returnformat!(` glue (squashing puts an identifier byte
  before `format`, so the admission does not apply); the `format!{` and `format![` delimiter forms, not
  allow-listed; a new `assert!`, `vec!` or `log::warn!` above a gate; a `'{'` or `'}'` char literal in a
  gate-bearing file; and a `c"…"` / `cr"…"` C-string, unknown to the shared stripper (it handles the `"`,
  `b`, `r` and `br` prefixes) and leaving a stray `c` byte — a false RED if it directly precedes the
  admitted call. That stripper serves other gates and is deliberately not modified here.
- **Residual `R-rb-78-PROCMACRO` (backlog):** an attribute or derive procedural macro rewriting a reducer
  body leaves no `macro_rules!`, no `!`-plus-delimiter in the region and no respelt identifier, but needs
  a `Cargo.toml` dependency edit — the `R-rb-77-CARGOSWAP` class: visible in any touches audit, not
  chased per ADR-0224.
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

Measured at slice close on the committed tree: (filled at close — filtered nextest count, matrix rows, X5
result, full suite count, `just ci`). The gating tests are the two `rb78_` tests in
`server-module/src/guards_tests.rs`; the reviewer note they assert lives in `server-module/src/guards.rs`.
