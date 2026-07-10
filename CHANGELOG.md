# Changelog


### Documentation

- ARCHITECTURE.md — durable design record linking the ADRs
- Add spacetimedb-client (SDK connect/subscribe, per-tx coalesce, convert shapes)
- Documentation accuracy sweep — damage u64, XP formula, ADR catalog (M8.5e) (#30)
- Record M8.6d closure — loser_base_stat_total doc-comment subsumed by M8.5b (M8.6d) (#35)
- Correct false owner_identity RLS claim + add false-RLS eval gate (M8.7d) (#40)
- Close M8.9 — record module map + content layout, regen changelog (ADR-0056/0057) (#55)
- Index ADR-0060 (evolution/fusion content shape); bump next-free 0060->0061 (#63)
- Index ADR-0061 (evolution/fusion transform rules); bump next-free 0061->0062 (#65)
- Index ADR-0062 (evolution/fusion server reducers); bump next-free 0062->0063 (#68)
- Index ADR-0064 (evolution/fusion content-integrity evals); next free 0065 (0063 reserved by in-flight M10c) (#71)
- Index ADR-0063 (evolution/fusion client overlay) (#72)
- ARCHITECTURE.md + ADR-0080 + CHANGELOG — closes M8.95 knowledge-bundle milestone (#105)
- Fix stale next-free self-reference + crosswalk in ADR-0060 (#109)

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
- Add raising rules — focus-training EV top-off + care (M9a)
- M9b — care reducer + inventory backbone + last_care_at_ms (ADR-0059)
- M9b-tail — train reducer (focus-training food spend) (#59)
- M9c raising + inventory view (train/care, server-derived stats) (#61)
- M10a evolution/fusion content types + integrity validator (#62)
- M10a-rules — evolution & fusion transforms (pure, individuality-preserving) (#64)
- Server evolution & fusion reducers (#67)
- Evolution/fusion content-integrity evals + Phase A complete (#69)
- Client evolution/fusion overlay (KeyE, EvolutionView) (#70)
- Tiled→RON importer + multi-zone content + warp overlay (#73)
- Server-authoritative warp runtime — per-zone schedules, warp detection, zone-map validation (#74)
- Client follow-camera + zone warp resubscribe (#76)
- Pure game-core NPC/dialogue/quest rule module (ADR-0068) (#78)
- Server NPC entity/wander + dialogue/quest reducers + heal_party (#79)
- RON content loading + validate_npc_content + NPC zone policy + RT-ADV-01 fix (ADR-0070) (#81)
- Client dialogue/quest/heal UI (#83)
- Content-sync path repair (ADR-0073) (#86)
- Netcode smoothness residuals — ADR-0075 (#90)
- Gate & sim-harness teeth (#92)
- Terminal battle GC + XP log-and-continue + canonical skill order (#94)
- Practice-battle XP multiplier 0.1× (ADR-0078) (#96)
- Nightly republish-without-delete smoke test (ADR-0079) (#98)
- OKF knowledge bundle producer + generated docs/knowledge/ (#102)
- OKF knowledge-bundle conformance + drift eval (M8.95b) (#103)
- Research-library conformance — type field + type-aware scripts (#104)
- Empty-moveset content invariant + marshal boundary guards (#107)
- Mechanical gate hardening (allowOnly / forbidOnly / flushBatch isolation) (#110)
- Currency primitive — player_wallet + grant/spend helpers (ADR-0081)
- Shop content + buy/sell reducers (ADR-0082) (#113)
- Shop client UI — shopModel/View, store/rowConvert wiring, ADR-0084 (#115)
- Economy sinks/sources — heal cost, quest/battle rewards via ADR-0081 helpers (#116)
- Gate-of-gates — CI/nightly wiring guards, coverage ratchet 25->96, gating server-module mutation nightly (ADR-0050 amendment) (#118)
- Recruit e2e revival — gameplay-driven R1-R3, dev_reducers fixme tripwire, CI dev-wasm publish (ADR-0086) (#120)
- Reducer-rejection feedback + app-level reconnect (ADR-0085) (#119)
- Content-lifecycle completion + player_conversation privacy via owner-scoped view (ADR-0087) (#123)

### Fixes

- Unblock SAST gate — literal front-matter parse + exclude .claude from semgrep (#13)
- Rule-core contracts — divide-by-zero / turn overflow / stat-truncation guards + BST SSOT (M8.5b) (#17)
- Bound client prediction to move-queue cap; PARTY SSOT; KeyB/resize robustness (M8.5f) (#31)
- Guard roll_encounter weight-sum u32 overflow + recruit_chance precondition (M8.7c) (#36)
- Fuse offspring monster_pub dual-write ordering (id=0 bug) (#84)
- Client zone-sync robustness — state-based reconcile, switchZone atomicity, rAF containment (ADR-0074) (#88)
- Deflake zoneSync 12.5c-1 Playwright races (master RED) (#100)

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
- Restore mutation + coverage gates (M-infra-c)
- ADR index — add 0066, bump next-free to 0067 (#75)
- Index ADR-0067 in docs/adr/README.md (#77)
- Index ADR-0069, bump next free to 0070 (#80)
- Index ADR-0070, bump next free to 0071 (#82)
- Index ADR-0072, bump next free to 0073 (#85)
- Index ADR-0073, bump next free to 0074 (#87)
- Index ADR-0074, bump next free to 0075 (#89)
- Index ADR-0075, bump next free to 0076 (#91)
- Index ADR-0076, bump next free to 0077 (#93)
- Index ADR-0077, bump next free to 0078 (#95)
- Index ADR-0078, bump next free to 0079 (#97)
- Index ADR-0079, bump next free to 0080 (#99)
- ADR index — add 0080, next free 0081 (#106)
- ADR index — register 0081, next free 0082 (#112)
- ADR index — register 0082, next free 0083 (#114)
- ADR index — register 0083, range to 0084, next free 0085 (#117)
- ADR index — register 0086, range to 0086, next free 0087 (#121)
- ADR index — register 0085, drop reservation note; changelog regen (#122)

### Testing

- Gate teeth & test rigor — dual-write eval, RED-until-closed anchors, bindings-drift in ci, nightly mutation/coverage (M8.5c) (#18)
- Generalize schema-snapshot to all tables, broaden zoned-schema, strengthen recruit-security & IV-inversion gates (M8.7a) (#37)
- Parameterize integration db + port for concurrent-run isolation (#38)
- Structural e2e-job gate + parked-test revival gate (M8.8f) (#46)
- Extract marshal.rs inline tests to marshal_tests.rs (M8.9c) (#51)
- Extract battle.rs inline tests to sibling battle_tests.rs (M8.9c) (#52)
- Extract guards.rs inline tests to sibling guards_tests.rs (M8.9c) (#54)
- M9d — no-idle-accrual proof-of-teeth + item-ids baseline (#60)
- Fix Nightly — kill all 72 mutation survivors + debounce level_for_xp timeouts (#66)

### Wip

- Extract taming.rs inline tests to taming_tests.rs (M8.9c) (#53)
- Monster-realm doc reconciliation phase — README/AGENTS/ARCHITECTURE/ADR-README/ADR-0067/raising.rs/CHANGELOG (#101)
- ARCHITECTURE.md — module-map, content-registry, raising+evolution sections (#108)
