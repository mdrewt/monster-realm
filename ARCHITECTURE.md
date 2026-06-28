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
  bans wall-clock reads (std::time::*, chrono::*::now) + unseeded RNG (rand::*, getrandom::*,
  OsRng, ThreadRng) workspace-wide (proven by `evals/determinism-fail-loud.eval.mjs`);
  time/RNG are injected. Release/bench profiles include `overflow-checks = true`
  (fail loud on arithmetic overflow, matching debug/test — ADR-0055).
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
  divergence return; seeded by the first own-row. **Bounded prediction enforced at both
  mutation points** — `enqueue` rejects moves past `MOVE_QUEUE_CAP`, and `reconcile` clamps
  the rebuilt queue to the cap (ADR-0052); `enqueue` also rejects on `#pending` at cap (optional 4th ctor `pendingCap`, default 16, ADR-0013.5) — so the predictor never runs ahead of authority
  and a burst can't leave mispredicted tiles. **M8.6c completed held-key continuation (ADR-0013):** OS key-repeat no longer drives movement; `keydown` queues immediate `step(dir)` + registers in MRU held-key stack (`HeldDirections`); rAF loop re-issues held dir deduped against `lastQueuedDir`, suppressed while overlay open; `keyup`/blur/reconnect release/clear. Snap-on-large-gap included (ADR-0013). **M8.8e hardened reconnect/divergence (ADR-0012/0013):** the batch handler re-seeds `#nextSeq` from the authoritative `last_input_seq` (`seedSeq`, monotonic) so post-reconnect intents clear the server ack and survive `reconcile` (no frozen player); it now *consumes* `reconcile`'s divergence return to re-commit the held dir at the pullback point (deduped via `reissueDir`); and the `u64→number` seq downcast is the fail-loud bounded `boundSeq`, its throw contained at the batch-listener call site. The
  movement rule itself never lives here — `apply_move` is the injected client-wasm export
  (proven by the parity + no-logic evals).
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
  (own from the slide clock, remote from the interpolation buffer). **Wasm-sourced constants** — `party_size()` and `party_slot_none()` are now single-sourced from `game-core` via `client-wasm` exports, replacing the former TS magic literals.
  **M8.6b connected the pure-core slide clock and interpolation buffer into the integrated loop via `RenderResolver`** — prior integrated loop fed raw integer tiles; the pure cores were tested-but-unimported. Now own animates from SlideClock (fractional, keyed to snapped tiles) and remotes from the interpolation buffer (now − interpDelay), completing the M4c smoothness design into reality.

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
fields — ADR-0015), **encounter-privacy** (private encounter table, no projection,
no client accessor, spawn weights never leak — ADR-0044).
**Cache-freshness** (M-infra-a, ADR-0043): no shared `CARGO_TARGET_DIR`, `rust-cache`
wired without `cache-all-crates`, distinct per-job `prefix-key`, sccache +
`CARGO_INCREMENTAL=0` co-located, no committed `.cargo` rustc-wrapper, nextest +
doctest in `test` recipe, `ci-fast` recipe present, `install-action` for audit +
nextest.
Each gate has a
known-bad fixture it must reject. The **client TS** is gated too (M3): `tsc` +
vitest/fast-check over the convert + Predictor property suites (run in `just ci`
and CI on a Node setup).
**Nightly vitest coverage scope** (M-infra-c, ADR-0050; gate-meaningfulness per
ADR-0009/0010): the `just coverage` line-threshold measures **hand-written,
unit-testable product LOGIC only**, scoped in `client/vite.config.ts`
(`test.coverage.include = ['src/**/*.ts']` minus an `exclude`). Excluded are the
generated SDK bindings (`src/module_bindings/**` — regenerated by `spacetime
generate`, drift-gated by the bindings-drift eval) and the render/DOM-only
imperative shells (`main.ts`, `net/connection.ts`, `render/world.ts`,
`render/characterView.ts`, `render/placeholderAssets.ts`, `ui/battleView.ts`,
`ui/boxView.ts`) — their substantive decision logic lives in the tested cores, and
they are validated by the two-window e2e (`e2e/golden.spec.ts`, `e2e/recruit.spec.ts`)
via `window.__game()`, never by vitest units, so vitest-v8 would always score them
0% (DOM/Pixi/live-SDK, not unit-runnable). The 25% threshold is **unchanged** and no
unit-coverable logic module is excluded, so the gate stays a real regression backstop
rather than a number dominated by non-unit code. **Known follow-up:** a little inline
glue logic still lives in the integration shells (`main.ts`'s Escape terminal-dismiss
latch + party-slot sentinel routing, `battleView`'s bait-id parse, `boxView`'s
nickname-changed guard) — e2e-validated today; extracting it into pure cores so it is
unit-covered is a separate client slice (M-infra-c does not touch `client/src` logic).

## Schema & content (ADR-0006)

Additive-only schema; content is **data** (RON registries in `game-core/content`,
parsed by pure loaders) seeded by an idempotent `sync_content` reducer (upsert by
stable id), separate from `init`. Stable ids are append-only.

## Server-module domain modules (M8.9 — ADR-0056)

The `server-module` crate is split by domain into cohesive submodules of the **same**
crate (not new crates — ADR-0005). `lib.rs` is reduced to module wiring + crate-wide
constants + the three lifecycle reducers (`init` / `sync_content` / `on_disconnect`).
**This module map is the canonical `touches:` vocabulary**: every downstream milestone
(M9, M10, …) declares the *domain module* it edits (`server-module/src/battle.rs`)
rather than the whole `lib.rs`, so two server-side slices touching different domains
are `touches:`-disjoint and may fan out per `PLAN.md` §9. Renaming a module later
invalidates downstream `touches:` declarations — **keep the file names stable.**

| Module | Owns | Inline-test sibling |
|--------|------|--------------------|
| `lib.rs` | module wiring + crate constants + lifecycle reducers (`init`/`sync_content`/`on_disconnect`) | — |
| `schema.rs` | the data `#[table]` structs + row types (14 of the 15 snapshot tables; the `movement_tick_schedule` scheduled table lives in `movement.rs` with its reducer) | — |
| `guards.rs` | `log_reject`, `validate_name`, `authorize_move`, `check_party_size`, `check_monster_in_party`, `check_team_coupling`, and `require_owner` (the consolidated owner-check preamble) | `guards_tests.rs` |
| `marshal.rs` | row ↔ game-core marshaling helpers | `marshal_tests.rs` |
| `content.rs` | `sync_content_inner` + seeding helpers | inline |
| `movement.rs` | `join_game`, `enqueue_move`, `set_move`, `clear_queue`, `movement_tick` + the `movement_tick_schedule` scheduled table | inline |
| `monster_mgmt.rs` | `set_nickname`, `set_party_slot` | inline |
| `battle.rs` | `start_battle`, `start_wild_battle`, `submit_attack`, `swap_active`, `flee`, `heal_party`, `begin_encounter`, `lead_party`, `write_back_*` (the largest module — the battle cluster) | `battle_tests.rs` |
| `taming.rs` | `attempt_recruit`, `grant_bait`, `grant_item`, `consume_one` | `taming_tests.rs` |

Behavior is provably unchanged because table/reducer **names are explicit**, so
regenerated TypeScript bindings and the schema snapshot are byte-identical — the
`bindings-drift` + `schema-snapshot` gates are M8.9's behavior-preservation proof.
The 10 evals that statically parse the server module now glob
`server-module/src/**/*.rs` (recursive, sorted) so the split is transparent to them.
Two mechanical constraints (recorded in ADR-0056, surfaced by the M8.9a spike): a
cross-module `ctx.db.<table>()` call must import the generated accessor trait
(`use crate::schema::<table>;`), and a module name must not equal a table name
(`mod battle;` resolves only once the `battle` table has moved out of the crate root).

## Content directory layout (M8.9 — ADR-0057)

Content registries are **glob-loaded directories**, not monolithic files. A
`game-core/build.rs` host build-script embeds every `content/<registry>/*.ron` in
**sorted filename order** as `include_str!` parts (compile-time embed; no runtime
I/O, no new runtime or build dependency — `std::fs` only), and the pure loaders in
`content.rs` concatenate the parsed `Vec`s. **This directory layout is the second
canonical `touches:` vocabulary**: adding content is a new
`content/<registry>/NNN-name.ron` and nothing else — no `content.rs`, loader, or
`build.rs` edit — so two content-adding slices become `touches:`-disjoint and fan out.

| Registry | Path | Form |
|----------|------|------|
| species | `content/species/*.ron` | directory (currently `000-core.ron`) |
| skills | `content/skills/*.ron` | directory |
| items | `content/items/*.ron` | directory |
| encounters | `content/encounters/*.ron` | directory |
| zones | `content/zones/*.ron` | directory |
| type_chart | `content/type_chart.ron` | **single file** (one coherent matrix, rarely appended in parallel) |

- **Numeric prefixes zero-pad to a consistent width** (`000-`, `001-`, `010-`): the
  embed sorts files **lexicographically** in both `build.rs` and the `append-only-ids`
  eval, so `10-foo.ron` would sort before `9-foo.ron`. Cross-file row order never
  affects behavior (every registry is keyed by id / zone_id, and `validate_content`
  enforces id-uniqueness across the merged `Vec`) — the convention only keeps
  `000-core.ron` the stable first part.
- **Loud per-file rejection**: a malformed `*.ron` makes the loader return `Err`
  naming the offending file — never a silent skip (parse-don't-validate preserved).
- Content is **data, not schema** — the layout change touches neither `module_bindings`
  nor the schema snapshot; the **content-parity** proof-of-teeth (merged registry ==
  pre-migration rows, in order) is its behavior-preservation gate.

## Decisions

ADRs **0002–0034** are design ADRs that live in the harness spec corpus
(`../../specs/monster-realm-v2/adr/`); **0001** is mirrored in both locations.
Implementation ADRs **0001, 0035–0057** live in `docs/adr/` — see
`docs/adr/README.md` for the navigable catalog. Highlights: 0035 scaffold
hardening, 0036 wasm boundary, 0037 STDB/content deps, 0038 proptest, **0039
two-window e2e CI gate**, 0040 RLS fallback split-tables, 0041 integer damage
formula, 0042 battle table public PvE, 0043 CI caching + fast inner loop, 0044
private encounter table, 0045 private `battle_wild` individuality table, 0046
player inventory model, 0047 recruit resolution, 0048 `start_battle` opponent
provenance, 0049 panic-as-content-invariant policy, 0050 nightly mutation/
coverage + bindings-drift-in-ci, 0051 biome lint scope, 0052 bounded client prediction, 0053 swap-legality pure-core invariant, 0054 dev-reducer release-gating, 0055 release fail-loud + determinism-gate completeness, 0056 server-module modularization (domain submodules — the canonical `touches:` vocabulary), 0057 content-directory glob loading via `build.rs`. See also
`docs/validation-findings.md` (empirical Tier-1 results).

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
- **`damage`** — integer-only formula (u64 intermediates, truncating division,
  no floats): `base = (2*level/5+2)*power*attack/defense/50+2`, STAB `*3/2`,
  type `*eff/10`, variance `*roll/100`, `max(1)`, clamped to `u16::MAX`.
  `accuracy_check(accuracy, roll) -> bool` — `roll < accuracy`.
- **`resolve`** — turn resolution: `resolve_turn` (swaps first, then
  speed-ordered attacks; KO by faster prevents slower from acting;
  auto-switch on faint or battle end), `resolve_enemy_turn` (AI picks best
  skill, one-sided attack), `resolve_player_swap` (swap then enemy attacks
  the new active). All return ordered `Vec<BattleEvent>`. `advance_turn` is the
  single SSOT owner of the `turn_number` advance + `u16::MAX → Fled` terminal —
  every turn-advancing path routes through it (the swap path deliberately does
  not advance the counter); `resolve_recruit_failure` (advance + skilled-wild
  strike-back) owns the failed-recruit battle transition so the `attempt_recruit`
  reducer cannot drift from the terminal (M8.8b). Swap legality is a
  pure-core invariant: `BattleSide::set_active` is the sole checked mutator
  (reject-not-clamp; bounds-checked before fainted-index check); illegal swaps
  are rejected with no mutation, no event, no panic (ADR-0053).
- **`ai`** — `pick_best_skill`: scores each known skill by `power * eff * stab`,
  picks highest. Ignores accuracy (accepted — simple heuristic, M14 can layer).
- **`xp`** — `battle_xp_reward`: `bst * loser_level / (5 * winner_level) + 1` (u32 intermediates — small products, well within range, no overflow risk).
  `apply_xp_gain`: saturating add, clamped at `xp_for_level(100)`, returns
  `(new_xp, new_level, did_level_up)`. `level_up_healed_hp(current, old_max,
  new_max)` is the SSOT level-up heal (heal by the max-HP growth, saturating both
  ways) — the reducer calls it rather than re-inlining the formula (M8.8b).

Content validation (`validate_content`) extended: skill `power > 0` enforced,
skill `accuracy ∈ [1, 100]` enforced (M8.8c — `0` = always-miss/unusable, `> 100`
= out-of-domain/always-hit; same illegal-but-representable class as `power == 0`),
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
    selection among eligible entries; weight sum is a checked fold (`checked_add`→`None` on u32 overflow — total for any caller, M8.7c)
  - `recruit_chance(max_hp, current_hp, base_rate, bait_bonus)` — integer HP-bonus:
    `(max_hp - current_hp) * MISSING_HP_FACTOR / max_hp`, capped at 1000. Guards:
    max_hp==0 skips, current_hp>=max_hp treats as full HP; `debug_assert!(base_rate ≤ 1000 && bait_bonus ≤ 1000)` precondition (fail-loud parity with `attempt_recruit`, M8.7c)
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

## Grass-encounter spine (`game-core` + `server-module` + `client/`, M8c — ADR-0045)

Wild-encounter trigger and individuality storage. Defers recruit/bait/inventory to M8d.

- **`TileKind::TallGrass`** — walkable, glyph `~`. `TileMap` gains a `grass` layer
  + `is_grass`. The M1 exhaustive `match` sites are the compiler-enforced registration
  points. `RawTileMap.grass` + `isGrass` parsed client-side; grass rendered as an
  additive overlay (visual-SSOT: one parse, one draw path).
- **Pure trigger geometry** — `stepped_onto_grass(prev, next, map) -> bool`: fires when
  `prev != next` (no wall-bump / standstill) AND `map.is_grass(next)`. Pure, unit-tested,
  the only new predicate.
- **`resolve_encounter(table, seed, player_level) -> Option<WildSpawn>`** — pure,
  deterministic, total. Splits ONE `u32` seed via `splitmix32` into four sub-rolls
  (`trigger_roll`, `species_roll`, `level_roll`, `individuality_seed`) — no hit/miss RNG
  asymmetry. Gates cheap via `encounter_triggers(trigger_roll, table.encounter_rate)`;
  then reuses the SSOT `roll_encounter` for weighted+level-ranged species pick; picks
  `wild_level` in `[min_level, max_level]`. Single place the seed is split (R-J / ADR-0045
  determinism coupling).
- **Private `battle_wild` side-table (ADR-0045):** `battle_id` PK (1:1 with the public
  `battle` row), `wild_species_id`, `wild_level`, `individuality_seed`. Stores the rolled
  seed, NOT expanded IV/nature columns — `roll_individuality(seed)` is pure/deterministic
  so the seed is the SSOT. **The `battle` table (ADR-0042, public) carries zero wild-gene
  columns.** The `wild-individuality-privacy` eval (cloned from the ADR-0044 6-teeth
  pattern) mechanically enforces: table is private, no projection, no generated accessor,
  AND no `wild_`/`iv_`/`nature` field on the public `battle` table.
- **`WILD_IDENTITY` sentinel** — zero-byte `Identity` no connection holds; used as
  `opponent_identity` on wild `battle` rows. `opponent_monster_ids = vec![]` (wild is
  unowned); `side_b.team` has exactly one element so `active_monster()` never panics. The
  `side_b.team.len()==1` vs `opponent_monster_ids.len()==0` asymmetry is intentional and
  documented at the table to prevent M8d from zipping them.
- **`begin_encounter`** — one impl, two callers (grass trigger + `start_wild_battle`
  reducer). Guards: rejects empty/duplicate `party_monster_ids`, rejects if player already
  `Ongoing`. Inserts `battle` + `battle_wild` atomically. Logs only
  `{battle_id, wild_species_id, wild_level}` — never the seed/IVs (log side-channel).
- **`start_wild_battle` reducer** — dev/test entry, `#[cfg(feature = "dev_reducers")]`
  (OFF in release/publish — ADR-0054, M8.7b). Draws `ctx.random()` (no client-supplied
  seed → no IV-grind cheat surface), derives the zone from the caller's `Character.zone_id`
  and **rejects** a mismatched `zone_id` arg (reject-not-clamp; never rolls an arbitrary
  client-named zone's private table), rolls from the caller's own private `encounter`
  table, calls `begin_encounter`.
- **`movement_tick` integration** — player-only, steps-onto-grass-only. One
  `ctx.random()` draw per stepping character (hit or miss), then `resolve_encounter`;
  partial-sync (no `encounter` row) and rate-0 are no-ops, never panics.

## Encounter server integration (`server-module`, M8b — ADR-0040/0044)

Private encounter table seeding with spawn-data privacy guarantee and B1
validation hardening. No projection (clients have zero need to read encounter
data).

- **Private encounter table (ADR-0044):** `encounter` (no `public` attribute,
  keyed by `zone_id`). Stores one `encounter_rate` per zone (not denormalized
  per entry) + a `Vec<EncounterEntryRow>` vector. Field types flatten-at-boundary:
  `Level` newtype serialized as `u8` (validated at deserialization, invalid codec
  cannot bypass invariants). Codegen emits structural type to `types.ts` (schema
  metadata, not row data); no table accessor, no subscription path. The cheat-
  surface values (per-zone weights/rates) never reach a client. Evaluated by
  `encounter-privacy` proof-of-teeth (6 teeth).

- **Content seeding via validate-before-write upsert:**
  - `sync_content_inner` parses `encounters.ron` via pure loader `load_encounters()`.
  - Validates via `validate_encounters()` (from M8a): unique zones, zone exists,
    rate ≤ 1000, weight > 0, min ≤ max level, species exists.
  - **B1 hardening:** reject empty `entries` vector; reject duplicate
    `species_id` within a zone.
  - Upsert by `zone_id` (no auto_inc, no clear-and-reinsert). Idempotent,
    consistent. Known residuals: stale-zone rows (same as other content tables),
    partial-sync window (cross-registry pattern; M8c trigger validates at runtime
    if needed), schema-shape leak (bindings-drift eval is defense-in-depth).

- **Marshaling helper:** `encounter_rows_from_table` (pure, flattens RON-parsed
  `EncounterTable` → `EncounterRow` for server-side storage). Thin wrapper, no
  embedded rules.

## Player inventory & recruit (`game-core/src/taming/` + `server-module` + `client/`, M8d — ADR-0046/0047)

Closes the find→tame loop: consume bait to raise recruit odds, rebuild the exact wild
from stored individuality, and grant it at full HP with no XP. Inventory is a
public additive owner-scoped table; bait classified by data.

- **`build_monster(seed, &Species, level: Level) -> MonsterInstance`** — pure, in
  `monster/rolls.rs`, parameterized generalization of `roll_starter` (M8a). Full HP,
  EVs zero, bond default, `party_slot: None`, `xp = xp_for_level(level)`. Rebuilds
  the exact wild at recruit time. Proof-of-teeth: `build_monster(seed, sp, L5) ≡
  roll_starter`; `current_hp == derived hp`.
- **`RECRUIT_BASE_RATE: u16` const** — in `taming/rules.rs` (export via mod/lib),
  tunable per-mille base success rate. Per-species rates deferred to M9. Validated:
  `recruit_bonus ≤ 1000` (content).
- **Public `inventory` table (ADR-0046):** additive, owner-scoped: `(inv_id, owner_identity,
  item_id, count)` — "owner-scoped" is the schema (the `owner_identity` column), NOT transport
  RLS: the table is public/world-readable (no `client_visibility_filter` in this toolchain),
  owner-scoping is only a client subscription filter, and per-owner transport RLS is tracked
  for M16. `ItemRow` gains `recruit_bonus: u16` (seeded in `sync_content`;
  bait = `recruit_bonus > 0`, data-driven both sides, not a magic id). Helpers: `grant_item`
  (saturating_add on count, find-then-update ensures one stack per `(owner,item_id)` — now
  mechanically gated by the `inventory-single-stack` eval since SpacetimeDB 1.12 has no
  multi-column unique constraint, ADR-0054/M8.7b; `#[cfg(feature = "dev_reducers")]` as its
  only caller is the dev `grant_bait`),
  `consume_one` (checked_sub, reject if 0/missing — never wrap). Dev/test `grant_bait`
  reducer (self-scoped, bait-only, capped qty; `#[cfg(feature = "dev_reducers")]` — OFF in
  release, ADR-0054; supersede at M9).
- **`attempt_recruit(ctx, battle_id, bait_item_id: Option<u32>) -> Result<(),String>`** —
  server-authoritative reducer. Guards (Err + log): battle exists, player-owned, outcome
  `Ongoing`, wild signal (`battle_wild` exists). Bait: if `Some(id)`, read `recruit_bonus`
  from live `item_row`, reject if unknown/0/not-bait; `consume_one` **before** roll
  (fail still costs bait — intended). Roll: `chance = recruit_chance(wild.max_hp,
  wild.current_hp, RECRUIT_BASE_RATE, bait_bonus)` (server-side, from live battle state);
  `roll = ctx.random()` (injected, no client arg); `success = attempt_recruit(chance, roll)`.
  **Success:** `build_monster(bw.individuality_seed, &species, wild_level)` (exact rebuild,
  SSOT via `roll_individuality(seed)`), grant to box (`PARTY_SLOT_NONE`) via dual-write
  (`monster` + `monster_pub` — ADR-0040), `outcome := SideAWins`, `write_back_party_hp`
  (NO XP — extracted helper; battle XP grant stays in `write_back_battle_results` only),
  delete `battle_wild`, update battle. **Failure:** `turn_number += 1`; if wild has skills,
  `resolve_enemy_turn(SideB,...)` (enemy acts, player forfeits turn); if that ends the
  battle, call full `write_back_battle_results` (normal loss); delete `battle_wild` on any
  terminal (GC). Proof-of-teeth: reject matrix (non-owner / over / non-wild / non-bait /
  missing-bait); exact wild grant (forced seed success, IVs/nature/species/level match
  `roll_individuality`); no XP on recruit; strike-back damage + no monster; bait consumed
  on forced fail; only one recruit per battle.
- **`battle_wild` GC** (ADR-0047 closes M8c residual (b)): unconditional delete in
  `write_back_battle_results` (the shared battle-end path), and in the recruit success/
  strike-back paths. No-op for PvP (no row).
- **Content:** `items.ron` seeded with one bait item (`recruit_bonus > 0`). Validation
  extended: `recruit_bonus ≤ 1000`.
- **Client:** `battleView.ts`/`battleModel.ts` Recruit action + bait selector (classify
  `recruit_bonus > 0` from generated `item_row` bindings; server is authority). Regenerated
  module bindings (`just gen`) include new `inventory` table, `attempt_recruit`/`grant_bait`
  reducers, `item_row.recruit_bonus` field. Proof-of-teeth: `bindings-drift` eval gates
  codegen freshness.
- **Security/privacy evals:** `recruit-reducer-security` (reject matrix for `attempt_recruit`);
  `inventory-privacy` (table carries no genes, owner-isolation, no duplicate stacks);
  `wild-individuality-privacy` still confirms no IV leak (existing from M8c).
- **New gating tests:** `monster/m8d_gating_tests.rs` (determinism, build_monster ≡
  roll_starter, HP derivation, recruit odds monotone, no-XP gate), `client/e2e/recruit.spec.ts`
  (client recover flow, bait consume, wild grant, strike-back). Supplementary
  `combat/redteam_m8d_tests.rs` (8 adversarial arithmetic tests, u32/sign edge cases).

## Known follow-ups / tech-debt

Tracked consciously so they stay visible, not forgotten.

- **(a) `battle`/`battle_wild` row reaping** — M8d closed the `battle_wild` GC (ADR-0047):
  unconditional delete in `write_back_battle_results` + recruit/strike-back paths. The
  `battle` row itself (PvP + wild) remains un-reaped; a general terminal-battle GC for
  the `flee`/win paths is a follow-up (M9+).
- **(b) `splitmix32` duplication** — the helper is present in both
  `taming/rules.rs` (`resolve_encounter`) and `monster/rolls.rs` (`roll_individuality`).
  Hoist to one `pub(crate)` fn to single-source the determinism contract that ADR-0045
  relies on (M8d or standalone cleanup).
- **(c) `lead_party` full-scan** — `movement_tick` scans all owned monsters to find the
  party lead per stepping character. Bound to party with a covering index before zones
  become crowded (M9).
- **(d) Reducer-level integration tests deferred** — `begin_encounter` /
  `movement_tick` / `start_wild_battle` reducer glue is review-covered and the pure logic
  (`resolve_encounter`, `stepped_onto_grass`) is unit-tested; full reducer integration
  tests ride with the M8d Playwright client flow.
- **(e) Battle-outcome render wired (M8.7e), with two named residuals.** The terminal
  outcome frame (`BattleView.#renderOutcome` — "Victory!/Defeat…/Got away safely!") was
  dead in the integrated build because `refreshBattle()` sourced the overlay from
  `ongoingBattle()` (Ongoing-only) and hid it the instant `outcome != Ongoing`. M8.7e
  feeds the overlay from a new `store.latestPlayerBattle(identity)` (most-recent battle,
  any outcome; bigint-keyed) through a **pure reducer `battleModel.ts::decideBattleOverlay`**
  (`(latest, {dismissedBattleId, synced}) → (action, nextState)`): Ongoing auto-shows
  (preserved), a resolved battle renders its outcome **once**, a first-sight terminal row
  is pre-dismissed (no stale pop on login), and a dismissed battle never re-pops. The
  resolved `battle` row persisting un-reaped (follow-up (a)) is what holds the frame on
  screen — the render leverages it deliberately. Residuals: **(i)** dismiss is **Escape-only**
  (the EARS' "and/or a brief timeout"); a hands-free auto-dismiss timeout + an on-screen /
  non-keyboard dismiss affordance are deferred to **M23 (client a11y)** — Escape is this
  client's established overlay-dismiss key. **(ii)** The **bait client surface** (subscribe
  `inventory`/`item_row` → `BaitItem[]` → 4th `buildBattleViewModel` arg → un-fixme
  `recruit.spec.ts`) is deferred to **M9c** (M9 raising owns the inventory-subscription /
  `player_item` backbone; M8.7b release-gated the `start_wild_battle`/`grant_bait` dev
  reducers out of the default client bindings, so the recruit e2e has no green path from a
  client-only slice). `decideBattleOverlay` follows ADR-0014's pure-core/shell split — no
  new ADR.

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
predicted == authoritative** no-desync net; own/remote smoothness via SlideClock/interpolation **connected in M8.6b**) complete. **M5b** (those golden flows now
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
proptest suites, all green) complete. **M8b** (encounter server integration — private
encounter table, validate-before-write upsert seeding, B1 empty/duplicate validation,
encounter-privacy eval with 6 proof-of-teeth) complete. **M8c** (grass-encounter
spine — `TileKind::TallGrass`, pure trigger geometry, `resolve_encounter` splitting
seed, private `battle_wild` side-table storage, `WILD_IDENTITY` sentinel, `begin_encounter`
atomic insertion, `movement_tick` integration with rate-0 no-ops, ADR-0045 — 19 tests,
all green) complete. **M8d** (recruit subsystem — `build_monster` parameterized generalization,
`RECRUIT_BASE_RATE` const, `attempt_recruit` reducer with server-authoritative roll + exact
wild rebuild + full-HP no-XP grant + strike-back on fail, public `inventory` table + `grant_item`/
`consume_one` helpers, `ItemRow.recruit_bonus` data-driven bait classification, `battle_wild`
unconditional GC, `write_back_party_hp` extracted, client Recruit action + bait selector,
`recruit-reducer-security` + `inventory-privacy` evals with proof-of-teeth, ADR-0046/0047 —
gating + e2e + red-team tests, all green) complete. **M8 (Taming subsystem M8a–M8d) fully
delivered:** encounter spawn weights are private; grass steps trigger wild encounters with
exact individuality storage; recruit-by-weaken closes the find→tame loop. **M-infra-a** (CI caching + fast inner loop
— ADR-0043: `Swatinem/rust-cache` per-job, `taiki-e/install-action` for nextest +
audit, `just test` = nextest + doctest, `ci-fast <crate>` recipe, `cache-on` sccache
opt-in, cache-freshness eval with 8 criteria + 17 proof-of-teeth fixtures)
complete.
Deferred-with-rationale: the criterion **perf-budget gate** (folded into the M20
observability capstone — a non-flaky budget needs tuned baselines) and GitHub
Actions *execution* (the workflow is committed; only local `just ci` is verifiable
in this environment).
**M8.9** (server-module modularization + content-directory glob loading — a pure,
behavior-preserving reorganization: no schema, rule, or game-design change)
complete. Workstream A (ADR-0056): the former `server-module/src/lib.rs` monolith
(~2081 lines) split into 8 cohesive domain submodules + a lifecycle `lib.rs`
(M8.9a spike+scaffold → M8.9b the move), the per-reducer owner-check preamble
consolidated into `guards::require_owner`, and each domain's inline tests extracted
to `*_tests.rs` siblings (M8.9c — marshal/battle/taming/guards). Workstream B
(ADR-0057, M8.9e): five of the six content registries migrated to glob-loaded
`content/<registry>/*.ron` directories via a `game-core/build.rs` embed
(`type_chart` stays a single file). Both module maps are now the canonical
`touches:` vocabularies that let future server-side and content-adding slices fan
out (see the two sections above). **Behavior provably unchanged — the milestone
close gate (verified at M8.9d):** `bindings-drift` = 0 (committed
`client/src/module_bindings/` byte-identical to a fresh `spacetime generate`),
`schema-snapshot` unchanged (15 tables), and `content-parity` green (the five
`m8_9e_*_migration_parity` tests reproduce the pre-migration rows in order).

### Finalization audit (2026-06-25) — named deferrals

A read-only review of M0–M3 + M4a found **no correctness/security issues** (rule
SSOT single-homed, reducers gate on `ctx.sender` + reject-not-clamp, the parity /
no-logic / desync evals all bite). Hardened in the pass: a `debug_assert` guard on
the server `zone_map` (fails loud if a non-zero zone ticks before M11), a content
test pinning the `zone_0` placeholder map within its registry dims, a `drain`
cleanup, and a predictor-level **monotonic-prediction** smoothness test. Tracked so
they stay conscious, not forgotten:

- **`isWasmReady()`** — **RESOLVED (M4).** M3 shipped the bridge + Vite plugin
  config; the readiness gate landed in **M4** with the live `--target bundler`
  load. Deferral closed.
- **Renderer smoothness evals** (own slide-clock decoupling from `move_started_at`;
  remote interpolation-buffer jitter) — **pure cores tested in M4b** as vitest proof-of-teeth
  (`render/slideClock.test.ts`, `render/interpolation.test.ts`: the bad clock that
  reads `move_started_at` stutters; the no-buffer renderer double-jumps). **Integrated
  wiring completed in M8.6b** via `RenderResolver` — the M4c loop now resolves own-from-SlideClock /
  remote-from-buffer end-to-end; proof-of-teeth: `render/renderResolver.test.ts` (12 tests),
  `sawFractionalOwnMotion` latch in `golden.spec.ts`.
- **`seq` boundary helper** (`u64` reducer / `bigint` store ↔ the predictor's session
  `number`) — **RESOLVED (M8.8e).** `boundSeq(bigint): number` is the fail-loud bounded
  downcast (throws above `Number.MAX_SAFE_INTEGER` / for negative, rather than silently
  aliasing a lower seq); paired with `seedSeq` for the reconnect re-seed. *Residual (pre-
  existing, out of M8.8e scope, flag for follow-up):* `store.flushBatch` has no per-listener
  isolation, so the `boundSeq` throw is contained at its call site instead — a general
  per-listener try/catch in `store.ts` would harden every batch listener.
- **Spec path `frontend/` == delivered `client/`** — **RESOLVED.** The delivered
  path is `client/`; the stale spec prose was cosmetic. Deferral closed.
- **M2 spec items not yet gated** (a `client_connected` reducer, a schema-snapshot /
  migration-smoke eval, soak/load tests) — soak/load is the **M20** capstone; the rest
  carry forward with M2's 9 shipped proof-of-teeth evals as the live gate set.
