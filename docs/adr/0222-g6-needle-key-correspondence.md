# 0222 — A REKEY needle must correspond to its own key's table: `[G6/correspondence]` proves the named helper reaches `db.<table>(` and writes through it

**Status:** Accepted
**Date:** 2026-08-31
**Slice:** rb-25 (residual R-rb-2-X10, promoted from rb-2's acceptance ledger)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz
**Extends:** ADR-0208 (no reciprocal back-link edit — `docs/adr/0208-*` is outside this slice's declared touches)
**Decision:** A REKEY needle must correspond to its own key's table: `[G6/correspondence]` resolves it to exactly one `fn` and requires that body to reach `db.<table>(`, writing through it on the rekey half; `[G6/mirror]` pins the one exception.

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
additionally runs five LIVE-TREE borrow proofs after the real check passes: each drives the shipped
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
   (`wallet_exists -> { let _ = ctx.db.player_wallet()…find(owner); false }`), and nothing else in
   the repo covers it — `accounts_tests.rs` references `account_has_game_data` once, for ordering
   only. **DEFERRED to the residual backlog** (ledger gate X9): the closure is a Rust twin
   enumerating the six `account_has_game_data` disjuncts beside the existing `rekey_all` D6-order
   pin, in a file outside this slice's `touches:`. rb-2's own DEFER named the same remedy.
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
