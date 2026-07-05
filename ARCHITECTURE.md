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
**Knowledge-bundle drift** (M8.95, ADR-0080): committed `docs/knowledge/` == fresh
`scripts/okf-export.mjs --check`; a stale or malformed concept fails CI.
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
0% (DOM/Pixi/live-SDK, not unit-runnable). The threshold was ratcheted 25 → **96** in
m13.5a after a post-exclusion re-measure of 99.35% lines (ADR-0050 amendment A1), and no
unit-coverable logic module is excluded, so the gate stays a real regression backstop
rather than a number dominated by non-unit code; the exclusion set itself is
exact-set-guarded by `dom-shell-coverage-exclusion.eval.mjs`. **Known follow-up:** a little inline
glue logic still lives in the integration shells (`main.ts`'s Escape terminal-dismiss
latch + party-slot sentinel routing, `battleView`'s bait-id parse, `boxView`'s
nickname-changed guard) — e2e-validated today; extracting it into pure cores so it is
unit-covered is a separate client slice (M-infra-c does not touch `client/src` logic).
**e2e dev_reducers publish topology** (M13.5h, ADR-0086): the CI `e2e` job pre-builds
the module wasm with `--features dev_reducers` (spacetime 2.6 `publish` has no
cargo-feature passthrough — ADR-0054) and hands the artifact to
`client/e2e/global-setup.ts` via `MR_DEV_MODULE_WASM`; when set, global-setup
publishes it with `--bin-path` instead of `--module-path` (unset ⇒ the plain publish,
local runs unchanged). `spec-gap-revival.eval.mjs` now enforces mechanically that no
`test.fixme` may cite dev_reducers once any workflow publishes it.

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
| `schema.rs` | the data `#[table]` structs + row types (22 of the 22 snapshot tables; the `movement_tick_schedule` scheduled table lives in `movement.rs` with its reducer) | — |
| `guards.rs` | `log_reject`, `validate_name`, `authorize_move`, `check_party_size`, `check_monster_in_party`, `check_team_coupling`, `require_owner` (the consolidated owner-check preamble), and `reject_if_in_battle` (battle-escrowed check for evolve/fuse — ADR-0061) | `guards_tests.rs` |
| `marshal.rs` | row ↔ game-core marshaling helpers | `marshal_tests.rs` |
| `content.rs` | `sync_content_inner` + seeding helpers | inline |
| `movement.rs` | `join_game`, `enqueue_move`, `set_move`, `clear_queue`, `movement_tick` (including NPC wander drive via `npc_decide`), npc entity integration + the `movement_tick_schedule` scheduled table | inline |
| `monster_mgmt.rs` | `set_nickname`, `set_party_slot` | inline |
| `battle.rs` | `start_battle`, `start_wild_battle`, `submit_attack`, `swap_active`, `flee`, `begin_encounter`, `lead_party`, `write_back_*` (the largest module — the battle cluster) | `battle_tests.rs` |
| `taming.rs` | `attempt_recruit`, `grant_bait` | `taming_tests.rs` |
| `inventory.rs` | `grant_item`, `consume_one` (single item-mutation surface — ADR-0059) | — |
| `raising.rs` | `care`, `train`, `evaluate_heal`, `heal_party` (raising + heal cooldown — ADR-0058/0059) | `raising_tests.rs` |
| `evolution.rs` | `evolve`, `fuse`, `compute_evolves_to` (M10b, ADR-0061/0062) | `evolution_tests.rs` |
| `npc.rs` | `talk`, `advance_dialogue`, `dismiss_dialogue` reducers; dialogue/quest state marshaling + helpers (M12b, ADR-0069) | `npc_tests.rs` |

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
| species | `content/species/*.ron` | directory (`000-core.ron` wild/base species + `010-derived.ron` evolved/fused derived forms) |
| skills | `content/skills/*.ron` | directory |
| items | `content/items/*.ron` | directory |
| encounters | `content/encounters/*.ron` | directory |
| zones | `content/zones/*.ron` | directory |
| zone_maps | `content/zone_maps/*.ron` | directory (string-art tile rows + warp list; keyed by zone_id) |
| type_chart | `content/type_chart.ron` | **single file** (one coherent matrix, rarely appended in parallel) |
| evolutions | `content/evolutions.ron` | **single file** (evolution conditions + triggers per species — ADR-0060) |
| fusion | `content/fusion.ron` | **single file** (fusion recipes — ADR-0060) |
| npcs | `content/npcs/*.ron` | directory |
| dialogue_trees | `content/dialogue_trees/*.ron` | directory |
| quests | `content/quests/*.ron` | directory |
| heal_locations | `content/heal_locations/*.ron` | directory |

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

## Agent knowledge bundle (M8.95 — ADR-0080)

A generated, committed, drift-checked **OKF-conformant knowledge bundle** at
`docs/knowledge/` gives agents one portable, navigable schema surface without a
second hand-maintained copy. `scripts/okf-export.mjs` is the **sole writer**;
any hand edit to `docs/knowledge/**` fails the drift gate in CI.

| Concept type | Count | Source |
|---|---|---|
| `SpacetimeDB Table` | 23 | `server-module/src/schema.rs` via `parseTableSchemas()` |
| `SpacetimeDB Reducer` | 25 | domain modules `server-module/src/**/*.rs` |
| `Schema Overview` | 1 | generated; links all tables + privacy classification |
| root `index.md` | 1 | generated entry point for agent lookup |

The producer reuses the **already-exported** `parseTableSchemas()` from
`evals/battle-schema-snapshot.eval.mjs` — the same parser that gates schema drift
now feeds the bundle, so they cannot disagree (SSOT, ADR-0003). Private tables
(`monster`, `encounter`, `battle_wild`) are tagged `visibility: private` and linked
to their public projections where one exists, making the ADR-0040/0044/0045
privacy posture machine-checkable. The vendored `.claude/hooks/okf-lint.mjs`
enforces required frontmatter (`type`, `title`, `slug`, `updated`, `tags`,
`abstract`) on every concept; the `knowledge-bundle-conformance` eval additionally
runs the drift check with proof-of-teeth fixtures (ADR-0010). Recipes: `just
knowledge` regenerates; `just knowledge-check` drift-checks.

Research library (`docs/research/*.md`) carries `type: Research Note` (additive;
validated by the vendored `research-lint.mjs`; `INDEX.md` regenerated with `type`
column via `research-index.mjs`).

## Decisions

ADRs **0002–0034** are design ADRs that live in the harness spec corpus
(`../../specs/monster-realm-v2/adr/`); **0001** is mirrored in both locations.
Implementation ADRs **0001, 0035–0083** live in `docs/adr/` — see
`docs/adr/README.md` for the navigable catalog. Highlights: 0035 scaffold
hardening, 0036 wasm boundary, 0037 STDB/content deps, 0038 proptest, **0039
two-window e2e CI gate**, 0040 RLS fallback split-tables, 0041 integer damage
formula, 0042 battle table public PvE, 0043 CI caching + fast inner loop, 0044
private encounter table, 0045 private `battle_wild` individuality table, 0046
player inventory model, 0047 recruit resolution, 0048 `start_battle` opponent
provenance, 0049 panic-as-content-invariant policy, 0050 nightly mutation/
coverage + bindings-drift-in-ci, 0051 biome lint scope, 0052 bounded client prediction, 0053 swap-legality pure-core invariant, 0054 dev-reducer release-gating, 0055 release fail-loud + determinism-gate completeness, 0056 server-module modularization (domain submodules — the canonical `touches:` vocabulary), 0057 content-directory glob loading via `build.rs`, 0058–0061 raising/training/evolution content+rules, **0062 evolution/fusion server reducer guard ordering, bond-write omission, and test-seam placement**, **0063 evolution/fusion client overlay (evolvesTo decode, fusion recipe display, coverage exclusion)**, 0064–0067 zone/warp data shape + server runtime + client follow-camera/global-subscription (**ADR-0067 accepted: global character subscription per Option C; per-zone re-subscription deferred to M20**), 0068–0071 NPC/dialogue/quest/heal (game-core rules + server reducers + content + client UI), 0072–0079 M12.5 residual fixes (fuse dual-write fix, content-sync repair, zone-sync robustness, netcode smoothness, gate teeth, battle lifecycle GC, practice-XP multiplier, nightly republish smoke), **0080 generated knowledge bundle** (OKF-conformant `docs/knowledge/` bundle, drift-gated, M8.95), **0081 currency primitive** (private `player_wallet` table, `apply_grant`/`apply_spend` in game-core, `grant_currency`/`spend_currency` server helpers, M13a), **0082 shops & buy/sell** (shop content + reducers, sell_price field, M13b), **0083 economy sinks/sources** (healing cost via `spend_currency`, quest/battle rewards via `grant_currency`, M13c). See also
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

## Raising subsystem (`game-core/src/` + `server-module/src/raising.rs` + `client/`, M9 — ADR-0058/0059)

M9 closes the "tame → raise" arc: bond accrual via care, EV training via consumables, and NPC healing.

- **Pure rules (game-core):** `evaluate_care(bond, last_care_at_ms, now) → Result<u8>` (cooldown + bond-cap logic, injected clock); `evaluate_train(monster, item_def) → Result<TrainResult>` (SSOT via `focus_train`: EV-grant capped at 252/510, `current_hp` never written per ADR-0058); `evaluate_heal` seam (HP + status restore).
- **Server — `raising.rs`:** `care` reducer (ownership-checked → `evaluate_care` → `apply_care`; cooldown from `ctx.timestamp` strict `<`; `last_care_at_ms: i64` additive column on `monster`); `train` reducer (ownership-checked; decision-before-`consume_one` ordering: reject never charges bait; calls `evaluate_train` then `consume_one`); `heal_party` reducer (in-battle SideA-won-only guard, zone + F7 position guards, full HP restore, upsert cooldown with strict `<` check — M12b, ADR-0069). Item definitions extended: `train_stat: Option<StatKind>` + `train_amount` additive columns; item id 2 = "Power Root" (first training food, CONTENT_VERSION 1→2).
- **Server — `inventory.rs`:** `grant_item`/`consume_one` — the single item-mutation surface (ADR-0059): every grant/consume path for the `inventory` table routes through these two helpers, enforcing the single-stack-per-`(owner, item_id)` discipline and delete-at-zero / capped qty.
- **Client (M9c):** `raisingModel.ts` (pure subscription view — verbatim server stats, `canTrain` data-driven from `item_row.train_stat`, owner-filtered `ownInventory` deep-copy + `itemDefs` structure-copy); `raisingView.ts` (text overlay, coverage-excluded); 'I' key toggle with mutual exclusion (box/battle supersede per ADR-0014). No new ADR for client (pure subscription pattern, ADR-0016).

## Economy (`game-core/src/currency.rs` + `server-module/src/economy.rs`, M13a — ADR-0081)

Currency primitive: one `u64` balance per player, PRIVATE owner-scoped table, single mutation surface.

- **Pure rules (`game-core/src/currency.rs`):** `MAX_BALANCE = 999_999_999` (9-digit UI cap); `apply_grant(balance, amount) -> u64` — `saturating_add` + `.min(MAX_BALANCE)` (monotone, never wraps); `apply_spend(balance, amount) -> Result<u64, &'static str>` — `checked_sub` reject-not-clamp (never negative, `Err("insufficient funds")` on over-spend). 14 unit + 3 proptest property tests.
- **Private `player_wallet` table (ADR-0081):** `(owner_identity: Identity [PK], balance: u64)`, **no `public` attribute** — non-owner subscriptions are impossible (SpacetimeDB omits private tables from table accessor codegen; only the type definition is generated for reducer argument serialization). Mirrors ADR-0015 must-never-leak requirement.
- **Server wrappers (`server-module/src/economy.rs`):** `grant_currency(ctx, owner, amount)` (upsert; 0-amount no-op, no phantom row) and `spend_currency(ctx, owner, amount) -> Result<(), String>` (find-then-update; 0-amount returns `Ok(())`; missing wallet or insufficient balance returns `Err`). Both are `pub(crate)` — no public reducer surface yet (M13b+ adds shops/sinks).
- **Single-surface discipline:** every economy mutation routes through these two helpers. The `currency-integrity` eval (6 proof-of-teeth criteria) mechanically blocks direct `.balance +=`, unchecked subtract, `PlayerWallet {}` literals, and `player_wallet()` accessor calls outside `economy.rs`/`schema.rs`.
- **Residuals:** starting balance (0) is content-tunable via `grant_currency` in a quest/join reducer; shops, sinks, and XP→currency conversion come in M13b+; per-owner transport RLS deferred to M16 (same pattern as inventory, ADR-0046).

## Economy shops (`game-core/content/shops/` + `server-module/src/economy.rs`, M13b — ADR-0082)

Shop content and server-validated buy/sell reducers; the first player-facing economy feature.

- **Content (M13b):** `ShopDef` / `ShopStockEntry` types in `game-core/content.rs`; `content/shops/000-core.ron` (single file per MVP, additive after). Shop definitions: id (stable), entries (item_id + buy_price per item). `load_shops` / `parse_shops` / `validate_shops` loaders (RON parse → validation). Validation: no dangling item refs, unique shop ids, no duplicate item_id per shop, **`buy_price == 0` rejected** (free-item exploit guard).
- **Tables (schema.rs):** `shop_row` (public, PK `shop_id`) + `shop_item_row` (public, auto_inc PK, btree on `shop_id`, via `sync_content` upsert shop_row + clear-and-reinsert shop_item_row).
- **Server — `economy.rs` reducers (ADR-0082):** `buy(shop_id, item_id, qty)` and `sell(item_id, qty)`. Both server-priced, atomic, reject-not-clamp. `buy` validates shop/item exist, `require_owner`, `checked_mul` overflow guard, `spend_currency` → `grant_item`. `sell` validates item owned, `checked_mul` overflow guard, validates total before consume loop, `consume_one`×qty → `grant_currency`. Both routes through M13a helpers (single-surface discipline).
- **Content add:** `sell_price: u64` additive field on `ItemDef`/`ItemRow` (`#[serde(default)]` for backward compat; 0 = not sellable; `validate_shops` rejects 0 buy_price at load).
- **CONTENT_VERSION 5 → 6:** `sync_content` seeds shop tables + re-derives item sell_price.
- **Eval:** `evals/shop-reducer-security.eval.mjs` — 5 teeth; spec-gap-revival sell→ambiguous false-positive fix.
- **Baselines:** `table-schemas.json`, `content-hash.json` updated to version 6.

## Economy sinks/sources (`server-module/src/raising.rs` + `server-module/src/npc.rs` + `server-module/src/battle.rs`, M13c — ADR-0083)

Currency flow wired through economy helpers into three cardinal paths: healing cost (sink), quest completion (source), battle results (source).

- **Sinks:** `heal_party` reducer in `raising.rs` calls `spend_currency(ctx, owner, cost)` before healing, cost sourced from `HealLocationDef.cost_currency` (content-data, zero = free healing; non-zero cost enforced by `validate_heal_locations`).
- **Sources:** `apply_quest_trigger` (called from `advance_dialogue` reducer in `npc.rs`) grants `reward.currency` on `QuestComplete` via `grant_currency`; `write_back_battle_results` in `battle.rs` grants `battle_currency_reward(bst)` on SideAWins (pure helper in `game-core/src/currency.rs`, returns `u64` reward based on loser battle stats — content-tunable via game-core). All routes through M13a helpers (single-surface discipline, ADR-0081).
- **Validation:** `validate_heal_locations` added to `validate_content` call in `sync_content_inner`; **next-free ADR = 0085**.

## Economy client (`client/src/`, M13d — ADR-0084)

Shop screen and wallet display client integration.

- **Store extension:** `shop_row` and `shop_item_row` subscriptions ingested into `AuthoritativeStore` via `MicrotaskBatcher` (same pattern as M7c battle tables). `StoreShopRow` and `StoreShopItemRow` interfaces; `store.shops()` and `store.shopItems()` keyed accessors.
- **Pure view-model (`shopModel.ts`):** `buildShopViewModel(shops, shopItems, inventory, itemDefs) -> ShopScreenViewModel` — pure function (ADR-0016), sorts by lowest `shop_id` (deterministic), aggregates inventory by `item_id` (matches sell reducer contract). No DOM, fully node-testable.
- **Client store (`shopStore.ts`):** `player_wallet` is **NOT subscribed** — private table (ADR-0081/0040), produces no client binding in SpacetimeDB 2.6. Spec gap "wallet display" replaced by transaction feedback surface: async `buy()`/`sell()` promise rejection messages surface insufficient-funds/out-of-stock errors; successful transactions increment/decrement local inventory view atomically.
- **DOM shell (`shopView.ts`):** thin overlay rendering inventory grid + buy/sell buttons. KeyG trigger, full mutual-exclusivity with all overlays (B/I/E/dialogue guards check shopView state too per ADR-0014). `#pending` boolean flag + `btn.disabled` in-flight lock prevents double-spend (await completes before next click). `SHOP_QTY = 1` const (ADR-0082 D5 single-unit MVP).
- **Connection wiring (`net/connection.ts`):** subscribes to `shop_row` and `shop_item_row` tables; wires `onInsert/onUpdate/onDelete` to store via `MicrotaskBatcher` (same pattern as monsters/battles).
- **Main integration (`main.ts`):** KeyG toggles shop overlay, Escape closes it, movement/action suppressed while open. Reducer calls (`buy`, `sell`) routed through async Promise pattern (ADR-0084); catch block on failure logs and renders error toast (or message-append feedback surface, deferred to M13.5/M23).
- **ADR-0084 spec gap:** `player_wallet` privacy (ADR-0081/0040) means no client-side balance display; future wallet projection requires a public `player_wallet_pub` table (like `monster_pub` for monsters). This gap is documented in ADR-0084 with recommended follow-up.

## Evolution/Fusion content (`game-core/src/evolution/` + `server-module/src/evolution.rs`, M10a — ADR-0060/0061)

Pure content shape, integrity validator, and pure game-core transform rules for evolution and fusion.

- **Content (M10a-content — ADR-0060):** `EvolutionCondition` / `EvolutionTrigger` / `FusionRecipe` / `SpeciesEvolutions` types; `content/evolutions.ron` (single file, evolution conditions per species) and `content/fusion.ron` (single file, fusion recipes). `validate_evolution_fusion` is a **separate** cross-registry validator (not a `Species` field — avoids E0063 across 8 constructors with RON try_from mirrors for bare-int triggers); 7-rule check: no duplicate pairs, no derived-species in wild encounters, no dangling species/item/skill refs, no self-evolution, fusion-coherence. Derived species live in `content/species/010-derived.ron` (additive; `000-core.ron` stays the wild-encounter source). `sync_content` calls `validate_evolution_fusion` so the integrity gate is live on publish.
- **Pure rules (M10a-rules — ADR-0061):** `game-core/src/evolution/` — `eligibility` (`evolves_to` passive level/bond check; `resolve_evolution` item-path) + `transform` (`evolve` carries all individuality per ADR-0019, `current_hp` clamped to new max; `fuse` per-stat-max-IV + higher-bond-nature + fresh-L1 + lower-slot). First-match declaration order; Level/Bond triggers inclusive `>=`. 46 unit/property tests.
- **Server (M10b — ADR-0062):** `evolution.rs` — `evolve` + `fuse` reducers with battle-escrow + ownership guards; `compute_evolves_to` server helper; atomic `fuse` delete-two-insert-one in one transaction; additive `fusion` table + `evolves_to: Option<u32>` column on `monster`. The `monster-dual-write` eval's CAPTURE_INSERT teeth prevent the pre-M12.5a dual-write ordering bug (ADR-0072) from regressing.
- **Client (M10c — ADR-0063):** `evolvesTo?: number` on `StoreMonsterPub` (`option(u32)` decodes as primitive `number | undefined`); `StoreFusionRow` + `store.fusions()` wired to `buildEvolutionViewModel` via `FusionRecipeViewModel` (display-only; server validates); `EvolutionView` DOM shell (KeyE toggle, mutual exclusion with B/I/battle). Coverage-excluded per ADR-0015 `dom-shell-coverage-exclusion` eval.

## Known follow-ups / tech-debt

Tracked consciously so they stay visible, not forgotten.

- **(a) `battle`/`battle_wild` row reaping** — M8d closed the `battle_wild` GC (ADR-0047):
  unconditional delete in `write_back_battle_results` + recruit/strike-back paths.
  **M12.5e (ADR-0077) closed the `battle` row GC**: `write_back_battle_results` now
  deletes all prior terminal (non-Ongoing) `battle` rows for the player at write-back,
  keeping at most 1 terminal per player (the current one, committed by the caller's
  subsequent `update()`). Gap: `attempt_recruit` success path calls `write_back_party_hp`
  not `write_back_battle_results` — one prior terminal can persist until the next
  non-recruit terminal battle. Named follow-up, not silently dropped.
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
**M9b** (raising server — `care` reducer: bond accrual + cooldown via `evaluate_care` seam →
`apply_care` game-core SSOT; `train` reducer: EV-grant food spend via `evaluate_train` →
`focus_train`; `last_care_at_ms: i64` additive column on `monster`; consume-after-decision
ordering; ADR-0058/0059; raising-reducer-security eval extended) complete.
**M9c** (raising client — pure `raisingModel` subscription view, `canTrain` data-driven from
`item_row.train_stat`, `raisingView` text overlay, 'I' key overlay mutual-exclusion with
box/battle per ADR-0014; owner-filtered `ownInventory` deep-copy + `itemDefs` structure-copy;
no new ADR) complete. **M9 (Raising subsystem — train + care) fully delivered.**
**M10a-content** (evolution/fusion content + integrity validator — `EvolutionCondition`/
`EvolutionTrigger`/`FusionRecipe`/`SpeciesEvolutions` types; embedded `fusion.ron` +
`evolutions.ron` registries + `010-derived.ron` derived species; `parse_fusion`/`parse_evolutions`/
`load_*` loaders; 7-rule cross-registry `validate_evolution_fusion` with proof-of-teeth; ADR-0060)
complete. **M10a-rules** (pure `game-core/evolution/` module — `eligibility` (`evolves_to`/
`resolve_evolution` passive branch check by level/bond/item) + `transform` (`evolve` carries all
individuality per ADR-0019; `fuse` per-stat-max-IV + higher-bond-nature + fresh-L1 + lower-slot);
46 unit/property tests; ADR-0061) complete. **M10b** (server evolution + fusion reducers —
`evolve` + `fuse` reducers in `evolution.rs`; additive `fusion` table + `evolves_to: Option<u32>`
column on `monster`; `compute_evolves_to` server helper; atomic fuse delete-two-insert-one in one
transaction; battle/escrow guards reused; `sync_content` calls `validate_evolution_fusion` so the
integrity gate is live on publish; ADR-0062; 16 server tests) complete.
**M10d** (evals + Phase A docs — `evolution-fusion-content-integrity` eval: 5 content-integrity
rules (no-dup-pair, derived-not-wild, dangling-refs, self-evolution, fusion-coherence) + 12
proof-of-teeth; `evolution-reducer-security` eval: 5 reducer invariants (ownership×2 for fuse,
battle-guard×2, self-fusion guard, dual-write, SSOT delegation) + 14 proof-of-teeth; ADR-0064)
complete.

**Phase A (M0–M10) complete.** The single-player core loop — move → find a wild monster →
tame by weakening + recruit → raise (train/care) → evolve or fuse — is fully built,
server-authoritative, and content-data-driven. All game rules live once in `game-core` (pure,
deterministic, property-tested); reducers are thin ownership-gated shells (reject-not-clamp);
content is RON data (additive, append-only, integrity-gated by `validate_content` +
`validate_evolution_fusion`). The 29-eval suite (all with proof-of-teeth) + full unit/
integration/e2e test coverage gates every invariant in CI. **Next: Phase B (M11 — authored
multi-zone world, ADR-0008/0020).**

**M11a** (zone-map data shape — ADR-0065) complete: `WarpDef`, `ZoneMapDef` in `game-core/content.rs`;
`load_zone_maps()` (embedded RON via `ZONE_MAPS_RON_PARTS`); `map_for(zone_id, zone_maps)` →
`Result<TileMap, String>`; `TileMap::warp_at(pos)` → `Option<&WarpDef>`; `validate_zone_maps`;
content: `content/zone_maps/000-core.ron` (zones 0 and 1, mutual warps at (5,5)); all re-exported from `game_core::`.

**M11b** (server warp runtime — ADR-0066) complete: warp resolution in `movement_tick` via
`warp_at` — fires on actual movement only (`prev != next.pos`), battle-guarded (`BattleOutcome::Ongoing`
blocks warp, C1 security finding); per-zone schedules managed by `ensure_zone_schedules` (private,
idempotent, additive, called from both `init` and `sync_content`); `validate_zone_maps` gates
`sync_content_inner` before any `zone_def` upsert. 36/36 evals pass.

**M11c** (client follow-camera + warp resubscribe — ADR-0067) complete: `FollowCamera` pure class
(`offsetFor` clamps `playerPx − viewSize/2` to `[0, mapPx − viewPx]`; map < viewport → `(0,0)`);
`isOwnZoneChange(oldRow, newRow, ownEntityId)` pure predicate in `warpDetect.ts` (strict bigint
`===`); `RawWarpDef` + `TileMap.isWarp(x,y)` added (wire-accurate, Set-backed, OOB-safe);
`store.resetCharacters()` clears `#chars` only (players/monsters/etc. survive zone transitions,
no phantom re-render on empty); `zone_map(zone_id)` wasm dispatch via `map_for` (Err for unknown
zones, no silent zone_0 fallback); `ACTIVE_ZONE_ID` atomic + `set_active_zone()` wasm export
(apply_move reads it — no ApplyMove type-signature change); character subscription global
(`SELECT * FROM character`, no WHERE; renderer filters by currentZoneId); onOwnWarp handler:
`resetCharacters → zone_map → set_active_zone → setMap → resetPredictionState` wrapped in
try/catch (onBatchApplied isolation, M8.8e); `WorldRenderer.resize()` sets viewport-sized canvas
(no stage scale); `app.stage.position.set(-cx, -cy)` for camera scroll. 450 client tests,
7 Rust tests. Deferred to future: per-zone subscription cancellation (ADR-0007 goal; blocked on
SpacetimeDB subscription-group API).

**M12.5c** (zone-sync robustness — ADR-0074) complete: four bugs fixed via state-based zone
reconciliation. **Bug 1:** edge-triggered `onOwnWarp` races with `reconcile` (stale `rawMap.zone_id`
vs. own row). **Fix:** state-based check in reconcile listener: `if (own.row.zoneId !== rawMap.zone_id)`
→ `switchZone()`. **Bug 2:** `switchZone()` lacked atomicity. **Fix:** idempotent `switchZone(mapData, mapId)`
with renderer-first ordering (RT-SZ-01 invariant): `TileMap.fromRaw → renderer?.setMap → set_active_zone
→ rawMap= → resetPredictionState` (renderer throws before WASM zone committed). **Bug 3:** `setMap` had
stale JSDoc (claimed `resetCharacters`). **Fix:** corrected wording; no behavioral change. **Bug 4:** rAF loop
error uncaught, breaking renderer. **Fix:** try/catch/finally with `requestAnimationFrame(frame)` in finally
(re-request on error/success). Module-scope hoists: `renderer`, `resetPredictionState` (enable synchronous
calls from batch listener). Debug hook: `setRawMapZoneForTest` on `window.__game()` (proof-of-teeth
fixture). Proof: `switchZoneAtomicity.test.ts` (5 unit tests, RT-SZ-01), `e2e/zoneSync.spec.ts` (4 Playwright
tests: 12.5c-1/2/3/5). No new tables, no schema change.

**M12a** (pure game-core NPC/dialogue/quest rules — ADR-0068) complete: `npc_decide(current,
home, wander_radius, npc_id, tick) → Option<Direction>` in `game-core/src/npc/rules.rs` closes
the M1/M2 deferral — non-commutative splitmix64 hash (`npc_id.wrapping_mul(K)` before
`wrapping_add(tick)`) prevents tick-aliasing (RT-NPC-01); 1-in-5 stay on wander path only;
toward-home path is deterministic (no hash). Dialogue tree data model (`DialogueTree`,
`DialogueNode`, `DialogueChoice`, `PlayerDialogueState`, `Condition`) in
`game-core/src/dialogue/model.rs` — serde-ready, no `SpacetimeType` derives (M12b's job);
evaluation rules (`evaluate_condition`, `find_entry_node`, `available_choices`, `apply_choice`,
`apply_effects`, `apply_node_auto_effects`) in `game-core/src/dialogue/rules.rs` — `apply_choice`
re-checks conditions internally (security contract: M12b must not bypass); `apply_node_auto_effects`
must be called after `find_entry_node` to apply entry effects. Quest module
(`game-core/src/quest/`) — `can_start_quest`, `trigger_matches`, `process_trigger` with shared
`Condition` enum (SSOT with dialogue); `TriggerEvent` enum (Talk/Collect/Defeat);
`process_trigger` bounds-checks step index via `usize::try_from()` (no silent panic on fabricated
progress); Collect trigger is at-least (`event.qty >= trigger.qty`). 57 gating tests across 3
modules (13 NPC + 26 dialogue + 18 quest); all `just ci` evals pass.

**M12b** (server NPC entity/wander + dialogue/quest reducers + healing — ADR-0069) complete:
`server-module/src/npc.rs` new: `talk`, `advance_dialogue`, `dismiss_dialogue` reducers with F1
(identity) + F2 (single-write) + F7 (position range) guards. Dialogue state marshaling helpers:
`load_player_dialogue_state`, `write_player_dialogue_state`, `apply_effects_to_db`, `apply_quest_trigger`
(pure helpers, never reloading from DB mid-transaction). `schema.rs` adds 6 new tables: `npc`
(public, `#[unique]` npc_id, zone-keyed wander state) + `player_dialogue_state` (PRIVATE,
per-player/dialogue-tree flags/quest sets per ADR-0015) + `player_quest` (public, quest step
tracking) + `player_conversation` (public, transient session anchor) + `heal_location_row`
(public, NPC healing POI) + `heal_cooldown` (PRIVATE, per-location/player cooldown gate per
ADR-0015). `movement.rs` integrates NPC wander: for each NPC character, `npc_decide` returns
direction → push to move_queue, existing drain loop processes. `raising.rs` adds `evaluate_heal`
seam + `heal_party` reducer (guards: in-battle SideA-won-only, zone, position F7; full HP restore;
upsert cooldown with strict timestamp `<` check). `content.rs` seeds NPC entities + heal locations
via `sync_content_inner` (idempotent upsert, CONTENT_VERSION 3→4). `npc_tests.rs` (5 tests):
marshal roundtrips + wander determinism + radius-zero early return. New eval `npc-dialogue-quest-security`
(10 checks C1–C10: table refs, transience, bounds, identity guards, cooldown upsert pattern,
wander-radius-zero safety, in-battle gate, state mutation F2 discipline). Regenerated bindings
include new public table accessors + unique npc_id index. 36/36 evals pass.

**M12c** — Content RON loading for NPC/dialogue/quest/heal (ADR-0070); validate_npc_content (12-point cross-registry integrity); NPC zone policy (skip warp tiles); RT-ADV-01 fix (advance_dialogue zone+proximity re-check, auto-dismiss).

**M12d** (client dialogue/quest/heal UI — ADR-0071) complete: `dialogueContent.ts` static bundle (mirrors 000-core.ron; server remains SSOT for dialogue logic); `dialogueModel.ts` / `questLogModel.ts` / `healModel.ts` pure view-models (unit-tested); `dialogueView.ts` / `questLogView.ts` / `healView.ts` DOM shells (coverage-excluded); store extensions for `StorePlayerConversation`, `StorePlayerQuest`, `StoreHealLocationRow`, `StoreNpcRow`; subscriptions to `player_conversation`, `player_quest`, `heal_location_row`, `npc` (zone-unscoped, deferred optimization to M16); `dismissPending` latch in `main.ts` prevents double-dismiss on Escape; gating tests: `RT-DLG-01` pins dialogue-bundle freshness, `cooldown-bigint-boundary` gates SDK `bigint` precision, `C7-dismissPending-latch` verifies double-send prevention; all green, PR #83.

**M12.5e2** (practice-battle XP multiplier — ADR-0078): `write_back_battle_results` now applies a 0.1× XP penalty when `battle.opponent_identity != WILD_IDENTITY` (self-battle / future PvP). Rule lives in `game_core::practice_xp_reward(base: Xp, is_practice: bool) -> Xp` (pure, floor division, min=0). The `is_practice` flag is hoisted loop-invariant above the per-monster XP loop. Wild battles (opponent == `WILD_IDENTITY`) receive full base XP unchanged. No schema change. 781 Rust tests, 36 evals, 571 client tests all green.

**M12.5e** (battle lifecycle & rules residuals — ADR-0077) complete: three surgical fixes in `battle.rs`/`marshal.rs`. **(e-1) Terminal `battle` row GC:** `write_back_battle_results` now deletes all prior non-Ongoing `battle` rows for the player before returning — ordering-safe because all callers call `update(battle)` after this function returns, so the current battle's DB row is still Ongoing at scan time (keeping-latest-per-player invariant). **(e-3) XP loop log-and-continue:** per-monster parse failures (`Level::new`, `IVs::new`, `EVs::new`, missing species/evolutions) converted from `?`-propagation to `log::error!` + `continue` / `break 'stat_recompute` — one corrupt monster row can no longer make a battle permanently unwinnable. Structural guards (`check_team_coupling`, `write_back_party_hp`) remain fail-loud. Loser level parsed once pre-loop (loop-invariant) with log+`return Ok(())`. **(e-4) Canonical `known_skill_ids` order:** `battle_monster_from_row` in `marshal.rs` now iterates `species.learnable_skill_ids` and filters to those present in the skills slice, identical to `wild_battle_monster` — AI tie-break is now content-defined for owned monsters. ADR-0077 explicitly records 12.5e-2 (self-battle XP provenance) as Drew's DECISION, deferred with a note. 118 Rust tests, 42 evals, 571 client tests all green.

**M12.5a** (CRITICAL bug fix — fuse offspring `monster_pub` dual-write ordering, ADR-0072): `fuse` reducer in `evolution.rs` was calling `pub_from_monster(&offspring_monster)` before `ctx.db.monster().insert()`, so the pub row landed with `monster_id=0` (SpacetimeDB assigns `auto_inc` at insert time and returns the row). Fix: `let inserted = ctx.db.monster().insert(offspring_monster); ctx.db.monster_pub().insert(pub_from_monster(&inserted))` — mirrors `movement.rs:104-105` and `taming.rs:136-137`. `fuse_seam` test double aligned to start with `monster_id: 0` and use insert-return pattern. New gating invariant: `monster-dual-write` eval's `CAPTURE_INSERT` + `DISCARD_INSERT` checks enforce that every `ctx.db.monster().insert(` must capture the return value (not discard with `let _ =`), enforcing insert-then-pub ordering project-wide (TEETH D + TEETH E).

**M10c** (evolution/fusion client overlay — ADR-0063) complete: `evolvesTo?: number` on
`StoreMonsterPub` (`option(u32)` decodes as primitive `number | undefined`; `canEvolve =
evolvesTo !== undefined`), `StoreFusionRow` type + `store.fusions()` wired to
`buildEvolutionViewModel` via `FusionRecipeViewModel` (display-only, server validates),
`EvolutionView` DOM shell with KeyE toggle, mutual exclusion (B/I/battle ordering),
card `#selected` visual-refresh via `#cardEls` map, evolve-button debounce,
`evolutionView.ts` added to `vite.config.ts coverage.exclude` + gated by new
`dom-shell-coverage-exclusion` eval; `box-view-privacy` eval hardened with type-alias
bad-fixture. 401 client tests, 29/29 evals, EXIT:0.

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
