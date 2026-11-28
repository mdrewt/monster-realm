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
`battle_wild_unit` (wild individuality seeds), `battle_secret` (the
tactical seed), `battle_summary` (telemetry),
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

**Decision.** Anonymous play is first-class: every connection gets an identity, and the module never
rejects a connection for having no account. A world whose access rule is not open still refuses an
identity it has not admitted, account or not, and on a build that enforces ownership an anonymous
connection that holds no entitlement is accepted but refused by every reducer a player plays
through. An account row is created only for a token from an issuer on the build's own login-issuer
list and for this game's audience: an unrecognised issuer falls back to anonymous play, and an
allowed issuer with the wrong audience is disconnected. An account holds no PII; the identity, a
function of issuer and subject, keys everything. A guest moves its progress to an account with a
256-bit claim code the browser mints and registers before it redirects to sign-in. After sign-in the
account completes the claim, which runs every caller-state guard before it looks the code up, then
moves the guest's persistent game data onto the account (the retired guest keeps a tombstone of its
dialogue state), and erases instead of moving the guest's export bundles and its world rows; its
finished battles' tactical rows are erased, and its side of each kept battle record becomes the
tombstone identity. The destination must own no game data, which holds because the client claims
before it joins. A claim expires after 15 minutes.

**Why.** The server never generates the secret, so its strength does not depend on the server's RNG.
Checking caller state before resolving the code means the reducer cannot be used to test whether a
code exists; malformed and already-used codes return the same error. Registering the code before the
redirect is what lets the claim survive the round trip to the identity provider. A finished battle
is history shared with an opponent, not progress, and the guest identity retires at the claim.
Nothing else reliably removes what names it: every sweep and the 24 h GC keep the battle summary
(only its cap reaper deletes rows, oldest first, once 100,000 newer rows exist), a wild or practice
anchor is swept only on its own player's next battle, and a PvP anchor waits on the opponent's next
battle in the same role.

**Rules out.** Server-minted claim codes; storing email or JWT subjects; rejecting a connection for
being anonymous; widening the audience allowlist to more than this game's client; re-keying battle
rows onto the claiming account (a re-key helper per tactical table, to carry history that only
telemetry reads).

The issuer lists, the claim's guards and what it moves or erases: `ARCHITECTURE.md` "Accounts
lifecycle", Signing in and Claiming guest progress.

## The starter is a once-per-identity grant recorded by a marker; ownership is never the test

**Decision.** A first join grants the starter monster and the starter kit, once per identity. The
kit is content, checked at publish, and its items are ordinary items: they can be traded and sold.
The join shows no notice for the kit, because the wallet readout and the Bag already show it. The
grant is recorded by a marker flag in the owner's private dialogue state, set in the same
transaction as the kit. A set marker grants nothing, whatever the identity owns; an unset marker
grants the kit, and the monster too unless the identity already owns one. The kit is granted whole
or not at all: a kit that would exceed a stack or balance cap is skipped with a log line, leaving
the marker unset so the next join tries again, and a kit that fails to load refuses the join before
anything is written. The marker's flag namespace is reserved for the server, and content may not
name a flag in it. The guest claim moves the guest's dialogue state to the account and leaves the
retired guest a tombstone: its reserved flags, the marker, and a copy of its done quests.

**Why.** The player row is deleted when an identity's last session ends, so the next join re-runs
the grant check; a rule that reads ownership re-grants a starter (with fresh hidden IVs) to any
identity that reaches zero monsters. The guest claim is such a path: it moves every monster to the
account while the retired guest token can still join. The marker lives in the dialogue state rather
than a new table because that row is already private, re-keyed by the claim, erased by the deletion
cascade, counted as game data and part of the owner's export; a new table would need all of that
wiring again. The tombstone is the one place the claim copies instead of moving: without it the
retired guest would be granted a second starter and kit, and could redo a finished quest. Making the
kit untradeable would need a new item field and a trade rule, and would not stop one player farming
throwaway identities on its own: each fresh identity already gets a tradeable starter monster. How
the official server keeps those payouts from reaching a main identity is an open launch condition
(`docs/economy-tuning.md`, "Shared-economy caveat").

**Rules out.** Inferring "new player" from owned monsters, items or a wallet row. A re-grant for an
identity that holds the marker and owns no monster: a release or loss mechanic added later must
bring its own floor rule. Content (dialogue or quest) that tests, sets or clears a reserved flag.
Granting part of a kit, or clamping it at a cap. Accepted consequence: the retired guest's tombstone
(the reserved flags and quest ids, keyed by the retired guest identity) is not erased by the
claiming account's deletion cascade, which erases rows under the account's own identity.

The kit file, the marker, the grant rule and the content lint: `ARCHITECTURE.md` "Accounts
lifecycle", The starter.

## A player's tag is a minted sequence value: private at rest, mirrored on the public player row while online

**Decision.** Names are free and not unique, so each identity gets a discriminator, shown as a tag
beside the name, that tells same-named players apart. A join finds the caller's private handle row
or mints one from a sequence, and copies the value onto the public player row it inserts (0 means no
tag). The value is never 0, never derived from the identity, never held by two identities at once
and never minted twice: a sequence only grows, so a deleted handle's value is not minted again. The
guest claim moves the handle with its value; a handle counts as game data, so an account that
already holds one cannot claim, and a claimed guest identity that joins again is minted a different
value. The deletion cascade erases the handle and zeroes the tag and the lead level on the surviving
player row. A mint the datastore refuses refuses the join before any presence row is written. The
player row's second public column is the stored level of the owner's lead party monster (0 with no
party), kept equal to it by every write that changes a monster's level or party slot. The client
keeps the tag apart from the name and formats it in one place. Three surfaces show it: the Social
screen's Players row, the incoming trade and challenge request banner, and the Trades-tab session
row; every other surface shows the name alone.

**Why.** The player row is deleted at every disconnect and is not re-keyed by the claim, so a value
stored only there would be re-minted each session. A public handle table would list every identity
that ever joined, offline ones included; the mirror shows a tag only while its owner is online.
Profile rows exist only after a first rated game. A sequence value needs no collision retry and
cannot be forged to match another player's; the accepted cost is that a tag reveals roughly how many
identities joined before it. Zeroing the mirror at deletion keeps the tombstoned row from being
linked back to a tag another player saw. The lead level is a stored column, not a view: another
player's monsters are private (their projection is read only through the owner's view), and a view
over monsters evaluated for each subscriber would be recomputed on every monster change. The tag
disambiguates where a player picks another player out of a list or answers a request from one; in a
battle and in the world the name alone reads as part of the game (the operator's ruling,
<https://github.com/mdrewt/monster-realm/issues/588>), so the tag is a display join and never part
of the stored name. The Players row is built from parts so the player-chosen name stays isolated in
its `<bdi>` and out of the catalog resolver; the one-line banner and session row are plain text, so
they take the catalog join.

**Rules out.** Enforced-unique names. Deriving the tag from the identity (it would change at the
claim, or collide after it). Storing the tag only on the player or profile row. A public handle
table or a view that serves another player's handle. Reissuing an erased value. Minting anywhere but
a join's success path (a refused or deletion-gated join mints nothing). Changing a monster's level
or party slot without refreshing the lead level: the column would stay stale until the owner's next
such write or join. Folding the tag into the client's stored name (every name-only surface would
show it), and building the tag text or the name-and-tag join by concatenation outside the one
formatting module. Accepted consequence: the `u32` sequence is one finite, shared resource (about
4.3 billion identities) that guests, who are never reaped, also draw from; once it is spent every
identity without a handle is refused at join. Also accepted: any client sees each online player's
lead level and its changes as they happen (reorders, boxing, level-ups), because the operator chose
the lead level for the Players row; bucketing the value is the remedy if a playtest finds that
matters. A tag tells identities apart, not people: anonymous identities cost nothing to mint. And
the tag links a claimed guest to its account for anyone who saw the guest's tag, which is the
ruling's intent; deletion zeroes the tag on the surviving row only, not in another player's memory
or screenshots.

The handle table, the lead-level writers and the client's formatter and surfaces: `ARCHITECTURE.md`
"Accounts lifecycle", Tags and lead level.

## Account deletion and data export

**Decision.** Every table is classified once in the schema's data-lifecycle manifest (erase,
anonymize, via a join, or not owned; a written basis; exportable or not), and a test holds the
manifest to the generated module definition's table set, so a missing or stale entry fails. Deletion
is a request the account can cancel during a 7-day grace period; then the cascade force-resolves
live interactions, forces ongoing battles naming the account to a terminal result, and erases or
anonymises per the manifest. A table that holds only what an anonymized row keeps, the leaderboard's
membership, is re-derived after the name is tombstoned, not overwritten. A deletion-pending caller
cannot open new commitments, while commitments that predate the request stay completable. An export
is written as private chunks the owner reads back; each live bundle has a unique creation stamp,
requests are admitted against a global live-row cap that is halved for callers without an account
and halved again for callers without a wallet, and a bundle is deleted within an hour of its 7-day
expiry.

**Why.** A new table must not silently keep personal data after a deletion, so its classification is
part of the schema. Blocking new commitments during the grace period stops a deleting account from
laundering assets to a confederate. The export caps and tiers bound storage abuse, with anonymous
identities limited before account holders. The starter kit's currency creates the wallet row at an
identity's first join, and only an identity with a player or account row can request an export, so
the no-wallet tier holds almost no caller and a join alone reaches the anonymous tier. The wallet
signal stays: any per-identity signal an anonymous identity can earn is cheap, and sign-in is the
fix. A configured real sign-in issuer (today the production issuer list holds a fail-closed
placeholder) is therefore a launch condition for the official server. Until then no caller has an
account, so no caller reaches the account holders' ceiling, and identities that each earn a wallet
row can keep the anonymous tier full: other players' export requests are refused for as long as
those identities keep re-exporting, and for up to the 7-day retention after they stop. The operator
accepted that exposure until launch (monster-realm#757).

**Export scope.** The export is for the data held about the person. Game state is included where a
query on existing tables provides it; it is assembled from the tables the game already keeps, and
nothing is stored for the export's sake. A row that only duplicates exported state, or exists only
between sessions, may stay out with its reason in the manifest's basis (the saved position is one).

**Rules out.** An unclassified table; deleting before the grace period ends; an export path any
other player can read; a table or column added only so the export can carry it.

The reducers, the reapers, the guard and the chunking: `ARCHITECTURE.md` "Accounts lifecycle",
Deletion and Export.

## Battles run on one engine at a time; the tactical cutover was a flip, not a toggle

**Decision.** Both live battle starts, a grass encounter and an accepted challenge, open a tactical
battle and nothing else. The module declares no 1v1 table, reducer or pick type, and tests over the
generated module definition hold that none is declared. What stays of the 1v1 engine is what a
production path calls: the server keeps the write-back, terminal-sweep, faint-penalty and disconnect
helpers the tactical settlement calls, and game-core's combat module keeps the types stored in the
battle anchor, the content rows, and the carried rules (the damage formula and accuracy check, the
type chart, lead selection, the status countdown, the XP rules, and the PvP forfeit and challenge
rules). A helper or rule only its own tests call is dead code, not a fallback engine;
`docs/refactors/combat-carried-rules.md` lists what of it is left to remove and in what order. The
tactical engine calls a carried rule itself; where the rule takes the 1v1 battle state, the engine
states it once in its own module, pinned by tests that hold literal expected values. A test of a
removed rule goes with it, naming the removed function or the surviving test of the rule it carried;
a test that executes no product function is no check and goes for that reason.

**Why.** Two engines reachable at once would need a per-battle discriminator in every guard,
settlement and client renderer, and a runtime toggle is exactly the surface a hostile client would
flip. One engine per path keeps the battle guards, the settlement funnel and the battle frame
single-sourced, and compiling the old engine through the flip let the client keep typechecking so
the purge could delete the client side first. A 1v1 rule no production path calls reads as a second
engine, and every change to a stored battle type has to carry it. The entry-ability and weather
functions take the 1v1 active-slot state, which the grid has no equivalent of, so a depth wave could
use them only as a test oracle for one-line formulas. The wave states its rule on the tactical state
from the values its plan records, and the damage formula already carries the Rain and Sun modifier
through its weather parameter.

**Rules out.** A feature flag or config row selecting the engine; starting a tactical battle through
a dev-only reducer in any shipped build; a 1v1 table or reducer brought back as a fallback. In the
combat module: a 1v1 rule kept as the source for a later wave or as the expected value of a tactics
test; a second copy of a rule the engine can call; keeping a test that executes no product function
until a survivor is found for it.

The two writers and the combat module's callers: `ARCHITECTURE.md` "game-core: the rule layer" and
"server-module: the authority", Layout.

## Dev-only reducers never ship

**Decision.** A dev reducer compiles only behind a dev-reducer feature that is never in the default
build and that turns on anonymous join with it; a release feature together with a dev-reducer
feature does not compile, and the release recipe refuses an artefact that names a dev reducer or
whose profile compiles one. The playtest recipes check the *published* module's reducer list and
that the production client bundle holds no debug hooks, and the committed client bindings, generated
from the default build, hold no dev reducer. No dev reducer starts a battle: the e2e drives every
battle through the player-reachable flows. A dev reducer acts only on the caller's own state, except
the turn-window expiry, which only the module owner may call, even in a dev build. That reducer
moves the open window's deadline of the side it names to the call's time and lets the real scheduler
expire it; it refuses a call that finds the other side's window open, so a slow test cannot strike
the wrong player. An e2e may expire a window through it instead of waiting, and a test that does so
keeps one real-time expiry. The load-zone placement exists only in the load-test build. A change
that adds a dev reducer joins every check that lists dev code and keeps everything it adds behind
its feature; a dev caller reaches a private production function through a dev-gated forwarder and
never widens the function itself.

**Why.** A dev reducer in a real deployment is an exploit: free items, or expiring another player's
turn window. Checking the published module rather than the source catches a wrong build flag in the
publish path, which a source grep would not. A test that waits real deadlines spends a full turn
window per expiry (30 s in PvP); overriding `now` would open later windows ahead of real time, so
the reducer moves one deadline and leaves every timestamp real. One real-time expiry per test keeps
the real scheduler covered by the two-browser flow. What keeps dev code out of a release is checked
on the artefact and by the compiler: the published-module check, the release recipe's refusal, the
reducer census and the compile error for a release feature named with a dev-reducer feature. A
change that adds a dev reducer does not have to leave the default build's bytes unchanged. Accepted:
dev code that is not a reducer and escapes its feature gate changes the default build without any of
those checks seeing it; review of the gate is what catches it.

**Rules out.** Runtime flags for dev reducers; trusting the source tree as proof of what was
published; a dev reducer a player can call to act on anything but the caller's own state; a fake or
overridden clock for tests; an e2e that takes every expiry through the dev path; a `cfg(feature)`
module line; widening a production function's visibility for a dev caller; requiring a build's bytes
or its source layout to stay fixed as proof that dev code did not ship (it shapes production source
around a hash).

The features, the three dev reducers, the published-module check and the checklist for a new one:
`ARCHITECTURE.md` "server-module: the authority", Dev and load-test builds.

## SpacetimeDB versions move in lockstep

**Decision.** The spacetime CLI and host, the Rust `spacetimedb` crate and the npm `spacetimedb` SDK
are pinned to one version, and checks hold the resolved crates, the locked SDK and the generated
bindings to it. An SDK bump needs the live two-client e2e. Upgrades follow the upgrade runbook. A
nightly job republishes over live data without deleting it and checks that the data survives.

**Why.** The crate version is the product version: a crate/CLI mismatch changes the generated
bindings and the wire format. The vendor ships the CLI, the crate and the SDK from one repository on
the same day with no documented skew matrix, so the same version everywhere is the only
documented-safe configuration. A newer SDK can change reconnect behaviour, so an SDK bump is proved
on two live clients. A schema change the automatic migration cannot apply (reordering or removing
columns, renamed enum variants) only shows up when publishing over real data, so it has to be tested
there.

**Rules out.** Bumping the crate without the CLI (or the reverse); inserting a column anywhere but
the end; removing a column or reordering enum variants on a live database without planning a
`--delete-data` republish.

The pins, the checks and the nightly job: `ARCHITECTURE.md` "server-module: the authority", Working
with SpacetimeDB.

## The crate's `unstable` feature is on; the generated definition is checked instead

**Decision.** The workspace's `spacetimedb` dependency enables the crate's `unstable` feature
(operator, 2026-11-22), and the module uses nothing it gates; procedures, their transactions and
their HTTP client are outside it. What keeps an HTTP handler, a route or a row filter out of the
module is a check of the generated module definition, not the feature: it refuses each, at any
submodule depth, and any section kind it does not know, on the default build in the merge gate and
on every release artefact. The same check refuses any procedure but the world's own account checks
and any schedule but the module's own, and the reducer census refuses a procedure outside the
account-check module. Nothing checks the immediate-schedule call or a unique column's
insert-or-update, which are calls, not declarations: review keeps them out. The immediate-schedule
call is the one that matters to the access design: the host queues it when the call runs, so it runs
even if the calling reducer then fails, and it runs as the database identity, so it passes every
scheduler-only guard. What the feature gates at the pinned version and what it adds to the built
module (one export; the imports and the definition unchanged) are measured in
`docs/spacetimedb-2.16.md`.

**Why.** A slice that uses one of these APIs then measures only that API, against a module already
built and tested with the feature on. The guarantee the access design needs (no route the host
serves without the connect reducer, no row filter) is a property of what the module declares, and a
check of the declaration holds it whatever the feature list says; a declaration behind a release
feature is invisible to the test build, hence the check on each release artefact.

**Rules out.** Turning the feature off to keep those APIs out (the check is the guard); a
declaration of a handler, a route or a row filter without a slice that changes the check and
`docs/local-play.md` §3; a call of the immediate-schedule macro from a reducer a client can call; a
host older than 2.14.0 for this module, since such a host rejects the HTTP-handler export with the
signature the 2.14.0 crate and later emit (it gained the sender and the JWT; vendor release notes,
2.14.0).

The definition check, its allow-lists and where it runs: `ARCHITECTURE.md` "Verification layout".

## Server-module tests run on our own host ABI, over the two vendor crates patched where they refuse a native host

**Decision.** The module's native tests run on an in-memory host this repository defines, which
implements the SpacetimeDB host ABI itself. From crate 2.12.0 the vendor refuses a native host
twice: the bindings crate defines the ABI as stubs, and the main crate's table backend stops calling
it off wasm. So the workspace builds both crates from copies of their crates.io releases, changed
only by `#[cfg]` attributes that send native code down the branch wasm takes, each with a change
notice. A procedure runs natively through more such attributes: the host puts an aborted
transaction's rows back and answers each HTTP request from a queue the test stubs, so a procedure's
request opens no connection. A test proves each copy, with the patch undone, matches the crates.io
release, and that every changed line is such an attribute selecting on wasm what the original
selected; every SpacetimeDB hop re-copies both crates, re-records their hashes and re-applies the
patch. CI's dependency audit skips packages not from crates.io, so these two are checked at each
hop, in release notes and advisories, until CI audits them by name and version. The alternatives and
the measurements behind the choice are in `docs/spacetimedb-2.16.md` ("The vendor's unit-test
harness").

**Why.** The module's privacy and netcode rules are checked on what a transaction does as the host
sees it: every write a subscriber is sent, an unchanged update included; each shipped view, run
through the runtime's entry point for a chosen caller; and a client connection with or without a
JWT. The vendor's native harness (`test-utils`) answers none of these. Its datastore reports no
write or read, the view entry point does not reach it, and a JWT-less connection cannot be built. It
also puts the whole server, V8 and wasmtime included, into the test build. On wasm the changed
attributes select what they selected before, so the module we ship is the vendor's code.

**Rules out.** `test-utils` as the test host, until its datastore reports a transaction's writes and
runs the shipped views; a linker flag that tolerates the duplicate symbols (the stubs win, and the
tests that reach the host fail); switching off only the stubs, since the table backend still
refuses; testing on an older crate than the one that ships; any edit to the copies beyond such
attributes and their notices.

The host, the copies, the patch and its guard test: `ARCHITECTURE.md` "Workspace" and "Verification
layout".

## Schema changes are additive

**Decision.** Between consolidations a schema change only adds. New columns go at the end of a table
and carry an explicit default. Illegal combinations of states that a column-type change would rule
out are enforced by a checked predicate instead. Whether a table is scheduled is fixed at first
publish, so a scheduled table ships together with its reducer. A new table is classified in the
data-lifecycle manifest, and a new column on an exportable table forces an explicit export-or-omit
decision in that table's export serializer. A table or column whose job has moved stays in place,
unused, until a consolidation. A consolidation is a slice whose spec declares it. It removes what
additive changes left unused in one break, ships with a wipe of every database, and raises the
oldest client protocol the module serves to its new protocol number, so every client built before it
is told to update the game. The schema snapshot checks refuse a removal, a reorder or a type change
against the merge base, except for a consolidation the checks' own declared list names, and the
declaration lasts one schema change.

**Why.** SpacetimeDB's automatic migration accepts only appended columns with defaults. Anything
else needs `--delete-data`, which wipes every player. While no database holds data the game has
promised to keep, a wipe costs nothing, and carrying dead tables into early access would cost every
later reader of the schema, the deletion cascade and the export. So the unused parts go in declared
breaks before early access, and the additive rule holds between them and after the last one.

**Rules out.** Mid-struct column inserts, column removals, and type changes on a live table outside
a consolidation. A consolidation once a database holds player data the game keeps. A slice skipping
the merge-base comparison on its own authority: a consolidation is declared by its spec; the slice
that runs it cannot declare one on its own authority.

The default encoding, the export fixtures, the wipe runbook and the snapshot checks' declared list:
`ARCHITECTURE.md` "Schema and privacy model".

## The module publishes its protocol numbers; a publish that keeps data is followed by the owner's `sync_content`

**Decision.** game-core holds the protocol number and the oldest client protocol the module serves
(never above it), and the client reads both from its wasm. The module records both in the one row of
a public module-info table, at database creation and at every content sync by the owner, whether or
not the content changed. Every recipe and script in this repository that publishes over a database
and keeps its data then runs the owner's sync as the publishing identity, and fails when that call
is refused. A committed wire contract holds the generated bindings against one recorded entry per
protocol number: the protocol number rises by one with any change to the entry, and the oldest
served protocol rises above every entry from it upward that the bindings break. Server to client,
any difference in a table, view or type an entry holds breaks it, an appended column included;
client to server, any change to a reducer or type it holds does, except a variant appended to a sum
only an argument reaches. New tables, views, reducers and types break nothing.

**Why.** Database creation is the only time the module's init runs, and nothing in the module runs
when a new module is published over existing data, so the owner's call is what makes the row
describe the module that is running, including after a publish that changed the schema and left the
content alone, which the content-version check would skip. A client misled by the numbers fails
silently: it misreads rows or sends calls the module cannot decode. Arguments and fields travel by
position (BSATN), so an added, removed, reordered or re-typed one breaks an older client's call,
while an appended variant only adds a tag no older client sends; the SDK builds a reducer event from
the caller's own arguments, so no client decodes arguments. A renamed member counts as a change
although no name travels: the bindings hold no other identity for it. From SDK 2.16.1 a client skips
trailing columns its bindings lack (vendor #6091; measured in `docs/spacetimedb-2.16.md`), but not a
field appended inside a named type, and a rule that told the two apart would have to model the SDK's
decoder; counting a trailing top-level column as a break is the operator's choice (#873): nothing is
deployed, so it costs nothing now, and it is revisited before early access, when every additive
column would otherwise send every older client to update.

**Rules out.** Copying either number into TypeScript or into the server module. Refreshing the
numbers below the content-version check, or from a reducer any caller may run. A recipe or script
that publishes over kept data without the owner's call, or that ignores the call's exit status.
Raising the oldest served protocol for a change that breaks no entry (it sends every older client to
update the game for nothing). Rewriting an entry a merged change recorded, or deleting one at or
above the oldest served protocol: either hides a break from the check. Treating the numbers as a
server-side check: they tell a client which side to update, and every reducer still validates its
own input.

The constants, the row's writers and the wire contract's files: `ARCHITECTURE.md` "server-module:
the authority", Lifecycle.

## A client checks the server's protocol numbers before anything else, and a refusal lasts until reload

**Decision.** Each connection subscribes the module-info table alone first and judges its row
against the client's own protocol number. A protocol below the client's, no row or a refused query
means the host must update the server; an oldest served protocol above the client's means the player
must update the game. A refusal ends the connection and the page builds no other one, and the line
naming the side stays on the world hint until reload. An admitted connection is judged again
whenever the row changes, and only toward refusal. The module-info table's three columns never
change.

**Why.** The numbers help only if a client that cannot speak to the server can still read them, so
they are read before any other table and from a row whose shape is fixed for good (an SDK cannot
decode a row that lost a column). The refusal is terminal so that the line and the game never
disagree: a page that reconnected, was admitted and played under "Update the game to join" would be
saying something false, and a line that cleared itself would be missed. A reload is the retry. An
admitted connection is judged again because a client that reconnects between a publish and the
owner's `sync_content` still reads the previous numbers.

**Rules out.** Adding, removing or re-typing a column of the module-info table (a new fact goes in a
new table). Subscribing anything else, or calling a reducer, before the verdict. Admitting a refused
page later, or re-running the check on a timer. Serving a client bundle before the module it needs
is published and synced: a client newer than the server it reaches is refused, correctly, and stays
refused until reload. Reading the check as access control: the server turns nobody away by protocol.

The check's module and its place in the connection: `ARCHITECTURE.md` "Connection and store".

## Observability: the module never times itself or sends a signal out

**Decision.** Server signals come from the SpacetimeDB host: its metrics endpoint for Prometheus and
the module's log files for Alloy and Loki. New server log lines go through one JSON-envelope logger.
A 60 s heartbeat logs the deployed content version and writes nothing; it keeps running in a world
with nobody connected. OpenTelemetry spans and metrics are client-side only. The self-hosted stack
is bound to loopback.

**Why.** Reducers cannot make outbound calls and should not read clocks, so the host has to be the
source of timings and counters. The module's only outbound requests are its four account-check
procedures, to the one account service the build names, and none of them carries a signal. The
host's metrics endpoint answers without authentication and labels its series by database, so
everything stays on loopback.

**Rules out.** An exporter or polling reducer; a procedure that sends telemetry; ad-hoc `log::`
formats in new code; exposing the stack without changing the Caddy bind address on purpose.

The logger, the heartbeat and the stack's parts: `ARCHITECTURE.md` "Observability".

## Client UI: virtual buttons, one context stack, one overlay frame

**Decision.** Every input resolves, through one binding table, to a closed set of virtual buttons:
the D-pad, A, B, X, Y, LB, RB, Start and Select. Letter keys are optional accelerators that open a
canonical menu path. Every screen is a frame on one pure context stack over a world or battle base:
B pops one frame, and Start pops every frame to the base, or opens the main menu at a base. Every
frame is a class-styled frame inside the game screen. Server-owned state (battles and dialogue) is
reconciled into the stack on every batch, never pushed by a keypress, and the client never closes a
server-owned frame itself: it sends the reducer. A trade or challenge request is a non-modal banner
and world sheet, never a frame. Which overlay may open over another is one tier table. Menus are
D-pad lists, grids and tabs whose active item is a key, never an index or a pointer cursor. The hint
bar and Help are generated from the context table, the live bindings and the catalog. Bindings
persist per browser, and the D-pad, A, B and Start always keep a key. Every waiting Controls cell
has a way out on the pad: the button a Pad cell shows, else the live B, and the waiting line names
it for a player on the pad. The session terminal is outside the router and the overlay registry, so
on the pad the D-pad or the stick moves and A presses, while B and Start do nothing; a button held
while the terminal opens, closes, arms or disarms its confirm step acts only once released and
pressed again. Escape is routed ahead of every view, so no view can trap it (an Escape that ends an
IME composition is the IME's); text-entry views shield their fields from the other keys'
accelerators. Each view keeps its state in a pure model with a thin DOM view. Accessibility metadata
for every overlay is one total record. A status condition is named by text, never by colour alone.
All UI strings come from a total typed catalog (`en` and `fr`): a lookup throws on a missing key,
and switching to an unregistered locale throws. One whole-tree scan holds that no non-test client
file writes a raw string to a text sink; its sink floor only proves the scan still sees the tree,
and each view's own runtime tests hold its behaviour.

**Why.** A handheld-console grammar, where a few contextual buttons are primary and hotkeys are
shortcuts, is the intended interface. One stack makes "back one level" and "exit everything"
uniform. Silently dismissing a modal on a stray keypress loses input, and for dialogue it desyncs
server conversation state, so server-owned frames follow the store and an ongoing battle cannot be
hidden. Pure models make the UI logic testable without a DOM. Generated hints and help cannot drift
from the bindings. A pad-only player has no other way out of a cell that takes keys, or of a Pad
cell with no button to press again; B is always bound and already means back. Nothing else on the
pad can press Retry or Continue as guest, and the confirm step gives up this tab's account session,
which cannot be undone, so one press must never both open it and answer it. WAAPI animation ignores
`prefers-reduced-motion`. A total catalog makes a missing translation a compile error rather than a
blank label, and throwing (rather than showing the key) keeps an unwired string from looking wired.

**Rules out.** A feature reachable only by a hotkey; a hotkey-only discovery menu; leaving a waiting
cell on a timeout or disabling Key cells after pad input (a pad player with a keyboard at hand can
still bind keys); B answering No on the session terminal (a step there is left by choosing a button,
and B keeps one meaning on every step of it: nothing); a hand-written controls list; a dedicated
interact key; new per-overlay tiers, mutual-exclusion checks or force-hide lists; overlays anchored
to the window or in page flow; menus that hide themselves on a pick; conveying meaning by colour
alone; WAAPI animation; hard-coded UI strings; falling back to the key or `en` when a string is
missing; per-view copies of the string scan, or a ratchet fixture for the failing-sink count. A
per-view copy only adds a "this file is still visible to the scanner" tripwire. Going without it is
an accepted risk: a single view going dark to the scanner by less than the floor's margin goes
unnoticed by the scan, and only the sinks its runtime tests render are still checked.

The binding table, the stack, the router's key phases, the catalog and the string scan:
`ARCHITECTURE.md` "Client", UI.

## Context stack ownership

**Decision.** The context stack owns the player's frames, and `client/src/shell/frames.ts` owns the
stack: only that module assigns it, and every other module only reads it. Every player open (a
menu entry, an accelerator, a world interaction, the deferred shop open, a claim lifecycle prompt)
goes through one open path, that module's `openFrame`, which pushes the frame first and only then
shows its view. A frame already on the stack is not pushed again, and the stack's own same-id push
is the one dedup. The Social panels are one Social frame, and switching panels pushes and pops
nothing. Only the server-owned overlays, the battle and the dialogue, are mirrored from their
views' visibility, because they show themselves on server edges. A player view that closes itself
has its frame popped at the next sync, never pushed. A player frame's probe, hide and view travel
with its open. A movement-gate read derives from the stack as it stands and never syncs it.

**Why.** When the stack mirrored the views' self-managed visibility, every reader had to re-sync
first: gate reads mutated the stack, a shown overlay could sit off the stack until the next key,
frame or batch, and a second input source would have had to re-derive the open path. One push-first
open path gives a gamepad the same open path as the keyboard, and makes "shown but not on the
stack" impossible for the player set.

**Rules out.** Showing a player view outside the open path; pushing a player frame from visibility;
a per-panel Social frame; merging the three mirrored-frame tables in `client/src/shell/frames.ts`
(probes, hide handles, lent views) into one registry (three small total records with byte-identical
thunks are the defense against copy-paste sibling bugs); a gate read that pushes, pops, shows or
hides a frame; an assignment to the stack outside `client/src/shell/frames.ts`.

The open path and the mirrored ids: `ARCHITECTURE.md` "Client", UI.

## A hold gesture is a router edge: the top frame lists its hold-capable buttons

**Decision.** The top frame lists the buttons it treats as hold-capable, and the router holds the one
hold clock (500 ms). A listed button's press asks nothing. A release before the hold time delivers
its tap at the release; held that long, the frame is asked once with a hold input and the release is
swallowed. Arming is per button whatever the source (key, pad, pointer). A frame change, a reset or
release of every button, or a frame that stops listing the button drops the press with nothing
delivered. The D-pad and X are never hold-capable. Today only the bare tactical battle base lists Y,
and only while the shell can clear the selected unit's READY plan: a Y tap shows the hold-to-clear
line, which names the live keycap of Y on the last-used device, and a Y hold clears the plan the way
the confirmed Clear plan row does. B is never listed: its skip of a playing beat stays at the press.

**Why.** A held button must never also act as a tap, and a tap must not wait on a timer on every
screen. Only a frame that offers a hold pays the tap-at-release latency; every other button and
screen keeps press-time response. One router rule serves the keyboard, the pad and the pointer
alike, since the pad is one more source of the same edges. B keeps press-time skip because keyboard
and pointer players already skip at the press; a tap-vs-hold B would turn their tap into an undo, a
feel change left to the tactical battle's depth work.

**Rules out.** Per-screen hold timers or a second hold clock; listing a button whose tap must act at
the press (B while a beat plays, the D-pad, X); a hold that also delivers its tap; treating a held
key's OS auto-repeat as a hold.

The router's hold edge and the battle base's list: `ARCHITECTURE.md` "Client", UI.

## Code leaves `client/src/main.ts` into owner modules under `client/src/shell/`; `main.ts` stays the composition root

**Decision.** An extraction from `client/src/main.ts` follows the map in
`docs/refactors/client-shell.md`: layered modules under `client/src/shell/`, each owning its mutable
state as module-level `export let` bindings. Another module reads a binding through its import,
which is live, and changes it only by calling a function the owner exports; a `Set` or `Map` that
several modules mutate is exported read-only with an owner function per mutation. `main.ts` remains
the entry. Of `main.ts` and the shell modules, only `main.ts` registers a listener on the store, the
window or the document, installs the DEV hooks, writes the DOM at import or constructs a boot-built
view; its registrations keep the order the plan lists, and the locale block stays in it. A shell
module imports only the shell modules below it. A lower module reaches upward through a typed port
`main.ts` installs, which throws until installed, or logs to the console until installed when its
caller swallows a throw (the pad's fault sink: a failing reporter must not stop the poll that
releases held buttons), or through the parameter object of a frame-loop pump. Code the module map
puts below the dispatcher reaches `dispatch` and `applyStack` through one such port,
`shell/commandPort.ts`, which imports no shell module.

**Why.** Every `main.*` suite resets the module registry and imports `main.ts`, so module-level
state in a shell module resets per test and no suite changes how it boots. An import
cannot be assigned, so the compiler holds each binding to one writing module, and a moved body
changes only by its imports or by the owner call that replaces a write. The order of the batch
listeners is load-bearing (the stack's reconcile ahead of every listener that shows the battle or
the dialogue; the stack sync and the adapters' observe last), and Biome reorders import statements, so
registration cannot follow module evaluation. The locale writes are the only import-time statements
another module could observe, and in `main.ts` they run after every import.

**Rules out.** Feature modules that each own a view and register their own batch listener at import:
listener order would follow import order, and the stack and the dispatcher would import the features
that import them. Also: one shared state object (no field has an owner); controller classes with
injected collaborators (each extraction would move code and change its interface at once); a prelude
module holding the locale block (it would run ahead of modules that run before it now); a
module-scope copy of a live binding; a shell module that registers a listener.

The shell modules and the ports `main.ts` installs: `ARCHITECTURE.md` "Client".

## Each client registry has one test that states its members

**Decision.** A fact that a client registry holds (the overlay ids, the catalog keys, the
subscription batch, the help entries, the command kinds, the menu rows and accelerators) is written
out as a literal by one test: a roster compared with the registry for equality, in order where order
is behaviour, beside the registry. The frame ids have no list of their own: they are the overlay
roster plus the Social frame. Any other test computes its expected value from the registry, asserts
only its own entity, or gives the assertion up to the owner; none asserts a bare count of a registry
or carries one in its title. A hand table that says what each member should be (its tier, its battle
policy, its adapter, its name) is expected behaviour: it stays hand-written, typed `Record<K, _>`
where the registry has a key type. The subscription batch is read from what the connection sends and
is not exported for a test.

**Why.** A count cannot say which member changed and survives a swap; a roster can, so the roster is
the one literal worth keeping. The compiler holds the `Record` tables total, but not the
subscription batch, the help entries or the menu rows, so one owner per fact is what still goes red
when a member is added, dropped or reordered by accident, and what a client subscribes to is what it
is sent.

**Rules out.** Leaving the duplicate counts: a stale count still says nothing about which member
changed. A shared constants module for tests: a second copy of every registry, and not a check. No
roster at all: nothing would notice a thirtieth subscription query. Rebuilding a per-member table,
or the subscription expectation, from the product value it checks. A tally that adds one per pass of
a loop over the registry, or that counts whether another test ran.

Each fact and its owning test: `docs/refactors/test-pins.md`.

## Interaction target: the tile in front, then your own tile

**Decision.** A (and a click on the world) acts on the candidates of one game-core rule: the entities
on the tile the character faces, or, if there are none, the entities on the character's own tile.
Same zone only; ordered NPC, then heal, then player, then by id. An entity within range but not in
front is never a candidate, even though talking accepts up to two tiles. The UI starts trades and
challenges only from a player you face, a shop only from its keeper's greeting, and a heal only from
a faced heal tile or healer NPC. The server is more permissive. Talking accepts the talk range from
the NPC's current tile. Opening a trade session and challenging refuse a partner beyond it (same
zone, at most two tiles of Manhattan distance), and healing refuses a caller beyond it from the heal
location's tile. Buying and selling refuse a caller beyond the talk range plus the keeper's wander
radius from the keeper's home tile, the same zone only. Each of those five refusals has one message
for every out-of-range case: another zone, too far and a missing character.
A challenge or a trade session is answered from anywhere: its range is checked only when it is
opened. A challenger out of range learns only whether the target is joined and online; a shop or
heal caller out of range is refused before the battle guard and before any read of their wallet,
inventory or cooldown.

**Why.** Interaction follows what the character faces, as in console RPGs. The server's range is a
latency margin for an NPC or a player that steps one tile before the reducer runs. It is not the
player's reach. A shop is measured from home plus the wander radius because its keeper wanders once
the greeting ends while the shop frame stays open; measured from where the keeper stands, an open
shop would strand its customer. The order in a challenge is not a privacy guarantee: a player who
walks up to the target still gets those answers. A range refusal itself reveals nothing new, because
characters, NPCs and heal locations are public rows.

**Rules out.** A nearest-within-range target; widening the client rule to match the talk range;
starting a trade, a challenge, a purchase, a sale or a heal remotely from a menu; re-checking range
when a challenge is accepted or a trade session is confirmed; measuring a shop from its keeper's
current tile; content that leaves an NPC outside its wander disc, or lets a healer NPC stand or
wander more than one tile from its location's tile (the reach rules assume neither, and that NPC's
customers are refused).

The candidate rule and each reducer's range check: `ARCHITECTURE.md` "server-module: the
authority", Battles, trades and the rest (Reach).

## The battle frame has one owner per tactical phase

**Decision.** Three views can own the battle frame (the deploy panel, the tactical shell and the
results panel), and at most one shows at a time. One switch routes by the tactical row's phase
(Deploying to the deploy panel, Active to the shell, Finished to the results panel, no row to none)
with one fixed ritual: render the hidden target first, pop every player frame over the battle base,
hide the other views, then show, the open being the last statement; a target that cannot be built or
rendered leaves the current owner in place. An anchor without its tactical row is not a battle the
client can show: an Ongoing one builds nothing and keeps a shown owner (a battle the client can
render is never hidden; the stack still holds the battle base, and Start opens the menu), and a
terminal one is dismissed, with every view hidden in the same batch. The stack and the switch share
one predicate for a renderable battle, so the stack never counts an unrenderable outcome. The three
roots are built lazily on the first batch that routes to them, share the battle frame's one
accessibility record, and keep their own hide idempotent. The active battle view, the battle hint
and whether the tactical shell owns Start are read from the shown view, never the phase.

**Why.** The overlay registry, the context stack and the accessibility record (the live region, the
focus trap) key on one battle frame id. Two visible roots would be two titles and two modal dialogs;
closing a covered record and opening a fresh one would leave a frame over the base inert; a root
constructed at boot would be a second title and a second modal dialog the moment a battle routes to
another owner. Routing by phase keeps "a battle the client can render is never hidden" a one-place
rule, and sharing the renderable predicate with the stack keeps a row-less terminal anchor from
closing drop-policy frames on every batch with nothing on screen.

**Rules out.** A second overlay id per battle view; showing a battle view outside the switch;
constructing the tactical roots at boot; a renderer switch that pops the dialogue frame (a server
conversation suspended over the battle base stays) or that demotes a visible shell when one batch
fails to build; a fallback renderer for an anchor without its tactical row.

The switch, the predicate and the readers of the shown view: `ARCHITECTURE.md` "Client", UI.

## game-core is mutation-gated nightly, the server on the lines a pull request changes

**Decision.** game-core's mutation run is nightly and sharded, and each shard is its own
zero-tolerance verdict. The server's zero-tolerance gate is a pull-request job: it mutates the
server-module lines the change adds or edits, diffed from the merge base, and a survivor fails it.
The full server sweep runs weekly and files its survivors as one issue on the default branch;
survivors fail nothing, and a shard is red only when it gave no verdict. A survivor is killed by a
test or, if provably equivalent (no input distinguishes it), excluded with the written proof. The
bodies of the four logging functions are excluded by name; their direct tests stay.

**Accepted gaps.** The diff gate selects mutants only on lines a change adds or edits, so a test
weakened or deleted with no server source line changed passes it, and so does a change that only
deletes source lines; the weekly report is read for both. The escaping, the reject line and the
reserved-key guard in the logging bodies are held by their direct tests alone: no mutation run
checks that those tests still catch a break in them.

**Why.** The crates outgrew one serial job: the nights of 2026-10-31, 11-01 and 11-04 were cancelled
at GitHub's 6 h cap. A count cap hides regressions (kill one, add one, same number) and rewards
raising it. A nightly full-sweep verdict lands after the merge, on whoever is next; a diff verdict
lands on the change that made the mutant, before it merges, and the eight-runner sweep then runs once
a week instead of every night. A log line is a diagnostic, not a rule: losing or garbling one
degrades what an operator sees, never a player's state, so the mutation gates judge rules.

**Rules out.** Dropping mutants to fit the time limit; excluding a killable mutant outside the
logging functions; a survivor count, budget or threshold on the server, or a committed survivor
baseline file; a test that asserts only log text no tool parses.

The jobs, their shards and the exclusion file: `ARCHITECTURE.md` "Verification layout".

## Menu chrome draws from `--mr-*` tokens; the listbox ring stays `#cc5500`

**Decision.** Menu chrome takes its spacing, type, borders and colors from the `--mr-*` tokens, whose
values have one home, the client's style sheet. Spacing and type are rem, so a root scale reaches
them. Frame, chip and banner border widths stay px. Every color token has a `prefers-contrast: more`
value. The target frame reads top to bottom as title bar, tab bar, a body that grows and scrolls and
an overlaid feedback strip, with the world's hint bar below; screens move onto it one at a time, so
some still differ. New kit classes are named outside the `mr-frame`/`mr-shell` family. The dashed
ring on a focused listbox or grid stays `#cc5500`; `--mr-focus` is for other focused controls.

**Why.** Each menu had grown its own spacing and type, which players reported as inconsistent. A rem
border lands on fractional device pixels at a continuous scale and shimmers. The listbox ring can
cross the light active row, where `--mr-focus` measures about 1:1 against the 3:1 a focus indicator
needs.

**Rules out.** New px spacing or font sizes in menu chrome; a color literal where a token has that
role; a rem width on a frame, chip or banner border; a color token without a `more` value; moving the
listbox ring onto `--mr-focus` while the active row keeps its light fill.

The token sheet, the border tokens and the focus-ring contrast check: `ARCHITECTURE.md` "Client", UI.

## One viewport number scales the world by integers and the chrome continuously

**Decision.** One pure function is the single scale authority. It returns the integer device scale
the world renders at, and a continuous chrome scale from the shorter CSS axis, clamped. The chrome
scale is written to the root font size at the same event that resizes the renderer, so every rem
token follows it; until the first write the root stays at 100%, a scale of 1. The player's text size
is a second factor on the root; it never moves either scale.

**Why.** Playtest 3 read the snapping world and the smoothly growing menu as two competing methods
(#586 D1). Each half needs its own rounding: a fractional stage scale blurs the pixel art, and a
snapped chrome jumps between sizes. The chrome scale uses CSS pixels only, so a dpr change leaves the
chrome alone, and `100%` keeps the browser's font-size preference in the product. The world reads
the same function at the same event, so the smoothness contract does not move. Borders stay px
tokens so they land on whole device pixels. The root rule matches only after the first write
because the client's DOM test environment cannot compute rem through a `calc()` root font-size, and
some suites load the real sheet without the resize seam.

**Rules out.** A fixed-ratio letterbox: the visible tile count and the map margin absorb the
remainder, because a box would change how much world each window shows. Integer snapping of the
chrome scale, a second scale calculation elsewhere, and a px root size, which would override the
player's browser font setting. A dpr change with no size change fires no `resize` in Chromium, and
the seam stays resize-driven, so the world catches up at the next resize.

The scale function, the root rule and the text-size factor: `ARCHITECTURE.md` "Client", Rendering.

## Four message channels, chosen by one policy table

**Decision.** Every message the client shows has a message kind, and one policy table assigns each
kind to one of four channels. The **hint line** is a frame's feedback strip, or the world line when
no frame hosts it. The **toast** is one timed region for outcomes. The **modal** is a confirm sheet
for decisions. The **blocking text box** is the dialogue. The table is total over the kinds, so a
kind with no channel fails typecheck. Senders go through one routing module and name a kind at the
send site; a battle refusal paints the toast directly and is announced at once. A toast is announced
once through the one live region and hides after a fixed time on the frame clock. A persistent hint
follows the top frame. On the main menu's strip it outranks the menu's own line: an action-required
hint comes first, then a persistent state, then a disabled reason, then a Y-description. Otherwise
it sits on the world line, which is layered above every shell and below the toast. The strip is an
overlay with no layout height.

**Why.** Playtest 3 found that the old strip pushed the frame's content when it appeared (058). It
also found that the status line painted under every shell, so a rejection sent from the Monsters
sheet, or a disconnect, never reached a player with a frame open. One table means a view never
chooses its own channel, and the wireframes' channel table is checkable against the code. A toast is
never the only carrier of something the player must act on: an action-required toast kind names the
on-screen state that also carries it.

**Rules out.** A per-view channel choice. Holding a battle refusal until the battle ends: it is a
timed toast now. A second live region: the toast is not one. New `.mr-frame*` or `.mr-shell*`
selectors for the strip. A multi-line strip: a long hint ends in an ellipsis and the live region
still says all of it. A frame whose strip its own view still owns carries a persistent hint on the
raised world line until its strip joins the routing module.

The routing module, the strip's layout and the policy test: `ARCHITECTURE.md` "Client", UI.

## The Monsters action sheet is one corner-anchored ContextSheet; Summary is a page in the frame

**Decision.** A Monsters frame has one context sheet, mounted in the tab content area. It sits in a
bottom corner away from the cursor cell, the top corner if the bottom would touch that cell, else
height-capped and scrolling. Nothing is dimmed; the tabs and grid stay live. It is re-placed on every
paint and on panel resize. One content shows at a time: the sheet's rows, a sub-list (Feed…,
Evolve…) or the Evolve confirm, all in the same root. The sheet ends with Close, each sub-list with
Back. A on either is B's step; a held A does nothing. Summary is a page in the frame that replaces
both grids, with the tabs kept. It is not a sheet and adds no overlay id. B or A returns to the sheet
on the same monster; LB/RB close it to the list on that tab, since a tab click has no sheet close
before it.

**Why.** A sheet wedged between tabs and panels read as a stray panel (feedback 047). A fixed single
corner covers the selected slot for some slots. Beside-the-slot moves with every slot, and in-slot
buttons break on the grid, so the wireframe study's verdict on sheet placement adopted only the
detail page. A page gives Summary room for all stats without a second overlay.

**Rules out.** A fixed corner, beside-the-slot placement, in-slot buttons, a dim layer, a second
sheet root per sub-list, and a Summary implemented as a sheet or an overlay. The Inventory and Social
sheets reuse this placement and the kit's Close and Back rows. The Social row sheet ends with Back,
not Close: it opens from a row of the Social list, and A on Back returns to that list with nothing
sent. The world sheets reuse the Close row but keep their own anchor, under the interaction prompt.

The sheet's placement, ids and Back rows: `ARCHITECTURE.md` "Client", UI.

## Select is Help everywhere; a world sheet closes under it and ends with a Close row

**Decision.** Select opens Help over the bare world and over every world sheet: a fresh Select over a
sheet closes it and falls through to the base, which opens Help; a held Select is consumed and
changes nothing. The world sheets (the entity × action picker and the Y action sheet, the Accept /
Decline / View request sheet, the Challenge party-size confirm) paint as the kit's context sheet
inside the interaction prompt, hung where the prompt hangs, and are not re-placed by the corner
anchor. That root is what lets the pointer source click a row and close the sheet from a click
elsewhere. Every picker, action sheet and request sheet ends with a Close row: a layout row, not a
sheet entry, whose A is exactly B's step, so the sheet closes and nothing runs or is answered. The
Challenge confirm keeps No last and gets no Close row. The hint bar reads A OK (Choose beside a
multi-row picker), B Back, Start Close, Select Help over every world sheet.

**Why.** An earlier rule let an open sheet swallow Select, so the hint bar's Select Help chip lied
over every sheet. What that rule guarded against was Help opening under the sheet; closing the sheet
first keeps that guarantee and makes Select one action everywhere. The Close row exists because a
pointer player has no B: the chip-only prompt takes no pointer events, so a world sheet could only be
left from the keyboard (playtest 3 feedback). The confirm already has an exit row, No; a second one
would make its shape ambiguous.

**Rules out.** A world sheet that swallows Select; Help pushed over an open world sheet; a Close row
modelled as a candidate action or sheet entry (it would need a candidate and count toward the Choose
verb); a Close row on the Challenge confirm; re-anchoring a world sheet with the corner anchor (it
must stay where the faced thing is); promoting a world sheet to a frame or overlay id (a request is a
non-modal banner and world sheet, never a frame).

The world sheets' models, the Close row and Select's fall-through: `ARCHITECTURE.md` "Client", UI.

## Profile is one dialog; the rename, claim and privacy views are its sections

**Decision.** Profile is one overlay: it owns the frame root, the title, a body that scrolls under it,
the Close row, the accessibility open and close (one role, one label, one focus trap) and the one
column of rows the D-pad walks. Its initial-focus anchor is the name field; an open on Account or
Privacy seats that section's row at once instead. The rename, claim and privacy views keep their
files, models, handlers and element ids but are sections: they hold no accessibility of their own,
are shown and hidden only through the frame, and are not overlay ids. The frame takes the strictest
row of the three it replaced in every table: a player frame that a battle drops, and one a reconnect
closes (after the sweep, the reconnect shows a claim prompt its own cycle raised again). N and C are
two accelerators onto the one frame, the section carried as the path's tab; with Profile on top, the
one whose section does not hold the cursor moves it there. Every close (B, Start, the Close row, a
battle, a conversation, a reconnect) runs each section's hide, which disarms both two-step confirms,
the deletion's and the claim decline's; a move that enters a section whose confirm is armed lands on
its No. The privacy section opens over nothing, so no overlay-busy refusal guards it.

**Why.** The operator's complaint was three sparse full screens behind a sub-list (playtest 3, #586
D3). Tabs would have kept three sparse pages. Three dialogs cannot be visible sections of one screen,
because two open focus traps cannot coexist; the Social frame's one-panel-at-a-time trick shows one
panel, not three. A decline has to disarm on close, and No has to be where the cursor enters,
because one column puts an armed "Yes" directly under the name field, where Escape or one Down would
land on it.

**Rules out.** Giving a section its own accessibility open, role or frame classes; showing or hiding
a section alone (a section's own Escape, a per-section reconnect reset); a Profile sub-list or
Profile tabs; a second always-enabled anchor inside the Privacy section (the frame's Close is the
reseat target when a render refuses the focused control); leaving either confirm armed behind a
closed frame; the list scroll cue on the body (its gradients sit behind running text, where contrast
cannot be measured); re-adding an overlay-busy refusal for privacy.

The frame, its sections and the tables it sits in: `ARCHITECTURE.md` "Client", UI.

## Every served asset carries a provenance row; image-model output never ships

**Decision.** Every PNG the client serves has exactly one row in the art registry, which lands in the
same change as its file and records where the file came from, its license and its provenance tag.
The row type accepts only the licenses `project-original`, `CC0-1.0` and `CC-BY-4.0`/`CC-BY-3.0`,
and a CC-BY row must carry an attribution. It accepts only the provenance tags
`placeholder-procedural`, `placeholder-licensed` and `final`. The `ai-placeholder` tag, share-alike
and EULA licenses cannot be written. A validator rejects what the type cannot express, and a check
holds the rows against the served directory and the PNG headers. Image-model output is for ideation
only and never ships. The art rules live in `docs/art/style-guide.md`.

**Why.** Every served asset is a placeholder until an artist is hired. Without a record of where each
file came from, a placeholder that a license does not allow us to ship, or image-model output, could
reach a release without anyone noticing. Keys stay stable so final art is a file swap.

**Rules out.** Serving a file without a registry row; a row tagged `ai-placeholder`; share-alike or
EULA assets until counsel signs off; renaming an atlas key to swap art; asserting a file count in
place of the directory-against-registry check. A release gate that every row is `final` is deferred
to the launch checklist.

The registry, its row fields and the validator: `ARCHITECTURE.md` "Client", Rendering (Art registry).

## The frame loop is the only thing that draws; the sprite batcher samples at most four textures

**Decision.** Pixi's own render ticker is stopped. The renderer draws once at the end of each
frame-loop frame, and a resize draws because a resize clears the canvas. The sprite batcher is capped
at four textures after init and again after every WebGL context restore, because Pixi re-reads the
limit from the device on a context change. On a context restore the renderer also re-bakes the
terrain chunk textures and drops the generated placeholder character textures, since a rendered
texture comes back empty.

**Why.** Pixi's batch fragment shader chooses its texture with an if/else chain as long as the batch
limit, evaluated for every covered pixel. A hardware GPU does not notice. A software rasteriser
(SwiftShader: headless CI, and any player whose browser has no usable GPU) reports a limit of 32 and
pays for the whole chain per pixel, so the cost grows with how much of the canvas the map covers.
Measured on 2026-11-10 in headless Chromium on 2 cores at 1280x720, this configuration against Pixi's
own ticker at the device limit of 32 took idle browser CPU from 118% to 63% on a 10x7 zone and from
177% to 107% on a 28x20 zone that fills the canvas, where the frame rate rose from 39 to 60 fps and
the median key acknowledgement fell from 25 ms to 4.9 ms, with identical pixels. The cap covers the
sprite batcher, which draws the whole kit-atlas world, and not the flat-terrain fallback, whose shader
is built at the device limit before the cap applies. With Pixi's ticker running beside the frame
loop, Pixi draws the state the loop resolved on the previous animation frame; with one owner a frame
is presented in the task that resolved it. Without the re-bake, the terrain stays blank after a
context restore (30% of the canvas on the small zone, 98% on the large one, the same day).

**Rules out.** Starting Pixi's ticker, or adding a second `requestAnimationFrame` loop that draws; a
canvas-clearing operation that does not draw afterwards; raising the texture cap without re-measuring
under SwiftShader; a new generated texture that is not rebuilt on a context restore.

The ticker, the cap and the restore path: `ARCHITECTURE.md` "Client", Rendering.

## The client builds for ES2022; the wasm import is a native top-level await

**Decision.** The client's build targets `es2022` and uses no top-level-await transform. The
wasm-pack `bundler` package is resolved by the bundler's wasm plugin, and its async init is awaited
at module top level by the browser itself. The supported floor is every browser with ES2022 syntax:
Chrome 94, Firefox 93, Safari 16.4.

**Why.** A transform for older targets re-emits every chunk unminified, so the production bundle
ships with its whitespace and long names. Measured on 2026-11-10 on one commit, the transform took
the entry chunk from 794 kB to 1,219 kB raw (237 kB to 278 kB gzip) and all JavaScript from 358 kB to
419 kB gzip, and over 10 cold loads of the built client took script time to first idle from 70 ms to
96 ms and the first canvas from 244 ms to 277 ms. `es2022` produces the same bundle as `esnext`
today, but `esnext` lowers nothing, so the floor would move with whatever syntax a dependency ships.
The browsers below the floor date from 2021 or earlier and are out of vendor support.

**Rules out.** Re-adding a top-level-await transform; `build.target: 'esnext'`; lowering
`build.target` below a level with native top-level await while the wasm package is built for the
`bundler` target.

The build configuration: `ARCHITECTURE.md` "Client".

## The world post stack is `pixi-filters`, on the world layer only, planned from injected time

**Decision.** The post stack uses four filters from `pixi-filters`, pinned exactly and imported by
subpath: a lightmap, bloom, godray and a color-map LUT. One pure function plans it from the pass
toggles, an injected clock, the reduced-motion bit, a time-of-day keyframe, the renderer's
device-pixel resolution and what the renderer supports, and returns the passes to run in a fixed
order with their options; a disabled pass is left out of the plan rather than zeroed. The renderer
builds exactly those filters on the one container holding the terrain, decor and actor layers,
never on the stage or the DOM UI. Each filter runs at the renderer's resolution, and the LUT samples
nearest. The godray time is the injected clock, held at 0 while reduced motion is set; no filter
reads a wall clock or `Math.random`. An unsupported renderer, a pass whose construction throws, or a
throw from the probe frame drawn after the build disables the whole stack: the plan is empty with
one warning, and the world draws unfiltered. A driver that fails a shader without throwing is not
detected. The renderer starts with the stack off at the `day` keyframe, and the live game keeps it
off. A production build that turns the stack on must keep it off on a software rasteriser,
recognised from the WebGL renderer string read at init and again after a context restore: a string
naming SwiftShader or llvmpipe, in any letter case, would be one more reason for the empty plan and
its warning. A string that names neither, or that the browser masks, counts as hardware, so another
software rasteriser runs the stack until it is measured and added to the check's list. No production
build turns the stack on, so the check is not written.

**Why.** `pixi-filters` was the vetted choice of the PixiJS ecosystem review. It is MIT-licensed, has
no install scripts, and its single runtime dependency is a types package. It ships WebGL and WebGPU
programs for all four passes, which saves writing and maintaining four shaders. With the exact pin,
an upgrade is a deliberate lockfile change, and the subpath imports name the four filters in use.
Filtering the world container alone keeps the UI unfiltered. The world's tile edges stay one-pixel
hard steps because every pass renders on the device-pixel grid. A filter below the renderer's
resolution would be resampled, and the chain runs at the lowest resolution of any of its filters.
Injected time keeps two frames with the same inputs pixel-identical, which is what the look-dev
scene asserts. On software GL the stack costs many times an unfiltered frame, most of it godray and
bloom (`docs/art/style-guide.md` §Post stack). That is the reason for the software-rasteriser rule:
with the stack on, the live client misses the 55 fps frame-rate objective on SwiftShader and on
llvmpipe, and meets it on both GPUs of the same host at 1280×720 (§Low-end frame times). The
renderer string decides it because it is known before the first filtered frame, and the plan stays
a pure function of its inputs. The rule stops at software rasterisers: through WSL2's D3D12 layer
the host's integrated Radeon also misses the objective with the stack on at 1920×1080 and above, so a
build that turns the stack on also needs a bound for a weak hardware GPU, which this entry does not
set. A canvas clear per filter pass also breaks the frame loop's one-clear-per-frame check. So the
live game keeps the stack off.

**Rules out.** Filters on the stage, on a DOM layer or per sprite; a pass kept in the chain at zero
strength; a shader, filter or animation reading a clock other than the injected one; a filter at a
resolution below the renderer's; a linearly sampled LUT; adding another filter package without a new
entry here; turning the stack on in a production build without the software-rasteriser check;
recognising a software rasteriser from measured frame time (a clock in the plan, and the stack must
run slow before it is measured); `failIfMajorPerformanceCaveat` in the check's place (headless
Chromium created a context with it on both SwiftShader and llvmpipe); a player setting as the only
guard.

The plan, its passes and the renderer's hooks: `ARCHITECTURE.md` "Client", Rendering (Post stack).

## The connection target is run-time configuration: a shell document set before the client module runs

**Decision.** The client reads its server from a page global, the shell document `{ connection: {
uri, db, kind, fingerprint }, host }`, which the classic script `/shell-config.js` sets before the
module script runs; `kind`, `fingerprint` and `host` are optional. One resolver rejects a present
document that is wrong and never clamps it. An absent document means the development defaults in a
development build and a throw in a production build. An omitted `kind` is `test` in development and
`private` in production. `uri` and `db` are used exactly as written (trimmed) and key the stored
reconnect token and claim code; `fingerprint`, the fingerprint of the world's certificate key, is
not trimmed. `host` describes the page's host and asks for nothing by itself, and a world's gate
serving a page to a browser never writes it. A build in which any file other than `shell-config.js`
contains the playtest database name fails.

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

The document's fields and their rules, the resolver, the Vite plugin that serves and writes the
document, and the build check: `ARCHITECTURE.md` "Client", Connection and store, and Diagnostics.

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

**Decision.** A capability the client takes from whatever hosts its page (a browser tab, or a
desktop shell) has one owner in the client. Where a second host must provide it differently, the
owner is a port: a module under `client/src/platform/` that exports plain functions and holds the
browser's code as the default. Where every host provides the same web API, the owner stays a narrow
structural type the real global satisfies or a DOM registration the client makes. A shell supplies a
port's function through one page global, the shell bridge, set before the client module runs by the
hook that sets the shell document; it holds functions only, and a verb it does not hold runs the
browser's code. Every shell implements the same bridge, so one bundle runs in a tab, in Electron and
in Tauri. The first port is the hand-off to the operating system: open an address outside the game,
save a file the client made.

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

The call sites, the plan and the judge's scores: `docs/refactors/client-platform.md`.

## Local-play budgets are measured medians with stated headroom, on one machine profile

**Decision.** A single-player world and a friends server hold these budgets, each about one and a
half times the median it derives from, measured with the server confined to the two threads of one
core and 2 GiB:

| | Single-player world | Friends server |
|---|---|---|
| Memory | 330 MiB | 330 MiB |
| Idle CPU | 1.4 % of one thread | 1.0 % of one thread |
| Start-up to playable | 800 ms | 800 ms |
| Disk growth | 12 MiB per hour | 68 MiB per hour |

The friends-server memory and disk numbers are a walking-only floor, set again when battles and
trades are measured. Work that changes what the server does per tick, per connection or at start-up
re-measures and holds these.

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

The medians, each measure and the condition it is taken in, and the method: `docs/local-play.md` §6
and §7.

## A target's kind gates telemetry and account sign-in: only servers we operate get either

**Decision.** The shell document names the target's kind (`official`, `test`, `local` or `private`),
and the kind decides at run time whether the client sends telemetry and whether it offers an account
sign-in: only `official` and `test` get either. The telemetry resolver takes the kind as a required
input and decides on it before it reads any env value, so a `local` or `private` target resolves
disabled and the OpenTelemetry SDK never loads. The client reads the build's login issuer in one
module-scope assignment that keeps it only for `official` or `test`, and hands the connection the
client id under the same kind test; that one issuer value decides both whether the connection signs
in and whether the Profile screen offers Sign In. With no issuer the connection runs with sign-in
off: it builds no OIDC client, so every connection is anonymous and no OIDC request leaves it
whatever its URL or storage holds. Toward `local` and `private` the one sign-in a browser page can
make is for a world's ticket, only when the build names a ticket issuer, through an OIDC client
built apart from the connection; its token goes to the account service's ticket route alone. A
production document that omits `kind` resolves to `private`, so it gets neither account sign-in nor
telemetry. The OTLP endpoint stays a build value; the run-time decision is only whether to use it.
The control reads "Sign in / create account with <provider>", under the build's provider name or the
issuer when the build names none, because registration happens at the provider (operator ruling,
<https://github.com/mdrewt/monster-realm/issues/588>).

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

The resolver, the issuer read, the sign-in modes, the e2e build's placeholder issuer and the two
tests that hold both gates: `ARCHITECTURE.md` "Client", Connection and store, and Diagnostics.

## The desktop shell keeps a single-player or friends world's reconnect token on the device; a browser keeps every target's per tab

**Decision.** A page in a browser keeps the anonymous reconnect token per tab (`sessionStorage`) for
every kind. The desktop shell keeps a `local` or `private` world's token on the device (the origin's
`localStorage`), and every other kind's per tab. The shell is known by the shell document's
top-level `host: 'desktop'`, which the desktop shell writes and a browser page's document leaves
out. The client uses exactly one area, never the other: a blocked area means an anonymous connect,
not a fall back. A `local` or `private` target kept per tab first removes that one target's token
key from `localStorage` (a token a page left there earlier) and nothing else. The key is derived
from the target's `(uri, db)` in both areas, and the rule that withholds the token after two
rejections since the last successful connect is the same in both (the token is withheld, never
deleted). Only an anonymous build's token is saved; the account-kind marker, the guest-claim code
and the OIDC flow stay in per-tab `sessionStorage` for every kind.

**Why.** A browser may be a shared or public computer, and a world finds the player's character again
by their account (one character per account in a world; a check under a handle another identity holds
moves the character), so a browser needs nothing past its session. The desktop shell's storage belongs
to one player's device, so a relaunch resumes the same identity with no ticket request.

**Rules out.** `localStorage` for a page in a browser; falling back from one area to the other; saving
an account token in either area; keeping a ticket or an ID token in any storage. Accepted costs: a
device-kept token is readable by every script in the shell page's origin for as long as it is stored,
so whatever serves the page must keep foreign script out of that origin; and a successful anonymous
connect after two failed verifications replaces the stored token for good.

The persistence rule, the token gate, the forget step, the connection options and the tests that
hold it: `ARCHITECTURE.md` "Client", Connection and store.

## The e2e job lists the tests that passed only on a rerun; a flake stays in `docs/e2e-flakes.md` until its fix merges

**Decision.** The CI `e2e` job judges each shard by its highest attempt and lists every test that
passed only on a rerun: `unexpected` on a lower attempt and `expected` on the highest. The list goes
to a table in the run's step summary, complete and on a failing run too, and to one annotation per
test. The listing changes no verdict: a green highest attempt still passes the job. Playwright
`retries` is unset, so a rerun of failed jobs is the only second attempt, and a report's `flaky`
count stays a failure. `docs/e2e-flakes.md` registers the e2e flakes whose fix has not merged, each
with its evidence, its verdict (product or test) and its next step. The change that fixes a flake
deletes its entry. A test the listing names that has neither an entry nor a residual row of its own
is a new flake and gets an entry. A flake that its own row holds may stay a row until a study takes
it.

**Why.** Before the listing, a test that failed and then passed on a rerun left no mark on the run.
The only way to find one was to read the attempt-1 jobs of every rerun run by hand. Failing a run
that needed a rerun would instead turn every flake into a red `master` and push reruns into fix
slices. GitHub caps a step's annotations, so the summary table is the complete list. Up to that
cap, the annotations let a later tool count rerun-passed tests per run through the check-runs API
without reading logs. A single register keeps a flake's evidence in one place until a merged fix
makes it history.

**Rules out.** Failing the `e2e` job for a test that passed on a rerun; a flake entry that outlives
its merged fix; a second flake list beside the register.

The script, its output lines and what a register entry holds: `ARCHITECTURE.md` "Verification
layout".

## The party is read through an `(owner_identity, party_slot)` index

**Decision.** Every read of a player's party on a per-input or per-tick path goes through a btree
index over the private `monster` table's `(owner_identity, party_slot)`, as the range from slot 0 up
to `PARTY_SLOT_NONE`, which yields the party in slot order; the heal, once per heal, still reads by
owner. Reads that need every monster an owner holds keep the single-column owner index.
`PARTY_SLOT_NONE` is `u8::MAX`, held by a compile-time assert, because only then does the range mean
"not in Storage".

**Why.** Storage has no cap, and the owner filter read every monster the player held on every input.
Measured on 2026-11-16 (the load driver, 20 clients, median of 5), with 1,000 Storage monsters
`enqueue_move` cost 13.9 times its cost with one, and through the range 1.37 times, with a control
showing that the remainder follows the table's size, not the owner's Storage.

**Rules out.** Reading the party on a per-input path through `owner_identity` and dropping Storage
rows; capping
Storage to bound per-input cost; a `PARTY_SLOT_NONE` other than `u8::MAX` without changing the
range.

The two indexes, the reads on each and the assert: `ARCHITECTURE.md` "Schema and privacy model".

## Owner views are rebuilt only when dirty

**Decision.** The client rebuilds an owner view from the SDK cache only when that view is dirty. A
view's own insert and delete handlers mark it; there is no update handler and no per-row store
write. Every view is marked when the store is reset on a drop, after every connection build wires
its tables, and first when the base subscription applies. A view is cleared once its reconcile
returns; a throw leaves that view, and the later dirty views of its try group, dirty for the next
batch. Every non-view row handler is wrapped so that a throw marks every view, schedules the flush
and rethrows.

**Why.** Measured on 2026-11-16 with 1,000 Storage monsters (node, median of 400), rebuilding every
owner view (thirteen then) on every batch cost about 0.5 ms, even for a batch of only `character`
and `player` rows, which arrives on every movement step, and the dirty set brings that batch to
about 0.0005 ms. A view's update arrives as an unordered insert and delete pair, so a rebuild stays
whole-view and is read from the cache; only how often it runs changed. The SDK's dispatch loop has
no try/catch, so a throwing row handler skips the rest of a message whose rows are already cached.
Without marking every view on a throw, those views would stay stale and clean.

**Rules out.** Rebuilding every view on every batch; writing a view's rows into the store from its
row handlers; a row handler that throws without marking every view.

The reconciler, its marks, the wrapper and what a new owner view adds: `ARCHITECTURE.md` "Client",
Connection and store.

## Load is measured at the client's scope: `mr_load_driver`, a nightly smoke, reducer share by reducer

**Decision.** One tool measures load: the sim-harness load driver. Each bot holds what a walking
client holds of `player` and `character`: the client's `player` query, byte for byte, plus its
per-zone `character` queries. It holds none of the client's other tables, which walking does not
write. The report gives each level's received bytes per client per second, as a mean and for the
worst bot, over the driver's own scrape window. A nightly smoke (20 clients, one level) goes red
when a level is invalid: no bot joins, a bot's zone scope never settles, or no move reaches the
server. A level where every move is rejected stays valid, as a measurement of a saturated server.
Runs over many zones use the load-only build. Reducer-thread share is a recording rule over the
host's transaction time, summed by reducer.

**Why.** The host's `spacetime_num_bytes_sent_to_clients_total` counts a delta once, not once per
subscriber, so only a client's received bytes measure fan-out, and a bot that subscribes less than
the client under-counts it. The host series also holds each reducer's `Update` rows beside its
`Reducer` rows, and non-reducer transactions as one series with no reducer label. The rule's total
is therefore transaction-seconds per second and can exceed 1.0. It is a share by reducer, not a
utilisation.

**Rules out.** A host-side byte counter as the per-client budget signal; a driver whose
subscription differs from the client's; a CI load run that exits 0 on an invalid level.

The driver, its report fields and exit code, the smoke's job, the load-only build and the rule:
`ARCHITECTURE.md` "Observability", Load.

## The official server is sized for 1,000 concurrent players over 100 zones

**Decision.** The operator set the official server's population target on 2026-11-12 (the harness's
`game-design.md` §14). The world has up to about 100 zones. A zone holds 8–12 players on average,
and about 50 in a few zones. The world holds about 600 concurrent players on average and about 1,000
at peak. It stores 50,000 accounts; that count is a default, not an operator figure. The budgets
every population-scaled cost is held to are:
- a zone tick's p95 under `STEP_MS`;
- input round-trip p95 under 50 ms;
- download under 20 KB/s per client;
- the reducer thread under 50% at a 30% walking share.

The run of record is the load driver against the load-only build: 1,000 clients over 100 zones, one
zone filled to 50, 30% walking. A breached budget becomes a follow-up. Revisit the target if the
game outgrows it.

**Why.** Single-player and private worlds run on a player's own machine and are budgeted in
`docs/local-play.md`. Only the official server holds many players, so it alone sizes scaling work. A
client's download follows the walkers in its subscription scope: about 0.85 KB/s plus 0.077 KB/s per
walker, measured on 2026-11-16 in one zone up to 100 walkers. By that line the 20 KB/s budget is
reached near 220 walkers in one zone; that figure is extrapolated, not measured. The reducer thread
is one writer for the whole world. The target also sets `battle_summary`'s cap and the leaderboard's
rescan size.

**Rules out.** Sizing scale work from playtest populations, where 2–5 players hide every such cost;
a per-input, per-batch or per-join cost that grows with stored accounts or monsters owned.

The load driver and the load-only build: `ARCHITECTURE.md` "Observability", Load.

## A private world checks an account itself: a one-use ticket at first contact, then the account's handle

**Decision.** In a single-player or friends world the player connects under that world's own
anonymous token and never sends an account token. The world asks our account service itself whether
the player's account owns the game, and keeps the answer in a private row per identity, under a
handle: what the service answers for one account in one world, opaque, the same at every check, and
not a credential. An identity reads its own row alone.
- **First contact** spends a one-use ticket that the player's own software gets from the service,
  naming the world as that software authenticated it. The world presents it with the names it
  answers to and stores the answer, a negative one included. An identity the access rule has not
  admitted cannot connect, so the world's owner relays its ticket; a per-minute budget bounds the
  redeems a world sends, and never refuses the relay.
- **Later**, the world asks again about one identity at most once in 10 minutes, when it connects:
  arming the re-check stamps the row, so a client that reconnects in a loop cannot make it ask at
  every connection. It asks about the host's own account, the identity the owner names and marks on
  its row, on an hourly tick that asks once a day and again within the hour after a tick that got no
  answer; it sends nothing about an account pending deletion, and that schedule row is replaced,
  never updated.
- **The stored row admits** and entitles the connection the whole time a request waits, and a row
  never expires; a check that gets no answer changes no standing.
- **The world learns its address** from the service's answers: it asks over the address family of
  its `ip:` names, and a redeem stores the address a usable answer reports apart from the account,
  so a redeem refused after that answer has still stored it. A redeem presents an `ip:` name only
  while no address is stored for its family or the stored one is the name's own and was confirmed
  under 25 hours ago, and a move goes through one only while the stored one is.
- **A transaction that stores an answer** reads again every row it decides on, so an older answer
  never overwrites a newer one. No log line, table or return value holds a ticket, and no log line
  or return value holds a handle.
- **The player erases the link** with the unbind, which the access rule does not gate, and the owner
  can drop it; either takes the identity's admission row with it.

Only four procedures send a request. The attestation binding compiled beside them entitles and
admits nobody. A caller who is not entitled is refused by every reducer a player plays through.

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
alone would let back in an identity whose handle the owner removed. The host's own check exists
because a world asks only when somebody connects: one its host leaves running would otherwise keep
a standing and an address nothing has confirmed for days. The mark sits on a `world_account` row
because the owner's credential stays out of the page, so the host plays under another identity
than the owner's. The check ticks hourly and asks at 23 hours so that one falls due within a day
and a failed tick is tried again before a stored address, good for 25 hours, lapses. The schedule
row is replaced because the pinned host (2.16.1, read in its source and not measured on a running
host) queues an updated scheduled row again at the call, under the new row's hash, and drops that
entry when the transaction then aborts: an interval row would stop ticking until the host
restarts, while a delete and an insert that roll back leave the first row's entry queued. An
address can change hands, and a world that went on presenting its `ip:` name would vouch for
whoever holds the address next. The account service sees where a world's requests leave from, so
the world learns its address from the party it already asks and calls no other. One request
reports one family, so the world asks over the family its `ip:` names are in: a dual-stack host's
requests could otherwise leave over IPv6 and its IPv4 name would never be confirmed. The redeem
stores the address apart from the account because a refusal aborts the storing transaction, and
the answer that shows a name to be another's is the one refused. A stored address stamped after a
transaction's own time vouches for nothing, so a clock that steps back fails closed; the pinned
host takes each transaction's time as it opens, a procedure's included (read in its source), so
no order of honest transactions produces such a row. The host's check sends nothing for an
account pending deletion for the reason a connection arms no re-check for one: the cascade is
about to erase the row. The choice rests on the bundled
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
the admission row through an unbind or a drop; updating a `host_check_schedule` row in place; a
host check a client can start, or one that asks about any handle but the marked row's; presenting
an `ip:` name once the stored address is another or is 25 hours old; storing an answer's address
only together with the account row. Defaults the operator may overrule (asked on
<https://github.com/mdrewt/monster-realm/issues/861>): the withdrawal writes `world_admission`, so an
unbind in a `Password` world costs the player the door, and so does an unbind under `Open` by a
player who is offline when the rule changes to `Password`; after an unbind under `Password` or
`Allowlist`, a player other than the owner is refused by the access check and cannot check in again
without the owner's relay; a removed player who has disconnected cannot reach the unbind, since
every route runs the connect reducer first (see "A world that is not open refuses an unadmitted
identity at connect and in every reducer"); the `test` and `dev-enforcing` builds name the
`hosted-dev` account service, so a dev server's `check_account` sends real requests there; and an
answer whose `handle` is missing is stored as not entitled whatever else it says. Defaults of the
address rule and the host's check, which the operator may overrule too: a world that lists `ip:`
names of both families asks over IPv4 and never presents the IPv6 one; a world whose requests
leave from another address than the one it lists (a NAT gateway, a proxy, a VPN) never confirms
its `ip:` name and checks nobody in through it; a world reached only by an `ip:` name, with no
host marked and no known player returning, stays closed to first contact once its stored address
is 25 hours old; nothing clears the host mark but naming another identity or erasing the row, and
a schedule row whose marked row was erased keeps ticking and sends nothing; an answer that reports
no address is judged by the stored row alone (the service reports one in every answer).

The procedures, tables, refusals and schedules, the address rule, the client's half and the tests:
`ARCHITECTURE.md` "server-module: the authority", Private worlds; the measurements on 2.16.1 and the
four alternatives with a judge's scores: `docs/refactors/account-checks.md`.

## One character per account in a world: a check under a handle another identity holds moves the character

**Decision.** When a world's account check, the player's own or the owner's relay, is answered with
a handle that another identity of the world holds, the two identities are one account at two
clients, and the transaction that stores the answer moves the character to the identity the ticket
was redeemed for: every row that makes up the character and its position, with no marker, zeroed row
or tombstone left at the source. The source's presence rows are deleted, and the destination's own
join makes its character. A private row records the identity the character left; until that
identity's next successful check deletes it, the join and the guest claim's completion refuse it, so
checking in again with the same account moves the character back. The move is refused with no write
through an `ip:` name the world has not confirmed, for a caller that holds another account or owns a
character, and, under one reason, while either identity is in an ongoing battle or a trade or the
source's account is pending deletion. A move admits nobody, and leaves the source unadmitted where
the rule was refusing it. Finished battles and the rows about the source's own connection, admission
and login stay under the source.

**Why.** An account owns the game once, and a browser connects under a fresh identity at every
session, so without a move a returning player would start over or hold one character per browser
session. The move is its own primitive because the guest claim's re-key leaves the source a
starter marker, a zeroed wallet and a tombstoned profile: the claim retires its source, while a
move's source must be able to receive the character again. For the same reason the profile row is
re-keyed whole. `profile` rows otherwise survive every path, an account deletion included, so the
ladder never loses an entry; a move keeps the entry and changes the identity it is filed under.
The presence rows are deleted and not re-keyed because `guards::authorize_move` refuses an input
sequence at or below the character's last one, so a second client would be refused until its
counter passed the first's; because the owner's relay names an identity that is not connected,
whose `player` row no disconnect would remove; and because a client calls `join_game` after its
check. The join is refused while a `world_move` row stands because a build that entitles the
source by its token, or that does not enforce ownership, would otherwise grant it a second
starter; an unbind that cleared the row would open the same way round the refusal. A guest claim
is refused for the same caller because the claimed character would be one it can neither join
with, while the row stands, nor replace by checking in, since it would own a character. While an
identity holds a `world_account` row, `Allowlist` reads its handle and not its admission row, so
an admission row left under a source whose handle the host removed would let that identity back
in the moment its account row moved away. An address can change hands while a world still lists
its `ip:` name, and a ticket through it would carry a character to the address's new holder, so
such a name carries a move only while the address the account service last reported for the world
is the name's own. A pending deletion keeps the
character under the identity its cascade is keyed on. One reason covers the three states of the
other identity so the answer tells a ticket's holder nothing about it. The relay moves too: an
identity the access rule has not admitted reaches the world only through it, and the owner already
holds the database.

**Rules out.** `accounts::rekey_all` for a move; re-keying a `player`, `character` or `move_intent`
row to another identity; a marker, a zeroed row or a tombstone left at the source; a second
character for one handle; a move through an `ip:` name the world has not confirmed; a move out of
a battle, a trade or a pending deletion; a log line inside the transaction (its body may run
twice); a refusal reason that tells which state the other identity is in; an unbind or a drop that
clears a `world_move` row; a move that leaves the source admitted where the rule was refusing it.
Defaults the operator may overrule: a ticket is a bearer credential for its 60 s, so whoever
redeems it first names the identity the character moves to; `playtest_event` rows, seven-day telemetry of the source's battles, stay under the
source as finished battles do; a move has no cooldown, so two clients of one account can move a
character back and forth at the rate the check budget allows; a `world_move` row of an identity
that never returns is kept; and `unbind_world_account`, the owner's `drop_world_binding` and a
guest claim free a handle while its identity keeps the character, after which a check from another
identity starts a second character.

What a move carries, deletes and leaves, its refusals, admission, deletion and export, and the
tests: `ARCHITECTURE.md` "server-module: the authority", Private worlds; the measured cost:
`docs/local-play.md`, "One character per account: what a move carries and what it costs".

## The attestation is signed with Ed25519 and checked by `ed25519-dalek` compiled into the module

**Decision.** A world attestation, what the account service's `POST /attest` signs, is signed with
an Ed25519 key, and the module checks the signature with the `ed25519-dalek` crate (3.0.0, no
default features) through `verify_strict`, under the key the build's own `kid`-keyed list names,
never one from the token; `alg` is never read. A token over 4096 bytes is refused before anything is
decoded, and the payload is parsed only after the signature verifies. Replay is keyed on the world's
spent nonce, never on the token's text. The binding the module records from one grants nothing.

**Why.** An ES256 verifier (`p256`) and an Ed25519 one both build for `wasm32-unknown-unknown` with
no clock and no source of randomness, and both cost far less than the 5 ms one check may take
(measured inside one reducer on a 2.11.0 host). Ed25519 costs a fifth as much, the margin a slow
host and a flood of failing tokens use up; `verify_strict` refuses non-canonical signatures and
small-order keys, where ECDSA accepts two forms of every signature; and an Ed25519 key cannot be
loaded as a P-256 login key or the reverse, so attestation and login keys cannot verify each other's
tokens by key type as well as by key list. The cap exists because a check hashes the whole token:
its cost grows with length and a token that fails costs what a valid one costs.

**Rules out.** ES256 for the attestation, though it would keep one algorithm across the account
service. It becomes the choice if the production host's key service cannot hold an Ed25519 key,
since signing keys live there and that host is not chosen; ES256 fits the budget too.
`ed25519-dalek`'s plain `verify`, which accepts signatures `verify_strict` refuses, and its `fast`
feature (a few percent faster, for a larger module). Any crate feature that brings `std`'s clock or
`getrandom` into the module: `p256`'s `precomputed-tables` does through `std`, and the compiler does
not always refuse it, so the built module's import list is the check. Audience-scoped account
tokens, the fallback for a verifier that did not fit.

The checks in order and the payload's rules: `ARCHITECTURE.md` "server-module: the authority",
Private worlds; the measurements and the judge's scores: `docs/local-play.md` §3, "What a signature
check costs inside a reducer".

## An attestation names the server as the player's own software authenticated it

**Decision.** The `aud` of a world attestation is one string, the name under which the player's own
software authenticated the server: `spki:<fingerprint>/<db>` for a server the desktop shell pinned
and for a `local` world, whose fingerprint the party that started it wrote into the shell document;
`dns:<host>:<port>/<db>` for a domain server the platform's certificate checks validated;
`ip:<address>:<port>/<db>` for a server a browser reached by a bare IP address under a publicly
trusted certificate for that address. Any other target has no name, and the client asks for no
attestation for it. The name comes from the party that authenticated the server, never from the
world and never from a page we did not serve. In the shell the main process computes it and calls
the attestation route, refusing every certificate error, and the shell's page is given the
attestation and no login token. For a browser joiner the browser authenticated the server, and the
account service derives the name from the address it sends that browser back to. A world holds its
own names, which its owner writes, and accepts an attestation only when its `aud` equals one of
them, byte for byte. A `dns:` or an `ip:` name is listed only while the server holds an unexpired,
publicly trusted certificate for it; the certificate for an address is issued for the world's own
key, so the shell's pin and `spki:` hold on the same listener. The module's half is built;
everything else is designed and not built.

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
accepting an attestation under its old address's name until its certificate expires (160 hours at
most for an address, the certificate's life for a domain name), and a ticket under a `dns:` name
as long. A ticket under an `ip:` name it refuses once the account service reports the world
another address, or, after a first report, none for 25 hours (see "A private world checks an
account itself: a one-use ticket at first contact, then the account's handle"). A browser
that loaded an earlier server's page at the same address and port may still run what that page
left there. A name issued for the server's key, under a DNS zone we would operate, closes both and
was weighed and not chosen (R-lpw-19-CHANGEDHANDS).

The world's names and the tests: `ARCHITECTURE.md` "server-module: the authority", Private worlds;
the design: `docs/local-play.md` §3, "The access and attestation design", fork (c), and "A browser
binds a friends server it reached by address", fork (g).

## A browser binds a friends server by a sign-in on the account service's own origin; the attestation names the address the browser is sent back to

**Decision.** A page that a friends server's gate serves never signs in and never names the server.
It posts the world's nonce and database, as a top-level navigation, to a bind route on the account
service, which runs its sign-in step on its own origin, issuing no ID token, code or refresh token
and starting no session, then shows the server's address and asks for consent every time. On consent
it derives the attestation's `aud` from the address the bind returns to, `dns:<host>:<port>/<db>` or
`ip:<address>:<port>/<db>`, and redirects the browser to one fixed path at that address with a
one-use code in the fragment; the page redeems the code, with a value it kept, for the attestation,
and binds with it. The route takes only the page's own origin, `https:`, equal to the post's
`Origin` header: a domain under a public suffix, or a globally reachable IP address. Nothing is sent
to the server before the player presses Continue or Cancel, and the address, database and nonce
reach no database, log or backup. A page asks for a bind when the world says it needs one and once a
day otherwise, a default the operator may overrule. Operator ruling,
<https://github.com/mdrewt/monster-realm/issues/833>: a player at a public computer joins a friend's
server from a browser by its address, a static IP address included. Designed, not built.

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

What the page posts, the route's checks, the measurements and the judge's scores:
`docs/local-play.md` §3, "A browser binds a friends server it reached by address", fork (f).

## The official build holds no attestation key and a world build trusts no login issuer

**Decision.** A release build of the module is one of two. The `official` build trusts the
production login issuer, holds no attestation key and names no account service to ask. The `world`
build, which the desktop shell and the standalone server ship, holds the production attestation
keys, names the production account service and trusts no login issuer. The lists and the address are
constants of the build. No production attestation key is published, so a `world` build binds
nothing; and the production service's address is a placeholder under a reserved name that answers
nothing, so a `world` build entitles nobody until a real address ships. On a build with no key the
binding reducers refuse as their first statement, before anything is decoded, read or written (the
unbind and the drop only on a build that also names no account service to ask), and no rule reads a
binding on any build. On a build that names no account service each account-check procedure answers
`this server checks no account` as its first statement and the entitlement check reads no
`world_account` row, so the official build has the login token as its one way in. On the `world`
build every token is an anonymous guest's. The two builds have one schema and one set of client
bindings.

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

Each profile's keys and account service, the binding reducers' refusal, why the dev builds ask the
hosted dev service, and the tests (one runs only under the `official` build): `ARCHITECTURE.md`
"server-module: the authority", Private worlds; the design: `docs/local-play.md` §3, fork (b).

## Private servers carry their own encryption: a real certificate for a domain, a pinned self-signed one otherwise; plaintext only on loopback

**Decision.** The client opens plaintext `ws:` only to a loopback address: a single-player world, or
the desktop shell talking to its own host. Every other server is `wss:`, in one of two ways. A
server with a registered domain serves a certificate a browser trusts: the standalone server obtains
and renews one over ACME when given the domain, or the host puts their own certificate or reverse
proxy in front. A server reached by a bare IP address, public or on a LAN, and a shell world opened
to friends, serves a self-signed certificate made once per world and kept with the world's data and
its backups; a server at a public IP address may instead be given a certificate for that address by
a certificate authority, for the same key. The invite and the shell document carry that
certificate's fingerprint (SHA-256 of its public key), and the desktop shell completes a connection
only to a matching certificate, even one a certificate authority would accept. A plain browser
joining a server under its self-signed certificate loads the client page from the server's gate over
`https:` and accepts the certificate once; there the shell is the recommended way to join, and on a
build that enforces ownership the only one, since a browser has authenticated nothing an attestation
could name. A browser binds a server that shows a publicly trusted certificate, for a domain or for
its address. For a pinned target the client keys its stored reconnect token on the fingerprint and
the database name, not the address. Operator ruling, 2026-11-16,
<https://github.com/mdrewt/monster-realm/issues/821>. Beyond the shell document's `fingerprint`
field none of it is built yet: the resolver takes any `ws:` or `wss:` address, and the transport,
the certificate, the pins, the reconnect key and ACME are open work in the harness's local-play
spec.

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

The design for an address under a public certificate, and how a browser binds such a server:
`docs/local-play.md` §3, "A browser binds a friends server it reached by address", forks (f) and
(g).

## A world that is not open refuses an unadmitted identity at connect and in every reducer; the owner relays the door

**Decision.** While a world's access rule is `Password` or `Allowlist`, the connect reducer refuses,
as its first statement, an identity the rule does not admit, and every reducer of the generated
client roster that is not owner-only makes the admission check, except the unbind, which makes none;
the player's account-check procedure makes it before it sends anything and again before it stores an
answer. A world with no rule row is `Open`. Under `Password` the rule admits the owner and an
identity holding an admission row. Under `Allowlist` it admits the owner; an identity that holds a
`world_account` row exactly while that row's handle is on the host's private list, and nothing else
counts for it, so delisting refuses at the next check; and an identity with no such row only when it
holds an admission row. An attestation binding is not read. The list is read at every check and
nothing is stored from it. Admission rows are written only by the owner's rule change: to each
identity the call names, and, when the rule changes to one that is not `Open`, to each live identity
other than the owner that the rule in force before the call admitted (a live identity that rule
refused gets none unless the call names it). One is deleted with its identity's `world_account` row
by the player's own unbind and the owner's drop, by the deletion cascade and a guest claim (for the
retired guest), and by a character move, for a source the rule was not admitting. The list is the
owner's to edit, at most 256 handles, and is made from the players already let in: a change to
`Allowlist` adds the handle of every `world_account` row whose identity the rule in force admitted,
the owner's own handle stays listed while the rule is `Allowlist`, a write that would take the list
past its bound is refused, and an account's deletion takes off the handle of the deleted identity's
`world_account` row. The module declares no HTTP handler, no HTTP route and no row filter. The
module's half is built; the gate's half (the door endpoint and its password check, closing a removed
identity's sockets) is designed, not built.

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

The admission functions, the owner-only roster, the list's writes and bound, the definition check
and the roster test: `ARCHITECTURE.md` "server-module: the authority", Private worlds; the gate's
design: `docs/local-play.md` §3, fork (a).

## The gate checks a world's password; the module never receives one

**Decision.** No reducer the module declares takes a password, a hash of one or a value derived from
one. The owner-only rule change stores in the access table the rule and nothing else: it has no salt
or hash column. A `Password` world admits the owner and the identities holding an admission row, and
nothing else. The host gate checks the password: it keeps an Argon2id salt and hash in the world's
directory with the owner credential's permissions, never in a backup copy's readable part or a log;
it counts wrong passwords by source address and by identity and refuses both after five in ten
minutes; on the right password it admits the joiner through the owner's rule change, naming the rule
in force. A host with no gate has no password door: its owner admits identities from the command
line. Built: the module's half and a census of every reducer's arguments. Designed, not built: the
gate's check. Operator ruling, 2026-11-22 (monster-realm#840).

**Why.** The host's commit log keeps the arguments of every committed reducer call in the clear
(measured on 2.11.0 and again on 2.16.1 standalone hosts: `docs/local-play.md` §3), so a password given to a reducer,
and every wrong guess counted by a committed call, sits on the host's disk whatever the table
stores; a password stretched before the call is still a password-equivalent there. The operator
named a reader of logs as the attacker. The gate sees the source address, the one count that bounds
guessing when an identity costs nothing, and it holds the owner credential that admits.

**Rules out.** A reducer argument that carries a typed password, its hash or anything derived from
it, under any name; a door reducer of any kind in the module; counting wrong passwords in the
module; reading the stored salt or hash. Accepted limits: a commit log a module with the door wrote
keeps the passwords given to it, and the module cannot erase it; the argument census is a tripwire
for arguments that carry text, and a value derived from a password could ride in an argument of
another type, where review is the defence.

The argument census: `ARCHITECTURE.md` "server-module: the authority", Private worlds; the gate's
design: `docs/local-play.md` §3, fork (a).

## Every player must own the game on Steam, for now

**Decision.** Playing requires owning the game on Steam, in every way to play: the official server,
a friend's server and a single-player world, and in a browser as well as the desktop build. On the
official server every reducer a player plays through admits only a connection whose token, from our
account service, carries the entitlement claim `mr_ent: ["base-game"]`; in a single-player or
friends world it admits only an identity whose `world_account` row says its account owns the game,
as the world's own check of the account stored it. The account service issues the claim only after
Steam's `CheckAppOwnership` reports an owned, permanent licence held by the player themself: a
Family Sharing borrower, a free weekend and a PC café licence do not count, and a refund removes
entitlement at the next issuance (an hour at most on the official server). A build that names the
dev feature `open_join` does not enforce it, so the e2e suite and local development still join
anonymously. Until the operator supplies the Steam app id and publisher key (planned about two
months before early access), entitlement comes from the dev issuers: each dev account carries
`mr_ent` or not as an admin sets it, so the rule and its refusal are built and tested before Steam
is wired in. A dev issuer checks Steam only as App ID 480, Valve's development app: a Steam player
there is entitled by an admin flag on `steam:<steamid64>` that an account lacks until an admin sets
it, and a dev issuer never asks Steam who owns the game and never holds the publisher key (operator,
2026-11-23). Operator ruling, 2026-11-16 ("for now, all players, including browser players, must own
the game in order to play").

**Why.** The operator's ruling. The claim is checked by the module, not implied by the issuer, so
a later free tier or demo changes what the service issues, not the module. The check sits in the
gate every gameplay reducer opens with because some reducers need no `player` row, and because in
a single-player or friends world an identity that joined while entitled must be refused once the
world stores that its account does not own the game (a refund, a ban), which a check made once at
the join never sees. Checking ownership at
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
player refunded after a world checked its account keeps playing there until that world's next
check of the account is answered: a world asks about a player other than its host again only when
the identity next connects, 10 minutes or more after it last asked (see "A private world checks an
account itself: a one-use ticket at first contact, then the account's handle"), so a connection
held open is not asked again,
and from the call after a negative answer is stored every gated reducer refuses the identity. On
the official server a connection that outlives its token keeps playing until it reconnects (see
"Ownership is enforced unless a dev feature switches it off").

The issuer's ownership check, its policy function and the dev profiles' Steam settings:
`docs/account-service.md`.

## Ownership is enforced unless a dev feature switches it off

**Decision.** A build enforces ownership unless it names the dev feature `open_join`, and the build
that names no feature enforces: `default` is empty, and that build trusts no login issuer and holds
no attestation key, so it admits nobody. A site that builds or publishes for anonymous play names
`open_join` itself, and the dev-reducer features imply it. A release feature (`official`, `world`)
wins over a dev feature, so no feature set yields production trust with enforcement off, and a
release feature together with a dev-reducer feature does not compile. The ownership features add or
remove no table, reducer, view or type. A module to ship is made only by the release recipe, which
builds from the release feature alone and refuses an artefact whose recorded profile is not the one
asked for, does not enforce, compiles or names a dev reducer, or trusts anything but one `https:`
login issuer (`official`) or none (`world`).

On an enforcing build the one gate every reducer a player plays through opens with checks ownership
straight after the access rule and before the reducer reads or writes anything else. The caller's
connection must carry a token from one of the build's login issuers, addressed to the module's
audience, whose `mr_ent` claim names `base-game`, or the caller's `world_account` row must say its
account owns the game, however long ago the account service said so; an attestation binding entitles
nobody. Anyone else, an anonymous connection included, gets the one fixed error `ownership
required`, and nothing is written; this holds whether or not the identity has joined. An identity
the access rule does not admit gets the admission refusal first, and nothing of ownership is read.
The gate reads what is stored when the call runs and asks the account service nothing, so an
identity that has joined is refused from the first call that finds it not entitled. The reducers
that ask nothing about ownership are the account's own (deletion, its cancel, the export and the
guest claim's two, which make the access check alone), the unbind, the owner-only ones, the connect
reducer and the account-check procedures.

**Why.** No input's omission ships an open module: `spacetime publish --module-path` and
`spacetime generate` build with the default features unless told otherwise, and what they then
build admits nobody. The only way to an open module is to name a dev feature, which no recipe that
makes a module to ship does. It is the rule dev behaviour already follows (see "Dev-only reducers
never ship"): the dev thing is the opt-in.
The ownership rule is made where the admission rule is, in the one gate, so the roster that proves
every reducer makes the access check proves this one too and a reducer added later cannot leave it
out. The reducers that do not ask are the ones a player who is not entitled must still reach:
deleting or exporting their data is theirs to do whatever the account owns, a guest claim attaches
progress already made to an account and plays nothing, the unbind is how a player leaves a world,
and the owner's reducers run the world, the host's own account check among them.

**Rules out.** A feature that switches enforcement on (the build nobody configured would admit
anyone and trust the dev keys); an environment variable or a row as the switch; conditional
compilation of the constants (a branch no build compiles is a branch nothing checks); making a
module to ship any other way than the recipe; telling builds apart by `spacetime describe --json`,
which reads the same for every one; a `local-dev` attestation key made per machine, as its login key
is (a build's keys are constants computed from its features, and a key that differs per machine
would need a build input the feature set does not have); an ownership call copied into each reducer,
or a list of exempt names read inside the gate (its `reducer` argument is a log label); an ownership
check on the account's deletion, export or claim reducers, on the unbind or on an owner-only
reducer. Accepted cost: every site that builds or publishes for anonymous play names `open_join`,
and one that leaves it out gets a module that refuses every join. Accepted limits: the reducers that
end something a player started (clearing a queue, forfeiting, cancelling a trade or a challenge,
dismissing a dialogue) are gated like the rest. An identity that is not entitled ends what it
started by closing its connection: when its last connection ends, the disconnect reducer resolves
its live trades, battles and challenges and deletes its conversation, character and `player` rows.
Until then what it queued or staked runs on without it (the movement tick, the battle deadlines and
the other side's confirm of a trade session are not calls of that identity), and the module cannot
close a connection. Reading is not gated: a connection that is not entitled subscribes to whatever
an admitted connection reads. A refused call logs one line and nothing limits how many. The host
checks a token's expiry at connect only and the gate does not read `exp`, so a connection that
outlives its token keeps playing until it reconnects.

The features and the profile they compute, the recipes that name `open_join`, the gate's four-way
roster, the claim scanner, the artefact's profile section, the release recipe and the tests:
`ARCHITECTURE.md` "server-module: the authority", Dev and load-test builds and Private worlds.

## The client learns that a server needs an account from its kind or from the first refusal; the menu frame is the sign-in screen

**Decision.** Nothing in the module tells a client whether it enforces ownership before `join_game`
answers, so the connection has two sources. The client tells it up front for an `official` target
whose build names an issuer: the official module always enforces, so an anonymous connection there
sends no `join_game` at all. Toward every other target the first `join_game` the server refuses with
`ownership required` turns the same flag on for the rest of the page, and no later anonymous
connection of that page joins. A refusal is reported apart from the error line, whose text is shown
as it is. While the flag is on, the sign-in begins the OIDC redirect with no claim code (the
connection never joined, and the claim's start refuses a caller with no player row) and leaves a
code already in storage untouched. The screen is the main menu frame in a gate mode: a sign-in row,
and after a refusal the not-owned title and a row that opens the store. Nothing closes it, Escape
included, and it goes down when the own `player` row is in the store. A build with no issuer, and a
`local` or `private` target, show one status line and no sign-in screen; a `local` or `private`
world's own account check uses the same frame's gate mode.

**Why.** A `test` target may be open (the browser suite and the playtests are) or enforcing (a
dev-enforcing build), and its kind does not say which, so only the server's answer can. The
official kind is known to enforce, and probing it would cost one refused reducer and one log line
for every visitor. A new overlay would need an entry in every overlay registry; the menu frame
already has the nav kit's D-pad, A, B and Y, pointer picks and focus handling, and `MenuView`
paints whatever view model it is given. A stored claim code is a guest's only way to move progress
made before the server enforced, so the gate's sign-in never destroys it: the account connection it
returns as meets the claim flow's own join veto.

**Rules out.** A build variable that says the server enforces (see "A target's kind gates telemetry
and account sign-in": the build must not know its server). Treating a `test` target with an issuer
as enforcing, as an `official` one is (a `test` target that names an issuer may be open, as the
browser suite's is). Clearing the stored claim code when the gate's sign-in starts. Lowering the
gate when a connection is merely allowed to try: the refusal arrives after `onReady`, so that hides
the screen the refusal should raise. Reporting the refusal through `onError`. A `test` target still
sends one anonymous `join_game` per page load before its screen shows; removing that needs a public
value from the module, which is a schema change.

The connection's flag and callbacks, the gate's model and screen, and the tests: `ARCHITECTURE.md`
"Client", Connection and store.

## The account service is our own small OIDC issuer; Steam is the only player sign-in

**Decision.** One service in this repository (`account-service/`, TypeScript) built on
`oidc-provider` 9.x (MIT, OpenID Certified) is the one issuer. The official module trusts its login
tokens; a world asks it whether an account owns the game, with the one-use tickets it issues; and it
signs world attestations with a separate Ed25519 key. Players sign in two ways, both giving the
subject `steam:<steamid64>` so a browser and a desktop session are one account: the desktop shell
exchanges a Steam ticket (`GetAuthTicketForWebApi` with the identity `monster-realm-account`,
checked by `AuthenticateUserTicket`) at a custom grant; a browser uses authorization code with PKCE,
where the service's sign-in step is Steam's OpenID 2.0, verified with `check_authentication` and
exact checks of the return address, endpoint, claimed id and a single-use nonce. Both check
ownership before issuing. ID tokens are ES256 and live an hour; browser refresh tokens live 30 days
and rotate, and reusing a rotated one revokes its chain. A separate deployment with its own issuer
name and keys offers email and password for development and QA only, with accounts made by an admin
command and a per-account entitlement flag. Storage is one SQLite file on one instance, opened with
Node's built-in `node:sqlite` (no native SQLite package). In production, signing keys live in the
host's key service through external signing, and discovery and the key set are to be served from a
CDN as well.

Two dev and test issuers run now, each with its own keys: `http://localhost:4455` for development
and tests and `https://auth.monster-realm.spookyowltech.com` (the operator's domain,
`monster-realm`'s own subdomain) for testing from other machines. Test and dev builds of the module
trust both; release builds trust neither. Their Steam steps run as App ID 480. The production
deployment, at a host the operator names then, waits for the Steam app id and publisher key, which
the operator supplies about two months before early access.

**Why.** SpacetimeDB trusts only an OIDC issuer's signed JWTs, and Steam issues none, so a service
of ours must check Steam and sign. A certified provider library carries the protocol (codes, PKCE,
refresh rotation, discovery, keys) so the code we write is only the Steam steps, the ownership rule,
the world tickets and checks, and the attestation. SpacetimeAuth, Clockwork Labs' hosted issuer,
exchanges Steam tickets and reports owned apps, but has no Steam sign-in for a browser, gives its
own user id as the subject (a browser and a desktop session would be two accounts) and has no
per-world attestation; it is also in beta. Better Auth has no official Steam method, and the ticket
grant and attestation would be ours either way. BitCraft, Clockwork Labs' own Steam game on
SpacetimeDB, appears from third-party tooling to sign in through its own API: the same shape, though
unconfirmed.

**Rules out.** SpacetimeAuth or Better Auth as the issuer (revisit SpacetimeAuth if it gains a
browser Steam sign-in and SteamID subjects); a second issuer for players beside this one; the dev password method, a dev issuer or a dev key in a production deployment, and a dev issuer in a release build's trusted list (the service refuses to start; the release recipe's test refuses the build);
refresh tokens for the desktop (it exchanges a fresh ticket); the publisher key anywhere but the
service's secret store, read by one module and never logged.

The routes, grants, profiles, keys, storage and deployment: `docs/account-service.md`.
