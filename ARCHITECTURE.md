# Architecture — monster-realm

The durable design record (links the ADRs in `docs/adr/`; not a milestone
narrative). The spec corpus is the source of truth; this records the shape.
The per-milestone sections from `## Decisions` down quote code **as it shipped
at that milestone**: entries predating the 2026-08-16 SDK upgrade show 1.x
SpacetimeDB spellings (`#[table(name = x)]`, `ctx.sender` as a field) that no
longer compile. Current syntax is 2.x — see ADR-0197 and `AGENTS.md`.

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
- **`server-module`** — the SpacetimeDB module (crate 2.8.1 / CLI 2.8.1 —
  kept in lockstep; the crate version IS the product version, ADR-0197). Reducers are
  THIN: validate `ctx.sender()` + legality → delegate to `game-core` → write tables;
  reject with `Err`, never clamp. Shared types flatten into table columns.
- **`sim-harness`** — headless, deterministic, multi-client driver (injected
  clock + seed) with a seeded netcode `Link` (latency/loss/reorder) for in-CI
  netcode tests without a browser. Also hosts `src/bin/mr_load_driver.rs` (m20d,
  ADR-0180 D9 / OBS-27): a std-only, live-only **network shell** bin that never
  runs in CI (its pure core is unit-tested; the socket layer needs a live host).
  It scales N WebSocket clients against a running module, minting one identity
  per client, and reads the breaking point off `/v1/metrics` (movement-tick p95
  vs `STEP_MS`, or queue-depth growth) — protocol-real, not SDK-real (no `tokio`,
  no `spacetimedb-sdk`; the SDK deviation from D9 is recorded in ADR-0180's
  m20d amendment). Invoke: `cargo run -p sim-harness --bin mr_load_driver -- --run-id <id> --db <name>`.
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
  **nh3 (ADR-0152):** predictor instances carry a `PredictorEpoch` generation identifier (branded type, minted at construction). On warp/reconnect rebuild, rejection eviction is guarded: a stale rejection from a discarded predictor (mismatched epoch) is a total no-op. Rebuilt predictors floor their seq space via `lastSentSeq` (the highest seq sent before rebuild) so `seedSeq` prevents re-issuing already-sent seqs, closing the post-rebuild collision hazard. Both mechanisms (guard + floor) are required to close the ptc5f accepted-risk window.
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
  **M8.6b connected the pure-core slide clock and interpolation buffer into the integrated loop via `RenderResolver`** — prior integrated loop fed raw integer tiles; the pure cores were tested-but-unimported. Now own animates from SlideClock (fractional, keyed to snapped tiles) and remotes from the interpolation buffer (now − interpDelay), completing the M4c smoothness design into reality. **ptc5g (ADR-0141)** extends `RenderResolver`'s own-path snap: besides the predictor's time-gap `snapped` flag, it also snaps when the new authoritative own-target is `> 1` tile (Chebyshev) from the slide clock's current target — so a same-zone server correction / respawn / dropped-update catch-up jumps rather than gliding multiple tiles over one `STEP_MS` (zone warps stay reset-covered via `resolver.reset()`). Resolves the M10.5 D-render-snap residual (trigger fired at M11 warps).

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
**Dev-observability gating** (dev-observability, ADR-0157): `net/devLog.ts` carries zero
runtime imports, no bareword `console`, no `globalThis`/`window` and no ring reference —
so the outbound dev log structurally cannot reach the F9 bug bundle or own a second sink.
**Cache-freshness** (M-infra-a, ADR-0043): no shared `CARGO_TARGET_DIR`, `rust-cache`
wired without `cache-all-crates`, distinct per-job `prefix-key`, sccache +
`CARGO_INCREMENTAL=0` co-located, no committed `.cargo` rustc-wrapper, nextest +
doctest in `test` recipe, `ci-fast` recipe present, `install-action` for audit +
nextest.
**Rekey-contract-surface** (M22 s0): `REKEY_MANIFEST` — the ADR-0179 D6 policy
table, and the mechanically enforced copy of it — is now an EXPORTED, recursively
frozen const on `evals/guest-claim-integrity.eval.mjs`, so a second gate file
consumes the one walk of the Rust sources instead of transcribing a third copy.
`evals/rekey-contract-surface.eval.mjs` freezes that seam: the manifest is
exported and deeply frozen (every eval shares ONE module instance under
`run.mjs`, so a stray write to an entry's needle would silently green
`[G6/consumed]`), `findIdentityColumns` returns `{path,type}` records derived from
STRIPPED source (a table declared only inside a Rust string literal must not be
walked), and importing the module runs nothing — checked with child processes
whose `argv[1]` is a real sibling `evals/*.mjs`, because a main guard widened to
match a directory or `run.mjs` exits the whole 90-eval suite mid-loop with code 0.
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
`ui/boxView.ts`, `ui/raisingView.ts`, `ui/evolutionView.ts`, `ui/dialogueView.ts`,
`ui/questLogView.ts`, `ui/healView.ts`, `ui/shopView.ts`, `ui/tradeView.ts`,
`ui/pvpView.ts`) — their substantive decision logic lives in the tested cores, and
they are validated by the two-window e2e (`e2e/golden.spec.ts`, `e2e/recruit.spec.ts`)
via `window.__game()`, never by vitest units, so vitest-v8 would always score them
0% (DOM/Pixi/live-SDK, not unit-runnable). The threshold was ratcheted 25 → **96** in
m13.5a after a post-exclusion re-measure of 99.35% lines (ADR-0050 amendment A1), and no
unit-coverable logic module is excluded, so the gate stays a real regression backstop
rather than a number dominated by non-unit code; the exclusion set itself is
exact-set-guarded by `dom-shell-coverage-exclusion.eval.mjs`. (`ui/leaderboardView.ts`
is deliberately NOT excluded — it is 100% happy-dom unit-covered instead, ADR-0120 D3; `ui/renameView.ts`
likewise NOT excluded — fully happy-dom covered, ADR-0133.)
**Known follow-up:** a little inline
glue logic still lives in the integration shells (`main.ts`'s Escape terminal-dismiss
latch + party-slot sentinel routing, `battleView`'s bait-id parse, `boxView`'s
nickname-changed guard) — e2e-validated today; extracting it into pure cores so it is
unit-covered is a separate client slice (M-infra-c does not touch `client/src` logic).
**e2e dev_reducers publish topology** (M13.5h, ADR-0086): the CI `e2e` job pre-builds
the module wasm with `--features dev_reducers` (`publish` has no cargo-feature
passthrough — ADR-0054, premise corrected by ADR-0197 FF2: a hidden
`build --features` does exist; `--bin-path` is kept deliberately) and hands the artifact to
`client/e2e/global-setup.ts` via `MR_DEV_MODULE_WASM`; when set, global-setup
publishes it with `--bin-path` instead of `--module-path` (unset ⇒ the plain publish,
local runs unchanged). `spec-gap-revival.eval.mjs` now enforces mechanically that no
`test.fixme` may cite dev_reducers once any workflow publishes it.
**Trading negative-path e2e** (14r-b, ADR-0184): `client/e2e/trade-zz-negative.spec.ts` drives three browser contexts (= three identities) through `window.__mrTrade` and asserts server truth via `spacetime sql`, covering the propose/respond/cancel/confirm **rejection** paths (`trading.rs:287/:304/:330/:355/:433/:439/:442/:472/:747`). Playwright's `testDir: './e2e'` auto-discovers it, so it runs in the CI `e2e` job with no workflow or `justfile` edit; the `zz` in the filename is load-bearing (alphabetical run order under `workers: 1`). The `e2e` job is merge-doctrine-enforced, not a branch-protection-required check. Exact-boundary *accept* stays statically gated — no item faucet reaches a browser identity (ADR-0184 D4).
**Playtest-ops recipes** (M-playtest-a, ADR-0129): `just playtest-up/down/wipe` publish honest release-profile modules to isolated DB `monster-realm-playtest` (never dev-default `monster-realm`); `scripts/verify-release-reducers.mjs` fails loud on dev_reducers in published `describe --json` output (forbidden = `start_wild_battle`, `grant_bait` only); `scripts/verify-build-hooks.mjs` scans `dist/**/*.js` for DEV-hook window bindings (`.__x=` / `defineProperty`), failing loud on absent/empty dist. `evals/playtest-verify.eval.mjs` gates the pure checkers (not live in `just ci`); pt-a3 defers live nightly playtest-smoke.

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
| `lib.rs` | module wiring + crate constants + lifecycle reducers (`init`/`sync_content`/`on_disconnect`/`on_connect` — the M21 `client_connected` hook delegates to `accounts::provision_or_touch_account`) | — |
| `accounts.rs` | M21 accounts/auth (ADR-0179): reducers `start_guest_claim`/`complete_guest_claim`/`delete_account`/`cancel_account_deletion` + the `guest_claim_reaper` scheduled reducer & `guest_claim_reaper_schedule` table; OIDC issuer+audience provisioning (`provision_or_touch_account`); the guest→account re-key orchestrator (`rekey_all`, which delegates every game-data write to a `rekey_*` helper in that table's owning module — D0 write-isolation) | `accounts_tests.rs` |
| `schema.rs` | the data `#[table]` structs + row types (the table count is generated — see `docs/knowledge/`; scheduled tables live beside their reducers: `movement_tick_schedule` in `movement.rs`, `trade_offer_reaper_schedule` in `trading.rs`, `pvp_deadline_schedule` in `pvp.rs`, `playtest_reaper_schedule` in `playtest.rs`, `guest_claim_reaper_schedule` in `accounts.rs`; the M21 `account`/`guest_claim` tables + owner-scoped `my_account` view live here) | — |
| `guards.rs` | `log_reject`, `validate_name`, `authorize_move`, `check_party_size`, `check_monster_in_party`, `check_team_coupling`, `require_owner` (the consolidated owner-check preamble), `reject_if_in_battle` (battle-escrowed check for `evolve` — ADR-0061, essence-graph shape per ADR-0177), `reject_if_monster_in_trade` / `escrowed_item_qty` / `escrowed_currency_amount` (trade escrow — M15a, ADR-0106), `require_pvp_participant` (M16 — ADR-0109), `is_ranked_pvp` (ranked-battle classification — M17a, ADR-0119), `is_in_ongoing_battle` / `is_in_ongoing_battle_either_role` (both-role ongoing-battle guard, hoisted from `pvp.rs` — M17.5a, ADR-0122), and the `saturating_sub_u64` / `saturating_sub_u32` helpers | `guards_tests.rs` |
| `observability.rs` | `mr_log` / `mr_log_breadcrumb` + `mr_heartbeat` scheduled reducer & `MrHeartbeatSchedule` table; Layer-1 structured logging, heartbeat dead-man beat — ADR-0180 D6 | `observability_tests.rs` |
| `marshal.rs` | row ↔ game-core marshaling helpers | `marshal_tests.rs` |
| `content.rs` | `sync_content_inner` + seeding helpers | inline |
| `movement.rs` | `join_game`, `enqueue_move`, `set_move`, `clear_queue`, `movement_tick` (including NPC wander drive via `npc_decide` — collision- and radius-aware since ADR-0159 D2), npc entity integration + the `movement_tick_schedule` scheduled table | inline |
| `monster_mgmt.rs` | `set_nickname`, `set_party_slot` | inline |
| `battle.rs` | `start_battle`, `start_wild_battle`, `submit_attack`, `use_battle_item` (M14e — ADR-0096), `swap_active`, `flee`, `begin_encounter`, `lead_party`, `write_back_*` (the largest module — the battle cluster) | `battle_tests.rs` |
| `taming.rs` | `attempt_recruit`, `grant_bait` | `taming_tests.rs` |
| `inventory.rs` | `grant_item`, `consume_one` (single item-mutation surface — ADR-0059) | — |
| `raising.rs` | `care`, `train`, `essence_train`, `consume_crystalized_essence`, `evaluate_heal`, `heal_party` + the `accrue_quality_time`/`apply_quality_time_credit`/`grant_essence` growth helpers (raising + heal cooldown — ADR-0058/0059; essence/Quality-Time — ADR-0175) | `raising_tests.rs` |
| `evolution.rs` | `evolve` + the `apply_evolution`/`check_and_evolve` auto-evolution helpers (fusion deleted — EG1/ADR-0174; event-triggered essence-graph evolution — EG2/ADR-0175) | `evolution_tests.rs` |
| `npc.rs` | `talk`, `advance_dialogue`, `dismiss_dialogue` reducers; dialogue/quest state marshaling + helpers (M12b, ADR-0069) | `npc_tests.rs` |
| `economy.rs` | `buy`, `sell` reducers + `grant_currency` / `spend_currency` / `wallet_balance` helpers (the single economy-mutation surface — M13, ADR-0081/0082) | `economy_tests.rs` |
| `trading.rs` | `propose_trade`, `respond_trade`, `confirm_trade`, `cancel_trade`, `trade_offer_reaper` + the `trade_offer_reaper_schedule` scheduled table (M15a — ADR-0106; TTL reaper M16.5f — ADR-0117) | `trading_tests.rs` |
| `pvp.rs` | `challenge_pvp`, `accept_challenge`, `decline_challenge`, `cancel_challenge`, `submit_pvp_action`, `pvp_deadline_reaper` + the `pvp_deadline_schedule` scheduled table (M16 — ADR-0109); the ranked account gate (`ranked_account_gate` pure seam + `ranked_enforcement_active` deployment-conditional activation, Guard 3a in both handshake reducers — 14r-g, ADR-0189) | `pvp_tests.rs` |
| `content_cache.rs` | `LazyLock` hot-path content caches (zone maps, evolutions, dialogue trees, quests, skills, items, abilities, heal locations) + the `content_version`-keyed rebuildable type-chart cache — no reducers; ADR-0089/ADR-0170 | `content_cache_tests.rs` |
| `ranking.rs` | `get_or_init_profile` + `apply_pvp_rating` (module-write-only `profile` rating/W/L — applied only from the `settle_pvp_battle` funnel in `pvp.rs`; M17a — ADR-0119) + the module's one reducer `set_profile_name` (writes `player.name` only, profile-untouching; the ADR-0125 mirror surfaces the rename on the leaderboard — pt-c1, ADR-0132) | `ranking_tests.rs` |
| `playtest.rs` | the PRIVATE append-only `playtest_event` capture table + its interval-singleton TTL+cap reaper (`playtest_reaper` scheduler-only reducer + `playtest_reaper_schedule` table, armed by `ensure_playtest_reaper` from init/sync_content); `record_recruit_event` fires from `attempt_recruit` at the H1 decision point; pure seams `hp_permille`/`plan_reap`/`plan_reaper_arm` (server-only observability, NOT a game rule; pt-b2 — ADR-0131; report via `just playtest-report`, which since 16r-d decodes `spacetime sql --format json` envelopes with fail-loud validation instead of parsing the CLI's *display* rendering — that text format carries no stability contract and 2.8.1 silently changed it; envelope shape + decoder contract in ADR-0197 D19-D23) | `playtest_tests.rs` |

Behavior is provably unchanged because table/reducer **names are explicit**, so
regenerated TypeScript bindings and the schema snapshot are byte-identical — the
`bindings-drift` + `schema-snapshot` gates are M8.9's behavior-preservation proof.
The evals that statically parse the server module now glob
`server-module/src/**/*.rs` (recursive, sorted) so the split is transparent to them.
**Source-scan strippers (13r-c, ADR-0181):** `evals/rust-scan.mjs` is the SSOT
string-literal-aware Rust scanner — it lexes comments and string literals in ONE
pass (so a `//` inside a literal is data, not a comment start) and is length- and
offset-preserving, blanking literal payloads. TypeScript scans use
`stripTsComments` (`evals/conversation-privacy.eval.mjs`) instead, which keeps
literal payloads VERBATIM: the client privacy evals BAN SQL text that lives inside
a string literal, so payload-blanking would make those bans pass vacuously. Evals
that scan Rust should import `rust-scan.mjs` rather than hand-rolling a
comment-stripping regex; a regex that strips `//` without string awareness is
false-GREEN capable, and `evals/scanner-migration-audit.eval.mjs` (ADR-0186) is
the live enforcing gate and measurement of which `*-security.eval.mjs` /
`*-privacy.eval.mjs` files remain unmigrated. **Its `KNOWN_UNMIGRATED_CAP` is an
UPPER BOUND, never an exact equality (15r-a2):** under-cap prints a non-blocking
advisory and exits 0, so each queued migration slice can delete its debt entry
without the shared cap literal becoming cross-slice state that REDs `master` for
doing *more* migration.
**Rust test-mirror parity (13r-h, ADR-0195):** three bundled test-mirror repairs, all ADR-disclosed (ADR-0179 §9), none previously queued. `accounts_tests.rs` G2 mirror replaced a hardcoded 5-reducer needle list with dynamic source-derived reducer enumeration at parity with `guest-claim-integrity.eval.mjs`'s `checkNoClientIdentity` — positive wire-safe-scalar param allowlist, scheduled-struct-with-guard carve-out, Identity-constructor ban, and an exact reducer name-set pin. `evolution_tests.rs` EG2-9 swapped a hardcoded 10-file `scheduled_scan_sources()` for a recursive `read_dir` of `server-module/src/*.rs` (minus `*_tests.rs`) processed PER-FILE (no cross-file brace bleed), extended to seven scheduled-reducer anchors (added `guest_claim_reaper` + `mr_heartbeat`) with per-new-reducer body anchors. `accounts.rs` gained a pure `account_state_is_legal` predicate (the Account legal-state pairing invariant) `debug_assert!`'d in all five pure constructors, plus a `schema.rs` doc note and an exact-equality struct-shape tripwire so M22's `delete_account` extension must re-derive the invariant consciously.
**Counting gates go HOLLOW, not red, when their region gains a legitimate
occurrence (14r-f, ADR-0188 D4).** `zone-warp-server-runtime.eval.mjs`'s W3 counted
`is_in_ongoing_battle(` anywhere after `warp_at(` and failed only on zero; routing
`movement_tick`'s grass pre-check through the same SSOT added a second legitimate
call downstream, so deleting the warp guard would have left the count at 1 and W3
would have passed with the finding live. W3 is now region-scoped
(`warp_at(` … `stepped_onto_grass(`, explicit `-1` end-fallback + `slice` — never
`substring`, whose clamp-and-swap inverts the region onto the drain lock) and pins
the guard EXPRESSION and that something BRANCHES on it, not mere presence. When a
change adds a sanctioned occurrence inside any counted region, re-scope the gate in
the same PR — a presence/count check that a decoy or telemetry call can satisfy
reads as coverage while providing none.
**Client mirrors of server constants are gated as mirrors (14r-f, ADR-0188 D3).**
`client/src/ui/tradeProposeModel.ts` exports `MAX_TRADE_MONSTERS_PER_SIDE = 64`
mirroring the private `server-module/src/trading.rs:37` SSOT (inclusive — the server
compares `>`), so an over-cap trade fails in-UI instead of as an opaque reducer
reject. The server stays authoritative and rejects, never clamps. A mirrored
constant is a second source of truth unless mechanically tied to the first, so
`evals/trade-cap-parity.eval.mjs` reads the Rust literal directly, requires an
exported named const, asserts equality, and proves by dataflow that the clause
reading it is a top-level `&&` conjunct of `canSubmit` — a decorative const beside a
live bare literal is the drift shape it exists to kill.
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
| species | `content/species/*.ron` | directory (`000-core.ron` wild/base species + `010-derived.ron` evolved derived forms + `020-playtest-wave1.ron` roster wave 1 — ADR-0143 + `050-wave2.ron`/`051-wave2-derived.ron` roster wave 2 — ADR-0144 + `060-item-evo-derived.ron` item-triggered derived forms — ADR-0149 + `070-wave3.ron`/`071-wave3-derived.ron` roster wave 3, Electric + Light — ADR-0204) |
| skills | `content/skills/*.ron` | directory |
| items | `content/items/*.ron` | directory |
| encounters | `content/encounters/*.ron` | directory |
| zones | `content/zones/*.ron` | directory |
| zone_maps | `content/zone_maps/*.ron` | directory (string-art tile rows + warp list; keyed by zone_id) |
| type_chart | `content/type_chart.ron` | **single file** (one coherent matrix, rarely appended in parallel) |
| evolution_paths | `content/evolution_paths/*.ron` | directory (evolution-graph edges: `edge_id`-keyed, tier/essence/Trust/Quality-Time/Nutrition gates — ADR-0174; twelve authored edges since EG3 — `000-core.ron` owns edge band 1..=99, `070-wave3.ron` owns 100..=199, ADR-0176/0204; R1–R12 gated by `validate_evolution_paths` + `evals/evolution-content-integrity.eval.mjs`) |
| npcs | `content/npcs/*.ron` | directory |
| dialogue_trees | `content/dialogue_trees/*.ron` | directory |
| quests | `content/quests/*.ron` | directory |
| heal_locations | `content/heal_locations/*.ron` | directory |
| shops | `content/shops/*.ron` | directory (per-shop stock + buy/sell prices — ADR-0082) |
| abilities | `content/abilities/*.ron` | directory (per-species passive effects — ADR-0094) |

- **Species id ranges are reserved per authoring wave** (ADR-0143): 1–6 core/derived,
  **7–10 pt-d1 roster wave 1**, **20–29 pt-d2 roster wave 2** (ADR-0144 D1),
  **30–39 slice B item-evolution derived forms** (ADR-0149 D3), **40–49 reserved for roster
  wave 3**. Because the directory is
  glob-*merged*, two waves that claim the same ids merge with no git conflict and surface
  only as a `duplicate species id` error from `validate_content` at publish time — so the
  reservation lives in each part file's header, not just in review.
- **Encounter tables tier by PLAYER level, and the band does double duty** (ADR-0145):
  `roll_encounter` filters entries by the *player's* lead-party level, then
  `resolve_encounter` picks the *spawn* level uniformly inside that same band. A high
  `min_level` is therefore invisible to a low-level player — that is the difficulty-curve
  mechanism, not just a spawn range. **Zone 0 "Verdant Hollow" is frozen byte-identical**
  because `client/e2e/recruit.spec.ts` derives two remote-CI flake budgets from its exact
  weights and rate; any new zone-0 entry needs `min_level >= 15` (the e2e's provable
  player-level ceiling is 12, machine-derived by `pt_d3_tuning.rs`, not asserted in prose).
  **Zone 1 "Tideglass Cove" carries all 9 wild-legal forms**; its weights and bands are
  tuning data and deliberately unpinned. A wave-3 tier-0 form's `max_level` there sits strictly
  below its own outgoing evolution `min_level` (rw3c) — `level_gate_met` is inclusive and
  auto-evolution fires immediately when exactly one path is eligible, so a band reaching the gate
  would ship wild catches that evolve on capture. Derived forms (4, 5, 6, 9, 10, 22, 23, 30, 31,
  41, 43) must never appear in any encounter table — `validate_evolution_paths` rule R6 (derived-not-wild) rejects them.
- **Numeric prefixes zero-pad to a consistent width** (`000-`, `001-`, `010-`): the
  embed sorts files **lexicographically** in both `build.rs` and the `append-only-ids`
  eval, so `10-foo.ron` would sort before `9-foo.ron`. Cross-file row order never
  affects behavior (every registry is keyed by id / zone_id, and `validate_content`
  enforces id-uniqueness across the merged `Vec`) — the convention only keeps
  `000-core.ron` the stable first part.
- **The `append-only-ids` gate is BIDIRECTIONAL** (12r-a): adding a content id requires
  appending it to that registry's `evals/baselines/*-ids.json` in the **same PR** — an
  unpinned live id fails the gate rather than silently escaping append-only enforcement.
  Each registry additionally carries an **exact expected DISTINCT-id count**, pinned in
  two places the eval reads independently — not a minimum: a count below it means a
  baseline was shrunk (restore the content), a count above it means content grew, so the
  PR that adds an id must **bump both pins in that same PR**. That closes the
  add-one/retire-one swap and the duplicate/`-0` padding that inflates `length` while
  `Set` collapses it, and it turns the "delete the content and un-pin it in one commit"
  shrink into a **reviewable line** — two hardcoded numbers must come down — rather than
  an invisible agreement between two files. Be precise: that is review visibility, not a
  mechanical impossibility. A **fully-coordinated** shrink (content, pin, and both counts
  in one commit) still passes; no working-tree gate can tell it from a legitimate
  retirement without a cross-revision record of what was once shipped. The gate likewise
  does **not** detect id reuse/rebinding: swapping two ids, or rebinding an id to a
  different entity, leaves the id set unchanged and stays green. Both gaps want the
  map-shaped ever-issued-ledger shape, e.g. `evolution-path-edge-ids.json`.
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
| `SpacetimeDB Table` | generated — see `docs/knowledge/` | server module tables via `parseTableSchemas()` |
| `SpacetimeDB Reducer` | generated — see `docs/knowledge/` | domain modules `server-module/src/**/*.rs` (excludes `*_tests.rs`, ADR-0137) |
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
runs the drift check with proof-of-teeth fixtures (ADR-0010), and asserts no
concept page's `resource:`/`source:` frontmatter points at a `*_tests.rs` file
(ADR-0137 — so test-fixture reducers can't clobber real reducer pages while the
committed==regenerated drift gate stays green). Recipes: `just
knowledge` regenerates; `just knowledge-check` drift-checks.

**Schema-gate order-awareness and visibility (13r-d, ADR-0193; 15r-sec-vis, ADR-0199):** that same gate is now column-ORDER
aware — `evals/baselines/table-schemas.json` records each table's `order`, and a git-resolved
append-only comparison against the previously committed baseline keeps a mid-struct insert RED
even after a sanctioned full re-baseline (live spacetime accepts only tail-appended
`#[default(...)]` columns, ADR-0173 D5). The baseline additionally records each table's declared
`visibility` (`public` or `private`), and a private-to-public transition fails the gate unless
accompanied by a hand-authored `visibility_note` citing an ADR. Regeneration is `node
evals/battle-schema-snapshot.eval.mjs --write` (ADR-0199 D8). `parseTableSchemas()`'s return shape is unchanged.

**Generated changelog (m17.5g):** `CHANGELOG.md` is likewise a generated ledger —
`git-cliff` renders it from committed Conventional Commit history (`just changelog`
is the sole writer; never hand-edit). Policy since m17.5g: **regenerate at every
milestone close** (the close/reconciliation chore runs `just changelog`), so the
ledger can lag by at most the open milestone — the tenth review found it 8 merges
behind. A slice's own squash line lands at the NEXT regen: git-cliff reads committed
master history, so regenerate at the branch point, never after `wip:` commits.
**Enforcement since 13r-g (ADR-0196):** `scripts/changelog-freshness.mjs` runs in the
`changelog-freshness` nightly job, comparing a fresh generation's entry multiset against
the committed ledger. It fails only on the CONJUNCTION — at least 15 entries missing AND
the oldest missing entry at least 6 days old — because the lag is a weekly sawtooth that
reaches 20-26 on a healthy wave, so a bare count either nags (66% of nights) or misses
half the real episodes; from 8 entries behind it prints an advisory and exits 0. 16r-c (ADR-0196
follow-ups #2/#3) added `just changelog-check` and a version-pinned `just changelog`, and
`evals/nightly-smoke-wiring.eval.mjs` now guards the nightly job's existence, neuter-freedom
and gate-step integrity per-PR — but the freshness VERDICT itself stays nightly-only by
ADR-0196's accepted decision, since the ledger may lag by up to one open milestone and a
per-PR freshness gate would red on essentially every feature PR.

**Nightly failure notification (lp-03, ADR-0200):** the five nightly gates had teeth and no
voice — `mutation-server` was RED for five consecutive nights with nobody reacting. A `notify`
job now fans in over all five (`needs:`), fires on a `failure`/`skipped`/`cancelled` result and
opens exactly one GitHub issue per non-success job via `gh`, naming the job and linking the run,
under a **job-scoped** `issues: write` grant (top-level stays `contents: read`; the mutation jobs
compile third-party build scripts and must not hold issue-write). Both mutation jobs upload
`mutants.out/` with `if: always()` so the survivor list exists on the night it is needed. That
`if:` is why `evals/nightly-smoke-wiring.eval.mjs`'s `jobIsNotNeutered` gained a step-scoped
carve-out — admitted only on an upload-artifact step and only for `always()`, with the scan
otherwise hardened (own block extraction, an anchored key match, a `continue-on-error` allowlist,
the recipe pinned as the first `run:` step, and fail-closed on shapes it cannot read).

**Nightly red-response policy (16r-h, ADR-0203):** ADR-0200's `notify` job says WHICH job
failed; it never said what the required response is or who owes it.
`docs/nightly-red-response-policy.md` is now that answer for every job declared in
`nightly.yml`, held to the workflow in BOTH directions by `evals/nightly-smoke-wiring.eval.mjs`
Checks 31-35: the matrix's job-key set must be exactly equal to the workflow's declared jobs (a
job with no row and a row for a deleted job are both red, and the reason names which way it
drifted), and every job's comment preamble must cite the doc path as a bounded token — so a
seventh job added tomorrow is red until it is both rowed and cited. The Owner column is a
closed two-member enum (`build-loop supervisor` / `operator (Drew)`) of which BOTH must appear,
because a constant owner column carries no information, and every Escalation cell must cite an
ADR that exists on disk. The doc names recipes (`just mutate-core`, `just mutate-server`, `just
coverage`) and never numbers, so 15r-tst-i's pending rate ratchet can replace the
absolute-count baseline without editing it. One clause exists only because a red-team prototype
measured the bypass: no stray pipe table may appear anywhere in the file, since a
blank-line-separated decoy with re-cased headers is invisible to the parser and more prominent
to a human.

**ADR back-link reciprocity (12r-f):** ADR-0104 D1 already required that "an ADR
that only *amends* another stays `Accepted`; the amended ADR gains
`**Amended-by:**`", but only `checkRefs` enforced anything — a one-directional
dangling-reference check, so a *missing* back-link passed green and 55 accumulated
(54 forward, 1 reverse).
`validateBacklinks()` in `scripts/adr-digest.mjs` now mechanizes the invariant in
both directions. It is **era-scoped**: enforced only when BOTH endpoints are
`>= BACKLINK_ERA_MIN` (`0151` — the oldest ADR 12r-f repaired). Repairing a
pre-era back-link is a semantic claim ("did 0116 really amend 0103?"), not a
formatting fix, so the below-era gaps (44 as of 12r-f) are counted in a one-line
WARN summary rather than itemised or enforced. The in-era gaps that predate the
gate (five at 12r-f) sit in `KNOWN_BACKLINK_GAPS`, which **may only shrink** — a ratchet errors on an entry
whose gap is already repaired, and a frozen duplicate of the set in
`evals/adr-backlink-corpus.eval.mjs` asserts set equality so growth needs two
visible edits in two directories. Back-link resolution reads a fence-stripped
header view and accepts bare `NNNN` as well as `ADR-NNNN` (nine ADRs of the
0151–0164 era write bare ids); normalising those to `ADR-NNNN` per ADR-0104 D1,
and adding an `Amended-by` column to `DIGEST.md`, are follow-ups. Teeth:
`evals/adr-backlink-integrity.eval.mjs` + `evals/adr-backlink-corpus.eval.mjs`.

Research library (`docs/research/*.md`) carries `type: Research Note` (additive;
validated by the vendored `research-lint.mjs`; `INDEX.md` regenerated with `type`
column via `research-index.mjs`).

## Cache (M13.5d — ADR-0089)

Hot-path content registries cached at the shell layer; **game-core stays pure** (zero caches, all functions deterministic). Compile-time embedded RON is immutable → safe to cache static references.

**Server-module hot-path caches** (`server-module/src/content_cache.rs`):
- `static ZONE_MAPS: LazyLock<Result<Vec<ZoneMapDef>, String>>` — parsed zone-map registry; `movement_tick` calls `(*ZONE_MAPS).as_ref().map_err(Clone::clone)` for per-zone tick lookup (was O(registry) per tick, now O(1))
- `static EVOLUTIONS: LazyLock<Result<Vec<SpeciesEvolutions>, String>>` — evolution conditions; `battle.rs` hoists `load_evolutions()` out of per-monster loop
- `static DIALOGUE_TREES: LazyLock<Result<Vec<DialogueTree>, String>>` — dialogue data; `npc.rs` caches for `talk` / `advance_dialogue` reducers
- `static QUEST_DEFS: LazyLock<Result<Vec<QuestDef>, String>>` — quest registry; placeholder for future quest-lookup optimization
- `static ABILITIES` / `static HEAL_LOCATIONS` (11r-g, ADR-0170 D2/D3) — same `LazyLock` shape; `battle.rs`'s four ability sites and `heal_party`'s cost lookup stop re-parsing RON per call
- `cached_type_chart(ctx)` (11r-g, ADR-0170 D1) — NOT a `LazyLock`: type relations are DB rows, so the cache is a `Mutex<Option<(u32, Arc<TypeChart>)>>` keyed on `config.content_version` (single writer + same-txn version stamp make a version match prove row identity); Err never cached; must never be called from a `type_relation_row`-writing transaction (source-scan-pinned)
- **Pattern:** `LazyLock` not `OnceLock::get_or_try_init` (unstable); `Result<&'static Vec<T>, String>` propagates errors via `map_err(Clone::clone)`

**Client-wasm two-level cache:**
- **Level 1 (registry):** `static ZONE_MAPS_REGISTRY: LazyLock<Result<Vec<ZoneMapDef>, String>>` — one-time parse of full zone-map registry at first `zone_map(zone_id)` call
- **Level 2 (active zone):** `thread_local! { static ACTIVE_TILE_MAP: RefCell<Option<TileMap>> = const { RefCell::new(None) }; }` — built tile map for currently-active zone. `const { … }` initializer avoids clippy `missing_const_for_thread_local` lint. Invalidated on `set_active_zone` via `RefCell::take` before warp prediction
- **Parity:** client-wasm and server share deterministic `map_for(zone_id)`, cached tile map returns identical `TileMap`

**Determinism + parity gates (all green):** no wall-clock or unseeded-RNG introduced; `prediction-parity.eval.mjs` confirms `apply_move` unmarked; wrapped parse step, logic stays in game-core; schema/bindings unchanged. Performance: O(registry) → O(1) lookup on hot paths (200ms movement_tick, per-step warp checks).

## Decisions

ADRs **0002–0034** are design ADRs that live in the harness spec corpus
(`../../specs/monster-realm-v2/adr/`); **0001** is mirrored in both locations.
Implementation ADRs **0001, 0035 onward** live in `docs/adr/` — see
`docs/adr/README.md` for the two-location navigation rules + next-free number and
the generated `docs/adr/DIGEST.md` for the navigable catalog: the current range +
one-line-per-ADR digest (the hard upper bound is deliberately not repeated here;
`DIGEST.md` is the sole enumeration, drift-gated by `just adr-digest`). **ADR numbering note:** the harness
spec corpus also contains design ADRs numbered `0055`–`0057` (different topics from
the project's implementation ADRs `0055`–`0057`); when resolving a bare `ADR-0055`
citation, check context — a `docs/adr/` path prefix disambiguates to the project
implementation record. Highlights: 0035 scaffold
hardening, 0036 wasm boundary, 0037 STDB/content deps, 0038 proptest, **0039
two-window e2e CI gate**, 0040 RLS fallback split-tables, 0041 integer damage
formula, 0042 battle table public PvE (privatized 15r-sec-a/ADR-0198), 0043 CI caching + fast inner loop, 0044
private encounter table, 0045 private `battle_wild` individuality table, 0046
player inventory model, 0047 recruit resolution, 0048 `start_battle` opponent
provenance, 0049 panic-as-content-invariant policy, 0050 nightly mutation/
coverage + bindings-drift-in-ci, 0051 biome lint scope, 0052 bounded client prediction, 0053 swap-legality pure-core invariant, 0054 dev-reducer release-gating, 0055 release fail-loud + determinism-gate completeness, 0056 server-module modularization (domain submodules — the canonical `touches:` vocabulary), 0057 content-directory glob loading via `build.rs`, 0058–0061 raising/training/evolution content+rules, **0062 evolution/fusion server reducer guard ordering, bond-write omission, and test-seam placement (superseded by 0177)**, **0063 evolution/fusion client overlay (evolvesTo decode, fusion recipe display, coverage exclusion — superseded by 0177)**, 0064–0067 zone/warp data shape + server runtime + client follow-camera/global-subscription (**ADR-0067 accepted: global character subscription per Option C; per-zone re-subscription deferred to M20**), 0068–0071 NPC/dialogue/quest/heal (game-core rules + server reducers + content + client UI), 0072–0079 M12.5 residual fixes (fuse dual-write fix, content-sync repair, zone-sync robustness, netcode smoothness, gate teeth, battle lifecycle GC, practice-XP multiplier, nightly republish smoke), **0080 generated knowledge bundle** (OKF-conformant `docs/knowledge/` bundle, drift-gated, M8.95), **0081 currency primitive** (private `player_wallet` table, `apply_grant`/`apply_spend` in game-core, `grant_currency`/`spend_currency` server helpers, M13a), **0082 shops & buy/sell** (shop content + reducers, sell_price field, M13b), **0083 economy sinks/sources** (healing cost via `spend_currency`, quest/battle rewards via `grant_currency`, M13c), **0084 shop client view** (wallet-private gap, feedback surface, M13d), **0085 reducer-rejection feedback + reconnect** (Predictor.dropRejected, sendGuarded, app-level rebuild-with-backoff, M13.5b), **0086 CI e2e dev_reducers publish** (`--features`/`--bin-path` topology, M13.5h), **0087 owner-scoped view** (`#[view]` over private `player_conversation`, M13.5c), **0088 nightly mutate-core repair** (smoke-republish fix, timeout tolerance, M fix-nightly), **0089 content parse caching** (hot-path zone-maps/evolutions/dialogue via `LazyLock` statics; client-wasm two-level cache; game-core stays pure, M13.5d), **0090 client UX correctness** (bait save/restore, zone-switch guard, adaptive interp delay, render perf, M13.5e), **0091 type-rigor hardening** (GrantItem once-only gate, exhaustive trigger match, Result-propagation in battle/taming, check_party_slot+SlotError, marshal re-checks, M13.5f), **0092 status-effect rules** (StatusEffect enum, BattleStatusStore, resolve_full_turn, M14a), **0093 server status persistence** (StatusEffect→types.rs, BattleMonster.status field, StatusCured.slot RT-S14-01 fix, resolve_full_turn wiring, M14b), **0094 passive-ability system** (StatusKind payload-free, AbilityEffect exhaustive, validate_abilities sibling, apply_entry_ability/apply_ability_modifiers hooks, M14c), **0095 weather/field-state** (WeatherKind + FieldState content + server persistence, M14d), **0096 status-curing items** (applies_status on SkillDef, cure_status on ItemDef, use_battle_item reducer, client status badge, M14e), **0097 Phase B completion marker** (ARCHITECTURE.md M14 section, R1/R2/R3 residual register, M14f), **0098 swap/recruit post-turn pipeline** (run_post_turn_phases, load_skills replaces skill_defs_from_rows, ADR-0092 D3 amended, M14.5a), **0099 StatusApplied slot + Phase 4.5 drop-if-fainted** (slot field on StatusApplied, phase-4.5 faint guard, M14.5b), **0100 ability-system end-to-end wiring** (species_row.ability column, build_ability_store, AbilityStore threaded through all three resolve functions, five reducer paths, CONTENT_VERSION 10→11, M14.5c), **0159 care-button feedback + collision-aware NPC wander** (in-overlay showFeedback idiom D1; npc_decide with facing/map params for legality-aware wander D2; feel-polish), **0174–0177 essence-graph evolution** (schema/type freeze; reducers + event-based auto-evolution; ten-edge content registry; Migration B removing `bond`/`evolves_to`/`fusion` + gate migration — fusion deleted as a feature, ADR-0060/0061/0062/0063/0064/0147/0149 superseded). See also
`docs/validation-findings.md` (empirical Tier-1 results).

## Monster subsystem (`game-core/src/monster/`, M6a)

Pure, deterministic rule layer for monster individuality and progression.

- **`types`** — value objects: `IVs` (0–31, custom Deserialize), `EVs` (252/510
  caps, custom Deserialize), `Nature` (25-variant 5×5 grid), `Level` (1–100,
  custom Deserialize), `Xp`, `StatBlock`, `MonsterInstance`. Parse-don't-
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
- **Monster privacy (ADR-0040, hardened by ADR-0194 / issue #284)**: RLS
  (`client_visibility_filter`) is unavailable (crate-`unstable` feature only;
  `Filter::Sql` cannot express `Vec<u64>` membership) — re-verified unchanged
  at 2.8.1 (ADR-0197). Mechanism: **private**
  `monster` table (hidden genes: IVs, EVs, nature) + since 13r-e a **private**
  `monster_pub` projection (safe fields only) read exclusively through the
  owner-scoped **`my_monster_pub`** view — other players' monster_pub rows are
  need-to-know and are not delivered at all (no client consumer exists; the
  engagement view is a specified deferral in ADR-0194). Dual-write discipline
  unchanged; the `monster-privacy` eval pins the view body/signature/inventory,
  the subscription allowlist, and the bindings file set (proof-of-teeth for
  each clause).
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
- **Connection wiring** (`net/connection.ts`): subscribes to the owner-scoped
  `my_monster_pub` view (13r-e, ADR-0194) and the `species_row` table. The
  PK-less view never fires `onUpdate`; its handlers only schedule the
  `MicrotaskBatcher`, whose flush closure reconciles the store's monster map
  from the SDK cache before `flushBatch()`.
- **Main integration** (`main.ts`): 'B' key toggles box overlay, Escape closes
  it, movement input suppressed while open. Reducer calls (`setNickname`,
  `setPartySlot`) routed through the connection. `__game()` snapshot extended
  with monster data.

## Combat subsystem (`game-core/src/combat/`, M7a — ADR-0041)

Pure, deterministic, integer-only combat resolution engine. All battle rules
live here exactly once (ADR-0003 SSOT). Randomness injected via `TurnVariance`.

- **`types`** — value objects: `BattleMonster` (projected stats for combat),
  `BattleSide` (active slot + team roster with auto-switch; `BattleSide::with_lead`
  seats the first `hp > 0` member as the lead at construction and returns `None`
  for an empty/all-fainted side, so a 0 HP monster is never sent out — team order
  is preserved because `team[i]` is positionally coupled to the caller's
  monster-id list, ADR-0156), `BattleState`
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
- **Private `battle_wild` side-table (ADR-0045):** `battle_id` PK (1:1 with the `battle` row),
  `wild_species_id`, `wild_level`, `individuality_seed`. Stores the rolled
  seed, NOT expanded IV/nature columns — `roll_individuality(seed)` is pure/deterministic
  so the seed is the SSOT. **The `battle` table (ADR-0042, private since 15r-sec-a/ADR-0198) carries zero wild-gene
  columns.** The `wild-individuality-privacy` eval (cloned from the ADR-0044 6-teeth
  pattern) mechanically enforces: table is private, no projection, no generated accessor,
  AND no `wild_`/`iv_`/`nature` field on the `battle` table.
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
  EVs zero, `party_slot: None`, `xp = xp_for_level(level)`. Rebuilds
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

M9 closed the "tame → raise" arc: originally bond accrual via care (Bond retired at EG5 — `care` now credits Trust, EG2/ADR-0175/0177), EV training via consumables, and NPC healing.

- **Pure rules (game-core):** `evaluate_care(last_care_at_ms, now) → Result<(), String>` (cooldown-only seam since EG5/ADR-0177 — Bond retired; lives in `server-module/src/raising.rs`, delegating to the shared `is_cooldown_ready` SSOT, the same shape as `evaluate_heal`); `evaluate_train(monster, item_def) → Result<TrainResult>` (SSOT via `focus_train`: EV-grant capped at 252/510, `current_hp` never written per ADR-0058); `evaluate_heal` seam (HP + status restore). The care magnitude `CARE_COOLDOWN_MS` and the cooldown-ready predicate `is_cooldown_ready(last, now, cooldown) = now.saturating_sub(last) >= cooldown` live in `game-core/src/raising/rules.rs` (ptc5e, ADR-0140) — one SSOT predicate shared by both the care and heal cooldown gates (siblings of `CHALLENGE_TTL_MS`/`is_challenge_stale`).
- **Server — `raising.rs`:** `care` reducer (ownership-checked → `evaluate_care` cooldown gate → Trust-favorable increment + `trust_tier` recompute + `accrue_quality_time` + `check_and_evolve`, EG2/ADR-0175; cooldown from `ctx.timestamp` via the shared `is_cooldown_ready` seam; `last_care_at_ms: i64` additive column on `monster`); `train` reducer (ownership-checked; decision-before-`consume_one` ordering: reject never charges bait; calls `evaluate_train` then `consume_one`); `heal_party` reducer (in-battle SideA-won-only guard, zone + F7 position guards, full HP restore, upsert cooldown via the shared `is_cooldown_ready` seam — M12b, ADR-0069). Both `care` and `train` also carry the both-role ongoing-battle guard `is_in_ongoing_battle(ctx, ctx.sender)` (same SSOT helper as `heal_party`), rejecting mid-battle to close the bounded HP-laundering path where a mid-battle EV bump would inflate the in-battle level-up heal (ptc5a, ADR-0136 amends ADR-0122 §D7). Item definitions extended: `train_stat: Option<StatKind>` + `train_amount` additive columns; item id 2 = "Power Root" (first training food, CONTENT_VERSION 1→2).
- **Server — `inventory.rs`:** `grant_item`/`consume_one` — the single item-mutation surface (ADR-0059): every grant/consume path for the `inventory` table routes through these two helpers, enforcing the single-stack-per-`(owner, item_id)` discipline and delete-at-zero / capped qty.
- **Client (M9c):** `raisingModel.ts` (pure subscription view — verbatim server stats, `canTrain` data-driven from `item_row.train_stat`, owner-filtered `ownInventory` deep-copy + `itemDefs` structure-copy); `raisingView.ts` (text overlay, coverage-excluded); 'I' key toggle with mutual exclusion (box/battle supersede per ADR-0014). No new ADR for client (pure subscription pattern, ADR-0016).

## Economy (`game-core/src/currency.rs` + `server-module/src/economy.rs`, M13a — ADR-0081)

Currency primitive: one `u64` balance per player, PRIVATE owner-scoped table, single mutation surface.

- **Pure rules (`game-core/src/currency.rs`):** `MAX_BALANCE = 999_999_999` (9-digit UI cap); `apply_grant(balance, amount) -> u64` — `saturating_add` + `.min(MAX_BALANCE)` (monotone, never wraps); `apply_spend(balance, amount) -> Result<u64, &'static str>` — `checked_sub` reject-not-clamp (never negative, `Err("insufficient funds")` on over-spend). 14 unit + 3 proptest property tests.
- **Private `player_wallet` table (ADR-0081):** `(owner_identity: Identity [PK], balance: u64)`, **no `public` attribute** — non-owner subscriptions are impossible (SpacetimeDB omits private tables from table accessor codegen; only the type definition is generated for reducer argument serialization). Mirrors ADR-0015 must-never-leak requirement.
- **Server wrappers (`server-module/src/economy.rs`):** `grant_currency(ctx, owner, amount)` (upsert; 0-amount no-op, no phantom row) and `spend_currency(ctx, owner, amount) -> Result<(), String>` (find-then-update; 0-amount returns `Ok(())`; missing wallet or insufficient balance returns `Err`). Both are `pub(crate)` — no public reducer surface yet (M13b+ adds shops/sinks).
- **Single-surface discipline:** every economy mutation routes through these two helpers. The `currency-integrity` eval (6 proof-of-teeth criteria) mechanically blocks direct `.balance +=`, unchecked subtract, `PlayerWallet {}` literals, and `player_wallet()` accessor calls outside `economy.rs`/`schema.rs`.
- **Residuals:** starting balance (0) is content-tunable via `grant_currency` in a quest/join reducer; shops, sinks, and XP→currency conversion come in M13b+; per-owner transport RLS deferred until per-row RLS lands (same pattern as inventory, ADR-0046).

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
- **Sources:** `apply_quest_trigger` (called from the **`talk`** reducer at `npc.rs:270-277` — its only call site; `advance_dialogue` fires no trigger at all. Corrected by 11r-e/ADR-0169 D6, which depends on this mechanism) grants `reward.currency` on `QuestComplete` via `grant_currency`; `write_back_battle_results` in `battle.rs` grants `battle_currency_reward(bst)` on SideAWins (pure helper in `game-core/src/currency.rs`, returns `u64` reward based on loser battle stats — content-tunable via game-core). All routes through M13a helpers (single-surface discipline, ADR-0081).
- **Validation:** `validate_heal_locations` added to `validate_content` call in `sync_content_inner`; **next-free ADR = 0085**.

## Economy client (`client/src/`, M13d — ADR-0084)

Shop screen and wallet display client integration.

- **Store extension:** `shop_row` and `shop_item_row` subscriptions ingested into `AuthoritativeStore` via `MicrotaskBatcher` (same pattern as M7c battle tables). `StoreShopRow` and `StoreShopItemRow` interfaces; `store.shops()` and `store.shopItems()` keyed accessors.
- **Pure view-model (`shopModel.ts`):** `buildShopViewModel(shops, shopItems, itemDefs, ownInventory, ownWallet?) -> ShopScreenViewModel` — pure function (ADR-0016), sorts by lowest `shop_id` (deterministic), aggregates inventory by `item_id` (matches sell reducer contract). No DOM, fully node-testable. The 5th parameter is the ux2 balance (ADR-0154).
- **Client store (`shopStore.ts`):** the `player_wallet` **table** is never subscribed — private (ADR-0081/0040), and SpacetimeDB skips private tables during codegen so no table binding exists. Until ux2 the only balance surface was transaction feedback: async `buy()`/`sell()` promise rejection messages surface insufficient-funds/out-of-stock errors; successful transactions increment/decrement local inventory view atomically. **ux2 (ADR-0154) adds the owner-scoped `my_wallet` view as the sanctioned read path** — see the M-postgate-ux-hardening section.
- **DOM shell (`shopView.ts`):** thin overlay rendering inventory grid + buy/sell buttons. KeyG trigger, full mutual-exclusivity with all overlays (B/I/E/dialogue guards check shopView state too per ADR-0014). `#pending` boolean flag + `btn.disabled` in-flight lock prevents double-spend (await completes before next click). `SHOP_QTY = 1` const (ADR-0082 D5 single-unit MVP).
- **Connection wiring (`net/connection.ts`):** subscribes to `shop_row` and `shop_item_row` tables; wires `onInsert/onUpdate/onDelete` to store via `MicrotaskBatcher` (same pattern as monsters/battles).
- **Main integration (`main.ts`):** KeyG toggles shop overlay, Escape closes it, movement/action suppressed while open. Reducer calls (`buy`, `sell`) routed through async Promise pattern (ADR-0084); catch block on failure logs and renders error toast (or message-append feedback surface, deferred to M13.5/M23).
- **ADR-0084 spec gap — CLOSED by ux2 (ADR-0154), and NOT the way this line predicted.** The gap was real (`player_wallet` privacy meant no client-side balance display), but the suggested remedy — a public `player_wallet_pub` projection table, by analogy with `monster_pub` — was rejected: a projection table is a second write surface over a balance, which ADR-0081's single-surface discipline exists to prevent. The chosen route is an owner-scoped `#[view]` (the ADR-0087 `my_conversation` pattern), which adds a read path and no write path.

## Accounts & auth client (`client/src/`, M21b-2 — ADR-0179/0182)

OIDC sign-in, guest→account claim UI, and session lifecycle on the imperative shell. The forward
sign-in redirect only fully functions against a real deployed Better Auth issuer (a deployment-timed
follow-up, hard-gated on `13r-c-2`); against the placeholder `.invalid` issuer it degrades to a
handled sign-in-failed state.

- **Pure core (`net/`):** `credentialDecision.ts` (`decideConnectCredential` — the full `outcome ×
  everAuthenticated × consecutiveTransientErrors` branch table, injected-total, no I/O); `oidc.ts`
  (hand-rolled over Better Auth's OIDC endpoints — discovery cache, `state`+PKCE S256 mint/scrub/
  compare, `renewOrExchange` a total function, no new runtime dep); `claimCode.ts` (client-minted
  256-bit code over per-tab `sessionStorage`, AUTH-60). All host/`fetch`/`crypto`/storage injected.
- **Connection shell (`net/connection.ts`):** `resolveCredential` (async, the one I/O boundary) feeds
  a synchronous `build(credential)` widened to `DbConnection | undefined`; every async/exception
  boundary is defensively total so the reconnect ladder can't silently stop (ADR-0182 C1/RT-01).
  `my_account` is subscribed and is the **sole** "is this connection authenticated" authority (D15);
  the write-guard's credential class is in-memory provenance, never a storage re-read (D14). The
  claim-code join-gate is an unconditional veto scoped to account-class connections, re-evaluated
  fresh every `onApplied`, closing F2 across reconnects (D16). `startSignIn`/`reconnectNow` expose the
  forward-redirect and session-retry through the `{kind, token}` seam — provider-agnostic by design
  (a future Steamworks-ticket flow swaps in behind it, ADR-0182 Consequences).
- **Session/claim UI (`ui/`):** paired pure-model/DOM-shell splits — `sessionModel`/`sessionView`
  (registry-external `hidden|expired|unreachable`, driven directly by `conn.sessionState()`, D17) and
  `claimModel`/`claimView` (`claimView` joins `overlayRegistry` as `GUARD_ONLY`; the 4-way reject
  taxonomy mirrors `complete_guest_claim`'s guards). `menuModel`/`helpModel` add the `KeyC` account
  leaf. No credential value or claim code ever reaches a log/telemetry sink (AUTH-57, `evals/
  client-no-pii-logs.eval.mjs`).
- **Deployment (`ops/auth/`, `docs/observability-dr-runbook.md` §8):** self-hosted Better Auth
  (compose + `.env.example` + README recipe, no committed runtime/secret) with a DR posture whose
  first line item is JWKS signing-key custody (ADR-0182 D20). Native email+password is dev/QA-only
  (OQ5). The self-contained live claim flow is exercised end-to-end by `evals/account-e2e.eval.mjs`.

## Reducer-rejection feedback & app-level reconnect (`client/src/`, M13.5b — ADR-0085)

Closes the silent phantom-intent desync and the dead-button/blank-reconnect gaps from the seventh review. SDK 2.6 has no per-reducer callbacks and no auto-reconnect on the raw builder path; each reducer call's Promise (rejects on `Err`, NEVER settles on a drop) is the rejection surface.

- **Prediction (`prediction/predictor.ts`):** `dropRejected(seq)` evicts a KNOWN-DEAD pending op — a rejected seq is never acked, so it would survive the `seq > ackedSeq` prune forever and replay a phantom move at every reconcile. Mutates only `#pending`; on `true` the caller forces `reconcileFromStore()` (a rejected burst-tail produces no further authoritative batch). Categorically distinct from `#pendingCap` backpressure, which never drops recorded ops (gating tests pin the `setMove`/`clearQueue` cap bypass).
- **Reconnect policy (`prediction/reconnectPolicy.ts`):** pure flat state `{link, attempt}`; freeze is derived (`linkFrozen ≡ link !== 'connected'`), transitions idempotent (the SDK's onerror-then-onclose double event cannot double-schedule); `reconnectDelayMs = min(1000·2^attempt, 30_000)`, attempts unbounded. `attempt` counts consecutive FAILED builds (cold-start rung asymmetry documented in ADR-0085).
- **Status surface (`ui/statusModel.ts`):** pure `reduceErrorMessage` (SenderError reason passes through; InternalError detail NEVER leaks; classification by `err.name` equality, not `instanceof`) + fallback-guarded `subscriptionErrorMessage`. The DOM write is `textContent`-only via `reportError` onto a dynamically created `#status` div (main.ts — no index.html edit).
- **Shell (`net/connection.ts`):** app-level rebuild-with-backoff — one `scheduleRebuild()` timer handle, shared `handleDrop()` (store.reset → freeze → surface once → schedule), `wireTables` re-registers ALL table handlers per build, ONE `MicrotaskBatcher` across rebuilds, `joinGame` unconditional on apply with exact-match benign `already joined` catch, `pagehide` teardown + `pageshow(persisted)` bfcache inverse (RT-PH-01), getter-backed `conn` (never cache across await points).
- **Send gating (`main.ts`):** `sendGuarded(where, call)` wraps every non-movement send — frozen short-circuit ("disconnected — try again") plus `.catch` → status line; movement rejections stay silent (prediction repair, M2 §3); `healTargetLocationId` returns `undefined` = SKIP (ends the `locationId: 0` guaranteed-Err); the shop double-spend lock is released on reconnect via `shopView.hide()` (RT-PL-01 — an in-flight buy/sell at drop time never settles).

## Playtest observability (`client/src/ui/`, pt-b1 — ADR-0130)

Client-only observability layer extending the M13.5b error seam for the playtest gate. `game-core`/wasm untouched (determinism per ADR-0003); server `playtest_event` table is pt-b2.

- **Event ring (`ui/eventRing.ts`):** capped FIFO (`EVENT_RING_CAP=256`, oldest-evicted) of the H1/H2/H3 proxy `PlaytestEvent` union (identity-hex/ids/numbers only, no PII); monotonic `tSeq` + injected clock (deterministic under test). 6 core events wired in main.ts (connect/disconnect/zoneChange/battleStart/battleEnd/rankedMatch via dedicated unconditional `onBatchApplied` latches); 8 correlation-heavy variants pre-committed but parked to pt-b1b.
- **Error surface (`ui/errorRing.ts` + `errorOverlayModel.ts`/`errorOverlayView.ts`):** window `error`/`unhandledrejection` + augmented `reportError` funnel through total `normalizeError` (cap `ERROR_MSG_MAX_LEN=512`, `ERROR_RING_CAP=64`) into a self-mounting (`#mr-error-overlay`), non-blocking (`pointer-events:none`, off the movement-suppression list), `textContent`-only overlay; re-entrancy-guarded.
- **F9 bug bundle (`ui/bugBundle.ts`, pure):** one keypress → Blob download of `{buildSha, identity, zone, event ring, error ring, non-PII key-store allowlist}`; **no network** (bugBundle.ts imports nothing from `net/*`; bigint-total serializer; CSP-fallback to console), so it works when the connection is the bug.
- **Outbound dev log (`net/devLog.ts`, pure — dev-observability, ADR-0157):** `VITE_MR_DEVLOG` (`off` | `send` | `send-move`, default `off`) gates a Proxy installed at `build()`'s return in `net/connection.ts`, logging every outbound reducer call (name + args) to `console.log`; `send` excludes the `enqueueMove` movement flood, `send-move` includes it. **Strict identity when disabled** (`wrapReducerLogging(c, undefined) === c`) so the default production build allocates no Proxy and emits nothing. Deliberately **console-only — never the event ring or the F9 bundle**: reducer args carry player free text (`joinGame`/`setNickname`/`setProfileName`) and the bundle is a shared artifact bound by the pt-b1 no-PII rule. Fail-loud asymmetry is **inverted** vs pt-a1: an unknown token throws in dev but degrades to `off` + one `console.error` in prod, because the eager module-scope resolve runs before the error listeners exist and a throw there would blank the session. Enforced by `evals/dev-observability-gating.eval.mjs` (zero runtime imports ⇒ the module structurally cannot reach the ring).

## Evolution (essence graph) (`game-core/src/evolution/` + `server-module/src/evolution.rs`, EG1–EG5 — ADR-0174/0175/0176/0177; supersedes the M10a fusion-era shape, ADR-0060/0061/0062/0063)

Evolution is a real, public, subscribable directed graph; **fusion is deleted as a feature** (Drew's r2 directive via the harness ADR-0019 amendment 2026-08-02 — removed, not repaired). Species carry `tier: u8` (0–5 provisional cap, monotonic); `evolution_path` edges are AND-combined gates over `min_level`, per-Affinity essence balances, and Trust / Quality-Time / Nutrition tiers. Essence reuses the 8-variant `Affinity` enum — earned from wild-battle wins (typed by the *defeated* species, practice- and PvP-exempt), the cooldown-gated `essence_train`, or crystalized-essence items; all 8 pools zero on every evolution. Bond is retired (both roles absorbed by Bayesian-smoothed Trust, K=10); its storage was removed by Migration B (this section's ADR-0177 D2).

- **Content (EG3 — ADR-0176):** `content/evolution_paths/*.ron` (ADR-0057 glob directory; replaced `evolutions.ron` + `fusion.ron`, both deleted). Each entry authors a durable, append-only `edge_id` (the durable edge identity — never `path_id`, the DB auto_inc key; ADR-0174 EG1-12). Ten edges shipped: the 1/2/3-family, species 7/8 common + item-assisted branches, 20→22, 21→23, and the Steamveil fan-in fix (6 ← 1 with Water 120, 6 ← 2 with Fire 120). Validated by `validate_evolution_paths` rules R1–R12 (dup-pair, self-evolution, dangling refs, vacuous path, tier-monotonicity `+1`, derived-not-wild, essence-cap ≤3, fan-in-permitted, essence-item single-role, universal reachability, tier cap, `edge_id` uniqueness) — live at `sync_content`, mirrored textually by `evals/evolution-content-integrity.eval.mjs` (which also owns the cross-revision `edge_id` ever-issued ledger, `evals/baselines/evolution-path-edge-ids.json`).
- **Pure rules (EG1 — ADR-0174):** `game-core/src/evolution/eligibility.rs` — `path_satisfied(instance, path)` (the ONE shared 5-gate predicate: level/essence/Trust/Quality-Time/Nutrition) + `eligible_evolution_paths(instance, paths) -> Vec<usize>` (full eligible set, powers the panel/choice UX) + the three tier-derivation helpers `trust_tier_of` (Bayesian `(fav+10)/(fav+unfav+20)`), `quality_time_tier_of`, `nutrition_pct_of`. `transform::evolve` carries all individuality per ADR-0019, `current_hp` clamped to new max. `EvolutionTrigger`/`EvolutionCondition`/`SpeciesEvolutions`/`FusionRecipe`, `resolve_evolution`/`evolves_to`, `fuse`/`fusion_eligible` and the ADR-0147 taxed-carry math are all deleted.
- **Server (EG2 — ADR-0175):** `evolution.rs` — `evolve(ctx, monster_id, to_species)` (ownership + both-role battle-escrow + trade-escrow guards; indexed `(from_species, to_species)` lookup; fresh server-side `path_satisfied` check naming the failing requirement on reject) delegating to the shared `apply_evolution` (zero essence, fresh-lookup `MonsterPub.tier`, dual-write; Trust/Quality-Time/level survive). `check_and_evolve` (event-based auto-evolution): called last from the five mutation sites (`care`/`train`/`essence_train`/`write_back_battle_results`/`enqueue_move`), 0 eligible → no-op, exactly 1 → auto-apply same transaction, 2+ → waits for the player's explicit `evolve()`; chain cascade bounded by the tier cap + a hard iteration guard. `essence_train` + `consume_crystalized_essence` share one cooldown clock (`last_essence_train_at_ms`), full guard set incl. item trade-escrow and decision-before-consume. Gates: `evals/evolution-reducer-security.eval.mjs` (E1–E5 + S1–S6), `evals/no-idle-accrual.eval.mjs` (growth-writer confinement, never-scheduled accrual, struct-literal confinement), `monster-dual-write`'s CAPTURE_INSERT teeth (ADR-0072). **Migration B (EG5 — ADR-0177 D2):** `bond`/`evolves_to` columns and the `fusion` table are REMOVED from the schema — a removal publish is always rejected by SpacetimeDB automatic migration, so a live DB on the Migration-A schema needs the ADR-0177 runbook (`--delete-data`, dev-sanctioned), never a plain republish.
- **Client (EG4 — supersedes the M10c/ADR-0063 shape):** `bond`/`evolvesTo` and the whole fusion surface (`StoreFusionRow`, `store.fusions()`, `FusionRecipeViewModel`) are **deleted** from the client. `StoreMonsterPub` instead carries the public essence-graph projection (`tier`, an affinity-keyed `essence` record, `trustTier`, `qualityTimeTier`, `nutritionPct`), and `StoreEvolutionPath` mirrors the public `evolution_path` table — keyed in the store by `pathId`, because `sync_content` republishes the table as an unordered delete+insert burst with re-minted ids. `evolutionModel.ts` ports `game-core`'s gate **comparison** predicate (`pathRequirements`/`pathSatisfied`/`unmetRequirement`/`eligibleEvolutionPaths`) so the requirements/progress panel and the party-roster badge compute eligibility client-side with zero server round-trip; the three tier-**derivation** helpers are NOT ported — the server publishes their outputs. Evolution is event-triggered: the client shows no Evolve action for the single-eligible case (the server auto-applies it) and renders a choice picker only at 2+ simultaneously-eligible paths. `EvolutionView` DOM shell (KeyE toggle, mutual exclusion with B/I/battle) remains coverage-excluded per ADR-0015 `dom-shell-coverage-exclusion`, and is now gated by a sibling `evolutionView.test.ts`.

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
  **14r-d (ADR-0185)**: all three GC steps (the `battle_wild` delete, the player
  prior-terminal sweep and the RT-M16-03 opponent sweep) now run *above* the fallible
  party-HP write, so an `Err` there can no longer skip them — the `check_team_coupling`
  exit still can, deliberately (ADR-0185 D7); and all four `battle.rs` terminal sites
  (`submit_attack`, `swap_active`, `flee`, the disconnect GC) log-and-commit rather
  than `?`-abort into an `Ongoing` row. The two `taming.rs` sites (`:169`, `:270`)
  still `?`-propagate — disclosed in ADR-0185 D3 as the named follow-up.
- **(a2) Ranked-requires-account activation debt (14r-g — ADR-0189)**: both PvP handshake
  reducers now gate on `accounts::is_account_holder` for BOTH parties via the pure
  `ranked_account_gate` seam (Drew's decision, issue #307; resolves ADR-0179 OQ2) — but the
  gate is **deployment-conditionally INERT** while `accounts::ALLOWED_ISSUERS` is the
  fail-closed `.invalid` placeholder (no account can exist in any environment until
  OQ1/13r-c-2 lands a real issuer). The `ea_ra_06a` canary in `pvp_tests.rs` self-expires at
  the issuer flip and its message carries the 5-item activation checklist the flipping slice
  owes: EARS-3 client affordance (pvpModel/pvpView + main.ts wiring), converting the three
  guest-PvP e2e specs to account-holding identities, removing the conditional + canary,
  knowledge regen, and the D7 in-flight/ladder-wipe decision.
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
merged). **11r-b** (PvP side-B battle overlay — ADR-0167) later made the battle
accessors role-agnostic: `store.ongoingBattle`/`latestPlayerBattle` match either PvP
role and return raw server rows, and `ownPerspective()` in `net/store.ts` is the single
view-boundary seam that re-seats the local player as sideA — wired exactly once, from
`refreshBattle` in main.ts, while diagnostics deliberately keep reading raw server
truth. **M8a** (taming rules — pure encounter triggering, recruit-chance arithmetic,
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
`apply_care` game-core SSOT — bond accrual retired at EG5/ADR-0177 D3, and `apply_care`/`Bond`/
`CareError`/`CARE_BOND_AMOUNT` deleted from game-core at 16r-g; `train` reducer: EV-grant food spend via `evaluate_train` →
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
individuality per ADR-0019; `fuse` per-stat-max-IV + higher-bond-nature + lower-slot + TAXED
carry — bond 75% of max, level max(75% avg, 50% max)≥1, EVs 75% of avg — ADR-0147);
46 unit/property tests; ADR-0061) complete. **M10b** (server evolution + fusion reducers —
`evolve` + `fuse` reducers in `evolution.rs`; additive `fusion` table + `evolves_to: Option<u32>`
column on `monster`; `compute_evolves_to` server helper; atomic fuse delete-two-insert-one in one
transaction; battle/escrow guards reused; `sync_content` calls `validate_evolution_fusion` so the
integrity gate is live on publish; ADR-0062; 16 server tests) complete.
**M10d** (evals + Phase A docs — `evolution-fusion-content-integrity` eval: 5 content-integrity
rules (no-dup-pair, derived-not-wild, dangling-refs, self-evolution, fusion-coherence) + 12
proof-of-teeth; `evolution-reducer-security` eval: 5 reducer invariants (ownership×2 for fuse,
battle-guard×2, fusion-eligibility delegation via `reject_if_not_fusable`→`game_core::fusion_eligible`
(ADR-0147, production-source-scoped: single-definition, arg-identity, Result-enforced, ordered
after ALL ownership checks), dual-write, SSOT delegation) + 23 proof-of-teeth fixtures
and a production-reader exclusion probe; ADR-0064)
complete.

**Phase A (M0–M10) complete.** The single-player core loop — move → find a wild monster →
tame by weakening + recruit → raise (train/care) → evolve or fuse — is fully built,
server-authoritative, and content-data-driven. All game rules live once in `game-core` (pure,
deterministic, property-tested); reducers are thin ownership-gated shells (reject-not-clamp);
content is RON data (additive, append-only, integrity-gated by `validate_content` +
`validate_evolution_fusion`). The 53-eval suite (all with proof-of-teeth) + full unit/
integration/e2e test coverage gates every invariant in CI. **Next: Phase B (M11 — authored
multi-zone world, ADR-0008/0020).**

**M11a** (zone-map data shape — ADR-0065) complete: `WarpDef`, `ZoneMapDef` in `game-core/content.rs`;
`load_zone_maps()` (embedded RON via `ZONE_MAPS_RON_PARTS`); `map_for(zone_id, zone_maps)` →
`Result<TileMap, String>`; `TileMap::warp_at(pos)` → `Option<&WarpDef>`; `validate_zone_maps`;
content: `content/zone_maps/000-core.ron` (zones 0 and 1, mutual warps at (5,5)); all re-exported from `game_core::`.

**M11b** (server warp runtime — ADR-0066) complete: warp resolution in `movement_tick` via
`warp_at` — fires on actual movement only (`prev != next.pos`), battle-guarded (C1 security finding;
since **11r-a / ADR-0166 D4** the guard is the both-role SSOT `guards::is_in_ongoing_battle(ctx, p.identity)`
— the former inline `battle().player_identity()` filter saw side A only, so a PvP side-B player walked
through a warp tile mid-ranked-battle. `unwrap_or(true)` means "no player row ⇒ an NPC ⇒ *skip* the warp",
ADR-0070, hence the local is named `skip_warp`); per-zone schedules managed by `ensure_zone_schedules` (private,
idempotent, additive, called from both `init` and `sync_content`); `validate_zone_maps` gates
`sync_content_inner` before any `zone_def` upsert. 36/36 evals pass.

**11r-c** (real server battle movement lock — ADR-0168, amends 0166) complete, server-only:
`movement_tick` gains a **drain-time battle lock** — a character whose player is in an ongoing
battle in EITHER role (`guards::is_in_ongoing_battle(ctx, p.identity)`, ADR-0122 SSOT) has its
drain SKIPPED with the queue INTACT (matching the sim-harness model, closing ADR-0166 R10's
harness-fiction drift), sited after the empty-queue arm and before `move_queue.remove(0)` so idle
characters pay no extra probes; `unwrap_or(false)` states the FACT "no player row ⇒ never in a
battle row" (deliberately opposite to the warp guard's ADR-0070 `unwrap_or(true)` POLICY — do not
unify). `enqueue_move`/`set_move` add an **intake reject** (`is_in_ongoing_battle(ctx, ctx.sender)`
→ `Err`, reject-not-clamp, first statement); `clear_queue` is deliberately NOT guarded (pure
cancellation — guarding it would strand the stale pre-battle queue to battle end). Closes the
walk-mid-battle hole that only honest-client overlay suppression previously covered; the eval W3
warp-guard needle is de-vacuified (`is_in_ongoing_battle(` vs the grass-check-satisfiable
`BattleOutcome::Ongoing`) and a new eval W6 pins the drain lock before the drain. Gate is
source-scan + eval (no reducer-executing harness, ADR-0156 P7). ADR next-free = 0169.

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
SpacetimeDB subscription-group API). **Superseded in part by uxd1/ADR-0160** — the canvas is no
longer unscaled and `offsetFor` no longer pins small maps to `(0,0)`; see the uxd1 note below.

**uxd1** (responsive viewport scaling — ADR-0160) complete, pure-client render edge (no server,
schema, or `game-core` change): a new pure module `client/src/render/viewport.ts` owns the whole
scale decision — `viewportScale(cssW, cssH, dpr)` picks an **integer** `deviceScale` (source→device,
so one texel covers a whole number of device pixels) aimed at `TARGET_VISIBLE_TILES` on the shorter
axis and bounded by `[MIN_VISIBLE_TILES, MAX_VISIBLE_TILES]` (MAX strict, MIN best-effort — the hard
`deviceScale >= 1` floor wins, since a sub-1 scale IS the blur bug), and derives the fractional
`stageScale = deviceScale / dpr` plus the effective viewport in SOURCE px. `app.init`/`renderer.resize`
now carry `resolution = devicePixelRatio` + `autoDensity` (the Pixi v8 defaults `1`/`false` were the
retina-blur root cause); `installResizeHandler` reads `innerWidth`/`innerHeight`/`devicePixelRatio`
at **fire-time** so a monitor drag re-crisps without a reload. `FollowCamera.offsetFor` branches
**per axis** — scroll-clamp when `mapPx >= view`, center at `-(view − mapPx)/2` when smaller — so a
wide-but-short map scrolls horizontally while centering vertically. **Unit contract:** `offsetFor`'s
`viewW`/`viewH` are now the effective viewport in SOURCE px, never CSS px; `WorldRenderer`'s old
`#viewW`/`#viewH` fields are deleted in favor of one `#vs: ViewportScale` so the CSS value is not in
scope at the call site. `stage.position` routes through the tested `worldToScreen` rather than an
inlined parallel copy. `screenToWorld` ships unwired as a seam for uxd2 (spec-directed).

**uxd2** (shop-via-NPC context interaction — ADR-0161) complete, full-stack additive slice: server-anchored `NpcInteraction{Dialogue, Shop(u32), Heal(u32)}` enum on the public `npc` table (SSOT for NPC roles; validated by `validate_npc_interactions` at seed); pure client resolver `client/src/ui/interactModel.ts` (`nearestInteractable`: distance → NPC-before-tile → id-within-kind; heal tiles join same resolver); generalized `KeyT` dispatch (Dialogue → `talk` reducer, Shop → greet-then-shop then open bound shop overlay, Heal → open bound overlay); frame-loop `#interact-prompt` positioned via `WorldRenderer.screenFor` (the exact offset+stageScale the stage applied that frame); removed global `KeyG`/`KeyH` hotkeys (helpModel rows dropped; overlays now open contextually). `CONTENT_VERSION` bump, bindings regen, zone-1 shopkeeper seeded. Proof: `shop-npc.spec.ts` e2e, resolver range/zone/kind-precedence tests, prompt anchor/label tests, default first-shop/first-location model-arm regression guards, validator teeth. **ADR next-free: 0162.**

**uxd3-a** (unified overlay IA — ADR-0162) complete, pure client chrome (zero reducer/schema/predictor/renderer surface): a new pure `ui/overlayRegistry.ts` holds the modality SSOT for all **15** mutual-exclusion overlays (`errorOverlayView` excluded by name) as a `Record<OverlayId, OverlayTier>` — `EXCLUSIVE_TOP={battleView}` · `HIDE_SWITCH={box,raising,evolution}` · `GUARD_ONLY=`the other 11 incl. the new `menuView` — plus a total `canOpen(target, visible)` reducer that considers EVERY blocker in manifest order (so `blockedBy` is deterministic and `forceHide` is the full qualifying set), and a `NEVER_FORCE_HIDE` invariant that makes force-hiding `dialogueView` unrepresentable across every target × blocker-set pair (a client-side hide would strand the server `player_conversation` row — ADR-0139). `ui/menuModel.ts` is the pure two-level nav core (5 categories / 11 leaves, depth-2 **structurally** via a two-member state union rather than a capped back-stack; grey-not-hide; availability enters as three plain booleans so the core never touches the store); `ui/menuView.ts` is a `textContent`-only happy-dom-covered shell with ONE delegated click + ONE delegated mouseover on the `<ul>`. Front door is `KeyM` (verified unbound; Escape deliberately NOT overloaded), wired as the 12th open-handler with the full 14-sibling guard list **plus `identity !== ''`**. `main.ts` gains `menuView` additively — one token into each of the 5 fan-out OR-lists and one `!menuView?.visible` into each of the 11 existing guard lists — because collapsing those surfaces would detonate a **17-test** source-scan cluster (`W-RN-/W-TP-/W-HELP-FANOUT-*`) for zero user-visible change; that collapse, the hotkey→thunk migration, the retirement of `W-OVERLAY-FANOUT-MUTEX`, and the `#menu-launcher` click front-door are **deferred to uxd3-b** (the replacement gate — manifest completeness + a `canOpen` invariant porting the ptc5c 9-case RED — lands and is proven green HERE, so uxd3-b deletes the old gate against a working substitute). The 7 non-trio hotkey open-bodies were extracted into named `openX()` functions so there is ONE open path per overlay (`held.clear()` stayed in the KeyN/KeyO *handlers* — it belongs to the keypress, and the menu route provably cannot leave a key held), and the interact dispatch moved into `interactAtNearest()` so the hotkey and the menu's Interact leaf share ONE exhaustive `switch (target.kind)` — which **re-anchored two uxd2 teeth** (`W-INTERACT-KEYT-DISPATCH/-SWITCH`) onto that function, content unchanged, plus a new assertion that the hotkey still routes through it. Drew's "Backpack"/"Journal" ask ships as leaf TITLES, not categories (`raisingView` IS the inventory, `questLogView` IS the quest log — a category would promise a screen that does not exist); Shop/Heal are deliberately NOT leaves (uxd2/ADR-0161 D5 removed their globals). The `#help-hint` badge was relabelled by **text node only** to `Press ? for controls & help · M for menu`, which survives every `indexShell.test.ts` H-tooth and keeps exactly one corner affordance. Named residuals: menu nav does not key-repeat (the `e.repeat` gate precedes the intercept; accepted — ≤5 rows with wrap); `onReconnect` has ~22 chars of headroom against `W-TP-RECONNECT`'s fixed window; the manifest scan is non-recursive `/View\.ts$/`. ADR next-free = 0163.

**uxd3-b** (overlay probe substrate + AC-12 click front door — ADR-0163, amends 0151/0162) complete, pure client chrome: the five hand-rolled overlay OR-lists in `main.ts` (`anyOverlayVisible()`, the nh2 reconcile emitter, the keydown movement suppression, the pvp auto-show aggregate, the rAF held-dir re-issue) collapse onto ONE `const overlayProbes: Record<OverlayId, () => boolean>` read through a new `anyVisible(probes, exempt?)` in `ui/overlayRegistry.ts` — 69 hand-maintained `View?.visible ||` terms → 0. The shell is deliberately READ-ONLY (no `open`/`hide`/`hideAllExcept`/`visibleIds`/handle object — zero consumers until uxd3-c, the same YAGNI call ADR-0162 A7/A15 made in this module). `main.ts` is coverage-EXCLUDED and `just ci` does not run e2e, so the source-scan teeth are the whole gate and are correspondingly exact: `W-FANOUT-SURFACES-ROUTE-THROUGH-REGISTRY` Part A pins the EXACT contiguous call shape per surface (a presence check was measured green against a one-character `!` inversion that kills all movement), Part B pins a byte-identical `<id>: () => <id>?.visible ?? false` per manifest member plus the value import, no local decoy, no spread and a whole-file ceiling of 3 on the identifier (a `Reflect.set` past the END marker was measured green without it — `Readonly` is erased at runtime), and Part C is a whole-file CEILING (named-idiom excision then zero residual) where the retired teeth were floors. AC-12 ships as attribute delegation: `#help-hint` gains `data-menu-launcher` + `pointer-events:auto` and `main.ts` matches `closest('[data-menu-launcher]')` in the pre-existing click listener, so it acquires no reference and `W-UX1-HINT-NO-JS-OWNER` stays green VERBATIM; `indexShell.test.ts` H4→H4b trades the blanket `pointer-events:none` ban for a BOUNDED surface (a CSS property ALLOW-list — a growth deny-list was measured unclosable by `zoom`/`border`/`scale`). **21 teeth retired (deleted, never skipped)**; honestly, the two `*-FANOUT-COUNT` floors would have stayed GREEN and were deleted deliberately, the leaderboard exact-count parity self-check is a genuine net loss (Part C sees only the `||` spelling — a de-Morgan `&&` sixth surface passes), and TWO of the four `*-FANOUT-PVP` teeth (`W-RN-`/`W-TP-`) were already vacuous on master — they sliced from the FIRST `anyOverlayVisible`, i.e. the shared predicate, never the pvp aggregate (the other two DID read the aggregate; their coverage is carried by surface 4's needle, which additionally pins the exempt id). Also deleted: three provably-dead `tradeView?.hide()` lines in KeyB/I/E. **Deferred to uxd3-c** (the last piece of `M-postgate-overlay-registry`, still NOT retired): per-id open/hide thunks, `hideAllExcept`, the `refreshBattle`/`onReconnect` collapses, the 12 hotkeys → `canOpen`, and the retirement of `W-OVERLAY-FANOUT-MUTEX` — deferred because it is the ONLY executable guard that KeyB's list contains `!dialogueView?.visible`, so deleting it before a caller consults `canOpen` is a strict weakening (AC-20 erratum: the EARS never required a caller). Named residuals: the clickable badge can occlude buttons in the nine in-flow overlay shells (measured clean — `just e2e` 44 passed/1 skipped — but that is a measurement, not a proof); the Escape-tooth re-anchoring boy-scout is deferred (~70 lines / 4 hunks, over cap, and atomic). ADR next-free = 0164.

**M12.5c** (zone-sync robustness — ADR-0074) complete: four bugs fixed via state-based zone
reconciliation. **Bug 1:** edge-triggered `onOwnWarp` races with `reconcile` (stale `rawMap.zone_id`
vs. own row). **Fix:** state-based check in reconcile listener: `if (own.row.zoneId !== rawMap.zone_id)`
→ `switchZone()`. **Bug 2:** `switchZone()` lacked atomicity. **Fix:** idempotent `switchZone(newZoneId)`
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
tracking) + `player_conversation` (transient session anchor; public at M12b, PRIVATE since
M13.5c — clients read it only through the owner-scoped `my_conversation` view, ADR-0087) + `heal_location_row`
(public, NPC healing POI; 12r-d adds the tail-appended `cost_currency` u64 column — bigint
end-to-end on the client, rendered by `healModel.ts::formatHealCostLine`, closing ADR-0170
residual 1's silent-debit trap) + `heal_cooldown` (PRIVATE, per-location/player cooldown gate per
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
  aliasing a lower seq); paired with `seedSeq` for the reconnect re-seed. *Residual closed
  by M10.5d:* `store.ts:flushBatch` now has per-listener try/catch (catches+logs, continues),
  so a throwing listener cannot starve siblings.
- **Spec path `frontend/` == delivered `client/`** — **RESOLVED.** The delivered
  path is `client/`; the stale spec prose was cosmetic. Deferral closed.
- **M2 spec items not yet gated** (a `client_connected` reducer, a schema-snapshot /
  migration-smoke eval, soak/load tests) — soak/load is the **M20** capstone; the rest
  carry forward with M2's 9 shipped proof-of-teeth evals as the live gate set.

---

## M14 — Deeper Battle Systems (status, abilities, weather)

**M14a** (status-effect rules — ADR-0092, PR #134) complete: `StatusEffect` enum
(`Burn | Poison | Paralysis | Sleep { turns_remaining: u8 } | Freeze`);
`BattleStatusStore { side_a, side_b }` pure game-core (no `SpacetimeType` — persistence
m14b); `StatusVariance` (6 rolls, separate from `TurnVariance` so `resolve_turn` signature
is unchanged); `TurnChoice::Pass` variant for action-blocked sides; `resolve_full_turn`
wrapper: pre-turn block → Pass substitution → `resolve_turn` (unchanged) → post-turn DoT
(Burn/Poison) + faint cascade → status tick; new `BattleEvent` variants
(`StatusApplied / StatusDamage / ActionBlocked / StatusCured`). Proof-of-teeth: (1)
M7-regression — `resolve_full_turn` with empty store + plain attack produces byte-identical
events to `resolve_turn`; (2) exhaustive `match` at every status site flags a new variant
at compile time. 22 EARS + 4 red-team gating tests.

**M14b** (server status persistence — ADR-0093, PR #135) complete: `StatusEffect` moved
to `types.rs` (circular-import avoidance; `status.rs` re-exports); `BattleMonster.status:
Option<StatusEffect>` added as last field with `#[serde(default)]` (ADR-0006 additive —
old rows deserialize to `None`); `StatusEffect` gains `#[cfg_attr(feature="spacetimedb",
derive(spacetimedb::SpacetimeType))]`; `BattleEvent::StatusCured` gains `slot: u32` (fixes
RT-S14-01 — bench-slot cures no longer ambiguous); `StatusVariance::from_ctx_random(seed)`
(splitmix64, same pattern as `TurnVariance`); `submit_attack` now calls `resolve_full_turn`
(constructs `BattleStatusStore` from `BattleMonster.status` fields → resolves → writes
store back, gated on `Ongoing`); bindings regenerated (15 `SpacetimeType`s); battle-schema-
snapshot baseline updated 14→15 types; `docs/knowledge/` regenerated.

**M14c** (passive per-species ability system — ADR-0094, PR #137) complete: `StatusKind`
payload-free discriminant (mirrors `StatusEffect` without payloads — RON reads
`StatusImmunity(immune_to: Sleep)` cleanly); `AbilityEffect` exhaustive enum
(`StatusImmunity { immune_to: StatusKind }` / `EntryHeal { denom: u16 }`);
`AbilityStore { side_a, side_b }` (parallel to `BattleStatusStore`); `apply_entry_ability`
(returns `()`, no event API yet); `apply_ability_modifiers`; `Species.ability: Option<u32>`
additive field (`#[serde(default)]`); `validate_abilities` additive sibling (preserves
`validate_content` 4-param signature); `content/abilities/000-core.ron` (3 starters: Flame
Body, Vital Spirit, Regeneration); `CONTENT_VERSION 7→8`. OCP gate: a new `AbilityEffect`
variant is a compile error at every unhandled site. 20 EARS + 4 red-team gating tests.

**M14d** (weather / field-state — ADR-0095, PR #139) complete: `WeatherKind` exhaustive
enum (`Rain | Sun | Sandstorm | Hail`); `WeatherEffect { kind, turns_remaining: u8 }`;
`FieldState.weather: Option<WeatherEffect>` on `BattleState`; per-turn effectiveness
modifier (Rain/Sun boost Water/Fire; Sandstorm/Hail apply chip damage per turn 3.5, exempt
Earth/Water respectively); `sets_weather: Option<WeatherKind>` on `SkillDef` (content cache
path, no `SkillRow` schema change); `tick_weather` in `resolve_full_turn` Phase 5;
`validate_content` exhaustive `match` on `WeatherKind` (compile-time OCP gate — B-1 fix
from mandatory review pass); `CONTENT_VERSION 8→9`. Proof-of-teeth: weather-set move does
not boost its own hit; WeatherSet event fires after BattleEnd on same-turn KO (ADR-0095 D4).

**M14e** (status-curing items + client event display — ADR-0096, PR #141) complete:
`applies_status: Option<StatusKind>` additive on `SkillDef`; `cure_status: Option<StatusKind>`
additive on `ItemDef`; Phase 1.5 store→`BattleMonster` sync in `resolve_full_turn` (ensures
"no stacking" guard sees authoritative status); Phase 4.5 `BattleStatusStore → BattleMonster`
write-back (newly-applied status deferred one turn per convention — ADR-0096 D1); `use_battle_item`
6-guard reducer (owner/Ongoing/load-def/cure_status/match-active-status/consume_one); client
status badge on active monster's battle card; skill 11 "Toxic Sting" (Power 20, Poison);
item 3 "Antidote" (cures Poison); `CONTENT_VERSION 9→10`. Residuals: R1 `swap_active`
status-drop, R2 bench-cure gap, R3 `attempt_recruit` gap — deferred to Phase C.

**Phase B (M11–M14) complete.** The authored-world layer — multi-zone movement + warps,
NPC/dialogue/quest/heal, economy + shops, and deeper battle depth (status/abilities/weather)
— is fully built and merged. `resolve_turn` (ADR-0017) remains symmetric and signature-
stable throughout M14; M16 PvP inherits the full depth for free.

## M14.5 — Eighth-Review Residuals

**M14.5a** (swap/recruit post-turn pipeline — ADR-0098, PR #147) complete: `run_post_turn_phases`
helper centralises post-turn logic (DoT / faint cascade / status tick / XP) for `resolve_player_swap`
and `resolve_recruit_failure`; `load_skills()` pure helper replaces ad-hoc `skill_defs_from_rows`
calls; ADR-0092 D3 amended (always-swappable regardless of status — status persists on bench);
7 gating + 5 red-team tests; `CONTENT_VERSION` unchanged.

**M14.5b** (StatusApplied carries slot + Phase 4.5 drop-if-fainted — ADR-0099, PR #149) complete:
`StatusApplied { slot: u32, status: StatusEffect }` (slot added, breaking `BattleEvent` variant —
all callers updated); Phase 4.5 faint-guard clears pending `BattleStatusStore` entries for fainted
slots so Burn/Poison applied in the same hit as a KO cannot fire on a dead monster next turn;
`debug_assert` on slot bounds; ADR next-free = 0100.

**M14.5c** (ability-system end-to-end wiring — ADR-0100, PR #151) complete: `species_row.ability:
Option<u32>` additive column (ADR-0006); Flameling → ability_id 1 (Flame Body: StatusImmunity
Burn), Sproutlet → ability_id 3 (Regeneration: EntryHeal denom=4), Tidalin → no ability;
`build_ability_store` pure helper in `marshal.rs`; `AbilityStore` threaded as last parameter
through `resolve_full_turn`, `resolve_player_swap`, `resolve_recruit_failure`; five reducer paths
(`start_battle`, `begin_encounter`, `submit_attack`, `swap_active`, `attempt_recruit`) build and
pass `AbilityStore`; `apply_entry_ability` called at battle start for both sides' active slot;
`CONTENT_VERSION 10→11`; eval baselines updated; 7 EARS gating tests; auto-switch-on-KO gap
(D6) documented for Phase C. ADR next-free = 0101.

**M14.5d-1a** (item-row cure-status column — ADR-0105, PR #162) complete: `item_row.cure_status:
Option<StatusKind>` additive column (ADR-0006); status cured when used in battle (client classification);
seeded by `sync_content_inner` from `ItemDef.cure_status`; bindings regenerated (`cureStatus` getter);
`CONTENT_VERSION 11→12`; EA-1 through EA-6 source-guard tests; baselines updated.

**Next: Phase C (M15 — trade; M16 — PvP battles; M17 — guilds; M18 — raids; M19 — seasonal/live-ops; M20 —
soak/load; M21–M25 — polish + launch gate, ADR-0021/0022/0025).**

## M15 — Trading (Phase C)

**M15a** (trading spine — ADR-0106, PR #165 merged) complete: `trade_offer` table
(`public`; btree indexes on `initiator` + `counterparty`; display-only `MonsterCard` snapshots per
ADR-0015 — no IV/EV/nature); `validate_proposal` + `build_swap_plan` pure rules in
`game-core/src/trading/`; `reject_if_monster_in_trade` + `escrowed_item_qty` +
`escrowed_currency_amount` guards in `server-module/src/guards.rs`; four reducers
(`propose_trade` / `respond_trade` / `confirm_trade` / `cancel_trade`) + `cancel_trades_on_disconnect`
called from `on_disconnect`; escrow guards wired into all 11 asset-mutating reducers (evolve, fuse,
set_nickname, set_party_slot, care, train, heal_party, buy, sell, start_battle/begin_encounter,
use_battle_item/attempt_recruit); atomic swap re-reads live rows at confirm time (no stale-data
exploit); 20 proof-of-teeth unit tests; no CONTENT_VERSION bump (trade_offer is runtime-created,
not seeded). ADR next-free = 0107.

**M15b** (trade client UI — ADR-0107, PR #168) complete: `buildTradeViewModel` pure model (4-state action table, mySide/theirSide orientation, 44 Vitest tests including fast-check bigint); `TradeView` DOM shell (KeyU toggle, async `#pending` double-spend lock via `TradeCallbacks → Promise<void>` pattern); store types `StoreMonsterCard` / `StoreTradeItem` / `StoreTradeOffer` + row converters; `trade_offer` table subscription and batch listener in `connection.ts`; main.ts integration with KeyU handler, 4 reducer callbacks, reconnect reset, frame-loop guard, mutual exclusivity check (!tradeView?.visible) on KeyB/KeyI/KeyE opens; `#trade-overlay` DOM block. All gates pass (1142 Rust + 897 JS tests, all evals). ADR next-free = 0108.

**M15c** (trade evals tail — ADR-0108, PR #170) complete: three JS eval files — `trade-reducer-security.eval.mjs` (12 criteria: TR-19 no-genes, TR-18 disconnect, TR-13–17 role+status+reread+delete); `trade-escrow-guards.eval.mjs` (11 guard sites: reject_if_monster_in_trade × 7 reducers, escrowed_item_qty × 2, escrowed_currency_amount × 2; fuse ≥2 + start_battle ≥2 mutation kill); `trade-conservation.eval.mjs` (6 criteria: dual-write, item consume+grant, currency spend+grant, row deletion). All 48 evals pass. M15 Trading CLOSED.

## M16 — PvP Battles (Phase C)

**M16a** (PvP spine — ADR-0109, PR #172) complete: `battle_challenge` table (public; btree indexes on `challenger` + `target`); `battle_action` table (PRIVATE — must-never-leak, ADR-0015; btree on `battle_id`); `pvp_deadline_schedule` table (scheduler-colocated in `pvp.rs`, ADR-0056 exception); `ChallengeStatus` + `PvpAction` SpacetimeTypes; full PvP domain module `server-module/src/pvp.rs` (~570 LOC): `challenge_pvp`, `accept_challenge`, `decline_challenge`, `cancel_challenge`, `submit_pvp_action` (inline resolve), `pvp_deadline_reaper` (scheduler-only guard), `forfeit_on_disconnect`, `cancel_challenges_on_disconnect`, internal `start_pvp_battle` (bypasses ADR-0048 provenance guard); `require_pvp_participant` guard in `guards.rs`; on_disconnect wired for both `forfeit_on_disconnect` + `cancel_challenges_on_disconnect`; 10 source-guard tests (EA-PVP-01..10) + 6 red-team gating tests (RT-M16-01..08); bindings regenerated. Key invariants: Forfeit → existing `SideAWins`/`SideBWins` (no new variants, BSATN stability); both-submit resolution inline in same transaction; challenger-first tie-break at deadline (D5); side-B HP write-back in terminal paths; `write_back_battle_results` called BEFORE battle row update (GC ordering, RT-M16-08). ADR next-free = 0110.

**M16b** (PvP client UI — ADR-0110, PR #176) complete: `buildPvpChallengeViewModel` pure model (incoming/outgoing/challengeable players; Pending-only outgoing filter); `PvpView` DOM shell (KeyP toggle, `anyOverlayVisible` auto-show guard, `forceVisible` path); `StoreBattleChallenge` in store + `battleChallengeRowToStore` converter; `battle_challenge` subscription in `connection.ts` (explicit "MUST NEVER subscribe to `battle_action`" comment); `isPvP` detection (`!isWild && playerIdentity !== opponentIdentity`); `pvpPendingTurnNumber` set INSIDE `sendGuarded` lambda (frozen-link safety); `canFlee: false` in PvP; `onPvpAttack`/`onPvpSwap` callbacks; KeyP 9-way mutual-exclusion guard; `pvpView.ts` in dom-shell-coverage-exclusion eval; `client/e2e/pvp.spec.ts` (7 DOM/key/mutual-exclusivity tests). 938/938 unit tests, 58 evals. ADR next-free = 0111.

**M16c** (PvP evals tail — ADR-0111, PR #178) complete: three JS eval files — `pvp-action-privacy.eval.mjs` (4 cross-language criteria: schema PRIVATE, client no SELECT, client no listener, client has MUST NEVER warning); `pvp-handshake-guards.eval.mjs` (11 criteria: self-challenge guard, target-battle guard, accept/decline role+status+GC, cancel initiator+status+GC); `pvp-deadline-disconnect.eval.mjs` (5 liveness criteria: scheduler guard, stale-turn check, both-sides disconnect, cancel-outgoing-only). All 61 evals pass. M16 PvP CLOSED. ADR next-free = 0112.

## M16.5 — Ninth-review residuals

**M16.5a** (battle↔trade interlock both directions — ADR-0112, PR #180) complete: `propose_trade` and `confirm_trade` now call `reject_if_in_battle` for every monster on both sides (initiator and counterparty). Battle guard chains both btree indexes (`player_identity` + `opponent_identity`) to cover PvP side-B monsters. `m7b_2` spec-gap test revived with real assertions; `spec-gap-revival` eval extended to reject vacuous revivals (block-comment body with no `assert`). ADR next-free = 0113.

**M16.5b** (receiver-cap headroom check — ADR-0113, PR #181) complete: `confirm_trade` calls new pure function `check_headroom` (in `game-core/src/trading/rules.rs`) before any mutation. Trades where a receiver's item stack would exceed `MAX_ITEM_STACK = 9999` or their currency balance would exceed `MAX_BALANCE = 999_999_999` are rejected with `Err` (no partial swap, no silent clamping). `MAX_ITEM_STACK` moved from `server-module/src/inventory.rs` to game-core (SSOT). Two new `TradeError` variants: `ItemStackCapExceeded { item_id }` and `CurrencyCapExceeded`. Proof-of-teeth: 9 new unit tests in `rules.rs`, 1 source-scan test in `trading_tests.rs` (EA-CONSERVATION-HEADROOM-01), `trade-conservation` eval extended to 7th criterion. All 62 evals pass, 1190 Rust tests, 938/938 client tests. ADR next-free = 0114.

**M16.5c** (trade client completion — ADR-0114, PR #185) complete: three ninth-review residuals closed. (1) KeyQ/KeyH/KeyG overlay guards were already fixed in M16b review pass; new e2e test `trade open: G/Q/H keys do not open overlays` proves proof-of-teeth for the reverse direction (open trade via KeyU, press G/Q/H, assert only `#trade-overlay` is visible). (2) `StoreTradeOffer.status` narrowed from `string` to `'Pending' | 'ConfirmedByCounterparty'` literal union (`TradeStatus` type); `deriveActionsAndLabel` rewritten as exhaustive switch — a future server variant is a TypeScript TS2366 compile error. (3) `TradeView` render hygiene: `#lastRenderKey` tracks offer-state changes and clears `#feedbackEl` on transition (stale "Trade accepted!" across statuses/sessions eliminated); `#renderActions()` sets `btn.disabled = this.#pending` at button creation and `finally()` re-enables live buttons via `querySelectorAll` (not orphaned closure reference — closes mid-flight render UI deadlock). 4 new `tradeView.test.ts` unit tests (TV-1..TV-4); `TM-12a` added; 943 client tests. ADR next-free = 0115.

**M16.5d** (trade runtime coverage — ADR-0115, PR #187) complete: write-side test-hook dispatch + full round-trip e2e + escrow-guard tail. `window.__mrTrade` test hook (mirrors `window.__game` pattern) exposes `proposeTrade` / `respondTrade` / `confirmTrade` / `cancelTrade` reducers + `allTradeOffers()` / `allPlayers()` queries; all BigInt fields serialized as strings for Playwright boundary. Two-context Playwright e2e `client/e2e/trade-full.spec.ts` (m16.5d-1: hook exists; m16.5d-2/3/4: full propose→respond→confirm flow with monster conservation assertion). `trade-escrow-guards.eval.mjs` extended: TR-13 guard site added for `attempt_recruit`/`escrowed_item_qty` (12 guard sites total); `bodyHasGuard` hardened with RT-SEC-02b string-literal/comment stripping to prevent false positives from log messages containing guard names. All 62 evals pass. M16.5 Ninth-review residuals CLOSED. ADR next-free = 0116.

**M16.5e** (eval-infra hardening — ADR-0116) complete, evals-only (no production Rust/TS): three gate-infrastructure gaps closed. (1) `spacetime-type-snapshot` gains `checkAppendOnly` — a git-history *directional* check (prev committed baseline via `merge-base HEAD origin/master`, `HEAD~1→HEAD` transition when self-identical) so a bad re-baseline (mid-insert/reorder/removal/kind-flip — a positional BSATN wire break) is caught even when source and baseline are edited together; skip is fail-open-LOUD only when git/prev-baseline is unresolvable (D2). (2) `trade-escrow-guards` extraction hardened: `orderAndFilterRustEntries` (sorted, `*_tests.rs` excluded) + whole-source comment-then-string strip in `extractFunctionBody`, so a string literal containing `pub fn sell(` (real occurrence in `economy_tests.rs`) can never hijack the anchor; string-strip escape branch matches backslash-newline (line-continuation string in content.rs otherwise inverts quote pairing). (3) `bsatn-compat-smoke` criterion 7: `checkAdditiveColumnCoupling` — every `Option<…>` column on a content-synced table must have its field-assignment in a `StructName {` row literal in content.rs (upsert AND clear-and-reinsert shapes; in-place-mutation exemption for update-only no-literal tables — the `monster`/`monster_pub` recompute shape); vacuity guard + 4 anchors (`ability`, `train_stat`, `cure_status`, `cost_item_id`). Teeth A-1..A-12, B-0..B-3, C-1..C-6+C-W written RED-first by the tester; 61/61 evals green ×5 runs. ADR next-free = 0117.

**M16.5f** (trade SSOT/polish — ADR-0117) complete: four ninth-review residuals closed. (1) respond/confirm role+status checks moved to pure `authorize_respond`/`authorize_confirm` in `game-core/src/trading/rules.rs` (role-first ordering — no status leak to non-parties); shell delegates with `.map_err(log_reject)?` (validate_proposal pattern); two never-constructible `TradeError` variants deleted (`MonsterNotOwned`, `InsufficientCurrency { available }` — the latter a privacy trap: `available` would leak a counterparty's private balance). (2) propose_trade escrow subtraction made symmetric (both parties, items + currency, both btree indexes chained; provably 0 under ADR-0106 D4, kept for the auction-house extension). (3) trade_offer privacy doc corrected — `player_wallet` is NOT a world-readable precedent (it is private must-never-leak); offered-currency lower-bound leak + propose-error binary-probe recorded as accepted bounded exposure (ADR-0106 M-2 amended). (4) TTL reaper: `trade_offer_reaper_schedule` scheduled table colocated in trading.rs (per-offer one-shot `ScheduleAt::Time` at `created_at_ms + TRADE_OFFER_TTL_MS` (1 h, game-core const), scheduler-only guard, `is_offer_stale` re-check, runtime auto-deletes fired one-shot rows per SpacetimeDB schedule-tables §Row Lifecycle) + `disarm_trade_reaper` at all four offer-deletion sites (extends the pvp precedent — 1 h rows would otherwise accumulate under a propose/cancel loop). Gates: trade-reducer-security eval evolved to 16 criteria (delegation-shape checks with statement-terminator `?`-scan + argument-span field check + string-literal strip); 4 new ea_ source-scan tests; 13 new rules unit tests; verifier ran 6 mutation spot-checks — all bite. 30 tables. ADR next-free = 0118.

**nightly-mut-triage** (ADR-0118) complete: six-night nightly mutation red triaged — game-core `mutation` job was 5 missed `check_headroom` accept-boundary/guard mutants, killed with counterparty boundary + skip-guard contract tests (zero-tolerance intact, no exclusions); `mutation-server` was a stale ratchet baseline (crate doubled from M15/M16/M16.5; killable in-crate set empty), cap re-baselined 180 → 309 (exact measurement @ 908c99b) with the wiring-eval ceiling 200 → 340 and a positive-control tooth. Re-baseline procedure recorded in ADR-0118.

**M17a** (ranked-ladder spine — ADR-0119) complete: persistent ranked Elo on a presence-vs-progression boundary. (1) `profile` table (public world-readable leaderboard record: PK identity, name, rating i32, wins/losses u32) — never deleted (unlike the ephemeral `player` row), runtime table so no CONTENT_VERSION bump (ADR-0106 D7 precedent); no rating index (m17b sorts client-side). (2) Pure integer Elo in `game-core/src/ranking.rs` (`apply_elo`: i64-internal linear approximation, `div_euclid`, Δ ∈ [1, K−1], equal → K/2, upset swings more; `compute_rating_update` is the SSOT for the zero-sum ± application with saturating i32 belt; `INITIAL_RATING = 1000`; K/DIVISOR private). (3) `settle_pvp_battle` in `pvp.rs` unifies the two decisive-commit sites into ONE funnel (write-back while Ongoing [RT-M16-08] → terminal update [RT-M16-05] → `ranking::apply_pvp_rating` → side-B HP → action sweep) — the sole `apply_pvp_rating` call site (RL-10 call-site-count tooth); rating gated by `guards::is_ranked_pvp` (distinct players, non-wild) so practice self-battles and wild battles never rate even through the disconnect-forfeit path. (4) Build-time discovery closed: the four PvE reducers (`submit_attack`/`swap_active`/`flee`/`use_battle_item`) gained `if is_ranked_pvp(&battle)` rejects (AI-plays-side-B ranked farming + flee rating-dodge holes), pinned by battle-reducer-security eval criteria with bite-verified fixtures A–D (`attempt_recruit` structurally safe via the wild-only `battle_wild` row, pinned). Gates: mutate-server re-baselined 309→308 (exact cap, ADR-0118 §4); targeted mutants on the new game-core module 20/20 caught; 31 tables. Residual parked for follow-up: side-B `opponent_identity` ongoing-battle guard gap in `start_battle`/`begin_encounter`/`movement_tick`/`heal_party` (pre-existing M16 — ADR-0119 residuals). ADR next-free = 0120.

**M17b** (ranked leaderboard client UI — ADR-0120) complete, client-only: the world-readable `profile` table surfaced as a KeyL leaderboard overlay. (1) `StoreProfile` mirrored into the AuthoritativeStore (onInsert/onUpdate only — deliberately NO remove path: RL-2/ADR-0119 D1 guarantee profile rows are never deleted, so the missing handler is the tripwire if that ever changes; `reset()` clears for reconnect re-hydration) + `'SELECT * FROM profile'` subscription. (2) `leaderboardModel.ts` pure TOTAL view-model: strict-total-order comparator (rating desc → RAW name asc code-unit — never localeCompare — → identity hex asc; `'#<hex8>'` empty-name fallback is display-only), no row cap (YAGNI). (3) `leaderboardView.ts` zero-callback DOM shell (RL-15: no client write path, pinned by source-scan teeth incl. a `set_profile_name` needle + the `'SELECT * FROM profile'` subscription tooth) — deliberately NOT coverage-excluded (the dom-shell exclusion list is exact-set-guarded by an eval owned by the concurrent m17c slice): 100% happy-dom-covered instead (ADR-0120 D3). (4) main.ts: all 22 inventory sites (mutual exclusion vs ten overlays both directions, incl. `refreshBattle` 'show'-branch hide — challenger-side battle push while board open — and the pvp listener's `anyOverlayVisible`; movement suppression + both held-reissue guards preserve ADR-0013 resume-on-close). Parked to a follow-up slice (ADR-0120): `set_profile_name` flow (server reducer does not exist; needs ADR-0119 D6 RL-7 tooth amendment + `validate_name`) and RL-14 post-battle rating delta (battleModel/battleView). ADR next-free = 0121.
**M17c** (ranked evals tail — ADR-0121) complete, test-only (no production Rust/TS): RL-16/17/18. (1) `ranking-security.eval.mjs` re-pins the m17a security contract at the eval layer as toolchain-boundary defense-in-depth vs `pvp_tests.rs`: module-write-only (no reducer in ranking.rs; `ctx.db.profile()` nowhere else — intentionally coupled to ADR-0119 D6), once-only rating call site (two-needle form: path-qualified `ranking::apply_pvp_rating(` == 1 in pvp.rs, bare identifier == 0 per other domain file), never-deleted (chained-delete + split-binding needles across every non-test file except ranking.rs, `on_disconnect` body clean). (2) `ranking-pve-exclusion.eval.mjs` re-verifies the four battle.rs PvP-reject guards by importing the frozen battle-reducer-security checkers (guarded import → RED on missing export) and adds `hasPvpRejectWithNonEmptyBody` — brace-matches the guard block and requires `return Err` inside it, killing the documented `if is_ranked_pvp(&battle) {}` no-op residual (positional-evasion, nested-brace, next-line-brace fixtures; nested-dead-code documented as mutation-testing-owned). (3) `client/e2e/ranked-forfeit.spec.ts` — two-context ranked flow (challenge → accept via M16b DOM testids → forfeit by closing B's browser, the only user-reachable forfeit path) asserting zero-sum server truth via `spacetime sql` from the spec (winner A 1000+Δ wins=1, loser B 1000−Δ losses=1, sum == 2000, Δ ∈ [1,31]; identity-normalized, hard-fail on parse miss) — no client hook, fully decoupled from the concurrent m17b leaderboard slice. Red-team execution pass: 9/9 real-source mutations bite, e2e flake-free ×5, full e2e suite green. 63 evals. ADR 0121 (0120 reserved by the concurrent m17b slice).

## M17.5 — Tenth-review residuals

**M17.5a** (both-role ongoing-battle guard SSOT — ADR-0122) complete: side-B PvP damage-laundering exploit (concurrent wild/practice battle + HP snapshot restore post-PvP) closed. Hoisted both-role guard from `pvp.rs` into `guards.rs` as a unit-testable two-function split: pure-core `is_in_ongoing_battle_either_role` (player-arm any-Ongoing, opponent-arm Ongoing && opponent_identity != WILD_IDENTITY) + wrapper `is_in_ongoing_battle(ctx, identity)` (arg-order pinned: player iterator first). All four PvE sites (`start_battle`/`begin_encounter`/`start_wild_battle` dev-only/`heal_party`) + `evolve`/`fuse` chain both btree indexes per M16.5a precedent; pvp.rs private copy deleted. Gates: 7 unit tests (empty-player opponent scenarios + laundering-two-ongoing-rows trace), 4 side-B seam tests in evolution_tests.rs (chain coverage), eval criteria C1–C4 in battle-reducer-security.eval.mjs (per-site call-form allowlist + identity-token + chain-count + single-definition wrapper arg-order pin + classification guard exactly-3-sites assertion); red-team 5 live mutation spot-checks all bite. M17 PvP + Ranked closed. ADR next-free = 0123.

**M17.5b** (trade swap debits-before-credits ordering — ADR-0123, amends ADR-0113) complete: bilateral same-item trades near the stack cap silently destroyed items (counterparty credit landed before its debit; `grant_item` monotone-clamps at `MAX_ITEM_STACK`), and currency headroom used raw balances (false-reject for bilateral currency swaps, which also masked the equivalent currency destruction — the two fixes are inseparable). `SwapPlan::ordered_steps() -> Vec<ApplyStep>` is the SSOT ordering contract (game-core public API, same standing as `check_headroom`): ALL ItemDebit/CurrencyDebit strictly before ANY ItemCredit/CurrencyCredit; per-transfer exact parity (one debit + one credit, same qty/amount); within each phase item steps then currency steps in transfer order. Credit variants carry `to_initiator` (= `!from_initiator`, inverted once at emission — no inversion at any dispatch site). `confirm_trade` is a single exhaustive 4-arm match over `ApplyStep` dispatching to `consume_one`/`spend_currency`/`grant_item`/`grant_currency`; legacy per-transfer loops deleted. Currency headroom netted shell-side INLINE in the `check_headroom` args: `wallet_balance(x).saturating_sub(offer.x_currency)`, symmetric with ADR-0113 item netting; cap-headroom-only (a broke sender still rejects at `spend_currency` with whole-transaction rollback — platform atomicity). Gates: executed game-core tests walking the real `ordered_steps()` over a per-party clamp-mirror model with tripwire-before-clamp asserts (@9999/@9998 conservation, over-cap reject, netting-sensitivity flip, broke-sender boundary, constructive proptest); EA-CONSERVATION-ORDER-01 source-guard (loop-consumption needle + no-legacy-loops + netting inside the check_headroom arg span, with discard/split-loop/dead-var teeth fixtures) + EA-CONSERVATION-ORDER-INLINE-01 (pins the inline-netting gate constraint); trade-conservation eval APPLY_ORDER criterion (8th, source-scan mirror); targeted cargo-mutants on ordered_steps 0 missed (both to_initiator inversion-deletions + empty-vec caught). ADR next-free = 0124.

**M17.5c** (shop receiver-cap headroom — ADR-0124, amends ADR-0113, ADR-0082) complete: `buy` and `sell` reducers lacked headroom rejects, silently destroying value at receiver caps (`buy` spent then `grant_item` monotone-clamped the grant away at `MAX_ITEM_STACK`; `sell` consumed items then `grant_currency` saturated at `MAX_BALANCE`). Pure single-receiver primitives `check_item_headroom(current_count, incoming_qty, item_id)` and `check_currency_headroom(balance, incoming)` in game-core extend reject-not-destroy (ADR-0113) to the shop paths; the 8-arg `check_headroom` delegates unconditionally to both, unifying the cap comparison (SSOT per axis; the `incoming > 0` skip-gate lives inside the currency primitive). Shop call-sites read RAW stacks/balances (not escrow-netted — escrow is a spend-lock, not a receive-lock; the trade path nets because it is debit-then-credit) and check-before-spend/consume. Gates: 11 game-core boundary tests (item ×5 incl. exact-fill accept + u32-saturation reject; currency ×6 incl. anti-normalization pin `(MAX_BALANCE+1, 0) → Ok`); delegation tooth (include_str! self-scan of `check_headroom`'s body); economy_tests.rs source-guards (comment+string-stripped ordering scans with `?`-propagation, provenance pins `inventory()`/`unwrap_or(0)`/`wallet_balance`, argument-identity pins `check_item_headroom(current_count,`/`check_currency_headroom(balance,`, cfg-forbidden); shop-reducer-security eval extended 5→7 criteria (BUY_HEADROOM/SELL_HEADROOM, 7 bad + 1 good fixture teeth each incl. hardcoded-0/planted-string/cfg bypasses). ADR next-free = 0125.

**M17.5d** (passive profile.name mirror on rating application — ADR-0125) complete: leaderboard profiles now refresh `name` passively from the live `player` row (when present) on every rated game, healing stale first-ever-name problem (M17.5 tenth-review finding). `get_or_init_profile`'s `Some` arm composes `refresh_profile_name(existing, live_player_name(ctx, identity))` — two private helpers in `ranking.rs`. `refresh_profile_name(profile, live_name)` is pure, in-memory-only (no write in `get_or_init_profile`, preserving its find-or-insert shape), replaces `name` when `live_name` is `Some`, keeps existing on `None` (player row absent after e.g. disconnect-forfeit). Persistence rides `apply_pvp_rating`'s existing `..winner`/`..loser` spreads, so both players refresh on every rated write; renames surface on the next game (max staleness one game, accepted cost vs. the parked D-17.5-C `set_profile_name` reducer — module-write-only by ADR-0119 D6). `live_player_name` chained-`.map` form is load-bearing: None-safe for disconnect race (settle-after-both-rows-gone), avoids split-binding shape. Gates: ranking_tests.rs d1_*/d2_* unit-tests (pure core), source-scans pinning one-helper usage + two call-sites + no split-bindings in ranking.rs; all eight pre-existing RL-5/RL-7/RT-M17-01 byte-pins survive. ADR next-free = 0126.

**M17.5e** (battle_challenge TTL reaper — ADR-0126) complete: Pending challenges now expire after 2 min via a reaper cloned from the trade reaper (ADR-0117) — private one-shot schedule table + 4-site disarm in pvp.rs, staleness SSOT (`CHALLENGE_TTL_MS` + `is_challenge_stale`) in game-core combat::pvp; decline-cooldown deferred to M19.

**M17.5f** (PvP runtime coverage + DEV-gated test hooks + SDK-enum exhaustiveness — ADR-0127, amends ADR-0115 D1) complete: (1) `window.__game`, `window.__mrTrade`, `window.__mrPvp` now DEV-gated inside `if (import.meta.env.DEV)` block; production `vite build` drops them via minifier dead-branch elimination (attack-surface reduction, zero e2e cost). (2) PvP two-context e2e (`pvp-full.spec.ts`: turn-exchange, rated-forfeit zero-sum; `trade-interlock.spec.ts`: paired positive-control, battle guard proof). (3) `HANDLED_ENUM_VARIANTS` registry (rowConvert.ts:56–65) + `narrowTag` fail-soft boundary (ADR-0127 D2) — SDK-enum-exhaustiveness eval statically diffs types.ts variants against registry, coupling ratchet forces conscious store-union decision on server-variant append, narrowTag logs unknown tags via console.warn (never throws). Gates: e2e 8→10 specs (~+50s), eval C1–C4 teeth + narrowTag unit tests, store-union tsc errors force registry updates, registry entries without narrowTag sites accept eval-only enforcement. M17 PvP+Ranked+Tenth-review CLOSED.

## M-playtest-a — Local playtest build hygiene (pre-gate)

**pt-a1** (client build hygiene — ADR-0128) complete: makes the client honest for a local solo playtest. (1) Prod-safe connection config — pure `resolveConnectionConfig(env, isDev)` in `client/src/net/connectionConfig.ts` replaces the inline `main.ts` `URI`/`DB` consts; a production build (`import.meta.env.DEV === false`) FAILS LOUD (throws) when `VITE_STDB_DB` is unset/empty or equals the dev-default `monster-realm` (reject-not-clamp — a wrong prod DB would corrupt H1/H2/H3 playtest feedback), while dev preserves the `ws://127.0.0.1:3000`/`monster-realm` fallbacks. Guards the DB name only, NOT the URI (localhost is the legitimate local topology). (2) Build version stamp — `client/vite.config.ts` `define`-injects a git short-SHA + build time (env-overridable, `'unknown'` fallback); pure `client/src/net/buildInfo.ts` exposes `BUILD_INFO {sha,builtAt,mode}` + `formatBuildStamp`, rendered into `#build-stamp` and exposed UNGATED at `window.__mrBuild` (present in production — the M-playtest-b F9 bug-bundle embeds it to pin which build a finding came from; contrast the DEV-gated `__game`/`__mrTrade`/`__mrPvp` hooks). (3) Reconciles ADR-0127: the DEV hooks are empirically absent from the default minified `vite build` (0 `window.__*` bindings even with `--minify false` — Rollup DCE; refines the `--minify false` caveat). Honest serve path = `vite build` + `vite preview` (default port 4173). Gates: connectionConfig fail-loud proof-of-teeth (unset/empty/dev-default/whitespace reject; playtest-DB + prefix-DB accept; dev-fallback; fast-check fail-loud-iff property) + buildInfo formatter teeth (sha+mode present, `'unknown'` fallback). Parked to pt-a2: `just playtest-up/down`, published-module `dev_reducers`-absent proof, automated build-output DEV-hooks-absent guard, `docs/playtest-ops.md`; hosted deploy re-booked M-playtest-a2.

**pt-c1b** (client profile-rename UI — ADR-0133) complete: KeyN overlay for player profile name changes in M17.5d's passive mirror flow. (1) `renameModel.ts` pure view-model: string trim + non-empty (server `set_profile_name` validates `validate_name` SSOT); no DOM, node-testable. (2) `renameView.ts` text-input overlay (FIRST input overlay after M15b/M16b read-only shells) with three input-hygiene guards: `stopPropagation` on BOTH input and submit-button keydown (bubble-phase window listener else opening 'n' injects), `held.clear()` on open (`main.ts:847` unconditional keyup handler → held-key corruption without it), deferred `setTimeout(focus, 0)` + `e.preventDefault()` in KeyN branch (else the open keystroke lands); `#pending` async lock with `.finally().catch()` (vitest exits 1 on unhandled rejection); `hide()` resets input/feedback/#pending. (3) `main.ts` KeyN handler (11-sibling mutual-exclusion guard, renders current name from `store.player(identity)?.name`); async `onSubmit`→`setProfileName` with frozen-gate + `reduceErrorMessage` no-leak feedback; all 20 `renameView?.visible` overlay sites gated + `held-key` resume-on-close guard preserved. (4) `rename.spec.ts` server-truth SQL e2e proves round-trip (write path NOT in leaderboard files, RL-15); ranked→leaderboard-DOM reflection parked pt-c1b2. ADR next-free = 0134.

**pt-c2** (trade-propose overlay — ADR-0134) complete: KeyO entry point for `proposeTrade` reducer (resolves D-17.5-D / H3). (1) `tradeProposeModel.ts` pure view-model (RLS-currency-only: `buildProposeLists`, `buildProposeSubmission`, `parseCurrency` digit-scan never Number/parseInt). (2) `tradeProposeView.ts` overlay shell (mirrors pt-c1b three-guard hygiene; `#readDraft` BigInt-guard hardening; fully happy-dom covered). (3) `main.ts` KeyO handler (24-site mutual-exclusion fan-out including KeyN guard, PvP anyOverlayVisible, onReconnect dead-lock fix, Escape chain, held-key resume); frozen-gate + error feedback. (4) `client/e2e/trade-propose.spec.ts` two-context e2e (A proposes, B responds via KeyU; assertion: specific monsterId transfer matches). Item-offer rows, counterparty monster/item selection (RLS-impossible), help overlay, `docs/PLAYTEST.md` parked to pt-c2b. ADR next-free = 0135.

**pt-c2b** (in-client help overlay + tester runbook — ADR-0135) complete, client-only: closes the last onboarding gap before the playtest gate. (1) `helpModel.ts` pure TOTAL VM (`buildHelpViewModel()` → `{controls:{key,action}[], goals}` from a typed SSOT const — NOT RON, YAGNI client chrome; returns a fresh copy each call; display-only, zero callback/submit fields). (2) `helpView.ts` display-only DOM shell (zero-arg construction, `leaderboardView` precedent; no input/submit/`#pending`/reducer) — `render()` paints `textContent`-only `<li>`s via `replaceChildren` (XSS firewall retained by discipline + rebuild-authoritative); fully happy-dom-covered, deliberately NOT in `vite.config.ts` coverage.exclude. (3) `?` (`e.key === '?'`, the SOLE `e.key` branch in an otherwise-`e.code` handler — a help affordance is about the glyph, robust across layouts; `F1` rejected for browser-intercept + discoverability) toggles the overlay; full mutual-exclusion fan-out = **19** `helpView?.visible` sites (reconcile-diverge, 12 sibling open-guards KeyB/I/E/Q/H/G/U/P/L/N/O/T, `?` self-branch, Escape, keydown movement-suppression, rAF held-key re-issue, PvP `anyOverlayVisible`, `refreshBattle` force-hide) with `held.clear()` on open. (4) **The one deliberate asymmetry (ADR-0135):** help is NOT hidden on `onReconnect` — unlike every sibling (rename/tradePropose hide for a never-settling `#pending` lock; leaderboard/pvp hide because their content is store-derived and goes stale), help holds no lock AND its content is a static const, so surviving a reconnect is correct; pinned by a two-endpoint-bounded negative tooth `W-HELP-NO-RECONNECT-HIDE`. (5) `docs/PLAYTEST.md` tester runbook (launch via `just playtest-up` referencing `docs/playtest-ops.md`, controls table mirroring the helpModel SSOT, first-15-minutes, F9 bug-bundle ritual, anonymous per-browser-identity caveat). Gates: helpModel units (non-empty controls+goals, load-bearing-key coverage, purity/mutation-resistance, display-only structural guard) + helpView happy-dom units (XSS-firewall + rebuild-authoritative + fail-loud ctor) + 13 source-scan wiring teeth in `main.wiring.test.ts` (count-floor `helpView?.visible >= 19` pegged to `leaderboardView` parity, per-context anchors for each fan-out region incl. the rAF forward-anchor and the battle-supersession tooth). First-join auto-show (needs a new localStorage seam) + trade item-offer rows parked to pt-c2c. ADR next-free = 0136.

## M-playtest-c.5 — Pre-gate review residuals

**ptc5b** (wild-battle disconnect resolution — ADR-0138) complete, server-only: closes the mid-wild-battle disconnect soft-lock + row leak. `on_disconnect` (lib.rs) now calls `battle::resolve_wild_battle_on_disconnect(ctx, me)` after `pvp::forfeit_on_disconnect` — the latter deliberately excludes `WILD_IDENTITY` and no reaper covers the wild `battle`/`battle_wild` row class, so a mid-wild-battle drop otherwise left an `Ongoing` row that soft-locked the returning player (`is_in_ongoing_battle`'s player arm has no WILD exclusion, so any lingering `Ongoing` row blocks `begin_encounter`/`start_battle`). Resolution = **auto-flee**: SSOT predicate `is_ongoing_wild_battle(b, player)` (the *selecting* dual of `guards::is_in_ongoing_battle_either_role`) collects the caller's Ongoing WILD rows; each is set `Fled`, run through the exact `flee` write-back (`write_back_battle_results` — persists damaged HP clamped to `stat_hp`, no XP, GCs the `battle_wild` sidecar), then the `battle_wild` + `battle` rows are deleted outright (unlike manual `flee`'s mark-`Fled`+`update` — a disconnected client has no terminal frame to observe, and a lingering row is a leak + stale-overlay hazard on reconnect; a belt-and-suspenders `battle_wild` delete survives an early write-back `Err`). Persist-damage (NOT a pre-battle-HP restore) keeps disconnect ≈ flee — no "disconnect-to-heal" exploit; caller-scoped + idempotent (never touches another player's rows). No new table/reducer/schema. Gates: 4 proof-of-teeth (pure-core selection incl. caller-scoping/idempotency, re-entry-flip soft-lock proof + mutation, `resolve_wild_battle_on_disconnect` body source-scan for WILD-scope + write-back + both deletes, `on_disconnect` wiring scan). ADR next-free = 0139.

**ptc5c** (overlay mutual-exclusion symmetry — ADR-0139) complete, client-only: closes the one-directional overlay-guard gap in `main.ts`. The three oldest overlay-open handlers — `KeyB`/`KeyI`/`KeyE` (box/raising/evolution) — omitted `!dialogueView?.visible && !questLogView?.visible && !healView?.visible` from their open-guards while every newer handler (KeyQ/H/G/U/P/L/N/O + the `?` help handler) guarded the full sibling set, so pressing B/I/E over an active dialogue/quest-log/heal overlay stacked a second overlay. Fix = add the three modal guards to KeyB/I/E — **guard-only, not hide** (hiding a live dialogue/quest/heal on a box keypress is wrong UX; the Escape ladder already closes them independently). Primary deliverable = a new source-scan gate `W-OVERLAY-FANOUT-MUTEX` (`main.wiring.test.ts`) that turns the whole class into a fail-loud invariant: each of the **13** overlay-open handlers must account for every sibling of the 14-overlay set (`{battle,box,raising,evolution,dialogue,questLog,heal,shop,trade,pvp,leaderboard,rename,tradePropose,help}`, `errorOverlayView` excluded) except its own toggle target — **modals via guard-form `!Y?.visible` only** (a `.hide()` on a modal must not satisfy it), the `{box,raising,evolution}` hide-switch trio via guard-OR-hide, `battleView` via the bare `battleView?.visible` token (covers the `shouldToggleBox(...)` call form). Handler blocks are sliced by min-over-all-anchors (12 `e.code === 'KeyX'` + `e.key === '?'` + an `e.code === 'Escape'` sentinel bounding KeyT/`?`). `W-HELP-FANOUT-OPENGUARDS` is kept alongside (complementary: it pins the help-specific guard-form per 12-`e.code`-handler; the new gate adds the full matrix incl. the `?` handler). The open-coded-lists → single overlay registry root-cause refactor (spec ptc5c-2) is **parked** as a named post-gate slice `M-postgate-overlay-registry` (Decision B — behavior-sensitive hide-switch flattening + SERIAL `main.ts` churn pre-gate; the gate already holds the correctness line). No schema/reducer/server change; `just knowledge` no-op. Gate proof: RED (9 failures = KeyB/I/E × dialogue/questLog/heal) → GREEN. ADR next-free = 0140.


## M-playtest-d — Playtest content pack (pre-gate)

**pt-d2** (roster wave 2 + placeholder-replacement sprites — ADR-0144) complete, content/assets only — no schema, no mechanics, no `client/src`/`game-core/src` change. Roster 6 → 10 forms: `content/species/050-wave2.ron` adds the wild-legal bases **Umbraquill** (20, Dark, *status* archetype — speed-first Poison applier) and **Gustwyrm** (21, Wind, *support* — the roster's first bulky pivot); `051-wave2-derived.ron` adds their evolution-only targets **Venumbra** (22, speed 100, the fastest form shipped) and **Tempestrix** (23, hp 92 / sp_def 96, the first true wall, ability 3 Regeneration), with two appended `evolutions.ron` blocks (20→22 `Level(22)`, 21→23 `Bond(180)`). Because roster waves are authored by **concurrently-running slices**, pt-d2 claims a reserved **id band 20–29** and the **`05x-`** filename band, and picks affinity/archetype by an explicit tie-break rule (tail of the `Affinity` enum among affinities that have skills → Dark, Wind; tail of the GDD §5 archetype list → status, support) so the two waves stay disjoint with zero communication (ADR-0144 D1). New base forms have no encounter row yet — encounter tuning is pt-d3, and no reachability validator exists, so this is valid-but-not-yet-wild content. Sprites: new `client/art-src/generate_monsters.py` **imports** `generate_art.py` primitives and never edits it (the shared 1200-line module is what wave 1 must also extend — editing it from both slices is the one guaranteed hard conflict), emitting `monster-<slug>.{png,json}` + byte-identical-rects `-normal` sheets in the shipped emberkit format (96×128, 12 `mon_<face>_<col>` frames, 8 animations, `left` = `hflip` of right) for the five shipped forms that had no sheet plus the four new ones; **seven body plans** (quadruped / bipedal-armored / serpentine-coil / rooted-sprout / amorphous-vapor / avian+size / orb+wraith) give each species a distinct silhouette rather than a palette swap (the H2 attachment bar). Assets ship **inert** — `client/src/render/placeholderAssets.ts` is still the only `AssetProvider`, so wiring them is a later slice. Gate: new auto-discovered `evals/pt-d2-roster-wave-2.eval.mjs` (reserved band, STAB, **orphan-derived-form + evolution-target-must-be-derived** — a red-team pass proved a base→base evolution passed both the Rust authority and the first draft — monotonic evolution BST, sprite set/format/normal-registration, and a **silhouette-distinctness** tooth that decodes each sheet's `mon_down_idle` alpha, crops to its bbox and requires ≥10% pairwise difference, so a palette-swap reskin fails). `CONTENT_VERSION` 12→13 + regenerated `evals/baselines/content-hash.json` (ADR-0073), committed last so a rebase behind wave 1 is one deterministic regeneration. ADR next-free = 0145.

## M-postgate-netcode-hardening — input responsiveness (post-gate)

**nh1** (movement-suppression `preventDefault` — ADR-0146) complete, client-only, `main.ts` + sibling teeth. The single window `keydown` handler had **two** early-return paths that never cancelled the browser's own default action: the 14-overlay movement-suppression block and the `if (e.repeat) return;` OS-key-repeat guard. 10 of the 14 overlays are plain normal-flow `<div>` shells in `client/index.html` (the other 4 build `position:fixed;inset:0` roots in JS) — 9 and 5 after ux1/ADR-0151 viewport-anchored `#help-overlay`, so opening one appends content below a viewport-sized canvas and makes the document scrollable — at which point Arrow keys/Space page-scrolled the game out from under the player instead of being captured (the 2026-07-25 playtest "controls stopped working" report; `KeyW/A/S/D` have no native scroll so they silently no-op'd, matching the report naming arrows specifically). Fix = both paths delegate to one non-exported `suppressNativeMovementDefault(e)` next to `KEY_DIR`, which cancels the default for `KEY_DIR` keys ∪ `Space` **unless `targetOwnsKey(e)`** — `INPUT`/`TEXTAREA`/`SELECT`/`contentEditable` own arrows *and* Space, while a focused `BUTTON`/`A` owns only Space (activation), so arrows over a button — the commonest focus state, since a button keeps focus after a click — are still suppressed. That target guard is load-bearing, not defensive: only `renameView`/`tradeProposeView` `stopPropagation()` their focusables, so the other eight overlays' buttons and `battleView`'s two `<select>`s (`bait-selector`, `cure-item-selector`) bubble straight to this listener, and a blanket `preventDefault()` would have traded the scroll bug for broken keyboard selection/activation. Covering the `e.repeat` path is what makes the fix work for a *held* key (each repeat keydown carries its own default) — a disclosed extension of EARS nh1-1. **`preventDefault`-only: no intent/predictor/`held`/frame-loop change** (desync lens clean; ADR-0013 untouched). Gates: 6 source-scan teeth in `main.wiring.test.ts` (`W-NH1-SUPPRESS`/`REPEAT`/`HELPER`/`TARGET`/`NONEGATION`/`NOVACUITY`) — anchor-bounded regions (never fixed-width: a fixed window overruns into the movement branch's pre-existing `preventDefault()` and would pass vacuously), line **and** block comments stripped, and the guard expression pinned contiguously after a red-team pass demonstrated an outer-negation mutant that passed lint, typecheck and every earlier tooth. Disclosed residuals: dead-code wrappers still satisfy source-scan (caught downstream by biome/tsc); `PageUp`/`PageDown`/`Home`/`End` remain unsuppressed (outside nh1-1's key set); modifier chords are suppressed, consistent with the pre-existing movement branch.

**nh2** (held-key continuation gate — ADR-0148) complete, client-only, `main.ts` + `prediction/predictor.ts` + sibling teeth. The "slippery movement" report (tap overshoots a tile; release stutters then walks one more) was **not** the keyup handler failing to cancel a queued step, as the spec assumed. Grounding it against live code found that `characterToPredictedBaseline` rebases every reconcile to `now − 2·STEP_MS`, so `#stepForward` drains the whole local queue on **every** reconcile — `#queue` is empty almost always, and "cancel the queue on keyup" would cancel nothing. The real defect is the *continuation trigger*: the rAF loop re-issues whenever `reissueDir(held.active(), predictor.lastQueuedDir)` is defined, i.e. whenever `#queue` is empty, which (because an accepted `enqueue_move` writes the character row under this client's own global subscription) is ~2-16 ms after every send. Emission was therefore **frame-rate-bound, not step-bound**: a measured 63.8 sends/s at 60 Hz (58.4 of them rejected `"queue full"`), amplified by a feedback loop where each rejection's `dropRejected` → `reconcileFromStore()` empties `#queue` and triggers the next re-issue. That, not key release, is what produced the 7,961 rejections in the 2026-07-25 playtest. Fix = a pure **not-emit** gate: `Predictor` gains `#lastAuthQueueLen` (set from `authQueue.length` in `reconcile`, before the ADR-0012 four-step) and one read-only accessor `outstandingSteps` = `#lastAuthQueueLen + #pending.length`, the steps the *server* still owes; both continuation emitters (rAF loop **and** the reconcile-divergence re-issue) gate on `outstandingSteps === 0`. The two terms cannot double-count because `authorize_move` writes the ack in the same transaction as the queue push. Nothing is cancelled and no reducer is called, so `reconcileFromStore()` stays the single repair path and the fix cannot desync by construction — the measured alternative (calling the existing unused `clear_queue` on keyup) rolls `#predicted` back up to 2 tiles and **teleports the player backward** through `RenderResolver`'s chebyshev>1 snap in 9 of 10 release phases, the exact defect class ADR-0141 exists to suppress. Plus **R1**: `predictor.drain(now)` moved above the re-issue block so a step emitted this frame is not drained by it — a residual fix (the gate takes press-phase render teleports 88% → ~2%, R1 takes that to 0%; R1 alone removes essentially none, so the two must not be separated). Measured net: 63.8 → 5.0 sends/s, 557 → 0 rejects per 10 s, unchanged 5.00 tiles/s. **Accepted trade (⚠ flagged for Drew):** sustained speed is now bounded by `2·oneWayLatency + framePeriod < STEP_MS` — display refresh is a term, so the cliff is ≈90 ms one-way at 60 Hz but ≈83 ms at 30 Hz; fine for the ADR-0129 localhost playtest, but any hosted deployment needs a lookahead/adaptive bound first. Gates: 26 behavioural teeth in `predictor.test.ts` driving a deterministic injected-clock simulation of the real client loop against a model of `enqueue_move`/`movement_tick` (each nh2 tooth paired with a `gateEnabled:false`/`drainFirst:false` twin reproducing the pre-fix behaviour), plus 3 source-scan teeth; six pre-existing fan-out teeth were **re-anchored** from fixed-width `slice(idx ± N)` windows to needle-bounded regions (assertions byte-identical — the windows broke because the edit moved code out of them, and widening them was explicitly rejected). Disclosed residual: no test executes `main.ts`'s frame body, so a `main.ts`-level revert is only fully closed by the parked `nh2-e2e` keyboard tooth.

**mvi** (hold-commit tap/hold discrimination — ADR-0158, amends ADR-0148) complete, client-only, `client/src/prediction/heldKeys.ts` + `main.ts` + `evals/hold-commit-step-budget.eval.mjs` + sibling teeth. Drew's r2 playtest residual (walk-to-edge, pause, single tap → sometimes 1/2 tiles, deterministic per server tick phase) diagnosed via a committed discrete-event sim (`movementSim.test.ts`, promoted from the diagnosis harness) against the real Predictor/HeldDirections/reissueDir wiring. Root cause: **not SERVER-side** (movement.rs proved innocent: one drain per op, drains == accepted emissions, zero rejections); **CLIENT-side** — the nh2 continuation gate reopens on tick observation, and the rAF loop re-issues if the key is still physically down. Tick phase φ is uniform in [0, STEP_MS=200), so P(double) ≈ tapMs/200 for 50–150ms human taps — the **continuation decision depended on SERVER TICK PHASE, not player intent**. This is exactly nh2's accepted `{1,2}` tap-emission residual, now operator-reported as a defect. Fix = **hold-commit discrimination**: heldKeys.ts stack entries stamp `pressedAtMs` in-entry; `press(dir, nowMs)` requires nowMs (clockless press = compile error); `committedActive(nowMs)` returns the active dir iff held ≥ threshold; threshold is `export const HOLD_COMMIT_MS = 150` (constructor param, defaulting). Main.ts changes exactly 3 lines (keydown stamped with performance.now(); both emitters swap `held.active()` → `held.committedActive(now)`); `const held = new HeldDirections()` stays argless. The dir-returning-method shape (vs a boolean guard) was a simplify-lens reshape: keeps every W-NH2 tooth byte-stable, deletes the argument-revert mutant class, and enables the whole-file `held.active(` === 0 count tooth (partially closes nh2 residual (b)). **HOLD_COMMIT_MS = 150 selection (two-sided)**: CEILING — walk-start cadence: X + framePeriod(30fps) + latency < STEP_MS or server idles (ADR-0013 class); sweep (fps {24,30,60,144} × framePhase × tickPhase × latency {0,1,25}): zero missed slots through X=160, min step-2 slack 22.9ms at X=150 vs 3.8ms at 160; selection rule 'largest X with ≥10ms slack, rounded 10' ⇒ 150. FLOOR — tap coverage: maxSafeTap(X)=X, human taps 50–150ms ⇒ X ≥ 140. Two constraints CANNOT both cover 180ms presses (30fps budget forbids raising X ≥ 200 — smoothness wins per ADR-0013). Contract: taps ≤ 140ms ⇒ exactly 1 tile every phase/fps; presses ≥ 240ms always walk; (150,240) indeterminate band. Binding the budget mechanically: `hold-commit-step-budget.eval.mjs` reads REAL STEP_MS from game-core/src/world.rs (cadence retune reds CI until threshold re-derived; U-H8 alone compares literal). Gates: 14 hand-applied mutants (re-stamp/parallel-map/stack-read/comparison/default-value/argument-revert/keydown-gate/divergence-wiring/time-since-construction/import-sealing/ceiling/floor/missing-call — each killed, zero survivors); anti-vacuity twins (S1-per-scenario, S5 ceiling, S9b-twin); disclosed un-killable (inherited from nh2 residual 1, unchanged by this fix). Disclosed residuals: (1) (150,240)ms taps still read as short walks — next lever NOT raising X (forbidden) but decoupling policies; (2) below 30fps stutter returns (X is frame-rate-bound, 30Hz floor per nh2); (3) nh2 residual 1b (ArrowRight+KeyD dual ungated) now sole same-direction double path — parked as `M-postgate-dualkey-dedup`; (4) no test executes main.ts frame body (sim + wiring teeth prove design, not runtime — `mvi-e2e` parked); (5) movementSim's ClientModel hand-maintained (drift risk in-file); (6) touch/gamepad require nowMs (compile error, not silent); (7) held key wiped by zone-warp/reconnect/overlay stays pre-existing, re-press restarts commit window (~150ms later than pre-fix); (8) predictor.test.ts stays pre-mvi (gates nh2's outstandingSteps invariants; movementSim.test.ts authoritative post-mvi); (9) e2e drives `__game().step()`, bypasses held, cannot regress nor prove this; (10) overlay-visibility duplication 3× in main.ts (pre-existing SSOT smell, noted for M-postgate-overlay-registry); (11) improvement: measurement harness COMMITTED (movementSim.test.ts).

**14r-e** (dualkey first-step dedup + movement-input runtime e2e — ADR-0187, amends ADR-0158) complete, client-only, closes mvi residuals 3+4. The dedup: `HeldDirections.isHeld(dir)` (membership in the held stack, deliberately NOT stack-top — a dir buried under a newer press is still held) gates the keydown's first step as brace-less `if (!held.isHeld(dir)) step(dir);`, a pure not-emit that closes the last same-direction double-move path (ArrowRight+KeyD both bound East) while preserving the nh2 F3 freeze-escape by construction (release evicts the dir, so re-press emits). The runtime proof: `client/e2e/movement-input.spec.ts` drives `page.keyboard.down/up` against the real rAF frame body — tap discrimination (A), the dual-code overlap RED proof (B), hold-through-overlay freeze+resume via the KeyB box toggle which does not `held.clear()` (C), and a sustained-hold send budget read from two new DEV-only `__game()` counters `moveSendCount`/`moveRejectCount` (D) — the counters exist because tile throughput is identical with the outstandingSteps gate intact or broken (server cadence paces acceptance), so only a send-budget observable separates the worlds. Executed bite-proofs: a second ungated keydown emitter outside every scanned region passes the ENTIRE wiring suite (the ADR-0158 "un-killable" class, confirmed live) and is killed by e2e A; the narrow `&& true ||` gate mutant measured 52 sends in a 1 s hold vs the ≤ 12 budget on the real stack. Honest scope: runtime closure is proven for the rAF emitter only (the reconcile-listener emitter stays source-scan-pinned); the keyup-by-dir asymmetry (releasing one code evicts the dir while the other code is physically down) is pre-existing and recorded, not fixed.

**13r-f** (held-key warp continuation — ADR-0192, amends ADR-0152) complete, client-only, `client/src/prediction/heldKeys.ts` + `main.ts` seam + sibling teeth. Closes the nh5 defect (ADR-0152 residual #4 / nh3-plan R6): `resetPredictionState()`'s `held.clear()` on the warp arm stopped movement dead at every zone boundary crossed mid-hold (keydown ignores `e.repeat`, so no re-registration). PARTIALLY CLOSES mvi/ADR-0158 residual (7) — the zone-warp half; the reconnect and overlay clears remain deliberate. Fix: `HeldDirections` gains pure `snapshot()/restore()` (entry-copying, replace-semantics, ORIGINAL press stamps preserved so an already-committed hold resumes next frame with zero re-commit delay and a mid-tap hold stays uncommitted per ADR-0158); `switchZone` brackets its `resetPredictionState()` call — warp arm ONLY; shared reset body + `onReconnect` byte-identical (ADR-0152's reconnect guarantee: `held.clear()` ALONE guards the deferred-reconcile gap, now mechanically pinned by a zero-held-touch region tooth). Invariant revision: warp-arm closure of ADR-0152 residual #1 now rests on same-flush reconcile ordering alone (load-bearing pinned fact: `batch.ts` `queueMicrotask`, `batch.test.ts:13-32`; the `connection.ts` `onOwnWarp` call order is belt-and-suspenders — the state-based path subsumes it). Gates: RED-first (13 red pre-impl incl. TWO wiring teeth), 8 unit/property teeth (U-W1..8), S12 behavioral block in `movementSim.test.ts` with both-policies modeling + a source self-check binding 'preserve' to the real seam (kills the shadow-log cheat), 4 wiring teeth incl. a same-nesting-depth anti-dead-branch assertion (kills the tautological-if wrap PoC'd by red-team), 10 live mutants all killed by named teeth; verifier confirmed gating tests unweakened; full client suite 2433 green. Disclosed residuals: warp-chain content risk newly reachable (`validate_zone_maps` lacks a to_tile-adjacent-to-foreign-from check; current content immune — follow-up); `onOwnWarp` ordering pin optional hardening; `predictor.ts:377-393` residual note now a stale pointer (out of touch set); hold-through-warp e2e now NON-vacuous (nh3 R7 reversed), sketch parked in ADR-0192.

**nh4** (reconnect token persistence — ADR-0150) complete, client-only, new `net/authToken.ts` + 4 wiring points in `net/connection.ts` + sibling teeth. `build()` never called `.withToken(...)` and discarded the token the SDK already hands to `onConnect`'s third argument, so every page reload minted a fresh anonymous identity — live module logs show Drew's single 2026-07-25 session spanning **6 identities**, each with its own starter grant, silently discarding the monsters/inventory/currency built up before it (and corrupting playtest metrics, since one tester's re-catch across two identities reads as two players' first attempts). No server change was needed: `join_game` already gates the starter on `!has_monsters`. Two spec premises did not survive grounding and both changed the design. (1) nh4-3's "a `playtest-wipe` leaves a stale, now-invalid token" is **false** — the token is a host-issued JWT verified at the host-level `/v1/identity/websocket-token`; `--delete-data` clears one database's rows and re-runs `init`, and the "owner re-register" note concerns the publishing CLI identity, not the browser's. Post-wipe the reconnect *succeeds* as the same identity into an empty DB and the unconditional `joinGame` yields a clean fresh start. The genuinely reachable failure is a **host reset** (fresh data dir / recreated volume / changed `STDB_SERVER`), which rotates the signing key and — since `reconnectPolicy.ts` keeps attempts unbounded with no give-up state — would loop forever re-supplying a dead token. (2) The obvious recovery, *clear the token when the error classifies*, is itself a data-loss bug: the SDK throws the identical `Failed to verify token: <statusText>` for a transient 500/502/503 as for a 401, and HTTP/2 mandates an empty `statusText`, so clearing would delete a player's identity on a server hiccup. The shipped design is **suppress, never clear**: `createAuthTokenGate` counts rejections *since the last success* and, at `AUTH_REJECT_SUPPRESS_THRESHOLD` (2), withholds the token for the next build; the anonymous connect that then succeeds overwrites it — a successful connect being the only available oracle for "the host is up and refused *us*". A red-team pass killed the first draft's reset-on-non-auth rule, which alternating rejection/network-error defeats (counter oscillates 0→1→0→1, suppression never engages); counting since-last-success is strictly stronger and still leaves a pure outage unable to advance the counter at all. Storage is per-tab **`sessionStorage`**, not `localStorage`: `on_disconnect` keys purely on identity with no live-connection check, so an origin-shared token would let closing a stray second tab forfeit the first tab's PvP battle and delete its character row. All behavior lives in the new module because `connection.ts` is coverage-excluded and only source-scannable; the 4 wiring points are pinned by needle-bounded gates that (per the ADR-0146/0148 vacuity lessons) assert exact contiguous arguments, exact occurrence counts, and position relative to the `stale()` guard — including a scope tooth for the mutant that moves the gate inside `build()`, which would reset the in-memory counter every rebuild and make suppression permanently inert. Disclosed residuals: the SDK's now-live token path puts a short-lived credential in the WebSocket URL's query string (SDK-owned; revisit before any hosted deployment, alongside the storage choice); Chrome's duplicate-tab `sessionStorage` copy still shares an identity (documented in `docs/playtest-ops.md`); no token TTL/rotation (M21 owns real auth); the parked `nh4-e2e` reload tooth is the only true end-to-end proof.

**M21b** (auth-kind marker — ADR-0179 D8) narrows exactly one of nh4's four wiring points, additively. nh4's design rests on the token slot holding a *long-lived anonymous* credential, which is why persist-and-replay is right for it. M21a's accounts work makes a *second, short-lived* credential class reachable, and the SDK echoes whatever was handed to `.withToken()` straight back as `onConnect`'s third argument (`dist/index.mjs:5765` assigns from the builder; `:6226-6231` adopts the host's own token only when none was supplied) — so the previously unconditional `auth.onConnected(token)` would have written an OIDC JWT into the anonymous slot, and `tokenForNextAttempt()` would have replayed it past its `exp` on the next build. `authToken.ts` therefore gains a companion `sessionStorage` marker (`mr.authKind.v1|<uri>|<db>` — deliberately **not** `mr.authToken.v1.kind`, which is a superstring of the token prefix and would have made key-space disjointness an argument rather than a construction), and `connection.ts` reads it once per build into `buildKind` and gates that one save. Everything nh4 established is untouched: `.withToken(auth.tokenForNextAttempt())` is byte-identical, suppress-never-clear is unchanged, and the marker fails to `'anon'` — today's exact behaviour — on every blocked/corrupt storage path. Two things are deliberately *not* claimed. The guard is **best-effort, not structural**: `'anon'` is also the permissive direction, so a lost marker re-opens the replay, and that fail direction is *forced* by AUTH-31 (failing to `'account'` would break every existing anonymous tab the instant storage is blocked). One lossy boolean cannot serve both requirements, so M21b-2 must **replace** the discriminator with the provenance of the credential actually supplied, carried in memory beside the token. And `writeAuthKind` ships with **no production caller** as a named YAGNI exception — writing `'account'` before the read-side guard exists causes three silent harms (stale-token replay; a permanently latched suppression counter, since `onConnected` is the only reset of `rejectionsSinceSuccess`; and a fresh identity plus an undeletable starter monster per reconnect), so a repo-wide source scan asserts no module under `client/src` even references the writer.

## 15r-sec-a — Participant-scoped battle privacy (security slice)

**15r-sec-a** (participant-scoped `battle` table via `my_battle` view — ADR-0198) complete, server + client: closes the M16 PvP information-disclosure blocker from ADR-0042:30. `battle` table flipped private (schema.rs:396), sole read path is the participant-scoped `my_battle` view — two point-index scans over existing btrees on `player_identity`/`opponent_identity` with dedup by construction (practice battles delivered once, ADR-0198 D3). Client half is NOT a mechanical rename: view bindings carry no PK (2.8.1 codegen confirmed; SDK deliberately pinned 2.6.0), so `onUpdate` never fires; every write arrives as insert+delete pair. Countermeasure = ADR-0194 D4 pattern: reconcile-from-cache inside batch flush (connection.ts:141-158, new `reconcileBattlesFromView(…)` method + `deepRowEq` for nested StoreBattle arrays; `store.battleCount` getter). Server prose corrected (schema.rs, battle.rs, pvp.rs) to remove public-table assumptions; evolution_tests.rs new mirror `e15r_sec_a_battle_is_private_and_its_view_is_participant_scoped`. Bindings regenerated post-view-publish; `battle_table.ts` deleted, `my_battle_table.ts` created. Client e2e (`my-battle-privacy.spec.ts`): two chromium instances, A drives wild encounter (practice-scoped battle), B observes zero battle — negative control proving participant-scope. Server-side unchanged (visibility is transport-only). Mandatory client hard-refresh (Q-B4 accepted). Evals extended: `monster-privacy.eval.mjs` [VB/*] family + view/subscription/bindings checks; `account-privacy.eval.mjs` `EXPECTED_VIEWS` array (sorted insertion, AMed). Proc-macro residual (lexical scan only) and subscription-batch atomicity (2.8.1 assumed) noted in ADR-0198 residuals. Lives opposed by: pvp-full.spec.ts/pvp-side-b.spec.ts (opponent_identity branch coverage), recruit.spec.ts (practice-wild precedent). ADR next-free = 0199.

## M-postgate-ux-design — unified overlay modality and registry (uxd3-a/b/c — ADR-0162/0163/0164)

The overlay subsystem was restructured around a pure `canOpen(targetId, visibleIds)` decision table and a centralized registry:

**uxd3-a (ADR-0162)** shipped the pure modality core — `OVERLAY_TIERS` (three tiers: EXCLUSIVE_TOP, HIDE_SWITCH, GUARD_ONLY), `OVERLAY_IDS` (15-member set), `canOpen` reducer, and a two-level `KeyM` menu (categories and leaves). Deferred the hand-maintained read-list collapse and hotkey routing.

**uxd3-b (ADR-0163)** unified the five `main.ts` OR-list read surfaces (overlay checks, modal reconcile, movement suppression, PvP aggregate, held-key re-issue) onto one `anyVisible(overlayProbes)` probe table, eliminating list duplication. Added AC-12 menu click launcher via `data-menu-launcher` attribute delegation. Deferred write substrate and hotkey→`canOpen` migration.

**uxd3-c (ADR-0164)** completed the write substrate: `visibleIds(probes)` for querying visible-id sets, and `OverlayHandles` (flat optional-thunk table; `dialogueView` guarded never-hide). Routed all twelve hotkeys and AC-12 click through `canOpen` verdicts. Retired four guard-list scan teeth + two reconnect fixed-window hazards; declined the `onReconnect` collapse (four-tooth cost for six lines); deferred Escape re-anchoring boy-scout (73 lines, atomic). **`M-postgate-overlay-registry` CLOSED.**

## M-postgate-ux-hardening — discoverability affordances (post-gate)

**ux1** (help affordance — ADR-0151) complete, client-only, `client/index.html` + `client/src/ui/battleView.ts` + sibling teeth. Two persistent hints for the two discoverability gaps the 2026-07-25 playtest gate named: a corner badge advertising the `?` help overlay (EARS ux1-1) and a "Press Esc to continue" hint on battle-result screens (ux1-2). **The slice grew one disclosed part because the affordance it advertises did not render on screen.** `#help-overlay` shipped at pt-c2b (ADR-0135) carrying *only* `style="display:none"` — a static, in-flow `<div>` placed after the `window.innerHeight`-tall PixiJS canvas in `#app`, with no CSS file anywhere in the repo and a `HelpView` that only ever writes `style.display`. So `HelpView.show()` painted it below the fold (measured `top=724` at `innerHeight=720`) in default black on the `#0b0d12` body; advertising it alone would have been a net-negative change that passed its own static-markup teeth. It now carries `position:fixed;inset:0;z-index:100;overflow:auto` plus a readable background, mirroring the four JS-created modal roots and staying under `battleView`'s `z-index:110` so a battle auto-show still supersedes it. **The hint itself is zero-JS static markup** — no view class (a new `src/ui/*.ts` shell would land in the 96% coverage denominator with no legal exit, since `dom-shell-coverage-exclusion.eval.mjs` exact-set-guards `vite.config.ts`) and not owned by `main.ts` (which is coverage-excluded, and the hint would then be absent exactly when the client fails to boot). The continue hint is a sibling of `#outcomeEl`, never merged into its text (three e2e specs use `getByText('Victory!', {exact:true})`) and never its child (`#renderOutcome` writes `textContent`), toggled on the existing `outcome === 'Ongoing'` predicate with no `isPvp` branch and reset in the `refresh(null)` branch alongside weather/pvpStatus. Gates: 8 assertions in a new `client/src/indexShell.test.ts` that parses the **real** `index.html` (the repo's hand-mirrored-fixture view-test idiom is vacuous for this), 7 cases in `battleView.test.ts`, and 2 source-scan pins in `main.wiring.test.ts` (`W-UX1-ESCAPE-BATTLE` pins the Escape→battle-dismiss binding that makes the hint truthful — otherwise wholly untested; `W-UX1-HINT-NO-JS-OWNER` pins the zero-JS invariant, the only tooth enforcing ux1-1's "not just on first load"). **Disclosed residuals:** the other **nine** in-flow overlay shells (`dialogue`, `quest-log`, `heal`, `shop`, `trade`, `pvp-challenge`, `leaderboard`, `rename`, `tradepropose`) have the identical below-the-fold defect and are deliberately out of scope — the strongest available evidence for prioritising the parked `M-postgate-overlay-registry`; and no test here proves the hint is *visibly* rendered (happy-dom does no layout, so ~12 invisibility bugs pass any static-markup test — that needs `client/e2e/**` + `toBeInViewport()`). ADR next-free = 0152.

**ux3** (playtest preflight — ADR-0153) complete, tooling-only: `justfile` + `docs/playtest-ops.md` + `evals/playtest-verify.eval.mjs`. `playtest-up`/`playtest-wipe` went straight from the `MR_PLAYTEST_DB` guard to `spacetime build`/`publish`, so running either without a SpacetimeDB cost a full wasm build and then an opaque `tcp connect error`, with nothing naming the fix; `spacetime start` appeared nowhere in the justfile or the runbook. New shared `playtest-preflight` recipe, called as an exact unsuffixed line from both, after the (network-free) DB-name guard and **before** the build — deliberately inverting the old "build first so compile errors surface before network contact" ordering, since a compile error still precedes the publish and with the server down neither recipe can succeed either way. **The probe is `timeout 10 spacetime server ping "$STDB_SERVER"`, not `curl "$STDB_SERVER/v1/ping"`**: `publish -s` accepts `spacetime server` NICKNAMES (`local`, `maincloud`), which a URL-constructing curl probe fails DNS on — a preflight that resolves its target differently from the command it guards can confidently misdiagnose a healthy server, which is worse than the error it replaces. **Shared resolution proved insufficient on its own:** `server ping` exits **0 for any completed HTTP round-trip**, so a trailing slash or path suffix (`Server returned 404`) and any unrelated service on that port (`Server could not be reached (500 …)`) all passed the first draft while `publish -s` rejects them; the probe therefore matches the literal `Server is online` line and echoes the CLI's own last output line so the failure names the real cause (404 / 500 / connection refused). `command -v` branches for `spacetime` and for GNU `timeout` keep a missing binary from being misattributed to a stopped daemon — the same misattribution the curl design was rejected for. Gate (this eval is the ONLY automated check on these recipes — `just ci` cannot run them, they need a live DB): an order assertion (the exact trimmed call line strictly before the first `spacetime build`/`publish` in BOTH recipes, returning false when EITHER anchor is absent so a recipe that stops calling spacetime cannot vacuously pass), comment-stripped body needles, `timeoutBindsProbe` (`timeout <positive-N>` must immediately precede the probe token — `timeout 0` *disables* the timeout in GNU coreutils, and a dead doc-string satisfied a naive co-occurrence check), and **four behavioral teeth**: negative (dead port → non-zero, with the remediation text on stderr *and* the runtime-EXPANDED URL, because `just` echoes a non-shebang recipe's source lines and the remediation string alone can be supplied by a line that never executed), a positive control (live local HTTP stub → exit 0, without which "the preflight always fails" is a passing implementation), a non-SpacetimeDB-responder tooth (500 stub → non-zero, the tooth for the output-matching decision), and a call-site tooth that runs both callers with a fake `spacetime` first on PATH and proves they abort without ever invoking it — the only assertion gating that the CALLERS honor the preflight rather than merely containing the line (kills `set +e` above the call, a `just() { :; }` shadow that would also silently disable the pt-a2 dev-reducer honesty gates, and the call parked in a dead `if` branch; no source scan reaches that class). An earlier source-scan-only draft of this gate let 9 of 19 functionally-broken implementations pass GREEN; the shipped gate kills 10/10. The behavioral teeth skip when the `spacetime` CLI is absent, per the existing `bindings-drift` convention (CI installs it before `just eval`). Disclosed non-scope: `playtest-report` and `playtest-verify-release` reach the same server and keep the opaque failure mode. ADR next-free = 0154.

**ux2** (owner-scoped wallet view — ADR-0154) delivers the server half complete and the client half as a deliberate, disclosed seam: `server-module/src/schema.rs` (+ `economy_tests.rs` teeth), `client/src/net/store.ts`, `client/src/ui/{shopModel,shopView}.ts` (+ sibling teeth), a new `evals/wallet-privacy.eval.mjs`, and regenerated bindings. `player_wallet` stays PRIVATE; `#[view(name = my_wallet, public)] fn my_wallet(ctx: &ViewContext) -> Option<PlayerWallet>` returns `ctx.db.player_wallet().owner_identity().find(ctx.sender)` and nothing else. **`public` on a view is a mandatory keyword with no visibility effect** (`spacetimedb-bindings-macro/src/view.rs` marks it `#[allow(unused)]` and *rejects* its omission); per-caller scoping comes from the host ABI reconstructing `sender`, so the body's filter is the entire security boundary — which is why the gate is shaped the way it is. Adversarial review drove that shape, and **corrected which leak actually matters**. A view handle has no `Table` impl (`spacetimedb-bindings-macro/src/table.rs`; empirically `error[E0599]: no method named 'iter' found for &player_wallet__ViewHandle`) — `.iter()` **cannot compile** inside a `ViewContext`, and `UniqueColumnReadOnly` exposes only `find`. So the whole-table-scan family the first gate draft centred on is already forbidden by the compiler; those clauses are kept as defense-in-depth but police nothing reachable. **The one reachable leak in a view is a point lookup on the wrong key** — and a presence-only "body contains `find(ctx.sender)`" check waves it straight through, because a dead `let _decoy = …find(ctx.sender);` above `…find(victim)` satisfies it while passing eval, `cargo test`, clippy and `fmt`. The sanctioned body is a single expression, so the gate pins it **exactly**: the whitespace-compacted body must EQUAL `ctx.db.player_wallet().owner_identity().find(ctx.sender)`, in both the eval and the Rust tooth. Around that, `checkWalletViewsSafe` closes `walletReaderFns` to a **fixed point** (every fn whose brace-walked body touches the accessor, plus every fn that calls one, transitively) and fails any view referencing the table or reaching it through that closure — a 1-hop derivation is defeated by `view → roster() → census()`; it also pins the return type to `Option<PlayerWallet>` with `Vec<` banned (a `-> Vec<PlayerWallet>` view carrying a conforming `find` is indistinguishable in the generated binding, so nothing else can see it), bans the substring `iter`, and rejects `AnonymousViewContext` (a legal view context that carries no sender). A companion `checkWalletAccessorConfined` pins the accessor to `fn my_wallet`'s body inside `schema.rs` — the file `currency-integrity`'s ACCESSOR_BYPASS criterion explicitly exempts. Table-privacy is NOT re-implemented here (owned by `currency-integrity` criterion 3 + `player_wallet_table_is_not_public`). **The client never removes the wallet row on a view delete**, unlike the `my_conversation` precedent: no server path deletes a `player_wallet` row (six accessor calls in `economy.rs`, zero deletes — pinned by `player_wallet_rows_are_never_deleted`), so a view `onDelete` can only be the old half of an update pair, and a net-effect balance-equality gate would *fire on the live row* during a buy-then-sell round trip (100→50→100 delivers `I(50) I(100) D(100) D(50)`; no comparison on the row's own fields can distinguish that from a genuine delete). Insert-wins + `reset()` on disconnect is provably correct. The store holds a **single slot**, not a map, so another player's balance is unrepresentable in the client cache; `ShopBalanceViewModel` is a two-arm union so "broke" (`0n`) never collapses into "not subscribed" — a `?? 0n` design would show "Gold: 0" to a player at `MAX_BALANCE` during any delivery gap. **Disclosed residuals (both client-half items since DISCHARGED by ux2b — ADR-0169):** the view is live and world-callable at publish time and ux2's only in-slice proof was structural — the behavioral two-identity assertion needed `client/e2e/**`, outside its declared touch-set, and now ships as `client/e2e/wallet-balance.spec.ts`; and the client half was inert (the optional 5th argument unpassed) until ux2b wired `connection.ts`/`rowConvert.ts` and **all three** `buildShopViewModel*` call sites — D7 said *both*, a count stale since uxd2/ADR-0161 D5 added `buildShopViewModelForShop`, corrected by ADR-0169 D4. **Still open:** `#shop-balance` inherits `#shop-overlay`'s known below-the-fold defect until `M-postgate-overlay-registry` lands — viewport-anchoring just the balance node was rejected as it would float a naked "Gold: 123" over an invisible shop panel. ADR next-free = 0155.

**ux4** (battle-swap discoverability — ADR-0155) complete, client-only: `client/src/ui/battleView.ts` + `client/src/ui/boxView.ts` + sibling unit tests. ux4-1's repro step **confirmed** the box/team-separation hypothesis and **refuted** the swap UI as the defect — `attempt_recruit` grants `PARTY_SLOT_NONE` (a *decided* behaviour, ADR-0047 §3, to avoid clobbering an occupied party slot), `lead_party` filters those rows out of side A, so `battleModel`'s `canSwap = bench.length > 0` is correctly false with one party monster and `#renderSwapButtons` is correct ⇒ ux4-2 (explain the absence) applies and ux4-3 (fix the UI) does not. The repro is executable, not prose: S1/S2/X2 are GREEN on the untouched tree, and S1/S2 are the repo's **first PvE `Swap:` assertions** (only `Submit Swap:` was pinned, so deleting the PvE arm of the label ternary was a green mutant). Shipped: a toggled `#swapHintEl` in `battleView` on `vm.outcome === 'Ongoing' && !vm.canSwap` — keyed on the **same flag in the same method** as the buttons, so "hint shown ⟺ no swap buttons rendered" is structural rather than derived through the model's `canSwap = bench.length > 0` identity (H8 pins the only separating shape, `canSwap:false` with a non-empty bench; the inconsistent `canSwap:true, bench:[]` shape was measured to behave identically under both predicates) — plus a **static** `#hintEl` in `boxView`, whose asymmetry is forced: the battle copy asserts a conditional fact that goes false the moment the player fixes their party, while the box copy asserts a model invariant that holds whenever the overlay is open, so a toggled box hint would require inventing a predicate. **Every clause of both copies is honesty-forced, not stylistic:** `B` is a dead key while the battle overlay is open (`main.ts` KeyB → `inputGuards.ts` = `return !battleVisible`) and stays dead past the battle, because a terminal row is not GC'd on resolution and `decideBattleOverlay` re-shows a non-dismissed terminal — so the copy names the **Esc** step and orders the timing qualifier *before* the key name; healing is not advertised (`heal_party` is zone-gated to `zone_id: 0` while a zone-1 encounter table exists, and `main.ts` skips the send with no heal location in the store); the battle copy is scoped **"in this battle"** because a red-team sequence falsifies the unscoped claim (Esc un-gates KeyB → unguarded `set_party_slot` accepts `To Party` → the row write re-shows the overlay → snapshot `sideA.team` keeps `canSwap` false); and the box copy **describes** the `To Party` button rather than commanding a click, since the empty-box branch renders none in the fresh-player state. ux4-2 is discharged in a **weakened always-on form, not recruit-triggered** (ADR-0047 §1: the client cannot distinguish a recruit-end from a KO-end by `outcome`, and a first-class recruit event needs `main.ts`/`battleModel.ts`, both out of the touch-set). Gate = **15 cases** (S1/S2, H1-H8, X2-X6) and nothing else: both shells are sanctioned coverage-excluded DOM shells and there is no TS mutation gate. That gate was earned adversarially — an earlier 12-case draft passed a **cheating** show-only implementation with the reset laundered into `hide()` (it greened both reset arms while parking the hint next to "Victory!" and beside a live `Swap:` button; H7's live-view transitions with no `hide()`/`refresh(null)` kill it), three conjunct mutants (`weather`/`playerCard.status`/`cureItems`) survived until H1's fixture varied fields that were constant across every other fixture, a copy adding `' Or press ? for help.'` survived at 124 chars until `?`/`help` fences plus a 120-char cap landed (`?` is dead behind the battle overlay too — the literal ux1 lie), and a whole-sentence-swapped copy survived until a reason-before-remedy ordering assertion landed; final probe 26/26 named mutants killed. Named deferrals D1-D8, including **D6 `M-postgate-pvp-side-b-overlay`** — a CRITICAL pre-existing product bug this slice found and did not fix: the PvP **side-B** player never receives a battle overlay at all (`refreshBattle` reads `store.latestPlayerBattle(identity)`, which filters `playerIdentity`, while the accepting player is stored as `opponent_identity`), hence no cards/skills/swap buttons and **no forfeit control anywhere**, frozen until the 60 s deadline — so the ux4 hint is **side-A-only in PvP** and "B is dead while the overlay is open" is a side-A statement — and **D7** `set_party_slot`'s missing `is_in_ongoing_battle` guard (audited **not** exploitable today: `write_back_party_hp` keys off the `party_monster_ids` id snapshot and no mid-battle `party_slot` reader exists, but the safety is emergent, unguarded and untested — there is no `monster_mgmt_tests.rs`). Disclosed residuals: the hint fires most often in the wild-battle state where the Recruit control shares `#actionsEl` and the copy does not name it (a `canRecruit` branch was rejected on ADR-0151 D3 precedent); `battleView`'s root has no `overflow`, so ~20 px of added height needs a real 720p measurement (happy-dom does no layout — folds into the deferred `client/e2e/swap-hint.spec.ts`, where `To Party` now matches two nodes and demands `getByRole('button', …)`); and the copy hardcodes `Esc`/`B`, which the existing fan-out teeth pin only by guard *shape*, not by letter. Merge-order note: concurrent sibling slice **ux2 holds ADR-0154** and also appends to this section, so if ux4 merges first the trailing next-free line needs the supervisor's reconcile. ADR next-free = 0156.

**ux2b** (wallet view runtime path — ADR-0169, amends ADR-0154; delivered as slice **11r-e** of `M-postgate-eleventh-review-residuals`) closes ux2's disclosed client seam, and with it Drew's 2026-07-25 playtest complaint ("a cost is listed, but the amount of money I have is not obvious"). `net/connection.ts` adds `'SELECT * FROM my_wallet'` to the single `.subscribe([...])` array plus ONE **insert-only** `conn.db.my_wallet.onInsert` handler — no `onDelete`, no `onUpdate`, because per ADR-0154 D4 a row update through a view arrives as an unordered insert+delete pair, so copying `my_conversation`'s `shouldRemoveOnViewDelete` gate would remove the *live* row on a buy-then-sell round trip; the tooth is a whole-file contiguous needle plus zero-count clauses precisely because that copy-paste is the likeliest mistake. `net/rowConvert.ts` adds the pure pass-through `playerWalletRowToStore` (`balance: bigint` untouched — `Number()` loses precision near `MAX_BALANCE`, `?? 0n` fabricates "broke" from "dark"). `main.ts` passes `store.ownWallet(identity)` at **all THREE** `buildShopViewModel*` call sites (`:1378` the dialogue listener's deferred shop open; `:1437`/`:1445` the shop batch listener's bound/unbound arms) — ADR-0154 D7 and the 11r-e spec both say *two*, a count stale since uxd2/ADR-0161 D5 added `buildShopViewModelForShop`; ADR-0169 D4 corrects it and an exactly-3 count tooth (reusing the file's existing `callArgs` paren walker) freezes it. The two-identity behavioral proof ux2 could not write ships as `client/e2e/wallet-balance.spec.ts`, funded by the deterministic `quest_001` 50-gold faucet (whose `Talked` trigger fires in `talk` — see the Economy sources bullet) and asserting the balance at **first paint** via an `addInitScript` `MutationObserver`, because a retrying `toHaveText` cannot red an implementation that patched only the batch listener: `movement_tick` re-renders an open overlay every ~200 ms with no player input. Stated so it is not later miscited, that e2e gates the CLIENT owner filter and render path only — server-side view scoping stays owned by `evals/wallet-privacy.eval.mjs` and `economy_tests.rs::my_wallet_view_is_owner_scoped` (ADR-0154 D2). Disclosed residuals: the below-the-fold `#shop-overlay` defect is untouched (ADR-0151); `wallet-privacy.eval.mjs`'s own forward-claimed `FROM my_wallet` positive anchor was NOT folded in (`evals/**` is outside the touch-set — the identical anchor ships in `connection.test.ts`, which gates `just client-test`); the `0n` ⇒ "Gold: 0" behavioral proof needs a second identity at a *different* nonzero balance via a trade round trip and is deferred; and the hand-written `Sdk*Row` interfaces still have no drift gate against the generated bindings (repo-wide convention, repo-wide fix). ADR next-free = 0170.

**11r-g** (server hardening basket — ADR-0170, amends ADR-0089) complete, four independent items, `M-postgate-eleventh-review-residuals`: (1) `movement_tick`'s grass-encounter swallow sites (`table_from_encounter_row` Err, every `begin_encounter` Err) become rate-limited logged no-ops — an instantiable `RateLimiter` (`Mutex<(Option<i64>, u32)>`, saturating arithmetic since release ships `overflow-checks = true`, clock-backwards emits-and-re-anchors) with two independent statics so a spammy table fault cannot mask `begin_encounter` failures, a `suppressed` count in every emitted line, and the client-controlled routine "party has no conscious monster" reason filtered at source via a shared `battle.rs` const so a hostile fainted-party grass-walker can neither flood the log nor saturate the limiter window (mutation-verified: the `!=`→`==` mutant is killed by a contiguous filter+gate needle). (2) ADR-0089 completion for `battle.rs` only: `cached_abilities()` (7th LazyLock) replaces 4 per-action RON re-parses, and a NEW `content_version`-keyed rebuildable type-chart cache (`cached_type_chart(ctx)`; coherence = single `type_relation_row` writer + same-transaction version stamp; Err never cached; lock deliberately held across rebuild; forbidden-caller invariant source-scan-pinned across content.rs/marshal.rs/evolution.rs) replaces the per-action full-table rebuild in `submit_attack`/`swap_active` — `pvp.rs`/`taming.rs` sites stay uncached (outside the declared touch-set, recorded residual). (3) The heal-cost item SPLIT: `cached_heal_locations()` (8th LazyLock) ends `heal_party`'s per-call registry re-parse and `healModel.ts` gains the required `costCurrency` VM field + three-way `isFree` (inert seam, `?? 0`, NaN-preserving) — the `HealLocationRow.cost_currency` column itself is PARKED as a hidden dependency (seed site is a `content.rs:702` struct literal outside the touch-set, and the column amends ADR-0083 §A) with the full runtime path enumerated in ADR-0170 residual 1. (4) `json_escape` at `log_reject`'s choke point (single forward pass, `'\u{0022}'` spelling per the W-pre scanner invariant, both `reducer` and `reason` escaped — several call sites forward `&str` params) plus the two `movement_tick_error` sites; the same defect class at `battle.rs`/`pvp.rs`/`content.rs`/`npc.rs` log sites is a recorded residual, not ridden along. Gates: 424 module tests + 48 healModel vitest + 74/74 evals; five bite-verified teeth (window boundary, gated-log mega-needle, `let_`-discard ban, version-hit/Err-not-cached, `??`-vs-`||`); cargo-mutants on the diff 31 caught / 1 missed → the miss got its own tooth. ADR next-free = 0171.

**11r-h** (test-integrity & diagnostics residuals — ADR-0172, amends ADR-0130/0157) complete, `M-postgate-eleventh-review-residuals`; five items, only one touching production code. (1) RT-SZ-02 (`net/switchZoneAtomicity.test.ts`) was `expect(true).toBe(true)` under a header declaring itself "a documentation test"; it now constructs a real `Predictor` and asserts a seeding reconcile returns `false` **while its own drain advances the predicted tile** (the non-empty-`authQueue` case `prediction/predictor.test.ts` does not cover), with a diverging-reconcile contrast case killing the always-`false` mutant. Because a `Predictor` unit test cannot pin RT-SZ-02's actual subject — the batch listener FALLING THROUGH to reconcile after a zone switch — a companion source-scan tooth pins that the only `return` between the zone-mismatch branch and `predictor.reconcile(` is the guarded e-2/M13.5e failed-switch form. (2) The M14d red-team weather test asserted a kill condition (`let _valid = matches!(…)`) that `content.rs` no longer contains; rewritten as a positive pin over ALL FOUR `WeatherKind` variants **plus a negative control** (a weather skill that is independently invalid ⇒ `is_err()`) — without it the whole-function `validate_content(..) { Ok(()) }` mutant survived, since no reachable implementation of an all-`{}` exhaustive match can return `Err`. (3) F-5f's assertions sat inside `if (gateIdx >= 0)` with a trailing `expect(true)`; more seriously, `src.indexOf('if (import.meta.env.DEV)')` — the computation used by the WHOLE F-5 family — resolved to a **comment** ~150 lines above the real gate, so deleting the gate (shipping the DEV hooks into production bundles) left every one of them green. All six now share `devGateIndex()` (comment-stripped source, brace-included needle, `expectUniqueAnchor`), and F-5f became four falsifiable assertions built on **containment** of the gate block rather than index ordering (ordering false-fails on a correct repositioning and goes vacuous on any top-level insertion). Verified by replaying the gate-deletion mutation against origin/master's copy (6 passed) and this one (6 failed). (4) A third revival tripwire joins `spec-gap-revival.eval.mjs`'s expiry and dev_reducers detectors: RED when `client/e2e/recruit.spec.ts` still parks R4 behind a `test.fixme` citing `grantBait` while any live line under `client/src` exposes it — `evals/**` never scanned (proven green under symlink attack), `*.test.ts` and `module_bindings/**` excluded with in-code rationale, **both** comment syntaxes stripped (a block-comment mention of the token false-alarmed the entire eval on a correct tree), dirent-based walking so a dangling symlink cannot red it, and a GB-ANCHOR tooth so a reworded fixme cannot leave the tripwire dormant. (5) Movement rejections were invisible: `main.ts`'s `enqueueMove` `.catch` repaired prediction with no trace, so an F9 bundle from a rubber-banding player showed nothing. It now emits a dev-console fate line (`formatFateLine`/`makeFateLogger` in `net/devLog.ts`, mirroring the send pair, deliberately IGNORING `NOISY_REDUCERS` — rejections are rare and are the signal) and a rate-limited `errorRing` breadcrumb (`rateLimitTick`, a pure options-object transition unit-tested for the gap boundary, the cap edge, purity, a backwards clock and event conservation). The breadcrumb reaches the **bundle** but is filtered out of the **overlay** by a shared `MOVE_REJECT_PREFIX` at `pushError`'s render — `errorRing` IS the overlay's data source, so a raw push would have surfaced movement rejections to the player on the next unrelated error (M2 §3) and evicted every genuine error from the 8-record window; the first plan draft got this wrong and ADR-0172 D3 records the correction. `noteMoveRejection` is total by construction. Named residual, honestly stated: `main.ts` is coverage-excluded, so item 5's gate is source scanning — the red-team pass wrote EIGHT intent-breaking implementations that passed all 1827 client tests and all 74 evals, and each was closed with an ordering or verbatim assertion and re-measured; the durable fix (extract an injectable `makeMoveRejectRecorder` under `net/`) needs a new file and is a named follow-up, alongside the identical one-hop-indirection hole inherited by `W-DEVLOG-EAGER` on the send side. ADR next-free = 0173.

**11r-f** (resume-from-idle interpolation smoothness — ADR-0171, amends ADR-0090) complete, client-only pure-core, M-postgate-eleventh-review-residuals: two defects made every remote/NPC pause-resume ugly — (1) the jitter EWMA in `store.ts upsertCharacter` had no gap bound (one 5s pause fed deviation≈4800 → ewma 600 → delay clamped at 2.5 steps for ~2.1s), fixed by the one-sided idle-gap gate `interval <= JITTER_IDLE_GAP_STEPS(=3) × stepMs` admits / `>` skips — bookkeeping (receivedAt baseline + ring append) deliberately unconditional (gating the baseline would freeze the estimator forever after any idle), EWMA carried across gaps unchanged; (2) `interpolateHistory` lerped the whole gap (first resume frame a≈(G−D)/G ≈ 0.9-tile pop then a crawl), fixed by re-anchoring any bracket with raw span strictly > REANCHOR_SPAN_STEPS(=2)×stepMs to the window [next−stepMs, next] with a dead-zone hold at prev below it — outer HOLD/clamp untouched, per-bracket, raw-span≤0 guard first. API: `interpolateHistory(snapshots, renderTime, stepMs = 0)` — 0 disables (legacy byte-for-byte, the tested regression property); sole production consumer `renderResolver.ts` forwards its injected `#stepMs` (declared touches-delta; test (xviii) exists solely to kill a revert of that line, and (H-E) kills a hardcoded-200 literal at stepMs=50). Constants file-local single-consumer by design (shared interpConfig is outside the touch-set — deferral D-A); `JitterEstimator` (zero production callers) got a divergence JSDoc note instead of the gate (D4; unification/deletion queued D-B). 25 gating tests (19 started red) authored by a separate tester from EARS E1, strengthened after an executed red-team pass closed 6 verified reward-hack holes (fractional-boundary aliasing both sides, bracket-index cheat, oldest-clamp drop under stepMs>0, resolver stepMs literal, synthetic-interval source at stepMs=20); verifier hand-ran 12 source mutants — 12/12 killed. Accepted residuals pinned by tests: evolving-D backward wobble ≤ 0.2 tile (closed-form tight max, test (xix); same class ordinary brackets already had), sustained-cadence hold-then-slide shape is intended (matches SlideClock motion language, test (x)); known band (2×stepMs, 3×stepMs]: re-anchored shape correct but EWMA fixed-point keeps delay clamped — never a regression vs pre-11r-f, recorded as D-D evidence. ≥2-tile resumes still snap (M12.5d-2, intended). Gates: 275/275 gating, 1830/1830 client, full `just ci` exit 0. ADR next-free = 0172.

**11r-i** (gate-coverage extensions — ADR-0173, amends ADR-0006/0093/0095) complete, `M-postgate-eleventh-review-residuals` — the milestone's LAST slice; four items, one of which overturned a load-bearing assumption. (1) `dialogue-client-integrity`'s C6 read only `dialogue_trees/000-core.ron` while `build.rs` glob-loads the directory (blind the moment a `010-*.ron` part lands) and compared node ids + choice COUNTS, never TEXT. It now reads every part in sorted order **as independent parts** (mirroring `content.rs parse_parts`, which never concatenates), segments **per tree**, and compares node `text` plus the ORDERED choice-text list bidirectionally. Root cause was deeper than the spec knew: the old `nodesBlockStart = indexOf('nodes:')` / `findStandaloneIdPos` heuristics were **already wrong on the committed single file** — `000-core.ron` has two trees and both define a node `id: "greeting"`, so both resolved to the first tree's position, and the second tree's tree-level id was scanned as a node id; it passed by coincidence. Normalization is **escape-decoding only** (RON's real grammar — `\xHH`, braced `\u{…}`, never bare `\uXXXX`; TS's real grammar — bare `\uXXXX` AND `\xHH` AND braced `\u{…}`), byte-for-byte after, with fail-loud `unsupported string form` on anything unsupported: no trimming, case folding or Unicode normalization, each of which is a silent drift channel. The scanner is string-literal aware because it must be — a red-team pass proved a live false-PASS where one unbalanced `]` inside authored choice text desynchronized the old bracket counter and a bundle **missing an entire choice** reported as matching. (2) Append-only id coverage went 5 → 10 registries: `abilities`/`shops`/`npcs` joined the numeric gate, and a new sibling `append-only-string-ids.eval.mjs` pins quest ids, dialogue TREE ids and `npc_id` — the strings `PlayerQuestRow.quest_id`, `PlayerConversation.current_node_id` and `Npc.npc_id` key live player rows on. The spec's "string-id registries" premise needed correcting: `npcs` carries BOTH a numeric entity `id` and a string `npc_id`, so it is gated twice; `dialogue_trees` pins tree ids only, since node ids are tree-scoped and duplicated. `heal_locations` is excluded **deliberately** (ADR-0140 §ptc5e-2's `stale_heal_location_ids` reaper deletes removed locations by design; no persistent row keys on `location_id`; a removed id fails closed with `Err("heal location not found")`) — and that exclusion comment is **mechanically checked**, not merely cited, by source-scanning `raising.rs` for the rejection it claims. Two red-team-proven comment-masking vectors (mid-line `//` and `/* … */`, the latter already-used RON syntax) are closed by a string-literal-aware `trailingCommentIdNeedles`/`commentIdNeedles` that REFUSES an ambiguous registry rather than trusting the scan; `parseIds`/`readRegistryDir` stayed byte-identical because `game-core/tests/{pt_d1_roster,pt_d3_tuning}.rs` pin their semantics and `game-core/**` is outside the touch-set. (3) `npc.rs`'s silent unknown-quest `continue` now emits a `quest_def_missing` warn, `json_escape`d (ADR-0170 D5) and gated by a dedicated process-static `RateLimiter` at a 60 s window on the injected clock — "once per sync" realized as "once per window per process", which is at least once per content sync because a republish reinstantiates the module and resets statics. Control flow is unchanged. Three successive adversarial passes each found a cheat satisfying the previous teeth (an unread `let _escaped =` binding; a second ungated `log::error!` leaking the raw id; a `check(now_ms(ctx), 0)` window) — each closed. (4) **The spec's BSATN item was built on a false premise, and measuring it is the slice's most valuable output.** `bsatn-compat-smoke`'s header asserted, untested, that "SpacetimeDB handles additive schema at the ENGINE level when publishing without --delete-data". Measured against live spacetime 2.6.0: adding a field to the nested `BattleState` struct is **REJECTED** ("requires a manual migration") even as `Option<T>` with `#[serde(default)]`; so is a nested field inside a `Vec` column; a top-level column inserted mid-struct is rejected twice (reordering + missing default annotation); **only** a column appended at the END carrying an explicit `#[default(...)]` publishes cleanly with rows surviving. So ADR-0006's additive promise is narrower than it read. The proposed nightly phase is additionally unbuildable: no live `battle` row can exist at republish time, because a one-shot `spacetime call` disconnects immediately (RT-SR-01 confirmed empirically — `SELECT * FROM player` is empty right after `join_game`) and `resolve_wild_battle_on_disconnect` (ADR-0138) deletes any ongoing wild battle. The false header is corrected, the verified rules made machine-visible, and `spacetime-type-snapshot` (which already pins `BattleState`'s field list) named as the gate that actually catches a nested widening — in CI, not 24 h later. Named follow-up slice **11r-j**: a nightly phase testing the shape that DOES work (append-at-end + `#[default(...)]`), plus the Rust-side comment-hygiene guards for `abilities`/`npcs` and block comments, and a limiter for the unbounded `quest_defs_load_error` log site. Gates: 75/75 evals, 1556 Rust tests, 1852 client tests, full `just ci` exit 0. ADR next-free = 0174.

**12r-b** (PLAYTEST.md control-table reconciliation) complete, `M-postgate-twelfth-review-residuals`; docs + one new gate, no production code. `docs/PLAYTEST.md` claimed at `:40` to be "kept in sync" with `client/src/ui/helpModel.ts`'s `CONTROLS` SSOT and was not: it documented `H` (heal) and `G` (shop) — both deleted by uxd2/ADR-0161, with no `KeyG`/`KeyH` branch anywhere in `main.ts` — omitted `M` (the two-level main menu, ADR-0162) entirely, described `T` as "Talk to a nearby NPC" rather than the interact key that also reaches shop and heal, and told testers at §4 step 7 to "Shop (`G`) and heal (`H`) in town." A tester following it literally pressed two dead keys for two core loops and never learned the menu key existed. The table body is now GENERATED from `CONTROLS` (so the `T` action's U+2014 em dash is copied, not retyped) and step 7 routes both loops through `T`. **The durable output is the gate, not the edit** — `pt-c2b` explicitly chose a hand-written table with no generator (`docs/specs/pt-c2b-plan.md:116`), and this is the drift that decision produced, so the fix is a real check: `client/src/ui/playtestControlsDoc.test.ts` (24 tests) parses the live doc and compares it against `buildHelpViewModel()`, asserting bidirectional key set-equality (EARS E1), **exact** action-text equality, row-count-equals-`CONTROLS`-length plus no duplicate keys, and a whole-document single-character inline-code-span whitelist derived from `CONTROLS`. Four of those five shapes exist because an adversarial pass PoC'd a false green against the previous one: `.includes` containment let a row append "(also try `G` for shop)" and stay green; a stray `|` in a cell silently truncated the row instead of throwing; a table-only check was blind to the §4 PROSE, which is where the original bug actually lived; and a decoy `| Key | Action |` table — first placed after the section anchor, later hidden by wrapping the REAL section in a stray ``` fence — bound the parser to the wrong table and scored a verified 22/22 GREEN while the tester-visible doc carried the full original bug. The parser therefore fail-louds on every ambiguity it can detect (missing section/header, a second header after the anchor, a duplicated `## 3. Controls` in the RAW pre-fence-strip text, a malformed or pipe-less separator, any row that is not exactly 2 cells) rather than ever returning `[]`, because a vacuous parse is how a doc gate dies silently. Row ORDER is deliberately not gated (E1 is set semantics; the doc's teaching order groups the trade keys). Disclosed residuals, recorded in the test's own comments: non-backticked prose ("press G to shop"), multi-character spans (`` `G/H` ``) and bold non-code mentions (`**G**`) are all invisible to the span scan — closing them collides with the doc's legitimate `F8`/`F9`/`WASD`/`spacetime` spans; `docs/playtest-ops.md` is unscanned (it carries no key claims today); and `F8` is a live key deliberately absent from `CONTROLS`, so the scan is single-character-only by design. Because the gate asserts EXACT action text, the queued micro-slice that fixes `helpModel.ts:35`'s stale "fuse" copy must now update the doc's `E` row in the same commit — the gate working as intended. Gates: 24/24 gating (all 8 proof-of-teeth independently re-derived by the verifier), 1999 client tests, 1590 Rust tests, all evals PASS, full `just ci` exit 0. No ADR (none assigned). ADR next-free = 0178.

**M21c** (accounts/auth eval gates — ADR-0179 G1/G2/G3/G4/G5/G6/G8/G9/G10/G11/G12) complete, `M21-accounts-auth`; **tests and gates only — zero production change** (M21a shipped the code at PR #298). Two new evals — `evals/account-privacy.eval.mjs` (G1 + G12) and `evals/guest-claim-integrity.eval.mjs` (G2–G6, G11) — plus extensions to `ranking-security.eval.mjs` (G8), `currency-integrity.eval.mjs` (G10) and `pvp_tests.rs::m17a_rl2_profile_never_deleted_scan` (G9). **The slice's value is in what adversarial passes proved was still open.** Three review lenses and two red-team passes each landed a patch that violated a real invariant while `just ci` stayed fully green, and every one is now closed by a clause with a live mutation proving it bites (31 total): a `my_account` decoy-line leak (`let _d = …find(ctx.sender); …find(victim)` — closed by an EXACT body pin); the raw JWT `iss` written to a reject log through `log_reject`'s **first** `&str` parameter, which `guards.rs:48-51` itself calls "an unenforced convention" (closed by constraining EVERY argument to a literal or named literal const, plus a claim-binding tracker that follows the observed binding name rather than a spelling — the shipped Rust twin's identifier list is rename-evadable); a struct-argument and an `Identity::from_hex` reducer, both unauthenticated code-less takeovers of any identity's monsters/inventory/wallet/profile (closed by enumerating reducers from source and pinning the NAME SET exactly — the Rust twin iterates a hardcoded five-name list and is blind to an ADDED reducer); `consume_claim_and_disarm(ctx, me)`, a one-token swap that deletes nothing and leaves the 64-hex claim code redeemable (closed by an argument pin); an always-true early `return Ok(())` making that same consume dead code while every POSITION-based clause passed (closed by `[S/reachable]`); an empty-`aud` short-circuit that inverts AUTH-3 (closed by pinning the guard shape exactly); `let db = &ctx.db;`, which hides the ENTIRE write-isolation family because `ReducerContext.db` is a public field (closed by `[W/db-binding]`, with `[W/ctx-binding]` closing the same escape one level up — a context parameter merely spelled `context` instead of `ctx` hid a foreign-table delete from the entire family); a UFCS `UniqueColumn::delete(&ctx.db.profile().identity(), id)` that puts the verb before the accessor and so evaded both this repo's Rust scan and its eval while deleting a permanent ladder record; and — the most valuable single finding — `let _audit = zeroed_wallet(row.clone()); …update(row);`, which preserved `rekey_wallet`'s ordering, presence and no-delete assertions while the guest kept its balance, letting ONE guest identity donate the SAME currency to unbounded fresh accounts (AUTH-14 is per-ACCOUNT, not per-GUEST). **Two systemic corrections underlie most of these.** First, the live tree is rustfmt-WRAPPED (`ctx.db\n.profile()\n.identity()\n.update(`), so every contiguous needle in the repo's older scans matched ZERO times — `ranking-security` C1a/C1b and the `pvp_tests` RL-2 scan were both walked past by this project's own formatting, and all needles now run against whitespace-compacted source. Second, a stripper that mishandles any Rust literal prefix **greens every ban clause and reds only presence clauses**, so a desync is invisible to the clauses it blinds; the shared `stripRustSource` lexes `r`/`br`/`b`/`c`/`cr` with arbitrary hash counts, char literals vs lifetimes, and nested block comments, and every live source additionally passes an `assertStripperSound` desync self-check whose own teeth inject deliberately broken strippers. G6's `REKEY_MANIFEST` transcribes ADR-0179 D6's 23 Identity columns and is bidirectional against the live schema, with the `account_has_game_data` exists-helper half being the one delegation nothing in the repo covered before; two of D6's `BLOCKED` justifications were **corrected** in the process (`battle.player_identity`/`opponent_identity` — `is_in_ongoing_battle` filters `Ongoing`, so terminal rows orphan; `battle_challenge.target` — only the challenger half is swept on disconnect), which matters because M22 consumes this manifest as its deletion-cascade SSOT. G9 replaces a hardcoded 13-file `include_str!` list — which had never covered `ranking.rs`, the file the invariant is actually about — with a recursive `read_dir` derivation guarded by a basename anchor set rather than a zero-headroom count floor. Deliberately NOT re-implemented, with owners named in-file: the tree-wide `ViewContext::new(` ban and hidden-view counts (`wallet-privacy.eval.mjs`), `format!`-in-`log_reject` and the `rekey_profile` update-count pins (`accounts_tests.rs`/`ranking_tests.rs`), and any doc-tie parsing D6's markdown (fails on a reword, passes on a wrong manifest). Named residuals: `evolution_tests.rs`'s hardcoded `scheduled_scan_sources()` omits `accounts.rs`; the Rust twins' reducer/identifier lists should be brought to parity with the JS gates; three older evals still strip `//` before string literals; and the two new evals carry ~420 duplicated scanner lines whose `splitArgs` copies have already diverged, indicating a shared `evals/rust-scan.mjs`. Gates: 80/80 evals, 1662 Rust tests (workspace), 2018 client tests, full `just ci` exit 0. No ADR consumed (0179 body-only amendments). ADR next-free = 0180.

**m20b** (self-hosted observability stack config — ADR-0180 amendment) complete, `M20-observability-performance`; **ops configuration only — zero game code, zero reducers, zero schema, nothing wired into `just ci`**. `ops/observability/**` stands up the 7-container stack (Prometheus, Alloy, Loki, Tempo, Grafana OSS, node_exporter, Caddy) plus `docs/observability-dr-runbook.md`; see `ops/observability/README.md` for topology and the OBS-*→file map. **Three design corrections were forced during the build and are recorded in ADR-0180's m20b amendment, not just in code.** (1) A bridge network is unusable: a container's `127.0.0.1` is itself, so a bridge-networked Prometheus cannot scrape a loopback-bound SpacetimeDB, and both bridge-preserving repairs require SpacetimeDB to bind a non-loopback address — reopening `/v1/metrics`'s confirmed-permanent unauthenticated gap. The stack therefore runs `network_mode: host` with every service's own listen flag bound to `127.0.0.1`, which makes each flag the security boundary (omission FAILS the gate, because every upstream default is `0.0.0.0`) and reduces OQ1 containment to a single variable, `MR_CADDY_BIND_ADDR`. (2) D12/OBS-36 bounded only S2's `stage.metrics` labels; the S4 browser-OTLP path is public and unauthenticated by design and converts caller-chosen attributes 1:1 into Prometheus labels, so it gained an allowlist — and, after a red-team pass proved a key-only allowlist still lets an allowed-but-caller-supplied `zone_id` mint one series per request, an OTTL value-space bound as well. (3) `up{job="alloy"}` is process liveness, not pipeline health: Alloy hosts independent internal components, so a stalled file tail leaves `up=1` while ingestion is dark — OBS-39's rule ships alongside a companion `AlloyIngestStalled` rule on actual tail throughput. **OQ1 is answered, not guessed** (`M-playtest-a-deployment.spec.md` fixes deployment as local-only), and D17(2)'s explicitly-UNVERIFIED correlation-pivot spike resolved to **Grafana Correlations, not Loki derived fields** — derived fields are one-way and Loki-source-only and structurally cannot express the Tempo→Loki leg; Correlations are file-provisionable in OSS as a nested `correlations:` list under the source datasource. The gate is `ops/observability/checks/stack-config-checks.mjs`, 18 pure text predicates written as an importable library precisely so m20e's `evals/observability-stack-config.eval.mjs` (G6/G9) wires it rather than re-implements it, with 103 EARS-derived tests authored by a separate tester plus 13 regression tests for red-team bypasses that were **executed, not hypothesised** — a quoted service key (`"mr-evil-relay":`) hid an entire rogue service, its unbound listener, and a shell-exfil `entrypoint` from four gates at once while `docker compose config --services` listed all eight, so the compose parser now fails CLOSED on any line it cannot read exactly; a trailing `//` decoy comment satisfied a substring wiring check while the receiver forwarded metrics unfiltered; a decoy `rate_limit` zone laundered a real unlimited one; and `checkNoQuotedCredential` was case-sensitive and lacked `hash`, making the bcrypt credential this design centres on invisible. Tier-2 `validate.mjs` runs each config through its own upstream validator via the pinned image (8/8) — which is how Tempo was caught: **3.0.x restructured `app.Config` and drops the top-level `compactor` key D11's `block_retention` needs**, so Tempo alone is pinned to the 2.x LTS track. `mr-trace-relay` (D15/D17) and its scrape job and dead-man's-switch rule are deliberately deferred to **m20b-2**: its only input is `mr_log` `phase` breadcrumbs, and OBS-41 currently has **no implementing slice** — m20a's `touches:` covers the envelope fields but no domain-reducer file, and no §4 checkbox assigns the paired call sites. Gates: 116 slice tests, 8/8 tier-2 validators, 80/80 evals, 2032 client tests, Semgrep 0 findings, full `just ci` exit 0. ADR next-free = 0181.


**m20c** (client real OTel Web SDK wiring — ADR-0180 amendment) complete, `M20-observability-performance`; **client-only — zero reducers, zero schema, zero bindings drift**. `client/src/observability/` (8 modules, functional-core/imperative-shell: `names`/`deviceClass`/`attributes`/`config`/`frameWindow`/`interpGap`/`instruments` pure and host-blind, `telemetry.ts` the one impure shell with an injected SDK loader whose production default dynamic-imports `@opentelemetry/*` as a lazy chunk) + eight additive, marker-bounded main.ts hooks (wasm-ready mark, module-scope config resolve, fire-and-forget init, reconcile attempt/correction counters, dropped-intent counter, enqueueMove RTT `.then` ahead of the rejection `.catch` and self-guarded so a telemetry fault can never run `dropRejected` on an accepted move, the 1s frame-window tick with an AM14 tab-suspend discard, and zone re-stamping on the switchZone commit path). The S4 wire contract is mirrored ONCE client-side (`names.ts` = `config.alloy:155-158`'s exact grammars; invalid values OMIT their key, never coerced — what leaves the browser is the OBS-34/35 criterion); the fps histogram lands verbatim as `mr_client_fps_bucket` for the OBS-25 p50≥55 recording rule (unit-free naming discharges the Alloy suffix risk); resource attributes are pinned to exactly `{service.name}` (the per-page-load `instance`-label series-mint door the datapoint allowlist cannot see); no request headers of any kind ride the export (OBS-16 — the ingest is public by design and CORS allows only content-type); export cadence is clamped [15s,300s] + upward-only ×(1+0.1·rand) jitter, worst case 24 req/min/tab incl. the exporter's non-configurable 5-retry burst = 5× headroom under Caddy's 120/min/IP, asserted as arithmetic. Telemetry is OFF by default (`VITE_MR_OTLP_ENDPOINT` unset ⇒ the SDK chunk is never even fetched) and fail-silent everywhere — `tls internal` means exports fail until the operator trusts the local CA, and the game must not care. Gating: 103 EARS-derived unit/property tests + 23 source-scan wiring teeth in `main.wiring.test.ts`'s append-only m20c block (with its own string-literal-aware comment scanner + self-test, after a red-team pass PROVED the file's older stripper is blinded by an unclosed `/*` inside any string literal — older teeth unfixed, out of the append-only reach, flagged in ADR-0180's m20c amendment); 12 orchestrator-fired mutation bite-proofs all RED. PromQL contract for m20e: divergence rate = `rate(mr_client_reconcile_correction)/rate(mr_client_reconcile)`; `mr_client_intent_reject` is a deliberate third counter beyond the six spec-named signals. Live compose-stack smoke deferred to post-integration per the slice brief. ADR next-free = 0181.

**m20e** (evals tail + mr-trace-relay pure core — ADR-0180 amendment) complete, `M20-observability-performance`; **evals/tests/ops only — zero reducers, zero schema, zero bindings drift**. `ops/observability/relay/` ships the relay's functional core (`parse`/`pair`/`otlp`/`reconstruct`, pure, node-stdlib-only, no clock/RNG/fs) + a stdout-only batch CLI + the committed `trace-pair-set.json` (membership ∅ — OBS-41 vacuously satisfied; the integration half — compose service, scrape job, alert rule, `/health`, tail daemon — is parked as **m20e-2**, formerly m20b-2, with the relay-code-in-m20b placement sentence of ADR-0180 explicitly superseded). `evals/observability-stack-config.eval.mjs` activates m20b's 18-predicate checks library in `just ci` (C1–C18) and adds G9a–G9k: trace-to-logs/correlation-pivot presence, the 4-stage fail-loud `$trace_pair_set` read, banned-membership vs the PARSED `$slo_set` + criterion bench ids, exact set-equality against a function-body-scoped scan for paired `phase` breadcrumbs (independently mirrored in Rust in `observability_tests.rs` off the same two-layer golden fixture `relay/fixtures/breadcrumb-golden.json`, whose host envelope is live-captured), a park tripwire (G9g — reds the moment m20e-2's files land without enabling the four parked assertions P1–P4), a supersession tripwire (G9h — reds at first membership until A10/G7 are retired), relay hygiene/credential/write-API bans (G9i/G9j), and a `node --test` spawn of all six suites with a mechanically-derived 181-test floor (G9k). G5's third metrics-contract assertion landed (delta-around-injection against live Alloy; recorded live: 0→5 in 8 s). G11/OBS-51 recorded as an honest null A/B (∅ membership ⇒ no toggle): |Δp95| 0.028 ms noise floor at 50 clients × move-rate 100, both runs `not_reached` — the benchmark for the first real membership A/B. First real boot of the m20b stack surfaced four committed-config defects (tempo flag, alloy volume perms, caddy file-capability, grafana alert interval) — recorded in ADR-0180's m20e amendment, fixes assigned to m20e-2. ADR next-free = 0181.

**13r-b** (`mr-trace-relay` integration — ADR-0191, amends ADR-0180) complete, `M-postgate thirteenth-review residuals`; **ops/evals only — zero reducers, zero schema, zero client change**. The m20e-2 park (OBS-45/OBS-46) is discharged: `ops/observability/relay/` gains `tail.mjs` (a pure tail state machine — half-open ranges, identity-beats-size precedence over `{dev, ino, 64-byte head sample, birthtimeMs}`, carry dropped on every restart so an old file's partial line cannot splice onto a new file's head) and `daemon.mjs` (the imperative shell: injected fs/timer/stdout/stderr seams, a three-flag allowlist parser, and a `/health` route set of exactly one key), and `docker-compose.yml` gains the **8th service** alongside its `prometheus.yml` scrape job and a distinct `TraceRelayDown` Grafana rule — all three in ONE change, because `checkListenAddrsLoopback` fails closed (`checks/stack-config-checks.mjs:494-499`) and an 8th service therefore structurally cannot exist without a listening process, while a target with no process pins `up=0` forever. `/health` serves a real label-free exposition body (`mr_trace_relay_lines_read_total` + a last-read gauge), not an empty one: verified against `prom/prometheus:v3.13.2`, both a 200 carrying `ok` **and** a `204 No Content` scrape to `up=0` and would invert the dead-man's switch — and the counter is what makes a silently stalled tail (the failure a wrong host-side mount mode produces) visible, discharging ADR-0180 Correction 3's residual for this service. The service runs the node image as **uid 473** (Alloy's own, so the host-side `r-x` precondition on `${MR_SPACETIME_DATA_DIR}/replicas` stays one fact about one identity), mounts Alloy's byte-identical replicas **source** at container target `/data/module-logs` (a target containing `replicas` would be read as a writable mount by `checkModuleLogsMountReadOnly`'s whole-file line scan via the `--logs-dir` command item), and its `command:` begins `node` (the node-image entrypoint parses a leading `--flag` as a node option and the container dies). **Shipped posture, stated rather than implied:** the daemon prints its OTLP/HTTP JSON document to **stdout and nothing ingests it** — the OTLP POST client is deferred and parked as P5 with a live tripwire (G9j bans egress flatly in `daemon.mjs`, so the first POST reds the gate) — and `$trace_pair_set` is still **∅**, so that document is empty regardless of sink; OBS-41 remains unowned. Stated gaps, decisions not oversights: no offset checkpoint (OBS-45 forbids writes), so files present at boot seek to EOF and breadcrumbs written while the relay was down are never exported; bytes appended to a rotated file between polls live in `*.log.1` and are lost. Gates: G9n (relay `volumes:` sub-block + injection-surface allowlist — closing C5's `found === 0` vacuity floor, which cannot prove the relay has a mount at all), G9o (scrape job resolved inside `scrape_configs:`, port cross-resolved from the relay's own scoped compose block — a file-wide search returns prometheus's 9090), G9p (the switch asserted as something that can FIRE: threshold node, evaluator direction, params, datasource, severity and `for:` all DERIVED from AlloyDown in the same document, not re-spelled); T-a inverted, T-m/T-n/T-o/T-p added as executed cheats, G9g deleted rather than polarity-flipped; three mutation bite-proofs against the REAL config (mount `:ro`→`:rw`, port mismatch, evaluator `lt`→`gt`) each red with a precise message; `NODE_TEST_PASS_FLOOR` re-derived 181 → 243. ADR next-free = 0192.

**lp-05** (Tier-2 observability validator wired into the gate — ADR-0201) complete, `M-loop-infrastructure`; **ops/CI wiring only — zero reducers, zero schema, zero client change, zero game code**. `ops/observability/validate.mjs` had **zero programmatic callers** at `064e627`: the only references in the repo were its own usage comment at `:12` and three lines in `ops/observability/README.md`, and neither the `justfile` nor `.github/workflows/ci.yml` contained the string `observability` at all. It is now a `ci:` dep invoked as `just observability-validate` → `node ops/observability/validate.mjs --require-docker`, with the matching exact step in ci.yml's `ci:` job. **This supersedes the m20b entry's "nothing wired into `just ci`" above** — Tier 2 now runs in the gate alongside Tier 1, and `just ci` consequently requires docker. The `ci:`-dep form is load-bearing rather than cosmetic: `justfileCiDepsAppearInCi` then *requires* the exact `- run: just observability-validate` step, which is the only free wiring enforcement available, and it fires from three independent points (lefthook pre-commit, `just eval`, and the standalone anchor step in the `e2e:` job). A recipe-body line was the original design and was **rejected by measurement** — applying the whole slice to a copy of the tree and deleting all three wiring lines left `ci-gate-wiring`, `build-ci-hygiene`, `gate-teeth`, `gate-hardening-config` and `observability-stack-config` all PASS. **The slice's real content is the anti-cheat hardening, not the wiring.** A red-team pass wrote three cheating validators that each scored **47/47** against the first tooth suite: one replaced every check with `docker version --format '<literal containing the digest and config path>'`, one shipped phantom `status:'pass'` results for six deleted checks, and one kept all eight checks but mounted a `mkdtempSync` stub tree at `/work` instead of the committed config directory — byte-identical argv except the mount source. The hardened suite (62 tests) kills all three: mount SOURCE must resolve to the real `ops/observability` dir; the compose check names `docker-compose.yml` by **absolute** path (cwd is invisible to an argv recorder, and this also closes a `COMPOSE_FILE=harmless.yml` bypass); invocation SHAPE permits exactly one `version` probe and otherwise only `run`/`compose`/`build`; a **runtime** status allowlist parsed off stdout forces `main()` through `summarize()` (a correct-but-dead exported `summarize` no longer helps); the validator's own report line carries a check-count floor; and the entry guard is proved **behaviourally** — importing the module must invoke docker zero times. `summarize()` is fail-closed in three directions (status allowlist, any skip under `--require-docker`, and a non-vacuity floor), because the original blacklist let `'Skipped'`, `'SKIPPED'`, `'skip'`, `'failed'`, `'error'` and `undefined` all exit **0** — and the printer's `.toUpperCase()` meant the log read `validate SKIPPED:` while the process exited 0. Entry guard is `isEntryPoint()` with a `realpathSync` fallback, not bare `import.meta.main`: that property needs Node ≥ 24.2 and this box's default `node` is 18.19.1, under which the guard is `undefined` and `main()` silently never runs. `test:` gained a fail-closed `node --test` wrapper (both `ℹ` and `#` reporter spellings, unparsed count fatal, pass floor 62) because `node --test` exits **0** on a zero-test file, a 0-byte file, an all-`skip` file, and on a failing test followed by a top-level `process.exit(0)` — all four measured and all four now RED. Gates: 62 slice tests, 8/8 tier-2 validators (4.1s warm), full `just ci` exit 0; drills — a malformed `docker-compose.yml` REDs the wired path with `yaml: line 269: could not find expected ':'`, and on a genuinely docker-less runner `--require-docker` exits 1 with no `SKIPPED` line while the bare call exits 0 loudly; six mutation bite-proofs (delete the ci.yml step → 3 suite fails **and** `ci-gate-wiring` FAIL; `|| true` on the body; drop the dep; `--require-docker` made a no-op; `continue-on-error: ${{ success() }}`; the four vacuous `node --test` shapes) each RED. Known flake class, disclosed: `run()` cannot distinguish a Docker Hub rate limit from a config error, so a registry hiccup reds a merge-blocking check. ADR next-free = 0202.

**lp-doc-a** (obsolete residual prose corrected — ADR-0202) complete, `M-loop-infrastructure`; **`docs/adr/` plus this file — zero code, zero schema, zero gate logic.** Three residual ids the corpus still described as outstanding are now dispositioned in place, **per item rather than as a unit**, because a closure that hides a remainder is the same defect in a new coat. `m20b-2`/`m20e-2` is **PARTLY CLOSED** by 13r-b (`7bba44e`, ADR-0191) and the id itself **RETIRED**: the park enumerated six artifacts (seven eval-numbered rows, because P1 the service and P2 its mount are counted separately) and exactly one is outstanding, but the OTLP POST client alone is re-parked as **P5** under a new id with `G9h` as its mechanized un-defer trigger — **this supersedes the m20b entry's "deliberately deferred to m20b-2" and the m20e entry's "parked as m20e-2" above**. The same m20e entry's *"fixes assigned to m20e-2"* for the four first-boot config defects is likewise superseded: the owner is **13r-a** (`1d68c33`, ADR-0190), three are fixed, and tempo's undefined flag (D1) plus a fifth defect discovered by D3 — caddy's port-80 redirect bind (D3b) — are still open (D1 catalogued but uncommitted as `S23-obs-parks`; D3b in no spec at all). `nh5` is **CLOSED** by 13r-f (`7e08d36`, ADR-0192), with the inversion it causes named (a hold-through-warp e2e is no longer vacuous) and its four unowned follow-ups carried forward rather than absorbed; the three *conditional* "a future nh5 change must revisit this" sites (ADR-0152 residual #1, ADR-0152's reconnect invariant, ADR-0085's demarcation) are marked `STILL OPEN` with the outcome of the revisit, never closed — retention landed on the warp arm only and `held.clear()` stays load-bearing. `11r-e-1`/`-3`/`-9` are **RETIRED as a false lead**: they are the EARS acceptance ids of shipped slice 11r-e (ADR-0169), each live-tested, and the recorded reason is an EARS-id/residual-id **namespace collision** — noted in ADR-0169 itself so a reader at the definition site learns it. `14r-f-2` is **STILL OPEN and ownerless**: the id-rebind blind spot is re-verified real (the species/item/skill baselines are still flat id arrays), and the slice ADR-0188 defers to was never created — the id is carried only as an untriaged residual, with no spec assigning it an owner — so it is escalated rather than given a fictional one. ADR-0186's *"EXPECTED to be RED"* consequence is rewritten in place (the criterion forbids the sentence existing, not merely being disputed) and the replacement refuses the opposite error: the gate is green at `18 gated / 10 migrated / 7 debt / 1 not-applicable` **because** seven evals are named as cap-bounded debt, two of them live needle-swallowers. **Every disposition this slice recorded uses one greppable form** — `**[CLOSED | PARTLY CLOSED | STILL OPEN | RETIRED … ; recorded by ADR-0202]**`, all four states populated — chosen so `grep -rnE` over `docs/adr/` returns them as the seeding shape a residual registry would need (with one pre-existing non-conforming mark in ADR-0175 also caught, noted in the ADR). **The honest limit, stated in the ADR:** the digest gate renders only header preambles, so no standing gate reads the body of any ADR edited here — it cannot tell a true annotation from a false one, or from a deletion. (Scoped deliberately: `playtest-verify` and `nightly-smoke-wiring` DO needle ADR bodies, just not these six.) The EARS evidence is prose review plus one verifier-run base-relative diff check, which confirms every removed line is the pre-image of its own end-of-line append outside the one declared ADR-0186 rewrite and the three ADR-0190 citation digits. A mechanical tooth for the expected-RED criterion is cheap in principle and was **not taken**; the ADR records both its right home (`evals/spec-gap-revival.eval.mjs`, already the stale-blocker tripwire pattern and off the serialized migration surface) and the two ways a naive grep for it self-reds. Also repaired, as Boy Scout cleanup at the hunk cap: three ADR-0190 citations that pointed at blank lines in ADR-0180. Gates: `just adr-digest-check` RED before regeneration with `DIGEST.md is stale` and GREEN after, full `just ci` exit 0; tolerated back-link gaps unmoved at 5/44. ADR next-free = 0203.

**m22-s1** (M22 privacy/compliance **S1**, the game-core deletion contract surface — spec `M22-privacy-compliance.spec.md` §4.3/§4.5/§4.7/§5/§8.1, governed by harness ADR-0031; **no new project ADR**) complete; **pure `game-core` only — zero schema, zero reducers, zero client, zero evals.** A new top-level module `game-core/src/accounts/` (first entry in `lib.rs`'s module list and re-export run) holds `deletion.rs`: `DELETION_GRACE_MS_DEFAULT`, `is_deletion_due(Option<i64>, i64) -> bool`, `TOMBSTONE_IDENTITY_BYTES`, `TOMBSTONE_AUTH_ISSUER`, `EXPORT_CHUNK_ROWS` and `STATE_TRANSITION_OWNERS` — the six values S2–S8 consume, written once here rather than in each shell. Placement mirrors `CHALLENGE_TTL_MS`/`is_challenge_stale` (`game-core/src/combat/pvp.rs:100-110`, ADR-0126 D2); the `Option<i64>` parameter is the real column type, and `None => false` is load-bearing because PRV1-3 *clears* `deletion_requested_at_ms` on cancel, making `None` the cancelled state. **The grace number is not an engineering default:** spec §8.1 escalation #1 is UNRESOLVED, so 7 days ships as an explicitly arbitrary placeholder with an honest basis comment and no borrowed figure. **`TOMBSTONE_IDENTITY_BYTES` is `[u8; 32]`, not an `Identity`** — `game-core` carries no `spacetimedb` dependency and `client-wasm` depends on it *without* the feature, so raw bytes plus a derivation instruction is the only shape that keeps the constant single-sourced; S3 derives `Identity::from_byte_array(game_core::TOMBSTONE_IDENTITY_BYTES)` in `server-module/src/lib.rs` beside `WILD_IDENTITY` (`:84`), never in `accounts.rs`, whose `[R/identity-ctor]` clause bans that constructor.

## M23 — Accessibility (S0 the substrate, S2 the static shells — ADR-0205)

**m23-s0** complete, `M23-accessibility`; **pure client chrome — zero reducers, zero schema, zero predictor/renderer surface, and zero consumers (every reader is S1+).** `ui/overlayRegistry.ts` gains `A11yMeta` and a total `OVERLAY_A11Y: Readonly<Record<OverlayId, A11yMeta>>` beside `OVERLAY_TIERS` — the same anti-drift device, so a seventeenth overlay is a COMPILE error in the a11y table exactly as it already is in the tier table, the probe table and the handle table. Each entry carries `role` (a CLOSED `'dialog' | 'alertdialog'` union, which is what makes `role="presentation"` a compile error rather than something a presence scan waves through; all sixteen are `dialog` today), `labelKey` (a catalog KEY, never a literal — the M24/ADR-0033 seam), `initialFocusSelector` (a stable **constructor-time** `#id`/`[data-testid]` anchor, never a render-time control: `battleView` `replaceChildren()`s its skills and action rows every server tick, so focusing one would be incorrect, not merely brittle) and `dismissible`. New `ui/a11yCopy.ts` holds the flat `Object.freeze`d `Record<string,string>` catalog plus `t(key)`, which **throws** naming the key on a miss — returning the key would announce `a11y.overlay.boxView.title` to a screen-reader user and make an unwired catalog look wired, and returning `''` would ship an unlabelled dialog. The `a11y.overlay.*` orphan check is namespace-SCOPED and derived from `OVERLAY_IDS`, deliberately not global: S1 lands `a11y.world.*`/`a11y.announce.*` immediately, and a global check would force a later slice to weaken an S0 gate — proved executably by a must-stay-green bite-proof, not by prose. **A11Y-1/A11Y-2 are gated by a real NEGATIVE COMPILE, not the house textual declaration pin:** red-team measured that a `Partial<>` spelling plus a planted decoy string constant holding the byte-exact expected declaration left both `tsc --noEmit` and the pin green, a bypass structural to any pure-text pin, so the tests instead spawn `tsc --noEmit` on generated probe modules and assert the polarity of the compiler's verdict (two must compile, two must not). Gates: 31 co-located tests, 28 mutation bite-proofs red and 2 must-stay-green, full `just ci` exit 0. **Two spec amendments recorded in ADR-0205 and flagged for sign-off:** §2.1's "natively focusable" is relaxed to "focusable, natively or via `tabindex`" (seven of sixteen ids have nothing natively focusable and the alternative is S2 shipping four dead controls), and §5.1's `[A11Y-02]` regex is case-permitted and segment-non-empty (the spec's own `/^a11y\.[a-z0-9.]+$/` rejects the canonical key §2.8 itself gives and accepts `a11y..`). ADR next-free = 0206.

**m23-s1** complete, `M23-accessibility`; **pure client chrome — zero reducers, zero schema, zero predictor/renderer surface**, and (like s0) zero production consumers: every reader is S3/S4/S5. Four new modules under `client/src/ui/`. `focusTrap.ts` is a pure `nextFocusTarget(focusables, current, shift)` plus a thin `installTrap(root)` shell; the trap registers in the **CAPTURE** phase, and that is load-bearing rather than stylistic — `renameView.ts:62,:81` and `tradeProposeView.ts` `stopPropagation()` their focusables' keydown, so a bubble-phase root listener is 100% dead in exactly the two overlays with real text input. It recomputes the focusable set on **every** keydown (`battleView.ts:241,:270` `replaceChildren()` every server tick, so a cached NodeList points at dead nodes within one frame), `preventDefault`s **only** plain Tab / plain Shift+Tab and only when focus actually moves, exempts Ctrl/Alt/Meta+Tab as browser-and-OS chrome, and **never** `stopPropagation`s — `main.ts:1052`'s window ladder (session gate, F8/F9, the fourteen-branch Escape ladder) must keep receiving every key. `tabindex="-1"` anchors are OUTSIDE the tab ring on purpose while remaining the `initialFocusSelector` target (the ARIA APG dialog pattern). `nextFocusTarget` returns `HTMLElement | null` — an amendment to spec §2.2's `HTMLElement`, because `noUncheckedIndexedAccess` is OFF (`client/tsconfig.json`) so `focusables[0]` is a runtime-`undefined` trap — and it branches EXPLICITLY on `indexOf === -1`; the "elegant" modular-arithmetic single formula is banned and gate-pinned, since it is measured to return `focusables[1]` instead of `last` for a not-in-list `current` with `shift=true`. `liveRegion.ts` is a trailing-edge 500 ms coalescer whose **only** DOM write is `node.textContent = msg` and which holds **no clock at all** — `nowMs` arrives per call, one step beyond the house injected-clock idiom (`main.ts:696-697`) — resolving `#a11y-live` fresh on every write and caching neither a null nor a non-null node, so it is inert-but-correct until S2 ships that element. Its dedup compares against `pending ?? lastWritten`, **not** `lastWritten` alone: the latter was measured to drop a legitimate re-announcement forever. Trailing edge (not leading) is required verbatim by A11Y-9; the resulting ≤500 ms latency on a lone announcement is a spec-mandated consequence flagged to M23's owner, not silently redesigned. `announcements.ts` is a 100%-pure `announcementsFor(prev, next)` over `{topOverlay, message}`, resolving overlay names through `t(OVERLAY_A11Y[id].labelKey)` and never a literal; its purity is enforced **mechanically** — its spec deliberately carries no `@vitest-environment` line, so it runs under node where any `document`/`window` reference throws. `overlayA11y.ts` is the SOLE owner of the deferred `setTimeout(…, 0)` focus (the drop-in for `renameView.ts:102` / `tradeProposeView.ts:124`, which S3 deletes, and what keeps A11Y-15's future ban on a literal `.focus(` in any `*View.ts` satisfiable); it keeps ONE record per id (`{root, returnFocus, timer, uninstall}`) so there is never a half-state, preserves the ORIGINAL return target across a re-open, and treats close-without-open and double-close as true no-ops. Gates: 47 co-located tests, 14/14 acceptance gates met with recorded evidence, full `just ci` exit 0 (87 client files / 2532 tests, 90 evals PASS / 0 FAIL). **Red-team wrote and ran the cheats and found four green-but-wrong implementations, all now bitten**: the focusable selector gutted to `button:not([disabled])` (no fixture anywhere used an `<input>`/`<textarea>`/`a[href]`/`[tabindex]`, while `#rename-input` and tradePropose's currency inputs are real production focusables), the `:not([tabindex="-1"])` clause dropped, and `announcementsFor` returning a shared in-place-mutated array — each survived all 42 original tests. The fourth, a hardcoded `role='dialog'`, **cannot** be bitten today: all sixteen registry entries are `dialog`, so the 16-way parameterisation has zero variance on that field; a TRIPWIRE test reds the day an overlay earns `alertdialog`, and the partial tooth is recorded at the call site rather than overclaimed. **Declared gaps:** of spec §2.4's four announcement transitions only (1) "overlay opened" is resolvable by S1 — (2) world-region, (3) battle outcome and (4) prompt/zone all need NEW `a11yCopy.ts` entries, and `a11yCopy.ts` is in **no** slice's `touches:` after S0, which also makes A11Y-22 unsatisfiable as sliced (escalated). Two cross-slice contracts S1 cannot self-enforce are named in the module headers: the four `#app`-mounted overlays share ONE root, so S4 must close-before-open or two capture traps stack; and `LiveRegion.flush(now)` must be pumped from S5's rAF loop or the region is permanently silent with nothing in S1-S4 reding. **No ADR authored** — the supervisor assigned no number and `docs/adr/**` is "reserved number only" under fan-out; the decisions ride in the module headers. ADR next-free = 0206.

**m23-s2** complete, `M23-accessibility` S2 — **the static shells, the live region, and the repo's
first stylesheet.** `client/index.html`'s eleven static overlay shells gain `role="dialog"` +
`aria-modal="true"` in the MARKUP (so the attribute is correct before S3's runtime path exists and no
`replaceChildren()` can un-set it), and the nine non-natively-focusable `initialFocusSelector` anchors
gain a `tabindex` — `0` on `#menu-rows`, `-1` on the other eight, and **none** on `#rename-input` /
`#tradepropose-target`, where a `-1` would REMOVE a native control from the tab order. The obligation
is DERIVED, never listed (ADR-0205 D1): the gate resolves each of the sixteen
`OVERLAY_A11Y[id].initialFocusSelector` against the real `index.html`, and the eleven that resolve ARE
the static shells — there is no hand-kept `OverlayId`→element-id map, which is why the irregular ids
(`pvpView`→`#pvp-challenge-overlay`) cannot drift. The gate reads `OVERLAY_A11Y[id].role` back
dynamically rather than asserting the literal `'dialog'`, which is the consumer read-back that
de-theatres S0's table one slice earlier than the constructed-side read-back.
`<div id="a11y-live" aria-live="polite" aria-atomic="true" class="sr-only">` is the LAST `<body>`
element: outside `#app`, outside every view root, inside no `replaceChildren()` subtree, so the
announcement binding cannot be destroyed by this codebase's authoritative-rebuild idiom. It carries no
inline `style` on purpose — one there enters `W-ONE-CORNER-AFFORDANCE`'s corner filter.
**`client/src/styles.css` is the repo's first and only stylesheet, and it is loaded by a
`<link rel="stylesheet" href="/src/styles.css">` in `<head>`, never by an `import` from a `.ts`** —
a durable constraint for every later slice that extends it (S9). It holds **class and `:root`
selectors ONLY, zero `#id` selectors**: `indexShell.test.ts` and `main.wiring.test.ts` pin
`#help-overlay`/`#help-hint`/`#build-stamp`'s inline positioning BY TEXT, so a rule reaching one of
those ids could silently satisfy or defeat those assertions without touching the markup they read.
Today it holds exactly one rule, `.sr-only`, hiding visually via `clip-path` while STAYING IN THE
ACCESSIBILITY TREE — `display:none`/`visibility:hidden` would remove the node entirely and make the
live region decorative. `:root` tokens and the `prefers-contrast` media query are deliberately absent:
S9 already owns this file and lands them beside the contrast work that consumes them. Gates: 10
co-located teeth appended to `indexShell.test.ts` (append-only, proven by a difflib opcode pass — zero
original lines changed), 13 mutation bite-proofs red and 1 must-stay-green, plus a hostile-CSS fixture
suite for the two scanners. ADR next-free = 0206 (no new ADR: ADR-0205 already carries this design).

**m23-s3** complete, `M23-accessibility` S3 — **the ten static-shell views wired to S1's helpers, in
TWO mechanisms, and the deferred `.focus()` deleted from the view layer.** Seven views delegate from
`show()`/`hide()`; the three with **no `show()`** (`dialogueView`, `questLogView`, `healView`) wire on
the `render(vm | null)` **null↔non-null EDGE** instead (spec §2.2, A11Y-34) — `main.ts:1574` calls
`dialogueView.render(vm)` unconditionally on every store batch, so there is literally nothing for a
`show()`-based design to attach to. **Both mechanisms detect the edge by reading the EXISTING `visible`
getter BEFORE the `display` write, never from a new nullity field**, and that is the load-bearing call:
`questLogView`/`healView` are opened by `render(vm)` but closed by `hide()`, so a `#lastVmWasNull`
field updated only inside `render()` never sees the hide and the SECOND open silently ships no role, no
label, no focus and no trap — while passing every single-cycle test (measured; the `-REOPEN-AFTER-HIDE`
tag is its falsifier). **The open guard is what makes delegation safe at all:** `pvpView.refresh()`
calls `show()` unconditionally and `main.ts:1697-1709` recomputes `forceVisible` every batch, so an
unguarded `openOverlayA11y` re-schedules the deferred focus several times a second and the overlay
becomes impossible to Tab through — `pvpView.ts`'s `show()` carries the canonical statement of this and
the other nine views point at it. **The close guards are deliberately ASYMMETRIC**: `render(null)` IS
guarded (A11Y-34 forbids invoking on a repeat render at the same nullity, and dialogue's null branch
fires every batch forever), while `hide()` is NOT — `closeOverlayA11y` is a documented no-op with no
open record, and leaving it unguarded is the self-healing path for a record that ever desynchronises
from the DOM, which a guard would strand permanently. `renameView.ts:102` and `tradeProposeView.ts:124`
lose their `setTimeout(() => …focus(), 0)` (and their now-false header bullets); `ui/overlayA11y.ts` is
the sole owner, which is what makes A11Y-15's ban on a literal `.focus(` in any `*View.ts` true rather
than aspirational. The `OverlayId` is an **inline literal** at each call site — the closed union makes
a typo a compile error, and a *drifted* id (open one overlay, close another) is caught by tests, not by
a const. Gates: 86 new co-located tests across ten specs (four new files: `dialogueView`,
`questLogView`, `healView`, `pvpView`), 9/9 acceptance gates met with recorded evidence, full `just ci`
exit 0 (91 client files / 2628 tests). **Red-team wrote 14 wrong implementations against the suite
before the real one existed and found three green-but-wrong holes, all now closed**: the `.focus(`
scan's CONTROL fixture miscounted its own planted occurrences, so the gate failed even on a CORRECT
implementation and never reached the real scan; `-CLOSE-UNGUARDED` covered only 4 of 10 views, so
guarding `hide()` on the other six shipped 62/62 green while permanently leaking a focus trap; and the
comment/string stripper was swallowed by a regex literal containing a quote, hiding a real duplicate
deferred `.focus(` in seven views (closed by diffing a comments-only strip against the full strip).
**Two residuals disclosed, not gated:** call ORDERING (open-last, D7) is provably ungated — an
open-first implementation measures 62/62 green, so S4 must carry that obligation in its own plan rather
than inherit it from this template; and `refresh()`/`toggle()` byte-identity is unenforced. **A latent
S1 gap flagged upward, out of `touches:`**: `openOverlayA11y` writes `role`/`aria-modal` BEFORE calling
`t(meta.labelKey)`, which throws by design on an unwired key — on a throw the DOM keeps both attributes
with no record stored, so the later close no-ops and can never strip them, contradicting that module's
own "no half-open state" claim. Unreachable today (all 16 catalog keys are pinned present). **No ADR
authored** — the supervisor assigned no number; the decisions ride in the module headers. ADR next-free
= 0206.
