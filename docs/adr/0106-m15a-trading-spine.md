# ADR-0106 — M15a Trading Spine

**Status:** Accepted
**Date:** 2026-07-13
**Slice:** m15a (SOLO — touches game-core + server-module)
**Supersedes:** —
**Amends:** —
**Subsystems:** schema-persistence, economy-quests, battle
**Decision:** Introduce `trade_offer` table + no-physical-escrow guards across all asset-mutating reducers; pure game-core swap rules; atomic confirm-time re-read; cancel-on-disconnect cleanup.

## Context

Monster Realm needs player-to-player trading. The trade flow requires:

1. A table to represent an open offer (`trade_offer`)
2. Display-only monster snapshots so the counterparty can evaluate the deal without leaking private IV/EV data (ADR-0015)
3. An escrow mechanism so offered assets cannot be concurrently mutated while the trade is pending
4. An atomic swap that re-reads live rows at confirm time (no stale-data exploit)
5. Cleanup on disconnect (no orphan offers)

## Decisions

### D1 — Mirror `reject_if_in_battle` for monster escrow (TR-2–TR-7, TR-11)

A `reject_if_monster_in_trade` guard in `server-module/src/guards.rs` mirrors the existing `reject_if_in_battle` pattern: pure predicate over an `impl Iterator<Item = impl Borrow<TradeOffer>>`. Call sites chain `initiator`-filtered and `counterparty`-filtered btree iterators so every active offer for the owner is scanned regardless of role.

**Wired into:** `evolve` (TR-2), `fuse` (TR-3), `set_nickname` (TR-4), `set_party_slot` (TR-5), `care` (TR-6), `train` (TR-7), `start_battle`/`begin_encounter` (TR-11/ME-1).

### D2 — Quantitative item/currency escrow (TR-8–TR-10, TR-12)

Items and currency are fungible, so the guard is quantitative, not boolean:

- `escrowed_item_qty(iter, owner, item_id) -> u32` — saturating sum over active offers
- `escrowed_currency_amount(iter, owner) -> u64` — saturating sum over active offers

At each call site: `available = inventory_count - escrowed` (or `balance - escrowed`). Reject if `requested > available`. Saturating arithmetic prevents overflow on pathological input (MI-2).

**Wired into:** `sell` (TR-8), `buy` (TR-9), `heal_party` (TR-10), `use_battle_item`/`attempt_recruit` (TR-12), `train` (TR-7).

### D3 — No physical escrow; guards enforce immutability in place

Assets are never moved to a holding row. The `trade_offer` row itself is the lock: `reject_if_monster_in_trade` and `escrowed_*` helpers read active offers and reject conflicting mutations. The atomic swap in `confirm_trade` re-reads live rows and verifies ownership still matches the offer before executing any transfer (`build_swap_plan` → `Err(OwnershipChanged)` if not).

Terminal state is row DELETED (mirrors ADR-0077 battle GC). No `Completed` variant exists.

### D4 — One active offer per player at a time (TR-20)

`validate_proposal` receives `initiator_has_active_trade` and `counterparty_has_active_trade` booleans from the server shell. If either is true, returns `Err(AlreadyInTrade)`. This prevents offer spam and simplifies the "already in trade" escrow checks (a player can only be in one offer).

### D5 — `MonsterCard` is display-only (TR-19, ADR-0015)

`MonsterCard` contains only public-facing fields: `monster_id`, `species_id`, `nickname`, `level`, `current_hp`, `stat_hp`. It does **not** contain `iv_*`, `ev_*`, or `nature_kind`. Snapshots are taken at `propose_trade` time and stored in the `trade_offer` row for the counterparty to evaluate the offer without querying the private `monster` table.

### D6 — `trade_offer` is a public table

The table is `#[spacetimedb::table(name = trade_offer, public)]`. This means all clients can subscribe to all offers. Per-owner transport RLS is the M16 residual (same as inventory/wallet — M-2 known residual).

### D7 — `TradeSide` enum (renamed from `SideId`)

The trading rule module needs an enum to identify which side of the swap an asset transfers to. `SideId` is already exported by `game_core::combat`. The trading variant is named `TradeSide` (`Initiator` | `Counterparty`) to avoid a naming collision.

### D8 — TOCTOU non-issue (SpacetimeDB single-threaded WASM)

SpacetimeDB reducers execute in a single-threaded WASM environment. Read-check-write within one reducer is atomic with respect to all other reducers — no concurrent TOCTOU is possible. Physical escrow (moving assets to a holding row) would be strictly worse: double-write risk, orphan risk, and no additional safety.

### D9 — Saturating arithmetic for escrowed qty/currency (MI-2)

`escrowed_item_qty` and `escrowed_currency_amount` use `saturating_add` when accumulating across offers. A pathological input (player somehow in multiple offers — impossible given D4, but defensive coding) cannot cause an integer overflow that would incorrectly clear the escrow.

### D10 — `cancel_trades_on_disconnect` (TR-18)

`on_disconnect` calls `trading::cancel_trades_on_disconnect(ctx, me)` before deleting the player row. The function collects all active offer IDs (via btree indexes on `initiator` and `counterparty`) into a `Vec` first, then deletes each. Collect-before-delete avoids mutating while iterating. No assets move — offers are simply deleted.

## Known Residuals

- **M-2 (public table currency leak):** `trade_offer.initiator_currency` / `counterparty_currency` are visible to all clients. This mirrors the existing `player_wallet.balance` leak. Transport RLS is the M16 residual.
- **M-3 (disconnect cancels counterparty offer):** If the counterparty disconnects, the offer is cancelled even if the initiator is still online. This is intentional (no orphan offers).
- **Header backfill (M-infra-d residual):** DIGEST.md header backfill remains parked.

## ADR Chain

- ADR-0015: private-table data must not leak into public tables (MonsterCard shape)
- ADR-0006: additive schema discipline (trade_offer fields appended last)
- ADR-0056: server-module submodule vocabulary (`trading.rs` filename is now canonical)
- ADR-0061: pure rules in game-core, thin shell in server-module (trading/rules.rs)
- ADR-0077: terminal GC pattern (row DELETE = terminal, mirrors battle)
- ADR-0081: single wallet-mutation surface (spend_currency / grant_currency)

## Spec Coverage

| Criterion | Covered by |
|-----------|-----------|
| TR-1 (non-empty offer) | `validate_proposal → EmptyOffer` |
| TR-2 (evolve escrow) | `reject_if_monster_in_trade` in `evolve` |
| TR-3 (fuse escrow) | `reject_if_monster_in_trade` in `fuse` (both parents) |
| TR-4 (nickname escrow) | `reject_if_monster_in_trade` in `set_nickname` |
| TR-5 (party-slot escrow) | `reject_if_monster_in_trade` in `set_party_slot` |
| TR-6 (care escrow) | `reject_if_monster_in_trade` in `care` |
| TR-7 (train item escrow) | `escrowed_item_qty` in `train` |
| TR-8 (sell item escrow) | `escrowed_item_qty` in `sell` |
| TR-9 (buy currency escrow) | `escrowed_currency_amount` in `buy` |
| TR-10 (heal currency escrow) | `escrowed_currency_amount` in `heal_party` |
| TR-11 (battle monster escrow) | `reject_if_monster_in_trade` in `start_battle` + `begin_encounter` |
| TR-12 (battle item escrow) | `escrowed_item_qty` in `use_battle_item` + `attempt_recruit` |
| TR-13 (reject releases escrow) | `respond_trade(false)` deletes row |
| TR-14 (counterparty confirms) | `respond_trade(true)` → `ConfirmedByCounterparty` |
| TR-15 (re-read at confirm) | `confirm_trade` re-reads live rows + `build_swap_plan` ownership check |
| TR-16 (atomic swap) | `confirm_trade` applies plan then deletes offer row |
| TR-17 (cancel) | `cancel_trade` deletes row |
| TR-18 (disconnect cancel) | `cancel_trades_on_disconnect` from `on_disconnect` |
| TR-19 (no IV/EV leak) | `MonsterCard` struct shape (compile-time) |
| TR-20 (one active offer) | `validate_proposal → AlreadyInTrade` |
| TR-21 (no self-trade) | `validate_proposal → SelfTrade` |
| TR-22 (both-side empty rejected) | `validate_proposal → EmptyOffer` |
| ME-1 (wild battle escrow) | `reject_if_monster_in_trade` in `begin_encounter` |
