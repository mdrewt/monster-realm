# Architecture — monster-realm

The durable design record (links the ADRs in `docs/adr/`; not a milestone
narrative). The spec corpus is the source of truth; this records the shape.

## The spine (load-bearing, do not "simplify")

**Functional core / imperative shell with server authority.** One pure rule layer
(`game-core`); the server module, the wasm boundary, and the client are the
effectful shells.

- **`game-core`** — pure, deterministic Rust. Every game rule lives here exactly
  once (ADR-0003 SSOT). The server runs it for truth; the client runs the *same
  compiled code* (via `client-wasm`) for prediction. Re-implementing a rule
  elsewhere is the desync bug. Determinism is mechanically enforced: `clippy.toml`
  bans wall-clock reads + unseeded RNG workspace-wide; time/RNG are injected.
- **`client-wasm`** — thin `wasm-bindgen` exports wrapping `game-core` for client
  prediction (ADR-0036). Built with `wasm-pack`. Depends on `game-core` **without**
  the `spacetimedb` feature (the feature-isolation eval proves it).
- **`server-module`** — the SpacetimeDB module (crate 1.12 / CLI 2.6). Reducers are
  THIN: validate `ctx.sender` + legality → delegate to `game-core` → write tables;
  reject with `Err`, never clamp. Shared types flatten into table columns.
- **`sim-harness`** — headless, deterministic, multi-client driver (injected
  clock + seed) with a seeded netcode `Link` (latency/loss/reorder) for in-CI
  netcode tests without a browser.
- **`client/`** — PixiJS + TS: connects, subscribes, renders from the **generated**
  bindings (never duplicated content). Read-only store + one-way flow (ADR-0014).
- **prediction layer** (`client/src/`, M3) — the headless, node-testable core M4's
  loop consumes. `convert/` marshals SDK shapes (tagged-union enums, `bigint` ids)
  ↔ the wasm/serde shapes, dumb + explicit (no abstraction across the boundary), incl.
  the **lossy local-time rebasing** baseline (no clock sync, ADR-0012). `prediction/`
  is the **`Predictor`**: a local intent queue + `pending` **queue-ops** (`Enqueue`/
  `SetMove`/`Clear`, not raw moves) + the four-step `reconcile` (drop acked → rebuild
  from the server queue + replay ops → reset to truth → `step_ms`-paced `drain`) + a
  divergence return; seeded by the first own-row; bounded prediction + snap-on-large-
  gap (ADR-0013). The movement rule itself never lives here — `apply_move` is the
  injected client-wasm export (proven by the parity + no-logic evals).
  **M4 contract:** the own character animates from a **self-owned slide clock** and
  **ignores `move_started_at`** (drain-pacing bookkeeping only); `reconcile` runs on
  one **transaction-consistent** snapshot.
- **render layer** (`client/src/render/`, M4b) — the renderer's functional core +
  thin Pixi shell. Pure, node-tested: `map` (the tile map parsed ONCE from the wasm
  `zone_map()` value, never a hard-coded TS grid — visual-SSOT), `interpolation` (the
  remote delay buffer — render at `now − interpDelay` between the two bracketing
  snapshots, **hold-not-extrapolate**), `slideClock` (the own character's self-owned
  slide, keyed to target-tile changes, **decoupled from `move_started_at`**), `zorder`
  (stable overlap order), `viewRegistry` (pooled-view create/teardown). The Pixi shell
  (`world`/`characterView`/`placeholderAssets`, no pixel tests — validated by the M5
  e2e) draws `TILE_PX`-scaled tiles + one **pooled** sprite per entity (mutate-in-place,
  torn down on despawn), behind an **`AssetProvider`** seam (albedo today; HD-2D
  normal/material channels are an additive future render mode — ADR-0004). It owns no
  state and reads no store/predictor: the M4c loop feeds it resolved positions
  (own from the slide clock, remote from the interpolation buffer).

## Mechanical gates (each ships a proof-of-teeth fixture — ADR-0010)

`just ci` is green **and meaningful**: determinism/safety (clippy), feature-
isolation, prediction-parity (native == wasm-pack, incl. movement), **no-logic-in-
wrapper** (client-wasm marshals, never re-decides the rule) and **js-path-parity**
(the marshaled serde `apply_move` == the native-verified flat path, M3),
netcode-determinism, zoned-schema (every world table carries an indexed
`zone_id`, ADR-0007), append-only content ids (ADR-0006), bindings-drift
(committed bindings == fresh `spacetime generate`, ADR-0009), **monster-privacy**
(private monster table, clean public projection, no client accessor — ADR-0040),
**box-view-privacy** (StoreMonsterPub interface contains no hidden IV/EV/nature
fields — ADR-0015).
**Cache-freshness** (M-infra-a, ADR-0043): no shared `CARGO_TARGET_DIR`, `rust-cache`
wired without `cache-all-crates`, distinct per-job `prefix-key`, sccache +
`CARGO_INCREMENTAL=0` co-located, no committed `.cargo` rustc-wrapper, nextest +
doctest in `test` recipe, `ci-fast` recipe present, `install-action` for audit +
nextest.
Each gate has a
known-bad fixture it must reject. The **client TS** is gated too (M3): `tsc` +
vitest/fast-check over the convert + Predictor property suites (run in `just ci`
and CI on a Node setup).

## Schema & content (ADR-0006)

Additive-only schema; content is **data** (RON registries in `game-core/content`,
parsed by pure loaders) seeded by an idempotent `sync_content` reducer (upsert by
stable id), separate from `init`. Stable ids are append-only.

## Decisions

See `docs/adr/` (0002–0034 design ADRs from the spec corpus; 0035 scaffold
hardening, 0036 wasm boundary, 0037 STDB/content deps, 0038 proptest, 0040 RLS
fallback split-tables, 0041 integer damage formula, 0042 battle table public PvE,
0043 CI caching + fast inner loop) and `docs/validation-findings.md` (empirical
Tier-1 results).

## Monster subsystem (`game-core/src/monster/`, M6a)

Pure, deterministic rule layer for monster individuality and progression.

- **`types`** — value objects: `IVs` (0–31, custom Deserialize), `EVs` (252/510
  caps, custom Deserialize), `Nature` (25-variant 5×5 grid), `Level` (1–100,
  custom Deserialize), `Xp`, `Bond`, `StatBlock`, `MonsterInstance`. Parse-don't-
  validate: invariants enforced at construction AND deserialization boundaries.
- **`rules`** — integer-only stat derivation (u32 intermediates, truncating
  division, no floats → native/wasm parity). HP formula: `((2*base + iv + ev/4)
  * level / 100) + level + 10`. Other: `(((2*base + iv + ev/4) * level / 100)
  + 5) * nat_num / nat_den`. XP curve: `level³` (medium-fast). `level_for_xp`:
  binary search for largest l in [1,100] where l³ ≤ xp.
- **`rolls`** — seeded RNG construction (splitmix32 mixing, follows `tick_seed`
  pattern). `roll_individuality(seed) → (IVs, Nature)`, `roll_starter(seed,
  &Species) → MonsterInstance`. Deterministic: same seed → same result.

Content registries (ADR-0006) extended: `species.ron`, `skills.ron`,
`type_chart.ron`, `items.ron` — all parsed by pure loaders following the zones
pattern. `validate_content` enforces: unique ids, no zero/over-255 base stats,
no dangling skill refs, no duplicate type chart pairs. Append-only-ids eval
extended for all registries.

## Monster server integration (`server-module`, M6b — ADR-0040)

The monster subsystem's server-side integration: content tables, monster storage
with privacy, starter grant, and management reducers.

- **Content tables** (all `public`): `species_row`, `skill_row`,
  `type_relation_row`, `item_row` — seeded from game-core RON registries by
  `sync_content_inner` (upsert by stable id; type chart: clear-and-reinsert).
  `sync_content` is guarded to module-identity only.
- **Monster privacy (ADR-0040)**: RLS (`client_visibility_filter`) is confirmed
  non-functional in STDB crate 1.12. Fallback: **private** `monster` table
  (hidden genes: IVs, EVs, nature) + **public** `monster_pub` projection (safe
  fields only). Dual-write discipline enforced by programmer + the
  `monster-privacy` eval (proof-of-teeth: flags public monster table, flags
  hidden fields in projection, flags `monster_table.ts` in bindings). Codegen
  confirms: "Skipping private tables during codegen: monster."
- **Starter grant** (`join_game`): idempotent — checks `monster.owner_identity`
  before granting. Seed from `ctx.random()` (server-side entropy, not the
  predictable Identity hash). Species reconstructed from `species_row` table →
  `game_core::roll_starter`. Rejects with `Err` if starter species missing
  (reject-not-clamp).
- **Management reducers**: `set_nickname` (ownership-checked, `validate_name`,
  empty clears), `set_party_slot` (ownership-checked, bounds-validated, occupancy
  conflict rejection). Both dual-write `monster` + `monster_pub`.
- **Marshaling helpers**: `monster_from_instance` (flattens game-core
  `MonsterInstance` → flat table columns), `pub_from_monster` (derives safe
  projection). Thin wrappers, no embedded rules.

## Box/party view (`client/src/ui/`, M6c — ADR-0014)

Client-side box and party management screen. Pure subscription view: reads
from the `AuthoritativeStore`, mutates only via ownership-checked reducers
(one-way flow, ADR-0014). No SDK imports in the view layer.

- **Store extension** (`net/store.ts`): `StoreMonsterPub` and `StoreSpeciesRow`
  interfaces + keyed Maps + CRUD methods. No hidden genome fields (IVs/EVs/
  nature) — enforced by the `box-view-privacy` eval with proof-of-teeth.
- **Row converters** (`net/rowConvert.ts`): `SdkMonsterPubRow`/`SdkSpeciesRowRow`
  structural interfaces + converter functions. Flatten tagged-union `affinity`
  to bare string. The store stays SDK-agnostic.
- **Pure view-model** (`ui/boxModel.ts`): `buildPartyViewModel` (6-slot array,
  `null` for empty), `buildBoxViewModel` (partySlot 255 filter), `hpPercent`,
  `nextFreePartySlot`. No DOM, no side effects, fully node-testable.
- **DOM shell** (`ui/boxView.ts`): thin overlay rendering `MonsterCardViewModel`s.
  Rename via `prompt()`, party/box management via callbacks. Renders with
  `textContent` (no `innerHTML` — XSS-safe). Refreshed on `onBatchApplied`
  when visible.
- **Connection wiring** (`net/connection.ts`): subscribes to `monster_pub` and
  `species_row` tables, wires `onInsert/onUpdate/onDelete` callbacks to store
  via `MicrotaskBatcher`.
- **Main integration** (`main.ts`): 'B' key toggles box overlay, Escape closes
  it, movement input suppressed while open. Reducer calls (`setNickname`,
  `setPartySlot`) routed through the connection. `__game()` snapshot extended
  with monster data.

## Combat subsystem (`game-core/src/combat/`, M7a — ADR-0041)

Pure, deterministic, integer-only combat resolution engine. All battle rules
live here exactly once (ADR-0003 SSOT). Randomness injected via `TurnVariance`.

- **`types`** — value objects: `BattleMonster` (projected stats for combat),
  `BattleSide` (active slot + team roster with auto-switch), `BattleState`
  (symmetric SideA/SideB for PvP readiness, ADR-0017), `TurnChoice`
  (Attack/Swap), `BattleEvent` (`#[non_exhaustive]` for M14 extensibility),
  `TurnVariance` (injected damage/accuracy rolls + speed tie-breaker),
  `Effectiveness` (Immune/NVE/Neutral/SE), `BattleOutcome`, `SideId`.
- **`type_chart`** — `TypeChart` wraps RON-loaded `TypeRelation` data; 8
  affinities, raw values in {0, 5, 10, 20}. Unlisted pairs default to 10
  (neutral). `classify` maps raw → `Effectiveness` discriminant.
- **`damage`** — integer-only formula (u32 intermediates, truncating division,
  no floats): `base = (2*level/5+2)*power*attack/defense/50+2`, STAB `*3/2`,
  type `*eff/10`, variance `*roll/100`, `max(1)`, clamped to `u16::MAX`.
  `accuracy_check(accuracy, roll) -> bool` — `roll < accuracy`.
- **`resolve`** — turn resolution: `resolve_turn` (swaps first, then
  speed-ordered attacks; KO by faster prevents slower from acting;
  auto-switch on faint or battle end), `resolve_enemy_turn` (AI picks best
  skill, one-sided attack), `resolve_player_swap` (swap then enemy attacks
  the new active). All return ordered `Vec<BattleEvent>`.
- **`ai`** — `pick_best_skill`: scores each known skill by `power * eff * stab`,
  picks highest. Ignores accuracy (accepted — simple heuristic, M14 can layer).
- **`xp`** — `battle_xp_reward`: `(bst/5)*(loser_level/winner_level)+1`.
  `apply_xp_gain`: saturating add, clamped at `xp_for_level(100)`, returns
  `(new_xp, new_level, did_level_up)`.

Content validation (`validate_content`) extended: skill `power > 0` enforced,
type chart effectiveness values restricted to {0, 5, 10, 20}.

## Taming subsystem (`game-core/src/taming/`, M8a)

Pure, deterministic encounter triggering and recruit-chance arithmetic. All
integer-only (per-mille 0–1000, u32 intermediates, no floats). Randomness
injected (no RNG/clock).

- **`types`** — value objects: `EncounterEntry` (species_id, weight,
  min_level/max_level as `Level` newtypes), `EncounterTable` (zone_id,
  encounter_rate per-mille, entries vec). Parse-don't-validate via `Level`
  invariants.
- **`rules`** — 4 pure rule functions:
  - `encounter_triggers(roll, threshold)` — `roll % 1000 < threshold` (per-mille
    gate)
  - `roll_encounter(table, roll, player_level)` — level-range filter → weighted
    selection among eligible entries
  - `recruit_chance(max_hp, current_hp, base_rate, bait_bonus)` — integer HP-bonus:
    `(max_hp - current_hp) * MISSING_HP_FACTOR / max_hp`, capped at 1000. Guards:
    max_hp==0 skips, current_hp>=max_hp treats as full HP
  - `attempt_recruit(chance, roll)` — `roll % 1000 < chance`
  - `MISSING_HP_FACTOR = 500` — per-mille constant (50 percentage points at 0 HP)

Content pipeline extended: `encounters.ron` — per-zone weighted spawn tables (RON
registry, ADR-0006). `parse_encounters` / `load_encounters` / `validate_encounters`
follows existing loader pattern. Validation: unique zone_ids, zone exists,
encounter_rate ≤ 1000, weight > 0, min_level ≤ max_level, species exists.

`ItemDef.recruit_bonus: u16` added with `#[serde(default)]` — bait classification
by data (`recruit_bonus > 0`), not magic item ID.

24 gating tests (787 lines) covering both EARS criteria, including 5 proof-of-
teeth fixtures (bad encounter_rate > 1000, weight == 0, min > max level,
dangling species, dangling zone). 2 proptest suites (bounded output, monotone
HP-bonus). All green.

## Status

Phase A spine: M0 (foundation + gates + presence walking skeleton, e2e green),
M1 (movement core), M2 (authoritative zoned movement + per-zone tick), and M3
(the prediction layer — client-wasm marshaling bridge + convert + the Predictor)
complete. **M4a** (the connection adapter + `AuthoritativeStore`) and **M4b** (the
render layer — tile map from `zone_map()`, pooled CharacterViews, the own-character
slide clock + remote interpolation buffer + stable z-order, behind tested pure cores
with proof-of-teeth) complete. **M4c/M5a** (the per-frame loop wiring
`connection → AuthoritativeStore → Predictor(apply_move) → WorldRenderer` with input +
the `window.__game()` snapshot, plus the two-window Playwright golden flows: see-each-
other, A↔B movement sync + prediction convergence, and the canonical **wall-bump ⇒
predicted == authoritative** no-desync net) complete. **M5b** (those golden flows now
run **in CI** against a real version-pinned standalone SpacetimeDB — ADR-0009/0039,
falsified by a proof-of-teeth desync eval, ADR-0010) complete: a desync,
stale-bindings, or rubberband regression now turns **CI red**, not just local
`just e2e`. **M6a** (monster individuality — pure game-core types, rules, rolls,
content registries — 65 new tests, all green) complete. **M6b** (server integration
— content tables, monster privacy via split-table fallback ADR-0040, starter grant,
set_nickname/set_party_slot reducers, monster-privacy eval with proof-of-teeth)
complete. **M6c** (box/party view — client-side subscription-driven overlay, pure
view-model + DOM shell, connection wiring for monster_pub/species_row, 'B' key
toggle, reducer integration, box-view-privacy eval with proof-of-teeth — 35 new
client tests, all green) complete. **M6 (Monsters & individuality) is now fully
delivered** (M6a + M6b + M6c all merged). **M7a** (game-core combat resolution
rules — type chart, integer damage formula, speed-ordered turn resolution,
auto-switch, AI skill picker, XP reward/level-up — 192 tests, all green)
complete. **M7b** (battle table + server reducers — `start_battle`, `submit_attack`,
`swap_active`, `flee`, `heal_party` with ownership/outcome guards, HP/XP write-back,
battle-reducer-security + battle-schema-snapshot evals with proof-of-teeth — 15 server
tests, all green) complete. **M7c** (battle view — client-side subscription-driven
overlay, `StoreBattle`/`StoreSkillRow` store types, `battleRowToStore`/`skillRowToStore`
row converters, `buildBattleViewModel` pure view-model with null guards, `BattleView`
DOM shell (textContent-only), connection wiring for `battle`+`skill_row` in same
subscribe() call, main.ts integration with Escape priority battle>box>movement,
auto-hide box during battle, heal_party button in box view — 57 new client tests, all
green) complete. **M7 (Battle system) is now fully delivered** (M7a + M7b + M7c all
merged). **M8a** (taming rules — pure encounter triggering, recruit-chance arithmetic,
encounters.ron registry, validation, 24 tests with 5 proof-of-teeth fixtures + 2
proptest suites, all green) complete. **M-infra-a** (CI caching + fast inner loop
— ADR-0043: `Swatinem/rust-cache` per-job, `taiki-e/install-action` for nextest +
audit, `just test` = nextest + doctest, `ci-fast <crate>` recipe, `cache-on` sccache
opt-in, cache-freshness eval with 8 criteria + 17 proof-of-teeth fixtures)
complete.
Deferred-with-rationale: the criterion **perf-budget gate** (folded into the M20
observability capstone — a non-flaky budget needs tuned baselines) and GitHub
Actions *execution* (the workflow is committed; only local `just ci` is verifiable
in this environment).

### Finalization audit (2026-06-25) — named deferrals

A read-only review of M0–M3 + M4a found **no correctness/security issues** (rule
SSOT single-homed, reducers gate on `ctx.sender` + reject-not-clamp, the parity /
no-logic / desync evals all bite). Hardened in the pass: a `debug_assert` guard on
the server `zone_map` (fails loud if a non-zero zone ticks before M11), a content
test pinning the `zone_0` placeholder map within its registry dims, a `drain`
cleanup, and a predictor-level **monotonic-prediction** smoothness test. Tracked so
they stay conscious, not forgotten:

- **`isWasmReady()`** — M3 shipped the bridge + Vite plugin config; the readiness
  gate lands in **M4** with the live `--target bundler` load (the loop awaits it).
- **Renderer smoothness evals** (own slide-clock decoupling from `move_started_at`;
  remote interpolation-buffer jitter) — **delivered in M4b** as vitest proof-of-teeth
  (`render/slideClock.test.ts`, `render/interpolation.test.ts`: the bad clock that
  reads `move_started_at` stutters; the no-buffer renderer double-jumps). The
  standalone `evals/*.eval.mjs` smoothness gates ride with the M4c loop (which
  resolves own-from-predictor / remote-from-buffer end-to-end).
- **`seq` boundary helper** (`u64` reducer / `bigint` store ↔ the predictor's session
  `number`) — a typed conversion lands with the **M5** connection adapter; both sides
  are internally consistent today.
- **Spec path `frontend/` == delivered `client/`** — gates target `client/`; the spec
  prose is stale (cosmetic).
- **M2 spec items not yet gated** (a `client_connected` reducer, a schema-snapshot /
  migration-smoke eval, soak/load tests) — soak/load is the **M20** capstone; the rest
  carry forward with M2's 9 shipped proof-of-teeth evals as the live gate set.
