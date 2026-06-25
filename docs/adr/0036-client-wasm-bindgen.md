# ADR-0036: `wasm-bindgen` + `wasm-pack` for the client-prediction boundary

- **Status:** Accepted
- **Date:** 2026-06-25
- **Context milestone:** M0a (shared-core isolation & prediction parity)
- **Implements:** ADR-0003 (pure Rust `game-core` → wasm for client prediction)

## Context

ADR-0003 commits to the client predicting with the *same compiled rule code* the
server runs, delivered to the browser as wasm. That requires a concrete wasm
toolchain and a JS boundary. M0a needs it now to stand up the **prediction-parity
eval** (the anti-desync spine) on the trivial M0 rule, so M1 movement plugs into
an existing gate.

## Decision

Adopt **`wasm-bindgen`** (the `[workspace.dependencies]` SSOT, `0.2`) for the
`client-wasm` boundary and **`wasm-pack`** (pinned in the toolchain) to build it.
`client-wasm` is `crate-type = ["cdylib", "rlib"]`: `cdylib` is the wasm artifact,
`rlib` lets the same export be host-tested. `u64` crosses the boundary as `BigInt`.

`client-wasm` depends on `game-core` **without** the `spacetimedb` feature; the
feature-isolation eval proves the client build graph never pulls a server-only
dependency. The prediction-parity eval builds the wasm and asserts its output is
byte-identical to the native `game-core` path, with a baked-in proof-of-teeth
(the comparator must reject a synthetic divergence).

## Consequences

- The wasm boundary is real and gated from M0a; M1+ rules inherit the parity gate.
- `pkg/` (wasm-pack output) is a build artifact (gitignored), rebuilt by the eval
  and by CI; CI builds it once and shares it with the frontend job (M0 spec §4).
- wasm-bindgen/wasm-pack versions are pinned and bumped deliberately (Renovate).
- Considered alternatives (rejected, per ADR-0003): re-implementing the rule in
  TypeScript (the desync bug); a Rust/`bevy`→wasm whole-client (heavier, deferred
  to ADR-0004's rejected alternatives).
