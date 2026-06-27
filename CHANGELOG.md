# Changelog

All notable changes to monster-realm. Hand-maintained for now; automated
regeneration from Conventional Commits via `git cliff` (`just changelog`) is
pending a `cliff.toml` body-template fix (tracked for a build/CI-hygiene slice).

## [Unreleased]

### Verified — M8.6d: loser_base_stat_total doc-comment (subsumed by M8.5b)

- **Subsumed (ADR-0049 §4, "BST — owned by the rule layer") — no behavior change.** The M8.6 residual requiring the
  `loser_base_stat_total` doc-comment to match its `u16` return type is closed. M8.5b
  (PR #17, commit `66f7871`) relocated the base-stat-total computation into the pure
  game-core function `game_core::base_stat_total(base: &StatBlock) -> u16`
  (`game-core/src/combat/xp.rs`, saturating add) and made the server shell
  `loser_base_stat_total` (`server-module/src/lib.rs`) a pure marshaling wrapper that
  delegates to it. The shell's doc-comment now accurately states the `u16` return, the
  marshaling-only role, and the ADR-0049 SSOT citation; the old "Returns u32" line
  was deleted by M8.5b. Verified against the tree: no stale `u32` claim remains.
- **Gating tests confirm the contract (all untouched, still binding):**
  `m7b_loser_base_stat_total_flameling` (318), `m7b_loser_base_stat_total_high_bst_species`
  (630), `m7b_loser_base_stat_total_max_stats_no_overflow` (1530, guards u8-overflow) in
  `server-module/src/lib.rs`; `base_stat_total_known_answer` (Bulbasaur 318) and
  `base_stat_total_saturates` (all-`u16::MAX` → 65535, kills wrapping add) in
  `game-core/src/combat/xp.rs`.
- **Boy Scout:** replaced a stale `// loser_base_stat_total does not exist yet — this test
  is RED.` TDD-scaffold comment in `m7b_loser_base_stat_total_flameling` with an accurate
  note that the explicit `u16` binding pins the signature. Inline test-doc comment only;
  no behavior change.

### Changed — M8.6c: predictor flow-control + robustness

- **Held-key continuation model (ADR-0013)** — OS key-repeat no longer drives movement. `keydown` ignores `event.repeat`; non-repeat movement keydown does immediate `step(dir)` AND registers dir in a most-recently-pressed held stack (`HeldDirections` in new `client/src/prediction/heldKeys.ts`); rAF frame loop re-issues held dir each frame, **deduped** against `predictor.lastQueuedDir` (pure `reissueDir`), suppressed while overlay visible; `keyup` releases; two-key hold falls back to still-held key; blur + reconnect clear. Preserves continuous held movement deterministically (frame-loop-driven, not OS-repeat-rate-dependent) — one behavior-visible change to valid play, same feel.
- **`#pending` backpressure (ADR-0013.5)** — `Predictor.enqueue` now declines (returns undefined, no record) when `#pending` is at cap (optional 4th ctor arg `pendingCap`, default 16 ≈ 16·STEP_MS no-ack backstop). NO eviction — ops in `#pending` never dropped (keeps reconcile replay desync-safe). Bounds prediction lead per ADR-0013 point 5.
- **Robustness: defensive copies + null guards** — `AuthoritativeStore.speciesMap()`/`skillMap()` return new `Map(...)` copies (no live-map leak; upholds `server→store→render` one-way flow); `buildBattleViewModel` fails soft (returns null) on negative `active`, not only `active >= team.len()`.
- **Tests:** new `heldKeys.test.ts` (reissue dedup, MRU-stack fallback, held-key/lag integration), new predictor `#pending` backpressure block (coordinated with M8.5f's `#queue`-cap tests, not duplicated), store map-copy tests, battleModel negative-active tests. All proof-of-teeth (verified).

### Changed — M8.6b: render smoothness wiring

- **Own-character slide clock + remote interpolation wiring** — `RenderResolver` routes own character through a self-owned `SlideClock` (fractional sub-tile slide, keyed to predicted target, snapped on `DrainResult.snapped`) and remote characters through the interpolation buffer (`interpolate(prev, latest, now − interpDelay)`, hold-not-extrapolate). The integrated render loop (`main.ts` `renderEntities`) now samples one `now`, captures `{snapped}` from `predictor.drain(now)`, resolves entities, and renders fractional positions. **Completes M4c smoothness wiring**: the tested pure cores (`render/slideClock.ts`, `render/interpolation.ts`) were green-but-dead (zero importers outside tests); now live in the integrated path. The store's `prev` snapshot is consumed by remote interpolation (dead-snapshot cleanup, no `store.ts` edit). Proof-of-teeth: `render/renderResolver.test.ts` (12 tests, 4 red on revert) + sticky `sawFractionalOwnMotion` latch in `golden.spec.ts`.

### Fixed — M8.6a: swap-legality hardening

- **Combat core swap validation** — `BattleSide::set_active(idx) -> Result<(), SwapError>` makes illegal monster swaps (out-of-bounds or fainted `team_index`) unrepresentable in the resolver. All six `active =` writes in `resolve.rs` now route through the checked mutator (reject-not-clamp; bounds-checked before fainted index); rejected swaps produce no mutation, no `Switch` event, no panic. `resolve_player_swap` aborts the intent; `resolve_turn`'s Swap branch no-ops. Field privatization parked. Restores the swap-legality invariant into the pure game-core (ADR-0053).

### Fixed — M8.5f: netcode & client robustness

- **Client over-prediction rubberband** — on a move-input burst beyond `MOVE_QUEUE_CAP`, `Predictor.enqueue` now declines past the cap and `reconcile` clamps the rebuilt queue to the cap (ADR-0052), preventing mispredicted tiles on reconnect.
- **KeyB no longer opens the box over an active battle** — key-priority ordering prevents conflicting overlays.
- **Renderer responds to window resize** — the render layer correctly recalculates viewport on window-resize events.
- **No spurious snap on predictor's first drain / reconnect** — fixed edge case in snap-on-large-gap logic on initial state transitions.

### Changed — M8.5f: SSOT consolidation

- **Party constants single-sourced from game-core** — `PARTY_SIZE` and `PARTY_SLOT_NONE` are now exported from `game-core` via `client-wasm` as `party_size()` and `party_slot_none()` functions; TS magic literals deleted. Server's `MAX_PARTY_SIZE` and `PARTY_SLOT_NONE` now re-source from `game_core::` module constants, ensuring parity.

### Added — M8d: recruit-by-weaken with inventory

- **`build_monster(seed, &Species, level: Level)`** — pure generalization of
  `roll_starter` in `monster/rolls.rs`; parameterized by level for exact wild
  rebuild at recruit time (ADR-0047).
- **`RECRUIT_BASE_RATE: u16` const** — tunable per-mille base success rate in
  `taming/rules.rs`; per-species rates deferred to M9.
- **Public `inventory` table (ADR-0046)** — owner-scoped additive stack: `(inv_id,
  owner_identity, item_id, count)`. `ItemRow` gains `recruit_bonus: u16` seeded
  in `sync_content`; bait classified by data (`recruit_bonus > 0`) on both client
  and server (SSOT, never a magic id). Helpers: `grant_item` (saturating_add,
  one-stack discipline), `consume_one` (checked_sub, reject on 0/missing, never
  wrap). Dev/test `grant_bait` self-scoped reducer (supersede at M9).
- **`attempt_recruit` reducer** — server-authoritative, injected `ctx.random()`
  roll. Validates: battle exists, player-owned, wild signal present. Consumes
  bait before roll (fail still costs it). On success: rebuild exact wild via
  `build_monster(individuality_seed, &species, wild_level)`, grant to box
  (`PARTY_SLOT_NONE`) at full HP via dual-write (`monster` + `monster_pub`
  per ADR-0040), set outcome `SideAWins`, write back party HP only (no XP —
  extracted `write_back_party_hp` helper closes XP confusion, ADR-0047), delete
  `battle_wild`, atomic transaction (single grant window, no double-recruit).
  On failure: enemy strikes back (turn forfeited); if terminal, full battle
  results write runs; `battle_wild` deleted unconditionally (GC at M8d close).
- **Client Recruit action** — battle view gains bait selector; classify by
  `recruit_bonus > 0` from `item_row` bindings (server authority). Module
  bindings regenerated (`just gen`): new `inventory` table, `attempt_recruit`/
  `grant_bait` reducers, `item_row.recruit_bonus` field.
- **Evals & tests** — `recruit-reducer-security` (reject matrix), `inventory-privacy`
  (owner-isolation, one-stack, no genes), gating tests (`m8d_gating_tests.rs`: HP
  derivation, exact-wild proof, no-XP gate, recruit odds monotone), e2e
  (`recruit.spec.ts`), red-team arithmetic tests (`redteam_m8d_tests.rs`).
- **ADR-0046** — inventory model: additive, public, low-stakes, bait data-driven.
- **ADR-0047** — recruit resolution: exact wild rebuild, no XP on capture, `SideAWins`
  terminal, strike-back on fail, unconditional `battle_wild` GC.

### Added — M7a: game-core combat resolution rules

- **`game-core/src/combat/` module** — pure, deterministic, integer-only
  combat engine (ADR-0041). Symmetric SideA/SideB design for PvP readiness
  (ADR-0017).
- **Type chart** (`type_chart.rs`) — data-driven 8-affinity lookup from RON
  `type_chart.ron`. Raw effectiveness values {0, 5, 10, 20}; unlisted pairs
  default to neutral (10).
- **Damage formula** (`damage.rs`) — integer-only with u32 intermediates:
  `(2*level/5+2)*power*attack/defense/50+2`, STAB (*3/2), type (*eff/10),
  variance (*roll/100), max(1), clamped to u16::MAX.
- **Turn resolution** (`resolve.rs`) — `resolve_turn` (speed-ordered attacks,
  KO-prevents-slower, auto-switch on faint), `resolve_enemy_turn` (AI-only),
  `resolve_player_swap` (swap then enemy hits new active).
- **Enemy AI** (`ai.rs`) — `pick_best_skill` scores by power * eff * STAB.
- **XP system** (`xp.rs`) — `battle_xp_reward` (BST-scaled) and
  `apply_xp_gain` (saturating add, clamped at level 100).
- **Content validation** — `validate_content` extended: skill power > 0,
  type chart effectiveness restricted to {0, 5, 10, 20}.
- **192 tests** — unit, property (proptest), proof-of-teeth (ADR-0010), and
  adversarial red-team fixtures. All green.
- **ADR-0041** — integer-only damage formula with injected variance.

### Previous milestones

- M8c: grass-encounter spine (wild spawn + individuality storage, private battle_wild)
- M8b: encounter server integration (private table, privacy eval)
- M8a: taming rules (encounter triggering, recruit odds)
- M7c: battle view (client subscription overlay)
- M7b: battle table + server reducers (start, submit, flee, heal, write-back)
- M7a: game-core combat resolution rules (shipped in this Unreleased section above)
- M6c: box/party view (client subscription overlay)
- M6b: server integration (content tables, monster privacy, starter grant)
- M6a: monster individuality (types, rules, rolls, content)
- M5b: e2e in CI (SpacetimeDB, desync eval)
- M5a/M4c: per-frame loop, golden flows
- M4b: render layer (tile map, slide clock, interpolation, z-order)
- M4a: connection adapter, AuthoritativeStore
- M3: prediction layer (client-wasm, convert, Predictor)
- M2: authoritative zoned movement
- M1: movement core
- M0: foundation, gates, walking skeleton
