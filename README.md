# monster-realm (SpacetimeDB)

Multiplayer game on SpacetimeDB. The **server module** (`server/`) is a Rust
crate compiled to WASM and published to a SpacetimeDB instance; the **client**
(`client/`) connects to it.

> CI note: pure module logic is unit-tested off-instance. Full integration tests
> require a running SpacetimeDB instance (`spacetime start`) and are run locally /
> in a dedicated job, not in the default cloud CI. See standards/domain/game.md
> and standards/domain/realtime-chat.md.
