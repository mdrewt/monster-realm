# 0222 — A REKEY needle must correspond to its own key's table: `[G6/correspondence]` proves the named helper reaches `db.<table>(` and writes through it

**Status:** Accepted
**Date:** 2026-08-31
**Slice:** rb-25 (residual R-rb-2-X10, promoted from rb-2's acceptance ledger)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz
**Extends:** ADR-0208 (no reciprocal back-link edit — `docs/adr/0208-*` is outside this slice's declared touches)
**Decision:** A REKEY needle must name one cfg-free `fn` (both halves); the rekey half must also reach `db.<table>(` and write through it. Since rb-41 the exists half's reach is proven by `rb41_*` Rust tests; the mirror exception is retired.

---

## Context and problem statement

ADR-0179 D6's re-key manifest maps every `Identity` column to a policy. For a `REKEY` entry the
manifest also names two helpers: `rekey:` (called from `rekey_all`) and `exists:` (called from
`account_has_game_data`, guard 11 / AUTH-20). ADR-0208's `[G6/consumed]` clause proved those needles
are PRESENT in the two call sites. It never asked **which table the named helper is about.**

rb-2's red-team measured the consequence and deferred it as residual R-rb-2-X10:

> re-point `heal_cooldown.owner_identity`'s `exists` needle at `has_monsters(` and delete
> `has_heal_cooldown` from `account_has_game_data`: the borrowed needle is still present, the eval
> stays GREEN, and guard 11 stops fail-closing for `heal_cooldown`.

A second, smaller hole rode along: `indexOf` is not identifier matching, so the needle `et_exists(`
is a plain substring hit inside the live `wallet_exists(` call — a manifest could name a helper that
exists nowhere and still read as consumed.

## Decision

**D1 — identifier-bounded call matching.** `[G6/consumed]` uses a file-local `containsCallOf`. The
needle always ends with `(` (NEEDLE_SHAPE, enforced by `[G6/policy]`, which runs first), so that
paren IS the right boundary and only the LEFT is tested: not a word character, and not `.`
(a method call on some receiver is not a call of the crate-level function the manifest names).
`rust-scan.mjs`'s `containsIdent` **cannot** be used here — it also tests the character AFTER the
needle, which for `f(ctx` is the `c` of `ctx`, so it returns false for every real call and the
clause would be permanently red. rb-2's DEFER note proposed exactly that swap; it is wrong.

**D2 — `[G6/correspondence]`.** For each REKEY entry and each half, the needle's function name is
resolved across the STRIPPED tree (`treeSrcs` was already a parameter, so no input-set widening).
Fail-closed on **0** declarations ("helper not found, skip" is a hole the size of the manifest), on
**more than one** (taking the first hit lets a decoy declared earlier launder a borrow), on an
unlocatable or empty body, and on a configuration predicate. Then the body must reach the accessor
token of the entry's own table.

**D3 — the token is `db.<table>(`, rooted at a real database handle.** Not `.<table>(`: any
same-named method on any receiver satisfies that (measured, clippy-clean). Not `ctx.db.<table>(`:
that misses the legitimate `let db = &ctx.db;` alias. The receiver must be `<ident>.db`, or a name
this body binds to `&ctx.db` / `ctx.db`. Accessor sites inside a macro invocation are rejected —
spans are computed generically (`ident` + `!` + bracket-walk), never from a blacklist of macro
names, because a blacklist of constructs is unclosable. `#[cfg` and `cfg!(` are refused both on the
function item and in its body.

**D4 — the rekey half proves EFFECT, the exists half proves NAMING.** A re-key helper that only
READS its own table leaves every guest row under the abandoned identity, so at least one accessor
occurrence must carry `.insert(` / `.update(` / `.delete(` **within its method chain** — the span is
bounded by `isChainChar`, the primitive `[W/write-target]` already uses. A body-wide or
next-`db.`-bounded search is satisfied by a `Vec::insert` in the following statement, and by a
neighbouring table's real update reached through another handle (both measured green before this
bound). An existence predicate legitimately only reads, so the exists half requires the accessor
only.

**D5 — one pinned mirror exception.** `has_monsters(` is the existence predicate of both `monster`
and its 1:1 projection `monster_pub`, and it legitimately reads only `db.monster(`. `EXISTS_COVER` is
a one-row `Map` literal (no prototype chain to pollute), pinned by SET EQUALITY, not membership: the
manifest carries a SECOND REKEY pair sharing an existence needle (`player_quest` /
`player_dialogue_state`), and a red-team measured the amnesty — hollow that shared predicate, add a
second row, stay green. Two further clauses police it: the cover must share the excused key's
existence needle (P2), and the excused key must still ACTUALLY fail the strict check (P3 — an
amnesty that outlives its justification is how a one-row exception becomes a general one).

**The safety invariant** that lets the exception excuse ANY failure kind and not merely "reaches the
wrong table": the cover key is itself a REKEY entry, strict-checked by the same loop on its own
iteration regardless of iteration order. A hard defect in the shared helper — not declared, declared
twice, no body, cfg-hidden — is therefore reported against the cover no matter what the excused key
does. What the exception drops is exactly one question ("does this predicate ALSO reach the
projection"). The 1:1 invariant it rests on was independently confirmed by the reducer-security
audit: `monster` and `monster_pub` are never deleted from anywhere in the non-test tree, both
inserts are same-transaction pairs, and every `monster_pub` write goes through `pub_from_monster`,
which copies `owner_identity` from the private row. Its owning gate is
`evals/monster-dual-write.eval.mjs`.

**D6 — the oracle is the SHIPPED tree, not the fixture.** The FG75 teeth run against in-file
fixtures, and the fixture lives in the file an attacker is already editing. So the default export
additionally runs three LIVE-TREE borrow proofs (L2-L4; five until rb-41, which retired L1 and L5
with the exists half's reach leg) after the real check passes: each drives the shipped
checker over the shipped sources with a borrowed manifest or an in-memory source edit and requires it
to red **with the expected tag and every expected message fragment**. The success summary reports
counts DERIVED from the run, never literals — a literal survives the deletion of the code it
describes (measured: the whole clause block was deleted and four literal claim fragments still
printed). The teeth count is likewise derived from an `expectTag` counter and pinned, because
`if (…) return null;` as the first line of `runTeeth()` skipped all of them while the gate printed
"(100 teeth verified)" and exited 0.

## Consequences

**The accessor≡table-half join is STRUCTURAL, not observed.** `parseTableSchemas` keys tables on the
`accessor =` argument and `findIdentityColumns` builds `${table}.${field}` from it, and `[G6/live]`
forces every manifest key to resolve to one of those tables. A future reader should not "re-verify" a
fact that cannot drift.

**Known limits, stated so a green gate is not read as more than it gives:**

1. **This is naming integrity, not reachability.** A `db.<table>(` in unreachable-but-compiled code
   satisfies the clause (the `cfg` legs close the compiles-into-no-target half only).
2. **The exists half cannot see hollowing.** A predicate whose body reads its table and returns a
   constant is textually indistinguishable from a real one. MEASURED green
   (`wallet_exists -> { let _ = ctx.db.player_wallet()…find(owner); false }`), and when this ADR was
   written nothing else in the repo covered it — `accounts_tests.rs` referenced
   `account_has_game_data` once, for ordering only. **CLOSED by rb-41** — see the Amendment below.
3. **The rekey half proves a write, never a DIRECTION or a COMPLETENESS.** Delete-without-reinsert
   and a `to`/`from` inversion both pass. `player_wallet` and `profile` are covered elsewhere
   (`currency-integrity` pins `zeroed_wallet(row)`, `ranking-security` pins `tombstoned_profile`);
   `rekey_monsters` / `rekey_inventory` / `rekey_npc_state` / `rekey_heal_cooldown` have no such
   gate. Backlog.
4. **`rekey_wallet` passes on the source-zeroing write.** Its destination credit lives inside
   `grant_currency`, which the clause never opens. A refactor moving the zeroing into a callee — the
   direction ADR-0081's single-surface doctrine points — would red correct code, and the rekey half
   has no escape hatch by design. The remedy is a deliberate, reviewed edit here.
5. **Generic accessor names are a trip-wire.** `config`, `account` and `player` are accessor names
   generic enough that `db.<table>(` would be weak for them. All three are `EXEMPT`/`BLOCKED` today,
   so they never reach this clause; promoting any of them to `REKEY` requires revisiting the token.
6. **The needle's module path is discarded** (`crate::inventory::wallet_exists(` resolves to
   `wallet_exists`), so a wrong module path is documentation rot the gate blesses. Backlog.
7. **Two false-RED shapes** a future agent must not "fix" by loosening: mutually exclusive `#[cfg]`
   twins of one helper (the message names the case and gives the wrapper-fn remedy, not a rename);
   and the live-tree probes' `mutateLive` anchors, which pin exact live source text and fail loud
   with a re-anchor instruction after a parameter rename or a rustfmt change.
8. **Tokens are matched on deleted-whitespace text** (`compactWs` deletes rather than collapses), and
   `WRITE_VERBS` is shared with G5's write-isolation clause — pinned as an exact ordered set by a
   tooth naming both consumers, because nothing pinned it before.

**Authoring constraint this creates:** a fixture that both concatenates `GOOD_TREE[0].src` into a
file AND includes `GOOD_TREE[0]` in the same tree array now reds with "declared 2 time(s)".

## Amendment (2026-09-04, rb-41 — residual R-rb-25-X9)

Known limit 2 is CLOSED, and D5's `[G6/mirror]` exception goes with it. Not by hardening the
scanner — ADR-0224 forbids that — but by migrating the exists half's REACH question ("does this
predicate read, and decide on, its own table?") out of this eval into ordinary Rust `#[test]`s that
run the SHIPPED predicates against REAL rows. The cut is SURGICAL, not a whole-half deletion, for a
reason a red-team MEASURED on the plan (see "KEPT" below).

**The tests.** Seven `#[test]`s, each in the `*_tests.rs` of the module owning the predicate:
`rb41_wallet_exists_tracks_real_wallet_rows` (`economy::wallet_exists`, `economy_tests.rs`),
`rb41_profile_exists_tracks_real_profile_rows` (`ranking::profile_exists`, `ranking_tests.rs`),
`rb41_has_heal_cooldown_tracks_real_cooldown_rows` (`raising::has_heal_cooldown`,
`raising_tests.rs`), `rb41_has_items_tracks_real_inventory_rows` (`inventory::has_items`, NEW
`inventory_tests.rs`, declared from `inventory.rs`), `rb41_has_monsters_tracks_real_monster_rows`
(`monster_mgmt::has_monsters`, NEW `monster_mgmt_tests.rs`, declared from `monster_mgmt.rs`), and
`rb41_quest_state_tracks_real_quest_rows` + `rb41_dialogue_state_tracks_real_dialogue_rows`
(`npc::has_quest_or_dialogue_state`, `npc_tests.rs`) — the only two-armed predicate, so one test per
`||` arm, each registering ONLY its own table so the other arm reads an empty one.

Each test walks four states — EMPTY, a STRANGER-only row, an OWN row, the OWN row removed with the
stranger's row left behind — and asserts BOTH the predicate and `accounts::account_has_game_data` at
every state. Rows are seeded and removed through a typed fixture handle, never through a write path.
Two fixture rules are load-bearing (red-team F2/F3, both MEASURED): every non-identity column is
ZERO or empty and the stranger row mirrors the owner row except for its identity, so a predicate
that additionally inspects a payload column (`.is_some_and(|w| w.balance > 0)` — the very defect
`economy.rs`'s own doc comment warns about) reds at the own-row step; and both identities are
`[n; 32]` with `n >= 1`, because `Identity::__dummy()` (the context's sender) is all-zeros and an
owner of `[0; 32]` would let a predicate that keys on `ctx.sender()` instead of `owner` pass. Limit
2's own proposed remedy ("a Rust twin enumerating the six `account_has_game_data` disjuncts") is
therefore delivered as BEHAVIOUR, not as a source pin: the hollow that was MEASURED green here
(`{ let _ = <the shipped read>; false }`) reds its own predicate's test, and deleting a disjunct reds
only the paired `account_has_game_data` assertion in that table's test while the direct predicate
assertion stays green, naming which disjunct went. MEASURED: every test was shown RED by name
against its own hollowed predicate (per `||` arm for npc) and against each deleted disjunct, then
GREEN on restore; the record is `memory/projects/gates/rb-41.red-before.md` (harness memory, not
this repo).

**Why this became possible.** `spacetimedb` 2.8.1 `src/lib.rs:1043` declares
`#[doc(hidden)] pub fn ReducerContext::__dummy() -> Self`, so a context whose `db` is the real
accessor type can be built inside the crate: the standing premise "there is NO way to construct a
`ReducerContext` in this crate" was STALE, not a fact. It is stated in ADR-0225 (line 91), ADR-0226
(line 145), ADR-0227 (line 58) and ADR-0232 (line 15) and in a `content_tests.rs` comment — NOT
edited here (outside rb-41's declared touches); this paragraph is the record that they are stale.
The `accounts_tests.rs` header, which gave the premise as the reason for its executed-test /
source-scan split, and the six rationale comments in `accounts_tests.rs`, `privacy_tests.rs` and
`ranking_tests.rs` that restated it, WERE corrected in this slice (the scans they justify stand).

**The native host.** NEW `server-module/src/native_host_tests.rs` is the SSOT for the design; read
its module doc. The facts that bind other files: it is a `#[cfg(test)]` module wired from `lib.rs`,
and it defines ONCE the ten `#[no_mangle] unsafe extern "C"` SpacetimeDB host syscalls the generated
table code calls — replacing the aborting stubs previously split across `accounts_tests.rs` (4
symbols) and `privacy_tests.rs` (6). Five are implemented (the two name lookups, the index point
scan, and the row iterator's advance/close); the table scan and the four write syscalls panic loudly
— a full-table `.iter()` is the shape this repo bans in owner-scoped readers, and tests seed through
the fixture handle using `bsatn::to_vec`, the same encoder the real insert path uses. `row_iter_bsatn_advance` returns `-1` on the call that drains the iterator,
because `UniqueColumn::find` asserts exhaustion after ONE `next()` (a `0`-then-`-1` protocol panics
every `find`-based predicate — MEASURED). The fixture derives the canonical index name
`{table}_{column}_idx_btree` itself, so a test cannot bind another table's index to its rows. Table
and index ids are minted per name and NEVER reset, since the generated `table_id()` / `index_id()`
memoise their first answer in a per-type `OnceLock`; a process-wide lock serialises fixtures under
plain `cargo test` — nextest, which every `just` gate runs, gives each test its own process, so CI
never exercises that lock. Three naming facts are load-bearing: the module name ends in `tests` (the
`accounts_tests.rs` mod census exempts only `*tests` names), the file name ends in `_tests.rs` (what
the cross-file eval scanners key on), and the `mod` line carries `#[cfg(test)]`. What keeps the ten
symbols out of the published module is the COMPILER — any non-test reference to the module fails
the publish build with E0433 (MEASURED by the security audit; `just build` was run in this slice) —
not a gate: monster-privacy's `[SCOPE]` clause first accepts the literal `#[cfg(test)]` anywhere in
the excluded file's RAW text, prose included, so a test file that mentions the attribute
self-certifies (18 pre-existing `*_tests.rs` files do), and its parent-declaration branch accepts
any such literal within 160 characters above the `mod` line, so an adjacent gated module vouches
for its neighbour (both MEASURED; the eval is outside touches, recorded as a follow-up). The three
rb-41 files deliberately never spell the attribute in prose, so nothing here self-certifies. This
is the first `unsafe` code in `server-module/src`.

**DELETED from `evals/guest-claim-integrity.eval.mjs`** — ADR-0224 amendment 1 makes migration mean
deletion in the SAME slice: the ACCESSOR-REACH leg of the exists half of `[G6/correspondence]`
(`strictCorrespondence` returns after the declaration legs when `half === 'exists'`), the whole
`[G6/mirror]` clause and `EXISTS_COVER` (D5 existed only to excuse `monster_pub` from that leg),
teeth FG75b/n/o/p/q/r, live-tree probes L1 and L5, and the `monster_rows_present` fixture spare.
RE-POINTED, not deleted: the four reach-leg teeth FG75j/k/u/v moved from exists helpers to rekey
helpers — their legs still serve the surviving half, and deleting them would silently unprove it.
`TEETH_PINNED` re-derived 351 → 345. The success detail still derives its counts from the run
(16 halves proven, 3 live-tree proofs bit) and names the `rb41_*` tests as the exists-side reach
proof. Net −329 lines (+149/−478).

**KEPT — and why the cut is surgical.** The exists half still resolves its needle to EXACTLY ONE
declaration with a non-empty body carrying no `#[cfg` on the item and no `cfg!(` in the body (D2's
first four legs), and FG75f/g/h/i/w/y stay pointed at exists helpers to prove it. A red-team
MEASURED that these legs are ANTI-superseded by behaviour: a `#[cfg(test)]` / `#[cfg(not(test))]`
twin of `wallet_exists`, or a body `cfg!(test) && real`, ships `false` to the wasm module while every
`rb41_*` test stays green — a native test binary is compiled with `--cfg test` and structurally
cannot see either shape. Today's eval reds both ("declared 2 time(s)"; "contains a configuration
predicate (`cfg!(`)"), and the whole-half deletion first planned would have passed both. Also kept
in full: the rekey half (D2-D4 unchanged), D1's identifier-bounded call matching, `[G6/consumed]`
INCLUDING its exists half (the needle-in-`account_has_game_data` check that closes the needle-swap /
bare-substring class), teeth FG75a/c/d/e/l/m/s/t/x and probes L2/L3/L4. The sentences in D2, D4 and
D5 that describe the exists half's REACH leg read as history from here on.

**Known limits, continuing the list above.** Reviewer and red-team findings, recorded as limits
plus one review checklist item, not as new gates (ADR-0224 amendment 2 — proof-of-teeth does not
recurse). Limits 1 and 3-8 stand unchanged; the rekey half of 3, 4 and 6 is untouched.

9. **Exists-side reach is now BEHAVIOURAL, and behaviour only covers what a test names.** The seven
   tests cover the seven REKEY tables holding an `rb41_*` twin; the eighth entry,
   `monster_pub.owner_identity`, shares `has_monsters(` and is covered at the predicate level only.
   A NEW REKEY entry for a table with no twin has an `exists:` needle checked for declaration
   integrity and consumption only — nothing proves it reaches its table. Reviewer /
   security-auditor checklist item: **a new REKEY manifest entry ships with an `rb41_*` twin.**
10. **A manifest `exists:` needle re-pointed at another live helper, with the disjunct left in
    place, is caught by nothing.** The behaviour is still pinned by the seven tests (the disjunct is
    live), so this is documentation drift of the manifest, not a security property — accepted.
11. **The host's table binding is caller-supplied.** A green run proves the predicate reads the
    registered table through `{table}_{column}_idx_btree` with the key `owner_of` extracts from the
    seeded row; it does not prove the schema declares that index, and the host models no
    constraints (a duplicate unique key seeded by mistake surfaces as the bindings' own `find`
    assertion).
12. **`Fixture::requested_indexes()` records a name once per PROCESS** (the generated `OnceLock`
    memo), so it is a reliable diagnostic under nextest, not under a shared-process run.
13. **`Fixture::ctx()` is the only sanctioned route to `__dummy()`.** A direct call bypasses the
    serialisation lock and races other fixtures under plain `cargo test`.
14. **The tests prove the predicate, not the insert path.** Rows arrive through the fixture handle,
    so nothing here exercises the real write syscalls, the auto_inc write-back decode, or the
    dual-write pairing.

**Consequence for future authors:** a ctx-bound helper is now testable against real rows, so a new
existence or read predicate ships with an `rb41_*`-shaped test rather than a source pin; a text
scan is still the right tool for what a native test binary cannot see (cfg twins), and any document
still asserting that `ReducerContext` cannot be constructed is stale.
