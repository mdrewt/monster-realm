# Decisions

The design choices that constrain code in this repository today, and why. Each entry
says what was decided, why a reader could not easily re-derive it, and what it rules
out. `ARCHITECTURE.md` describes how the pieces fit; this file records the choices
behind them. When a decision changes, edit its entry in place — this is current
state, not a log.

## Rules are written once, in game-core

**Decision.** Every game rule lives in the `game-core` crate exactly once. The server
module calls it for truth; the browser runs the same compiled code through the thin
`wasm-bindgen` shell in `client-wasm` for prediction. Constants the client needs
(`step_ms`, `move_queue_cap`, `party_size`, `party_slot_none`, `talk_range`,
`max_trade_monsters_per_side`, `deletion_grace_ms_default`) and derived queries
(`evolution_eligibility`, `zone_map`) are wasm exports (`client-wasm/src/lib.rs`), not
TypeScript literals.

**Why.** A rule implemented twice drifts, and a drifted movement or battle rule is a
desync: the client predicts one outcome, the server commits another, and the player
sees rubber-banding. A hand-copied constant drifts the same way, only more quietly.

**Rules out.** Re-implementing a rule in TypeScript or in a reducer; copying a
game-core constant into client code. `client-wasm` depends on `game-core` without the
`spacetimedb` feature (`client-wasm/Cargo.toml`), so server-only code never reaches
the browser bundle.

## Determinism: integer math, injected time and randomness

**Decision.** `game-core` is pure and deterministic. `clippy.toml` bans wall-clock
reads (`SystemTime::now`, `Instant::now`, `chrono::{Utc,Local}::now`) and unseeded or
OS randomness (`rand::thread_rng`, `rand::random`, `rand::rng`, `getrandom`, `OsRng`,
`ThreadRng`) workspace-wide, and `just lint` runs clippy with `-D warnings`. Time comes
in as `Millis` (the server converts `ctx.timestamp` in `server-module/src/marshal.rs`
`now_ms`); randomness comes in as a seed (`ctx.random()` mapped through
`TurnVariance::from_ctx_random` in `game-core/src/combat/types.rs`). The release and
bench profiles set `overflow-checks = true` (root `Cargo.toml`).

**Why.** The same inputs must produce byte-identical output natively on the server and
in wasm on the client, and a replayed seed must reproduce a battle turn. A clock read
or an ambient RNG inside a rule makes that impossible, and an overflow that wraps
silently in release (but panics in tests) hides exactly the bugs tests exist to catch.

**Rules out.** Floats in rules, clock reads in rules, unseeded RNG anywhere in Rust. In
TypeScript the ban is not mechanical: client code may read `performance.now()` for
rendering and pacing, but it never feeds a rule decision the server would redo.

## Integer damage formula with a seeded variance roll

**Decision.** `calc_damage` (`game-core/src/combat/damage.rs`) is integer-only with
`u64` intermediates: `base = (2·level/5 + 2)·power·attack/defense/50 + 2`, then STAB
×3/2, type effectiveness ×{0,5,10,20}/10, a variance roll in `85..=100` /100, an
integer weather numerator/denominator, and a floor of 1 for any non-immune hit. The
five per-turn rolls come from one `ctx.random()` seed via `TurnVariance`.

**Why.** Balance tuning happens in content (species stats, skill power, the type
chart), so the formula itself has to be stable and bit-reproducible. Integers make it
identical on every target; the floor of 1 keeps a hit from ever doing nothing.

**Rules out.** Float math in combat; per-platform rounding; reading randomness inside
the resolver.

## Content is data compiled into game-core

**Decision.** Game content (species, skills, items, zones, maps, encounters, NPCs,
dialogue, quests, shops, abilities, heal locations, evolution paths, the type chart)
is RON under `game-core/content/`. `game-core/build.rs` embeds every `*.ron` file of
each registry directory in sorted filename order; `validate_content` checks it; a
content-invariant violation in the pure core is a panic. The server seeds the public
content tables in `sync_content` and skips re-seeding while the stored
`config.content_version` equals `CONTENT_VERSION` (`server-module/src/lib.rs`). The
`content-version` eval pins `CONTENT_VERSION` to a hash of every content file's bytes
(`evals/baselines/content-hash.json`), so any content edit — comments included —
needs a version bump. No content row table carries a `locale` column: content stays
locale-agnostic; localization lives in the client catalog (`client/src/ui/i18n/`).

**Why.** Content has to reach the client (prediction, maps) and the server (truth)
from one source with no runtime loading. Directory-per-registry files let content be
added without editing shared files. Without the version pin, edited content would
silently never reach a live database. Localized strings in content would turn every
translation fix into a `CONTENT_VERSION` bump and a server reseed, for text only the
client renders.

**Rules out.** Hard-coding content in Rust or TypeScript; loading content at runtime;
editing `game-core/content/` without bumping `CONTENT_VERSION` and regenerating the
baseline (the eval failure message prints the exact command); a locale column on
content rows; localized strings in RON content.

## Server authority: thin reducers in domain modules

**Decision.** The server module is split into domain modules (`server-module/src/`:
`accounts`, `battle`, `economy`, `evolution`, `movement`, `npc`, `pvp`, `privacy`,
`raising`, `ranking`, `taming`, `trading`, ...). A reducer validates the caller
(`ctx.sender()`) and the request, calls `game-core`, and writes tables. Checks shared
across modules live once in `guards.rs` (`require_owner`, `is_in_ongoing_battle`,
`require_not_deleting`, the battle-input validators). A module writes only its own
tables; cross-module writes go through the owning module's helper (for example
`accounts::rekey_all` delegates to `rekey_*` helpers in each owner).

**Why.** Reducers are the only writers and the only trust boundary. Keeping them thin
keeps every rule testable without a database, and keeping guards in one place stops
PvE and PvP paths from growing slightly different versions of the same check.

**Rules out.** Game rules inside reducers; a second copy of a guard; a module writing
another module's table directly.

## Reject, don't clamp

**Decision.** Invalid input is refused with `Err`, never silently corrected. Examples
in code: an over-cap move enqueue returns `Err("queue full")`; a stale input seq is
rejected in `guards::authorize_move`; an oversized party is rejected by
`check_party_size`, not truncated; `BattleSide::set_active` returns a typed
`SwapError`; `submit_attack` refuses an attack from a fainted active monster; a
shop purchase or trade that would push the receiver past `MAX_ITEM_STACK` or
`MAX_BALANCE` is rejected before anything moves (`check_item_headroom` /
`check_currency_headroom`). A rejected reducer rolls back its whole transaction.

**Why.** A clamped request succeeds with a result the caller did not ask for, and a
client predicting the unclamped version desyncs without any error to react to. An
`Err` is visible, logged (`guards::log_reject`), and leaves state untouched.

**Rules out.** Truncating lists, snapping values into range, or destroying overflow
at a cap.

## Table privacy: private tables plus owner-scoped views

**Decision.** Any table holding per-player state another player must not see is
private (no `public` in its `#[spacetimedb::table]`). Each owner reads their own rows
through a `#[spacetimedb::view]` whose body filters on `ctx.sender()`
(`server-module/src/schema.rs`): `my_monster_pub`, `my_inventory`, `my_wallet`,
`my_conversation`, `my_account`, `my_pending_evolution_notices`, `my_battle` (either
participant), and `my_export_bundle` (`privacy.rs`). Some tables have no client read
path at all: `monster` (IVs, EVs, nature), `encounter` (spawn weights), `battle_wild`
(the wild's individuality seed), `battle_action` (secret PvP picks), `heal_cooldown`,
`guest_claim`, `player_session`.

**Why.** Hidden stats, item stock, balances and a pending PvP pick are competitive
information. The view body is the entire boundary, so each view takes only the
context: an extra "owner" parameter would let a caller choose whose rows to read.

**Rules out.** Marking a per-player table `public`; a view that takes an identity
argument. Tables that are public on purpose: content, `character`, `player`,
`profile` (the leaderboard), `trade_offer` and `battle_challenge` (both parties need
them), and `player_quest`.

## Bounded client prediction

**Decision.** The client never predicts further ahead than the server would accept.
The `Predictor` (`client/src/prediction/predictor.ts`) refuses an enqueue past
`MOVE_QUEUE_CAP` (2, the game-core value) and applies backpressure at 16 unacknowledged
ops. It records queue *operations* (`Enqueue`/`SetMove`/`Clear`) rather than raw moves
and replays them onto the server's queue on reconcile. Each predictor carries a
generation id (`PredictorEpoch`), so a rejection addressed to a predictor discarded by
a warp or reconnect does nothing. A rebuilt predictor starts its sequence numbers
above the highest one already sent. Zone warps resolve only server-side, in
`movement_tick` (`server-module/src/movement.rs`); the client never predicts a zone
crossing. `skip_warp` there defaults `true` when the mover has no player row, so an NPC
never leaves its home zone.

**Why.** A client that runs ahead of authority has to pull the player back, which is
the rubber-band this architecture exists to prevent. Recording operations instead of
moves is what makes a mid-flight `SetMove` or `Clear` replay correctly. A warp changes
the map the predictor runs on, so only the server can resolve it; keeping every NPC in
its home zone keeps NPC movement local to one zone's map.

**Rules out.** Unbounded local queues; dropping unacknowledged ops to make room;
reusing a sequence number after a rebuild; predicting a zone crossing client-side; an
NPC crossing zones.

## Held keys: commit threshold and warp continuity

**Decision.** Movement is driven by virtual D-pad edges from the input router
(`client/src/input/router.ts`), refcounted across physical keys, so releasing ArrowUp
does not stop a held W. OS key-repeat drives neither movement nor menus (`e.repeat` is
ignored). A press sends one step immediately; continuation comes from the frame loop
re-issuing the held direction only after the key has been held for `HOLD_COMMIT_MS`
(150 ms, `client/src/prediction/heldKeys.ts`), only when the predictor has no
outstanding steps, and only while `movementEnabled` (the world base with no frame above
it and the session gate open). Every push of a non-base frame clears the held set, so a
direction held through a menu does not resume when the menu closes; the player presses
again. Menu auto-repeat is synthesized by the router on an injected clock (350 ms, then
100 ms) and clamps at list ends. A zone warp keeps the held-key stack across the
prediction reset; a reconnect does not.

**Why.** Key-repeat rates vary by OS and flood the server. The threshold separates a
tap (one tile) from a hold (walk), and waiting for outstanding steps to clear stops
the client from queueing moves faster than the server drains them. Keeping the stack
across a warp lets a player walk through a door without re-pressing the key. A walk
that resumes behind a closing menu is a step the player did not ask for, and stale hold
stamps would skip the commit threshold.

**Rules out.** Repeat-driven movement or menus; emitting continuation steps while
earlier ones are still in flight; resuming a held walk after a frame closes.

## Remote interpolation: adaptive delay, hold rather than extrapolate

**Decision.** Other characters render at `now − delay` between two buffered snapshots
(`client/src/render/interpolation.ts`). The delay adapts per character from a jitter
estimate (smoothing `INTERP_JITTER_ALPHA` = 0.125, up to `INTERP_MAX_DEPTH` = 4
snapshots, bounded between 0.5 and 2.5 steps in `client/src/render/config.ts`). An
arrival gap longer than three steps counts as idleness, not jitter
(`JITTER_IDLE_GAP_STEPS` in `client/src/net/store.ts`). At the newest snapshot the
entity holds position rather than extrapolating. The own character snaps instead of
sliding when the server correction is more than one tile away.

**Why.** Snapshots arrive in bursts. A fixed delay either pops under jitter or lags
all the time. Extrapolation guesses wrong and then corrects visibly. Treating a pause
as jitter would inflate the delay after every stop.

**Rules out.** Extrapolating remote entities; a single global interpolation delay.

## Integer pixel scaling

**Decision.** The renderer runs Pixi at `resolution = devicePixelRatio` with
`autoDensity`, and chooses an integer device scale (source pixels to device pixels) in
`client/src/render/viewport.ts` from the target visible tile count
(`TARGET_VISIBLE_TILES` 11, clamped to 7..16 in `client/src/render/config.ts`). The CSS
stage scale is that integer divided by `devicePixelRatio`, so it is fractional whenever
the ratio is not 1. When the map is smaller than the viewport, the camera centres it.

**Why.** Non-integer scaling blurs or shimmers pixel art.

**Rules out.** Fractional device scales; fitting the map by stretching.

## Evolution graph and the auto-evolve rule

**Decision.** Evolution is a graph of authored edges (`game-core/content/
evolution_paths/*.ron`, seeded into the public `evolution_path` table). Each edge
carries a durable, never-reused `edge_id` and AND-combined requirements: minimum
level, per-affinity essence amounts, and optional Trust, Quality-Time and Nutrition
thresholds. Every edge advances species tier by exactly one. Eligibility is one
shared query, `game_core::eligible_evolution_paths`. After any write that can change
eligibility, `check_and_evolve` (`server-module/src/evolution.rs`) evolves
automatically only when exactly one edge is eligible, and repeats against the new
species (capped at `MAX_EVOLUTION_CHAIN_STEPS`). With zero or several eligible edges
it does nothing, and the player chooses through the `evolve` reducer, which looks up
the one edge matching both endpoints. Each applied evolution appends a reveal to the
owner's private `pending_evolution_notice` row; `ack_evolution_notices` drains it.

**Why.** Automatic evolution is convenient, but when a monster qualifies for two
branches at once, picking for the player would silently close off the other branch.
Content should keep requirements different enough that this is rare.

**Rules out.** First-match auto-evolution; evolving along an edge the client names
without an endpoint check; reusing or renumbering an `edge_id`; publishing evolution
history to other players.

## Recruiting a wild monster

**Decision.** A successful recruit (`server-module/src/taming.rs`) rebuilds the exact
wild individual from the private `battle_wild` seed, at full HP, ends the battle as
`SideAWins`, deletes the `battle_wild` row, and awards no battle XP.

**Why.** Rebuilding from the stored seed means the monster the player caught is the
one they fought — same IVs and nature — and keeping the seed server-side means no
client can inspect a wild's genes before deciding to catch it.

**Rules out.** Re-rolling the individual at catch time; exposing wild genes to the
client.

## Trading resets the bond, not the monster

**Decision.** `confirm_trade` (`server-module/src/trading.rs`) resets each transferred
monster's seven Trust/Quality-Time columns — `trust_favorable_count`,
`trust_unfavorable_count`, `trust_favorable_battle_day_epoch`,
`quality_time_ticks_total`, `quality_time_accum_ms`, `quality_time_window_ms`,
`quality_time_window_start_ms` — to `0` through game-core's `reset_bond_on_trade` over a
`TrainerBond` value (`game-core/src/raising/rules.rs`); the reducer copies the columns
through the rule and never zeroes them itself. Level, species, nickname, IVs, EVs,
nature, xp and the eight essence pools transfer unchanged. `monster_pub`'s derived
`trust_tier`/`quality_time_tier` re-derive from the reset counters (Neutral / 0) while
the evolution `tier` copies forward. The guest-claim identity re-key
(`monster_mgmt::rekey_monsters`) is the same trainer under a new identity and does not
reset the bond.

**Why.** Trust and Quality-Time measure the relationship with the current trainer;
essence is the monster's own. Unfavorable trust resets with the rest — a faint
history is also a relationship with the old trainer — so a round trip through a
second account clears a Hostile tier; that is the accepted price of the rule. See
<https://github.com/mdrewt/monster-realm/issues/479>.

**Rules out.** Halving or otherwise taxing essence on trade; carrying the bond across
owners; re-implementing the zeroing in the reducer or in TypeScript; resetting on the
guest-claim re-key.

## Economy: bounded balances, headroom before transfer

**Decision.** Currency is a private `player_wallet` (`u64` balance, `MAX_BALANCE`
999 999 999 in `game-core/src/currency.rs`); every balance change goes through
`economy::grant_currency`/`spend_currency`. Item stacks cap at `MAX_ITEM_STACK`
(9999). `confirm_trade` checks receiver headroom first, and the swap applies debits
before credits (`SwapPlan::ordered_steps`), so a trade either happens completely or
not at all. Escrow is a guard, not a hold: an asset offered in an open trade cannot be
spent, sold or evolved. A trade offer from the client can only request currency from
the counterparty, because the counterparty's monsters and items are private and not
visible to the proposer. The client parses currency input to `BigInt` digit by digit
(`client/src/ui/tradeProposeModel.ts`).

**Why.** Reducers run serially, so check-then-write in one reducer is atomic, and
escrow rows would just be a second source of truth. The currency-only counterparty is
forced by the privacy model. `u64` balances exceed JavaScript's safe integers, so
`Number()` parsing would corrupt large amounts.

**Rules out.** Physical escrow rows; credit-then-debit ordering; parsing currency with
`Number`/`parseInt`.

## Battle lifecycle and PvP

**Decision.** The battle table is private; participants read it through `my_battle`.
A battle starts with the first conscious monster as lead (`BattleSide::with_lead`).
One predicate, `guards::is_in_ongoing_battle`, checks both roles and is used
everywhere a battle must block something: movement (a drain-time lock in
`movement_tick`, plus `enqueue_move`/`set_move` rejecting mid-battle), trading,
evolution, guest claims. PvP turns are secret `battle_action` rows, resolved when both
arrive or forfeited by a `PVP_TURN_DEADLINE_MS` (60 s) reaper. Challenges expire after
`CHALLENGE_TTL_MS` (120 s). Only battles between two distinct real players change
`profile` rating (`guards::is_ranked_pvp`, Elo from `INITIAL_RATING` 1000 with no
floor). When an identity's last connection closes, its live trades, PvP battles, wild
battles and challenges are resolved (`resolve_all_live_interactions` in
`server-module/src/lib.rs`). Ranked PvP requires both players to hold an account, but
this is inactive until a real OIDC issuer is configured (`pvp.rs`
`ranked_account_gate`).

**Why.** Every blocking rule reads the same predicate, so PvE and PvP cannot drift
apart. Disconnect handling keys on the *last* connection (the private
`player_session` table), so a second tab or an overlapping reconnect cannot forfeit
the player's battle.

**Rules out.** Per-call-site battle checks; forfeiting on any single socket close;
rating practice or wild battles.

## Accounts, guest identity and the claim flow

**Decision.** Anonymous play is first-class: every connection gets a SpacetimeDB
identity, and `on_connect` never rejects a connection that has no account. An
`account` row is created only for a JWT from an allowed issuer and audience
(`ALLOWED_ISSUERS`/`ALLOWED_AUDIENCE` in `server-module/src/accounts.rs`, still the
fail-closed `.invalid` placeholder). A token from an unrecognised issuer falls back to
anonymous play; a token from an allowed issuer with the wrong audience is disconnected.
An account holds no PII: `Identity = f(iss, sub)` keys everything. A guest moves their
progress to an account like this. The browser mints a 256-bit claim code
(`crypto.getRandomValues`, `client/src/net/claimCode.ts`) and registers it with
`start_guest_claim` *before* redirecting to sign-in. After sign-in, the account
identity calls `complete_guest_claim`, which runs every caller-state guard before it
looks up the code, then re-keys the guest's persistent game data onto the account
(`rekey_all`: monsters, inventory, quests, wallet, profile and the rest),
purges the guest's export bundles, and consumes the code. The destination must own no
game data. That holds because the client does not call `join_game` on a signed-in
connection while an unconsumed claim code is stored; it claims first
(`client/src/net/connection.ts`). A claim expires after `CLAIM_TTL_MS` (15 min),
cleaned up by a scheduled reaper.

**Why.** The server never generates the secret, so its strength does not depend on
the server's RNG. Checking caller state before resolving the code means the reducer
cannot be used to test whether a code exists; malformed and already-used codes return
the same error. Registering the code before the redirect is what lets the claim
survive the round trip to the identity provider.

**Rules out.** Server-minted claim codes; storing email or JWT subjects; rejecting
anonymous connections; widening the audience allowlist to more than this game's client.

## Account deletion and data export

**Decision.** Every table is classified once in `schema::DATA_LIFECYCLE_MANIFEST`
(Erase / Anonymize / ViaJoin / NotOwned, a written basis, and whether it is
exportable). A test fails if a table is missing or stale. `delete_account` sets
`PendingDeletion` and arms a one-shot reaper for `DELETION_GRACE_MS_DEFAULT` (7 days,
`game-core/src/accounts/deletion.rs`); `cancel_account_deletion` reverses it. When
the reaper fires, the cascade force-resolves live interactions first, forces ongoing
battles naming the account to a terminal result, erases or anonymises per the
manifest, and stamps `terminal_at_ms`. A deletion-pending caller cannot open new
commitments: 25 reducer call sites call `guards::require_not_deleting`, while
commitments that predate the request stay completable. `request_data_export` writes
private `export_bundle` chunks (`EXPORT_CHUNK_ROWS` 500) for `my_export_bundle`, gives
each live bundle a unique creation stamp (rejecting under contention), admits requests
against a global live-row cap that is halved for callers without an account and
halved again for callers without a wallet, and an hourly reaper deletes chunks older
than 7 days (`server-module/src/privacy.rs`).

**Why.** A new table must not silently keep personal data after a deletion, so its
classification is part of the schema. Blocking new commitments during the grace
period stops a deleting account from laundering assets to a confederate. The export
caps and tiers bound storage abuse, with anonymous identities limited before account
holders.

**Rules out.** An unclassified table; deleting before the grace period ends; an export
path any other player can read.

## Dev-only reducers never ship

**Decision.** `start_wild_battle` and `grant_bait` compile only with the
`dev_reducers` feature (`server-module/Cargo.toml`), which is never in `default`. The
playtest recipes publish the default build and then check the *published* module with
`spacetime describe --json` (`scripts/verify-release-reducers.mjs`), and check that
the production client bundle contains no DEV debug hooks
(`scripts/verify-build-hooks.mjs`).

**Why.** A dev reducer in a real deployment is a free-items and free-battles exploit.
Checking the published module rather than the source catches a wrong build flag in
the publish path, which a source grep would not.

**Rules out.** Runtime flags for dev reducers; trusting the source tree as proof of
what was published.

## SpacetimeDB versions move in lockstep

**Decision.** The spacetime CLI/host and the Rust `spacetimedb` crate are pinned to
the same version (2.8.1: root `Cargo.toml`, both workflows' `Pin spacetime` steps).
The npm `spacetimedb` SDK is separate (2.6.0, locked in `client/package-lock.json`).
Module code uses 2.x syntax (`#[table(accessor = x)]`, `ctx.sender()`). Upgrades
follow `docs/runbooks/spacetimedb-upgrade.md`. The nightly `smoke-republish` job
republishes over live data without `--delete-data` and checks that the data survives.

**Why.** The crate version is the product version: a crate/CLI mismatch changes the
generated bindings and the wire format. A schema change the automatic migration cannot
apply (reordering or removing columns, renamed enum variants) only shows up when
publishing over real data, so it has to be tested there.

**Rules out.** Bumping the crate without the CLI (or the reverse); inserting a column
anywhere but the end; removing a column or reordering enum variants on a live
database without planning a `--delete-data` republish.

## Schema changes are additive

**Decision.** New columns go at the end of a table and carry an explicit `#[default]`
(`i64` defaults are typed, e.g. `#[default(0i64)]`, because an untyped `0` encodes as
4 bytes and the publish fails). Illegal combinations of states that a column-type
change would rule out are enforced by a checked predicate instead (for example
`accounts::account_state_is_legal`). Whether a table is scheduled is fixed at first
publish, so scheduled tables ship together with their reducer. A new table needs an
entry in `schema::DATA_LIFECYCLE_MANIFEST` (a test fails otherwise). A new column on
an exportable table breaks the compile of the exhaustive export fixtures in
`server-module/src/privacy_tests.rs`, which forces an explicit export-or-omit
decision in that table's serializer in `privacy.rs`.

**Why.** SpacetimeDB's automatic migration accepts only appended columns with
defaults. Anything else needs `--delete-data`, which wipes every player.

**Rules out.** Mid-struct column inserts, column removals, and type changes on a live
table.

## Observability: the module never times itself or calls out

**Decision.** Server signals come from the SpacetimeDB host: `/v1/metrics` for
Prometheus and the module's log files for Alloy→Loki. New server log lines go through
`observability::mr_log` (one JSON envelope). A 60 s `mr_heartbeat` scheduled reducer
logs the deployed content version and writes nothing. OpenTelemetry spans and metrics
are client-side only. The self-hosted stack (Prometheus, Alloy, Loki, Tempo, Grafana,
node_exporter, Caddy, and a trace relay) lives in `ops/observability/`, bound to
loopback.

**Why.** Reducers cannot make outbound calls and should not read clocks, so the host
has to be the source of timings and counters. `/v1/metrics` answers without
authentication and labels its series by database, so everything stays on loopback.

**Rules out.** An exporter or polling reducer; ad-hoc `log::` formats in new code;
exposing the stack without changing the Caddy bind address on purpose.

## Client UI: one overlay registry, keyboard first

**Decision.** Overlays are exclusive, except the main menu, which stays open beneath
the screen it opens and never blocks one (`overlayVerdict` in `client/src/main.ts`).
One pure function decides which may open:
`canOpen` (`client/src/ui/overlayRegistry.ts`) reads a tier per overlay (a battle on
top, guard-only modals that another hotkey never dismisses, and the Box, Raising &
Inventory and Evolution overlays, which swap with each other). A battle that starts
force-hides most open overlays, but never the dialogue overlay. The main menu (`M`) is a D-pad list whose entries open
their screen above it
(`client/src/ui/screens/mainMenuScreen.ts`); B closes that screen and returns to the menu. Each view keeps
its state in a pure model (`*Model.ts`) with a thin DOM view (`*View.ts`). Text-input
overlays clear held movement keys on open and own their keystrokes. The controls list
has one source, `CONTROLS` in `client/src/ui/helpModel.ts`. `T` interacts with the
nearest NPC, shop or heal tile (`nearestInteractable`), based on the NPC's
`NpcInteraction` role column. Accessibility metadata for every overlay is one total
record (`OVERLAY_A11Y`); status badges pair colour with a short text token defined
once in `game-core` (`A11Y_TOKENS`, checked in `validate_content`); `Element.animate`
is banned by a Biome plugin (`client/lint/no-waapi.grit`) because it ignores
`prefers-reduced-motion`. All UI strings come from a total typed catalog
(`client/src/ui/i18n/`: `en` and `fr`); `t()` throws on a missing key, and
`setLocale` throws on an unregistered locale.

**Why.** Silently dismissing a modal on a stray keypress loses input, and for dialogue
it desyncs server conversation state. Pure models make the UI logic testable without
a DOM. A total catalog makes a missing translation a compile error rather than a
blank label, and throwing (rather than showing the key) keeps an unwired string from
looking wired.

**Rules out.** Per-overlay mutual-exclusion checks; conveying meaning by colour
alone; WAAPI animation; hard-coded UI strings; falling back to the key or `en` when a
string is missing.
