# Decisions

The design choices that constrain code in this repository today, and why. Each entry
says what was decided, why a reader could not easily re-derive it, and what it rules
out. `ARCHITECTURE.md` describes how the pieces fit; this file records the choices
behind them. When a decision changes, edit its entry in place — this is current
state, not a log.

## One repository, one cargo workspace

**Decision.** The four product crates (`game-core`, `client-wasm`, `server-module`, `sim-harness`)
are members of one cargo workspace in this repository, beside the TypeScript client in `client/`.
The server module and the prediction wasm consume `game-core` by path.

**Why.** The rule crate's whole value is that the client and the server compile the same code at the
same revision. Split across repositories it becomes a versioned dependency, and a version skew between
the two consumers is a desync. One repository also means one CI pipeline and no publish step for the
rule core.

**Rules out.** Extracting `game-core` (or an "engine") into its own repository or published crate;
letting the client and the server pin different revisions of it.

The crates and their dependencies: `ARCHITECTURE.md` "Workspace".

## One game, three ways to play: no code may assume we run the server

**Decision.** The same server module, rules crate and client are played three ways: a single-player
world on a server the game starts on the player's machine, a private server a player hosts for
friends, and the one official server. A way to play is a deployment — where the server runs and who
may connect — never a build of the rules. A deployment's module is built to trust the accounts that
deployment takes; the rules, the schema and the client bindings are the same in every build. A
character belongs to one world; nothing moves between worlds. Private worlds run the official rules
until modding ships after early access, and the code is written so that modding can be added: content
stays data behind one loader per registry, rules never name a specific content id, and each kind of
extension has one seam.

**Why.** Most players are expected to play alone or with a few friends, and early access is that
build; the official server follows. Three rule sets or three clients would triple every change and
let the ways to play drift apart. Isolation between worlds is what keeps the official server's economy
and ladder meaningful when anyone can run their own world. The design intent is `game-design.md` §14
in the harness's spec corpus.

**Rules out.** A server address, database name or operator-run service assumed in shared client or
module code (the connection target is configuration); an upgrade or migration step a person runs by
hand; telemetry that leaves a player's machine without their consent; client game code that exists
only in one shell (browser, desktop); a feature that cannot work with one player and nobody else
online; progress or collection content that requires another player (group content such as raids
stays attemptable alone); importing a character, monster, item or rating into the official server;
a rule or view that branches on a content id.

## SpacetimeDB is the server platform

**Decision.** The authoritative server is a SpacetimeDB module (`server-module`): tables, reducers,
scheduled reducers and generated TypeScript bindings. All rules stay in `game-core`; the module is a
thin shell around it.

**Why.** It is the one candidate that runs the same compiled Rust `game-core` authoritatively that the
client predicts with, and it supplies subscriptions, persistence and schema migration that would
otherwise be bespoke netcode. A custom Rust server (Axum/Tokio with Postgres and a sync layer)
re-implements all of that. Colyseus shares TypeScript, not the Rust core, and Nakama's Go/Lua server
cannot share it at all. Keeping the rules in portable `game-core` bounds the lock-in: a port re-wraps
the same core.

**Rules out.** Game rules in SpacetimeDB-specific code; a second game-state server beside the module;
adopting a game-server framework that cannot execute `game-core`.

The module's layout: `ARCHITECTURE.md` "server-module: the authority".

## PixiJS and TypeScript render the client

**Decision.** The client renders with PixiJS 8 in TypeScript. The renderer is a pure view of
authoritative and predicted state and owns none of it. One client constant, `TILE_PX`, ties visual
resolution to the grid; `game-core` works in integer tiles.

**Why.** For a 2D pixel-art game PixiJS gives a small bundle, mature web tooling and sprite and
tilemap performance. A Rust/bevy wasm client would remove the TypeScript boundary, but at roughly an
order of magnitude more bundle weight and with weaker web tooling, and that boundary is already thin
(generated bindings and the wasm exports) and checked for drift. Phaser's batteries (scenes,
physics, input) duplicate what `game-core` and the client shell provide. A custom WebGL or WebGPU
renderer is unjustified for 2D. A native or desktop client goal is the condition that would reopen this.

**Rules out.** Game state or rules in the render layer; a 3D-environment renderer; coupling rules or
netcode to pixels-per-tile.

How the client draws: `ARCHITECTURE.md` "Rendering".

## Rules are written once, in game-core

**Decision.** Every game rule lives in the `game-core` crate exactly once. The server module calls it
for truth; the browser runs the same compiled code through the thin `wasm-bindgen` shell in
`client-wasm` for prediction. A constant or a derived query the client needs is a wasm export, not a
TypeScript literal.

**Why.** A rule implemented twice drifts, and a drifted movement or battle rule is a desync: the
client predicts one outcome, the server commits another, and the player sees rubber-banding. A
hand-copied constant drifts the same way, only more quietly.

**Rules out.** Re-implementing a rule in TypeScript or in a reducer; copying a game-core constant into
client code; server-only code in the browser bundle, which is why `client-wasm` builds `game-core`
without its `spacetimedb` feature.

The exports the client reads: `ARCHITECTURE.md` "client-wasm: the prediction boundary".

## Determinism: integer math, injected time and randomness

**Decision.** `game-core` is pure and deterministic. A rule takes time as `Millis` and randomness as a
seed, both handed in by its caller, and computes in integers with overflow checks on in release
builds. Clippy bans wall-clock reads and unseeded or OS randomness workspace-wide, and a clippy
warning fails the lint.

**Why.** The same inputs must produce byte-identical output natively on the server and in wasm on the
client, and a replayed seed must reproduce a battle turn. A clock read or an ambient RNG inside a rule
makes that impossible, and an overflow that wraps silently in release (but panics in tests) hides
exactly the bugs tests exist to catch.

**Rules out.** Floats in rules, clock reads in rules, unseeded RNG anywhere in Rust. In TypeScript the
ban is not mechanical: client code may read `performance.now()` for rendering and pacing, and
`Date.now()` against a server-epoch column for display or an advisory gate whose readiness only a
wasm export over the game-core predicate decides (`care_remaining_ms` on the Monsters sheet); the
server re-decides on its own clock.

Where time and seeds enter: `ARCHITECTURE.md` "game-core: the rule layer".

## Integer damage formula with a seeded variance roll

**Decision.** Damage is one integer-only formula with `u64` intermediates: a base from level, power,
attack and defense, then the same-type bonus, type effectiveness, a variance roll in `85..=100` and
weather, each an integer ratio, and a floor of 1 for any hit the target is not immune to. The
variance roll is drawn from the battle's seed, which the server takes from `ctx.random()`.

**Why.** Balance tuning happens in content (species stats, skill power, the type chart), so the
formula itself has to be stable and bit-reproducible. Integers make it identical on every target; the
floor of 1 keeps a hit from ever doing nothing.

**Rules out.** Float math in combat; per-platform rounding; reading ambient randomness inside the
resolver, which draws only from the seed it is handed.

The formula term by term: `ARCHITECTURE.md` "game-core: the rule layer".

## Content is data compiled into game-core

**Decision.** Game content (species, skills, items, zones, maps, encounters, NPCs, dialogue, quests,
shops, abilities, heal locations, evolution paths, the type chart) is RON under `game-core/content/`,
one directory per registry, embedded into `game-core` at build time and validated there. The server
seeds its content tables from it only when its stored content version differs from
`CONTENT_VERSION`, so every content edit bumps that number; an eval enforces it.
Content is locale-agnostic: no content table has a locale column, and the client localizes.

**Why.** Content has to reach the client (prediction, maps) and the server (truth) from one source
with no runtime loading. Directory-per-registry files let content be added without editing shared
files. Without the version pin, edited content would silently never reach a live database. Localized
strings in content would turn every translation fix into a `CONTENT_VERSION` bump and a server
reseed, for text only the client renders.

**Rules out.** Hard-coding content in Rust or TypeScript; loading content at runtime; editing
`game-core/content/` without bumping `CONTENT_VERSION`; a locale column on content rows; localized
strings in RON content.

The embed, validate, seed and version steps: `ARCHITECTURE.md` "Content pipeline".

## Tactical content is part of the row it describes

**Decision.** A value the tactical engine reads about a skill, a species, a battle item or a zone's
wild encounters is a field of that row, and RON must spell it for every skill, species and encounter
table. Battle maps and the tactical tuning stay registries of their own. No content table has a
column for a tactical field. One `game-core` gate checks tactical content: CI runs it as ordinary
tests and the content sync runs it before any write. This is the target. The code still holds four
registries of tactical fields keyed by another row's id, and `docs/refactors/tactics-content.md`
gives each field's home and lists the slices that move each registry, in order.

**Why.** A skill's power and its reach are one balance decision, and the engine reads them together.
Kept as two entries that must agree by id, they let an author change one and forget the other, and
what notices is a join that names an id and no file. One row cannot disagree with itself, and a lever
left out is a parse error at that row. Nothing a player sees depends on keeping the halves apart: the
tactical data reaches the client inside the wasm module either way, and neither layout puts it in a
table.

**Rules out.** A registry of tactical fields keyed by the id of the row they describe; a tactical
field RON may omit for a skill, a species or an encounter table; a second copy of the lints in the
server; a column on a content table for a field only the engine reads; a made-up tactical value in a
content struct built from a table row (a rule takes the values it reads).

## Server authority: thin reducers in domain modules

**Decision.** The server module is split into domain modules, each owning its reducers and
the tables it writes. A reducer validates the caller (`ctx.sender()`) and the request, calls
`game-core`, and writes tables. A check that more than one module needs lives once, in one shared
helper, never copied per module. A module writes only its own tables; a write into another module's
table goes through a helper the owning module provides.

**Why.** Reducers are the only writers and the only trust boundary. Keeping them thin keeps every
rule testable without a database, and keeping each guard in one place stops PvE and PvP paths from
growing slightly different versions of the same check.

**Rules out.** Game rules inside reducers; a second copy of a guard; a module writing another
module's table directly.

The modules, the shared guards and the cross-module helpers: `ARCHITECTURE.md` "server-module:
the authority".

## Reject, don't clamp

**Decision.** Invalid input is refused with `Err`, never silently corrected: a request over a
cap, out of order, too large or not allowed in the current state fails as a whole, and nothing
in it is truncated, snapped into range or partly applied. A rejected reducer rolls back its whole
transaction.

**Why.** A clamped request succeeds with a result the caller did not ask for, and a client
predicting the unclamped version desyncs without any error to react to. An `Err` is visible,
logged, and leaves state untouched.

**Rules out.** Truncating lists, snapping values into range, or destroying overflow at a cap.

Where the server refuses, with examples: `ARCHITECTURE.md` "server-module: the authority".

## Table privacy: private tables plus owner-scoped views

**Decision.** Any table holding per-player state another player must not see is
private (no `public` in its `#[spacetimedb::table]`). Each owner reads their own rows
through a `#[spacetimedb::view]` whose body filters on `ctx.sender()`
(`server-module/src/schema.rs`): `my_monster_pub`, `my_inventory`, `my_player_quest`, `my_wallet`,
`my_conversation`, `my_account`, `my_pending_evolution_notices`, `my_battle` (either
participant), `my_trade_session` (either participant), `my_export_bundle` (`privacy.rs`), and the tactical set (`my_tactical_battle`,
`my_battle_units`, `my_battle_events`, `my_battle_clock` for either participant;
`my_battle_queue`, `my_battle_deploy`, `my_formation` for the owner). Some tables have no
client read path at all: `monster` (IVs, EVs, nature), `encounter` (spawn weights),
`battle_wild` and `battle_wild_unit` (wild individuality seeds), `battle_secret` (the
tactical seed), `battle_summary` (telemetry), `battle_action` (secret PvP picks),
`trade_session_snapshot` (the review copy of each monster offered in a trade session,
genes included), `move_intent` (each character's undrained input queue and seq guard;
`movement_tick` publishes a copy on the public `character` row), `last_position` (where
an account's character stood at its last disconnect), `heal_cooldown`,
`guest_claim`, `player_session`.

**Why.** Hidden stats, item stock, balances and a pending PvP pick are competitive
information. Quest progress is personal, and a public table sends every player's rows to
every client, a cost that grows with the stored accounts. The view body is the entire boundary, so each view takes only the
context: an extra "owner" parameter would let a caller choose whose rows to read.

**Rules out.** Marking a per-player table `public`; a view that takes an identity
argument. Tables that are public on purpose: content, `character`, `player`,
`profile` (the leaderboard; clients read only the members' rows and their own),
`leaderboard_top` (the top 100's identities, which their profile rows already show),
`battle_challenge` (both parties need it), and
`trade_offer`, which is drain-only: no reducer inserts a row, and
a row still in it leaves by `cancel_trade`, a disconnect, account deletion or its TTL
reaper.

## The leaderboard is a membership table that the client joins

**Decision.** The public `leaderboard_top` table holds only the identities of the top 100
profiles in the ladder order: rating descending, name ascending by UTF-16 code units, identity
ascending. The ranking module rewrites it from a full rescan of `profile` after each profile write
and at `init` and `sync_content`. The client subscribes `profile` joined to `leaderboard_top`, plus
its own row, ranks the rows it holds, and shows its own row marked `100+` when it is not a member.

**Why.** A whole-table `profile` subscription sent every profile to every joining client. Measured
2026-11-16: 2,440,223 bytes at 50,002 profiles against 5,041 for the join and the own row, and
about 7.5 ms of reducer thread per rescan at 50,000. The membership is an invariant recomputed
from `profile`, not an incremental guess, and display data stays in `profile`, so a rename or a
tombstone needs no second write; profile writes come at human rates. Names compare by UTF-16 code
units because the client ranks the rows it holds with JavaScript's `<`, and the two orders must
agree at the 100th place. The client holds no profile below the top 100, so a true rank there
cannot be computed.

**Rules out.** Subscribing `profile` whole again; copying display columns into `leaderboard_top`;
incremental or boundary upkeep, or a `rating` index, before the rescan's measured cost binds. Two
colluding account holders can loop challenge, accept, deploy and forfeit with no cooldown and pay
one rescan per loop; if that shows in the reducer-thread share, the next step is skipping the scan
when no written row is or becomes a member.

The rescan's callers, the query and the publish-without-`init` gap: `ARCHITECTURE.md` "Schema and
privacy model".

## Tactical battle privacy is structural; only the summary and the formation are exported

**Decision.** Every tactical table is private. Both participants read the battle, its units,
events and clocks through views joined through the `battle` anchor's two identity indexes; a
player reads only their own queue, deploy staging and formation; the seed, the wild units' seeds
and the summary have no view, and no participant-visible row says whether a plan is READY. Deploy
is reveal-by-copy: no unit row exists until both sides have locked, and while a PvP battle is
Deploying each participant gets the anchor with the other side's team empty. Of the tactical tables
only `battle_summary` and `player_formation` are exported, with the other side's identity and
per-side columns null, as the `battle` export treats the other participant.

**Why.** Whether a READY plan exists is the one fact an opponent could act on (design §6.3), and
the summary's whole-battle columns move only when a step the participants watched executes or the
battle closes, so not even a mid-battle export shows one. The seed replays every roll; a wild's
seed rebuilds a recruited wild. A roster seen before both locks would let a player deploy against
it, and the anchor keeps both rosters because the settlement writes HP back from them by position,
so the read path hides them. The opponent's clock is match state, not a secret. The queue and
staging are secrets while a battle runs and gone after it, and transcripts are deleted 24 h after
it, so an export would copy nothing durable of them; the summary and the formation are game state
an owner-keyed index query on an existing table provides, so the export scope rule includes them
(operator, monster-realm#755). A wild unit has no owner, so no index can key unit rows and they are
reached through their battle. Still revealed, and accepted: a PvP battle closed while Deploying is
returned as stored, the emptied side keeps its monster-id list, `player.lead_level` is public, and
a `QueueVoided` after a KO, a turn skip or the battle's end shows that a plan existed.

**Rules out.** A ready, queued or lock flag on `battle_unit` or `battle_tactical`; writing one
side's units at its own lock; emptying the stored anchor's teams while Deploying (the reveal would
have to rebuild them from the monster rows); a view over the seed, the wild units or the summary,
or one taking an identity argument; an exporter for any other tactical table; exporting the other
side's identity or per-side columns; a summary column that moves while a plan waits, unless the
export redacts it; an erase step that finds unit rows by owner or tactical rows only through the
anchor (wild units have no owner, and the reaper's first step can delete an ongoing wild anchor
before the sweep runs); settling a tactical anchor through the 1v1 write-back (its side-A XP and
currency grant is the asymmetry design §7 removes); a second caller of the rating update.

Views, deploy, settlement and the erase step: `ARCHITECTURE.md` "Schema and privacy model".

## Movement intent is private; the tick publishes it

**Decision.** A player's movement intent (the undrained queue and the monotonic seq guard) is
stored in the private `move_intent` table, one row per player character. The intent reducers, and a
battle start emptying the queue, write that row and touch no public row. The zone's `movement_tick`
is the only writer of the published queue and ack on the `character` row: it copies the private
pair there in the update that carries the position, writes the row only when something changed, and
publishes whenever the private pair differs from the published one, so the owner learns of every
accepted input within one tick. There is no view and no extra subscription; the owner reads the
queue and the ack from its own `character` row.

**Why.** A public row written per input is delivered to every subscriber of the table, so the
deliveries grow with the square of the players walking. With intent private, a walking character
costs one public row write per step. An owner-scoped view for the ack would be evaluated on the
module's single reducer thread for every subscriber on every write, which costs more of that thread
than the bytes it saves. Publishing position, queue and ack as one row in one transaction also
means the client can never see one without the others, so it cannot replay an input the position
already includes.

**Rules out.** A `character` or `player` write in an intent reducer; a view or a second public
table for the ack; any other writer of `character.move_queue` or `character.acked_seq`, except the
load-test build's placement reducer, which clears and publishes the queue in its row write as the
tick's warp arm does; a tick branch that holds an intent row and does not publish it.

The intent row's lifecycle and the publish step: `ARCHITECTURE.md` "Movement".

## An empty zone does no work; no state depends on a tick having run

**Decision.** A zone's `movement_tick` is scheduled only while a player's character is in
the zone: entering arms it, and the tick that finds no player's character resets the zone's
ambient state and removes its own schedule row, so every way of leaving (walking out through a
warp, disconnecting, timing out, account deletion) ends in that one path a tick later. State
is of three kinds. **Ambient** state, what the world does by itself and no player would miss
(today NPC wander), is frozen while the zone is empty and reset to its authored default as it
empties. **Player-caused** state (a quest step, an item taken, a purchase) is never reset and
needs no tick. **Time-driven** state (a respawn, a restock, a growth timer) is stored as a time
or a deadline and computed from elapsed time when next read. In a world with nobody connected
no `movement_tick` runs, and the one schedule that keeps running is the 60 s heartbeat, which
writes no row: every reaper is a one-shot armed when something is owed, and one that bounds a
table by age holds at most one row, at the oldest row's expiry, re-armed no sooner than its fixed
delay. Decided, not built (designed and measured in `docs/refactors/idle-tick.md`): an
NPC's step is written once, at rest, and the interval row stays, with nothing else about the tick
changed; removing the ticks that move nothing waits on the operator and, if built, rewrites this
entry.

**Why.** The same module runs on a player's own machine and on the official server. A tick for
every zone costs reducer-thread time and wake-ups in proportion to the zones, and a commit-log
write whenever it moves an NPC nobody is there to see. Resetting on the way out instead of catching
up on the way in means the jump home is never seen and the next player finds a known state with
nothing to wait for; the reset reaches only a client still holding the emptied zone's rows, which
does not draw it. One disarm path, driven by the tick, means a new way of leaving cannot forget to
disarm. The heartbeat is the operator's dead-man's switch: its log line says the module is alive
when nobody plays, and the alerting treats ten minutes without module log bytes as a stalled log
pipeline. A table's oldest row already says when its next reap is due, so a periodic sweep with
nothing due is a call that does nothing; the delay keeps a burst of inserts (a playtest run is
a scan and sort of the whole table; for the export reaper's bounded read the delay bounds the
transaction count) from coming back seven days later as one run each, and a row is still reaped
within one delay of its expiry. On SpacetimeDB 2.16.1 a transaction that writes no row adds
nothing to the commit log and sends nothing, so an idle player's log cost is the wandering NPC's
row written twice a step, and writing it once halves it. What the empty ticks still cost is a small
share of one thread for each zone with a player at rest. The operator asked for the ticks that move
nothing to go (disk, bandwidth, reducer thread), but removing them adds a table, a reducer and a
row lifecycle whose failed opening tick leaves a zone waiting for a key press. The operator kept them
and accepted a reduced-motion step drawn with no walking frame (2026-11-27, #888); the question returns
when the world has many zones holding a resting player.

**Rules out.** State that is correct only if a tick ran (a tick counter, a timer decremented per
tick, an effect that expires after N ticks of an unwatched zone); elapsed-time catch-up when a zone
is entered; a second schedule row for a zone; disarming from the paths that remove a character
instead of from the tick; resetting anything a player caused; arming every zone at `init` or
`sync_content`; an interval schedule for a reaper, or a periodic re-check after a failed run (it
would ride the heartbeat, which is to do nothing but beat; a failed run is accepted to wait for the
table's next write, the same recovery the per-entity reapers have); a schedule row for a table with
nothing to reap. Under either idle-tick design: a one-shot row for every tick (the host deletes
each in a transaction of its own and the next has to be inserted, which grows the idle commit log
and every tick of a walk, and a failed tick strands its zone); a slower interval for a quiet zone
(it still ticks, and swapping rows costs more log than it saves); an event table for position
(its insert is logged like a stored row's, and a client that connects mid-walk is sent nothing);
a wander step written twice once its single write has merged.

The arming paths, the reset and the reapers' shape: `ARCHITECTURE.md` "server-module: the
authority".

## `battle_summary` keeps the newest 100,000 battles

**Decision.** The private `battle_summary` telemetry table keeps its newest 100,000 rows by
`battle_id`, twice the 50,000 stored accounts the official server is sized for. Older rows are
deleted by a reaper that runs only when something is owed: the summary insert that takes the table
over the cap arms one run a fixed delay out if none is armed, as do `init` and `sync_content`, so
a database already over the cap at publish is reaped. A run never deletes a row whose battle still
has a `battle` or `battle_tactical` row (held: a live battle, a finished one whose anchor is kept,
an erased account's last battle), so the table can exceed the cap by the held rows.

**Why.** Every battle adds a row and nothing else removes one. 100,000 rows, about three days of
battles at 1,000 daily players, is more than the playtest's match-length and tuning reads need,
and it does not grow with the population. A live battle's row is skipped because the settlement
re-inserts a zeroed summary for a battle whose row is missing: deleting it would lose the battle's
telemetry so far and write a row that is wrong. The delay batches the inserts between runs into one
and holds the reaper, a scan and sort of the whole table (the key's accessor has no range filter
to walk only the lowest ids), to one run per delay. A run that left only held rows does not re-arm,
so a table held over the cap does not repeat that scan while no battle starts. A run's bound drains
about 27 rows a second, against the 0.35 battles a second the official server is sized for.

**Rules out.** An age-based TTL on `battle_summary` (the reads want a row count, not a window);
reaping a held row; a schedule row while the table is at or below the cap; a re-arm after a run
that left only held rows.

Delay, batch bound and arming: `ARCHITECTURE.md` "Schema and privacy model".

## A session resumes where it left off

**Decision.** A returning account's character appears on the zone, tile and facing its last
character had when the account's last connection closed. The position is saved at that last
disconnect only, in a private table owned by movement with one row per identity, and consumed at
the next join, so a row exists only while the account has no character. A first join starts on the
authored spawn. One fallback rule: the saved position is used when its zone still has a map and the
tile is walkable there, and otherwise the character starts on the world spawn facing South. The row
is not exported.

**Why.** With every session starting in zone 0, the spawn zone holds every player's first minutes
and is the population peak the per-client byte budget has to survive; and a single-player world
sent the player back to the start each time the game was opened. Saving at disconnect costs one
row write per session; saving per step would add a private write to every step for a value read
once. Keeping the character row across a disconnect would leave offline players standing in the
world, visible, counted as occupying their zone and keeping its tick armed. The world spawn is
the fallback because it is the one tile content guarantees walkable and connected to the rest
of the world: a nearest-walkable search can land behind a wall or in a pocket with no way out,
and zones have no authored entry point; a saved tile that content invalidates is rare and costs
a walk. A warp tile is kept because a warp fires only on the step onto its tile, and a warp's
arrival tile is the tile of the warp back, so a player who has just changed zone stands on one;
occupancy is ignored because characters block each other nowhere (a move asks only whether the tile
is walkable). An account in the game has no row, and its position is in its exported `character`
row; an export from an account that never joined omits it, an accepted limit, since the client
joins before it can ask and the next export from inside the game carries it.

**Rules out.** Writing the saved position from the tick or a move reducer; a row for an account
that has a character; a client-readable view of the table; restoring a position mid-session;
treating occupancy or a warp as a reason to move a resuming character; a second fallback rule or a
nearest-tile search; a zone-0 assumption in anything that runs after the join (tests and tools that
need the spawn use a new identity); arming zone 0 for a character that resumed elsewhere.

Where the position is saved, consumed, erased and re-keyed: `ARCHITECTURE.md` "server-module:
the authority".

## World rows are subscribed by zone

**Decision.** The client never subscribes `character` whole. Beside its base set, a connection
holds one subscription set for its own character row and one per wanted zone. The scope follows
the authoritative own row, never the map being drawn: the own row's zone, plus the destination of
every warp of that zone within four tiles of the own row's tile, so a destination's rows are held
before the warp. A new set is subscribed before an old one is released, and a set goes only after
the own zone's set has applied and it has stayed unwanted for 5 s. A failed own-row or own-zone set
is retried in place and then ends the connection, which costs the player the character row, not
the place; a prefetched set never gates anything. `player` stays in the base set, unfiltered, as
the world directory. No table, reducer, view or binding is involved: the queries use `character`'s
primary key and its indexed `zone_id`, so the client works against any published module.

**Why.** `character` is the only public table written on every step, so an unfiltered subscription
delivers every step of every player to every client. Measured on a local host on 2026-11-12, every
player walking: 57 KB/s per client at 500 players unscoped, against 5 KB/s in a zone of 50 and 9.5
in a zone of 100 scoped, and walkers in another zone cost a scoped client nothing (2.6 KB/s beside
20 walkers, 2.5 after 100 more walk in zone 1). Without the prefetch every warp drew the arriving
zone without its NPCs and players for 1 or 2 frames on loopback and 17 at a 300 ms round trip;
with it, only a round trip longer than the walk from the prefetch line, or a move into a zone
by no warp, still does. `player` is written at join, leave, a rename, a lead-level change and
account deletion, never per step, so scoping it would save little and change what the Players tab
lists. The own-row set keeps the warp path intact: while it is held, the host delivers a warp as
one update of the own row (no insert and no delete in 3,417 measured warps), so the zone switch
and the row's position, queue and ack arrive together as they do unscoped. The rest was measured
on SpacetimeDB 2.11.0, not assumed: the host shares a query among subscribers by its SQL text
(50 clients in one zone add one zone query between them, plus 50 own-row queries), which is why
one module builds it; both queries are pruned by value, so a write is evaluated only against
its own zone's and its own row's queries (2 evaluations per write at 20 and at 120 walkers);
an applied set's rows are consistent with the updates that follow (no gap and no duplicate in
8,400 compared sequences), and an unsubscribe returns its rows as deletes, so the store needs no
re-seeding and no sweep; a rejected set fails only its own handle and subscribing inside a row
callback is safe, which makes retrying in place possible, where a reconnect replaces the character
with a new entity; and a subscribe and unsubscribe pair costs about 20 µs of the database thread,
which the linger bounds to one pair per zone per 5 s for a player pacing across a door, who also
re-downloads nothing. The own-row query is the design's whole thread cost, about 3.4 µs a step,
the same at 100 and at 500 walking players (0.9 % of the thread at 500 walking players, 1.7 % at
1,000), inside the budgets it was sized for (the database thread under 50 %, a tick's p95 under
the step interval, input round-trip p95 under 50 ms, 20 KB/s per client), and the zone query alone
measures 1.6 % more thread share than the unfiltered subscription; if thread share binds, the next
step is an own-row query held only until the zone's set applies and issued again if the own row is
lost. Scoping `player` waits until the directory measures above 1 KB/s per client or the population
target passes about 5,000 concurrent players; its shape is a cold, zone-indexed roster with one
owner module, counterparts' names read by identity, shipped server-first with a client fallback for
older modules.

**Rules out.** A `character` query in the base set, or one with no `WHERE`; building either query's
text anywhere but one client module; taking the zone from the drawn map or assuming one; taking
the prefetch position from the predicted tile, or the warps from the drawn map; a prefetched zone
on the own zone's retry ladder or timeout, or its age or rejections as a prefetch counted once
the player is in it; a standing subscription to every neighbouring zone; releasing the old zone
before the new one is applied; unsubscribing on a dropped connection; drawing characters on a new
connection before the scope has settled; subscribing a zone for a client that has no own character
row; a sender-scoped view of "players in my zone" (a view is evaluated on the reducer thread for
every subscriber on every write); scoping `player` before its trigger.

The sets, the prefetch, the linger and the failure path: `ARCHITECTURE.md` "Connection and store".

## Bounded client prediction

**Decision.** The client never predicts further ahead than the server would accept. The predictor
refuses a move past the server's queue cap (`MOVE_QUEUE_CAP`, the game-core value) and applies
backpressure at 16 unacknowledged operations. It records queue *operations* (enqueue, set, clear)
rather than raw moves and replays them onto the server's queue on reconcile. The acknowledgement
it prunes against arrives in the own `character` row, with the queue and the position. A rejection
addressed to a predictor that a warp or a reconnect discarded does nothing, and a rebuilt predictor
starts its sequence numbers above the highest one already sent. Zone warps resolve only on the
server, in the zone's movement tick, and the client never predicts a zone crossing. It learns of
one as a single update of its own `character` row, which its own-row subscription holds across
the change of zone. A mover with no player row never takes a warp, so an NPC never leaves its home
zone.

**Why.** A client that runs ahead of authority has to pull the player back, which is the
rubber-band this architecture exists to prevent. Recording operations instead of moves is what
makes a mid-flight set or clear replay correctly. A warp changes the map the predictor runs on, so
only the server can resolve it; keeping every NPC in its home zone keeps NPC movement local to one
zone's map.

**Rules out.** Unbounded local queues; dropping unacknowledged ops to make room; reusing a sequence
number after a rebuild; predicting a zone crossing client-side; an NPC crossing zones.

The predictor's intent, drain, reconcile and rejection steps: `ARCHITECTURE.md` "Prediction and
reconciliation".

## Held keys: commit threshold and warp continuity

**Decision.** Movement is driven by virtual D-pad edges, counted per button across physical keys,
so releasing one key does not stop another held for the same direction. OS key-repeat drives
neither movement nor menus; a menu repeats on an injected clock instead. A press sends one
`Face` at once; a release sends nothing. A hold continues with `Step`, which the frame loop, or
the reconcile after a server correction, sends only after the key has been held for the commit
threshold (150 ms), only when the predictor has no outstanding steps and no sent input is still
owed, and only while the world base takes input (no frame or sheet above it, the session gate
open); a tap only turns. Every push of a frame, and every change of base kind, clears the held
set. A zone warp keeps the held set across the prediction reset; a reconnect does not.

**Why.** Key-repeat rates vary by OS and flood the server. The threshold separates a tap
(one input) from a hold (a walk), and waiting for outstanding steps stops the client queueing
moves faster than the server drains them. One step in flight is also the measured choice over
two (`docs/send-pipeline-depth.md`). Against a local server a second gives a watcher nothing,
since a step already lands on every tick. It multiplies teleports of the own avatar unless only
the frame loop sends it, and either way it fills the server's queue, which then refuses a press
made mid-walk, and adds a tile to every committed hold. The cost of one step falls on a player
whose delay each way nears half the step interval: steps miss ticks and the walk drops toward half
speed. The continuation sends `Step`, which turns and moves in one input, so a walk that falls back
to a second held key or resumes after a server correction does not stop for a turn slot. Keeping
the set across a warp lets a player walk through a door without re-pressing. A walk that resumes
behind a closing menu is a step the player did not ask for, and stale hold stamps would skip the
commit threshold. A step sent and then cancelled on keyup would take back steps the predictor has
already drawn, pulling the own avatar backward.

**Rules out.** Repeat-driven movement or menus; continuation steps while earlier ones are in
flight; a step cancelled on keyup (`clear_queue` or `set_move` on release); resuming a held walk
after a frame closes; `Step` on a fresh press (a tap would move instead of turning); `Face` from
the continuation.

The router, the held set and the owed inputs: `ARCHITECTURE.md` "Prediction and reconciliation".

## Turning in place: `Face` turns, or steps when already facing

**Decision.** `MoveInput::Face(Direction)` is a press of a direction. game-core's one movement rule
turns a character that does not face it, in place, and gives one that already faces it exactly the
`Step` result. `Face` travels on the existing `enqueue_move` and `set_move` reducers and drains
like any other input, so a turn takes one movement slot on the server and in the predictor's
replay, and it passes the same battle locks, deletion gate and sequence guard. The variant is
appended after `Jump`.

**Why.** The operator ruled that a player faces a direction before moving in it (feedback item
pt3-2026-10-165), and interaction targets the faced tile, so facing needs an input that does not
move. The turn-or-step choice is made when the input drains: the server and the predictor then
both judge it against the facing left by the inputs before it, from the same compiled rule, and the
client never works out an "effective facing" of its own. The existing reducers already carry every
guard a movement input needs.

**Rules out.** A separate facing reducer (a second intake path with its own battle lock, deletion
gate and seq); an extra reducer argument (it changes every caller and the signature of a reducer
every deployed client calls); changing `Step` itself (NPC wander and the bump rule use it);
choosing between `Face` and `Step` at intake or on the client; marshaling a variant the client
does not know as `Step`; publishing a module that adds a `MoveInput` variant apart from the client
bundle that decodes it — a bundle built before the variant cannot decode a `character` row whose
public queue holds one, whoever queued it.

The rule's two arms and how `Face` crosses the wasm boundary: `ARCHITECTURE.md` "Movement".

## Reconnect backoff climbs one rung per failed attempt

**Decision.** The client owns its reconnect policy: a pure state machine that its connection
adapter drives. After `n` failed attempts in a row, the next attempt waits `min(1000 ms · 2^n,
30 s)`. The ladder has no give-up rung. Two things stop retrying: a session terminal (an expired
account session, an unreachable auth service) until the player retries or continues anonymously,
and the protocol check's refusal, which lasts until reload. Every build path starts an attempt,
and every attempt that fails climbs exactly one rung, whether it ends in a connect error, a drop
after the socket opened, or both in either order. A failed attempt is marked, so a second event
for the same failure changes nothing. Only an applied subscription resets the ladder. A drop from
a connected link does not climb, so its first retry waits the base delay. The "connection lost"
notice shows on the connected-to-disconnected edge only.

**Why.** The SDK does not reconnect on the raw builder path, so the app owns its retries. A
restarting host often accepts the socket and drops it before the subscription applies. If only a
connect error climbed, that client would retry every second for as long as the restart lasts. The
SDK can report one drop as both an error and a close, so the ladder counts failed attempts, not
failure events.

**Rules out.** Resetting the ladder when the socket opens, or on anything but an applied
subscription; climbing once per failure event; a build path that does not start an attempt; a
give-up rung on the ladder.

The policy module and the build paths: `ARCHITECTURE.md` "Connection and store".

## Remote interpolation: adaptive delay; hold, except a bounded continued walk

**Decision.** Other characters render at `now − delay` between buffered snapshots. The delay
adapts per character from a jitter estimate that ignores intervals longer than three steps
(idleness), bounded between 0.5 and 2.5 steps. The store keeps one snapshot per position: a row
update on the same tile replaces the row and is neither a snapshot nor a jitter sample. At the
newest snapshot a remote holds position, with one exception: a remote whose last two position
changes were the same one-tile step, at most three steps apart, the newer at most three steps ago,
and which has not turned in place since, is drawn on past its newest tile at the walk's cadence,
at most half a tile and only toward a walkable tile.

**Why.** Snapshots arrive in bursts: a fixed delay either pops under jitter or lags all the time,
and treating a pause as jitter would inflate the delay after every stop. The own client sends one
step at a time, so a walker's row stream often has an empty tick between steps, on which the server
writes a same-tile `Idle` row. Holding at the newest snapshot draws that as a pause on every tile,
so the operator ruled that a remote continues its last walk for a short window and then settles
(feedback item pt3-2026-10-159). A stop is only known when the window runs out, so the half-tile
cap is also the backward correction a stop can show.

**Rules out.** Continuing a remote that is not on a straight walk, farther than half a tile, past
the window, or toward a tile that is not walkable; continuing from a single step (a tap, an NPC's
wander); appending a same-tile row to the snapshot ring; a single global interpolation delay.

The interpolation core and the resolver's two arms: `ARCHITECTURE.md` "Rendering".

## Integer pixel scaling

**Decision.** The renderer chooses an integer device scale (source pixels to device pixels) from
a target visible tile count, and runs Pixi at the display's device-pixel ratio, so the CSS stage
scale is that integer divided by the ratio and is fractional whenever the ratio is not 1. When the
map is smaller than the viewport, the camera centres it. Terrain chunk textures bake at resolution
1 with nearest sampling at every device scale. The integer device scale upsamples each texel to a
whole number of device pixels, so a device-scale change re-bakes nothing; a context restore still
re-bakes.

**Why.** Non-integer scaling blurs or shimmers pixel art. A chunk baked at the device scale costs
the scale squared times one baked at resolution 1, which costs 4 KB per tile: 36 times as much at
device scale 6, the scale a full-screen 4K window gets.

**Rules out.** Fractional device scales; fitting the map by stretching; baking terrain at the
device scale, or re-baking it when the device scale changes.

The viewport's scale choice and the chunk bake: `ARCHITECTURE.md` "Rendering".

## Evolution graph and the auto-evolve rule

**Decision.** Evolution is a graph of authored edges. Each edge carries a durable, never-reused id
and AND-combined requirements: a minimum level, per-affinity essence amounts, and optional Trust,
Quality-Time and Nutrition thresholds. Every edge advances species tier by exactly one. One shared
game-core query decides eligibility. After any write that can change eligibility, the server
evolves a monster automatically only when exactly one edge is eligible, and repeats against the
new species, up to a fixed chain cap. With zero or several eligible edges it does nothing, and
the player chooses; the server then looks up the one edge matching both endpoints. Each applied
evolution queues a reveal that only the owner reads.

**Why.** Automatic evolution is convenient, but when a monster qualifies for two branches at once,
picking for the player would silently close off the other branch. Content should keep requirements
different enough that this is rare.

**Rules out.** First-match auto-evolution; evolving along an edge the client names without an
endpoint check; reusing or renumbering an edge id; publishing evolution history to other players.

The edge table, the query, the chain and the reveal queue: `ARCHITECTURE.md` "Battles, trades and
the rest", Evolution.

## Recruiting a wild monster

**Decision.** A successful recruit rebuilds the exact wild individual from its private
individuality seed, at full HP, and takes the wild off the board. Recruiting the last conscious
wild wins the battle for the player, as a knockout would. A recruited wild is not a knockout, so it
earns no battle XP.

**Why.** Rebuilding from the stored seed means the monster the player caught is the one they fought
— same IVs and nature — and keeping the seed server-side means no client can inspect a wild's
genes before deciding to catch it.

**Rules out.** Re-rolling the individual at catch time; exposing wild genes to the client.

The seed rows and the recruit hook: `ARCHITECTURE.md` "Battles, trades and the rest", PvE, and
"Schema and privacy model", Tactical battles.

## Trading resets the bond, not the monster

**Decision.** A trade resets each transferred monster's seven Trust and Quality-Time counters to
`0`, through one game-core rule that the server copies the columns through; the server never zeroes
them itself. Level, species, nickname, IVs, EVs, nature, XP and the eight essence pools transfer
unchanged. The public Trust and Quality-Time tiers re-derive from the reset counters (Neutral and
0), while the evolution tier carries over. The guest-claim identity re-key is the same trainer
under a new identity and does not reset the bond.

**Why.** Trust and Quality-Time measure the relationship with the current trainer; essence is the
monster's own. Unfavorable trust resets with the rest — a faint history is also a relationship
with the old trainer — so a round trip through a second account clears a Hostile tier; that is
the accepted price of the rule. See <https://github.com/mdrewt/monster-realm/issues/479>.

**Rules out.** Halving or otherwise taxing essence on trade; carrying the bond across owners;
re-implementing the zeroing in the reducer or in TypeScript; resetting on the guest-claim re-key.

The swap, the seven columns and the rule: `ARCHITECTURE.md` "Battles, trades and the rest", Trade
sessions.

## Trade sessions open face to face, one per pair, and are never one-sided

**Decision.** A trade is a session that two players open face to face (the client offers it only
toward a player on the tile the opener faces, or on the opener's own tile when nothing is in front,
and the server refuses a partner out of interact range) and then edit, confirm or cancel from
Social › Trades. Each side offers any mix of monsters, items and currency. Two players share at
most one session, whichever of them opened it, and a player may have at most four sessions they
opened; sessions others opened with them never count. A confirmed side cannot edit (cancelling is
the way out), and a confirm names the session revision it reviewed: every accepted edit advances
the revision and clears both confirms. A confirm is refused when either offer is empty or when
the side would own no monster afterwards, and no other soft-lock check exists. A received monster
takes the receiver's lowest free party slot, else Storage; the receiver's party size never refuses
a trade.

**Why.** The operator's trade-scope ruling (monster-realm #585): all three asset classes,
face-to-face initiation, one active trade per pair, no one-sided gifts, simple soft-lock guards
("90% of cases with 0 false positives" beats a frustrating 95%), arrival in the party else
Storage. Counting only the sessions a player opened stops sockpuppets from locking someone out
of trading, and never reading the partner's count keeps the cap from answering questions about
them. The revision makes "each side confirms what it saw" hold under concurrent edits.

**Rules out.** Opening a trade remotely; two sessions between the same players; a cap that
counts sessions others opened or reads the partner's count; gifts; soft-lock heuristics beyond
the last-monster count; refusing a trade because the receiver's party is full; a separate execute
reducer; a confirm that names no revision.

The session row, the open cap and the side and arrival rules: `ARCHITECTURE.md` "Battles, trades
and the rest", Trade sessions.

## Economy: bounded balances, headroom before transfer

**Decision.** Currency is a private `u64` balance capped at 999 999 999, and every payment and
every charge goes through one grant and one spend helper. Item stacks cap at 9999. The confirm
that executes a trade session checks receiver headroom first, and the swap applies debits before
credits, so a trade either happens completely or not at all. Escrow is a guard, not a hold:
a guarded asset cannot be spent, sold or evolved. A trade session locks at confirm: a side's
monsters, items and currency are guarded only while that side is confirmed. The shared guards count
a confirmed session side and any legacy offer row still in its table; that table is drain-only, and
its propose, respond and confirm reducers refuse every call without reading a trade or asset row,
so no reducer names another player's assets. An unconfirmed side locks nothing beyond exclusivity
(a monster sits in one trade at a time), so each confirm first compares every offered monster with
its private review snapshot and, on a difference, refreshes it and clears both confirms instead of
confirming; the confirm that completes the pair re-runs the full side check for BOTH sides on live
rows before anything moves. A failure on the other side clears that side's confirm and tells the
caller nothing more. Each side names only its own assets: no trade reducer acts on an argument
naming the other player's. The client carries currency as `bigint` from the store row to the
reducer argument.

**Why.** Reducers run serially, so check-then-write in one reducer is atomic, and escrow rows would
just be a second source of truth. `u64` balances exceed JavaScript's safe integers, so `Number()`
parsing would corrupt large amounts.

**Rules out.** Physical escrow rows; credit-then-debit ordering; parsing currency with
`Number`/`parseInt`.

The wallet, the caps, the swap order, the guards and the snapshot: `ARCHITECTURE.md` "Battles,
trades and the rest", Trading, Trade sessions, and Raising and economy.

## Healing is free, and quests are the recruit loop's faucet

**Decision.** Every shipped heal location charges nothing: no currency cost, no cost item,
no cost quantity. The heal charges whatever a heal location names, so the price is data and
the shipped data names none. A successful recruit pays no currency; wilds knocked out earlier
in the same battle still pay their battle reward, so a battle against a lone wild that ends
in a recruit pays nothing. Quest rewards are the faucet for recruit-heavy play: one quest
ships, its currency reward is content, and the server credits exactly what the content names,
once. With a full party, recruit-heavy play in zone 0 buys a Lure Berry within a fixed battle
budget. `docs/economy-tuning.md` holds the reasoning and says where each number lives.

**Why.** The economy is not a major part of the game (operator's balance stance): items,
prices and rewards are tuned as for a single-player game, and every number must feel fair to
one player with nobody to trade with. A heal charge is then a sink against one player's faucet
and it taxes losing. A recruit pays nothing because the monster is the reward (operator ruling,
<https://github.com/mdrewt/monster-realm/issues/587>), so a player who mostly recruits has less
battle income than one who mostly fights; a quest pays for play that is not knocking wilds out. A
wild pack is clamped to the conscious monsters in the party, so a small party earns less from
recruit-heavy play and a one-monster party meets only lone wilds. No mechanic consumes a monster
(there is no monster sink).

**Rules out.** Charging currency or an item to heal as a currency sink; paying currency for a
successful recruit; restating prices, rewards or battle budgets in prose docs; raising battle
payouts, cutting shop prices or raising the sell price's fraction of the buy price to fund
recruit-heavy play. A heal charge, a recruit payout or a monster sink changes the reasoning, so it
changes the worksheet and this entry together.

## Battle lifecycle and PvP

**Decision.** The battle table is private; participants read it through an owner-scoped
view. Everything a battle must block checks both battle roles through the shared guards: a
per-player predicate (movement, guest claims and the other player actions), or, for evolution
and a trade side, a per-monster one. Movement is blocked twice: the movement tick drains nothing
for a player in a battle, and new moves are refused mid-battle. A battle start also empties each
battler's private move queue on the server, keeping the sequence guard, so a step queued before a
battle never runs after it. Accepting a challenge opens a tactical battle: secret queue rows under
a 30 s window each time the battle waits on a unit, forfeit on the fourth auto-pass or the last
connection closing. Challenges expire after 120 s. Only battles between two distinct real players
change the public rating (Elo from 1000, no floor). When an identity's last connection closes,
its live trades, PvP battles, wild battles and challenges are resolved. Ranked PvP requires both
players to hold an account, but this is inactive until a real OIDC issuer is configured.

**Why.** Every blocking rule reads the same guards, so PvE and PvP cannot drift apart. Disconnect
handling keys on the *last* connection, so a second tab or an overlapping reconnect cannot forfeit
the player's battle. The server drops the queue itself because a stale or hostile client would not
send `clear_queue`; the drain lock alone only postpones the queued steps until the battle ends.

**Rules out.** Per-call-site battle checks; forfeiting on any single socket close; rating practice
or wild battles; relying on a client-sent `clear_queue` to end pre-battle movement.

The guards, the disconnect sweep and the 1v1 tables no live path writes: `ARCHITECTURE.md`
"server-module: the authority" ("Lifecycle"; "Battles, trades and the rest", PvE and PvP).

## Queued actions halt-and-return; the idle clock resets on every accepted submit

**Decision.** At pop, the first queued entry that fails its pop-time check and every later one
are wasted: never executed, no AP charged, never retried, visible only as a `PlanHalted` event
naming the unit, the index and the failure kind. Control returns live to a player-owned conscious
unit with at least the cheapest action's AP (2), else the turn ends committed. The idle clock runs
only while the battle waits on a player's unit; each accepted submit for it closes the window, and
re-entering the wait opens a fresh full one after the capped presentation pad. A live submit whose
first entry fails is refused and changes nothing, clock included. PvP-ruleset expiry auto-passes
without Guard and the 4th strike against one side forfeits; wild expiry auto-flees. The planner,
inventory, recruit headroom and Item/Recruit/Flee resolution reach the executor only through one
hooks trait; a hook may add only recruit, award and status events and never decides the outcome
(the terminal sweep does; a flee is `Fled` whatever the hook did).

**Why.** Paying AP for a non-event reads as economy theft, the most-resented pattern in the
reception corpus; halting means nothing executes from a board the plan did not assume. The
clock takes the "resets the moment they submit" ruling (D583.2) literally; refusing a submit
that executes nothing stops zero-cost resubmits refilling the clock forever. The executor knows
no inventory, recruit or planner rule: each arrives through a hook the server implements over
game-core, so the turn order and the AP accounting stay in one place.

**Rules out.** Charging the first invalid entry's nominal AP (design §12 Q2's alternative); a
cumulative per-unit-turn clock (§12 Q1's); skipping past an invalid entry (conditional scripting);
trusting a client-sent tile (a Skill re-aims at its bound unit, a Move re-paths); wiring a rule
into the executor except through the hooks. Accepted reveals: the halt's failure kind names why the
first discarded entry failed, and `QueueVoided` shows that a plan existed.

The gate, the clock and the hooks: `ARCHITECTURE.md` "game-core: the rule layer", Tactical engine.

## Tactical settlement derives the reward ledger from the transcript

**Decision.** A tactical battle's rewards (design §7) are settled once, at its finish, by folding
the persisted battle-event transcript into game-core's reward rules: each knockout is credited
to the attacker of the last opposite-side hit on the victim, against the final board with the
units not yet fallen restored. The payout goes through the same per-monster credit as every
other battle reward, over the whole conscious party, and is shown as award lines appended after
the battle's end. The win-only credits (daily trust-favorable, Quality Time, the evolution check)
need a defeated wild, so a recruit-only win pays nothing. The battle summary is one row per battle,
inserted when play starts and accumulated every step. One anchor, one payout path.

**Why.** Nothing in game-core calls the KO hook, and the shell sees the board only between
transactions, so the KO moment is observable only through the transcript; consciousness is
monotone in P1 (no heal or revive), which makes the reconstruction exact. Reusing the per-monster
credit keeps one write-back funnel and the carried trust/Quality-Time scope. The summary's
windows-per-unit-turn and pre-queued/live counts are not derivable from events, so they accumulate
per step. A 1v1 turn on a tactical anchor would pay twice.

**Rules out.** A second ledger store or a per-KO reward write mid-battle; recomputing the killer or
the split on the client (it renders the award lines as they are); a headroom check for recruits (no
monster-storage rule exists; the predicate is "the unit has an owner"); paying the win credits on a
recruit-only win. Moving the fold and the attribution into game-core's reward rules is due with the
first slice that adds a heal or revive.

The fold, the credit and the summary row: `ARCHITECTURE.md` "Schema and privacy model", Tactical
battles.

## Tactical rule conventions carried from bt-2

**Decision.** In a wild battle side A is the player: only it is player-owned and it holds round-1
tie priority. Both coins, the round-1 PvP priority coin and the adjudication coin, read the low bit
of a `splitmix64` draw, with 0 → A. Practice runs the PvP ruleset through one mapping from the
battle kind. A wild mutual wipe is a loss for the player, by fixed order. Every target of an attack
draws an accuracy then a variance roll, hit or miss. Flank is judged on the board captured before
the attack. Freeze thaw rolls come off the battle's one roll stream. The wild round cap fires on
`round >= cap`. First-Stand clears when it saves the unit, as well as at its first TurnStart.

**Why.** Each looks arbitrary in the code and is easy to flip, but the executor builds on them (who
is player-owned decides who may use an item, recruit, flee or run a clock). Every roll comes off
one counter, so one added or skipped draw moves every later roll of the battle.

**Rules out.** A round-1 coin in a wild battle; matching on the PvP battle kind alone, which runs
Practice as PvE; adjudicating a wild mutual wipe, or a draw outcome (the outcome type gains no
variant); one roll shared by an attack's targets, or no variance draw on a miss; flank re-read
after an earlier KO in the same AoE; a second RNG stream for status rolls; `round == cap` (the
spec's wording); a First-Stand that survives its own save.

Where each convention lives: `ARCHITECTURE.md` "game-core: the rule layer", Tactical engine.

## Wild AI plans are a pure function of the public board

**Decision.** The wild planner takes no RNG or seed parameter. It reads a private view of the
board with no seed, roll counter or budget field, and costs every candidate plan from a fresh turn
budget, never the unit's stored one. The executor hands it the public view (seed and roll counter
zeroed), halts any entry but Move, Skill or EndTurn as a bad shape, and runs every entry, the
trailing EndTurn included, through the same pop-time check as a player plan. The planner therefore
calls the gate's path search, target, disengage, stride and validity rules and restates no rule. A
stance that needs randomness must move it into server-pushed battle events. The planner's signature
forbids the parameter and the view keeps the seed and roll counter out by structure; the view's
units still expose a budget, so tests are what catch a regression there.

**Why.** Design §4.2 has the client compute each intent chip with the same wasm `plan` on the
shared provisional board, so chips and forecasts never contradict each other. That board has no
seed and shows stored budgets, while the server plans just after `turn_start` refreshes the wild's;
reading neither keeps chip and execution equal on an unchanged board. A refused entry halts the
wild's plan at `PlanHalted`, as it would a player's; with no player to return control to, the
wild's turn ends.

**Rules out.** A seed or RNG parameter; reading the seed, the roll counter or the unit's stored
budget; a hidden PRNG; a TypeScript planner; range, cost or stride math re-implemented in the
planner.

The planner's inputs and the checks that hold them: `ARCHITECTURE.md` "game-core: the rule layer",
Tactical engine.

## Accounts, guest identity and the claim flow

**Decision.** Anonymous play is first-class: every connection gets a SpacetimeDB
identity, and `on_connect` never rejects a connection for having no account (a world whose access
rule is not `Open` refuses an identity it has not admitted, account or not: see "A world that is
not open refuses an unadmitted identity at connect and in every reducer; the owner relays the
door"). An
anonymous connection is accepted but cannot join on a build that enforces ownership (see
"Ownership is enforced unless a dev feature switches it off"). An
`account` row is created only for a JWT from an allowed issuer and audience
(`ALLOWED_ISSUERS`/`ALLOWED_AUDIENCE` in `server-module/src/accounts.rs`; `ALLOWED_ISSUERS` is the
build's own login-issuer list, computed from its cargo features). A token from an unrecognised issuer falls back to
anonymous play; a token from an allowed issuer with the wrong audience is disconnected.
An account holds no PII: `Identity = f(iss, sub)` keys everything. A guest moves their
progress to an account like this. The browser mints a 256-bit claim code
(`crypto.getRandomValues`, `client/src/net/claimCode.ts`) and registers it with
`start_guest_claim` *before* redirecting to sign-in. After sign-in, the account
identity calls `complete_guest_claim`, which runs every caller-state guard before it
looks up the code, then re-keys the guest's persistent game data onto the account
(`rekey_all`: monsters, inventory, quests, wallet, profile and the rest; the retired guest keeps
a dialogue-state tombstone, see "The starter is a once-per-identity grant recorded by a marker;
ownership is never the test"), purges the guest's export bundles, erases the guest's world rows (admission, wrong-password record, binding and bind nonce; none is moved, so a retired guest identity that reconnects holds no world row), erases the guest's finished battles as the deletion
cascade erases its subject's (`schema::erase_tactical_rows`, then
`battle::anonymize_battles`: the per-battle tactical rows go, and the guest's side of
each `battle` and `battle_summary` row becomes the tombstone identity), and consumes
the code. The destination must own no game data. That holds because the client does not call `join_game` on a signed-in
connection while an unconsumed claim code is stored; it claims first
(`client/src/net/connection.ts`). A claim expires after `CLAIM_TTL_MS` (15 min),
cleaned up by a scheduled reaper.

**Why.** The server never generates the secret, so its strength does not depend on
the server's RNG. Checking caller state before resolving the code means the reducer
cannot be used to test whether a code exists; malformed and already-used codes return
the same error. Registering the code before the redirect is what lets the claim
survive the round trip to the identity provider. A finished battle is history shared
with an opponent, not progress, and the guest identity retires at the claim. Nothing
else reliably removes what names it: every sweep and the 24 h GC keep `battle_summary` (only
its cap reaper deletes rows, oldest first, once 100,000 newer rows exist),
a wild or practice anchor is swept only on its own player's next battle, and a PvP
anchor waits on the opponent's next battle in the same role.

**Rules out.** Server-minted claim codes; storing email or JWT subjects; rejecting a
connection for being anonymous; widening the audience allowlist to more than this game's client;
re-keying battle rows onto the claiming account (a re-key helper per tactical table, to
carry history that only telemetry reads).

## The starter is a once-per-identity grant recorded by a marker; ownership is never the test

**Decision.** A first `join_game` grants the starter monster and the starter kit, once per
identity. The kit is data (`game-core/content/starter_kit.ron`: 200 gold, 2 Lure Berries, 1
Antidote), checked at publish by `validate_starter_kit`. Kit items are ordinary items: they can
be traded and sold. The join shows no notice for the kit, because the wallet readout and the Bag
already show it. The grant is recorded by the flag
`sys:starter_claimed` in the owner's private `player_dialogue_state.flags`, set in the same
transaction as the kit. `onboarding::starter_grant(claimed, owns_monster)` is the rule: a set
marker grants nothing, whatever the identity owns; an unset marker grants the kit, and the
monster too unless the identity already owns one. The kit is granted whole or not at all: it is
checked against the stack and balance caps first, and a kit that does not fit is skipped with a
`starter_kit_skipped` log line, leaving the marker unset so the next join tries again. A kit
that fails to load refuses the join before anything is written. The `sys:` flag namespace is
reserved for the server: `validate_npc_content` refuses any dialogue condition or effect, quest
start condition or quest step condition that names a `sys:` flag. The guest claim moves the
guest's dialogue row to the account and leaves the retired guest a tombstone row: its `sys:`
flags, the starter marker, and a copy of its done quests (`npc::rekey_npc_state`).

**Why.** `on_disconnect` deletes the `player` row when an identity's last session ends, so the
next join re-runs the grant check; a rule that reads ownership re-grants a starter (with fresh
hidden IVs) to any identity that reaches zero monsters. The guest claim is such a path: it moves
every monster to the account while the retired guest token can still call `join_game`. The
marker lives in `player_dialogue_state` rather than a new table because that row is already
private, re-keyed by the claim, erased by the deletion cascade, counted as game data and part of
the owner's export; a new table would need all of that wiring again. The tombstone is the one
place the claim copies instead of moving: without it the retired guest would be granted a second
starter and kit, and could redo a finished quest. Making the kit untradeable would need a new item
field and a trade rule, and would not stop one player farming throwaway identities on its own:
each fresh identity already gets a tradeable starter monster. How the official server keeps those
payouts from reaching a main identity is an open launch condition (`docs/economy-tuning.md`,
"Shared-economy caveat").

**Rules out.** Inferring "new player" from owned monsters, items or a wallet row. A re-grant for
an identity that holds the marker and owns no monster: a release or loss mechanic added later
must bring its own floor rule. Content (dialogue or quest) that tests, sets or clears a `sys:`
flag. Granting part of a kit, or clamping it at a cap. Accepted consequence: the retired guest's
tombstone (the reserved flags and quest ids, keyed by the retired guest identity) is not erased
by the claiming account's deletion cascade, which erases rows under the account's own identity.

## A player's tag is a minted sequence value: private at rest, mirrored on the public player row while online

**Decision.** Names are free and not unique, so each identity gets a discriminator, shown as a tag
beside the name, that tells same-named players apart. It lives in the private `player_handle` table
(`owner_identity` primary key, `discriminator: u32` `#[unique] #[auto_inc]`). `join_game` finds the
caller's row or mints one (insert 0, the column's sequence assigns the value) and copies the value
onto the public `player` row it inserts (`player.discriminator`; 0 means no tag). `onboarding.rs`
owns the table (`ensure_handle`, `rekey_handle`, `erase_handle`, `has_handle`). The value is never
0, never derived from the identity, never held by two identities at once and never minted twice: a
sequence only grows, so a deleted handle's value is not minted again. The guest claim moves the row
to the account with its value unchanged (`rekey_all`), and a handle counts as game data, so an
account that already holds one cannot claim (`account_has_game_data`). A claimed guest identity that
joins again is minted a different value. The deletion cascade erases the handle and zeroes
`discriminator` and `lead_level` on the surviving `player` row beside the tombstone name. The
owner's data export carries the handle row. A mint the datastore refuses (an exhausted sequence)
refuses the join with `handle unavailable` before any presence row is written. `player.lead_level`
is the second public column on that row: the stored level of the owner's lead party monster, 0 with
no party. `battle::refresh_lead_level` keeps it equal to that level and writes the row only when the
value differs. The dual-write seam (`monster_mgmt::update_monster_synced`) calls it when a write
changes a monster's `level` or `party_slot`; `join_game` and the session-trade transfer
(`trading_session::apply_swap`) call it themselves. The cascade zeroes it. The client keeps the two
columns apart from the name: `StorePlayer` carries `discriminator` and `leadLevel`, and
`StorePlayer.name` is the raw name. `client/src/ui/playerTag.ts` is the one place a tag is
formatted: `formatTag(discriminator)` gives `#` and the number padded to at least four digits
through the catalog key `identity.tag` (no tag for 0), and `taggedName(players, identity)` joins the
name and the tag through `identity.taggedName` (`Drew #0042`). Three surfaces show the tag: the
Social screen's Players row (name, tag, lead level, Nearby, each its own element; the tag in the
muted text colour `--mr-text-muted`, which the accessibility suite checks in both themes, except on
the cursor row; the level through the battle HUD's `tactics.hud.level` copy so it reads the same in
both places, and none for 0), the incoming trade and challenge request banner, and the Trades-tab
session row. Every other surface shows the name alone: the tactical battle clock, the trade editor
heading, the rename view, the Rankings tab. `playerName` (`client/src/ui/tradeSessionModel.ts`)
shows `#` and the first eight hex digits of the identity when the store holds no row for it or the
row's name is empty. That fallback is not a tag: `validate_name` refuses an empty name at join and
rename, so only an identity the store does not hold reaches it, and that identity has no tag to
show.

**Why.** The `player` row is deleted at every disconnect and is not re-keyed by the claim, so a
value stored only there would be re-minted each session. A public `player_handle` would list every
identity that ever joined, offline ones included; the mirror shows a tag only while its owner is
online. `profile` rows exist only after a first rated game. A sequence value needs no collision
retry and cannot be forged to match another player's; the accepted cost is that a tag reveals
roughly how many identities joined before it. Zeroing the mirror at deletion keeps the tombstoned
row from being linked back to a tag another player saw. The lead level is a stored column, not a
view: another player's monsters are private (`monster_pub` is read only through the owner's view),
and a view over `monster` evaluated for each subscriber would be recomputed on every monster change.
The tag disambiguates where a player picks another player out of a list or answers a request from
one; in a battle and in the world the name alone reads as part of the game (the operator's ruling,
<https://github.com/mdrewt/monster-realm/issues/588>), so the tag is a display join and never part
of the stored name. The Players row is built from parts so the player-chosen name stays isolated in
its `<bdi>` and out of the catalog resolver; the one-line banner and session row are plain text, so
they take the catalog join.

**Rules out.** Enforced-unique names. Deriving the tag from the identity (it would change at the
claim, or collide after it). Storing the tag only on `player` or `profile`. A public handle table or
a view that serves another player's handle. Reissuing an erased value. Minting anywhere but
`join_game`'s success path (a refused or deletion-gated join mints nothing). Changing a monster's
`level` or `party_slot` outside the dual-write seam without calling `battle::refresh_lead_level`:
the column would stay stale until the owner's next seam write or join. Folding the tag into
`StorePlayer.name` at the row converter (every name-only surface would show it), and building the
tag text or the name-and-tag join by concatenation outside `playerTag.ts`. Accepted consequence: the
`u32` sequence is one finite, shared resource (about 4.3 billion identities) that guests, who are
never reaped, also draw from; once it is spent every identity without a handle is refused at join.
Also accepted: any client sees each online player's lead level and its changes as they happen
(reorders, boxing, level-ups), because the operator chose the lead level for the Players row;
bucketing the value is the remedy if a playtest finds that matters. A tag tells identities apart,
not people: anonymous identities cost nothing to mint. And the tag links a claimed guest to its
account for anyone who saw the guest's tag, which is the ruling's intent; deletion zeroes the tag on
the surviving row only, not in another player's memory or screenshots.

## Account deletion and data export

**Decision.** Every table is classified once in `schema::DATA_LIFECYCLE_MANIFEST`
(Erase / Anonymize / ViaJoin / NotOwned, a written basis, and whether it is
exportable). A test compares the manifest with the generated module definition's
table set, so a missing or stale entry fails. `delete_account` sets
`PendingDeletion` and arms a one-shot reaper for `DELETION_GRACE_MS_DEFAULT` (7 days,
`game-core/src/accounts/deletion.rs`); `cancel_account_deletion` reverses it. When
the reaper fires, the cascade force-resolves live interactions first, forces ongoing
battles naming the account to a terminal result, erases or anonymises per the
manifest, and stamps `terminal_at_ms`. `Anonymize` also covers `leaderboard_top`, which
holds only an identity its anonymized `profile` row keeps: the cascade re-derives it after
tombstoning the name instead of overwriting it. A deletion-pending caller cannot open new
commitments: 25 reducer call sites call `guards::require_not_deleting`, while
commitments that predate the request stay completable. `request_data_export` writes
private `export_bundle` chunks (`EXPORT_CHUNK_ROWS` 500) for `my_export_bundle`, gives
each live bundle a unique creation stamp (rejecting under contention), admits requests
against a global live-row cap that is halved for callers without an account and
halved again for callers without a wallet, and a reaper deletes chunks older
than 7 days, within an hour of their expiry (`server-module/src/privacy.rs`).

**Why.** A new table must not silently keep personal data after a deletion, so its
classification is part of the schema. Blocking new commitments during the grace
period stops a deleting account from laundering assets to a confederate. The export
caps and tiers bound storage abuse, with anonymous identities limited before account
holders. The starter kit's currency creates the wallet row at an identity's first join, and
only an identity with a `player` or `account` row can request an export, so the no-wallet tier
holds almost no caller and a join alone reaches the anonymous tier. The wallet signal stays:
any per-identity signal an anonymous identity can earn is cheap, and sign-in is the fix. A
configured real sign-in issuer (`PRODUCTION_LOGIN_ISSUERS` in `server-module/src/accounts.rs`,
today the fail-closed placeholder; the gate reads that list, not the build's own
`ALLOWED_ISSUERS`) is therefore a launch condition for the official server. Until then no
caller has an account, so no caller reaches the account holders' ceiling, and identities that
each earn a wallet row can keep the anonymous tier full: other players' export requests are
refused for as long as those identities keep re-exporting, and for up to the 7-day retention
after they stop (R-rb-132-WALLETSYBIL). The operator accepted that exposure until launch
(monster-realm#757).

**Export scope.** The export is for the data held about the person. Game state is
included where a query on existing tables provides it; it is assembled from the tables
the game already keeps, and nothing is stored for the export's sake. A row that only
duplicates exported state, or exists only between sessions, may stay out with its
reason in the manifest's `basis` (`last_position` is one).

**Rules out.** An unclassified table; deleting before the grace period ends; an export
path any other player can read; a table or column added only so the export can carry it.

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
dispatch arms and copy. What stays of the 1v1 engine is deliberate. The server
module keeps the write-back, terminal-sweep, faint-penalty and disconnect helpers the tactical
settle funnel calls. `marshal.rs` has no 1v1 row→`BattleMonster` marshaling helper and
`content_cache.rs` no 1v1 skill, ability or type-chart cache: a helper only its own tests call is
dead code, not a fallback engine. `game-core/src/combat/` follows the same rule. It holds the
types stored in `Battle.state`, `battle_action` and the content rows, and the rules a production
path calls: the damage formula and accuracy check, the type chart, lead selection, the status
countdown, the XP rules, and the PvP forfeit and challenge rules. Everything else in it (the
turn driver in `combat/resolve.rs`, the enemy skill picker, the entry-ability hooks, the weather
chip and countdown) has no production caller, and `docs/refactors/combat-carried-rules.md`
lists what is left to remove and in what order. The tactical engine calls a carried rule itself. Where the
rule's signature takes the 1v1 `BattleState`, the engine states it once in `tactics/`, pinned by
tests that hold literal expected values. A test of a removed rule goes with it, naming the
removed function or the surviving test of the rule it carried; a test that executes no product
function is no check and goes for that reason. The 1v1
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
client side first and de-attribute the server side in the same slice. A 1v1 rule only its tests
call is paid for by every change to a stored type (its tests build `BattleMonster` and
`BattleSide` by hand) and by every gate that has to cover it, and it reads as a second
engine. The entry-ability and weather functions take the 1v1 active-slot state, which the grid
has no equivalent of, so a depth wave could use them only as a test oracle for one-line
formulas. The wave states its rule on `TacticalState` from the values the plan file records,
and `calc_damage` already carries the Rain and Sun modifier through its `weather` parameter.

**Rules out.** A feature flag or config row selecting the engine; starting a tactical
battle through a dev-only reducer in any shipped build; dropping or reordering the
retired tables (live data, additive schema).
In `combat/`: a 1v1 rule kept as the source for a later wave or as the expected value of a
tactics test; a second copy of a rule the engine can call; keeping a test that executes no
product function until a survivor is found for it.

## Dev-only reducers never ship

**Decision.** The dev reducers `grant_bait` and `dev_expire_tactical_window` compile only with
the `dev_reducers` feature (`server-module/Cargo.toml`). `dev_place_in_load_zone` compiles only
with `load_test_zones`, which implies `dev_reducers`. Neither feature is ever in `default`.
`dev_reducers` implies `open_join`, and `default` holds `open_join` and no dev-reducer feature. A
release feature (`official` or `world`) together with a dev-reducer feature does not compile, and
`just release-module` refuses an artefact that names a dev reducer.
The playtest recipes publish the default build, which is the test build (see "Ownership is
enforced unless a dev feature switches it off"), and then check the *published* module with
`spacetime describe --json` (`scripts/verify-release-reducers.mjs`, whose
`FORBIDDEN_REDUCERS` lists every dev reducer name, so a new dev reducer joins it in the
change that adds it), and check that the production client bundle contains no DEV debug
hooks (`scripts/verify-build-hooks.mjs`). The committed client bindings are generated from
the default build, so they hold no dev reducer, and the `bindings-drift` eval fails if one
appears. No dev reducer starts a battle: the e2e drives every battle through the
player-reachable flows. `dev_expire_tactical_window` is callable only by the module owner
(the `config` row's `owner_identity`, the check `sync_content` makes), so a player is
refused even in a dev build. It moves the open turn window's deadline to the call's time and
arms one deadline fire there; the scheduler's own `tactical_deadline_fire` expires the
window as at a real deadline. An e2e may expire a window through it instead of waiting, and
a test that does so keeps one real-time expiry in the same test.

`dev_expire_tactical_window` names the side whose window it expires and refuses a call that finds
the other side's window open, so a slow test cannot strike the wrong player. It acts on any Active
tactical battle, wild, PvP or Practice; a wild expiry is the AutoFlee a real deadline gives. It
refuses a Deploying or Finished battle.

`dev_place_in_load_zone` exists only in the load-test build: `load_test_zones`, which `just
load-host` publishes to a `monster-realm-load-zones*` database on a loopback host (a remote one
only with `MR_LOAD_ALLOW_REMOTE=1`). That build also
appends game-core's 100 generated zones to the zone, zone-map and tactics-zone registries. The
zones are 16×16 floor with ids 10000–10099 (`game-core/src/load_test_zones.rs`). Any caller may
call the reducer, but only for itself. It moves the caller's own character to a load zone's spawn
tile as the tick's warp arm moves a character. The character arrives Idle, its queued moves are
cleared and published with the seq kept, and the zone's tick is armed. The reducer refuses an id
outside the band, a caller with no character or move intent row, and a caller in an ongoing
battle. The load driver
(`mr_load_driver --zones`) calls it once per bot after the join, to spread its bots over the
zones. The browser client is not supported in a load zone: its wasm has no load-zone map, so it
cannot predict there. A change that adds a dev reducer must also:

- call the deletion gate first;
- join the census's `EXPECTED_GATED` (`privacy_enforcement_tests.rs`), and, when it adds a module,
  `EXPECTED_MODULES`. That module's `mod` line carries no `cfg`, because the census refuses every
  `cfg` but `cfg(test)`, so the feature gate goes on the module's items;
- add `exclude_re` keys for its surviving mutants to `.cargo/mutants.toml` entry 8;
- keep every item it adds behind its feature. The default game-core build compiles no new function
  for a dev or load feature. A game-core loader reaches gated code through a macro on the loader's
  existing line, whose feature-off arm expands to the loader's original expression
  (`load_test_zones::zones!`).

A dev caller reaches a private production function through a dev-gated forwarder
(`tactics.rs` `dev_arm_deadline`). It never widens the function itself.

**Why.** A dev reducer in a real deployment is an exploit: free items, or expiring another
player's turn window. Checking the published module rather than the source catches a wrong
build flag in the publish path, which a source grep would not. A test that waits real
deadlines spends a full turn window per expiry (30 s in PvP); overriding `now` would open later
windows ahead of real time, so the reducer moves one deadline and leaves every timestamp real.
One real-time expiry per test keeps the real scheduler covered by the two-browser flow.

What keeps dev code out of a release is checked on the artefact and by the compiler: the
published-module check, `just release-module`'s refusal of an artefact that names a dev reducer or
whose profile compiles one, the census rows, and the compile error for a release feature named
with a dev-reducer feature. A change that adds a dev reducer does not have to leave the default
build's bytes unchanged. Accepted: dev code that is not a reducer and escapes its feature gate
changes the default build without any of those checks seeing it; review of the gate is what
catches it.

**Rules out.** Runtime flags for dev reducers; trusting the source tree as proof of what was
published; a dev reducer a player can call to act on anything but the caller's own state
(`grant_bait` and `dev_place_in_load_zone` act on the caller's own;
`dev_expire_tactical_window` is owner-only); a fake or overridden clock for tests; an e2e that
takes every expiry through the dev path; a `cfg(feature)` module line; widening a
production function's visibility for a dev caller; requiring a build's bytes or its source layout
to stay fixed as proof that dev code did not ship (it shapes production source around a hash).

## SpacetimeDB versions move in lockstep

**Decision.** The spacetime CLI/host and the Rust `spacetimedb` crate are pinned to
the same version (2.16.1: root `Cargo.toml`, `SPACETIME_VERSION` in `scripts/ci-tools.sh`).
AMENDED 2026-10-15 (deps-s3): the npm `spacetimedb` SDK now joins the lockstep
(`^2.16.1`, locked in `client/package-lock.json`). It was previously held separate
(at 2.6.0) because newer SDKs change reconnect behaviour; since 2.7.0 the vendor
ships CLI/crate/SDK from one monorepo on the same day with no documented skew
matrix, so same-version-everywhere is the only documented-safe configuration. An
SDK bump still requires the live two-client e2e the old rule demanded.
`scripts/ci-tools.test.mjs` holds the resolved crates (`cargo metadata`), the locked npm SDK and the
generated bindings to one version; `bindings-drift` holds the bindings to the CLI on PATH, which CI
installs from `SPACETIME_VERSION`.
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

## The crate's `unstable` feature is on; the generated definition is checked instead

**Decision.** The workspace's `spacetimedb` dependency enables the crate's `unstable` feature
(operator, 2026-11-22), and the module uses nothing it gates: its procedures and their HTTP
client (`server-module/src/account_checks.rs`) are outside the feature. At 2.16.1 the feature gates HTTP
handlers and routes (`spacetimedb::http::{handler, router, HandlerContext}`), row filters
(`client_visibility_filter`, `Filter`), `volatile_nonatomic_schedule_immediate!` and a unique
column's `insert_or_update`/`try_insert_or_update`; procedures, their transactions and their HTTP
client are not behind it (`docs/spacetimedb-2.16.md`). What keeps a handler, a route or a row
filter out of the module is a check of the generated module definition, not the feature: `findDefinitionViolations` in `scripts/verify-release-reducers.mjs`
refuses each, at any submodule depth, and any section kind it does not know, on the default build
(`just module-definition`, in `just ci`) and on every artefact `just release-module` makes. The
same check refuses any procedure but the three account checks and any schedule but the module's
own, and the reducer census refuses a `procedure` attribute outside `account_checks.rs`. Nothing checks the immediate-schedule call or
`insert_or_update`, which are calls, not declarations: review keeps them out. The scheduled call is
the one that matters to the access design. The host queues it when the call runs, so it runs even if
the calling reducer then fails, and it runs as the database identity, so it passes every
scheduler-only guard (`crates/core/src/host/scheduler.rs:262-267, 953-971` at tag `v2.16.1`).
Measured on 2.16.1 (default build): the
feature adds one export, `__call_http_handler__`, and 76,336 bytes (3,480,052 to 3,556,388); the
imports and the definition's sections are the same with it off and on, and the native test binary
links with it (`lpw34_7_unstable` in `server-module/src/privacy_enforcement_tests.rs`).

**Why.** A slice that uses one of these APIs then measures only that API, against a module already
built and tested with the feature on. The guarantee the access design needs (no route the host
serves without the connect reducer, no row filter) is a property of what the module declares, and
a check of the declaration holds it whatever the feature list says; a declaration behind a release
feature is invisible to the test build, hence the check on each release artefact.

**Rules out.** Turning the feature off to keep those APIs out (the check is the guard); a
declaration of a handler, a route or a row filter without a slice that changes the check and
`docs/local-play.md` §3; a call of `volatile_nonatomic_schedule_immediate!` from a reducer a client
can call; a host older than 2.14.0 for this module, since such a host rejects the
`__call_http_handler__` export with the signature the 2.14.0 crate and later emit (it gained the
sender and the JWT; vendor release notes, 2.14.0).

## Server-module tests run on our own host ABI, over the two vendor crates patched where they refuse a native host

**Decision.** The module's native tests keep the in-memory host in
`server-module/src/native_host_tests.rs`, which defines the SpacetimeDB host ABI itself. From crate
2.12.0 the vendor refuses a native host twice: `spacetimedb-bindings-sys` defines the ABI as stubs,
and `spacetimedb`'s table backend stops calling it off wasm. So the workspace builds both crates
from copies of their crates.io packages under `vendor/`, through `[patch.crates-io]`, changed only
by `#[cfg]` attributes that send native code down the branch wasm takes, each with a change notice
(`vendor/native-host.patch`). A procedure runs natively through more such attributes: its
transactions and its HTTP client reach the host's `procedure_*` functions, which put an aborted
transaction's rows back and answer each request from a queue the test stubs, so a procedure's
request opens no connection (`Fixture::run_procedure`). `ProcedureContext::sleep_until` refuses
natively: a native test of a procedure that sleeps adds two more such attributes and a
`procedure_sleep_until` to the host. A test (`nh_vendored_crates_are_the_crates_io_release_plus_the_patch`)
proves each copy, with the patch undone, matches the hashes recorded from the crates.io release
(`vendor/PRISTINE.sha256`), and that every changed line is such an attribute, selecting on wasm
what the original selected; every SpacetimeDB hop re-records them and re-applies the patch
(`docs/runbooks/spacetimedb-upgrade.md`). CI's `cargo audit` skips packages not from crates.io, so
these two are checked at each hop, in release notes and advisories, until CI audits them by name
and version. Built at the hop to 2.12.0 and re-applied at 2.14.1 and 2.16.1 (`vendor/README.md`);
the alternatives and the measurements behind the choice are in `docs/spacetimedb-2.16.md`
("The vendor's unit-test harness").

**Why.** The module's privacy and netcode rules are checked on what a transaction does as the host
sees it: every write a subscriber is sent, an unchanged update included; each shipped view, run
through the runtime's entry point for a chosen caller; and a client connection with or without a
JWT. The vendor's native harness (`test-utils`) answers none of these. Its datastore reports no
write or read, the view entry point does not reach it, and a JWT-less connection cannot be built.
It also puts the whole server, V8 and wasmtime included, into the test build. On wasm the changed
attributes select what they selected before, so the module we ship is the vendor's code.

**Rules out.** `test-utils` as the Fixture's host, until its datastore reports a transaction's writes
and runs the shipped views; a linker flag that tolerates the duplicate symbols (the stubs win, and
769 tests fail); switching off only the stubs, since the table backend still refuses; testing on an
older crate than the one that ships; any edit to the copies beyond such attributes and their notices.

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
decision in that table's serializer in `privacy.rs`. A column whose job has moved stays
in the table: `player.last_input_seq` is retired (the seq guard is
`move_intent.last_input_seq`), is written as 0 by `join_game` and never again, and is
still exported.

**Why.** SpacetimeDB's automatic migration accepts only appended columns with
defaults. Anything else needs `--delete-data`, which wipes every player.

**Rules out.** Mid-struct column inserts, column removals, and type changes on a live
table.

## The module publishes its protocol numbers; a publish that keeps data is followed by the owner's `sync_content`

**Decision.** `game-core` holds `PROTOCOL_VERSION` and `MIN_CLIENT_PROTOCOL` (never above it), and
`client-wasm` exports them as `protocol_version()` and `min_client_protocol()`. The module records
both in row 0 of the public table `module_info`, from `init` and from the owner's `sync_content`
whether or not the content changed. Every recipe and script in this repository that publishes over a
database and keeps its data then calls `sync_content` as the publishing identity, and fails when
that call is refused. `client/src/net/wireContract.test.ts` holds the generated bindings against one
recorded entry per protocol number (`client/src/net/wireContract.json`): `PROTOCOL_VERSION` rises by
one with any change to the entry, and `MIN_CLIENT_PROTOCOL` rises above every entry from it upward
that the bindings break. Server to client, any difference in a table, view or type an entry holds
breaks it, an appended column included; client to server, any change to a reducer or type it holds
does, except a variant appended to a sum only an argument reaches. New tables, views, reducers and
types break nothing.

**Why.** `init` runs only when a database is created, and nothing in the module runs when a new
module is published over existing data, so the owner's call is what makes the row describe the
module that is running, including after a publish that changed the schema and left the content
alone, which the content-version check would skip. A client misled by the numbers fails silently: it
misreads rows or sends calls the module cannot decode. Arguments and fields travel by position
(BSATN), so an added, removed, reordered or re-typed one breaks an older client's call, while an
appended variant only adds a tag no older client sends; the SDK builds a reducer event from the
caller's own arguments, so no client decodes arguments. A renamed member counts as a change although
no name travels: the bindings hold no other identity for it. From SDK 2.16.1 a client skips trailing
columns its bindings lack (vendor #6091; measured on `module_info`, `docs/spacetimedb-2.16.md`), but
not a field appended inside a named type, and a rule that told the two apart would have to model the
SDK's decoder; counting a trailing top-level column as a break is the operator's choice (#873):
nothing is deployed, so it costs nothing now, and it is revisited before early access, when every
additive column would otherwise send every older client to update.

**Rules out.** Copying either number into TypeScript or into the server module. Refreshing the
numbers below the content-version check, or from a reducer any caller may run. A recipe or script
that publishes over kept data without the owner's call, or that ignores the call's exit status.
Raising `MIN_CLIENT_PROTOCOL` for a change that breaks no entry (it sends every older client to
update the game for nothing). Rewriting an entry a merged change recorded, or deleting one at or
above `MIN_CLIENT_PROTOCOL`: either hides a break from the check. Treating the numbers as a
server-side check: they tell a client which side to update, and every reducer still validates its
own input.

## A client checks the server's protocol numbers before anything else, and a refusal lasts until reload

**Decision.** Each connection subscribes `module_info` alone first and judges row 0 against its own
`protocol_version()` (`client/src/net/protocolCheck.ts`). A protocol below the client's, no row or a
refused query means the host must update the server; a `min_client_protocol` above the client means
the player must update the game. A refusal ends the connection and the page builds no other one,
and the line naming the side stays on the world hint until reload. An admitted connection is judged
again whenever the row changes, and only toward refusal. `module_info`'s three columns never change.

**Why.** The numbers help only if a client that cannot speak to the server can still read them, so
they are read before any other table and from a row whose shape is fixed for good (an SDK cannot
decode a row that lost a column). The refusal is terminal so that the
line and the game never disagree: a page that reconnected, was admitted and played under "Update the
game to join" would be saying something false, and a line that cleared itself would be missed. A
reload is the retry. An admitted connection is judged again because a client that reconnects between
a publish and the owner's `sync_content` still reads the previous numbers.

**Rules out.** Adding, removing or re-typing a column of `module_info` (a new fact goes in a new
table). Subscribing anything else, or calling a reducer, before the verdict. Admitting a refused
page later, or re-running the check on a timer. Serving a client bundle before the module it needs
is published and synced: a client newer than the server it reaches is refused, correctly, and stays
refused until reload. Reading the check as access control: the server turns nobody away by protocol.

## Observability: the module never times itself or sends a signal out

**Decision.** Server signals come from the SpacetimeDB host: `/v1/metrics` for
Prometheus and the module's log files for Alloy→Loki. New server log lines go through
`observability::mr_log` (one JSON envelope). A 60 s `mr_heartbeat` scheduled reducer
logs the deployed content version and writes nothing; it keeps running in a world with
nobody connected. OpenTelemetry spans and metrics
are client-side only. The self-hosted stack (Prometheus, Alloy, Loki, Tempo, Grafana,
node_exporter, Caddy, and a trace relay) lives in `ops/observability/`, bound to
loopback.

**Why.** Reducers cannot make outbound calls and should not read clocks, so the host
has to be the source of timings and counters. The module's only outbound requests are the
account checks' (three procedures in `server-module/src/account_checks.rs`, to the one
account service the build names, see "A private world checks an account itself: a one-use ticket at first contact, then the account's handle"); none of them carries a signal.
`/v1/metrics` answers without
authentication and labels its series by database, so everything stays on loopback.

**Rules out.** An exporter or polling reducer; a procedure that sends telemetry; ad-hoc
`log::` formats in new code; exposing the stack without changing the Caddy bind address on
purpose.

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
a key). Every waiting Controls cell has a way out on the pad: the button a Pad cell shows,
else the live B, and the waiting line names it for a player on the pad. The session terminal is
outside the router and the overlay registry, so the pad reaches its buttons directly: the D-pad or
the stick moves and A presses, while B and Start do nothing. A button held while the terminal
opens, closes, arms or disarms its confirm step acts only once released and pressed again. Escape alone is
routed in the capture phase, so a view's `stopPropagation` cannot trap it; every other key
keeps the bubble phase, where text-entry views shield their
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
without a DOM. Generated hints and help cannot drift from the bindings. A pad-only
player has no other way out of a cell that takes keys, or of a Pad cell with no button to press
again; B is always bound and already means back. Nothing else on the pad can press Retry or
Continue as guest, and the confirm step gives up this tab's account session, which cannot be undone, so one
press must never both open it and answer it. A total catalog makes a missing
translation a compile error rather than a blank label, and throwing (rather than showing the key) keeps an unwired string from looking wired.

**Rules out.** A feature reachable only by a hotkey (F9's menu twin, Options › Report a
problem, is still owed); a hotkey-only discovery menu; leaving a waiting cell on a
timeout or disabling Key cells after pad input (a pad player with a keyboard at hand can
still bind keys); B answering No on the session terminal (a step there is left by choosing a
button, and B keeps one meaning on every step of it: nothing); a
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

## A hold gesture is a router edge: the top frame lists its hold-capable buttons

**Decision.** The top frame lists the buttons it treats as hold-capable (`RouteContext.hold` in
`client/src/input/router.ts`; `HOLD_MS` is 500). A listed button's press asks nothing. A
release before `HOLD_MS` delivers its tap at the release; held `HOLD_MS`, the frame's adapter
is asked once with a hold input (`NavInput.hold`, `client/src/ui/nav.ts`) and the release is
swallowed. Arming is per button whatever the source (key, pad, pointer). A frame change,
`resetRepeat` / `releaseAll`, or a frame that stops listing the button drops the press with
nothing delivered. The D-pad and X are never hold-capable. Today only the bare tactical battle
base lists Y, and only while the shell can clear the selected unit's READY plan
(`battleHoldButtons` in `client/src/ui/screens/battleScreen.ts`,
`TacticsBattle.clearPlanHoldable`): a Y tap shows the hold-to-clear line, which names the live
keycap of Y on the last-used device ("Hold F to clear the plan" on the default keyboard; "Y" where
that device binds nothing to it), a Y hold sends `cancel_queue` through the same path as the
confirmed Clear plan row. B is never listed: its skip of a playing beat stays at the press.

**Why.** A held button must never also act as a tap, and a tap must not wait on a timer on
every screen. Only a frame that offers a hold pays the tap-at-release latency; every other
button and screen keeps press-time response. One router rule serves the keyboard, the pad and
the pointer alike, since the pad is one more source of the same edges. B keeps press-time skip
because keyboard and pointer players already skip at the press; a tap-vs-hold B would turn
their tap into an undo, a feel change deferred to the tactical battle's depth work and flagged
to the operator.

**Rules out.** Per-screen hold timers or a second hold clock; listing a button whose tap must
act at the press (B while a beat plays, the D-pad, X); a hold that also delivers its tap;
treating a held key's OS auto-repeat as a hold.

## Code leaves `client/src/main.ts` into owner modules under `client/src/shell/`; `main.ts` stays the composition root

**Decision.** An extraction from `client/src/main.ts` follows the map in
`docs/refactors/client-shell.md`: layered modules under `client/src/shell/`, each owning its
mutable state as module-level `export let` bindings. Another module reads a binding through
its import, which is live, and changes it only by calling a function the owner exports; a
`Set` or `Map` that several modules mutate is exported read-only with an owner function per
mutation. `main.ts` remains the entry. Of `main.ts` and the shell modules, only `main.ts`
registers a listener on `store`, `window` or `document`, installs the DEV hooks, writes the DOM
at import or constructs a boot-built view; its registrations keep the order the plan lists, and
the locale block stays in it. A shell module imports only the shell modules below it. A lower
module reaches upward through a typed port `main.ts` installs (the host of the world hint;
what the battle views need from `dispatch` and the stack; the Gamepad API's fault sink), which
throws until installed, or logs to the console until installed when its caller swallows a throw
(the pad's fault sink: a failing reporter must not stop the poll that releases held buttons), or
through the parameter object of a frame-loop pump.

**Why.** Every `client/src/main.*.test.ts` suite resets the module registry and imports
`./main`, so module-level state in a shell module resets per test and no suite changes how it
boots. An import cannot be assigned, so the compiler holds each binding to one writing
module, and a moved body changes only by its imports or by the owner call that replaces a
write. The order of the batch listeners is load-bearing (`reconcileStack` first of the
listeners that show or hide a view; the stack sync and the adapters' observe last), and Biome
reorders import statements, so registration cannot follow module evaluation. The locale writes
are the only import-time statements another module could observe, and in `main.ts` they run
after every import.

**Rules out.** Feature modules that each own a view and register their own batch listener at
import: listener order would follow import order, and the stack and `dispatch` would import
the features that import them. Also: one shared state object (no field has an owner, and
every test that reads a bare identifier from the source changes); controller classes with
injected collaborators (each extraction would move code and change its interface at once); a
prelude module holding the locale block (it would run ahead of modules that run before it
now); a module-scope copy of a live binding; a shell module that registers a listener.

## Each client registry has one test that states its members

**Decision.** A fact that a client registry holds (the overlay ids, the catalog keys, the
subscription batch, the help entries, the command kinds, the menu rows and accelerators) is written
out as a literal by one test: a roster compared with the registry for equality, in order where order
is behaviour, in the test file beside the registry. The frame ids have no list of their own: they
are the overlay roster plus the Social frame. Any other test computes its expected value from the
registry, asserts only its own entity, or gives the assertion up to the owner; none asserts a bare
count of a registry or carries one in its title. A hand table that says what each member should be
(its tier, its battle policy, its adapter, its name) is expected behaviour: it stays hand-written,
typed `Record<K, _>` where the registry has a key type. The subscription batch is read from what
`connect()` sends and is not exported for a test. `docs/refactors/test-pins.md` lists each fact, its
owner, and the slices that bring the existing tests to this rule.

**Why.** A registry's size written into many tests makes a slice that adds one member edit each of
them, and two slices that name the same test file never run together. A count cannot say which
member changed and survives a swap; a roster can, so the roster is the one literal worth keeping.
The compiler holds the `Record` tables total, but not the subscription batch, the help entries or
the menu rows, so one owner per fact is what still goes red when a member is added, dropped or
reordered by accident, and what a client subscribes to is what it is sent.

**Rules out.** Leaving the duplicates and letting each run add the pin files to its own file list:
the edits, the serialization and the stale counts all stay. A shared constants module for tests: a
second copy of every registry, in one file every slice edits, and not a check. No roster at all:
nothing would notice a thirtieth subscription query. Rebuilding a per-member table, or the
subscription expectation, from the product value it checks. A tally that adds one per pass of a
loop over the registry, or that counts whether another test ran.

## Interaction target: the tile in front, then your own tile

**Decision.** A (and a click on the world) acts on the candidates from
`game_core::interact_candidates`, exported to the client as
`interact_candidates_coded`. The candidates are the entities on the tile the character
faces (`pos.step(facing)`), or, if there are none, the entities on the character's own
tile. Same zone only; ordered NPC, then heal, then player, then by id. An entity
within range but not in front is never a candidate, even though `talk` accepts up to
`TALK_RANGE` (2). The UI starts trades and challenges only from a player you face, a
shop only from its keeper's greeting, and a heal only from a faced heal tile or
`Heal(_)` NPC. The server is more permissive than the client. `talk` accepts
`TALK_RANGE` from the NPC's current tile. `open_trade_session` and `challenge_pvp`
refuse a partner outside `game_core::interact::within_interact_range` (same zone,
Manhattan distance at most `TALK_RANGE`), and `heal_party` refuses a caller outside
that range of the heal location's tile. `buy` and `sell` refuse a caller outside
`game_core::interact::within_npc_reach` of an NPC offering that shop (`sell`: any
shop): the same zone and at most `TALK_RANGE + wander_radius` from the NPC's home tile.
Each of those five has one message for every out-of-range case: another zone, too far
and a missing character. A challenge or a trade session is answered from anywhere: its
range is checked only when it is opened. In `challenge_pvp` the range check runs right
after "target is joined and online" and before the checks that answer from the target's
account, battles and pending challenges, so a caller out of range learns only whether
the target is joined and online. In `buy`, `sell` and `heal_party` it runs after the
deletion gate and before the battle guard and every read of the caller's wallet,
inventory and cooldown.

**Why.** Interaction follows what the character faces, as in console RPGs. The
server's range is a latency margin for an NPC or a player that steps one tile before
the reducer runs. It is not the player's reach. A shop is measured from home plus the
wander radius because its keeper wanders once the greeting ends while the shop frame
stays open; measured from where the keeper stands, an open shop would strand its
customer. The order in `challenge_pvp` is not a privacy guarantee: a player who walks up
to the target still gets those answers. A range refusal itself reveals nothing new,
because `character`, `npc` and `heal_location_row` are public tables.

**Rules out.** A nearest-within-range target; widening the client rule to match
`TALK_RANGE`; starting a trade, a challenge, a purchase, a sale or a heal remotely from a
menu; re-checking range when a challenge is accepted or a trade session is confirmed;
measuring a shop from its keeper's current tile; content that leaves an NPC outside its
wander disc, or lets a `Heal(_)` NPC stand or wander more than one tile from its
location's tile (the reach rules assume neither, and that NPC's customers are refused).

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

## game-core is mutation-gated nightly, the server on the lines a pull request changes

**Decision.** `mutation` (game-core, nightly) runs as six cargo-mutants `--shard k/n` jobs, each
its own zero-tolerance verdict. The server's zero-tolerance gate is the pull-request job
`mutation-diff` (`just mutate-diff origin/master monster-realm-module`): it mutates the
server-module lines the change adds or edits, diffed from the merge base, and a survivor fails
it. The full server sweep, `mutation-server` (eight shards), runs weekly and files its survivors
as one issue on the default branch; survivors fail nothing, and a shard is red only when
cargo-mutants gave no verdict. A survivor is killed by a test or, if provably equivalent (no
input distinguishes it), excluded in `.cargo/mutants.toml` with the written proof. The bodies of
the four logging functions (`guards::log_reject`, `guards::json_escape`, `observability::mr_log`,
`mr_log_breadcrumb`) are excluded by name; their direct tests stay.

**Accepted gaps.** The diff gate selects mutants only on lines a change adds or edits, so a test
weakened or deleted with no server source line changed passes it, and so does a change that only
deletes source lines; the weekly report is read for both. The escaping, the reject line and the
reserved-key guard in the logging bodies are held by their direct tests alone: no mutation run
checks that those tests still catch a break in them.

**Why.** The crates outgrew one serial job: nights of 2026-10-31, 11-01 and 11-04 were cancelled
at GitHub's 6 h cap. A count cap hides regressions (kill one, add one, same number) and rewards
raising it. A nightly full-sweep verdict lands after the merge, on whoever is next; a diff verdict
lands on the change that made the mutant, before it merges, and the eight-runner sweep then runs
once a week instead of every night. A log line is a diagnostic, not a rule: losing or garbling
one degrades what an operator sees, never a player's state, so the mutation gates judge rules.

**Rules out.** Dropping mutants to fit the time limit; excluding a killable mutant outside the
logging functions; a survivor count, budget or threshold on the server, or a committed survivor
baseline file; a test that asserts only log text no tool parses.

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
`:root[style*="--mr-ui-scale"] { font-size: calc(100% * var(--mr-ui-scale) * var(--mr-text-step, 1)); }`,
carries it to every rem token. Until the first write the rule does not match, so the root stays at 100%, a
scale of 1. The player's text size (uif-13: ×1, ×1.5 or ×2 from Controls › Display, `client/src/ui/displayPrefs.ts`)
is the second factor, written as `--mr-text-step` at import, before the seam's first write; it never moves
`uiScale` or `deviceScale`.

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
The sinks are in `client/src/shell/feedback.ts`: `route` shows a message on its kind's channel, and
`reportError` adds the console line and the error ring. The senders go through them: `sendGuarded`
in `client/src/shell/session.ts` names a kind per send site (`SEND_REJECT_KIND`), `main.ts`'s care,
shop and rename outcomes name a kind, and its battle refusal paints the toast and is announced at
once. A toast is announced once
through `#a11y-live` (the notice pump) and hides after `TOAST_MS` of the frame clock. A persistent
hint follows the top frame (WF1-A9). On the main menu's strip it outranks the menu's own line: an
action-required hint comes first, then a persistent state, then a disabled reason, then a
Y-description. Otherwise it sits on
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

**Rules out.** A fixed corner, beside-the-slot placement, in-slot buttons, a dim layer, a second sheet
root per sub-list, and a Summary implemented as a sheet or an overlay. Later sheets (Inventory uif-8,
Social uif-9) reuse this placement and the `kit.sheet.close` / `kit.sheet.back` rows. The Social row
sheet ends with Back, not Close (`BACK_KEY` of `client/src/ui/monstersModel.ts`, appended in
`client/src/ui/screens/socialScreen.ts` and `client/src/ui/tradeView.ts`): it opens from a row of the
Social list, and A on Back returns to that list with nothing sent. The world sheets (uif-12) reuse the
Close row but keep their own anchor (see "Select is Help everywhere; a world sheet closes under it and
ends with a Close row").

## Select is Help everywhere; a world sheet closes under it and ends with a Close row

**Decision.** Select opens Help over the bare world and over every world sheet: a fresh Select over a
sheet closes it and falls through to the base, which answers `toggleHelp` (`worldButton` in
`client/src/ui/screens/worldScreen.ts`, `baseButton` in `client/src/ui/screens/index.ts`); a held Select
is consumed and changes nothing. The world sheets (the entity × action picker and the Y action sheet of
`client/src/ui/actionSheetModel.ts`, the Accept / Decline / View request sheet of
`client/src/ui/noticeModel.ts`, the Challenge party-size confirm) paint as the kit's `ContextSheet` (root
`[data-context-sheet]`) inside `#interact-prompt`, hung where the prompt hangs; `placeContextSheet` is
not used for them. That root is what lets the pointer source click a row and close the sheet from a click
elsewhere. Every picker, action sheet and request sheet ends with a Close row (`CLOSE_KEY`, painted with
`kit.sheet.close`): a layout row, not a `SheetEntry`, whose A is exactly B's step, so the sheet closes
and nothing runs or is answered. The Challenge confirm keeps `No` last and gets no Close row. The hint
bar reads A OK (Choose beside a multi-row picker), B Back, Start Close, Select Help over every world
sheet.

**Why.** An earlier rule let an open sheet swallow Select, so the hint bar's Select Help chip lied over
every sheet. What that rule guarded against was Help opening under the sheet; closing the sheet first
keeps that guarantee and makes Select one action everywhere. The Close row exists because a pointer
player has no B: the chip-only prompt is `pointer-events:none`, so a world sheet could only be left from
the keyboard (playtest 3 feedback). The confirm already has an exit row, No; a second one would make its
shape ambiguous.

**Rules out.** A world sheet that swallows Select; Help pushed over an open world sheet; a Close row
modelled as a candidate action or `SheetEntry` (it would need a candidate and count toward the Choose
verb); a Close row on the Challenge confirm; re-anchoring a world sheet with `placeContextSheet` (it must
stay where the faced thing is); promoting a world sheet to a frame or `OverlayId` (a request is a
non-modal banner and world sheet, never a frame: "Client UI: virtual buttons, one context stack, one
overlay frame").

## Profile is one dialog; the rename, claim and privacy views are its sections

**Decision.** Profile is ONE overlay, `profileView` (`client/src/ui/profileView.ts`): it owns the frame
root, the title, a body that scrolls under it, the Close row, the a11y open and close (one role, one
label, one focus trap) and the one column of rows the D-pad walks. Its initial-focus anchor is the name
field; an open on Account or Privacy seats that section's row at once instead. `renameView.ts`,
`claimView.ts` and `privacyView.ts` keep their files, models, handlers and element ids but are sections:
they hold no a11y of their own, are shown and hidden only through the frame, and are not `OverlayId`s
(`OVERLAY_IDS` is 16; `OR-MANIFEST-COMPLETE` in `overlayRegistry.test.ts` names the three files as an
exclusion). The frame takes the strictest row of the three it replaced in every table: `SCREEN_POLICY`
player / drop, and `RECONNECT_CLOSES` true (rename's, so a reconnect closes it, and `onReconnect` shows
a claim prompt its own cycle raised again after the sweep). N and C are two accelerators onto the one
frame, the section carried as the path's `tab`; with Profile on top, the one whose section does not hold
the cursor moves it there. Every close (B, Start, the Close row, a battle, a conversation, a reconnect)
runs each section's `hide()`, which disarms BOTH two-step confirms (the deletion's, and since this
change the claim decline's); a move that enters a section whose confirm is armed lands on its No. The
`privacy-busy` message kind is gone: the privacy surface no longer opens over anything.

**Why.** The operator's complaint was three sparse full screens behind a sub-list (playtest 3, #586 D3).
Tabs would have kept three sparse pages. Three dialogs cannot be visible sections of one screen, because
two open focus traps cannot coexist; the Social frame's one-panel-at-a-time trick shows one panel, not
three. A decline has to disarm on close, and No has to be where the cursor enters, because one column
puts an armed "Yes" directly under the name field, where Escape or one Down would land on it.

**Rules out.** Giving a section its own `openOverlayA11y`, role or frame classes; showing or hiding a
section alone (a section's own Escape, a per-section reset in `RECONNECT_RESETS`); a Profile sub-list or
Profile tabs; a second always-enabled anchor inside the Privacy section (the frame's Close is the reseat
target when a render refuses the focused control: `fallbackRow`); leaving either confirm armed behind a
closed frame; the list scroll cue `.mr-scroll` on the body (its gradients sit behind running text, where
contrast cannot be measured); re-adding an overlay-busy refusal for privacy.

## Every served asset carries a provenance row; image-model output never ships

**Decision.** Every PNG served from `client/public/assets/` has exactly one row in the art registry
(`ART_REGISTRY` in `client/src/render/art/registry.ts`, aggregated from one pack file per asset family in
`client/src/render/art/packs/`). A row records the stable atlas key, file, kind, sheet and frame size,
scale, source (the generator path, or the pack's URL), license and provenance tag, and it lands in the same
change as its file. The row type accepts only the licenses `project-original`, `CC0-1.0` and
`CC-BY-4.0`/`CC-BY-3.0`, and a CC-BY row must carry an attribution. It accepts only the provenance tags
`placeholder-procedural`, `placeholder-licensed` and `final`. The `ai-placeholder` tag, share-alike and
EULA licenses cannot be written. `validateArtRegistry` rejects what the type cannot express: a duplicate
key or file, a sprite, tile or normal frame off the 16 px grid, a scale other than 1, a malformed key and
an empty attribution. Its colocated test runs the validator over the real rows and checks each row against
the served directory and the PNG headers. Image-model output is for ideation only and never ships. The art
rules live in `docs/art/style-guide.md`.

**Why.** Every served asset is a placeholder until an artist is hired. Without a record of where each file
came from, a placeholder that a license does not allow us to ship, or image-model output, could reach a
release without anyone noticing. Keys stay stable so final art is a file swap. Before this, the repo had no
provenance, credits or asset-license file, and one wave of monster sheets came from a generator that has
since been deleted. Their rows cite it as `<path>@<commit>`.

**Rules out.** Serving a file without a registry row; a row tagged `ai-placeholder`; share-alike or EULA
assets until counsel signs off; renaming an atlas key to swap art; asserting a file count in place of the
directory-against-registry check. A release gate that every row is `final` is deferred to the launch
checklist.

## The frame loop is the only thing that draws; the sprite batcher samples at most four textures

**Decision.** Pixi's own render ticker is stopped (`autoStart: false` in `appInitOptions`).
`WorldRenderer.render` draws once at the end of each frame-loop frame, and `WorldRenderer.resize` draws
because a resize clears the canvas. The renderer caps `renderer.limits.maxBatchableTextures` at
`MAX_BATCH_TEXTURES` (4) after init and again after every WebGL context restore, because Pixi re-reads the
limit from the device on a context change. On a context restore it also re-bakes the terrain chunk
textures and drops the generated placeholder character textures (`AssetProvider.contextRestored`), since a
rendered texture comes back empty. `client/e2e/render-context.spec.ts` loses and restores the context in a
real browser and compares the canvas before and after, and counts one canvas clear per animation frame.

**Why.** Pixi's batch fragment shader chooses its texture with an if/else chain as long as the batch limit,
evaluated for every covered pixel. A hardware GPU does not notice. A software rasteriser (SwiftShader:
headless CI, and any player whose browser has no usable GPU) reports a limit of 32 and pays for the whole
chain per pixel, so the cost grows with how much of the canvas the map covers. Measured in headless Chromium
on 2 cores at 1280x720 (medians of 3 interleaved blocks; Pixi's own ticker and device limit of 32 against
this configuration): on a 10x7 zone, idle browser CPU is 118% against 63%; on a 28x20 zone that fills the
canvas it is 177% against 107%, the frame rate 39 against 60 fps, and the median CDP key acknowledgement 25
ms against 4.9 ms. Pixels are identical; the larger zone takes 2 draw calls where the device limit takes 1.
The cap covers the sprite batcher, which draws the whole kit-atlas world; the flat-terrain fallback's large
`Graphics` uses a separate Pixi shader built at the device limit before the cap can apply. With Pixi's
ticker running beside the frame loop, Pixi draws the state the loop resolved on the PREVIOUS animation
frame; with one owner a frame is presented in the task that resolved it. Without the re-bake, the terrain
stays blank after a context restore (30% of the canvas on the small zone, 98% on the large one).

**Rules out.** Starting `app.ticker`, or adding a second `requestAnimationFrame` loop that draws; a
canvas-clearing operation that does not draw afterwards; raising `MAX_BATCH_TEXTURES` without re-measuring
under SwiftShader; a new `generateTexture` result that is not rebuilt on `webglcontextrestored`.

## The client builds for ES2022; the wasm import is a native top-level await

**Decision.** `client/vite.config.ts` sets `build.target: 'es2022'` and uses no top-level-await
transform. The wasm-pack `bundler` package is resolved by `vite-plugin-wasm`, and its async init is awaited
at module top level by the browser itself. The supported floor is every browser with ES2022 syntax:
Chrome 94, Firefox 93, Safari 16.4.

**Why.** A transform for older targets (`vite-plugin-top-level-await`) re-emits every chunk unminified, so
the production bundle ships with its whitespace and long names. Measured on one commit, with the transform
against without: the entry chunk is 1,219 kB against 794 kB raw (278 kB against 237 kB gzip) and all
JavaScript 419 kB against 358 kB gzip; over 10 cold loads of the built client, script time to first idle is
96 ms against 70 ms and the canvas appears at 277 ms against 244 ms. `es2022` produces the same bundle
as `esnext` today, but `esnext` lowers nothing, so the floor would move with whatever syntax a dependency
ships. The browsers below the floor date from 2021 or earlier and are out of vendor support.

**Rules out.** Re-adding a top-level-await transform; `build.target: 'esnext'`; lowering `build.target`
below a level with native top-level await while the wasm package is built for the `bundler` target.

## The world post stack is `pixi-filters`, on the world layer only, planned from injected time

**Decision.** The post stack uses four filters from `pixi-filters` (pinned exactly, `6.1.5`, imported by
subpath: `simple-lightmap`, `advanced-bloom`, `godray`, `color-map`). `planPostStack`
(`client/src/render/postStack.ts`) is a pure function. Its inputs are the pass toggles, an injected `nowMs`,
the reduced-motion bit, a time-of-day keyframe, the renderer's device-pixel resolution and what the renderer
supports. It returns the passes to run, in a fixed order, each with its filter's constructor options;
a disabled pass is left out of the plan rather than zeroed. `WorldRenderer` builds exactly those filters and
attaches them to one container holding the terrain, decor and actor layers, never to the stage or the DOM UI.
Each filter runs at the renderer's resolution and the LUT samples `nearest`. The godray time is
`godrayTime(nowMs, reduceMotion)`: the injected clock, held at 0 while reduced motion is set. No filter reads a
wall clock or `Math.random`. Three things disable the whole stack: an unsupported renderer, a pass whose
construction throws, and a throw from the probe frame drawn after the stack is built. In each case the plan is
empty with one warning, and the world draws unfiltered. A driver that fails a shader without throwing is not
detected. The renderer starts with the stack off at the `day` keyframe, and `setPostStack` turns passes on.
A production build that turns the stack on must keep it off on a software rasteriser, recognised from the
WebGL renderer string (`UNMASKED_RENDERER_WEBGL`) read at init and again after a context restore: a string
naming SwiftShader or llvmpipe, in any letter case, would be one more reason for the empty plan and its
warning. A string that names neither, or that the browser masks, counts as hardware, so another software
rasteriser runs the stack until it is measured and added to the check's list. No production build turns the
stack on, so the check is not written.

**Why.** `pixi-filters` was the vetted USE verdict for this stack (`docs/research/pixijs-ecosystem-ui-and-assets.md`
§0/§6 in the harness). It is MIT-licensed, has no install scripts, and its single runtime dependency is a types
package. It ships WebGL and WebGPU programs for all four passes, which saves writing and maintaining four
shaders. With the exact pin, an upgrade is a deliberate lockfile change, and the subpath imports name the four
filters in use. Filtering the world container alone keeps the UI unfiltered. The world's tile
edges stay one-pixel hard steps because every pass renders on the device-pixel grid. A filter below the
renderer's resolution would be resampled, and the chain runs at the lowest resolution of any of its filters.
Injected time keeps two frames with the same inputs pixel-identical, which is what the look-dev scene asserts.
Measured on software GL at 1280×720 (`docs/art/style-guide.md` §Post stack), the four passes cost 35.1
ms/frame against 2.0 ms unfiltered, and godray and bloom account for most of it. That is the reason for the
software-rasteriser rule: with the stack on, the live client misses the 55 fps frame-rate objective on
SwiftShader and on llvmpipe, and meets it on both GPUs of the same host at 1280×720 (§Low-end frame times). The
renderer string decides it because the plan can take it as an input a unit test supplies. The rule stops at
software rasterisers: through WSL2's D3D12 layer the host's integrated Radeon also misses the objective with the
stack on at 1920×1080 and above, so a build that turns the stack on also needs a bound for a weak hardware GPU,
which this entry does not set. A canvas clear per filter pass also breaks the one-clear-per-frame count in
`client/e2e/render-context.spec.ts`. So the live game keeps the stack off.

**Rules out.** Filters on `app.stage`, on a DOM layer or per sprite; a pass kept in the chain at zero strength; a
shader, filter or animation reading a clock other than the injected `nowMs`; a filter at a resolution below the
renderer's; a linearly sampled LUT; adding another filter package without a new entry here; turning the stack
on in a production build without the software-rasteriser check; recognising a software rasteriser from measured
frame time (a clock in the plan, and the stack must run slow before it is measured);
`failIfMajorPerformanceCaveat` in the check's place (headless Chromium created a context with it on both
SwiftShader and llvmpipe); a player setting as the only guard.

## The connection target is run-time configuration: a shell document set before the client module runs

**Decision.** The client reads its server from a page global, `__MR_SHELL_CONFIG__`, that the classic
script `/shell-config.js` sets before the module script runs. The document is
`{ connection: { uri, db, kind } }`. One resolver (`client/src/net/connectionConfig.ts`) rejects a
present document that is wrong and never clamps it. An absent document means the development defaults in
a development build and a throw in a production build. An omitted `kind` is `test` in development and
`private` in production. `uri` and `db` are used exactly as written (trimmed) and key the stored
reconnect token and claim code. `VITE_STDB_*` are inputs of the Vite plugin only: it serves the document
in dev and writes it into the build when `VITE_STDB_DB` is set. `scripts/verify-build-hooks.mjs` fails a
build in which any file other than `shell-config.js` contains the playtest database name.

**Why.** The same client must join a single-player world the game starts, a friends server and the
official server (see "One game, three ways to play: no code may assume we run the server"). A page
global set by a classic script is read synchronously, so the fail-loud throw stays at module scope where
no `try` in `main()` can swallow it, and the unit suites that import `main.ts` issue no request. The
`uri` rules exist because the SDK resolves its endpoint relative to the `uri` while the client keys
credentials on the raw string: a spelling the URL parser rewrites (a query, a missing trailing slash, a
`..` segment) would be keyed as one target and dialled as another. The omitted-`kind` default is the
most restricted kind, so nothing keyed on the kind is granted by omission. The dev-database refusal is
a guard by name against a released client writing into the dev loop's data.

**Rules out.** Reading `import.meta.env.VITE_STDB_*` (or any build-time server address) in client code;
fetching the document at start-up (an asynchronous read moves the throw out of module scope); deriving
the target from `location` (a desktop shell's page origin is not the server); `type="module"` on the
shell-config script or a `client/public/shell-config.js` (either fixes the target at build time);
normalizing `uri` or `db` (case, trailing slash, default port: it would orphan stored identities);
substituting a default for a present but invalid document; echoing a document value in a start-up error
(a refused `uri` may carry credentials).

## The desktop shell is Electron; a preload script hands the client its connection

**Decision.** The desktop (Steam) build hosts the unchanged web bundle in Electron. The shell gives the
client its shell document from a preload script: `contextBridge.exposeInMainWorld('__MR_SHELL_CONFIG__',
document)` in a window with `contextIsolation: true` and `sandbox: true`. Measured on Electron 45.3.2, that
makes `__MR_SHELL_CONFIG__` an own, read-only property of the page's global object before the page's first
script and before its module script run, on first load and after a reload, from `file://` and from a custom
protocol; the page sees a frozen copy, and the page's own `/shell-config.js` script cannot replace it
(the property is not writable). Where the licence terms cover bundling, the shell starts the server
as a child of Electron's main process and stops it when the app quits; otherwise it starts nothing and
connects to a server the player installed. Steamworks calls stay in the main process. The evidence, the
judge's scores and the measurements are in `docs/local-play.md`.

**Why.** The shell must not fork the client, and the engine it renders in decides whether the e2e suite's
coverage carries over. Electron ships Chromium, the only engine family the suite runs; Tauri renders in
WebView2 on Windows but in WKWebView on macOS and WebKitGTK on Linux and the Steam Deck. Early access is the Steam build: Electron has
a documented route to the Steam overlay, Tauri's request for one is closed as not planned, and a launcher
that opens the system browser has no window to draw it over. A judge scored the three from one dossier:
Electron 50, the launcher 44, Tauri 43 of 65 weighted. Unweighted the launcher leads by a point (27, 26,
26); what Electron pays is size, a 151 MiB archive on Windows beside the 127 MiB server.

**Rules out.** A system-webview shell (Tauri) while the e2e suite runs Chromium only; shipping the Steam
build as a launcher plus the player's own browser; delivering the shell document in the desktop build by a
fetch, by editing the bundle's `index.html`, or with context isolation off; Steamworks or Node APIs in the
page. The choice stands on one thing nobody has measured: the Steam overlay drawing over an Electron window
on Windows. That is proved before anything else is built on the shell, and if the overlay cannot be made to
draw, this entry is rewritten, not worked around.

## The client reaches its host through ports cut where a second host needs one; a shell supplies them through one page global

**Decision.** A capability the client takes from whatever hosts its page (a browser tab, or a desktop
shell) has one owner in the client. Where a second host must provide it differently, the owner is a
port: a module under `client/src/platform/` that exports plain functions and holds the browser's code as
the default. Where every host provides the same web API, the owner stays a narrow structural type the
real global satisfies (the storage hosts, the pad read, the key event, the media query, the window size)
or a DOM registration `main.ts` or `connect` makes. A shell supplies a port's function through one page
global, the shell bridge, set before the client module runs by the hook that sets the shell document; it
holds functions only, and a verb it does not hold runs the browser's code. Every shell implements the
same bridge, so one bundle runs in a tab, in Electron and in Tauri. The first port is the hand-off to
the operating system: open an address outside the game, save a file the client made. The call sites,
the plan and the judge's scores are in `docs/refactors/client-platform.md`.

**Why.** The recorded shell is Electron, and that choice rests on an overlay nobody has measured: the
measurement runs a Tauri window beside it with the same bundle and may reverse the choice. A desktop
shell refuses `window.open` and navigation off its own origin, a blob download is not known to work in
every webview, and Steam's calls have no web API, so some capabilities cannot be reached through the web
platform alone. Storage, input, size and visibility are the same API in all three hosts: a wrapper
around them would have one implementation and nothing to adapt.

**Rules out.** One host object carrying every concern; choosing the adapter at build time (one bundle
per shell, and shell code in the client tree); leaving everything to the shell's own handling of web
APIs (no route for a call with no web API); a port for a concern no second host needs; a bridge that
hands the page an object of the shell's, or a bridge function that acts on what the page sends without
checking it in the shell's own process. Whether a shell's page may call into the shell at all is that
shell's security posture. The operator allowed the bridge (2026-11-27, #892), limited to the verbs the
plan names, and the Electron shell's spec (lpw-11) exposes the bridge's functions beside the shell
document. A shell that exposes none still fits, because the browser's code runs and it handles those
web APIs itself.

## Local-play budgets are measured medians with stated headroom, on one machine profile

**Decision.** A single-player world and a friends server hold these budgets, measured the way
`docs/local-play.md` describes, with the server confined to the two threads of one core and 2 GiB:

| | Single-player world | Friends server |
|---|---|---|
| Memory | 330 MiB (1.49 times the 220.8 median) | 330 MiB (1.52 times the 216.4 median) |
| Idle CPU | 1.4 % of one thread (1.57 times the 0.89 median) | 1.0 % of one thread (1.54 times the 0.65 median) |
| Start-up to playable | 800 ms (1.49 times the 538 median) | 800 ms (1.49 times the 538 median) |
| Disk growth | 12 MiB per hour (1.46 times the 8.23 median) | 68 MiB per hour (1.51 times the 45.01 median) |

The record defines each measure and the condition it is taken in. The friends-server memory and disk
numbers are a walking-only floor, set again when battles and trades are measured. Work that changes what
the server does per tick, per connection or at start-up re-measures and holds these.

**Why.** The server runs on the player's machine beside the game, so its cost is the player's, and a
budget nobody measured is either ignored or blocks the wrong change. The measured costs are small and the
three runs of a condition agree closely (the record gives the spread), so a budget near one and a half
times the median catches a real change without tripping on noise. The cost that never stops while someone
is connected is the movement tick, which commits a transaction five times a second even when every player
stands still.

**Rules out.** Raising a budget without re-measuring and rewriting the record; comparing a run on another
machine, without the constraints, or in another condition to these numbers (clock and disk speed are not
modelled; a run on real low-end hardware replaces the profile and the numbers together); reading the
friends-server memory and disk numbers as a ceiling for play with battles and trades.

## A target's kind gates telemetry and account sign-in: only servers we operate get either

**Decision.** The shell document names the target's kind (`official`, `test`, `local` or `private`;
`TARGET_KIND` in `client/src/shell/config.ts`). `resolveTelemetryConfig` takes it as a required
parameter and runs an exhaustive `switch` before it reads any env value: only `official` and `test`
reach the endpoint and interval rules, and `local` and `private` resolve `disabled`, so the
OpenTelemetry SDK never loads. `main.ts` reads the build's `VITE_MR_OIDC_ISSUER` in one module-scope
assignment that keeps it only for `official` or `test`; any other kind holds the empty string. That
one value goes to `connect` and to `signInOffer` (`client/src/ui/claimModel.ts`), which decides
whether the Profile screen's Account section offers Sign In and under which name: the build's
`VITE_MR_OIDC_PROVIDER_NAME`, or the issuer string when the build names none.
`VITE_MR_OIDC_CLIENT_ID` reaches `connect` under the same kind test, and `connect` gets
`signIn: 'oidc'` only when that issuer is non-empty, `'off'` otherwise. With `'off'` it builds no
OIDC client, so every connection is anonymous, `startSignIn` only reports `'sign-in-off'`, and no
OIDC request leaves the page whatever its URL or storage holds. A production document that omits `kind` resolves to `private`,
so it gets neither. The OTLP endpoint stays a build value; the
run-time decision is only whether to use it. Two tests hold both gates:
`client/src/observability/config.test.ts` (every kind but `official` and `test` resolves disabled)
and `client/src/main.targetKindGate.test.ts` (boots `main.ts` under each kind, and reads the Sign In
control, the connection's sign-in calls and, through the real connection, every OIDC
request). The control reads "Sign in / create account with
<provider>" (`claim.signInWithProvider`), because registration happens at the provider (operator
ruling, <https://github.com/mdrewt/monster-realm/issues/588>). The e2e build sets the server's
placeholder issuer `https://auth.monster-realm.invalid/` and a provider name
(`client/playwright.config.ts`), so the browser suite runs the labelled sign-in and its fail-safe;
the hidden control is proven by the DOM view tests and `main.targetKindGate.test.ts`.

**Why.** The same build joins worlds we do not operate (see "One game, three ways to play: no code
may assume we run the server"). Metrics from a friend's or a single-player world would reach our
ingest carrying the client's address, timing, build and device class though the player never used
our service. The account token is our issuer's id_token addressed to the build-wide client id, so a
host that received it could replay it against the official server. The Sign In control follows the
value `connect` received, so it shows exactly where a sign-in can start and the two cannot disagree;
with no issuer the prompt says accounts are not available on that server. The issuer and the
provider name are build values that reach the client at this one seam, and no client logic assumes a
provider, so each build can point at its own OIDC provider. Both gates are allow-lists, so a kind
added later is off until someone classifies it. The kind is the host's claim and is trusted exactly
as far as the client code the host serves; a host that claims `official` or `test` can send its
players' metrics to our ingest, which is accepted (the metrics carry no account identity).

**Rules out.** Gating either on a build-time flag or on the page's `location` (the build must not
know its server; a desktop shell's page origin is not the server); a deny-list of `local` and
`private`; moving the telemetry endpoint into the shell document (a friends host copying our
document would carry it); reading `import.meta.env.VITE_MR_OIDC_ISSUER` anywhere but that one
assignment, or deciding the Sign In control from anything but the value `connect` received (a second
read or a second kind test lets the control and the connection disagree); treating the hidden
control or the empty issuer as a complete off switch (hiding is presentation: a hidden button still
dispatches, so the `claimSignIn` command checks the offer itself; and an OIDC client built with an
empty issuer still runs the token exchange for a tab that holds a stored refresh token or a sign-in
redirect's code, fetching discovery from the page's own origin, which is why `'off'` builds no
client at all). Client logic that assumes a provider, or a provider label derived by parsing the
issuer URL (the OIDC flow already refuses an issuer it cannot use). A per-world telemetry opt-in or
per-world sign-in changes these two gates and their tests, not a side path.

## A single-player or friends world keeps its anonymous reconnect token on the device; a server we operate keeps it per tab

**Decision.** `tokenPersistenceFor(kind)` (`client/src/net/authToken.ts`) is an exhaustive `switch`
over the target's kind: `local` and `private` keep the anonymous reconnect token on the device (the
origin's `localStorage`), `official` and `test` keep it per tab (`sessionStorage`); a run-time value
outside the type is per tab. `createAuthTokenGate` takes that choice and uses exactly one area, never
the other: a blocked area means an anonymous connect, not a fall back. The key is derived from the
target's `(uri, db)` in both areas, and the rule that withholds the token after two rejections since
the last successful connect is the same in both (the token is withheld, never deleted). Only an
anonymous build's token is saved; the account-kind marker, the guest-claim code and the OIDC flow stay
in per-tab `sessionStorage` for every kind. `ConnectionOptions.targetKind` is required, `connect()`
builds its one gate from it, and `main.ts` passes `TARGET_KIND`. `client/src/net/authToken.test.ts`,
`client/src/net/connection.runtime.test.ts`, `client/src/main.targetKindGate.test.ts` and the browser
spec `client/e2e/local-identity.spec.ts` hold it.

**Why.** Sign-in is off toward `local` and `private` targets, so the token is the only thing that
identifies the player there; kept per tab, every launch would start a new character. Two pages may
share one identity because the server removes presence rows and saves the position only when an
identity's last connection ends. Toward a server we operate the account is the durable identity, and
per-tab storage keeps a guest's token from outliving the tab on a shared browser profile.

**Rules out.** `localStorage` for every kind; falling back from one area to the other; saving an
account token in either area. Accepted costs: a device-kept token is readable by every script in the
page's origin for as long as it is stored, so whatever serves the page must keep foreign script out
of that origin, and it stays in `localStorage` if a target's kind later changes; a production
document that names no kind resolves to `private` (`kindOf` in `client/src/net/connectionConfig.ts`)
and keeps its token on the device; and because the withhold rule is unchanged, a successful anonymous
connect after two failed verifications replaces the stored token for good.

## The e2e job lists the tests that passed only on a rerun; a flake stays in `docs/e2e-flakes.md` until its fix merges

**Decision.** The CI `e2e` job (`scripts/e2e-shard-union.mjs`) judges each shard by its highest
attempt. When that attempt's reports are readable, it also reads every lower attempt of the shard.
A test that is `unexpected` on a lower attempt and `expected` on the highest passed only on a
rerun. The script prints a `rerun-passed:` line and one `::warning` annotation for each such test.
It also appends a table of them to `$GITHUB_STEP_SUMMARY`, or "No e2e test passed only on a
rerun." when there are none, on a failing run too. A lower attempt with no readable `e2e.json`
gets a `rerun-unreadable:` line. The listing changes no verdict: a green highest attempt still
passes the job. Playwright `retries` is unset, so a rerun of failed jobs is the only second
attempt, and a report's `flaky` count stays a failure. `docs/e2e-flakes.md` registers the e2e
flakes whose fix has not merged. Each entry gives the test, the runs, the signature, every forcing
recipe tried with its counts, the verdict (product or test) and the next step. The change that
fixes a flake deletes its entry. A test the listing names that has neither an entry nor a residual
row of its own is a new flake and gets an entry. A flake that its own row holds may stay a row
until a study takes it.

**Why.** Before the listing, a test that failed and then passed on a rerun left no mark on the run.
The only way to find one was to read the attempt-1 jobs of every rerun run by hand. Failing a run
that needed a rerun would instead turn every flake into a red `master` and push reruns into fix
slices. GitHub caps a step's annotations, so the summary table is the complete list. Up to that
cap, the annotations let a later tool count rerun-passed tests per run through the check-runs API
without reading logs. A single register keeps a flake's evidence in one place until a merged fix
makes it history.

**Rules out.** Failing the `e2e` job for a test that passed on a rerun; a flake entry that outlives
its merged fix; a second flake list beside the register.

## The party is read through an `(owner_identity, party_slot)` index

**Decision.** The private `monster` table has two indexes over its owner
(`server-module/src/schema.rs`). The single-column `owner_identity` serves reads that need every
monster an owner holds: re-key, erase, export and `has_monsters`. `owner_party` is a btree over
`(owner_identity, party_slot)`. Every party read on a per-input or per-tick path goes through its
`(owner, 0..PARTY_SLOT_NONE)` range, which yields the party in slot order. Those reads are
`battle::lead_party_ids` (every accepted `enqueue_move`, the tick's band check, the tactical start,
`refresh_lead_level`) and `monster_mgmt::set_party_slot`'s occupied-slot read; `raising::heal_party`,
once per heal, still filters `owner_identity`. A compile-time
assert in `battle.rs` pins `PARTY_SLOT_NONE == u8::MAX`, because only then does the range mean
"not in Storage".

**Why.** Storage has no cap, and the owner filter read every monster the player held on every
input. With 1,000 Storage monsters, `enqueue_move` cost 13.9 times its cost with one (549.9 µs
against 39.6 µs). Through the range it costs 1.37 times (57.6 µs against 42.0 µs), and a control
shows that the remainder follows the table's size, not the owner's Storage (`mr_load_driver`, 20
clients, median of 5).

**Rules out.** Reading the party on a per-input path through `owner_identity` and dropping Storage
rows; capping
Storage to bound per-input cost; a `PARTY_SLOT_NONE` other than `u8::MAX` without changing the
range.

## Owner views are rebuilt only when dirty

**Decision.** `client/src/net/viewReconcile.ts` owns the owner-view reconciles and a dirty set
(`createOwnerViewReconciler`: `markDirty`, `markAllDirty`, `reconcileOwnerViews`). A batch rebuilds
a view from the SDK cache only when that view is dirty. Each view's `onInsert`/`onDelete` handler
marks it: `connection.ts` loops over `OWNER_VIEWS`, and there is no `onUpdate` and no per-row store
write. `markAllDirty` runs in three places: beside `store.reset()` on a drop, after every build's
`wireTables`, and first in the base subscription's `onApplied`. A view is cleared once its
reconcile returns. A throw leaves that view, and the later dirty views of its try group, dirty for
the next batch. Every non-view row handler is wrapped in `recoverViewsOnThrow`, which marks every
view, schedules the flush and rethrows. A new owner view gets a `RECONCILE` entry and a
`TRY_GROUPS` slot.

**Why.** Rebuilding every owner view (thirteen when measured) on every batch cost about 0.5 ms with 1,000 Storage
monsters. That included a batch of only `character` and `player` rows, which arrives on every
movement step. With the dirty set that batch costs about 0.0005 ms (node, median of 400). A view's
update arrives as an unordered insert and delete pair, so a rebuild stays whole-view and is read
from the cache; only how often it runs changed. The SDK's dispatch loop has no try/catch, so a
throwing row handler skips the rest of a message whose rows are already cached. Without marking
every view on a throw, those views would stay stale and clean.

**Rules out.** Rebuilding every view on every batch; writing a view's rows into the store from its
row handlers; a row handler that throws without marking every view.

## Load is measured at the client's scope: `mr_load_driver`, a nightly smoke, reducer share by reducer

**Decision.** `sim-harness/src/bin/mr_load_driver.rs` is the load tool. Each bot holds what a
walking client holds of `player` and `character`: `SELECT * FROM player`, byte-identical to the
client's, plus its per-zone `character` queries. It holds none of the client's other tables, which
walking does not write. The report gives each level's received bytes per client per second,
as a mean and for the worst bot (`rx_bytes_per_client_per_s`, `rx_bytes_per_client_per_s_max`),
over the driver's own scrape window. `MAX_CLIENTS` is 1,000. With `--fail-on-invalid`, an invalid
level exits 3. The nightly `load-smoke` job publishes the default module build to an in-memory
host and runs `just load-smoke` (20 clients, one level, `--fail-on-invalid`), so the nightly goes
red when a level is invalid: no bot joins, a bot's zone scope never settles, or no move reaches
the server. A level where every move is rejected stays valid, as a measurement of a saturated
server. Runs over many zones use the load-only build from `just load-host`
(see "Dev-only reducers never ship"). Reducer-thread share is the recording rule
`mr:reducer_thread_share:rate5m`, `sum by (reducer) (rate(spacetime_txn_elapsed_time_sec_sum[5m]))`
(`ops/observability/rules/recording.rules.yml`). `promtool test rules` tests it under
`just observability-validate`.

**Why.** The host's `spacetime_num_bytes_sent_to_clients_total` counts a delta once, not once per
subscriber, so only a client's received bytes measure fan-out, and a bot that subscribes less than
the client under-counts it. The host series also holds each reducer's `Update` rows beside its
`Reducer` rows, and non-reducer transactions as one series with no reducer label. The rule's total
is therefore transaction-seconds per second and can exceed 1.0. It is a share by reducer, not a
utilisation.

**Rules out.** A host-side byte counter as the per-client budget signal; a driver whose
subscription differs from the client's; a CI load run that exits 0 on an invalid level.

## The official server is sized for 1,000 concurrent players over 100 zones

**Decision.** The operator set the official server's population target on 2026-11-12 (the
harness's `game-design.md` §14). The world has up to about 100 zones. A zone holds 8–12 players
on average, and about 50 in a few zones. The world holds about 600 concurrent players on average
and about 1,000 at peak. It stores 50,000 accounts; that count is a default, not an operator
figure. The budgets every population-scaled cost is held
to are:
- a zone tick's p95 under `STEP_MS`;
- input round-trip p95 under 50 ms;
- download under 20 KB/s per client;
- the reducer thread under 50% at a 30% walking share.

The run of record is `mr_load_driver` against `just load-host`: 1,000 clients over 100 zones, one
zone filled to 50, 30% walking. A breached budget becomes a follow-up. Revisit the target if the
game outgrows it.

**Why.** Single-player and private worlds run on a player's own machine and are budgeted in
`docs/local-play.md`. Only the official server holds many players, so it alone sizes scaling work.
A client's download follows the walkers in its subscription scope: about 0.85 KB/s plus 0.077 KB/s
per walker, measured in one zone up to 100 walkers. By that line the 20 KB/s budget is reached near
220 walkers in one zone; that figure is extrapolated, not measured. The reducer thread is one writer
for the whole world. The target also sets `battle_summary`'s cap and the leaderboard's rescan size.

**Rules out.** Sizing scale work from playtest populations, where 2–5 players hide every such cost;
a per-input, per-batch or per-join cost that grows with stored accounts or monsters owned.

## A private world checks an account itself: a one-use ticket at first contact, then the account's handle

**Decision.** In a single-player or friends world the player connects under that world's own
anonymous token and never sends an account token. The world asks our account service itself whether
the player's account owns the game, through three procedures in
`server-module/src/account_checks.rs`, and keeps the answer in private `world_account {handle,
identity, entitled, checked_at_ms, is_host}`, which an identity reads through `my_world_account`
(its own row alone). A handle is what the service answers for one account in one world: opaque, the
same at every check, and not a credential.

- **First contact.** A client whose identity the world does not know asks the account service's
  `POST /ticket` for a one-use ticket naming the world as its own software authenticated it, and
  calls `check_account(ticket)`. The procedure refuses a ticket that is not 43 base64url
  characters, and refuses once the world has sent 30 ticket redeems in the current minute (the one
  row of `world_check_budget`); neither refusal sends anything. Otherwise it presents the ticket,
  every name the world answers to and its database identity at `POST /world/check` under a 3 s
  timeout, and stores the answered handle and entitlement, a negative answer included, in one
  transaction; `Ok` carries whether the account owns the game. A `403` (`the account service
  refused the ticket`) and any other failure, a timeout included (`the account service gave no
  answer`), refuse the call and change no `world_account` row. An identity the access rule has not
  admitted cannot connect, so the world's owner relays its ticket through `check_account_for(who,
  ticket)`; the relay counts in the budget and is never refused by it. A handle another identity
  holds is refused, and so is a second account for an identity that holds one (it unbinds first).
- **Each later connection.** The connect reducer arms one one-shot `recheck_schedule` row for an
  identity whose row was last checked 10 minutes ago or more, that has none armed and whose
  account is not pending deletion, and stamps the row's `checked_at_ms` as it arms: the world asks
  about one identity at most once in 10 minutes, however often it connects and whatever the run
  does. `checked_at_ms` is therefore when the world last asked, not when it was last answered.
  The host runs
  `recheck_account` from it (any other caller is refused before anything is sent), which presents
  the stored handle and stores the answer: a handle the service does not know is stored as not
  entitled; a handle under the service's newer key takes the stored one's place in `world_account`
  and in `world_allowlist` in the same transaction; a newer handle another identity already holds leaves
  the row's handle and stores the standing on it. The connection is admitted and entitled by the
  stored row the whole time, and a row never expires. A run with no answer leaves whether the
  account owns the game unchanged, the host spends the one-shot row whatever the run did, and the
  first connection 10 minutes after the arming asks again.
- **Deciding after a wait.** Other transactions run while a request waits, and a transaction's body
  may run twice. The transaction that stores an answer reads again every row it decides on (the
  admission or the ownership, the deletion state, the world's names, who holds the handle), and a
  re-check leaves alone a row that was unbound, checked again or replaced meanwhile, so an older
  answer never overwrites a newer one. A refusal is logged once, outside any transaction. No log
  line, table or return value holds a ticket, and no log line or return value holds a handle.
- **What reads the row.** `accounts::entitled` (see "Ownership is enforced unless a dev feature
  switches it off") and, under `Allowlist`, `access::is_admitted`, which admits an identity that
  holds a row exactly while its handle is on the host's list (see "A world that is not open refuses
  an unadmitted identity at connect and in every reducer; the owner relays the door").
- **Erasing it.** `unbind_world_account()` erases the caller's row with its armed re-check, and the
  owner's `drop_world_binding(identity)` does the same for a named identity. The unbind is the one
  reducer of the client roster the access rule does not gate, so a player whose handle the host
  took off the list can still erase the link, over a connection the connect reducer let in while
  the player was admitted. When a row goes, that identity's `world_admission` row goes with it,
  under every rule. A caller with nothing to erase gets `Ok` with no write (the drop answers `that
  identity holds no world binding`), and an account pending deletion is refused by the deletion
  gate. The deletion cascade takes the identity's handle off the host's list and erases the row;
  a guest claim erases the row of the guest identity it retires and moves none; the data export carries the
  caller's own row.
- **Which service.** `BuildProfile::world_check_url` (see "The official build holds no attestation
  key and a world build trusts no login issuer").
- **What keeps the surface closed.** `findDefinitionViolations`
  (`scripts/verify-release-reducers.mjs`) refuses a module definition that declares any procedure
  but these three, or any schedule but the module's own, on the default build and on each release
  artefact. The reducer census (`server-module/src/privacy_enforcement_tests.rs`) refuses a
  `procedure` attribute outside `account_checks.rs` and pins the tables each procedure reaches:
  `world_account`, `world_check_budget` and `world_allowlist` for the two first-contact
  procedures, `world_account` and `world_allowlist` for the re-check. The client's procedure
  surface is pinned by `evals/client-surface-privacy.eval.mjs`, and the wire contract records each
  procedure's arguments and return type.

The attestation binding is compiled beside it (`server-module/src/world_binding.rs`: the
tables `world_binding` and `world_bind_nonce`, their two views, the four nonce and bind reducers
and the verifier). It records a binding that nothing reads: it entitles and admits nobody, and
it is to be removed with `POST /attest`. Not built: the character that follows the account
from one identity to another (until then the second identity of one account is refused), the
host account's daily check and the rule for a world's `ip:` names (until then every name is
presented), the client's half, and the gate that refuses a caller who is not entitled in
every reducer. Proved by `server-module/src/account_checks_tests.rs` on the native test
host, with every answer of the service stubbed. The measurements on 2.16.1, the four alternatives
with a judge's scores and the slice changes are in `docs/refactors/account-checks.md`.

**Why.** A world's host owns its database and its signing key, and every standalone host calls
itself the issuer `localhost`, so a world cannot prove its name to a third-party provider and an
account token given to it could be replayed against the official server. The ticket is spent at the
service with the names the world answers to, so what a player gives one host opens no other world.
A world that asks for itself re-checks a client that never asks, which a credential the client
fetches cannot; no key or verifier has to sit in a build; and a reader of a world's data finds
handles, not account subjects. The stored status admits while a request waits because a module
cannot hold a connection open or close one: a check that had to land first would turn an outage of
our service into an outage of every world. Arming stamps the row because the host spends the
one-shot row before the run ends and a failed run stores nothing: without the stamp a client
that reconnects in a loop has the world send a request at every connection, past the service's
limit for the world's address, and every other player's check then fails. The budget bounds what
free identities in an `Open` world can make a world send; the relay is outside its refusal so the host can always check in
whoever it chooses, its own player included. The unbind and the drop take the admission row
because, while an identity holds a `world_account` row, `Allowlist` governs it by its handle alone
and leaves the admission row unread, and every rule change keeps that row: erasing the account row
alone would let back in an identity whose handle the owner removed. The choice rests on the bundled
host's `[module-http]` being on, which the operator decided
(<https://github.com/mdrewt/monster-realm/issues/874>): with it off a shell world checks nobody.
On, it adds nothing a host's owner could not already do: the host refuses loopback and private
addresses, and the module reaches only the account service the build names.

**Rules out.** Sending an account token to a world we do not operate (see "A target's kind gates
telemetry and account sign-in"); a third-party provider as the party a world asks; storing an
account's subject in a world; a ticket or a handle in a log line; refusing a known identity while
the service cannot be reached; running a failed re-check again within the connection that armed
it, or arming one for an identity at every connection;
storing an answer without reading again the rows it was decided on; refusing the owner's relay by
the budget; an admission check on the unbind (a removed player could not erase the link); keeping
the admission row through an unbind or a drop. Defaults the operator may overrule (asked on
<https://github.com/mdrewt/monster-realm/issues/861>): the withdrawal writes `world_admission`, so an
unbind in a `Password` world costs the player the door, and so does an unbind under `Open` by a
player who is offline when the rule changes to `Password`; after an unbind under `Password` or
`Allowlist`, a player other than the owner is refused by the access check and cannot check in again
without the owner's relay; a removed player who has disconnected cannot reach the unbind, since
every route runs the connect reducer first (see "A world that is not open refuses an unadmitted
identity at connect and in every reducer"); the `test` and `dev-enforcing` builds name the
`hosted-dev` account service, so a dev server's `check_account` sends real requests there; and an
answer whose `handle` is missing is stored as not entitled whatever else it says.

## The attestation is signed with Ed25519 and checked by `ed25519-dalek` compiled into the module

**Decision.** A world attestation is what the account service's `POST /attest` signs; the binding
the module records from one grants nothing (see "A private world checks an account itself: a one-use ticket at first contact, then the account's handle").
It is signed with an Ed25519 key, and the module checks the
signature with the `ed25519-dalek` crate (3.0.0, no default features), through `verify_strict`.
`world_binding::verify_attestation(keys, attestation)` runs these checks in order: a token over 4096
bytes is refused before anything is decoded; three non-empty segments of strict unpadded base64url
(`base64` 0.21); a header that is a JSON object, of which only `kid` is read (`alg` never is); the
key from the build's own `kid`-keyed list, never from the token; a 64-byte signature that
`verify_strict` accepts over `<header>.<payload>`. The payload is parsed only after the signature
verifies (`serde` derive over `serde_json`): string `sub`, `aud` and `nonce`, integer `exp`, optional
`mr_ent` array of strings, a repeated or wrongly typed member refused, `sub` 1 to 255 visible ASCII.
`iss`, `iat` and `jti` are not read. Replay is keyed on the world's spent nonce, never on the token's
text. The measurement and the judge's scores: `docs/local-play.md` §3, "What a signature check costs
inside a reducer".

**Why.** An ES256 verifier (`p256`) and an Ed25519 one both build for `wasm32-unknown-unknown` with
no clock and no source of randomness, and both cost far less than the 5 ms one check may take: 593
µs and 108 µs, the median of 101 checks inside one reducer on a 2.11.0 host. Ed25519 costs a fifth
as much, the margin a slow host and a flood of failing tokens use up; `verify_strict` refuses
non-canonical signatures and small-order keys, where ECDSA accepts two forms of every signature;
and an Ed25519 key cannot be loaded as a P-256 login key or the reverse, so attestation and login
keys cannot verify each other's tokens by key type as well as by key list. The cap exists because
a check hashes the whole token: its cost grows with length (past 5 ms between 400 and 700 KiB) and
a token that fails costs what a valid one costs.

**Rules out.** ES256 for the attestation, though it would keep one algorithm across the account
service. It becomes the choice if the production host's key service cannot hold an Ed25519 key,
since signing keys live there and that host is not chosen; ES256 fits the budget too.
`ed25519-dalek`'s plain `verify`, which accepts signatures `verify_strict` refuses, and its `fast`
feature (4 percent faster for 11 KB more). Any crate feature that brings `std`'s clock or
`getrandom` into the module: `p256`'s `precomputed-tables` does through `std`, and the compiler
does not always refuse it, so the built module's import list is the check. Audience-scoped account
tokens, the fallback for a verifier that did not fit.

## An attestation names the server as the player's own software authenticated it

**Decision.** The `aud` of a world attestation is one string: `spki:<fingerprint>/<db>` for a server
the desktop shell pinned and for a `local` world, whose fingerprint the party that started it wrote
into the shell document; `dns:<host>:<port>/<db>` for a domain server the platform's certificate
checks validated; `ip:<address>:<port>/<db>` for a server a browser reached by a bare IP address
under a publicly trusted certificate for that address. Any other target has no name, and the client
asks for no attestation for it. The name comes from the party that authenticated the server, never
from the world and never from a page we did not serve. In the shell the main process computes it
and calls the attestation route, refusing every certificate error, and the shell's page is given
the attestation and no login token. For a browser joiner the browser authenticated the server, and
the account service derives the name from the address it sends that browser back to (see "A browser
binds a friends server by a sign-in on the account service's own origin; the attestation names the
address the browser is sent back to"). A world holds its own names in a private table its owner
writes with `set_world_names` (at most 16, each 1 to 512 visible ASCII characters; a world with no
name accepts no binding), and `bind_world_account` accepts an attestation only when its `aud`
equals one of them, byte for byte. A `dns:` or an `ip:` name is listed only while the server holds
an unexpired, publicly trusted certificate for it; the certificate for an address is issued for the
world's own key, so the shell's pin and `spki:` hold on the same listener. Built: the module's
half, proved by `mod bind_refuses` and `mod relay_rig` in
`server-module/src/world_binding_tests.rs`. Everything else is designed and not built:
`docs/local-play.md` §3, "The access and attestation design", fork (c), and "A browser binds a
friends server it reached by address", fork (g).

**Why.** A hostile host can have its player's client fetch an attestation addressed to another
world, carrying that world's nonce, and present it there as its own. An audience and a nonce stop
that only if the audience is something the host cannot make true of its own server. A host cannot
present another world's certificate without its private key, whether it relays or proxies, and
cannot get a browser-trusted certificate for a domain or an address it does not control. A browser
shows a page nothing about the certificate it accepted and cannot pin one, so all it authenticates
is the address, through the public certificate authorities; they certify a public IP address
(Let's Encrypt for 160 hours at a time) and never a private one.

**Rules out.** Naming the key that verifies the client's world token (a host that proxies the
client to the victim world hands it a genuine token under that world's key, and keeps the token);
naming the database's identity (its host's to state); naming an address under a certificate no
authority issued (private addresses repeat on every network, nothing ever removes a stale name, and
a warning the player accepts authenticates nobody); a name the account service reads off a
connection of its own to the server (a host forwards that connection to the victim and answers
browsers itself); a name supplied by the world or by a page a gate served; an invite, shell
document or address entry that carries a reconnect token; an `ip:` or `dns:` name kept after its
certificate. Limits, a default the operator may overrule: an address or a domain name proves who
answers there when the player binds, and nothing about before or after. A world that moved keeps
accepting its old address's name until its certificate expires (160 hours at most for an address,
the certificate's life for a domain name), and a browser
that loaded an earlier server's page at the same address and port may still run what that page
left there. A name issued for the server's key, under a DNS zone we would operate, closes both and
was weighed and not chosen (R-lpw-19-CHANGEDHANDS).

## A browser binds a friends server by a sign-in on the account service's own origin; the attestation names the address the browser is sent back to

**Decision.** A page that a friends server's gate serves never signs in and never names the server.
It posts the world's nonce, the database, its own origin and the digest of a value it keeps to a
bind route on the account service, as a top-level navigation. The service runs its sign-in step on
its own origin, issuing no ID token, code or refresh token and starting no session, then shows the
server's address and asks for consent every time. On consent it derives the attestation's `aud`
from the address the bind returns to, `dns:<host>:<port>/<db>` or `ip:<address>:<port>/<db>`, and
redirects the browser to one fixed path at that address with a one-use code in the fragment; the
page redeems the code, with the value it kept, for the attestation, and binds with it. The route
takes only an `https:` origin in the URL parser's own spelling that equals the post's `Origin`
header: a domain under a public suffix, or a globally reachable IP address. Nothing is sent to the
server before the player presses Continue or Cancel, and the address, database and nonce reach no
database, log or backup. A page asks for a bind when the world says it needs one and once a day
otherwise, a default the operator may overrule. Operator ruling,
<https://github.com/mdrewt/monster-realm/issues/833>: a player at a public computer joins a
friend's server from a browser by its address, a static IP address included. Designed, not built:
`docs/local-play.md` §3, "A browser binds a friends server it reached by address", fork (f), with
the measurements and the judge's scores.

**Why.** The account service cannot see which server a browser is talking to, and does not need to:
the code exists only in a redirect to an address, and a browser completes that navigation only to
a server showing a certificate it trusts for that address, so only script running in that origin
can redeem an attestation that names it. A hostile host's page gets an attestation for its own
address, which no other world lists. The code, not the attestation, travels in the redirect because
a browser's history keeps the whole address after the page removes the fragment (measured in
Chromium 149), and the ruling's case is a shared computer. The service issues no token because a
page that holds none cannot leak one. Consent comes before any redirect so that no site learns,
unasked, that a visitor has an account or whether it owns the game.

**Rules out.** A page a gate serves signing in, with the game's client id or with a client
registered for its own origin (it would hold a login token, and a refresh token that mints
attestations with no player present); a world name taken from the page; the attestation in the
redirect itself; a window that posts the attestation back to its opener (the sign-in page would
have to keep an opener that can navigate it); approval on a second device (nothing delivers the
answer through the player's browser, so the name would be the asking page's claim); a return path
that varies or redirects (the fragment follows a redirect to wherever it leads); a redirect before
consent; a sign-in session or any cookie that admits a later bind; accepting `Origin: null` (the
gate's page sends a referrer policy that discloses its origin). Limits: a hostile page chooses
when to send a player to a sign-in and can send them to a look-alike; what an earlier holder of
the same address and port left in a browser acts as the server's page there (see "An attestation
names the server as the player's own software authenticated it").

## The official build holds no attestation key and a world build trusts no login issuer

**Decision.** A release build of the module is one of two. The `official` build trusts the
production login issuer and holds no attestation key. The `world` build, which the desktop shell
and the standalone server ship, holds the production attestation keys and trusts no login issuer.
Both lists are constants of the build: `BuildProfile::attestation_keys` is empty on `official`,
`default` and `conflict`, `PRODUCTION_ATTESTATION_KEYS` on `world` (empty, since no production key is
published, so a `world` build binds nothing and entitles nobody) and `DEV_ATTESTATION_KEYS`
(the published `local-dev` key; `hosted-dev` publishes none) on `test` and `dev-enforcing`; a test
holds the lists to the generated `account-service/attestation-public-keys.json`. On a build with no
key the six binding reducers (`bind_world_account`, `request_bind_nonce`, the owner-relayed form
of each, `unbind_world_account` and `drop_world_binding`) return `this server takes no world binding` as their first
statement, before anything is decoded, read or written; the unbind and the drop do so only on a
build that also names no account service to ask. A binding records the `kid` that signed it, and
no rule reads a binding on any build. On the `world` build
every token is an anonymous guest's. The two builds have one schema and one set of client bindings.
The builds also differ by the account service a world asks about an account
(`BuildProfile::world_check_url`, the `POST /world/check` address). `official`, `default` and
`conflict` name none: each of the three account-check procedures answers `this server checks no
account` as its first statement, and `entitled(ctx, profile)` reads no `world_account` row there,
so the official build has the login token as its one way in. `world` names the production service,
a placeholder under a reserved name that answers nothing, so a `world` build entitles nobody until
a real address ships. `test` and `dev-enforcing` name `hosted-dev`, because the host refuses a
procedure's request to `local-dev` on loopback (`docs/refactors/account-checks.md`, row P2). The
artefact's `mr_build_profile` section does not carry the address.
Proved by `mod binding_build` and `mod official_build` in `server-module/src/world_binding_tests.rs`
(the second under the `official` build, which no run of `just ci` includes: `cargo nextest run
--workspace --no-default-features --features monster-realm-module/official -E
'package(monster-realm-module) & test(/official_build/)'`). `docs/local-play.md` §3, fork (b).

**Why.** A ticket and an attestation are the only account credentials a private host ever sees,
and the same module source runs on every server, so the official server must be unable to take
either as an argument. A `world_account` row also admits by its stored status however old:
accepted there, it would let an account outlive a refund or a ban that a login token, reissued
within the hour, would catch. The refusal is what the compiled module holds. No row, call or
publish option reaches it, a fresh or restored database is closed, and a `world_account` or
binding row that reaches an official database admits nobody. With disjoint lists each release
build has exactly one way to be entitled.

**Rules out.** A row or flag that marks a database official (its owner controls it, and a fresh
database starts without it); relying on the world-name check and the attestation route alone; a
database identity compiled into the module; one release build that holds both lists; an
`entitled(ctx, profile)` that reads a `world_account` row on the official build. Accepted limit: a
`world` artefact published to the official database would check accounts and entitle by their
rows, so the official deploy publishes only an artefact whose recorded profile is `official`, and
writes no world name.

## Private servers carry their own encryption: a real certificate for a domain, a pinned self-signed one otherwise; plaintext only on loopback

**Decision.** The client opens plaintext `ws:` only to a loopback address: a single-player world,
or the desktop shell talking to its own host. Every other server is `wss:`, in one of two ways. A
server with a registered domain serves a certificate a browser trusts: the standalone server
obtains and renews one over ACME when given the domain, or the host puts their own certificate or
reverse proxy in front. A server reached by a bare IP address, public or on a LAN, and a shell world
opened to friends, serves a self-signed certificate made once per world and kept with the world's
data and its backups; a server at a public IP address may instead be given a certificate for that
address by a certificate authority, for the same key (designed, not built: `docs/local-play.md`
§3, "A browser binds a friends server it reached by address", fork (g)). The invite and the shell document carry that certificate's fingerprint
(SHA-256 of its public key), and the desktop shell completes a connection only to a matching
certificate, even one a certificate authority would accept. A plain browser joining a server under its self-signed
certificate loads the client page from the server's gate over `https:` and accepts the certificate
once; there the shell is the recommended way to join, and on a build that enforces ownership the
only one, since a browser has authenticated nothing an attestation could name. A browser binds a
server that shows a publicly trusted certificate, for a domain or for its address (see "A browser
binds a friends server by a sign-in on the account service's own origin; the attestation names the
address the browser is sent back to"). For a pinned target the client keys its stored reconnect
token on the fingerprint and the database name, not the address. Operator ruling, 2026-11-16,
<https://github.com/mdrewt/monster-realm/issues/821> (revising the same day's "plaintext only to
loopback and private-range addresses"); built by the harness spec `M-local-play.spec.md` lpw-18
(transport, certificate, pins, reconnect key) and lpw-17 (ACME for a domain, and for an address
under the browser design).

**Why.** The case that matters is a player hosting for friends over the internet, by bare IP or
domain, the way Minecraft servers are run. A home host has no certificate a browser trusts, so
requiring one would stop that hosting, and plaintext over the internet exposes the world token
(kept across launches) and all traffic to anyone on the path. A browser also refuses plaintext
`ws:` to anything but localhost from an `https:` page, so the plaintext rule would not work for
the browser client served over `https:`. A pinned fingerprint gives encryption and proof that the
joiner reached the server the invite named, with no certificate authority, and works on a LAN
with no internet. Public certificate authorities do not certify private addresses, so a LAN server
has no other choice. A home or LAN address changes; keying the reconnect token on the certificate
keeps returning players' characters when it does. TLS adds one round trip when a connection opens
and microseconds per message, which is negligible for long-lived WebSockets and the 32-connection
cap. The fingerprint is also a world identity a hostile host cannot forge without that world's
private key, and the account attestation names it to close the relay between private worlds, as
Minecraft's online mode binds its session check to the server's key.

**Rules out.** Plaintext `ws:` to any non-loopback address, LAN included, with or without a
warning; trusting a self-signed certificate without the invite's fingerprint in the shell;
regenerating a world's certificate on restart or upgrade (every friend's pin would break); a relay
or tunnel service we operate to carry friends' traffic; requiring every host to own a domain; a DNS zone and certificate broker we operate to
give every server a name (weighed for browser joiners and not chosen).

## A world that is not open refuses an unadmitted identity at connect and in every reducer; the owner relays the door

**Decision.** While a world's access rule is `Password` or `Allowlist`, the connect reducer
refuses, as its first statement, an identity that `access::is_admitted` does not admit
(`access::require_admitted_at_connect`), and every reducer of the generated client roster that is
not owner-only opens with `access::require_admitted`, except `unbind_world_account`, which makes no
admission check (see "A private world checks an account itself: a one-use ticket at first contact, then the account's handle"); the owner-only ones are `sync_content`, `set_world_access`,
`set_world_names`, `set_world_allowlist`, `drop_world_binding` and the two relayed binding reducers.
The binding reducers answer their build's refusal before that check; it reads nothing. The
procedure `check_account` makes the admission check before it sends anything and again before it
stores an answer, and `check_account_for` the owner check. A world with no
`world_access` row is `Open`. Under `Password`, `is_admitted` admits the owner and an identity in
`world_admission`. Under `Allowlist` it admits the owner; an identity that holds a `world_account`
row exactly while that row's handle is a row of private `world_allowlist` (at most 256 handles of
1 to 1024 visible ASCII, in the column named `account_subject`), and nothing else counts for it, so
delisting refuses at the next check; and an identity with no such row only when it holds a
`world_admission` row. An attestation binding is not read. The list is read at
every check and nothing is stored from it.
When the rule changes to one that is
not `Open`, `set_world_access` gives an admission row to each live identity that the rule in force
before the call admitted, and to none that rule refused. A new joiner's way in under `Allowlist`
is the owner's relayed account check (`check_account_for`) and the listing of the handle it
stored. Admission rows are written only by the owner-only
reducer `set_world_access`, which takes the joiners' identities, and deleted by a player's
own unbind and the owner's `drop_world_binding` when either erases a `world_account` row, and by the
deletion cascade and a guest claim (for the retired guest). A retired guest identity that reconnects
holds no world row: in a `Password` or `Allowlist` world it is refused until the owner admits it
or relays a check for it.

The list is the owner's to edit (`set_world_allowlist` replaces it) and is made from the players
already let in. When the rule changes to `Allowlist`, `set_world_access` adds the handle of every
`world_account` row whose identity the rule in force before the call admitted (under `Open` every
one; under `Password` those holding a `world_admission` row, and the owner's), beside the handles
already listed; its `admit` argument adds none. While the rule is `Allowlist`, the handle of the
owner identity's own row stays listed: `set_world_allowlist` stores it whether or not the call
names it, and a check of the owner's identity adds it. The list never passes 256 handles: a rule
change that would add past that, a `set_world_allowlist` that would store the owner's handle beside
256 others, and an owner's check under `Allowlist` of a handle a full list lacks are each refused
with the list's too-many error and no write. Under `Open` and `Password` the list is kept, stored
as the owner names it, and not read; the next change to `Allowlist` adds to it. A re-check that the
service answers under a newer handle puts that handle in the listed one's place. An account's
deletion takes the handle of the deleted identity's `world_account` row off the list; an identity
with no row takes nothing off, and a row the host typed that equals the handle goes too, because
it names the same account (`world_binding::delist_account_of`, called by
`accounts::account_deletion_reaper` before the row's erase). The row is the only record of the
handle, so an identity whose row is already gone takes nothing off: a player who unbinds, or whose
row the owner drops, before the account's deletion leaves the handle listed. A guest claim does not
write the list either, so the handle of the guest identity it retires stays listed until the host removes it.

The module declares no HTTP handler, no HTTP route and no row filter: a check of the generated
module definition refuses each, on the default build (`just module-definition`, in `just ci`) and
on each artefact `just release-module` makes (`scripts/verify-release-reducers.mjs`, over
`spacetimedb-standalone extract-schema`). All three sit behind the `spacetimedb` crate's
`unstable` feature, which the workspace enables, so that check is what keeps them out (see "The
crate's `unstable` feature is on; the generated definition is checked instead"). The same check and the deletion-gate census allow the three account-check procedures and no other. Built: the module's half (`server-module/src/access.rs`,
and the list in `server-module/src/world_binding.rs`); `mod admission_roster` in
`server-module/src/privacy_enforcement_tests.rs` takes the reducer roster from the generated
bindings' file names and executes every shipped reducer as an unadmitted caller on a `Password`
world. Designed, not built:
the gate's half (the door endpoint and its password check, closing a removed identity's sockets),
in `docs/local-play.md` §3, fork (a); see "The gate checks a world's password; the module never
receives one".

**Why.** Measured at SpacetimeDB 2.11.0 (the WebSocket, `call`, `sql` and the MCP tools) and again
at 2.16.1 (the WebSocket, `call`, `sql` and the MCP `sql` tool): every route that reads a row or
calls a reducer runs the connect reducer first, and its refusal is complete, with nothing needed
per table, view or reducer (`docs/local-play.md` §3). It runs once, though: a connection
already open keeps calling and reading after its admission is removed, and a module cannot close a
connection. Hence the check in every reducer and the admission of open connections when the rule
changes. An unadmitted identity can call nothing but its own unbind, so it cannot reach its own
admission, and the owner has to
relay the door: the host gate (designed, not built), holding the owner credential, admits a joiner
who gave the password. Turning the list on must not
lock out the people playing, the host first, so the list keeps an account's handle, not an
identity: the handle is the same whichever identity the account plays under. The `world_account`
and admission rows already say who the rule let in, so the list is made from them with no new
table. Nothing bounds `world_account`: a row stays until its identity unbinds, the owner drops
it, a claim retires its identity or its account is deleted. A change to `Allowlist` lists the
handle of every row whose identity the rule in force admitted, so a row left under a guest
identity a claim retires would be listed by a later change; the claim erases it. With more than 256
such handles the change to `Allowlist` is refused, and `drop_world_binding` is the owner's
reducer for bringing them under the bound; a drop that erases a `world_account` row takes that
identity's admission row with it under every rule, as its own unbind does, so the owner admits
again a player it means to keep. A handle stands for one person's account in this world, and an
account's deletion erases what identifies its player, so the cascade delists it. That is a default taken while the
operator's decision is open (<https://github.com/mdrewt/monster-realm/issues/886>): the alternative
not taken is to keep the entry as host-owned data and document the retention. It is reversible: one
call in the cascade and one function.

**Rules out.** A door reducer the joiner's own connection calls; row filters
(`client_visibility_filter`): the one shape that works for subscriptions at 2.11.0 needs a public
admission table with no filter of its own, the feature is `unstable`, and it puts the sender in
every subscription query; moving the public tables behind per-sender views (see "World rows are
subscribed by zone"); a count of wrong attempts in the module; an HTTP handler in the module (the host serves handlers without the connect
reducer); treating a refusal at connect as closing what is already open; trimming a list to fit
its bound; adding handles on a call that sets `Allowlist` over `Allowlist`; keeping the owner's
handle under a rule that does not read the list (a check would be refused for a rule that is not in
force, and the next change to `Allowlist` lists the handle anyway). Accepted limits: on a host
with no gate a removed identity keeps reading what it subscribed to until it disconnects, and a
joiner is admitted there only by the owner's own call. Leaving `Allowlist` and returning undoes a
removal: `Open` lists
every checked account's handle again, anyone's who checked in meanwhile included, and `Password`
lists whoever holds an admission row, which a rule change gives each connected identity, so the
host reads the list after changing back. A listed handle stays listed after its player's row is
erased by an unbind, a drop or a guest claim, until the host removes it (a later deletion of that
identity's account takes nothing off: the row it would read is gone); an identity that unbound
while the rule was `Open` and is still connected when it changes back gets an admission row from
the change, as every connection `Open` admitted does. Anyone with an account may check in to an
`Open` world, so more than 256 accounts can hold a row there and the change to `Allowlist` is then
refused; the host changes to `Password` first (which lists only the identities holding an
admission row), then drops rows with `drop_world_binding`, or deletes them as the database owner.
Under `Open` a dropped identity can check in again at once, which is why the change to `Password`
comes first.

## The gate checks a world's password; the module never receives one

**Decision.** No reducer the module declares takes a password, a hash of one or a value derived
from one. `set_world_access(rule, admit)` is owner-only and stores the rule with an empty salt and
hash under every rule, so a salt and hash an earlier module stored go at the owner's next call; the
module never reads them, and they admit nobody meanwhile. A `Password` world admits the owner and
the identities holding a `world_admission` row, and nothing else (see "A world that is not open
refuses an unadmitted identity at connect and in every reducer; the owner relays the door"). The
host gate checks the password: it keeps an Argon2id salt and hash in the world's directory with the
owner credential's permissions, never in a backup copy's readable part or a log; it counts wrong
passwords by source address and by identity and refuses both after five in ten minutes; on the
right password it admits the joiner through the owner's `set_world_access`, naming the rule in
force. A host with no gate has no password door: its owner admits identities from the command line.
Built: the module's half (`server-module/src/access.rs`; `mod reducer_arguments` in
`server-module/src/privacy_enforcement_tests.rs` describes every reducer the build declares, the
dev builds' listed by hand, and holds that no argument is named for a password and that the
arguments carrying text are a reviewed roster). Designed, not built: the gate's check, in `docs/local-play.md` §3, fork (a). Operator
ruling, 2026-11-22 (monster-realm#840).

**Why.** The host's commit log keeps the arguments of every committed reducer call in the clear
(measured on 2.11.0 and again on 2.16.1 standalone hosts: `docs/local-play.md` §3), so a password given to a reducer,
and every wrong guess counted by a committed call, sits on the host's disk whatever the table
stores; a password stretched before the call is still a password-equivalent there. The operator
named a reader of logs as the attacker. The gate sees the source address, the one count that bounds
guessing when an identity costs nothing, and it holds the owner credential that admits. The salt
and hash columns stay, written empty, because schema changes are additive.

**Rules out.** A reducer argument that carries a typed password, its hash or anything derived from
it, under any name; a door reducer of any kind in the module; counting wrong passwords in the
module; reading the stored salt or hash. Accepted limits: a commit log a module with the door wrote
keeps the passwords given to it, and the module cannot erase it; the argument census is a tripwire
for arguments that carry text, and a value derived from a password could ride in an argument of
another type, where review is the defence.

## Every player must own the game on Steam, for now

**Decision.** Playing requires owning the game on Steam, in every way to play: the official
server, a friend's server and a single-player world, and in a browser as well as the desktop
build. On the official server `join_game` admits only a connection whose token, from our account
service, carries the entitlement claim `mr_ent: ["base-game"]`; in a single-player or friends world
it admits only an identity whose `world_account` row says its account owns the game (see
"A private world checks an account itself: a one-use ticket at first contact, then the account's handle"). The account service issues the
claim only after Steam's `CheckAppOwnership` reports an owned, permanent licence held by the player
themself: a Family Sharing borrower, a free weekend and a PC café licence do not count, and a refund
removes entitlement at the next issuance (an hour at most on the official server). A build that names the dev feature `open_join` does not enforce it, so the e2e suite and local development still join anonymously (see "Ownership is enforced unless a dev feature switches it off"). Until the operator supplies the Steam app id and publisher key (planned about two months before early access), entitlement comes from the dev issuers: each dev account carries `mr_ent` or not as an admin sets it, so the rule and its refusal are built and tested before Steam is wired in. A dev issuer checks Steam only as App ID 480, Valve's development app: a Steam player there is entitled by an admin flag on `steam:<steamid64>` that an account lacks until an admin sets it, and a dev issuer never asks Steam who owns the game and never holds the publisher key (operator, 2026-11-23). Operator ruling, 2026-11-16 ("for now, all players, including browser
players, must own the game in order to play").

**Why.** The operator's ruling. The claim is checked by the module, not implied by the issuer, so
a later free tier or demo changes what the service issues, not the module. Enforcing in `join_game`
covers every gameplay reducer, because a player row exists only through it. Checking ownership at
every issuance, not once, lets a refund or a ban reach the official server within a token's life.
Every Steam account can run App ID 480, and Steam's ownership check answers only for a publisher's
own apps, so under 480 Steam proves a sign-in and never a purchase; the hosted dev issuer is
reachable from the internet, so a Steam player there owns nothing until an admin says so.

**Rules out.** Anonymous (guest) play on an enforcing build; the guest claim flow stays built
("Accounts, guest identity and the claim flow") and is unreachable there until the ruling changes.
A sign-in method that cannot prove a Steam licence (Google, Discord, email) for players. Treating a
Family Sharing borrower as an owner (one policy function in the account service changes it). A dev
issuer that takes another app id or the publisher key, asks Steam's ownership check, or entitles a
Steam player by default as it does a dev account. Known
limits, accepted: a host can patch the module on its own server to switch the rule off, and a
player refunded after binding a world keeps playing there until its host removes them.

## Ownership is enforced unless a dev feature switches it off

**Decision.** The build input is the cargo features of `monster-realm-module`: `official`,
`world`, `dev_issuers`, `open_join` and `dev_reducers` (`server-module/Cargo.toml`). A build
enforces ownership unless it names `open_join`. `official` and `world` select production trust (see
"The official build holds no attestation key and a world build trusts no login issuer");
`dev_issuers` adds the dev login issuers and still enforces; `open_join` implies `dev_issuers`, and
`dev_reducers` implies `open_join`. A release feature wins over a dev feature, so no feature set
yields production trust with enforcement off. `build_profile`, a `const fn` in
`server-module/src/accounts.rs`, computes a `BuildProfile` from the features: its name, whether it
enforces ownership, the login issuers it trusts, the attestation keys it holds and whether it
compiles a dev reducer. It applies
cargo's implications itself, so a feature handed to the compiler from outside cargo yields no
other profile. `BUILD_PROFILE` is this build's, and `ALLOWED_ISSUERS` is its login-issuer list: the
two dev issuers (`http://localhost:4455`, `https://auth.monster-realm.spookyowltech.com`) on a
test or dev-enforcing build, `PRODUCTION_LOGIN_ISSUERS` (the fail-closed `.invalid` placeholder)
on `official`, and none on `world`, on a build with both release features and on a build with no
feature at all. A release feature together with `dev_reducers` or `load_test_zones` does not
compile (a const assertion, skipped under clippy, whose `--all-features` run names every feature).
The ownership features add or remove no table, reducer, view or type.

`default` in `server-module/Cargo.toml` is `["open_join"]`, so a build that names no feature is the
test build: it admits anonymous players and trusts the two dev issuers. `spacetime publish
--module-path`, `just publish`, the playtest recipes, `scripts/smoke-republish.sh` and the nightly
load smoke all publish that build. A default build that enforces and trusts nothing is what this
decision aims at. It arrives when `open_join` leaves `default`, which needs each of those publish
sites, `client/e2e/global-setup.ts`, and the `just test`, `ci-fast` and mutation recipes to name
`open_join`. Until then only `just release-module <official|world>` makes an enforcing module to
ship, and it does not depend on the default: it passes `--no-default-features`, and a release
feature wins anyway.

`join_game` calls `accounts::require_entitled` after the admission check and before the deletion
gate. On an enforcing build the caller's connection must carry a token from one of the build's
login issuers, addressed to `ALLOWED_AUDIENCE`, whose `mr_ent` claim names `base-game`, or hold a
binding as below. Anyone else, an anonymous connection included, gets the one fixed error `ownership required`, and nothing
is written. A build that does not enforce admits everyone and never reads the token. The claim is
read by a small scanner over the token's raw payload, since the module has no JSON crate
(`token_names_entitlement`): exactly one top-level `mr_ent`, an array holding the string; a
duplicate key, an escaped key or text the scanner cannot follow fails closed.

The check gates `join_game`, the only way to a `player` row. The reducers that act on a monster the
caller owns and need no `player` row (`care`, `train`, `evolve`, `set_nickname`,
`set_party_slot`) do not make it. The account service gives an account that is not entitled no
token, so such a caller connects as another identity that owns nothing. It matters for a database
carried over from a build that did not enforce. The host checks a token's expiry at connect only,
and `join_game` does not read `exp`, so a connection that outlives its token keeps playing until it
reconnects.

The artefact carries its profile as the wasm custom section `mr_build_profile` (`profile=`,
`enforces_ownership=`, `dev_reducers=`, then a `login_issuer=` line per issuer), which `just
module-profile <wasm>` prints. `just release-module <official|world>` refuses any other argument.
It builds the module alone with `--locked --no-default-features --features <profile>` into
`<target>/release-module/<profile>`, with the rustflags emptied (an empty `CARGO_ENCODED_RUSTFLAGS`
also overrides config-file flags) and `RUSTC`, `RUSTC_WRAPPER` and `RUSTC_WORKSPACE_WRAPPER` unset.
It refuses an artefact whose section is absent or duplicated, is not the profile asked for, does
not enforce, compiles a dev reducer, names a dev reducer anywhere in its bytes
(`FORBIDDEN_REDUCERS` in `scripts/verify-release-reducers.mjs`), or trusts anything but one
`https:` login issuer (`official`) or none (`world`). It writes
`<target>/release-module/monster-realm-<profile>.wasm` and its `.sha256`, by which the artefact is
embedded or published. The code is proved by `server-module/src/accounts_tests.rs` (`acs6_profile`
over all 64 feature sets, `acs6_claim`, `acs6_door`, `acs6_section`); by
`server-module/src/movement_tests.rs`, where `acs6_enforcing` runs the real reducer on a real
dev-enforcing build through one line of `just test` (`--no-default-features --features
monster-realm-module/dev_issuers`) and `acs6_open` runs it on a test build; by `justfile.test.mjs`;
and by `evals/account-e2e.eval.mjs`, which on a live host publishes a dev-enforcing build
(anonymous and unentitled tokens refused, an entitled one joins) and the `official` artefact `just
release-module` built (anonymous and a dev-issuer token refused, no `account` row).

`accounts::entitled(ctx, profile)` entitles everyone on a build that does not enforce. An enforcing
build entitles a connection whose login token entitles it, or whose identity holds a `world_account`
row that says its account owns the game, however long ago the account service said so (see
"A private world checks an account itself: a one-use ticket at first contact, then the account's handle"). `require_entitled` writes nothing, and reads `world_account` only when the
token does not entitle and the profile names an account service. So on a dev-enforcing build a
connection with no row, one whose row says the account does not own the game and one that holds
only an attestation binding are all refused by `join_game` with `ownership required`, under
`Open`, `Password` and `Allowlist` (`mod acs6_enforcing_bound` in
`server-module/src/world_binding_tests.rs`; `mod open_join_unbound` holds an unbound join accepted
under `open_join`). The `local-dev` attestation key is fixed and can be derived from this repository
(`account-service/src/keys.ts`), so anyone can sign with it: a `dev_issuers` build's ownership check
in a `local` or `private` world stops nobody who signs with that key. No feature set gives a build
the `hosted-dev` attestation keys alone, and `hosted-dev` publishes none; a dev build that has to
hold against strangers needs one (`docs/account-service.md`, "Attestation keys").

**Why.** The aim is that no input's omission ships an open module: `spacetime publish
--module-path` and `spacetime generate` build with the default features unless told otherwise, and
once `open_join` leaves `default` what they build admits nobody. Until then the default is the test
build, and a module to ship comes only from `just release-module`, which names no default. The only
way to an open module is to name a dev feature, which no recipe that ships does. It is the rule dev
behaviour already follows (see "Dev-only reducers never ship"): the dev thing is the opt-in.

**Rules out.** A feature that switches enforcement on (the build nobody configured would admit
anyone and trust the dev keys); an environment variable or a row as the switch; conditional
compilation of the constants (a branch no build compiles is a branch nothing checks); making a
module to ship any other way than the recipe; telling builds apart by `spacetime describe --json`,
which reads the same for every one; a `local-dev` attestation key made per machine, as its login
key is (a build's keys are constants computed from its features, and a key that differs per
machine would need a build input the feature set does not have). Accepted cost: every site that
builds or publishes for anonymous play names `open_join` once `open_join` leaves `default`; until
then those sites get it from the default.

## The client learns that a server needs an account from its kind or from the first refusal; the menu frame is the sign-in screen

**Decision.** Nothing in the module tells a client whether it enforces ownership before `join_game`
answers. `connect` (`client/src/net/connection.ts`) therefore has two sources. `main.ts` passes
`accountRequired` for an `official` target whose build names an issuer: the official module always
enforces, so an anonymous connection there sends no `join_game` at all. Toward every other target
the first `join_game` the server refuses with `ownership required` turns the same flag on for the
rest of the page, and no later anonymous connection of that page joins. A refusal goes to
`onOwnershipRefused` and never to `onError`, whose text is shown as it is. While the flag is on,
`startSignIn` begins the OIDC redirect with no claim code (the connection never joined, and
`start_guest_claim` refuses a caller with no player row) and leaves a code already in storage
untouched. The screen is the main menu frame in a gate mode (`openSignInGate`,
`ui/screens/mainMenuScreen.ts`) over the gate model in `ui/claimModel.ts`: a sign-in row, and
after a refusal the not-owned title and a row that opens the store. `main.ts` answers Start's
"close every frame" as B on it, so Escape closes nothing, and lowers it when the own `player` row
is in the store. A `local` or `private` target, and a build with no issuer, show one status line
and no screen. `client/src/main.signInGate.test.ts` boots `main.ts` under each kind;
`client/e2e/signin-gate.spec.ts` runs the flow against the `local-dev` account service and a
dev-enforcing module.

**Why.** A `test` target may be open (the browser suite and the playtests are) or enforcing (a
dev-enforcing build), and its kind does not say which, so only the server's answer can. The
official kind is known to enforce, and probing it would cost one refused reducer and one log line
for every visitor. A new overlay would need an entry in every overlay registry; the menu frame
already has the nav kit's D-pad, A, B and Y, pointer picks and focus handling, and `MenuView`
paints whatever view model it is given. A stored claim code is a guest's only way to move progress
made before the server enforced, so the gate's sign-in never destroys it: the account connection it
returns as meets the claim flow's own join veto.

**Rules out.** A build variable that says the server enforces (see "A target's kind gates
telemetry and account sign-in": the build must not know its server). Treating a `test` target
with an issuer as enforcing, as an `official` one is (the browser suite's `test` pages name an
issuer and join anonymously; the `official` pages it opens, in
`client/e2e/local-identity.spec.ts`, are held at the sign-in screen). Clearing the stored claim
code when the gate's sign-in starts. Lowering the gate when a connection is merely allowed to
try: the refusal arrives after `onReady`, so that hides the screen the refusal should raise.
Reporting the refusal through `onError`. A `test` target still sends one anonymous `join_game`
per page load before its screen shows; removing that needs a public value from the module,
which is a schema change.

## The account service is our own small OIDC issuer; Steam is the only player sign-in

**Decision.** One service in this repository (`account-service/`, TypeScript) built on
`oidc-provider` 9.x (MIT, OpenID Certified) is the one issuer: the official module trusts its login
tokens and a world's module its attestations. Players sign in two
ways, both giving the subject `steam:<steamid64>` so a browser and a desktop session are one
account: the desktop shell exchanges a Steam ticket (`GetAuthTicketForWebApi` with the identity
`monster-realm-account`, checked by `AuthenticateUserTicket`) at a custom grant; a browser uses
authorization code with PKCE, where the service's sign-in step is Steam's OpenID 2.0, verified with
`check_authentication` and exact checks of the return address, endpoint, claimed id and a
single-use nonce. Both check ownership before issuing. ID tokens are ES256 and live an hour;
browser refresh tokens live 30 days and rotate, and reusing a rotated one revokes its chain. A
separate deployment with its own issuer name and keys offers email and password for development
and QA only, with accounts made by an admin command. The same service signs world attestations
with a separate Ed25519 key (see "The attestation is signed with Ed25519 and checked by
`ed25519-dalek` compiled into the module", which names when ES256 replaces it). Storage is one SQLite file on one instance, opened with Node's built-in `node:sqlite` (no native SQLite package); discovery and the key set are also
served from a CDN; signing keys live in the host's key service through external signing. It is built in two phases (harness spec `M-account-service.spec.md`). Phase 1, now: the same provider and token shape with an email-and-password sign-in step and a per-account entitlement flag, run as two dev and test issuers with their own keys, `http://localhost:4455` for development and tests and `https://auth.monster-realm.spookyowltech.com` (the operator's domain, `monster-realm`'s own subdomain) for testing from other machines; test and dev builds of the module trust both, release builds trust neither. Phase 2, when the operator supplies the Steam app id and publisher key about two months before early access: the two Steam sign-in steps, the ownership check, and the production deployment at a host the operator names then. The never-deployed Better Auth recipe in `ops/auth/` is replaced by the deployment recipe (acs-4).

**Why.** SpacetimeDB trusts only an OIDC issuer's signed JWTs, and Steam issues none, so a service
of ours must check Steam and sign. A certified provider library carries the protocol (codes, PKCE,
refresh rotation, discovery, keys) so the code we write is only the Steam steps, the ownership rule
and the attestation. SpacetimeAuth, Clockwork Labs' hosted issuer, exchanges Steam tickets and
reports owned apps, but has no Steam sign-in for a browser, gives its own user id as the subject (a
browser and a desktop session would be two accounts) and has no per-world attestation; it is also in
beta. Better Auth has no official Steam method, and the ticket grant and attestation would be ours
either way. BitCraft, Clockwork Labs' own Steam game on SpacetimeDB, appears from third-party
tooling to sign in through its own API: the same shape, though unconfirmed.

**Rules out.** SpacetimeAuth or Better Auth as the issuer (revisit SpacetimeAuth if it gains a
browser Steam sign-in and SteamID subjects); a second issuer for players beside this one; the dev password method, a dev issuer or a dev key in a production deployment, and a dev issuer in a release build's trusted list (the service refuses to start; the release recipe's test refuses the build);
refresh tokens for the desktop (it exchanges a fresh ticket); the publisher key anywhere but the
service's secret store, read by one module and never logged.
