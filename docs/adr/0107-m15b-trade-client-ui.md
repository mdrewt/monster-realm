# ADR-0107 — Trade client UI overlay (m15b)

**Date:** 2026-07-14  
**Status:** Accepted  
**Slice:** m15b (trade overlay UI)  
**PR:** TBD

---

## Context

M15a delivered the server spine: `trade_offer` table, `propose_trade` / `respond_trade` /
`confirm_trade` / `cancel_trade` reducers, escrow guards, and regenerated client bindings
(PR #165, ADR-0106). The client needs a UI overlay so players can review active offers and
act on them (accept / reject / confirm / cancel).

---

## Decision

### D1 — Store subscription: `SELECT * FROM trade_offer`

`trade_offer` is a PUBLIC runtime table (ADR-0106 D3). The client subscribes via
`SELECT * FROM trade_offer` and holds offers in `#tradeOffers: Map<bigint, StoreTradeOffer>`,
populated by the same insert/update/delete adapter pattern as `shop_row`.

The model (`buildTradeViewModel`) filters by `initiator === identity || counterparty ===
identity` as defense-in-depth against future RLS gaps (ADR-0015). Unfiltered rows from
other trades are kept in the store for possible future browse UI (M16) but are invisible
to the current model.

### D2 — Pure model function, total (ADR-0014)

`buildTradeViewModel(offers, identity, speciesMap, itemDefs): TradeScreenViewModel` is a
total pure function (never throws). Missing species/item def entries produce `"Unknown (#N)"`
fallback names. The function mirrors `buildShopViewModel` in shape: no DOM, no SDK, no
side-effects.

### D3 — `mySide` / `theirSide` orientation

The view model normalizes perspective: `mySide` = what the viewer gives up;
`theirSide` = what the viewer receives. When the viewer is the initiator, `mySide =
initiatorCards/Items/Currency`; when counterparty, roles swap. This prevents the view from
needing to know the viewer's role.

### D4 — Action derivation table (four states)

| Viewer role  | status                   | actions                  | statusLabel                        |
|--------------|--------------------------|--------------------------|-------------------------------------|
| initiator    | `Pending`                | `['cancel']`             | `'Waiting for response'`            |
| counterparty | `Pending`                | `['accept', 'reject']`   | `'Offer received'`                  |
| initiator    | `ConfirmedByCounterparty`| `['confirm', 'cancel']`  | `'Accepted — confirm to finalize'`  |
| counterparty | `ConfirmedByCounterparty`| `['cancel']`             | `'Accepted — awaiting confirmation'`|

`accept` and `reject` both call `respond_trade` reducer with `accepted: true/false`
respectively (same reducer, different argument — ADR-0106 B).

### D5 — KeyU keyboard shortcut, mutual exclusivity

The trade overlay is toggled by `KeyU`. It obeys the full mutual-exclusivity guard
(same 8-overlay list as `KeyG` / shop) and suppresses held-key movement while open
(ADR-0013). Escape closes it.

### D6 — Double-spend lock on reducer calls

`TradeView` carries a `#pending: boolean` lock identical to `ShopView` (ADR-0085).
The reconnect handler calls `tradeView?.hide()` to reset the lock, preventing a dead-button
after a drop-during-send.

### D7 — Coverage exclusion

`tradeView.ts` is a thin DOM shell (no unit-testable logic). Added to `vite.config.ts`
`coverage.exclude` and to `dom-shell-coverage-exclusion.eval.mjs`'s `DOM_SHELLS` array,
consistent with all prior view shells.

### D8 — Batch listener re-renders on offer status change

The `store.onBatchApplied` listener refreshes the trade overlay when visible, so a
`Pending → ConfirmedByCounterparty` status flip (delivered as `onUpdate` to the
counterparty) re-renders the initiator's view without a manual UI re-toggle.

---

## Consequences

- `store.ts` adds `StoreMonsterCard`, `StoreTradeItem`, `StoreTradeOffer` types; 3 new
  methods (`upsertTradeOffer`, `removeTradeOffer`, `allTradeOffers`, `ownTradeOffer`);
  `reset()` clears `#tradeOffers`.
- `rowConvert.ts` adds `SdkTradeOfferRow` interface + `tradeOfferRowToStore` converter.
- `connection.ts` wires `trade_offer` table; adds `'SELECT * FROM trade_offer'` to
  the subscription query.
- `main.ts` adds `TradeView` initialization (KeyU, Escape, batch listener, reconnect reset,
  frame-loop overlay guard).
- 44 new unit tests in `tradeModel.test.ts` cover all 4 action states, role detection,
  orientation, name resolution, bigint preservation, deterministic selection, and identity
  filtering (including fast-check properties).
- `tradeView.ts` DOM shell is e2e-validated (not unit-covered — ADR-0009/0010).
- ADR next-free: 0108.
