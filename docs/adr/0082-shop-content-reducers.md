# 0082. Shop content, buy/sell reducers (M13b)

- Status: accepted
- Date: 2026-07-04
- Surfaced by: M13-economy.spec.md task 2; reuses ADR-0081 (currency), ADR-0018 (inventory), ADR-0022 (economy), ADR-0006 (additive content).

## Context and problem statement

M13b adds shops: content-defined stock with buy/sell prices, and the `buy`/`sell` reducers
that move items and currency between the player and the server-as-counterparty. The classic
exploit is a client-set price or client-computed total; the design blocks that at every
seam.

## Design decisions

### D1 — ShopDef type and RON content

`ShopDef { id: u32, name: String, stock: Vec<ShopStockEntry> }` where
`ShopStockEntry { item_id: u32, buy_price: u64 }`. Shops are a new content registry
(`game-core/content/shops/*.ron`), following the M8.9e content-dir fan-out pattern
(ADR-0057). Seeded by `sync_content_inner` into `shop_row` and `shop_item_row` tables.

### D2 — sell_price on ItemDef, not per-shop

`sell(item_id, qty)` has no `shop_id` parameter (per spec). The sell price is a
per-item content field (`sell_price: u64` on `ItemDef`/`ItemRow`). Value 0 means
"not sellable — reject". This is the simplest design that satisfies the spec signature
while keeping prices server-side content (not reducer parameters). ADR-0022 is
satisfied: prices come from content, totals are server-computed.

### D3 — Schema: shop_row + shop_item_row (both public, content)

Two tables mirror the two-level content hierarchy. `shop_item_row` is keyed by
`(shop_id, item_id)` for O(1) buy validation. Both are public (world-readable
content, like `item_row` — no privacy concern for shop definitions).

### D4 — buy/sell reducer placement in economy.rs

Both reducers live in `server-module/src/economy.rs` (the economy domain module,
ADR-0056 canonical vocabulary). The `require_owner` guard executes before ANY
`spend_currency` call (ADR-0081 forward obligation).

### D5 — Infinite stock (no inventory depletion)

Shops have unlimited stock for the MVP. A buy validates "item is in this shop's
stock list" only — no quantity tracking. Deferred: per-shop stock depletion → M15
or later (YAGNI).

### D6 — validate_shops as a separate validator

Following the pattern of `validate_encounters`, `validate_npc_content`, etc., shop
validation is `validate_shops(shops: &[ShopDef], items: &[ItemDef])`. This avoids
changing `validate_content`'s existing signature.

### D7 — CONTENT_VERSION bump (5 → 6)

Adding `sell_price` to `item_row` and two new content tables requires re-seeding.

## Consequences

- `require_owner` before `spend_currency` in `buy` (ADR-0081 §forward-obligation).
- `#[allow(dead_code)]` removed from `grant_currency`/`spend_currency` (first caller lands).
- Client-set prices impossible: the reducer looks up price from `shop_item_row` (server DB).
- Client-set totals impossible: `buy_price * qty` computed server-side.
- Selling escrowed items deferred to M15 (no battle/escrow guard in sell for MVP).
- `sell_price == 0` rejects the sell ("item cannot be sold" error).

## ADR references

- ADR-0081: currency helpers + forward obligations (require_owner, dead_code removal)
- ADR-0022: economy design (shop prices as content, server-as-counterparty)
- ADR-0018: inventory backbone (grant_item/consume_one reused)
- ADR-0015: RLS / privacy (shop_row/shop_item_row are public content — no privacy concern)
- ADR-0006: additive content tables
- ADR-0057: content-dir fan-out pattern for shop RON
