# 0154 — Owner-scoped `my_wallet` view over the private `player_wallet` table

**Status:** Accepted
**Date:** 2026-07-26
**Slice:** ux2 (M-postgate-ux-hardening — owner-scoped `#[view]` over `player_wallet` + shop balance seam; EARS ux2-1..ux2-3)
**Supersedes:** —
**Amends:** 0081, 0084
**Amended-by:** 0194
**Subsystems:** security-authz, economy-quests, client-ui
**Decision:** Expose the caller's own balance through an owner-scoped `#[view] my_wallet -> Option<PlayerWallet>` (the ADR-0087 pattern), keep `player_wallet` private, and gate leak-shape with a call-graph-derived eval rather than body-anchored scanning.

## Context

Drew's 2026-07-25 playtest: "a cost is listed, but the amount of money I have is not
obvious." Confirmed against live code — shop rows render prices (`shopView.ts:105,125`)
but no balance appears anywhere, because `player_wallet` is deliberately PRIVATE
(ADR-0015 must-never-leak / ADR-0081) and `shopModel.ts:6-8` documented that "balance is
not accessible via subscription — only reducer-feedback messages are available."

Two candidate fixes existed. A client-side tally (accumulate grants/spends from reducer
feedback) was rejected in the milestone spec: it drifts on reconnect and multi-tab and
duplicates server-authoritative state. The codebase already had a precedent for exactly
this shape of problem — the owner-scoped `#[view] my_conversation` over the private
`player_conversation` table (ADR-0087, M13.5c).

`ARCHITECTURE.md:649` recorded the gap as needing "a public `player_wallet_pub` table."
That route is explicitly NOT taken: a projection table is a second write surface over a
balance, which ADR-0081's single-surface discipline exists to prevent.

## Decision

**D1 — `my_wallet` is an owner-scoped view in `schema.rs`, reading the table directly.**
It mirrors `my_conversation` verbatim: `ctx.db.player_wallet().owner_identity().find(ctx.sender)`
returning `Option<PlayerWallet>`. It must live in `schema.rs` — `currency-integrity.eval.mjs`
criterion 6 (ACCESSOR_BYPASS) bans the `player_wallet()` accessor in every server file
except `economy.rs`, `schema.rs`, `economy_tests.rs`. It does **not** delegate to
`economy::wallet_balance`: that helper ends in `.unwrap_or(0)`, which conflates "no wallet
row" with "balance 0" — the exact distinction this slice must preserve all the way to the
UI — and it takes `&ReducerContext`, not `&ViewContext`. ADR-0081's single-surface
discipline governs *mutations*; a view is a read projection and adds no write surface.

**D2 — the view's body is pinned EXACTLY, not by needle presence.** Adversarial review
corrected the threat model. A view handle has no `Table` impl, so `.iter()` does not
compile inside a `ViewContext` and `UniqueColumnReadOnly` exposes only `find`: the
whole-table-scan family is already forbidden by the compiler. **The one reachable leak is
a point lookup on the wrong key**, and a presence-only "body contains `find(ctx.sender)`"
check waves it through — a dead `let _decoy = …find(ctx.sender);` above
`…find(victim_identity)` passes the eval, `cargo test`, clippy and `fmt` while returning
an arbitrary player's wallet. Since the sanctioned body is one expression, both the eval
and the Rust tooth assert the whitespace-compacted body **equals**
`ctx.db.player_wallet().owner_identity().find(ctx.sender)`. Equality (rather than
absence-checking) is also what preserves the cargo-mutants kill in D8.

**D2b — reachability is a transitive closure, not a body filter.** Two indirection
attacks motivated it: `fn census(ctx) { …player_wallet()… }` + `#[view] rich_list(ctx)
{ census(ctx) }` (the ADR-0087-style "views whose body references the table" filter never
inspects `rich_list`), and the two-hop `view → roster() → census()` that defeats a 1-hop
derivation. `checkWalletViewsSafe` therefore closes `walletReaderFns` to a fixed point and
fails any view reaching the table through it. A hard-coded allowlist over all views was
rejected: it would collaterally gate unrelated future views.

**D3 — the view's return type is pinned to `Option<PlayerWallet>`, with `Vec<` banned.**
`-> Vec<PlayerWallet>` from a view named `my_wallet` is a whole-table leak carrying a
conforming `find` needle, and it is indistinguishable in the generated client binding,
so no other gate can see it. `&AnonymousViewContext` is likewise banned in the signature:
it is a legal view context (`spacetimedb-bindings-macro-1.12.0/src/view.rs:94,102,112`)
that carries no `sender` at all, and a substring match on `ViewContext` waves it through.
Conversely, `public` on a view is a *mandatory keyword with no visibility effect* (`view.rs:13-14`
`#[allow(unused)]`; omitting it is a compile error) — per-caller scoping comes from the
host ABI reconstructing `sender` (`spacetimedb-1.12.0/src/rt.rs:1099-1119`), which is why
the body's filter is the entire security boundary.

**D4 — the client never removes the wallet row on a view delete.** Through a view a row
UPDATE arrives as `onInsert(new)` + `onDelete(old)`, unordered, with no `onUpdate`
(ADR-0087). The conversation precedent gates the delete on a net-effect comparison. For
wallets that gate is both dead and wrong: no server code path deletes a `player_wallet`
row (six accessor calls in `economy.rs` — three finds, two updates, one insert; zero
deletes; `on_disconnect` does not touch it), and on a buy-then-sell round trip
(100→50→100) the coalesced delivery `I(50) I(100) D(100) D(50)` makes a balance-equality
gate fire on `D(100)` and remove the *live* row. No comparison on the row's own fields can
distinguish that from a genuine delete. Insert-wins plus `store.reset()` on disconnect is
simpler and provably correct, and the soundness condition is promoted to a permanent
gating test (`player_wallet_rows_are_never_deleted`).

**D5 — the store holds a single slot, not a map.** The view returns exactly one row — the
caller's — so `Map<identity, StoreWallet>` makes another player's balance representable in
the client cache for free. `#ownWallet: StoreWallet | undefined` plus an owner-filtered
accessor makes that unrepresentable (ADR-0015 V1 defense-in-depth).

**D6 — `ShopBalanceViewModel` is a two-arm union; "unknown" renders nothing.**
`{kind:'known', amount, label} | {kind:'unknown'}`. "Broke" (`0n`) and "not subscribed"
are semantically different and must not collapse — a `?? 0n` design would display
"Gold: 0" to a player at `MAX_BALANCE` during any delivery gap. The `unknown` arm renders
an empty, `hidden` node rather than a permanent em-dash placeholder, which would read as a
broken feature for as long as the subscription is unwired.

**D7 — ux2 ships the client half as an inert seam; `ux2b` lights it up.** The subscription
(`connection.ts`), the row converter (`rowConvert.ts`), the two `buildShopViewModel` call
sites (`main.ts:701-708` and the batch listener at `:1265-1279`) and the two-identity e2e
all sit outside this slice's declared touch-set, which a concurrent sibling slice may own.
The 5th `buildShopViewModel` parameter is therefore optional so both existing call sites
compile untouched. Patching only the first call site in `ux2b` would render the balance
once on open and let the batch listener overwrite it on the next batch — worse than not
shipping it — so `ux2b` must patch both, and must carry a call-site-count tooth (the
ADR-0108 RT-SEC-02 "guard + `(` call-site count" idiom) so a future third call site cannot
silently ship a blank readout. Until then `checkShopViewNoAmountFormatting` is
*structurally* green rather than behaviourally proven: no runtime path can put a `known`
balance into the shell, so its absence-check cannot fail. That is disclosed, not implied.

**D8 — the Rust body pin is load-bearing for the mutation gate, so it asserts presence,
never absence.** `mutate-server` caps *surviving* mutants at exactly 299 with zero
headroom (`justfile` + `nightly-smoke-wiring.eval.mjs`), and the `justfile` is outside
this slice's touch-set, so one new survivor would mean a red nightly that cannot be fixed
here. `cargo mutants --list --file server-module/src/schema.rs` shows `my_wallet` adds
exactly two mutants: `-> None` and `-> Some(Default::default())`. The second is *unviable*
(`PlayerWallet` derives no `Default`) and never reaches `missed.txt`. The first is caught
by `my_wallet_view_is_owner_scoped`, because `SCHEMA_SOURCE` is a **relative**
`include_str!` and therefore reads the *mutated* file in the cargo-mutants scratch tree
(the M17.5c precedent). Measured: `2 mutants tested: 1 caught, 1 unviable`, 0 lines in
`missed.txt`. An absence-only rewrite of that test would resurrect the survivor.

## Consequences

The balance is server-authoritative and cannot drift; a future HUD reads the same view.
`player_wallet` stays private, and table-privacy remains owned by
`currency-integrity.eval.mjs` criterion 3 rather than being re-implemented a third time.

Accepted risks, both named rather than silently carried:

1. The view is live and world-callable from the moment the module publishes, and the only
   in-slice proof is structural — a behavioral two-identity assertion requires `client/e2e/**`,
   which is outside the declared touch-set and is `ux2b`'s. This is the same posture under
   which `my_conversation` shipped.
2. The client half is inert on two axes: the 5th argument is never passed until `ux2b`, and
   `#shop-overlay` is one of the known below-the-fold in-flow shells (ADR-0151), so the
   readout inherits that defect until `M-postgate-overlay-registry` lands. Viewport-anchoring
   just the balance node was rejected — it would float a naked "Gold: 123" in the corner
   while the shop panel it belongs to stayed invisible.
