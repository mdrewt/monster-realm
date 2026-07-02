# ADR catalog — monster-realm

Architecture Decision Records live in **two locations**; check both.

- **Design ADRs `0002`–`0034`** — in the **harness spec corpus**
  (`../../specs/monster-realm-v2/adr/`). These are the foundational design
  decisions authored alongside the milestone specs.
- **Implementation ADRs `0001`, `0035`–`0054`** — in **this directory**
  (`docs/adr/`). These record decisions made while building the milestones.
- **`0001`** (record-architecture-decisions) is mirrored in both locations.

Resolving a reference: an ADR numbered `0002`–`0034` → harness spec corpus;
`0001` or `0035`+ → `docs/adr/`. Next free number: **`0068`**.

## ADRs in `docs/adr/`

| ADR | Title | Milestone |
|----:|-------|-----------|
| [0001](./0001-record-architecture-decisions.md) | Record architecture decisions | M0 |
| [0035](./0035-scaffold-hardening.md) | Scaffold hardening — robust secret-scan + SpacetimeDB-stack `.gitignore` | M0 |
| [0036](./0036-client-wasm-bindgen.md) | `wasm-bindgen` + `wasm-pack` for the client-prediction boundary | M3 |
| [0037](./0037-spacetimedb-content-deps.md) | SpacetimeDB module SDK + RON content dependencies | M6a |
| [0038](./0038-proptest.md) | `proptest` for property-testing the logic-heavy rules | M7a |
| [0039](./0039-e2e-in-ci-spacetime.md) | Two-window e2e as a CI gate against a pinned standalone SpacetimeDB | M5b |
| [0040](./0040-rls-fallback-split-tables.md) | RLS fallback: private table + public projection for monster privacy | M6b |
| [0041](./0041-integer-damage-formula.md) | Integer-only damage formula with injected variance (u64 intermediates) | M7a |
| [0042](./0042-battle-table-public-pve.md) | Battle table is public (PvE scope) | M7b |
| [0043](./0043-ci-caching-fast-inner-loop.md) | CI caching + fast inner loop | M-infra-a |
| [0044](./0044-encounter-table-private.md) | Encounter table: private with no projection | M8b |
| [0045](./0045-wild-individuality-private-table.md) | Wild individuality: private `battle_wild` side-table (seed-keyed) | M8c |
| [0046](./0046-player-inventory-model.md) | Player inventory: additive owner-scoped stack table, bait classified by data | M8d |
| [0047](./0047-recruit-resolution-semantics.md) | Recruit resolution: reuse `SideAWins`, full-HP no-XP grant, GC `battle_wild` | M8d |
| [0048](./0048-start-battle-opponent-provenance.md) | `start_battle` opponent-provenance authorization (reject-not-clamp) | M8.5a |
| [0049](./0049-panic-as-content-invariant-policy.md) | Panic-as-content-invariant policy in the pure core (+ rule-core contracts) | M8.5b |
| [0050](./0050-nightly-mutation-coverage-and-bindings-drift-in-ci.md) | Nightly mutation/coverage gates (not per-PR) + bindings-drift in fast `ci` | M8.5c |
| [0051](./0051-biome-lint-scope.md) | Biome as the TS/JS style+lint gate: scope, exclusions, deferred lint debt | M8.5d |
| [0052](./0052-bounded-client-prediction-queue-cap.md) | Bounded client prediction to the move-queue cap (no over-prediction rubberband) | M8.5f |
| [0053](./0053-swap-legality-as-pure-core-invariant.md) | Swap legality as a pure-core invariant (checked `set_active`) | M8.6a |
| [0054](./0054-dev-reducer-release-gating.md) | Dev/test-reducer release-gating (`#[cfg(feature="dev_reducers")]`) + zone reject-not-clamp + inventory single-stack as a mechanical gate | M8.7b |
| [0055](./0055-release-fail-loud-determinism-gate.md) | Release fail-loud + determinism-gate completeness (overflow-checks + RNG/clock/OS-entropy sinks) | M8.8a |
| [0056](./0056-server-module-modularization.md) | server-module internal module boundary (domain submodules) — the canonical `touches:` vocabulary | M8.9a/b |
| [0057](./0057-content-directory-glob-loading.md) | Content as glob-loaded `content/<registry>/*.ron` directories via a `build.rs` embed | M8.9e |
| [0058](./0058-raising-ev-training-care.md) | Raising rules — EV focus-training (top-off) and care (bond) as pure-core invariants | M9a |
| [0059](./0059-raising-server-care-cooldown-inventory-reconcile.md) | M9b server raising — `care` + per-monster cooldown, inventory-backbone reconcile, `train` split | M9b |
| [0060](./0060-evolution-fusion-content-shape.md) | Evolution/fusion content shape — separate cross-referenced registry + additive `validate_evolution_fusion` integrity checks | M10a |
| [0061](./0061-evolution-fusion-transform-rules.md) | Evolution/fusion transform rules — pure, individuality-preserving transforms in `game-core/src/evolution/` | M10a |
| [0062](./0062-evolution-fusion-server-reducers.md) | Evolution & fusion server reducers — guard ordering, seam placement, growth-writer registration | M10b |
| [0063](./0063-evolution-fusion-client-overlay.md) | Evolution & fusion client overlay — KeyE EvolutionView, pure view-model seam, fusion recipe display | M10c |
| [0064](./0064-m10d-evolution-fusion-content-integrity-evals.md) | Evolution/fusion content-integrity + reducer-security evals (Phase A eval harness completion) | M10d |
| [0065](./0065-zone-map-warp-data-shape.md) | Zone map + warp data shape — warps-in-TileMap overlay list, content.rs data / world.rs rules split, std-only Tiled importer, standalone validate_zone_maps | M11a |
| [0066](./0066-server-warp-runtime.md) | Server-authoritative warp runtime — per-zone schedules, warp detection, zone-map validation | M11b |
| [0067](./0067-follow-camera-and-warp-resubscribe.md) | Client follow-camera + zone warp resubscribe — global character subscription, onUpdate warp detection | M11c |

ADR-0041 (amended M8.5e) and ADR-0042 (amended M8.5a) carry appended amendment
sections; the original decision text is preserved as the historical record.

See also [`template.md`](./template.md) (the MADR template) and
`../validation-findings.md` (empirical Tier-1 results).
