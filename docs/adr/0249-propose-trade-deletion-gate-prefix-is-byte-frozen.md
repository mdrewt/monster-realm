# ADR-0249 — Nothing may precede `propose_trade`'s deletion gate: the statement prefix above it is byte-frozen in one ordinary Rust test, and the attribute half of R-rb-46-TRADINGCFG was already rb-47's

**Status:** Accepted
**Date:** 2026-09-12
**Slice:** rb-79 (residual R-rb-46-TRADINGCFG, `M-residual-backlog.spec.md#rb-79`)
**Supersedes:** —
**Amends:** ADR-0237 (rb-47 — narrows its Consequences claim that rb-47 "closed R-rb-46-TRADINGCFG": the attribute and statement-boundary half was closed there; the macro-free early-exit half stayed open and is closed here; reciprocal `Amended-by:` in its header)
**Extends:** ADR-0236 (rb-46 — the residual family; the trading site that clause I never reached; reciprocal `Extended-by:` appended to its header)
**Subsystems:** security-authz, ci-gates
**Decision:** rb-79 byte-freezes the whole statement prefix above `propose_trade`'s deletion gate in one ordinary Rust test (pure verdict, fixture matrix, live mutant register); the attribute half of R-rb-46-TRADINGCFG was already closed by rb-47.

---

## Context and problem statement

rb-46's plan red-team (ADR-0236, 2026-09-04) measured that a `#[cfg(test)]` on the `propose_trade`
deletion-gate statement at `server-module/src/trading.rs:252` passed every m22-s5 pin while the release
wasm shipped ungated, and registered R-rb-46-TRADINGCFG with a three-part remedy: port rb-46's
statement-boundary, `#[`/`cfg!(` and early-exit clauses onto `trading_tests.rs`. The residual was promoted
to rb-79 on 2026-09-11.

**Measured before planning (memory `promoted-residual-may-be-already-closed`): the residual was half
closed and half open.** rb-47 (ADR-0237, PR #429) ported the first two parts —
`rb47_propose_trade_gate_has_no_attribute_or_cfg_escape` (`trading_tests.rs:4731-4820`: the character
before the gate needle is `;` or `}`, zero `#[` and zero `cfg!(` in the reducer body, zero `#![cfg` in the
file) and `rb47_respond_trade_carries_the_offer_age_gate`'s file-wide `#[cfg` == 1 count
(`trading_tests.rs:4549-4560`). Executed at be3ff53 before any rb-79 test existed
(`memory/projects/gates/rb-79.red-before.md` §1, harness repo): `#[cfg(test)]` and
`#[cfg(debug_assertions)]` on the statement are KILLED by those two tests. ADR-0237:202-203 therefore
says rb-47 closed the residual, and ADR-0248 D6 (:286-289) says rb-79 "owns that class" — both are
half-right, and this ADR corrects both (D6 below). The residual row itself was never closed
administratively, which is why the aging rule promoted it.

**What stayed open is the early-exit half, and it is not theoretical.** Seven macro-free predecessors
placed directly above `trading.rs:252` are CI-clean at be3ff53 — `cargo fmt --check` exit 0,
`cargo nextest run -p monster-realm-module` → `902 tests run: 902 passed, 0 skipped`, clippy
`--all-targets --all-features -- -D warnings` exit 0 — with the file restored byte-for-byte after each:

| Row | Predecessor above the gate | Why every pin stays green |
|---|---|---|
| M3 | `if me != crate::WILD_IDENTITY { return Ok(()); }` | the gate STATEMENT is untouched: count 1, depth 0, boundary `;`, both ordering anchors hold |
| M4 | file-scope `const RB79_ENFORCE: bool = cfg!(test);` + `if !RB79_ENFORCE { return Ok(()); }` | rb-47's `cfg!(` ban is body-scoped; rb-78's macro ban runs from the reducer's item boundary, and the const sits above it |
| M5 | file-scope `const RB79_ENFORCE: bool = false;` + the same early `Ok` | no attribute, no macro, no `#[cfg` |
| M6 | `let e = String::new(); return Err(e).or(Ok(()));` behind the sender test | a rejection-looking combinator that evaluates to `Ok` |
| M7 | `let e = String::new(); return Err(e);` behind the sender test | rejection-SHAPED: rb-46's clause I (`battle_tests.rs:6905-6929`, `count(return) == count(returnErr(e);)`) would read 1 == 1 and pass |
| M8 | file-scope `fn open_offer_ungated(..)` + `return open_offer_ungated(ctx);` behind the sender test | rb-46's shape 1 (ADR-0236); a twin named `propose_trade_*` instead is caught, but only as a scan artifact — `m22s5_trading_fn_body` takes the first `fn propose_trade` hit and reads the twin's gate-less body |
| M10 | `let me = crate::WILD_IDENTITY;` | no `return` at all; every later check answers about the wild sentinel |

The mechanism is the one ADR-0236 and ADR-0248 record: `ReducerContext::__dummy()` answers `ctx.sender()`
with the all-zero identity, which is `crate::WILD_IDENTITY` (`lib.rs:89`), so a sender-keyed
predecessor routes every real player around the gate while the native host still reaches it, and every
executed test keeps observing the gate fire. Two controls stayed green as they must: a comment above the
gate, and the same early `Ok` BELOW the gate (a deleting caller never reaches it). ADR-0248 §Residuals
(R-rb-78-PLAINRETURN) assigns exactly this site to this slice: "clause I covers battle.rs/economy.rs,
equality covers respond_trade and begin_encounter, and trading.rs:252 is rb-79's".

## Decision

### D1 — Scope: one call site, one reducer, one file

`trading.rs:252` in `propose_trade`, read from `trading_tests.rs` only. `respond_trade` is already
equality-covered by rb-47 clause F (`trading_tests.rs:4595-4642`); `begin_encounter` by rb-76;
`battle.rs`/`economy.rs` by rb-46 clause I; `pvp.rs:818`, `pvp.rs:1004` and `ranking.rs:152` remain
R-rb-78-PLAINRETURN's (this slice discharges only its `trading.rs:252` share). The spec's remark that
pvp's two sites are "incidentally covered by ranking-security's body-wide `#[cfg` ban" is true of the
ATTRIBUTE class only, not of the early-exit class. `confirm_trade` and `cancel_trade` carry no deletion
gate by decision (ADR-0227 D5, ADR-0237 D5) and therefore have no prefix to freeze.

### D2 — The mechanism: whole-prefix EQUALITY, not a return census

A ported rb-46 clause I is measurably insufficient here: M7 passes it by construction and M10 contains no
`return`. rb-47 clause F's shape is what kills all seven — the squashed, comment-stripped,
string-blanked text between the reducer's opening brace and the gate needle must EQUAL a hand-typed
literal. Four clauses, evaluated by one pure verdict that collects labels and never short-circuits:

- `[rb79/twin]` — the squashed FILE contains the paren-free bytes `fnpropose_trade` exactly once. This
  turns M8a's scan artifact into a designed kill: a declaration twin whose name extends the reducer's
  would otherwise be the body every pin reads.
- `[rb79/extract]` — the brace-bounded body of the first `fn propose_trade` extracts (`m22s5_trading_fn_body`,
  `trading_tests.rs:2877`, re-raised as a LABEL rather than the panic `rb47_body` raises, so the fixture
  matrix can observe it). On failure the verdict pushes the label and skips the two clauses below.
- `[rb79/gate-count]` — the gate needle, in its plain and trailing-comma spellings, occurs exactly once in
  the squashed body. Not one means the prefix slice is meaningless; the verdict pushes the label and
  skips the clause below.
- `[rb79/prefix]` — the squashed prefix above the gate equals the frozen literal byte for byte:
  caller binding, both per-side caps, the caller-joined lookup with its `ok_or_else` rejection, nothing
  else. Kills M3-M8 and M10; incidentally also M1/M2 (an attribute leaves `#[cfg(test)]` in the prefix)
  and M9 (the hoisted gate changes the prefix) — rb-47 and m22-s5 stay the OWNERS of those two claims.

Depth is not re-asserted: the frozen prefix contains zero braces, so equality implies the depth-0 claim
m22-s5 owns (`trading_tests.rs:2984`).

### D3 — Provenance: the literal is derived from the ADRs and tied at runtime, never pasted

The literal is derived from ADR-0166 D3 (both size caps are the reducer's first statements, before any
DB read), ADR-0227 D3/D4 and PRV1-9 (the caller-only gate sits with the caller-state preamble, after the
joined check and before any counterparty read). The diff of that derivation against the squashed HEAD
prefix (239 bytes, zero `return` tokens) is a CHECK recorded in the red-before file, not the source.

Three defences against the "regenerate the pin from the body" tautology (memories
`pin-literal-built-from-needle-helper`, `regenerated-freeze-admits-prefix-early-return`):

- the literal is spelled from `concat!` fragments whose split points differ from every other needle
  helper in the file (m22-s5's `propose_|trade`, `require_not_|deleting(`, `check_trade_|side_size(`,
  `player().identity().|find(me)`; rb-47 clause F's `letme=ctx.sen|der();` family), with its own
  blank-literal constructor rather than `m22s5_blank_string_literal`;
- a RUNTIME TIE asserted on the literal itself with a third set of splits: the cap needle exactly twice,
  the joined-lookup needle exactly once, the sender read exactly once, the caller binding `letme=`
  exactly once, `crate::` zero times, `return` zero times. The last three are what a lockstep
  regeneration carrying M3-M8 (a `return`) or M10 (a `crate::` path) cannot satisfy;
- a RE-DERIVATION CONTRACT in the failure message: a red `[rb79/prefix]` means a statement moved above a
  security gate — re-derive from ADR-0166 D3 / ADR-0227 and re-argue the placement in an ADR; never
  paste the current body in, never relax to `starts_with`/`contains`.

### D4 — Vehicle: one pure verdict, one live test, one fixture matrix, one live register (ADR-0224)

- `rb79_prefix_verdict(file, raw) -> Result<(), String>` — the four clauses over the file's OWN
  strippers (`rb47_stripped`, `rb47_squash`; no third stripper, ADR-0003), zero `unwrap`/`expect`/`panic!`.
- `rb79_propose_trade_admits_no_predecessor_above_its_deletion_gate` — the live test over the real
  `TRADING_RS`: verdict `Ok`, the escrow-insert needle once (proves the body is the shipped reducer), the
  runtime tie, then the NOTE clause of D5 — in that order, so a real violation reports as a labelled
  verdict failure and the weakest claim reports last.
- `rb79_prefix_bypass_fixtures_are_rejected_by_clause` — a fixture matrix assembled from its own
  fragments (never from the expected-prefix helper): a pristine control asserted `Ok`, the measured
  survivors and the anti-vacuity branches each asserted by label MEMBERSHIP, and the M7 row additionally
  PROVING in-crate that rb-46's census passes on its text while `[rb79/prefix]` fires. No numeric row
  floor in code.
- the live register `memory/projects/gates/rb-79.mutants.py` on the REAL file (ledger gate X5).

RED before the fix, per ADR-0224's letter: on a clean tree the equality clause is green BY CONSTRUCTION
(the shipped prefix IS the specified prefix), so the TDD red is the note clause — exactly the ADR-0247 /
ADR-0248 shape — plus the by-hand re-application of the §1 survivors, which must red `[rb79/prefix]`.

No substrate clauses, unlike ADR-0248 D2: for an equality pin every substrate failure is FAIL-CLOSED.
An unpaired `/*` blanks the file and the gate needle with it (`[rb79/gate-count]`/`[rb79/extract]`); a
char-literal polarity flip mis-slices the body (`[rb79/prefix]`, measured by the plan red-team); a
raw-string decoy either desyncs the walker (red) or is swallowed whole and injects nothing (green and
harmless). `trading.rs` carries zero `/*` and zero `r#` today.

### D5 — The reviewer note is an in-place rewrite, not an insertion

Forty `trading.rs:NNN` citations in `docs/` and the harness specs, and three of the six knowledge-bundle
stamps (`#L439`, `#L490`, `#L765`), sit BELOW the gate; two of the citations (ADR-0248's `:252` and
`:468`) are one day old. Inserting lines would manufacture the rb-74 defect class in files this slice
may not edit. So the existing Guard-1a comment block (`trading.rs:248-251`) plus the blank line above it
(`:247`) is rewritten in place — the same line budget in, the same out, no line at or below `:252`
moving; ledger X3 pins all six stamps. Exactly ONE line begins with the marker `// rb-79 (ADR-0249)`;
the live test asserts that count and that the line sits strictly between the unique `pub fn
propose_trade(` line and the unique gate line — ORDERING ONLY, never a line-distance window. Wording:
the four existing claims kept in substance (fully-qualified path, `?;`, post-caps placement, caller-state
preamble); no double quote, no `#[`, no `cfg!`, no comment markers, no `r#`, no apostrophe, and no
contiguous production needle any raw-text scan in the crate reads. Comments are stripped before every
clause, so the note cannot affect the pins it describes.

### D6 — Relationships, and the two corrections

`**Extends:** ADR-0236` (the residual family; reciprocal `Extended-by:` appended). `**Amends:** ADR-0237`
with the reciprocal `**Amended-by:**` header line, because its Consequences (`:202-203`) state that rb-47
closed R-rb-46-TRADINGCFG: it closed the attribute and statement-boundary half, and this ADR closes the
rest. ADR-0248 D6 (`:286-289`) states the converse error — that rb-79 owns the `#[cfg` / statement-boundary
class for `trading.rs` — while the measured M1/M2 rows show rb-47 already owns it; that sentence is in
an ADR outside this slice's docs scope and is registered as R-rb-79-ADR0248D6 rather than edited here.

### D7 — Anti-decisions (each measured or argued, not assumed)

- **No file-wide `cfg!` ban** (cut at plan review by the `/simplify` lens): M4's `cfg!(test)`-valued const
  dies to `[rb79/prefix]` through its consumer; a `cfg!` const consumed BELOW the gate cannot route a
  caller around `:252`; the `return`-zero tie already closes the refrozen-prefix route; and the first
  legitimate `cfg!` anywhere in `trading.rs` would red a pin that owns `propose_trade`'s prefix.
  rb-47's body-scoped ban and rb-78's region-scoped ban own the in-body and above-the-gate spellings.
- **No port of rb-46 clause I** — measured weaker (M7, M10); a second census on a region equality already
  covers would be a check on another check. **No edit** to clause I, to rb-76's or rb-47's frozen
  prefixes, to the m22-s5 pins or to rb-47's tests (gating tests are never boyscout targets).
- **No duplicate of the reducer-roster pin.** The plan red-team measured a wire-name rename — an ungated
  `#[spacetimedb::reducer(name = ..)] pub fn open_a_trade(..)` twin with `fn propose_trade` demoted to a
  dead gated function — GREEN on every rb-79 clause by design and KILLED by
  `rb47_trading_reducer_roster_is_closed` (`trading_tests.rs:5200`) plus the m22-s5 gated-reducer censuses
  in `guards_tests.rs`. That dependency is disclosed in the live test's doc comment and MEASURED as
  register row M13 rather than re-pinned here.
- **No pin on `pvp.rs`/`ranking.rs`** (R-rb-78-PLAINRETURN; one named class per slice, ADR-0224).
  **No new eval, no clause on an existing eval, no second ADR number, no numeric fixture floor.**

## Considered alternatives

- **Compiler-enforced** — impossible: a legal statement above a legal call is exactly what Rust permits.
- **A ported return census** (rb-46 clause I) — measured insufficient (M7, M10).
- **`syn` / `cargo expand`** — bespoke tooling ADR-0224 retired as the default, and neither sees intent.
- **Reviewer checklist only** — rejected on ADR-0224's materiality test: seven measured CI-clean routes
  around a player-data authorization gate is a mechanical class.
- **A new `evals/*.eval.mjs`** — barred by ADR-0224.

## Consequences

- The bound: a source scan of one prefix proves what the file SPELLS above the gate, not what runs.
  Classes already owned elsewhere and out of scope here: a predecessor BELOW the gate (control C2;
  m22-s5's gate-before-insert ordering), a macro in the prefix (ADR-0248), an attribute on the statement
  or a `#[cfg` anywhere in the file (rb-47), a `lib.rs` module swap (ADR-0247), R-rb-78-NESTEDMOD,
  R-rb-78-PROCMACRO (a proc-macro attribute could inject a return into the compiled body while the
  source stays frozen — needs a manifest edit, the CARGOSWAP class), R-rb-77-CFGROSTER.
- Inherent to every frozen pin in this crate, reviewer-checklist class under ADR-0224: a lockstep edit
  of the literal in the test AND the body in the source is visible only in the PR diff, and editing a
  gating test to fit a change is what the split-ownership rule forbids.
- Accepted friction: a new statement above this gate must re-derive the literal and argue an ADR.
- Residual registered: **R-rb-79-ADR0248D6** (backlog, LOW — the stale attribution sentence at
  ADR-0248 `:286-289`).
- Touches beyond the declared `trading.rs` + `trading_tests.rs`: this ADR; one reciprocal header line
  each in `docs/adr/0236-*.md` and `docs/adr/0237-*.md`; the generated `docs/adr/DIGEST.md`; one
  `ARCHITECTURE.md` paragraph; the harness-side ledger, plan memo, red-before record and register runner.
  The X5 sweep mutates `trading.rs` transiently and it is byte-identical at merge.

## Confirmation

Measured at slice close and recorded in `memory/projects/gates/rb-79.red-before.md` §2-§3 (harness
repo): the filtered run `2 tests run: 2 passed`; the full module suite `904 tests run: 904 passed,
0 skipped`; fmt and clippy clean; the live register's per-row designated-test record (every M-row KILLED
by its named clause, M13 by the rb-47 roster pin, zero INVALID, every control GREEN, tree restored);
`just ci` green via ledger X4. The runner and the record live in the harness repo, never in this ADR.
