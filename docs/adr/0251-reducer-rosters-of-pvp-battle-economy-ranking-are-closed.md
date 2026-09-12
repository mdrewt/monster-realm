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
`npc.rs`, `taming.rs`, `accounts.rs`, `evolution.rs` and `privacy.rs`; none of them is a closed ROSTER over these four — the only census reading one of them is the
cross-file attribute COUNT in `pvp_tests.rs` over `ranking.rs` (D5), beside the m22-s5 / rb-46 censuses that constrain
only the names they enumerate.

## Decision

### D1 — Four per-file tests, not one parametrized test

`rb81_pvp_reducer_roster_is_closed` (`pvp_tests.rs`), `rb81_battle_reducer_roster_is_closed` (`battle_tests.rs`),
`rb81_economy_reducer_roster_is_closed` (`economy_tests.rs`) and `rb81_ranking_reducer_roster_is_closed`
(`ranking_tests.rs`). The criterion says the failure names the FILE: with one test per file the test NAME names it before
any message is read, whereas a parametrized loop stops at its first failing row and names only that one. Each test file
already reads its own module source, and each file's strippers have their own blind spots (ADR-0003: copied per module — the seven new scan helpers too, so a correction to any of them lands in all four files in the same edit;
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

Ten clauses per test, in ONE order in all four files. Every assert message carries its `[rb81/<clause>]` label first
and, for a numeric pin, found-vs-expected per kind. The order is load-bearing: the substrate preconditions run before
any stripper output is read; the semantic roster fires before the exotic-spelling closures, so a plain twin fails by
NAMING the twin rather than by an attribute-budget arithmetic error; and the only stripper-free clause is LAST, so
every register row's designated clause is the meaningful one.

1. **`[rb81/substrate]` — five preconditions, the first four read on the RAW source, before any clause below trusts a
   stripped view.** P1: block-comment opener
   and closer counts are both ZERO (measured 0/0 in all four). P2: the double-quote CHAR literal occurs ZERO times, in
   BOTH its three-byte and its backslash-escaped four-byte spelling. P3: raw-string openers (`r`/`br`, any hashes, then
   the quote byte) not preceded by an identifier byte are ZERO. P4: every contiguous run of full-line `//` comments and
   every trailing `//` comment carries an EVEN double-quote count (measured: 0 odd regions out of 108 / 122 / 27 / 22).
   P5: the two stripper orders — comments→strings and strings→comments, each file's OWN two strippers, squashed — are
   byte-EQUAL; `ranking_tests.rs` additionally asserts P5b, that the view it composes equals what `stripped_for_scan`
   (`ranking_tests.rs:238`) returns, an identity by construction today and therefore a DRIFT ALARM for the file's
   shared pipeline rather than a second measurement. P1/P4 kill the plan red-team's three polarity attacks H1/H2/H3
   (register rows M21, M22, M23), measured CI-clean against faithful Python ports of all four stripper pairs; P3 kills
   the rb-80 verifier's raw-string shape (M26); P2 kills the artifact red-team's F1/F2 (rows M29a-d and M29e), which
   were MEASURED fmt-clean at 919/919 before this clause counted the escaped spelling — none of the four string
   strippers has a char-literal branch, so the quote byte between the ticks opens a phantom string and inverts
   string/code polarity for the rest of the file, hiding a bare twin in `pvp.rs`/`battle.rs` and, in `ranking.rs`, a
   by-name-imported attribute twin that also evaded the pre-existing cross-file count. Two candidate preconditions were
   REJECTED because they are false at HEAD, not because they are weak: "every double quote lives outside comments" (the
   rb-80 `taming.rs` precondition) is unsatisfiable here — `ranking.rs:134`, `:167`, `:168`, `:258` put quotes in
   comments — and line-count preservation under string blanking does not hold either (`pvp.rs` and `ranking.rs` each
   lose one newline).
2. **`[rb81/tail]`** — the comment-stripped, strings-INTACT squashed view ENDS with the exact tail literal:
   conditional-test attribute, then the relocation attribute naming `<file>_tests.rs`, then the module declaration
   (`economy.rs` additionally carries an `allow(unused_imports)` attribute between them). It must read the
   strings-intact view because the stripped view blanks the relocation attribute's payload. This is the non-vacuity
   guard (it replaces a source-length floor) AND the relocation guard: an always-true conditional plus a retargeted
   path compiles the test module out of a different file, leaving every clause below reading source nobody ships
   (row M24, scored on the full suite: the `pvp` tests vanish and the run reports 586). Anything appended after the
   tail lands here too (row M24b).
3. **`[rb81/cfg-roster]`** — the ORDERED list of conditional-compilation predicates on the same view, read by a
   paren-depth walk so a nested predicate cannot truncate one: `pvp` [test], `economy` [test], `ranking` [test],
   `battle` [dev-feature ×4 at `:40`/`:42`/`:44`/`:546`, then test]. It makes the roster's build-visibility claim
   true — relaxing `battle.rs:546` publishes a dev-only entry point in the default build while the TEXT roster stays
   byte-identical (row M25) — and it catches a twin hidden behind a test predicate (rows M2a-d). `battle.rs` carries a
   SECOND, binding clause: the dev predicate immediately above `start_wild_battle`'s reducer attribute and its public
   declaration, exactly once. The second tester lens measured why a list alone is not enough: a list is a MULTISET that
   says how many dev gates exist, not what they gate, and four decoy dev-gated constants plus an un-gated
   `start_wild_battle` keep it identical (row M31).
4. **`[rb81/roster]`** — on the stripped+squashed view, in this internal order: the WALK, then the count, then the SET.
   The walk resolves the function name after every bare reducer attribute and PANICS `[rb81/roster-parse]` if the
   attribute is not followed by a public declaration with an argument list, so an attribute it cannot parse is a loud
   failure and never a skip (row M16, a `pub(crate) fn` twin). The count is 7 / 6 / 2 / 1 and is reported BEFORE the
   set because it is not implied by it: a twin resolving to an existing name leaves the set equal. The set is
   {`challenge_pvp`, `accept_challenge`, `decline_challenge`, `cancel_challenge`, `submit_pvp_action`,
   `battle_challenge_reaper`, `pvp_deadline_reaper`} / {`start_battle`, `start_wild_battle`, `submit_attack`,
   `swap_active`, `flee`, `use_battle_item`} / {`buy`, `sell`} / {`set_profile_name`}, compared as a `BTreeSet` with
   missing and UNEXPECTED reported separately. Kills the plain twin in each file (rows M1a-d), a deleted attribute in
   each file (M17a-d, the missing direction), a rename that holds the count still (M18, `flee` → `flee_v2`), an in-file
   macro that emits a literal attribute (M14), a reworded comment paired with a real twin (M20), a spaced `# [`
   attribute opener (M30, the artifact red-team's F3 — squashing closes the gap), and the wire-name twin that demotes
   the real function (M3).
5. **`[rb81/attr-any]`** — the attribute PREFIX count equals the bare count. This is the clause for the wire-name twin
   that leaves the roster whole: an attribute parameterised with a wire name publishes a reducer under the name clients
   call while the Rust item every other pin reads is a different, possibly ungated one (row M3b, count and set
   unchanged).
6. **`[rb81/attr-path]`** — the `::reducer` token count equals the bare count. Every bare attribute contains that
   token, so the count can only ever be GREATER; equality asserts the macro is reached NOWHERE else — not by a
   by-name import, not through an aliased crate path, not through a leading-colons path, not through a conditional
   attribute expanding to it (rows M4, M5, M8, M15).
7. **`[rb81/attr-partition]`** — on the stripped+squashed view, EACH kind's count equals its pin AND the total
   attribute-opener count equals the sum of the pinned kinds, so the unknown-kind bucket is ZERO: `pvp` 16 = reducer 7
   + table 2 + primary_key 2 + auto_inc 2 + index 1 + cfg 1 + path 1; `battle` 12 = reducer 6 + cfg 5 + path 1;
   `economy` 5 = reducer 2 + cfg 1 + path 1 + allow 1; `ranking` 3 = reducer 1 + cfg 1 + path 1. This is the only
   clause that sees an entry point spelled some other way: a braced rename import (M6), a glob import (M7), a
   neighbouring entry-point macro (M9), a relocated submodule carrying a twin (M11), and the net-zero kind swap (M19).
   The failure message carries the re-review contract: add the attribute deliberately, then bump this kind's pin and
   the total in the SAME edit; never relax a number alone.
8. **`[rb81/mod-census]`** — an identifier-boundary count of the module keyword equals ONE on the stripped view, NOT
   the squashed one (squashing glues the keyword to its neighbours; the plan reviewer measured this). A second declaration
   moves a twin into a file no clause here reads, with or without a relocation attribute (row M12), and a shadowing
   module re-exporting the attribute macro under another name would otherwise beat clause 6.
9. **`[rb81/include-ban]` and `[rb81/macro-ban]`** — on the stripped view, the substring `include` occurs ZERO times
   (any spelling — source inlining splices another file's tokens into this module at compile time) and `macro_rules`
   ZERO times (rows M13, M28, M27). A rule defined in ANOTHER module and invoked here is outside this file's window:
   R-rb-81-CROSSFILEMACRO.
10. **`[rb81/attr-raw]`** — the RAW text carries 17 / 13 / 5 / 4 attribute openers, an opener being a hash whose next
    NON-WHITESPACE byte is the bracket (so the spaced spelling counts and the census does not lean on the formatter
    gate). LAST, and the only clause reading no stripper output, so it still bites if the strippers are ever fooled.
    The delta over each partition total is the ONE comment-borne opener at `pvp.rs:1386`, `battle.rs:1604` and
    `ranking.rs:222`; `economy.rs` has none, so its raw pin equals its partition total (D5).

Three clauses the `/simplify` pass CUT: an exact import-list literal (every alias spelling already reds clauses 6 and
7, while an import-list pin would be a re-review on every import edit), a source-length vacuity floor (subsumed by
clause 2), and an exact pin on the comment lines that carry the raw-count delta (an over-pin on prose).

### D4 — Why an attribute PARTITION and not a `reducer`-token census or a bare total

`spacetimedb 2.8.1` re-exports seven attribute macros — `duration` (`lib.rs:71`), `client_visibility_filter` (`:109`),
`settings` (`:133`), `table` (`:462`), `reducer` (`:712`), `procedure` (`:783`), `view` (`:917`). `procedure` and
`view` publish module-level entry points, carry no `reducer` token anywhere in their spelling, and need no `use` line,
so a token census and clause 6 alike read ZERO on them; only an exhaustive per-kind partition with a zero unknown
bucket sees them (rows M9, M19). A bare `reducer`-token census was rejected for a second, measured reason:
`pvp.rs:252` declares a PARAMETER named `reducer`, used at `:260`, `:265`, `:270` and `:281`, so such a census would
pin a parameter name and drift on any rename of it. A bare TOTAL is rejected because it is nettable: M19 deletes one
`auto_inc` attribute and adds a neighbouring-macro twin, leaving the total unmoved while per-kind equality fires.

The partition's brittleness is deliberate, and the register carries it as two CONTROL rows rather than hiding it: a
comment that merely spells an attribute opener reds clause 10 alone (row D1), and a newly added `allow(dead_code)`
attribute reds clause 7 (row D2). Both are INTENDED re-reviews of a security census, which is why the failure message
names the remedy (bump the kind and the total together) instead of inviting a relaxation.

### D5 — Honest limits

- **A rule defined in another module and invoked in a censused file** has no file-local window: R-rb-81-CROSSFILEMACRO.
- **A twin in a NEW module file** (`src/twin.rs` plus a declaration in `lib.rs`) is invisible to all four tests and to
  the derived `rb47_scanned_module_names`. Not built here; folded into R-rb-80-CRATEWIDEBARE together with the eight un-rostered reducer files — `accounts.rs` 6, `lib.rs` 4, `evolution.rs` 1,
  `monster_mgmt.rs` 2, `movement.rs` 5, `observability.rs` 1, `playtest.rs` 1, `privacy.rs` 2 — four of which that
  residual already names by reducer (`movement`, `evolution`, `monster_mgmt`, `privacy`; ADR-0250 D6); the file-level
  roster is derived here.
- **The four string strippers have no char-literal branch.** P2 bans the only two spellings that carry a quote byte
  between ticks; the durable fix is a char-literal branch in each stripper: R-rb-81-CHARLITERAL.
- **P4 takes the first `//` on a code line**, so a `//` sequence inside a string literal can false-RED it. Fail-closed
  and disclosed in the clause's own message.
- **Clause 6 counts a SUBSTRING.** A future `crate::reducers::` path in one of these files would false-RED it.
- **`economy.rs`'s raw-opener pin equals its partition total**, because no comment there spells an opener — so unlike
  its three siblings it carries no independent teeth beyond the comment-decoy class.
- **Flipping a table from private to `public` moves no clause.** Out of the seeded criterion's scope, registered as
  R-rb-81-TABLEPUBLIC.
- **These rosters are TEXT.** They are what the four files SPELL, not the reducer table the compiled wasm publishes.
- **`ranking.rs` was not uncovered before this slice**, unlike its three siblings: `m17a_rl7_server_ranking_module_invariants`
  (`pvp_tests.rs:1260-1271`) counts the attribute prefix cross-file. That is a COUNT, never a set, and rows M6, M9, M29d and M29e are the register rows only
  `rb81_ranking_reducer_roster_is_closed` kills.
- **The reciprocal header line this ADR adds to ADR-0237 shifts every citation below it by one.**
  `ARCHITECTURE.md:2279`'s `ADR-0237:203-204` and ADR-0249's two copies of the same citation (its own `:29` and
  `:160`) are repointed to `:204-205` in this slice (docs companions, listed under touches-delta). One carrier is NOT
  edited and is measured, not assumed: the harness spec
  `specs/monster-realm-v2/M-postgate-nineteenth-review-residuals.spec.md:128` cites `ADR-0237:108` (supervisor-owned
  corpus — R-rb-81-SPECCITE). No gate cites ADR-0237 by line.

### D6 — Residuals registered, and the proof-of-teeth

- **R-rb-81-CROSSFILEMACRO (MED)** — a rule defined in another module, invoked in one of these four files, publishes an
  entry point every literal needle here counts as zero; the macro ban is file-local.
- **R-rb-81-CHARLITERAL (MED)** — the four string strippers model no char literal; P2 bans the two dangerous spellings
  instead of parsing them.
- **R-rb-81-TABLEPUBLIC (LOW)** — a private-to-`public` table flip moves no clause in these tests.
- **R-rb-81-SPECCITE (LOW)** — the harness spec's `ADR-0237:108` citation drifts by one with this slice's reciprocal
  header line and is not edited (D5).
- **R-rb-80-CRATEWIDEBARE (MED, inherited and widened)** — these four files now carry a roster; the eight reducer-bearing files listed in D5 still carry none, and a twin in a NEW module file is invisible to every per-file
  census in the crate.

Proof-of-teeth on the REAL files is the ledger's X6 live mutant register (`memory/projects/gates/rb-81.mutants.py`,
record in `memory/projects/gates/rb-81.red-before.md`), which byte-restores every file and verifies its SHA after each
row, scores a non-building row INVALID rather than KILLED, and requires each row's designated TEST to fail on its
designated clause LABEL: at `04e807f` (the hardened tests) 52 of 52 rows matched their expectation — 45 M-rows KILLED on their designated label (M10, the neighbouring-macro `view` twin, was INVALID on the first pass under an illegal signature and KILLED on `[rb81/attr-partition]` once re-run with a legal `Vec<u32>` return), M24 KILLED-BY-COUNT (suite 919 → 586), C1-C4 GREEN, D1/D2 RED-DISCLOSED, the tree byte-identical after every row (`rb-81.red-before.md` §4). Against the pre-hardening tests at `cfdea94` the same register scored
40 of 41 rows as expected; the one that did not was M10, the neighbouring-macro `view` twin, recorded INVALID because a
view declaration must be public — the honest record of an invalid mutant, not a survivor. Ledger X8 re-executes the
four plain-twin rows automatically at merge, which is the machine-verified tooth four stub tests could not fake.

## Consequences

- Three of these four files had NO roster cover at all (T0: 915/915 three times over) and the fourth had a cross-file
  COUNT; all four now fail a test whose NAME is the file, on a new entry point in any spelling D3 enumerates. The
  default suite moves 915 → 919.
- ZERO production edits: `pvp.rs`, `battle.rs`, `economy.rs` and `ranking.rs` stay byte-identical to `origin/master`,
  so the eighteen knowledge-bundle stamps into them do not move (ledger X4 pins both facts) and no line citation into
  any of the four drifts.
- ACCEPTED, deliberately: the partition is a brittle census. The first new attribute of ANY kind in these files reds a
  security test and must be added with its kind's pin and the total in the same edit (control D2); a comment that
  spells an attribute opener reds the raw count alone (control D1); `economy.rs`'s raw clause duplicates its partition
  total rather than adding teeth. The tests are GREEN at HEAD by construction — an ADR-0224 hardening pin, whose proof
  is the T0 record, the live register and the automated twin register, never a red-then-green flip of an equality.
- ACCEPTED: this is a source scan of four files. It does not see the compiled reducer table, a rule defined elsewhere,
  or a twin in a module file nobody here reads (D5, D6).
- ADR-0237's R-rb-47-ROSTER-PVP bullet is discharged by a dated amendment there, and its header carries the reciprocal
  `Extended-by:` line; that insert shifts `ARCHITECTURE.md:2279`'s citation and two in ADR-0249 (all three repointed
  here) and one in the harness spec corpus (disclosed in D5, not edited).
- Follow-ups: the crate-wide entry-point roster question stays with R-rb-80-CRATEWIDEBARE, and the durable substrate
  fix — a char-literal branch in each of the four string strippers — with R-rb-81-CHARLITERAL.
