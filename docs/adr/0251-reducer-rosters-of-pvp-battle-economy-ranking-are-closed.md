# ADR-0251 — The reducer rosters of `pvp.rs`, `battle.rs`, `economy.rs` and `ranking.rs` are pinned closed by one ordinary Rust test each; a new entry point in any of them is a loud test failure naming the file, not a silent addition

**Status:** Accepted
**Date:** 2026-09-12
**Slice:** rb-81 (residual R-rb-47-ROSTER-PVP, `M-residual-backlog.spec.md#rb-81`)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0237 (rb-47 — the closed roster it wrote for `trading.rs` is the shape this ADR carries into the four other files that own two-player reducers; reciprocal `Extended-by:` appended to its header, and its R-rb-47-ROSTER-PVP residual bullet is discharged by a dated amendment there)
**Subsystems:** security-authz, ci-gates
**Decision:** rb-81 pins the reducer rosters of pvp.rs, battle.rs, economy.rs and ranking.rs closed with one ordinary Rust test each — name set, attribute partition, substrate preconditions, tail and cfg pins — and edits no production file.

---

## Context and problem statement

rb-47's artifact red-team measured survivor A4: `respond_trade_v1`, a byte-identical copy of `respond_trade` minus its
offer-age gate, published alongside it in `trading.rs`. Every existing census passed — the m22-s5 gated-set and
already-open censuses in `guards_tests.rs` constrain only the names they enumerate, and `evals/trade-reducer-security`
checks a hard-coded name list — because none of them asks the only question that sees a NEW reducer: *what is the
complete set of reducers this file declares?* rb-47 answered it for `trading.rs` with
`rb47_trading_reducer_roster_is_closed` (ADR-0237) and registered the same gap for `pvp.rs`, `battle.rs`, `economy.rs`
and `ranking.rs` as R-rb-47-ROSTER-PVP.

The seeded criterion (immutable): WHEN a reducer file other than `trading.rs` gains a new `#[spacetimedb::reducer]`
THE SYSTEM SHALL fail a closed-roster test naming the file.

**Measured before planning, on the pristine tree at 1850d35** (harness `memory/projects/gates/rb-81.red-before.md`
§1): a plain bare twin reducer inserted above the test-module tail of `pvp.rs`, `battle.rs` and `economy.rs` passed the
full default suite — `915 tests run: 915 passed, 0 skipped` — three times over; only `ranking.rs`'s twin was caught, and
only by `pvp_tests.rs::m17a_rl7_server_ranking_module_invariants`, a cross-file COUNT of the attribute prefix, which
sees neither a rename nor any of the aliased, wire-named or neighbouring-macro spellings measured below. The gap was
also confirmed from both code graphs: the twelve roster/census symbols in the crate read `trading.rs`, `raising.rs`,
`npc.rs`, `taming.rs`, `accounts.rs`, `evolution.rs` and `privacy.rs`; none reads these four files.

## Decision

### D1 — Four per-file tests, not one parametrized test

`rb81_pvp_reducer_roster_is_closed` (`pvp_tests.rs`), `rb81_battle_reducer_roster_is_closed` (`battle_tests.rs`),
`rb81_economy_reducer_roster_is_closed` (`economy_tests.rs`) and `rb81_ranking_reducer_roster_is_closed`
(`ranking_tests.rs`). The criterion says the failure names the FILE: with one test per file the test NAME names it before
any message is read, whereas a parametrized loop stops at its first failing row and names only that one. Each test file
already reads its own module source, and each file's strippers have their own blind spots (ADR-0003: copied per module,
never shared); a single test would have to carry the union of four substrate hazards through one pipeline. rb-47 and
rb-80 set the same per-file precedent.

### D2 — Zero production edits; a hardening pin whose teeth are a mutant register

The four production files are byte-identical to `origin/master` (ledger X4 pins it, together with all eighteen
knowledge-bundle stamps into them). Eighteen stamps and seven source-reading test files ripple from a single inserted
byte, so the rb-79 zero-line-shift note was not repeated here. The tests are therefore GREEN at HEAD by construction —
what ADR-0224 calls a hardening pin — and their proof-of-teeth is the T0 record above plus the live mutant register on
the REAL files (X6, `rb-81.mutants.py`) and an AUTOMATED four-row twin register the supervisor re-executes at merge (X8):
a plain twin in each file must be KILLED by that file's test on its `[rb81/roster]` clause with the tree byte-restored.

### D3 — The clause set, in order, and what each one is for

(TO BE COMPLETED by the doc-keeper from the shipped tests: substrate P1–P5 → tail → cfg-roster → roster + loud parse →
attr-any → attr-path → attribute partition (per-kind equality + total) → mod census → include/macro bans → raw attribute
count. Cite the measured HEAD numbers and the register rows each clause kills.)

### D4 — Why an attribute PARTITION and not a `reducer`-token census or a bare total

(TO BE COMPLETED: `procedure` and `view` are re-exported attribute macros of `spacetimedb 2.8.1` that carry no
`reducer` token and need no `use` line; `pvp.rs` declares a parameter named `reducer`; a bare total is nettable by a
kind swap; the partition's brittleness is a deliberate re-review.)

### D5 — Honest limits

(TO BE COMPLETED: cross-file macro; a twin in a NEW module file; ranking.rs's pre-existing count cover; rosters are text;
the table-visibility flip; the harness spec citation drift.)

### D6 — Residuals registered

(TO BE COMPLETED after the lenses.)

## Consequences

(TO BE COMPLETED.)
