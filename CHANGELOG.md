# Changelog


### Documentation

- ARCHITECTURE.md — durable design record linking the ADRs
- Add spacetimedb-client (SDK connect/subscribe, per-tx coalesce, convert shapes)
- Documentation accuracy sweep — damage u64, XP formula, ADR catalog (M8.5e) (#30)
- Record M8.6d closure — loser_base_stat_total doc-comment subsumed by M8.5b (M8.6d) (#35)
- Correct false owner_identity RLS claim + add false-RLS eval gate (M8.7d) (#40)

### Features

- Cargo workspace + determinism clippy gate + pure game-core rule layer
- Feature-isolation + prediction-parity evals via wasm-pack
- Sim-harness seeded netcode link + netcode-determinism eval
- Presence vertical — spacetimedb module + RON content + sync_content
- TS bindings + zoned-schema/append-only-ids/bindings-drift evals
- Pure movement core (apply_move) + movement-parity eval
- PixiJS client + multi-client Playwright e2e (walking skeleton)
- Authoritative zoned movement — character/player + per-zone tick
- Client prediction layer — wasm bridge + convert + Predictor
- AuthoritativeStore — keyed-Map mirror, 2-snapshot history, batch signal
- Connection adapter — per-zone subscribe, row mirror, microtask batch
- Render layer — tile map, interpolation buffer, slide clock, pooled views
- Integrate client loop + window.__game() and two-window e2e golden flows (#2)
- Gate two-window e2e in CI against a pinned standalone SpacetimeDB (#3)
- Monster individuality types, rules, rolls, content (M6a)
- Monster tables, content sync, starter grant, privacy (M6b)
- Box/party view — subscription-driven overlay with privacy gate (M6c)
- Game-core combat resolution rules
- Battle table + server reducers (#8)
- Battle view — client-side subscription-driven overlay (#9)
- Taming rules — encounter triggering + recruit-chance arithmetic (#10)
- CI caching + fast inner loop (#11)
- Private encounter table + seeding + privacy proof-of-teeth + B1 (#12)
- Grass-encounter spine (M8c) — TallGrass tiles, private battle_wild seed-table, movement_tick wild trigger (#14)
- Recruit-by-weaken with inventory (M8d) (#15)
- Start_battle opponent-provenance authz + biting security eval (M8.5a) (#16)
- Pure-core swap legality — checked set_active rejects illegal swaps (M8.6a) (#32)
- Wire own slide clock + remote interpolation into the render loop (M8.6b) (#33)
- Predictor flow-control + robustness (M8.6c) (#34)
- Release-gate dev reducers + zone reject-not-clamp + mechanical inventory single-stack (M8.7b) (#39)
- Render battle-outcome frame once + Escape dismiss; bait wiring deferred to M9c (M8.7e) (#41)
- Validate skill accuracy is in [1, 100] (M8.8c) (#44)
- M8.8e — prediction robustness (reconnect re-seed, divergence re-issue, bounded seq) (#45)
- Glob-loaded content directories via build.rs (M8.9e) (#49)

### Fixes

- Unblock SAST gate — literal front-matter parse + exclude .claude from semgrep (#13)
- Rule-core contracts — divide-by-zero / turn overflow / stat-truncation guards + BST SSOT (M8.5b) (#17)
- Bound client prediction to move-queue cap; PARTY SSOT; KeyB/resize robustness (M8.5f) (#31)
- Guard roll_encounter weight-sum u32 overflow + recruit_chance precondition (M8.7c) (#36)

### M8.8b

- Recruit-path turn terminal + level-up heal (SSOT) (#42)

### M8.8d

- Sim-harness convergence teeth (loss+reorder → ServerWorld; ADR-0013) (#43)

### M8.9b

- Split server-module monolith into domain submodules (behavior-preserving) (#50)

### Maintenance

- Scaffold from template
- Green M0 baseline — harden secret-scan, SpacetimeDB .gitignore, pin toolchain
- Finalization audit — guards, content pin, monotonic smoothness, deferrals
- Make the GitHub Actions pipeline runnable
- Make dependency-review best-effort (needs repo Dependency graph)
- Wire skills & agents correctly
- Research library + synced index hook
- Sync research-index hook (duplicate-slug guard)
- Gate fmt+biome in lint, SHA-pin actions, fix devcontainer & log workspace dep (M8.5d) (#19)
- Add game art assets, art-gen tooling, and spec-location docs (#29)
- Release/bench fail-loud + complete the determinism lint gate (M8.8a) (#47)

### Testing

- Gate teeth & test rigor — dual-write eval, RED-until-closed anchors, bindings-drift in ci, nightly mutation/coverage (M8.5c) (#18)
- Generalize schema-snapshot to all tables, broaden zoned-schema, strengthen recruit-security & IV-inversion gates (M8.7a) (#37)
- Parameterize integration db + port for concurrent-run isolation (#38)
- Structural e2e-job gate + parked-test revival gate (M8.8f) (#46)
- Extract marshal.rs inline tests to marshal_tests.rs (M8.9c) (#51)
- Extract battle.rs inline tests to sibling battle_tests.rs (M8.9c) (#52)
- Extract guards.rs inline tests to sibling guards_tests.rs (M8.9c) (#54)

### Wip

- Extract taming.rs inline tests to taming_tests.rs (M8.9c) (#53)
