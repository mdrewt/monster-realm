---
name: spacetimedb-reducer
description: Writing or modifying SpacetimeDB reducers, table definitions, schema changes, or server-module Rust code in monster-realm (v2). Server-authoritative, integer-tile, data-driven.
---

# SpacetimeDB 2.6 Reducer Authoring (monster-realm v2)

> Before writing/changing server code, fetch current docs: `gitmcp-spacetimedb` MCP → SpacetimeDB 2.6 API. Honor the ADRs (`docs/adr/`): 0002 (server platform), 0006 (additive schema), 0011 (the tick), 0015 (RLS = defense-in-depth), 0016 (individuality).

## Reducer contract

- Return `Result<(), String>` (or a typed error). An `Err` aborts the transaction — use it; never silently clamp.
- Deterministic, side-effect-free except table writes. No `std::net`/`std::fs`, no mutable globals (clippy enforces).
- Time: `ctx.timestamp` — never `std::time`. Randomness: `ctx.rng()` — never `rand::thread_rng()`. Identity: `ctx.sender()` — never trust a client-passed field.
- The reducer is a **thin shell** over `game-core`: read authoritative rows → call the pure rule → write rows back. Never reimplement a rule that belongs in `game-core`.

## Validation checklist (every reducer taking client input)

1. `ctx.sender()` owns / is authorized for the target entity.
2. Resources/cooldowns sufficient (read from authoritative rows).
3. Input within valid range — **reject with `Err`, never clamp** (Postel inverted, per this project's AGENTS.md).
4. Rate-limit floods with a cooldown check.
5. **Escrow guard family:** monster-mutating reducers (battle/trade/raise/evolve/fuse) call `reject_if_in_battle` / `reject_if_in_trade` so a monster can't be in two stakes at once.

## v2 specifics (differ from v1)

- **Individuality naming (ADR-0016):** the domain types are `IVs` / `EVs` / `Nature` — **not** v1's `Potential`/`Temperament`/`Training`. Hidden stats live in **owner-private tables**.
- **RLS = defense-in-depth (ADR-0015):** `client_visibility_filter` is stakes-classified; must-never-leak data (hidden IVs, ranked picks, PII) goes in **private tables**, not merely behind an RLS rule (it was experimental — verify it filters).
- **Additive schema (ADR-0006):** shape new tables so later extensions are additive — no breaking migration. PvP-ready battle keying from the start: synthetic `battle_id` + indexed `opponent_identity`.
- **Integer-tile authority:** positions/rules are integer tiles; `apply_move` is **total** (an illegal move is a legal no-op / bump, not an error).

## Schema / type change checklist

After ANY table/type change:
1. `spacetime publish --module-path server monster-realm`
2. `spacetime generate --lang typescript --out-dir client/src/module_bindings --module-path server`
3. Rebuild client prediction WASM if shared `game-core` types changed: `wasm-pack build client-wasm --target bundler` (wasm-pack 0.15.0).
4. Re-run the **bindings-drift** + **schema-snapshot/append-only** evals.

## Gotchas

_Living log — symptom/quirk → cause → **avoid:** action. Append as you hit them._

- **RLS (`client_visibility_filter`) may not actually filter** on the pinned version (experimental / "not fully enforced"). **Avoid:** verify with two identities; put must-never-leak data in **private tables** (ADR-0015 fallback), not just an RLS rule.
- **A scheduled reducer is client-callable** → 2.x changed scheduled-reducer privacy + renamed the module-identity accessor. **Avoid:** guard `ctx.sender() != ctx.identity()`; confirm the accessor name on pinned 2.6.0.
- **`spacetime generate` flag drift** → flags vary by CLI version. **Avoid:** check `spacetime generate --help` on the pinned 2.6.0 before scripting.
- **Silent client/server drift after a schema/type change** → forgot to regenerate. **Avoid:** publish → generate → rebuild wasm → run the bindings-drift eval.
- **A monster ends up in two stakes (battle + trade)** → missing escrow guard. **Avoid:** every monster-mutating reducer calls the `reject_if_in_*` guard family.
