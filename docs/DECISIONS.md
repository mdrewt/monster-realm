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
(`evolution_eligibility`, `interact_candidates_coded`, `zone_map`, `care_remaining_ms`)
are wasm exports (`client-wasm/src/lib.rs`), not TypeScript literals.

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
rendering and pacing, and `Date.now()` against a server-epoch column for display or an
advisory gate whose readiness only a wasm export over the game-core predicate decides
(`care_remaining_ms` on the Monsters sheet); the server re-decides on its own clock.

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

## Tactical content lives in sidecar registries keyed by id

**Decision.** Tactical battle data does not add fields to `SkillDef`, `Species`, `ItemDef`,
`ZoneDef` or `EncounterTable`. It lives in its own registries under `game-core/content/`
(`tactics_skills/`, `tactics_species/`, `tactics_items/`, `tactics_zones/`, `battle_maps/`,
plus the `tactics_tuning.ron` singleton), each row keyed by the carried id.
`tactics::content::build_kits` joins them onto the carried rows, and
`validate_tactics_content` runs that join plus the kit lints. CI runs it as ordinary tests;
`sync_content` runs it in its validate phase, before any write.

**Why.** A new field on a carried content struct breaks every hand-built struct literal
(about 100 across game-core and the server tests) and the production marshaling. A field on
the encounter row would also be lost on the `encounter` table round trip without a schema
change. Sidecars keep the carried structs and tables frozen. Coverage ("every skill and
species id has exactly one row") is checked in the join, so a missing row fails loudly.

**Rules out.** Folding tactical fields into the carried structs before the 1v1 system is
retired; a second copy of the lints in the server; a default row for an uncovered id.

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
`SwapError`; `tactics::submit_queue` refuses a fainted unit's act with the typed error; a
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
participant), `my_export_bundle` (`privacy.rs`), and the tactical set (`my_tactical_battle`,
`my_battle_units`, `my_battle_events`, `my_battle_clock` for either participant;
`my_battle_queue`, `my_battle_deploy`, `my_formation` for the owner). Some tables have no
client read path at all: `monster` (IVs, EVs, nature), `encounter` (spawn weights),
`battle_wild` and `battle_wild_unit` (wild individuality seeds), `battle_secret` (the
tactical seed), `battle_summary` (telemetry), `battle_action` (secret PvP picks),
`heal_cooldown`, `guest_claim`, `player_session`.

**Why.** Hidden stats, item stock, balances and a pending PvP pick are competitive
information. The view body is the entire boundary, so each view takes only the
context: an extra "owner" parameter would let a caller choose whose rows to read.

**Rules out.** Marking a per-player table `public`; a view that takes an identity
argument. Tables that are public on purpose: content, `character`, `player`,
`profile` (the leaderboard), `trade_offer` and `battle_challenge` (both parties need
them), and `player_quest`.

## Tactical battle privacy is structural, and tactical rows are not exportable

**Decision.** The tactical tables (`server-module/src/schema.rs`, M-battle-tactics
bt-7) are all private. Both participants read `battle_tactical`, `battle_unit`,
`battle_event` and `battle_clock` through views that join through the `battle` anchor's
two identity indexes (`my_tactical_battle`, `my_battle_units`, `my_battle_events`,
`my_battle_clock`); a player reads only their own `battle_queue`, `battle_deploy` and
`player_formation` rows (`my_battle_queue`, `my_battle_deploy`, `my_formation`); and
`battle_secret` (the seed), `battle_wild_unit` (wild individuality seeds) and
`battle_summary` (telemetry) have no view at all. `battle_unit` carries no queue or
ready field. Deploy is reveal-by-copy: each side's picks go to its own owner-only `battle_deploy` row (`locked`, written in `tactics::stage_pvp`). The second lock, or the 45 s window's auto-fill in `tactics::expire_pvp_deploy` (`pvp_deploy_ms`, `game-core/src/tactics/tuning.rs`), calls `tactics::materialize`, which copies both stagings into `battle_unit` rows and flips the phase in one transaction. No unit row exists before that, so the only participant-visible deploy fact is the phase flip. `battle_clock` holds one row per side (a PvP battle holds two; a Practice battle's two name one player), and both participants read both through `my_battle_clock`: the opponent's window and strike count are match state, not a secret. `tactics::store` writes a row only when it moved, so a pre-queue or a cancel leaves nothing participant-visible. Forfeit is a client-confirmed reducer (`tactics::forfeit`), not a queue entry, and costs 0 AP. Forfeit, disconnect, the 4th auto-pass, Surge and adjudication all reach `tactics::finish` as `Close::Settled`, which settles through `pvp::settle_pvp_battle` in `SideAWriteBack::HpOnly` mode. That is the one caller of `ranking::apply_pvp_rating`; the tactical settlement pays essence to both sides, with no XP and no currency. Practice rates and pays nothing. Every tactical table is `exportable: false` in `DATA_LIFECYCLE_MANIFEST`;
the cascade step (`schema::erase_tactical_rows`, beside the tables it writes) collects
the battle ids from every row that still names the identity (the `battle` anchor chain,
the clock, queue, deploy and summary identity columns, and a scan of `battle_unit`),
sweeps the whole battle's per-battle rows by `battle_id` before `battle::anonymize_battles`
tombstones the anchor, and leaves `battle_summary` with the deleting side swapped to the
tombstone identity. The other participant's rows of a shared battle go with it: the
anchor is forced terminal for both sides and the transcript is GC-bound. Game-core's
non-wire enums (`Side`, `MoveClass`, `Stance`, `Entry`) are stored through schema-local
`SpacetimeType` twins (`SideRow`, `MoveClassRow`, `StanceRow`, `BudgetLastEntry`), never
as integer codes.

**Why.** Whether a READY plan exists is the one fact an opponent could act on (design
§6.3), so it must not be derivable from any participant-visible row: the queue is
owner-only and the unit row has no flag for it. The seed replays every roll; the wild
seeds rebuild a recruited wild. Transcripts are deleted 24 h after a battle, so an
export would copy nothing durable of them. The summary (one row per battle naming both
sides, with the counters bt-9 reads) and the formation (a live preference the owner
already reads through `my_formation`) are kept out of the export bundle by the spec
(BT7.4); whether a player's export should include them is an open spec question.
`battle_unit.owner` is `Option<Identity>` (a wild unit has none, and a
future two-ally side is just more rows), which no index can key, so unit rows are reached
through the battle they belong to. Accepted reveals, stated as such: the legacy `my_battle` anchor (`schema.rs`) returns the whole `Battle` row, so from Deploying on both participants see the opponent's roster (species, level, stats, known skills in `state.side_b.team`, filled at `tactics.rs` `start_pvp_tactical`); slots and positions stay secret until the copy, and the anchor shape is the cutover's to retire. `QueueVoided{unit}` after a KO, turn-skip or battle end shows that a plan existed (see "Queued actions halt-and-return").

**Rules out.** A ready or queued flag on `battle_unit`; a view over `battle_secret`,
`battle_wild_unit` or `battle_summary`; a view taking an identity argument; adding an
exporter for a tactical table; an owner-keyed-only cascade step for `battle_unit` (it
would miss wild units and could never be indexed); a cascade that finds tactical rows
only through the `battle` anchor (the reaper's first step can delete an ongoing wild
anchor before the sweep runs); `u8` codes for game-core enums in a row. Also ruled out: a lock flag on `battle_tactical` or a lock mirror on `battle_unit`; writing one side's units at its own lock (`materialize` runs only once both are locked, `tactics.rs` `stage_pvp`); routing a tactical anchor through `battle::write_back_battle_results` (its side-A XP and currency grant, `battle.rs`, are the M16a asymmetry that design §7 removes); a second `apply_pvp_rating` caller.

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
evolution, guest claims. Accepting a challenge opens a TACTICAL battle
(`tactics::start_pvp_tactical`): secret queue rows under the 30 s per-unit clock, forfeit on
the fourth auto-pass or the last connection closing (see "Tactical battle privacy is
structural"); the 1v1 `battle_action` rows and the 60 s `pvp_deadline_reaper` are never
written or armed by a live path since the cutover. Challenges expire after
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

## Queued actions halt-and-return; the idle clock resets on every accepted submit

**Decision.** At pop (`game-core/src/tactics/queue.rs`), the first entry failing
`validate_at_pop` and every later one are wasted: never executed, no AP charged, never
retried, visible only as `PlanHalted{unit, idx, reason_kind}`. Control returns live
(`Waiting(U)`) to a player-owned conscious unit with at least `min_action_cost` (2) AP, else
the turn ends committed. The idle clock (`tactics/clock.rs`) runs only while the battle waits
on a player's unit; each accepted submit for it closes the window, and re-entering `Waiting`
opens a fresh full one after the capped presentation pad. A live submit whose first entry
fails is refused (`InvalidNow`) and changes nothing, clock included. The AP floor bounds a
unit-turn to 3 windows (6 → 4 → 2). PvP-ruleset expiry auto-passes without Guard and the 4th
strike against one side forfeits; wild expiry auto-flees. The planner, inventory, recruit headroom
and Item/Recruit/Flee resolution reach the executor only through the `Hooks` trait; a hook
may add only `RecruitResult`, `Awards` and `Status` events and never decides the outcome (the
terminal sweep does; a flee is `Fled` whatever the hook did). Clocks and strike counts are
kept per side, so in Practice one player holds both. A submit that lands after its deadline
but before the fire commits is accepted; the fire then finds the window closed and is a no-op.

**Why.** Paying AP for a non-event reads as economy theft, the most-resented pattern in the
reception corpus; halting means nothing executes from a board the plan did not assume. The
clock takes the "resets the moment they submit" ruling (D583.2) literally; refusing a submit
that executes nothing stops zero-cost resubmits refilling the clock forever. `queue.rs` is in
no later slice's `touches:`, so later rules arrive as hooks the server implements over game-core.

**Rules out.** Charging the first invalid entry's nominal AP (design §12 Q2's alternative); a
cumulative per-unit-turn clock (§12 Q1's); skipping past an invalid entry (conditional
scripting); trusting a client-sent tile (a Skill re-aims at its bound unit, a Move re-paths);
wiring a rule into the executor except through `Hooks`. Accepted reveals: `reason_kind` names
the failure kind of the first discarded entry, and `QueueVoided` shows that a plan existed.

## Tactical settlement derives the reward ledger from the transcript

**Decision.** A tactical battle's rewards (design §7) are settled once, at its finish, by
`server-module/src/tactics_settle.rs`: the persisted `battle_event` transcript is folded into
game-core's `rewards::on_unit_defeated` — each `Ko` credited to the attacker of the last
opposite-side hit on the victim, against the final board with the units not yet fallen restored —
and `rewards::pay` is applied through the 1v1 funnel's own per-monster credit
(`battle::credit_monster`) over the whole conscious party, with one `Awards` line per paid monster
(ascending unit) and one `unit 0` line for the player's currency appended after `BattleEnd`. The
win-only credits (daily trust-favorable, Quality Time, the evolution check) need a defeated wild,
so a recruit-only win pays nothing. `battle_summary` is one row per battle, inserted at the Active
start (`outcome == Ongoing` until finished) and accumulated every step. No 1v1 reducer exists to act
on an anchor since bt-17: one anchor, one payout path.

**Why.** Nothing in game-core calls the KO hook, and the shell sees the board only between
transactions, so the KO moment is observable only through the transcript; consciousness is
monotone in P1 (no heal or revive), which makes the reconstruction exact. Reusing the 1v1 credit
keeps one write-back funnel and the carried trust/Quality-Time scope. The summary's
windows-per-unit-turn and pre-queued/live counts are not derivable from events, so they accumulate
per step. One anchor, one payout path: a 1v1 turn on a tactical anchor would pay twice.

**Rules out.** A second ledger store or a per-KO reward write mid-battle; recomputing the killer or
the split on the client (bt-12 renders the `Awards` lines as they are); a `check_headroom` for
recruits (no monster-storage rule exists; the predicate is "the unit has an owner"); paying the win
credits on a recruit-only win. Moving the fold and the attribution into game-core
(`tactics::rewards`) is R-bt-9-LEDGERHOME, due with the first slice that adds a heal or revive.

## Tactical rule conventions carried from bt-2

**Decision.** In a wild battle side A is the player: only it is player-owned
(`queue::is_player_owned`) and it holds round-1 tie priority (`initiative::round1_priority`).
Both coins, the round-1 PvP priority coin and the adjudication coin (`outcome::adjudicate`),
read `splitmix64(..) & 1` with 0 → A. Practice runs the PvP ruleset through the one mapping,
`BattleKind::uses_pvp_rules` (`tactics/tuning.rs`). A wild mutual wipe is `SideBWins` by
`FixedOrder` (ADR-0156 R5 as carried; `outcome::check_battle_end`). Every target of an attack
draws an accuracy then a variance roll, hit or miss (`resolve::draw_rolls`). Flank is judged on
the board captured before the attack (`resolve::resolve_attack`). Freeze thaw rolls come off the
one `splitmix64(seed ^ action_seq)` stream (`resolve::draw`, `upkeep::run_upkeep`). The wild
round cap fires on `round >= wild_round_cap`. First-Stand clears when it saves the unit, as
well as at its first TurnStart.

**Why.** Each looks arbitrary in the code and is easy to flip, but the executor and its tests
build on them (`is_player_owned` decides who may use an item, recruit, flee or run a clock).
Every roll comes off one `action_seq` counter, so one added or skipped draw moves every later
roll of the battle; the golden fixture (`game-core/tests/fixtures/tactics_golden.json`) pins
`draw_rolls` natively and in wasm.

**Rules out.** A round-1 coin in a wild battle; matching on `BattleKind::Pvp`, which runs
Practice as PvE; adjudicating a wild mutual wipe, or a draw outcome (`BattleOutcome` gains no
variant); one roll shared by an attack's targets, or no variance draw on a miss; flank re-read
after an earlier KO in the same AoE; a second RNG stream for status rolls; `round ==
wild_round_cap` (the spec's wording); a First-Stand that survives its own save.

## Wild AI plans are a pure function of the public board

**Decision.** `tactics::ai::plan(state, unit, stance, spawn, t)` takes no RNG or seed parameter;
`ai_tests.rs` pins the signature as a `fn` pointer type. `View::of` builds a private `View` with
no `seed`, `action_seq` or budget field, every stance helper reads only it, and `admissible`
costs every candidate plan from `TurnBudget::fresh(t)`, never `actor.budget`. The executor hands
`Hooks::plan_ai` the `public_view` (`seed`, `action_seq` zeroed), halts anything but
`Move`/`Skill`/`EndTurn` as `BadShape`, and runs every entry, the trailing `EndTurn` included,
through `validate_at_pop` like a player plan (`queue.rs` `start_turn`, `execute`). The planner
therefore calls the gate's own functions (`find_path`, `target_set`, `disengage_taxed`,
`stride_points`, `validate_unit`; `plan_cost` folds the gate's `spend`) and restates no rule. A
stance that needs randomness must move it into server-pushed `battle_event`s. The compile shape
forbids the parameter and the View keeps `seed`/`action_seq` out by structure; its units are
`&TacticalUnit`, so `budget` stays reachable, and the seed/budget-blindness tests and the
executor proptest (no `PlanHalted` on generated battles) are what catch a regression.

**Why.** Design §4.2 has the client compute each intent chip with the same wasm `plan` on the
shared provisional board, so chips and forecasts never contradict each other. That board has no
seed and shows stored budgets, while the server plans just after `turn_start` refreshes the
wild's; reading neither keeps chip and execution equal on an unchanged board. A refused entry
ends the wild's turn at `PlanHalted` (the `Hooks` seam: "Queued actions halt-and-return…").

**Rules out.** A seed or RNG parameter; reading `state.seed`, `action_seq` or `actor.budget`;
a hidden PRNG; a TypeScript planner; range, cost or stride math re-implemented in the planner.

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
exportable). A test compares the manifest with the generated module definition's
table set, so a missing or stale entry fails. `delete_account` sets
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

## Battles run on one engine at a time; the tactical cutover was a flip, not a toggle

**Decision.** The two live battle starts — the grass trigger in `movement_tick` and
`accept_challenge` — call the tactical writers (`tactics::start_wild_tactical`,
`tactics::start_pvp_tactical`) and nothing else. The switch happened in one slice (bt-16)
together with the deletion of the dev-gated tactical starts and the migration of every
battle e2e. bt-17 then deleted the 1v1 engine from the module: `start_battle` (which had stayed
client-callable through the flip), `submit_attack`, `swap_active`, `flee`, `use_battle_item`,
`attempt_recruit`, `submit_pvp_action`, `begin_encounter`, the dev-only `start_wild_battle`, the
60 s secret-pick deadline arming and the 1v1-only guards are gone (the generated bindings and
`client-callable-reducers.json` carry none of them), as are the client's 1v1 renderer, model,
dispatch arms and copy. What stays of the 1v1 engine is deliberate: `game-core`'s `combat::*` is
the type home of the stored `Battle.state` and of the carried rules the tactical engine reuses; the
module keeps the write-back, terminal-sweep, faint-penalty and disconnect helpers the tactical
settle funnel calls; ten row→`BattleMonster` marshaling helpers in `marshal.rs` /
`content_cache.rs` compile only under `cfg(test)` (their tests still exercise them; a production caller is a
compile error) until they are deleted with named survivors. The 1v1
tables (`battle_action`, `battle_wild`, `pvp_deadline_schedule`) are retired from use, never
dropped or reordered (see "Schema changes are additive"): a census test pins that no client-callable reducer
reaches `pvp_deadline_schedule` (the erase cascade's disarm still deletes from it), and that `battle_action` and `battle_wild` are reached by exactly
four tactical reducers (today only through the settle funnel's deletes — the census pins WHICH
reducers reach a table, not how). The account-e2e's vacuity allowlist names each retired table
with that reason.

**Why.** Two engines reachable at once would need a per-battle discriminator in every
guard, settlement and client renderer, and a runtime toggle is exactly the surface a
hostile client would flip. One engine per path keeps `guards::is_in_ongoing_battle`,
the settlement funnels and the battle frame single-sourced, and compiling the old
engine through the flip let the client keep typechecking so the purge could delete the
client side first and de-attribute the server side in the same slice.

**Rules out.** A feature flag or config row selecting the engine; starting a tactical
battle through a dev-only reducer in any shipped build; dropping or reordering the
retired tables (live data, additive schema).

## Dev-only reducers never ship

**Decision.** `start_wild_battle` and `grant_bait` compile only with the
`dev_reducers` feature (`server-module/Cargo.toml`), which is never in `default`. The
playtest recipes publish the default build and then check the *published* module with
`spacetime describe --json` (`scripts/verify-release-reducers.mjs`), and check that
the production client bundle contains no DEV debug hooks
(`scripts/verify-build-hooks.mjs`). A dev-gated start never outlives its build phase: the
tactical `dev_start_tactical_*` reducers were deleted in the same slice that wired the live
paths, and the e2e drives every battle through the player-reachable flows.

**Why.** A dev reducer in a real deployment is a free-items and free-battles exploit.
Checking the published module rather than the source catches a wrong build flag in
the publish path, which a source grep would not.

**Rules out.** Runtime flags for dev reducers; trusting the source tree as proof of
what was published.

## SpacetimeDB versions move in lockstep

**Decision.** The spacetime CLI/host and the Rust `spacetimedb` crate are pinned to
the same version (2.11.0: root `Cargo.toml`, both workflows' `Pin spacetime` steps).
AMENDED 2026-10-15 (deps-s3): the npm `spacetimedb` SDK now joins the lockstep
(`^2.11.0`, locked in `client/package-lock.json`). It was previously held separate
(at 2.6.0) because newer SDKs change reconnect behaviour; since 2.7.0 the vendor
ships CLI/crate/SDK from one monorepo on the same day with no documented skew
matrix, so same-version-everywhere is the only documented-safe configuration. An
SDK bump still requires the live two-client e2e the old rule demanded.
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

## Client UI: virtual buttons, one context stack, one overlay frame

**Decision.** Every input resolves, through one binding table
(`client/src/input/bindings.ts`), to a closed set of virtual buttons: D-pad, A, B, X, Y,
LB, RB, Start, Select. Letter keys are optional accelerators that open a canonical menu
path. Every screen is a frame on one pure context stack (`client/src/ui/contextStack.ts`)
over a world or battle base. B pops one frame; Start pops every frame to the base, or
opens the main menu at a base. `SCREEN_POLICY` is a total record per frame (owner, battle
behaviour, battle-safety). Server-owned state (battles and dialogue) is reconciled into
the stack on every batch, never pushed by a keypress, and the client never closes a
server-owned frame itself; it sends the reducer (`dismissDialogue`). A trade or challenge
request is a non-modal banner and world sheet, never a frame. Which overlay may open
over another is still the tier table `canOpen` reads (`client/src/ui/overlayRegistry.ts`).
Every frame is a class-styled `.mr-frame` inside `#game-screen`; `client/src/ui/frame.ts`
is the shared chrome (the main menu uses it today). Menus are D-pad lists, grids and tabs
(`client/src/ui/nav.ts`) whose active item is a key, never an index or a pointer cursor.
The hint bar and Help are generated from the context table, the live bindings and the
catalog (`client/src/ui/hintBarModel.ts`, `client/src/ui/helpModel.ts`). Bindings persist
per browser in `localStorage['mr.controls']` (versioned; D-pad, A, B and Start always keep
a key). Escape alone is routed in the capture phase, so a view's `stopPropagation` cannot
trap it; every other key keeps the bubble phase, where text-entry views shield their
fields from the accelerators. Each view keeps its state in a pure model (`*Model.ts`) with
a thin DOM view. Accessibility metadata for every overlay is one total record
(`OVERLAY_A11Y`); a status condition is named by text, never by colour alone — on the tactical
board through the exhaustive `tactics.status.*` catalog keys (the 1v1 badges and their
`A11Y_TOKENS` link left with the 1v1 view in bt-17); `Element.animate` is banned by
a Biome plugin (`client/lint/no-waapi.grit`) because it ignores
`prefers-reduced-motion`. All UI strings come from a total typed catalog
(`client/src/ui/i18n/`: `en` and `fr`); `t()` throws on a missing key, and `setLocale`
throws on an unregistered locale. One whole-tree scan (`client/src/ui/i18n/hardcodedStrings.test.ts`)
asserts that no non-test client file writes a raw string to a text sink; its sink floor only proves
the scan still sees the tree. Per-view behaviour is owned by each view's «key»-sentinel runtime
tests.

**Why.** A handheld-console grammar, where a few contextual buttons are primary and
hotkeys are shortcuts, is the intended interface. One stack makes "back one level" and
"exit everything" uniform. Silently dismissing a modal on a stray keypress loses input,
and for dialogue it desyncs server conversation state, so server-owned frames follow the
store and an ongoing battle cannot be hidden. Pure models make the UI logic testable
without a DOM. Generated hints and help cannot drift from the bindings. A total catalog
makes a missing translation a compile error rather than a blank label, and throwing
(rather than showing the key) keeps an unwired string from looking wired.

**Rules out.** A feature reachable only by a hotkey (F9's menu twin, Options › Report a
problem, is still owed); a hotkey-only discovery menu; a
hand-written controls list; a dedicated interact key; new per-overlay tiers,
mutual-exclusion checks or force-hide lists; overlays anchored to the window or in page
flow; menus that hide themselves on a pick; conveying meaning by colour alone; WAAPI
animation; hard-coded UI strings; falling back to the key or `en` when a string is
missing; per-view copies of the string scan, or a ratchet fixture for the failing-sink count. A
per-view copy only adds a "this file is still visible to the scanner" tripwire. Going without it is
an accepted risk: a single view going dark to the scanner by less than the floor's margin goes
unnoticed by the scan, and only the sinks its runtime tests render are still checked.

## Context stack ownership

**Decision.** The context stack owns the player's frames. Every player open (a menu entry,
an accelerator, a world interaction, the deferred shop open, a claim lifecycle prompt) goes
through one `openFrame` in `client/src/main.ts`, which pushes the frame first and only then
shows its view. A frame already on the stack is not pushed again; `contextStep`'s same-id
push no-op is the one dedup. The trade, challenge and leaderboard panels are one `social`
frame, and switching panels pushes and pops nothing. The visibility mirror sees only the
server-owned overlays (`MIRRORED_IDS` in `client/src/ui/contextStack.ts`: `battleView`,
which presents the battle base and the terminal outcome, and `dialogueView`), because those
show themselves on server edges. A player view that closes itself has its frame popped at
the next sync (`hiddenPops`), never pushed. The three main.ts tables (probes, hide handles,
lent views) keep rows only for the mirrored ids, and a player frame's probe, hide and view
travel with its open. A movement-gate read derives from the stack as it stands and never
syncs it.

**Why.** When the stack mirrored the views' self-managed visibility, every reader had to
re-sync first: gate reads mutated the stack, a shown overlay could sit off the stack until
the next key, frame or batch, and a second input source would have had to re-derive the
open path. One push-first entry point gives a gamepad (M-gamepad) the same open path as the
keyboard, and makes "shown but not on the stack" impossible for the player set.

**Rules out.** Showing a player view outside `openFrame`; pushing a player frame from
visibility; a per-panel Social frame; merging the three main.ts tables into one registry
(three small total records with byte-identical thunks are the defense against copy-paste
sibling bugs); a gate read that pushes, pops, shows or hides a frame.

## Interaction target: the tile in front, then your own tile

**Decision.** A (and a click on the world) acts on the candidates from
`game_core::interact_candidates`, exported to the client as
`interact_candidates_coded`. The candidates are the entities on the tile the character
faces (`pos.step(facing)`), or, if there are none, the entities on the character's own
tile. Same zone only; ordered NPC, then heal, then player, then by id. An entity
within range but not in front is never a candidate, even though `talk` accepts up to
`TALK_RANGE` (2). The UI starts trades and challenges only from a player you face. The
server stays permissive.

**Why.** Interaction follows what the character faces, as in console RPGs. The
server's range is a latency margin for an NPC that steps one tile before the reducer
runs. It is not the player's reach.

**Rules out.** A nearest-within-range target; widening the client rule to match
`TALK_RANGE`; starting a trade or challenge remotely from a menu.

## The battle frame has one owner per tactical phase

**Decision.** Three views can own the `battleView` frame — the deploy panel, the tactical shell
and the results panel — and at most one shows at a time. `refreshBattle` routes by the tactical
row's phase (`battleRenderer`: Deploying → the deploy panel, Active → the shell, Finished → the
results panel, no row → `none`) and switches with one fixed ritual: render the hidden target first,
pop every PLAYER frame over the battle base, hide the other views, then show (the open is the last
statement); a target that cannot be built or rendered leaves the current owner in place. An anchor
WITHOUT its tactical row is not a battle the client can show (bt-17 deleted the 1v1 view): an
Ongoing one builds nothing and keeps a shown owner (B17 reads "a battle the client can render is
never hidden"; the stack still holds the battle base and Start opens the menu), a terminal one is
dismissed and every view hides in the same batch — `renderableBattle` is the one predicate
`reconcileStack` and `refreshBattle` share, so the stack never counts an unrenderable outcome. The
three roots are built lazily on the first batch that routes to them, share the one `battleView`
overlay a11y record, and keep their own `hide()` idempotent; `activeBattleView`,
`tacticalOwnsStart` and `battleHint` read the SHOWN view, never the phase.

**Why.** The overlay registry, the context stack, the a11y record (`OVERLAY_A11Y`, the adopted
live region, the focus trap) and every test and e2e selector (`[data-testid="battle-title"]`,
`aria-modal`) key on ONE id, `battleView`. Two visible roots would be two titles and two modal
dialogs; closing a covered record and opening a fresh one would leave a frame over the base inert;
a root constructed at boot would be a second title and a second modal dialog the moment a battle
routes to another owner. Routing by phase keeps B17 a one-place rule, and sharing the renderable
predicate with the stack keeps a row-less terminal anchor from closing drop-policy frames on every
batch with nothing on screen.

**Rules out.** A second overlay id per battle view; showing a battle view outside `refreshBattle`'s
switch; constructing the tactical roots at boot; a renderer switch that pops the dialogue frame (a
server conversation suspended over the battle base stays) or that demotes a visible shell when one
batch fails to build; a fallback renderer for an anchor without its tactical row.

## The nightly mutation gates run sharded and both are zero-tolerance

**Decision.** `mutation` (game-core) and `mutation-server` run as matrices of cargo-mutants
`--shard k/n` jobs (6 and 8). Every shard is its own zero-tolerance verdict and the job is red iff
any shard is. The server gate has no survivor cap: a server survivor is killed by a test or, if
provably equivalent (no input distinguishes it), excluded in `.cargo/mutants.toml` with the written
proof (function + operator + column keys, so line drift cannot re-expose a runaway mutant). Log
lines are observable (a log sink asserts them), so a mutant that only changes a log line is killed,
not excluded. Four guaranteed-hang `tiled_import` mutants and one runaway-allocation mutant are
excluded there too. `mutate-core` and `mutate-server` carry an 8 GB `ulimit -v` backstop so a
runaway allocation aborts its test instead of killing the runner. `mutate-server` builds
incrementally (`CARGO_INCREMENTAL=1`; CI's toolchain action sets 0): about 4x faster rebuilds per
mutant with identical verdicts; `just mutate-diff` mutates only the lines committed since a base.
`just test` also runs the server tests with `--features dev_reducers`, which the default build
compiles out.

**Why.** The crates outgrew one serial job: nights of 2026-10-31, 11-01 and 11-04 were cancelled at
GitHub's 6 h cap. A count cap hides regressions (kill one, add one, same number) and rewards
raising it; the server had drifted to 72 survivors against a cap of 34, which were cleared with real
tests.

**Rules out.** Raising a cap or dropping mutants to fit the time limit; excluding a killable
mutant; a per-shard server budget; a committed survivor baseline file; an aggregate job that
re-counts what each shard already judged.

## Menu chrome draws from `--mr-*` tokens; the listbox ring stays `#cc5500`

**Decision.** Menu chrome takes its spacing, type, borders and colors from the `--mr-*` tokens in
`client/src/styles.css`, the one home of their values. Spacing and type are rem, so a root scale
reaches them. Frame, chip and banner border widths stay px (`--mr-border-width`,
`--mr-border-thin`). Every color token has a `prefers-contrast: more` value in the sheet's last
block. The target frame reads top to bottom as title bar, tab bar, a body that grows and scrolls and
an overlaid feedback strip, with the world's hint bar below; screens move onto it one at a time, so
some still differ. New kit classes are named outside the `mr-frame`/`mr-shell` family. The dashed
ring on a focused listbox or grid stays `#cc5500`; `--mr-focus` is for other focused controls.

**Why.** Each menu had grown its own spacing and type, which players reported as inconsistent. A rem
border lands on fractional device pixels at a continuous scale and shimmers. The listbox ring can
cross the light active row, where `--mr-focus` measures about 1:1 and the focus-ring tests in
`client/src/ui/overlayA11yWiring.test.ts` require 3:1.

**Rules out.** New px spacing or font sizes in menu chrome; a color literal where a token has that
role; a rem width on a frame, chip or banner border; a color token without a `more` value; moving
the listbox ring onto `--mr-focus` while the active row keeps its light fill.

## One viewport number scales the world by integers and the chrome continuously

**Decision.** `viewportScale` (`client/src/render/viewport.ts`) is the single scale authority. It
returns the integer `deviceScale` the world renders at, and the continuous `uiScale`, the shorter
CSS axis over 720 clamped to [0.875, 3]. `installResizeHandler` writes `uiScale` to `--mr-ui-scale` on
`documentElement` at the same event that resizes the renderer, and the one root rule,
`:root[style*="--mr-ui-scale"] { font-size: calc(100% * var(--mr-ui-scale)); }`, carries it to every
rem token. Until the first write the rule does not match, so the root stays at 100%, a scale of 1.

**Why.** Playtest 3 read the snapping world and the smoothly growing menu as two competing methods
(#586 D1). Each half needs its own rounding: a fractional stage scale blurs the pixel art, and a
snapped chrome jumps between sizes. `uiScale` uses CSS pixels only, so a dpr change leaves the chrome
alone, and `100%` keeps the browser's font-size preference in the product. `world.ts` is untouched
because it already reads the same pure function at the same event, so the smoothness contract does
not move. Borders stay px tokens so they land on whole device pixels. The selector is keyed on the
write because happy-dom cannot compute rem through a `calc()` root font-size (it reads `NaNpx`), and
suites such as `frame.test.ts` load the real sheet without the seam.

**Rules out.** A fixed-ratio letterbox: the visible tile count and the map margin absorb the
remainder, because a box would change how much world each window shows. Integer snapping of
`uiScale`, a second scale calculation elsewhere, and a px root size, which would override the
player's browser font setting. A dpr change with no size change fires no `resize` in Chromium, and
the seam stays resize-driven, so the world catches up at the next resize.

## Four message channels, chosen by one policy table

**Decision.** Every message the client shows has a `MessageKind`, and `client/src/ui/feedbackPolicy.ts`
assigns each kind to one of four channels. The **hint line** is a frame's feedback strip, or the world
line (`#status`) when no frame hosts it. The **toast** is one timed `.mr-toast` region (`ui/toast.ts`)
for outcomes. The **modal** is a confirm sheet for decisions. The **blocking text box** is the dialogue.
The table is a `satisfies Record<MessageKind, PolicyRow>`, so a kind with no channel fails typecheck.
`main.ts`'s sinks (`reportError`, `showNotice`, `sendGuarded` through `SEND_REJECT_KIND`, the battle
refusal, care) name a kind and `route` it. A toast is announced once through `#a11y-live` (the qf-6
notice pump) and hides after `TOAST_MS` of the frame clock. A persistent hint follows the top frame
(WF1-A9). On the main menu's strip it outranks the menu's own line: an action-required hint comes
first, then a persistent state, then a disabled reason, then a Y-description. Otherwise it sits on
`#status`, which is layered above every shell and below the toast. The strip is an overlay with zero
layout height: its height and negative bottom margin cancel, it sits in a 2rem bottom reserve on
`.mr-frame` and `.mr-shell`, and it is sticky with `bottom: -2rem`, because Chromium measures sticky
offsets inside the scroller's padding.

**Why.** Playtest 3 found that the old strip pushed the frame's content when it appeared (058). It
also found that the status line painted under every shell, so a rejection sent from the Monsters
sheet, or a disconnect, never reached a player with a frame open. One table means a view never
chooses its own channel, and the wireframes' channel table is checkable against the code. A toast is
never the only carrier of something the player must act on. An action-required toast row names the
on-screen state that also carries it, and the policy test pins that list.

**Rules out.** A per-view channel choice. Holding a battle refusal until the battle ends: it is a
timed toast now. A second live region: the toast is not one. New `.mr-frame*` or `.mr-shell*`
selectors for the strip. A multi-line strip: a long hint ends in an ellipsis and the live region
still says all of it. Frames whose strip is still view-owned (boxView, raisingView, and the per-view
lines that uif-4b moves) carry a persistent hint on the raised world line until their strips join
the seam.

## The Monsters action sheet is one corner-anchored ContextSheet; Summary is a page in the frame

**Decision.** A Monsters frame has one `ContextSheet` (`createContextSheet`, `client/src/ui/contextSheet.ts`,
root `[data-context-sheet]`), mounted in the tab content area `#monsters-panel` (`position:relative`,
`client/src/ui/boxView.ts`). `anchorSheet` puts it in a bottom corner away from the cursor cell, the top
corner if the bottom would touch that cell, else height-capped and scrolling. Nothing is dimmed; the tabs
and grid stay live. It is re-placed on every paint and on panel resize. One content shows at a time: the
sheet's rows, a sub-list (Feed…, Evolve…) or the Evolve confirm, all in the same root. Every row id is
`monstersSheet-root-<key>`; the heading keeps `monsters-sheet-name`. The sheet ends with Close, each
sub-list with Back (key `back`, `BACK_KEY` in `client/src/ui/monstersModel.ts`). A on either is B's step;
a held A does nothing. Summary is a page in the frame that replaces both grids, with the tabs kept. It is
not a sheet and adds no `OverlayId`. B or A returns to the sheet on the same monster; LB/RB close it to the
list on that tab, since a tab click has no sheet close before it.

**Why.** A sheet wedged between tabs and panels read as a stray panel (feedback 047). A fixed single corner
covers the selected slot for some slots. Beside-the-slot moves with every slot, and in-slot buttons break on
the grid, so only the detail page was adopted (wf-1, M-ui-foundation-wireframes.md "Verdict: sheet placement"). A
page gives Summary room for all stats without a second overlay.

**Rules out.** A fixed corner, beside-the-slot placement, in-slot buttons, a dim layer, a second sheet root
per sub-list, and a Summary implemented as a sheet or an overlay. Later sheets (Inventory uif-8, Social
uif-12) reuse this placement and the `kit.sheet.close` / `kit.sheet.back` rows.
