---
name: spacetimedb-reducer
description: Writing or modifying SpacetimeDB reducers, table definitions, schema changes, or server-module Rust code in monster-realm (v2). Server-authoritative, integer-tile, data-driven.
---

# SpacetimeDB Reducer Authoring (monster-realm v2)

> **Versions (all 2.x as of 2026-08-16 — ADR-0197).**
>
> | Piece | Version |
> |---|---|
> | `spacetime` CLI + host | **2.8.1** |
> | `spacetimedb` **Rust crate** (this module) | **2.8.1** |
> | `spacetimedb` npm (client) | 2.6.0 (`^2.6.0`) — deliberately not yet bumped |
>
> The crate version **is** the product version; keep it equal to the CLI. (An older note here
> claimed they were "decoupled" and left the module on the pre-2.0 crate `1.12.0` for six
> months — see ADR-0197. If you ever see `spacetimedb = "1.12"` again, that is the bug.)
>
> **Write 2.x syntax.** If you are copying from an old commit, a memory card, or a pre-2026-08-16
> ADR, these three spellings changed:
>
> | | 1.x (OLD — will not compile) | **2.x (write this)** |
> |---|---|---|
> | table/view/index attr | `#[spacetimedb::table(name = player, public)]` | `#[spacetimedb::table(accessor = player, public)]` |
> | caller identity | `ctx.sender` (a field) | `ctx.sender()` (a **method**) |
> | module identity | `ctx.identity()` | `ctx.database_identity()` (the former is deprecated, and CI runs clippy `-D warnings`) |
>
> On `accessor` vs `name`: `accessor` names the **Rust accessor** and is required; `name` is now
> an optional **string literal** overriding the canonical SQL table name, which defaults to the
> accessor identifier. That default is why the migration renamed no tables.
>
> **Docs:** `gitmcp-spacetimedb` serves the repo's **master** branch — now broadly correct for
> this module, but still ahead of the 2.8.1 pin, so confirm anything load-bearing against
> https://docs.rs/spacetimedb/2.8.1 or the vendored crate source. The harness SSOT for platform
> behavior is `docs/research/spacetimedb.md` **in the harness repo root** (the workspace two
> levels above `projects/monster-realm/`), not a path relative to this skill.
>
> `spacetime mcp` (CLI 2.8.1, UNSTABLE) is a **live-database** bridge — `get_schema`, `sql`,
> `call`, `ping` against a *running* instance. It is not a docs server.
>
> Honor the ADRs (`docs/adr/`): 0002 (server platform), 0006 (additive schema), 0011 (the tick), 0015 (RLS = defense-in-depth), 0016 (individuality), 0197 (the 2.8.1 upgrade).

## Reducer contract

- Return `Result<(), String>` (or a typed error). An `Err` aborts the transaction — use it; never silently clamp.
- Deterministic, side-effect-free except table writes. No `std::net`/`std::fs`, no mutable globals (clippy enforces).
- Time: `ctx.timestamp` — never `std::time`. Randomness: `ctx.rng()` — never `rand::thread_rng()`. Identity: **`ctx.sender()`** (a method in 2.x) — never trust a client-passed field.
- The reducer is a **thin shell** over `game-core`: read authoritative rows → call the pure rule → write rows back. Never reimplement a rule that belongs in `game-core`.

## Validation checklist (every reducer taking client input)

1. `ctx.sender()` owns / is authorized for the target entity.
2. Resources/cooldowns sufficient (read from authoritative rows).
3. Input within valid range — **reject with `Err`, never clamp** (Postel inverted, per this project's AGENTS.md).
4. Rate-limit floods with a cooldown check.
5. **Escrow guard family:** monster-mutating reducers (battle/trade/raise/evolve/fuse) call `reject_if_in_battle` / `reject_if_in_trade` so a monster can't be in two stakes at once.

## v2 specifics (differ from v1)

- **Individuality naming (ADR-0016):** the domain types are `IVs` / `EVs` / `Nature` — **not** v1's `Potential`/`Temperament`/`Training`. Hidden stats live in **owner-private tables**.
- **RLS DOES NOT WORK — do not "modernize" onto it (ADR-0015, ADR-0180 D18a, ADR-0197).** `#[client_visibility_filter]` is behind the `unstable` Cargo feature **and** the crate carries `// TODO: RLS filters are currently unimplemented, and are not enforced.` — verified **identical at 1.12.0 and 2.8.1**, so the 2.8.1 upgrade did *not* change this. A module declaring one publishes clean and filters nothing. Must-never-leak data (hidden IVs, ranked picks, PII) goes in a **private table** exposed through an **owner-scoped `#[view]`** (`my_wallet`/`my_conversation`/`my_monster_pub` — ADR-0087/0154/0194). Re-check that TODO on the next bump before believing otherwise.
- **Additive schema (ADR-0006):** shape new tables so later extensions are additive — no breaking migration. PvP-ready battle keying from the start: synthetic `battle_id` + indexed `opponent_identity`.
- **Integer-tile authority:** positions/rules are integer tiles; `apply_move` is **total** (an illegal move is a legal no-op / bump, not an error).

## Schema / type change checklist

After ANY table/type change (paths are `server-module`, not `server` — match the `justfile`):
1. `just publish` (= `spacetime publish --module-path server-module monster-realm`)
2. `just gen` (= `spacetime generate --lang typescript --module-path server-module --out-dir client/src/module_bindings`)
3. Rebuild client prediction WASM if shared `game-core` types changed: `wasm-pack build client-wasm --target bundler` (wasm-pack 0.15.0).
4. Re-run the **bindings-drift** + **schema-snapshot/append-only** evals.

## Gotchas

_Living log — symptom/quirk → cause → **avoid:** action. Append as you hit them._

- **RLS (`client_visibility_filter`) does not filter at all** → `unstable`-gated + "currently unimplemented, and are not enforced" in the crate at **both 1.12.0 and 2.8.1**. **Avoid:** private table + owner-scoped `#[view]`; never let an RLS rule be the only boundary.
- **A scheduled reducer is client-callable** → the module is now on 2.x, where scheduled functions are private by default, so the explicit guard is belt-and-braces rather than the sole defence. **Avoid:** keep `if ctx.sender() != ctx.database_identity() { return Err(..) }` as the first statement anyway — it is pinned by `ea_reaper_03`, `ea_pvp_02`, `ea_chr_03`, `g7`, `auth27` and `scan_playtest_reaper_*`. Removing it is a security-posture change and needs an ADR, not a cleanup commit.
- **A "fact" about the CLI inferred from `--help`** → `spacetime build --features` **does exist** (verified in the CLI source at v1.11.0 through v2.8.1) but is `.hide(true)`, so it never appears in `--help`. ADR-0054 inferred "no cargo-feature passthrough" from its absence there. **Avoid:** confirm a flag's absence in the tagged CLI source, not just `--help`.
- **`spacetime describe --json` changed shape with CLI 2.8.0** (a CLI property, NOT a host one — the CLI requests schema `version=10` and upgrades a v9 fallback before printing) → `RawModuleDefV10` = `{"sections":[…,{"Reducers":[…]}]}` with the field spelled **`source_name`**, not `name`, instead of the flat `{"reducers":[{"name":…}]}`. **Fixed** in `scripts/verify-release-reducers.mjs` (accepts both, fail-loud preserved; V9+V10 fixtures in `playtest-verify.eval.mjs`). **Avoid:** if you write another `describe --json` consumer, branch on the payload shape, never on a probed version.
- **`spacetime generate` flag drift** → flags vary by CLI version. **Avoid:** check `spacetime generate --help` on the installed CLI before scripting.
- **Silent client/server drift after a schema/type change** → forgot to regenerate. **Avoid:** publish → generate → rebuild wasm → run the bindings-drift eval.
- **A monster ends up in two stakes (battle + trade)** → missing escrow guard. **Avoid:** every monster-mutating reducer calls the `reject_if_in_*` guard family.
