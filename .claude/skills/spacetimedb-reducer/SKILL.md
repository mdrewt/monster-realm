---
name: spacetimedb-reducer
description: Writing or modifying SpacetimeDB reducers, table definitions, schema changes, or server-module Rust code in monster-realm (v2). Server-authoritative, integer-tile, data-driven.
---

# SpacetimeDB reducer authoring (monster-realm v2)

> **Versions.** `spacetime` CLI/host 2.8.1 · Rust `spacetimedb` crate 2.8.1 (this
> module) · npm `spacetimedb` 2.6.0 (client, upgraded separately). The crate version
> is the product version; keep it equal to the CLI (`docs/runbooks/spacetimedb-upgrade.md`).
>
> **Write 2.x syntax.** Old commits and examples use 1.x spellings that do not compile:
>
> | | 1.x (old) | **2.x (write this)** |
> |---|---|---|
> | table/view attribute | `#[spacetimedb::table(name = player, public)]` | `#[spacetimedb::table(accessor = player, public)]` |
> | caller identity | `ctx.sender` (field) | `ctx.sender()` (method) |
> | module identity | `ctx.identity()` | `ctx.database_identity()` (the old spelling is deprecated, and clippy runs with `-D warnings`) |
>
> `accessor` names the Rust accessor and is required; `name` is an optional string
> overriding the SQL table name, which defaults to the accessor.
>
> **Docs:** `gitmcp-spacetimedb` serves the repository's master branch, which is ahead
> of 2.8.1. Confirm anything load-bearing against https://docs.rs/spacetimedb/2.8.1 or
> the vendored crate source. The harness research note on platform behaviour is
> `docs/research/spacetimedb.md` in the harness repository root (two levels above
> `projects/monster-realm/`). `spacetime mcp` (CLI 2.8.1, unstable) talks to a running
> database, not the docs.

## Reducer contract

- Return `Result<(), String>`. An `Err` aborts the whole transaction; use it, and never
  silently clamp.
- Deterministic apart from table writes. No `std::net`/`std::fs`, no mutable globals,
  no `std::time` (clippy enforces this).
- Time: `crate::marshal::now_ms(ctx)` (from `ctx.timestamp`). Randomness:
  `ctx.random()`, mapped through a `game-core` helper such as
  `TurnVariance::from_ctx_random`. Identity: `ctx.sender()`; never trust a client-passed
  identity.
- A reducer is a thin shell over `game-core`: read rows, call the pure rule, write
  rows. Shared checks live in `server-module/src/guards.rs`. A module writes only its
  own tables; for another module's table, call that module's `pub(crate)` helper.

## Validation checklist (every reducer taking client input)

1. `ctx.sender()` owns or may act on the target (`guards::require_owner`).
2. Resources and cooldowns come from authoritative rows.
3. Input is in range; **reject with `Err`, never clamp.**
4. Floods are bounded (cooldowns, size limits before any O(N) work).
5. A monster cannot be in two stakes at once: monster-mutating reducers call
   `reject_if_in_battle` / `reject_if_monster_in_trade`, and currency or item spends
   subtract `escrowed_currency_amount` / `escrowed_item_qty`.
6. A caller whose account is pending deletion cannot open new commitments: call
   `guards::require_not_deleting` before any write, as the existing reducers do.
7. A scheduled reducer's first statement is
   `if ctx.sender() != ctx.database_identity() { return Err(..) }`. Scheduled
   functions are private by default in 2.x; keep the guard anyway.

## v2 specifics

- **Individuality:** the domain types are `IVs`, `EVs`, `Nature`. Hidden genes live in
  the private `monster` table; the owner reads the `monster_pub` projection through
  `my_monster_pub`.
- **Row-level security does not work.** `#[client_visibility_filter]` is behind the
  `unstable` feature, and the crate says "RLS filters are currently unimplemented, and
  are not enforced" (vendored `spacetimedb-2.8.1/src/lib.rs`). Per-player data goes in a
  **private table** read through an **owner-scoped `#[spacetimedb::view]`** whose body
  filters on `ctx.sender()` and takes no identity argument (`my_wallet`, `my_inventory`,
  `my_battle`, ... in `schema.rs`).
- **Integer tiles:** `apply_move` is total (an illegal move is a no-op bump).

## Schema and type changes

- **Additive only on live data.** Append new columns at the end with a `#[default]`
  (type `i64` defaults explicitly, e.g. `#[default(0i64)]`; an untyped `0` fails the
  publish). No mid-struct inserts, removals, type changes or enum reordering. Whether a
  table is scheduled is fixed at first publish.
- **Every new table** needs an entry in `schema::DATA_LIFECYCLE_MANIFEST` (a test fails
  otherwise) and, if the owner should see it, a view. The `battle-schema-snapshot` and
  `spacetime-type-snapshot` evals record columns and nested types; update their
  baselines deliberately.
- **Content edits** (`game-core/content/`) bump `CONTENT_VERSION` in `lib.rs` and
  regenerate `evals/baselines/content-hash.json`.
- Then: publish, `just gen` (never hand-edit bindings), `just wasm` if shared
  `game-core` types changed, and `just eval`.

## Gotchas

- **Views need a private table behind them** → subscribing the private table from the
  client fails the whole batch. **Avoid:** the view is the only client read path.
- **Cross-module `ctx.db.x()` does not compile** → the generated accessor trait is not
  in scope. **Avoid:** `use crate::schema::x;`.
- **A scheduled table does not resolve** → its reducer is in another module. **Avoid:**
  declare the schedule table next to its reducer.
- **Publish aborts with "requires a manual migration"** → a non-additive change (or an
  encoding change after a crate upgrade). **Avoid:** additive changes; see the upgrade
  runbook for the `--delete-data` case.
- **A "fact" about the CLI inferred from `--help`** → `spacetime build --features`
  exists but is hidden from `--help`. **Avoid:** confirm in the tagged CLI source.
- **`spacetime describe --json` shape** → CLI 2.8.x prints `{"sections": [...]}` with
  reducers under `source_name`; older CLIs print `{"reducers": [{"name": ...}]}`.
  `scripts/verify-release-reducers.mjs` accepts both. **Avoid:** branch on the payload
  shape, never on a probed version.
- **Client and server drift after a schema change** → bindings not regenerated.
  **Avoid:** `just gen`; `bindings-drift` fails otherwise.
