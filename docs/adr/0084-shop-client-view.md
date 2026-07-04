# ADR-0084 — Shop client view architecture (M13d)

**Date:** 2026-07-04 · **Status:** Accepted
**Deciders:** orchestrator
**ADR-sequence:** follows 0082 (M13b shop content/reducers)

## Context

M13d delivers the frontend shop screen and wallet display — the client-side
counterpart of the `buy`/`sell` reducers and `shop_row`/`shop_item_row` public
tables landed in M13b.

Three architectural constraints shape this decision:

1. **`player_wallet` is PRIVATE** (ADR-0081/0015, schema comment: "MUST-NEVER-LEAK:
   no `public`, no projection"). SpacetimeDB 2.6 private tables produce NO client
   subscription (ADR-0040, confirmed in the M13a desync-guard review). The client
   has no access to the live balance.

2. **shop_row / shop_item_row are PUBLIC** tables (no RLS); every connected
   player sees the full shop catalog. Ownership filtering for "what can I sell" uses
   the established `ownInventory(identity)` pattern (ADR-0015/0046 V1).

3. **Reducer callbacks carry failure messages** — the SpacetimeDB SDK fires a
   `ReducerEventContext` on every reducer call. If `status.tag === 'Failed'`, the
   context message contains the server's rejection reason (e.g., "insufficient
   funds", "item not in stock"). This is the ONLY out-of-band signal the client
   receives about an economy transaction.

## Decision

**A. Pure subscription shop model** — `shopModel.ts` is a pure function
`buildShopViewModel(shops, shopItems, itemDefs, ownInventory)` that produces a
view model from the four subscribable sources. No SDK imports, no DOM, no
side-effects. Same pattern as `raisingModel.ts`, `healModel.ts`.

**B. Shop catalog via public tables** — Subscribe to `shop_row` + `shop_item_row`
in `connection.ts`. Unfiltered (all shops visible; the client selects which
`shopId` to show based on context). Item names and `sellPrice` come from
`item_row` (already subscribed). The store exposes `allShops()` /
`shopItemsByShopId(id)` / `allShopItems()` read accessors.

**C. Wallet balance: NOT displayed** — Displaying a live balance from
`player_wallet` is architecturally impossible (private table, no subscription).
The shop view shows NO balance line. Instead a **feedback area** surfaces
the last reducer outcome ("Purchase complete!", "Error: insufficient funds", etc.)
so the player understands why an action succeeded or failed.

This is intentional and correct per ADR-0015/0081. A public balance projection
(like `monster_pub` for monsters) would require a server-module schema change —
deferred to a future slice if gameplay data shows it is needed (YAGNI).

**D. Reducer feedback via async/await Promise** — `main.ts` issues
`await conn.reducers.buy(...)` / `await conn.reducers.sell(...)` inside
async try/catch blocks. The SpacetimeDB 2.6 SDK returns a `Promise<void>`
that resolves on server commit and rejects with an `Error` on server failure
(no `conn.reducers.onBuy` event-listener API exists in STDB 2.6). On
rejection, `(err as Error).message` is forwarded to `ShopView.showFeedback`.
On success, a "Purchase/Sale complete!" message is shown. This satisfies the
spec requirement to "surface reducer-rejection feedback in the UI."

**E. Shop screen trigger** — The shop overlay opens via `KeyG` (General store)
when no other overlay is active. This is an MVP trigger: the real shopkeeper
NPC → shopId association will be wired in a later milestone (the dialogue tree
for a shop NPC will select a `shopId` before calling the open handler). The
overlay opens with the FIRST available shop from the store; if no shops are
loaded, it shows "No shop available."

**F. Sell eligibility by data** — An item is sellable IFF its `item_row.sellPrice > 0`
(classify-by-data; ADR-0047 pattern; never a hardcoded id list).

**G. DOM structure follows ADR-0014** — `shopView.ts` is a coverage-excluded DOM
shell (no logic); all logic is in the pure `shopModel.ts`. The overlay shell is
declared in `index.html` and referenced by id. Mutual exclusivity with all
other overlays is enforced in `main.ts` (same guard pattern as `boxView`,
`raisingView`, etc.).

## Consequences

**Good:**
- Wallet privacy invariant upheld (no leak of private data)
- Consistent with established model/view/main patterns (ADR-0014/0016)
- Reducer feedback surface is minimal, correct, and testable
- Pure model is fully unit-testable without DOM or SDK

**Accepted trade-offs:**
- Player never sees live balance; must infer from transaction feedback
- Shop must be opened manually (no NPC-dialogue hookup yet)
- `StoreItemRow` gains `sellPrice: bigint` — `raisingModel.test.ts` helper
  `itemDef()` and `rowConvert.test.ts` item fixtures need `sellPrice` added
  (expected mechanical updates, not test weakening)

## Compliance

- ADR-0014: functional core / imperative shell — `shopModel.ts` is pure logic; `shopView.ts` is the DOM shell; `main.ts` is the wire. ✓
- ADR-0015: RLS stakes-classification — shop tables are public (prices are not
  private), wallet is private. ✓
- ADR-0016: pure subscription view — `shopModel.ts` is a pure function over
  the four subscribable sources; no SDK, no DOM, no side-effects. ✓
- ADR-0040: private tables produce no client subscription — wallet excluded. ✓
- ADR-0047: classify by data (sellPrice > 0), never by hardcoded id list. ✓
- ADR-0081: wallet single-mutation-surface — client never writes balance. ✓
- ADR-0082: buy/sell reducers invoked correctly (shopId, itemId, qty). ✓

## Spec gap note

The M13 spec §5 task 4 says "wallet display; pure subscription views over
`player_wallet`" — this is a spec imprecision: `player_wallet` is private and
produces no subscription. This ADR replaces "wallet display" with "transaction
feedback surface". The spec will be updated to reflect this.
