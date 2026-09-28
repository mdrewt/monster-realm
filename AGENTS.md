# AGENTS.md — monster-realm

Project rules for coding agents. Inherits the workspace `AGENTS.md`. Architecture:
`ARCHITECTURE.md`. Decisions and their reasons: `docs/DECISIONS.md`.

## Toolchain (pinned)

| Tool | Version | Pin |
|---|---|---|
| Rust | 1.96.0 + `wasm32-unknown-unknown`, clippy, rustfmt | `rust-toolchain.toml` |
| spacetime CLI / host + `spacetimedb` crate | 2.8.1, always equal | root `Cargo.toml`; `Pin spacetime` steps in `.github/workflows/{ci,nightly}.yml` (`spacetime version use 2.8.1`) |
| npm `spacetimedb` SDK | 2.6.0 | `client/package-lock.json` |
| Node | 24.13.1 (`>=24.13.1 <25`) | `client/package.json` `engines`, workflows |
| wasm-pack | 0.15.0 | workflows |

## Run

`just setup` · `just wasm` · `just ci` (the merge gate) · `just ci-fast <crate>` ·
`just test` · `just lint` · `just eval` · `just client-test` · `just gen` · `just e2e`
(needs a running SpacetimeDB). Local play: `just playtest-up` (see `README.md`).

## Invariants

1. **game-core is the only place rules live.** Server reducers and the TypeScript
   client call it; they never re-implement a rule. Rust code never reads a wall clock
   or unseeded RNG (`clippy.toml` fails the lint).
2. **Reducers are thin and reject instead of clamping.** Identity comes from
   `ctx.sender()`; validate, call `game-core`, write; refuse with `Err`. Shared checks
   live in `server-module/src/guards.rs`.
3. **SpacetimeDB 2.x syntax:** `#[spacetimedb::table(accessor = x)]`, `ctx.sender()`,
   `ctx.database_identity()`. Details: `.claude/skills/spacetimedb-reducer`.
4. **Never hand-edit `client/src/module_bindings/`.** Regenerate with `just gen`; the
   `bindings-drift` eval fails on stale bindings.
5. **Never copy a game-core constant into TypeScript.** Export it from
   `client-wasm/src/lib.rs` and import that.
6. **Live-data safety.** New columns go at the end with a `#[default]`; any edit
   under `game-core/content/` bumps `CONTENT_VERSION` (`server-module/src/lib.rs`) and
   regenerates `evals/baselines/content-hash.json` (the eval prints the command).
   Per-player tables stay private behind an owner-scoped view.

## Code navigation

Two code graphs index this repo: CodeGraph (`.codegraph/`) and codebase-memory-mcp.
Before changing a shared `game-core` signature, list its callers from both graphs
plus a grep for dynamically invoked names.
