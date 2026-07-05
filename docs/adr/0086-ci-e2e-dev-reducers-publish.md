# ADR-0086 — CI e2e publishes the dev_reducers module via --bin-path (M13.5h)

**Date:** 2026-07-04 · **Status:** Accepted
**Deciders:** build-loop supervisor
**ADR-sequence:** 0086 supervisor-assigned; follows 0084 (M13d shop client view)

## Context

Spec 13.5h (M13.5 seventh-review residuals): `client/e2e/recruit.spec.ts`'s four
`test.fixme` blocks cited a nonexistent "M12.5-recruit infra slice" — a milestone
that appears in ZERO spec-corpus files, and one that `spec-gap-revival.eval.mjs`'s
`EXPIRED_FIXME_MILESTONES` list deliberately excluded. The tripwire could therefore
never fire: the recruit flow (a security-sensitive economy path with a 1,487-line
security eval) sat with no browser-level regression net and no mechanical pressure
to ever revive one — structurally the same failure mode by which M8.95 was silently
skipped. The fixmes' own prescription for revival was a `--bin-path` publish of a
`dev_reducers`-featured module (`start_wild_battle`/`grant_bait` are release-gated
out of the default build and the committed client bindings per ADR-0054).

## Decision

**A. CI pre-builds the dev-features wasm; global-setup publishes it via
`--bin-path`.** The `e2e` job in `.github/workflows/ci.yml` gains one
unconditional step (no `if:`, no `continue-on-error:` — the e2e block must stay
fully blocking per `e2eGateIsBlocking`) after "Pin spacetime 2.6.0":

    cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features dev_reducers

The step exports nothing; instead the "Two-window e2e" step's `env:` gains
`MR_DEV_MODULE_WASM: ${{ github.workspace }}/target/wasm32-unknown-unknown/release/monster_realm_module.wasm`.
`client/e2e/global-setup.ts` — the single publish point — publishes with
`--bin-path "<path>"` when `MR_DEV_MODULE_WASM` is set (non-empty), and keeps the
byte-identical plain `--module-path ../server-module` publish when unset (local
runs unchanged). Spacetime 2.6 `publish` has no cargo-feature passthrough
(ADR-0054), so pre-build-then-`--bin-path` is the only way to publish a
feature-gated module. The committed TS bindings are deliberately NOT regenerated:
dev reducers stay out of the default client bindings. Note the package name is
`monster-realm-module` — `-p server-module` fails.

**B. R1–R3 revived GAMEPLAY-driven; they do NOT call dev reducers.** The revived
recruit e2e tests reach battles by walking into grass (bounded shuttle), weaken
via real skill clicks, recruit via the real recruit action, and observe outcomes
via DOM + `__game()` snapshots (R3 additionally cross-checks `SideAWins` via
`spacetime sql` — the terminal the recruit success writes per ADR-0047). No test
invokes `start_wild_battle` or `grant_bait`.

**C. R4 re-anchored to a real named blocker.** The bait-flow test cannot run
today: bait requires a grant path the page cannot reach (see Alternatives), so R4
is re-anchored to the genuine revival condition — a client slice exposing a
test-only bait-grant/battle-start hook on `__game()` — instead of a phantom
milestone.

### The honest rationale: the dev publish currently has NO test consumer

Decision A ships even though B means no revived test calls a dev reducer. It
lands because:

1. the spec (13.5h-1) mandates the `--bin-path` dev_reducers publish explicitly;
2. it compiles the `dev_reducers` feature set on every PR — feature-gated code
   can no longer rot uncompiled;
3. it mechanically unblocks a future client slice exposing `__game()` dev hooks
   (bait grant / battle start) with ZERO further CI change — only the client and
   the test change;
4. the new spec-gap-revival detector's forcing premise ("a workflow publishes
   dev_reducers ⇒ no `test.fixme` may cite dev_reducers") requires the publish to
   exist for the tripwire to be armed at all.

## Alternatives rejected

- **Browser-identity HTTP calls to the dev reducers** (call `grant_bait` for the
  page's player from the test runner): the client `DbConnection` is built without
  `.withToken` and the SpacetimeDB SDK persists no token, so neither the page nor
  the HTTP API can authenticate AS the browser's player identity. Rejected as
  impossible, not merely inconvenient.
- **`main.ts` `__game()` dev hooks now:** `client/src` is owned by the concurrent
  m13.5b slice (touches-collision). Deferred — this is exactly the future slice
  Decision A mechanically unblocks.
- **Regenerating TS bindings from the dev build:** forbidden; the default
  `spacetime generate` has no feature passthrough (ADR-0054), so dev-featured
  bindings would drift from every non-dev regeneration and re-open the
  release-gating hole ADR-0054 closed.

## Consequences

- **e2e job cost:** ~+1 min for the dual-feature-set compile. `rust-cache`
  (`prefix-key: v1-e2e`) caches both feature variants side by side — feature
  flags change the crate hash, not the cache key — so no cache invalidation
  (ADR-0043/0050 caching posture unchanged).
- **golden/zoneSync unaffected:** verified — their scripted walk paths never
  enter grass, so publishing dev reducers (which only ADD reducers) changes no
  observed behavior.
- **e2e is now explicitly single-worker** (`workers: 1` in
  `client/playwright.config.ts`). All spec files share ONE published db, and
  golden.spec asserts an exact player population (`presenceCount === 2`);
  `fullyParallel: false` only serializes within a file, so once recruit.spec
  (which keeps a player joined for minutes) landed, cross-file worker
  parallelism made golden unreachable — observed locally as 3 workers; CI's
  4-vCPU runners would fan out to 2 and hit the same collision. Single-worker
  completes the serialization the config always intended, at the cost of the
  formerly overlapped golden+zoneSync wall-time (~40 s).
- **R2 revival is numerically marginal** (80‰ base recruit rate; the weaken-first
  strategy raises per-encounter odds to ≥40%) and carries a documented decision
  gate: if local ≥3-run validation shows flake or time overrun (>~150 s), R2+R3
  re-anchor to the same real named blocker as R4.
- The spec-gap-revival eval now RED-flags any future `test.fixme` citing
  dev_reducers anywhere in `client/e2e/*.spec.ts`, since a workflow now publishes
  it — revival is mechanical, not curated (ADR-0050 gate-of-gates posture). The
  workflow-side detector recognises three forms — the `--features dev_reducers`
  build line, a direct `--bin-path` publish, and the `MR_DEV_MODULE_WASM` env
  line; the env line is the load-bearing anchor (it must stay in the workflow
  for global-setup to receive the path, so build-step refactors can't silently
  disarm the tripwire).

## ADR references

- ADR-0054: dev-reducer release-gating; no cargo-feature passthrough in
  `spacetime publish`/`generate` — the constraint that forces pre-build +
  `--bin-path`.
- ADR-0047: recruit resolution semantics (`SideAWins` terminal, battle-row GC) —
  the observables the revived R2/R3 assert.
- ADR-0050: CI-policy SSOT / gate-of-gates ratchet — the posture this publish +
  detector pair extends to the recruit e2e surface.
