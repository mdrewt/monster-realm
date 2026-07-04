# m13a — Currency Primitive: Plan

**Slice:** M13 Economy & Inventory, slice a (serial spine)
**ADR assigned:** 0081
**Touches (declared, fan-out-ineligible — schema + bindings):**
- `game-core/src/currency.rs` (NEW)
- `game-core/src/lib.rs` (add `pub mod currency` + re-exports)
- `server-module/src/schema.rs` (additive: `PlayerWallet` table)
- `server-module/src/economy.rs` (NEW)
- `server-module/src/lib.rs` (add `mod economy`)
- `evals/currency-integrity.eval.mjs` (NEW)
- `docs/adr/0081-currency-primitive.md` (NEW)
- `client/src/module_bindings/**` (regenerated)

## Design (mirrors ADR-0018/inventory.rs, mandated by ADR-0022)

### Privacy invariant (ADR-0015)
`player_wallet` is PRIVATE (no `public` attribute). Balance is must-never-leak
owner data — neither a world-readable public projection nor a client_visibility_filter
(unsupported in this toolchain). A non-owner client cannot subscribe.

### Functional core (game-core/src/currency.rs)
Pure, injected-context-free functions:
- `MAX_BALANCE: u64 = 999_999_999` — 9-digit cap (UI-legible, tunable per ADR-0081 residual)
- `apply_grant(balance: u64, amount: u64) -> u64` — saturating_add capped at MAX_BALANCE
- `apply_spend(balance: u64, amount: u64) -> Result<u64, &'static str>` — checked_sub, Err on insufficient

### Schema (server-module/src/schema.rs — additive)
```
PlayerWallet { owner_identity: Identity (PK), balance: u64 }
```
PRIVATE (no `public`). PK = owner_identity → one row per player.

### Imperative shell (server-module/src/economy.rs)
- `grant_currency(ctx, owner, amount)` — 0-amount no-op; upsert via apply_grant
- `spend_currency(ctx, owner, amount) -> Result<(), String>` — find or Err("no wallet"); apply_spend or Err("insufficient funds")

### Anti-patterns to avoid
- No unchecked `+=` or bare `-` on balance (lint target for the eval)
- No `public` on player_wallet (privacy fixture)
- No direct field mutation bypassing the helpers (single-surface discipline)
- No signed integer for balance (u64 → negative is a compile error)

## EARS → Tests mapping

| EARS criterion | Test |
|---|---|
| Saturating cap on grant | `apply_grant(MAX_BALANCE, 1) == MAX_BALANCE` |
| Never negative | `apply_spend(0, 1) == Err("insufficient funds")` |
| Reject on insufficient | `apply_spend(50, 100) == Err("insufficient funds")` |
| 0-grant no-op | grant_currency(0) leaves no phantom row |
| Privacy (non-owner sees nothing) | eval: `player_wallet` has no `public` attribute |
| Monotone grant | property: `apply_grant(b, a) >= b` always |
| Spend is bounded | property: `apply_spend(b, a).ok() <= b` always |
| Overflow safety | `apply_grant(u64::MAX, u64::MAX) == MAX_BALANCE` |
| Single surface | eval: no `.balance +=` / `.balance -=` in economy.rs |

## Proof-of-teeth fixtures (eval: currency-integrity.eval.mjs)

1. **SATURATING_CAP** — injects `balance.saturating_add(amount)` without `.min(MAX_BALANCE)` → FAIL
2. **CHECKED_SUB** — injects bare `balance - amount` without checked_sub → FAIL
3. **PRIVATE_TABLE** — adds `public` to player_wallet → FAIL
4. **ZERO_GRANT_GUARD** — removes the `if amount == 0 { return; }` guard → FAIL (phantom row possible)
5. **SINGLE_SURFACE** — adds a direct `.balance +=` bypass → FAIL

## Sequence

1. ✅ Worktree created (`feat/m13a-currency-primitive`)
2. [ ] Tests written (tester agent, start red)
3. [ ] Implement (specialist agent, red→green)
4. [ ] Review pass (reviewer + red-team + simplify — parallel)
5. [ ] Full `just ci` green
6. [ ] Doc-keeper (ADR + memory + ARCHITECTURE)
7. [ ] Bindings regen + PR open

## Deferrals (not in this slice)
- Shop content (RON) + buy/sell reducers → m13b
- Sinks/sources wiring (healing cost, quest/battle rewards) → m13c
- Frontend shop screen + wallet display → m13d
