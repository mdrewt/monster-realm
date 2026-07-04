# monster-realm (SpacetimeDB)

Multiplayer game on SpacetimeDB. The **server module** (`server-module/`) is a Rust
crate compiled to WASM and published to a SpacetimeDB instance; the **client**
(`client/`) connects to it.

> CI note: pure module logic is unit-tested off-instance. Full two-window e2e tests
> require a running SpacetimeDB instance and run in a dedicated `e2e` CI job that is
> part of the default `ci.yml` merge gate (ADR-0039, M5b). See
> `../../standards/domain/game.md` and `../../standards/domain/realtime-chat.md`.
