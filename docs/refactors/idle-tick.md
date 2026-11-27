# A zone's movement tick runs only while there is work for it

The design record for lpw-26 (harness spec `M-local-play.spec.md`). It decides when a zone's
`movement_tick` runs and where NPC wander goes. None of it is built; section 7 names the slices that
build it. Every number here was measured on SpacetimeDB 2.16.1, the pinned host, on 2026-11-27
(UTC), on the machine and by the method of `docs/local-play.md` §7. Section 8 says how to repeat
the measurements and what was not measured.

**The findings the choice rests on.**

- A transaction that writes no row appends nothing to the commit log and sends nothing to a client.
  In a zone with no NPC, 8,999 `movement_tick` calls in 30 minutes grew the log by 0 bytes.
- The 1.24 MiB an hour an idle player costs (`docs/local-play.md` §4; 1.256 on 2.16.1) is the rows
  of the one NPC that wanders, written twice for each step it takes.
- What an empty tick does cost is reducer time: 45 µs each, and 0.14 % of one hardware thread for a
  zone with a player standing still in it.
- A one-shot schedule row costs more than an interval row. The host deletes a one-shot row in a
  transaction of its own after every run, and the next row has to be inserted, so a tick that was
  free becomes two logged transactions.

**The choice.** D: a zone holds its movement interval row only while it has work, and NPC wander
has an interval row of its own at the wander cadence, writing each step once. A is the design the
spec put forward, a one-shot row per tick, and it is not chosen: it doubles an idle player's
commit log in a zone with an NPC, adds 82 bytes to every tick of a walk, and a tick whose
transaction fails stops the zone until a player presses a key again.

## 1. What the tick does today, and what a transaction costs

`movement_tick` (`server-module/src/movement.rs`) is called by an interval row in
`movement_tick_schedule`, one per zone, every `STEP_MS` (200 ms). `arm_zone_tick` inserts the row
when a player's character enters the zone. The tick that finds no player's character in the zone
sends its NPCs home and deletes the row (`docs/DECISIONS.md`, "An empty zone does no work; no
state depends on a tick having run"). While a player is in the zone, every tick:

1. for each character with a `move_intent` row, drains one queued input through
   `game_core::apply_move` and writes the `character` row with the new tile, the remaining queue
   and the accepted sequence number; or, with nothing to drain, publishes the queue and the
   sequence number if they changed and sets `action` back to `Idle` if a step left it `Walking`
   (`publish_standing`);
2. skips the drain for a character whose player is in an ongoing battle, leaving its queue as it is;
3. resolves a warp when the drained step ends on a warp tile, and arms the tick of the zone the
   character arrives in;
4. rolls a wild encounter when the drained step ends on tall grass, and starts the battle;
5. on one tick in five for each NPC (`npc_step_due`), takes one wander step for it through
   `npc_decide`, unless the NPC is in a live conversation; the next tick sets the NPC's `action`
   back to `Idle`.

Only step 1's drain, step 5 and the settling to `Idle` write a row. A tick in which nobody has
queued input and no NPC is due writes none.

**What the commit log holds for one transaction.** The log was read record by record
(`replicas/1/clog/*.stdb.log`). A record is 26 bytes of framing, one flags byte, and, for a
reducer call, an inputs record of 4 bytes plus the reducer's name, the caller's 32-byte identity,
a 16-byte connection id, an 8-byte timestamp and the arguments. Rows follow.

| Transaction | Bytes in the commit log |
| --- | --- |
| Any reducer call that writes no row (`movement_tick`, `mr_heartbeat`, a reducer of the probe module in section 2) | 0: no record is written |
| `movement_tick`, framing and inputs before any row | 122 |
| `movement_tick` that writes one `character` row (an NPC's step, or settling one character to `Idle`) | 227 |
| `movement_tick` that drains one step: the `character` row and the `move_intent` row | 279 |
| `movement_tick` that drains one step and writes an NPC's row | 371 |
| `enqueue_move`: the `move_intent` row | 165 |
| An insert into `movement_tick_schedule` with an id the module chose, added to a transaction | 26 |
| The same insert with an id taken from the table's sequence (`id: 0`), which also rewrites the sequence's system row | 282 |
| The host's delete of a one-shot schedule row after its reducer ran, a transaction of its own | 56 (34 when the delete empties the table) |
| `movement_tick` whose only write is deleting its own interval row | 129 |

A transaction with no row also sends nothing: the host's `spacetime_num_bytes_sent_to_clients_total`
did not move over the 30-minute window of 8,999 empty ticks (section 3, "today", no NPC, standing
still). Its cost is the reducer call: 44.7 µs inside the module per empty tick
(`reducer_wasm_time_usec`), and a host that used 0.823 % of one hardware thread with those ticks
against 0.682 % without them (the same condition under D).

**What the host's scheduler does**, read from `crates/core/src/host/scheduler.rs` at `v2.16.1` and
seen in the runs below:

- An interval row first fires one interval after it is inserted (`schedule`, lines 211 to 242).
  Later ticks are anchored to the times the row asked for, so lateness does not accumulate
  (`delete_scheduled_function_row` and `next_interval_reschedule`, lines 796 to 821). The 0.1 ms
  a tick that `docs/send-pipeline-depth.md` shows on 2.11.0 (a 200.1 ms median) is gone: the
  median is 200.0.
- After a scheduled reducer returns, the host deletes a one-shot row in a new transaction, whether
  the reducer committed or failed (`call_scheduled_reducer_with_tx`, lines 743 to 789, the delete
  at line 778). An interval row is left in place and queued again (line 884).
- The reducer's own deletion of the row that called it is honoured: nothing is queued for a row
  that is gone (`delete_scheduled_function_row_with_tx`, lines 854 to 864).

## 2. The alternatives

Each alternative is a prototype of the module on a branch that is not merged. The branches start
at `26e1e085`, and every measured module is the branch's commit built with the `load_test_zones`
feature (`cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features
load_test_zones`).

| Name | What it does | Branch and commit | Module sha256 |
| --- | --- | --- | --- |
| Today | The interval row lives while a player's character is in the zone. | `master` at `26e1e085` | `6080b532…10d03b` |
| A, one-shot | The row is a one-shot at a multiple of `STEP_MS` on the server clock. Every writer of a `move_intent` row arms it. A tick arms the next one for the next tick when a character has work, else for the tick an NPC's next step comes due on, else not at all. | `proto/lpw-26-a-oneshot` at `38cae902` | `6534873e…24d13a` |
| B, slow interval | The interval row stays. A tick that finds no player-side work in a zone with no NPC that wanders replaces it with a row of five steps; a `move_intent` write puts the one-step row back. | `proto/lpw-26-b-slow-interval` at `05b9f63f` | `57ec98e8…156f28` |
| C, smaller writes | The interval row stays as it is today. An NPC's step is written once, at rest (`action` `Idle` on the new tile), so no later tick settles it. | `proto/lpw-26-c-smaller-writes` at `43c1d276` | `9cec0b8f…19d155` |
| D, interval while there is work | The zone holds an interval row only while it has work. A `move_intent` write to a zone with no row arms a one-shot at the next multiple of `STEP_MS`; that tick inserts the interval row; an interval tick deletes its own row once the zone has no work and no player's character has been touched for five steps. NPC wander has its own interval row and reducer, at the wander cadence, and writes each step at rest. | `proto/lpw-26-d-work-interval` at `49f9d2b1` | `ffdc1df7…6bc805` |

"Work" is the same in A, B and D: a character whose row still shows a step (`action` is not
`Idle`), a private queue or sequence number the row does not publish yet, or an undrained input
that can drain. A queue held by a battle is not work. A, B and D all arm from every writer of a
`move_intent` row (`enqueue_move`, `set_move`, `clear_queue`, and `drop_queued_moves` at a battle
start), which costs each intent write a read of the caller's `character` row for its zone and a
scan of the schedule table.

**C's and D's NPC write.** The client already draws a remote whose row says `Idle` on a tile it
has not reached as walking (`client/src/render/renderResolver.ts`, the remote arm), because the
server writes `Idle` between the steps of a walk today. `renderResolver.test.ts` pins it for a
wandering NPC ("two same-direction steps 1000 ms apart (an NPC wandering) …", np-a.7). So a step
written at rest is drawn as the same slide and the same walking frames, and the row that settles it
is not needed.

**NPC wander derived from the clock** was not prototyped. It writes no row at all, so on the server
its numbers are those of the zone with no NPC below. It is not chosen: the client would have to
compute every NPC's tile from a server clock it does not estimate today, through a wasm export of
the wander rule; an NPC held by a conversation is no longer a function of the clock alone; and
every reader of an NPC's tile (talk range, the conversation's liveness) would derive it too. An
NPC's position between two players' visits is ambient state, which the decision record already
resets instead of replaying. D's wander costs 0.634 MiB an hour for a player beside the one NPC
that wanders (section 3). If that is ever worth removing, this is the change that removes it.

**A variant of D without the one-shot** was measured for step timing only (the same commit built
with `LPW26_NO_KICK` set, sha256 `369aea5a…ecf046`): the intent write inserts the interval row itself.
Section 4 gives what it changes.

**An event table does not fit.** A one-file probe module built with `spacetimedb` 2.16.1 holds an
event table (`#[spacetimedb::table(accessor = step_event, public, event)]`), a stored table of the
same columns and a reducer for each. On the pinned host:

| Question | Measured |
| --- | --- |
| Is an event row sent to a subscriber? | Yes: a subscriber of `SELECT * FROM step_event` received each insert, and no delete. |
| Is it stored? | No: `SELECT * FROM step_event` over `/sql` returned no row afterwards. |
| What does a client that subscribes later receive? | Nothing for the event table; the stored table's current row. |
| What does the insert cost in the commit log? | 132 bytes, against 133 for the same row inserted into the stored table and 154 for an update of it. |

So an event row saves no disk: the insert is logged like any other. And it cannot carry position: a
client that subscribes or reconnects mid-walk would be sent nothing until the walker's next step.
The wire-contract check also refuses bindings that declare an event table until a slice gives it a
rule (`client/src/net/wireContract.ts`).

## 3. Transactions and commit log an hour (lpw-26.1)

Thirty cells: today and the four alternatives; a zone with NPCs (zone 0, where `elder_oak`
wanders) and one without (load zone 10000); one player standing still, one walking and eight
walking. Each cell is one run on a host of its own, with a 30-minute window after a 60-second wait.

- **Tick calls** are `movement_tick` plus, under D, `npc_wander_tick`
  (`spacetime_reducer_plus_query_duration_sec_count`).
- **Transactions** are every committed transaction, the reducers' and the host's own
  (`spacetime_num_txns_total{committed="true"}`, types `Reducer` and `Internal`). The host's own
  are the one-shot deletes of A and D. The heartbeat is 60 an hour of every cell.
- **Log records** are the transactions that wrote to the commit log, counted in the log.
- **Commit log** is the growth of `replicas/1/clog` in apparent size over the window, §7's
  measure.

MATRIX_TABLE

A walking player is `mr_load_driver` sending one intent every 200 ms, as in §4. Its walk is 16
intents east and 16 west along row 1. Zone 0's row 1 is eight tiles wide, so 9 of every 16 intents
there walk into a wall, where the tick drains them and no step follows; the load zone's is
fourteen wide, so 3 of every 16 do. An intent that bumps costs the log what a step costs.

**What the table says.**

MATRIX_NOTES

## 4. Step timing, the row that ends a walk, a reconnect, and what arming adds (lpw-26.2)

The probes are scripted clients on the host's WebSocket protocol, on hosts pinned as in section 3.
The walker sends as the game client does: one `Step` in flight, the next sent up to one 60 Hz
frame (0 to 16.7 ms) after the row that acknowledges the one before. A second client subscribes to
the zone and stamps every row it is sent. Today and the alternatives ran at the same time, each on
its own host.

**Step timing.** An interval is the time between two consecutive position changes of the walker
as the watcher receives them. A late step is one 1.5 × `STEP_MS` or more after the step before,
the measure `docs/send-pipeline-depth.md` uses. Walks start from rest, 1.2 to 1.4 seconds apart, so
under D every walk opens with the one-shot.

TIMING_TABLE

TIMING_NOTES

**The row that ends a walk** is the same-tile `Idle` row the tick writes when it finds the walker
with nothing queued. The watcher's time from the walker's last step to that row:

STOP_TABLE

**A press from rest.** One `Face` sent to a zone at rest, 150 times, 1.3 to 1.7 seconds apart: the
time from the send to the row that acknowledges it.

PRESS_TABLE

PRESS_NOTES

**A client that connects or reconnects mid-walk** is sent the same rows under D as today. One
12-step walk in the load zone, with a second watcher subscribing a second into it, and then the
walker's own socket dropped with its seventh input in flight:

| What | Today | D |
| --- | --- | --- |
| The late watcher's initial rows | the walker's row as stored: tile 6, `Walking`, sequence 5 | the same row |
| Its next row | the step to tile 7, 57 ms later | the step to tile 7, 62 ms later |
| The first watcher, when the walker's socket drops | the delete of the walker's row, 5 ms after the drop | the delete, 8 ms after |
| The input in flight | discarded with the `move_intent` row; the character is saved on tile 7, the last step drained | the same |
| The walker, connecting again 300 ms later and joining | its own row on tile 7, `Idle`, empty queue, sequence 0 | the same row |
| The schedule table | the zone's interval row deleted by the next tick, which finds the zone empty, 193 ms after the drop; a row again when the walker joins | the interval row deleted by the next tick, 193 ms after the drop; no row when the walker joins; the one-shot at its first input |

**What arming adds to a walking player's rows.** One 12-step walk from rest in the load zone, every
record of the commit log:

| | Today | D | A |
| --- | --- | --- | --- |
| First `enqueue_move` | 509 | 535: the one-shot row's insert, 26 | 535: the one-shot row's insert, 26 |
| The tick that drains the first step | 279 | 305: the interval row's insert, 26 | 305: the next one-shot's insert, 26 |
| The host's delete of the one-shot row | none | 56, once | 56 after each of the 12 ticks that drain, 34 after the last |
| Each later `enqueue_move` | 165 | 165 | 165 |
| Each later tick that drains a step | 279 | 279 | 305 |
| The tick that settles the walker to `Idle` | 227 | 227 | 227 |
| The tick that deletes the interval row, one second after the last step | none | 129 | none |
| The whole walk | 5,899 | 6,136 | 6,943 |

The first `enqueue_move` of a session is 509 bytes because it also writes the party's first
quality-time rows. Under D a walk costs 237 bytes more than today, once, however long it is: two
inserts of 26, the host's delete of 56, and 129 for the tick that deletes the interval row, which
today is an empty tick. A second walk that starts within a second of the first adds nothing: the
interval row is still there. Under A every tick of the walk carries 82 more.

Arming also adds reads to every intent write: the caller's `character` row, for its zone, and a
scan of the schedule table. `enqueue_move` took 123.4 µs inside the module under D against 111.4
today (8,791 calls each, one player walking in the zone without NPCs).

**A tick whose transaction fails.** A fault build of each module makes every `movement_tick` panic
for 500 ms on request. Two 12-step walks in the load zone: the fault set as the first input of
walk one is sent, and again as the sixth input of walk two is sent. The walker presses again when
an input has had no answer for 1.5 seconds.

| | Today | D | A |
| --- | --- | --- | --- |
| Fault at a walk's first input: the send to its acknowledging row | 594 ms | 1,698 ms: the input stood unanswered until the next press | 1,602 ms: the same |
| The schedule table after the failed tick | the interval row, still there | empty at the next reading, 118 ms after the one-shot row was first seen: the host had deleted it, and the interval row's insert was rolled back | empty |
| Fault mid-walk: the send to its acknowledging row | 568 ms | 568 ms | 1,569 ms: the walk stood until the next press |
| The watcher's longest gap between two steps of the faulted walk | 601 ms | 601 ms | 1,600 ms |

An interval row outlives a failed tick and its next tick runs, so today's walk and D's resume as
soon as the fault ends. A one-shot row does not: the host deletes it whether or not the reducer
committed, and what the reducer armed is rolled back with it. Under A every tick is a one-shot.
Under D only the first tick of a burst of work is, and the next `move_intent` write arms another.
The queue is not lost in either: both inputs drained in order once a tick ran.

**Publishing over a live database.** Today's module was published, a player joined and stood in
zone 0 (one interval row, id 1), and the prototype was published over it without deleting data.
The player's connection stayed open through the publish.

| | D | A |
| --- | --- | --- |
| The interval row the database held | deleted by its own first tick under the new module, within 0.3 s: the zone had no work | deleted by its own first tick, which armed a one-shot for the NPC's next step |
| NPC wander | stopped until the owner's `sync_content` call armed the zone's wander row; two wander ticks in the 2.5 s after it | carried on |

## 5. Scores

SCORES

## 6. The chosen design: D (lpw-26.3)

DESIGN

## 7. The slices that build it

SLICES

## 8. How to repeat, and what was not measured

REPEAT
