# 0081. Currency primitive (M13a)

**Status:** Accepted
**Date:** 2026-07-04
**Slice:** m13a
**Supersedes:** —
**Amends:** —
**Subsystems:** economy-quests, schema-persistence
**Decision:** Currency primitive: private player_wallet table (u64 balance, MAX=999_999_999) with apply_grant/spend_currency helpers as the single mutation surface.


- Status: accepted
- Date: 2026-07-04
- Surfaced by: M13 implementation, ADR-0022 (currency & shop economy) + ADR-0018 (inventory primitive).

## Context and problem statement

M13 introduces the economy: a currency balance per player and shop buy/sell reducers.
This ADR covers the **currency primitive** (M13a, the serial spine): the `player_wallet`
table, the `grant_currency` / `spend_currency` helpers, and the game-core rule functions
they delegate to — mirroring the inventory discipline (ADR-0018) for currency.

The constraints are:
- Balance must never go negative (economy integrity).
- Grants must be capped (overflow safety, UX legibility).
- The balance is owner-private (ADR-0015 — must-never-leak).
- All mutations route through a single surface (audit-able, no bypass path).
- The functional core (pure math) lives once in `game-core` (SSOT, ADR-0003).

## Considered alternatives

### A. `u64` balance with `saturating_add` cap + `checked_sub` reject (chosen)
One `player_wallet` row per player (PK = `owner_identity`), PRIVATE table (no `public`).
Game-core pure functions `apply_grant` / `apply_spend` contain the math; server-module
wrappers `grant_currency` / `spend_currency` own the table IO. Mirrors ADR-0018 exactly.

**Pros:** negative balance is a type-level impossibility (`u64`), not a runtime check;
saturating grant never panics or wraps; checked_sub rejects before any write; pure
game-core functions are independently testable and WASM-portable.

### B. `i64` balance with runtime `max(0, …)` clamps
Simpler schema (nullable optional), but negative balance is a representable (illegal)
state — violates "make illegal states unrepresentable." Rejected.

### C. Store balance in the `player` table (extend the existing row)
Avoids a new table. Rejected: `player` is PUBLIC (world-readable), and balance is
must-never-leak owner data (ADR-0015). Mixing public and private in one row is unsound.

## Decision outcome

Chosen: **A — private `player_wallet` table, `u64` balance, `apply_grant`/`apply_spend`
pure functions in game-core, server wrappers in `economy.rs`.**

### Consequences

- `player_wallet` is PRIVATE (no `public` attribute). Non-owners cannot subscribe.
- `MAX_BALANCE = 999_999_999` (9-digit, UI-legible, tunable). Grants at cap are no-ops
  (capped, monotone — never shrinks a pre-cap balance).
- `apply_grant(0, _)` is a no-op in the server wrapper (no phantom row). `apply_spend`
  with `amount == 0` is also a no-op (returns `Ok(())`); with `amount > balance` it
  returns `Err("insufficient funds")` and never modifies the row. Both helpers are
  symmetric: a zero-amount call on either direction never touches the DB.
- `spend_currency` has two distinct `Err` variants: `Err("no wallet")` when the player
  has never received any currency (no row exists), and `Err("insufficient funds")` when
  the row exists but the balance is too low. M13b reducers MUST map both to a single
  opaque user-visible error string (e.g. "not enough currency") to avoid leaking wallet
  existence state to clients.
- Every economy path (buy/sell reducers, quest/battle rewards, healing cost) MUST route
  through `grant_currency` / `spend_currency`. A direct `.balance +=` / `.balance -=`
  in any reducer is a review-blocking bypass (enforced by the `currency-integrity` eval).
- M15 (player↔player trade) adds a dual-consent escrow on top of these helpers — no new
  mutation surface (ADR-0022 design intent).

### Residuals

- `MAX_BALANCE` value (999_999_999) is an aesthetic choice; the economy-balance pass
  (M14/Phase-B checkpoint) may tune it. Change is additive (no schema migration).
- Starting balance (0) is tunable by content — `grant_currency` in `join_game` or a
  quest reward. This slice does not grant starting funds.
- Per-owner transport RLS (subscriptions filtered by owner) is deferred to M16
  (no `client_visibility_filter` in the current toolchain — same pattern as inventory,
  ADR-0046). The PRIVATE table ensures no subscription is possible from non-owner clients.
