# Should a zone's movement tick run only while there is work for it?

The design record for lpw-26 (harness spec `M-local-play.spec.md`). It decides what becomes of the
ticks a zone runs with nothing to do, and of NPC wander. None of it is built; section 7 names the
slices that build it. Every number measured here is from SpacetimeDB 2.16.1, the pinned host, on
2026-11-27 (UTC), on the machine and by the method of `docs/local-play.md` §7. Section 8 says how
to repeat the measurements and what was not measured.

**The findings the choice rests on.**

- A transaction that writes no row appends nothing to the commit log and sends nothing to a client.
  In a zone with no NPC, 8,999 `movement_tick` calls in 30 minutes grew the log by 0 bytes.
- The 1.24 MiB an hour an idle player costs (`docs/local-play.md` §4; 1.26 on 2.16.1) is the rows
  of the one NPC that wanders, written twice for each step it takes.
- What an empty tick does cost is processor time: 0.14 % of one hardware thread for a zone with a
  player standing still in it, of which the module's own 45 µs a tick is 0.02 %.
- A one-shot schedule row costs more than an interval row. The host deletes a one-shot row in a
  transaction of its own after every run, and the next row has to be inserted, so a tick that was
  free becomes two logged transactions.

**The choice.** C: the interval row stays as it is, and an NPC's step is written once, at rest. It
halves what an idle player costs the commit log beside the NPC (1.26 to 0.62 MiB an hour) and what
that player's client is sent, and changes no schedule row, no player path and nothing about how a
failed tick recovers. A judge scored it 87 of 100, today 81, D 69, B 60
and A 43 (section 5).

C leaves the empty ticks running. The operator asked for them gone for disk, bandwidth and
reducer-thread reasons. On 2.16.1 they cost no disk and no bandwidth, and 0.14 % of one hardware
thread for each zone with a player at rest. D removes them: a zone holds its movement interval row
only while it has work, and NPC wander has an interval row of its own. It costs a table, a
reducer, a row lifecycle that later changes must keep right, and one failure today cannot have.
Section 6 designs D duty by duty, so it can be built on the operator's word; whether 0.14 % of a
thread is worth that is the operator's to say (section 6.5). A, the design the spec put forward,
loses under either answer: a one-shot row per tick raises an idle player's commit log beside an
NPC from 1.26 to 1.84 MiB an hour, adds 82 bytes to every tick of a walk, and a tick whose
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

Only a drain (with the warp or the battle it sets off), step 5 and the settling to `Idle` write a
row. A tick in which nobody has queued input and no NPC is due writes none.

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
still). Its cost is processor time: a host that used 0.823 % of one hardware thread with those
ticks against 0.682 % without them (the same condition under D, in the same batch). The module's
own time is 44.7 µs per empty tick (`reducer_wasm_time_usec`), 0.02 % of a thread at five a
second; the rest is the host's scheduling and transaction work.

**What the host's scheduler does**, read from `crates/core/src/host/scheduler.rs` at `v2.16.1` and
seen in the runs below:

- An interval row first fires one interval after it is inserted (`schedule`, lines 211 to 242).
  Later ticks are anchored to the times the row asked for, so lateness does not accumulate
  (`delete_scheduled_function_row` and `next_interval_reschedule`, lines 796 to 821).
- After a scheduled reducer returns, the host deletes a one-shot row in a new transaction, whether
  the reducer committed or failed (`call_scheduled_reducer_with_tx`, lines 743 to 789, the delete
  at lines 778 to 780). An interval row is left in place and queued again (line 884).
- The reducer's own deletion of the row that called it is honoured: nothing is queued for a row
  that is gone (`delete_scheduled_function_row_with_tx`, lines 854 to 864).
- A tick the host is more than an interval late for is skipped, not run twice
  (`next_interval_tick_after`, lines 825 to 846).
- When the host starts it queues every schedule row it finds: an interval row for one interval
  from then, a one-shot whose time has passed at once (`SchedulerStarter::start`, lines 90 to
  143). This was read, not run.

## 2. The alternatives

Each alternative is a prototype of the module on a branch that is not merged. The branches start
at `26e1e085`, and every measured module is the branch's commit built with the `load_test_zones`
feature (`cargo build -p monster-realm-module --release --target wasm32-unknown-unknown --features
load_test_zones`).

| Name | What it does | Branch and commit | Module sha256 |
| --- | --- | --- | --- |
| Today | The interval row lives while a player's character is in the zone. | `master` at `26e1e085` | `6080b532…10d03b` |
| A, one-shot | The row is a one-shot at a multiple of `STEP_MS` on the server clock. Every writer of a `move_intent` row arms it. A tick arms the next one for the next tick when a character has work, else for the tick an NPC's next step comes due on (its own copy of `npc_step_due`'s arithmetic), else not at all. | `proto/lpw-26-a-oneshot` at `38cae902` | `6534873e…24d13a` |
| B, slow interval | The interval row stays. A tick that finds no player-side work in a zone with no NPC that wanders replaces it with a row of five steps; a `move_intent` write puts the one-step row back. | `proto/lpw-26-b-slow-interval` at `05b9f63f` | `57ec98e8…156f28` |
| C, smaller writes | The interval row stays as it is today. An NPC's step is written once, at rest (`action` `Idle` on the new tile), so no later tick settles it. | `proto/lpw-26-c-smaller-writes` at `43c1d276` | `9cec0b8f…19d155` |
| D, interval while there is work | The zone holds an interval row only while it has work. A `move_intent` write to a zone with no row arms a one-shot at the next multiple of `STEP_MS` (the opening one-shot); that tick inserts the interval row; an interval tick deletes its own row once the zone has no work and no player's character has been touched for five steps (a second of rest). A burst of work is the time from an opening one-shot to that deletion. NPC wander has its own interval row and reducer, at the wander cadence, one beat a second: `npc_step_due` is not asked, every NPC of the zone steps on every beat, and each step is written at rest. The paths that put a character into a zone arm the wander row and not the movement row, the tick does not ask whether a player is in its zone, and it deletes its row when the zone's map fails to load. | `proto/lpw-26-d-work-interval` at `49f9d2b1` | `ffdc1df7…6bc805` |

"Work" is the same in A and D: a character whose row still shows a step (`action` is not
`Idle`), a private queue or sequence number the row does not publish yet, or an undrained input
that can drain. A queue held by a battle is not work. B's also counts any NPC that wanders, so a
zone with one is never quiescent. A, B and D all arm from every writer of a
`move_intent` row (`enqueue_move`, `set_move`, `clear_queue`, and `drop_queued_moves` at a battle
start), which costs each intent write a read of the caller's `character` row for its zone and a
scan of the schedule table.

**C's and D's NPC write.** The client already draws a remote whose row says `Idle` on a tile it
has not reached as walking. It does so because the server writes a same-tile `Idle` row between
two steps of a walk whenever the walker's next input reaches it after the tick, which a real round
trip brings about and the probes here, on loopback, never did (section 4). Section 6.1 gives what
a client is sent, what no test covers yet and what reduced motion draws.

**NPC wander derived from the clock** was not prototyped. It writes no row at all, so on the server
its numbers are those of the zone with no NPC below. It is not chosen: the client would have to
compute every NPC's tile from a server clock it does not estimate today, through a wasm export of
the wander rule; an NPC held by a conversation is not a function of the clock alone; and
every reader of an NPC's tile (talk range, the conversation's liveness) would derive it too. An
NPC's position between two players' visits is ambient state, which the decision record already
resets instead of replaying. Under C wander costs 0.62 MiB an hour for a player beside the one
NPC that wanders (section 3). If that is ever worth removing, this is the change that removes it.

**D without the one-shot (D′)** was measured for step timing and the press wait only (the same
commit built with `LPW26_NO_KICK` set, sha256 `369aea5a…ecf046`): the intent write inserts the
interval row itself. Its cells in section 3 would be D's: none of D's six windows holds a one-shot
delete, so within them the two write the same records.

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
  are A's one-shot deletes and 6 an hour in every cell; no window of D holds a one-shot delete.
  The heartbeat adds about 60 an hour to every cell.
- **Log records** are the transactions that wrote to the commit log, counted in the log.
- **Commit log** is the growth of `replicas/1/clog` in apparent size over the window, §7's
  measure.

| Alternative | Zone | Condition | Window, s | Tick calls an hour | Transactions an hour | Log records an hour | Commit log, bytes | MiB an hour | Sent to clients, MiB an hour | Host CPU, % of one thread |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Today | with NPCs | standing | 1800 | 17,998 | 18,062 | 5,800 | 658,300 | 1.256 | 0.50 | 0.90 |
| A | with NPCs | standing | 1800 | 6,480 | 13,026 | 12,968 | 964,644 | 1.840 | 0.49 | 0.97 |
| B | with NPCs | standing | 1800 | 17,998 | 18,062 | 5,676 | 644,226 | 1.229 | 0.49 | 0.88 |
| C | with NPCs | standing | 1800 | 18,000 | 18,066 | 2,882 | 327,107 | 0.624 | 0.25 | 0.98 |
| D | with NPCs | standing | 1800 | 3,598 | 3,662 | 2,904 | 332,508 | 0.634 | 0.25 | 0.75 |
| Today | with NPCs | one walking | 1800 | 17,998 | 35,648 | 35,414 | 4,316,811 | 8.234 | 3.68 | 1.50 |
| A | with NPCs | one walking | 1800 | 17,826 | 53,278 | 53,212 | 5,207,841 | 9.933 | 3.67 | 1.80 |
| B | with NPCs | one walking | 1800 | 17,998 | 35,648 | 35,394 | 4,309,264 | 8.219 | 3.67 | 1.45 |
| C | with NPCs | one walking | 1800 | 17,998 | 35,626 | 35,372 | 4,179,803 | 7.972 | 3.43 | 1.62 |
| D | with NPCs | one walking | 1800 | 21,598 | 39,246 | 38,244 | 4,377,808 | 8.350 | 3.43 | 1.56 |
| Today | with NPCs | eight walking | 1800 | 17,998 | 158,720 | 158,670 | 23,643,987 | 45.097 | 118.92 | 3.85 |
| A | with NPCs | eight walking | 1800 | 18,002 | 176,540 | 176,498 | 24,402,074 | 46.543 | 118.78 | 4.19 |
| B | with NPCs | eight walking | 1800 | 17,998 | 158,726 | 158,682 | 23,639,424 | 45.089 | 118.88 | 3.70 |
| C | with NPCs | eight walking | 1800 | 17,998 | 158,732 | 158,686 | 23,509,669 | 44.841 | 116.93 | 3.71 |
| D | with NPCs | eight walking | 1800 | 21,598 | 162,106 | 161,312 | 23,678,152 | 45.162 | 116.85 | 4.17 |
| Today | without | standing | 1800 | 17,998 | 18,064 | 0 | 0 | 0.000 | 0.00 | 0.82 |
| A | without | standing | 1800 | 0 | 66 | 0 | 0 | 0.000 | 0.00 | 0.78 |
| B | without | standing | 1800 | 3,600 | 3,664 | 0 | 0 | 0.000 | 0.00 | 0.69 |
| C | without | standing | 1800 | 18,000 | 18,066 | 0 | 0 | 0.000 | 0.00 | 0.79 |
| D | without | standing | 1800 | 0 | 64 | 0 | 0 | 0.000 | 0.00 | 0.68 |
| Today | without | one walking | 1800 | 17,998 | 35,644 | 35,560 | 4,069,841 | 7.763 | 3.52 | 1.51 |
| A | without | one walking | 1800 | 17,948 | 53,518 | 53,454 | 4,783,404 | 9.124 | 3.52 | 1.77 |
| B | without | one walking | 1800 | 17,556 | 35,176 | 35,114 | 4,356,706 | 8.310 | 3.44 | 1.43 |
| C | without | one walking | 1800 | 17,998 | 35,646 | 35,568 | 4,070,815 | 7.764 | 3.52 | 1.41 |
| D | without | one walking | 1800 | 18,000 | 35,646 | 35,560 | 4,070,328 | 7.764 | 3.52 | 1.49 |
| Today | without | eight walking | 1800 | 17,998 | 158,724 | 158,674 | 23,456,392 | 44.740 | 127.13 | 3.94 |
| A | without | eight walking | 1800 | 18,000 | 176,536 | 176,476 | 24,172,949 | 46.106 | 127.10 | 4.22 |
| B | without | eight walking | 1800 | 17,998 | 158,732 | 158,688 | 23,454,187 | 44.735 | 127.09 | 3.65 |
| C | without | eight walking | 1800 | 17,998 | 158,730 | 158,686 | 23,456,823 | 44.740 | 127.14 | 3.65 |
| D | without | eight walking | 1800 | 18,000 | 158,534 | 158,476 | 23,434,775 | 44.698 | 127.09 | 4.15 |

A walking player is `mr_load_driver` sending one intent every 200 ms, as in §4. Its walk is 16
intents east and 16 west along row 1. Zone 0's row 1 is eight tiles wide, so 9 of every 16 intents
there walk into a wall, where the tick drains them and no step follows; the load zone's is
fourteen wide, so 3 of every 16 do. An intent that bumps costs the log what a step costs.

**What the table says.**

- **Today on 2.16.1 is today on 2.11.0.** With NPCs the three conditions grow the log by 1.256,
  8.234 and 45.097 MiB an hour, against §4's 1.24, 8.21 and 44.99.
- **An empty tick is free in the log.** A player standing in the zone without NPCs runs 17,998
  ticks an hour today, and the log holds no record and grows by no byte. The 1.256 MiB with NPCs
  is 5,800 records an hour of 227 bytes: the one NPC's 2,900 steps, each written twice.
- **D** runs no tick for a player standing in the zone without NPCs; its 64 transactions an hour
  are the heartbeat and the host's own. With NPCs it runs the 3,598 wander beats, 2,904 of which
  write, and the log grows by 0.634 MiB an hour, half of today's; the bytes sent to the client
  halve with it. Walking costs what it costs today: 7.764 against 7.763 for one walker without
  NPCs, 44.698 against 44.740 for eight. With NPCs one walker costs 8.350 against 8.234, 1.4 %
  more, because an NPC's step is a transaction of its own (229 bytes) where today it rides a tick
  that is already draining a step (92 bytes, twice).
- **A** runs no tick for a player standing without NPCs either. Everywhere else it costs more
  than today: 1.840 MiB an hour standing with NPCs (46 % more, from 12,968 records where today
  has 5,800), 9.933 and 9.124 for one walker (21 % and 18 % more) and 3 % more for eight. One
  walker's transactions rise from 35,648 to 53,278 an hour.
- **B** is today wherever an NPC wanders. Without NPCs a standing player still runs 3,600 ticks
  an hour, which cost no log. Its one-walker cell without NPCs, 8.310, is above today's because
  the prototype swapped between its two rows 1,097 times in the window (the driver's walk leaves
  the zone without work for a tick whenever an input that bumped is followed by a late one). Each
  swap is 308 bytes: 282 for an insert that takes its id from the sequence and 26 for the delete.
  With ids the module chose a swap would be two writes of 26 by section 1's figures, and the cell
  about 7.77; that is derived, not measured.
- **C** halves the standing cost with NPCs (0.624) and takes 3 % off one walker's there (7.972).
  It changes nothing without NPCs and runs every tick today runs.
- **Processor time.** The host with a player standing without NPCs used 0.82 % of one thread
  today and 0.68 % under D, in the same batch: the 17,998 empty ticks an hour cost about 0.14 % of
  a thread. B and C in a batch of their own agree: 0.69 % at 3,600 ticks an hour against 0.79 % at
  18,000. Processor time compares within a batch only (section 8 lists the batches): cells of
  different batches that run the same ticks differ by up to 0.3 %.

## 4. Step timing, the row that ends a walk, a reconnect, and what arming adds (lpw-26.2)

The probes are scripted clients on the host's WebSocket protocol, on hosts pinned as in section 3.
The walker sends as the game client does: one `Step` in flight, the next sent up to one 60 Hz
frame (0 to 16.7 ms) after the row that acknowledges the one before. A second client subscribes to
the zone and stamps every row it is sent. Today ran beside each alternative, at the same time, on
a host of its own. `docs/send-pipeline-depth.md` measured the game client in a browser on 2.11.0 (a
median of 200.1 ms, 202.2 at the 90th percentile, a largest interval of 227); scripted clients on
2.16.1 cannot be set beside that, so today is measured again here and each alternative is compared
with it.

**Step timing.** An interval is the time between two consecutive position changes of the walker
as the watcher receives them. A late step is one 1.5 × `STEP_MS` or more after the step before,
the measure `docs/send-pipeline-depth.md` uses. Walks start from rest, 1.2 to 1.4 seconds apart, so
under D every walk opens with the one-shot.

| Zone | Alternative | Walks | Intervals | Smallest | Median | p90 | p99 | Largest | Standard deviation | Late steps | `Idle` rows between two steps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| without NPCs | Today, runs 1 to 4 | 160 | 1760 | 194.0 | 200.0 | 200.6 | 201.2 | 206.3 | 0.57 | 0 | 0 |
| without NPCs | D, runs 1 to 4 | 160 | 1760 | 197.2 | 200.1 | 201.0 | 202.4 | 205.3 | 0.70 | 0 | 0 |
| without NPCs | Today, runs 5 to 8 | 160 | 1760 | 198.7 | 200.0 | 200.6 | 201.2 | 202.8 | 0.48 | 0 | 0 |
| without NPCs | C, runs 5 to 8 | 160 | 1760 | 198.2 | 200.0 | 200.6 | 201.2 | 202.5 | 0.49 | 0 | 0 |
| with NPCs | Today, runs 1 to 4 | 120 | 720 | 192.4 | 200.0 | 200.6 | 201.7 | 207.6 | 0.66 | 0 | 0 |
| with NPCs | D, runs 1 to 4 | 120 | 720 | 196.7 | 200.1 | 201.5 | 202.2 | 203.4 | 0.78 | 0 | 0 |
| with NPCs | Today, runs 5 to 8 | 120 | 720 | 198.5 | 200.0 | 200.6 | 201.2 | 202.2 | 0.47 | 0 | 0 |
| with NPCs | C, runs 5 to 8 | 120 | 720 | 198.8 | 200.0 | 200.6 | 201.0 | 202.2 | 0.45 | 0 | 0 |

Runs 1 to 4 pair today with D, and runs 5 to 8 pair today with C: the two of a pair ran at the
same time, each on its own host. Run 1 shared the machine with a compile (a one-minute load
average of 6.6 at its end); runs 2 to 4 ran together, as did runs 5 to 8, with a load average
under 1. Run by run:

| Run | Zone | Alternative | Intervals | Median | p90 | Largest | Late steps |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | without NPCs | Today | 440 | 200.0 | 200.6 | 206.3 | 0 |
| 1 | without NPCs | D | 440 | 200.1 | 201.1 | 205.3 | 0 |
| 1 | with NPCs | Today | 180 | 200.0 | 200.7 | 207.6 | 0 |
| 1 | with NPCs | D | 180 | 200.1 | 201.7 | 202.7 | 0 |
| 2 | without NPCs | Today | 440 | 200.0 | 200.6 | 201.5 | 0 |
| 2 | without NPCs | D | 440 | 200.1 | 201.0 | 202.7 | 0 |
| 2 | with NPCs | Today | 180 | 200.0 | 200.5 | 201.8 | 0 |
| 2 | with NPCs | D | 180 | 200.1 | 201.4 | 202.6 | 0 |
| 3 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.9 | 0 |
| 3 | without NPCs | D | 440 | 200.1 | 201.0 | 203.0 | 0 |
| 3 | with NPCs | Today | 180 | 199.9 | 200.6 | 202.7 | 0 |
| 3 | with NPCs | D | 180 | 200.1 | 201.3 | 203.4 | 0 |
| 4 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.6 | 0 |
| 4 | without NPCs | D | 440 | 200.1 | 200.9 | 202.6 | 0 |
| 4 | with NPCs | Today | 180 | 200.0 | 200.7 | 202.5 | 0 |
| 4 | with NPCs | D | 180 | 200.1 | 201.6 | 202.6 | 0 |
| 5 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.6 | 0 |
| 5 | without NPCs | C | 440 | 200.0 | 200.6 | 202.3 | 0 |
| 5 | with NPCs | Today | 180 | 200.0 | 200.6 | 202.2 | 0 |
| 5 | with NPCs | C | 180 | 199.9 | 200.7 | 201.2 | 0 |
| 6 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.6 | 0 |
| 6 | without NPCs | C | 440 | 200.0 | 200.6 | 202.3 | 0 |
| 6 | with NPCs | Today | 180 | 200.0 | 200.7 | 201.7 | 0 |
| 6 | with NPCs | C | 180 | 200.0 | 200.6 | 202.2 | 0 |
| 7 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.8 | 0 |
| 7 | without NPCs | C | 440 | 200.0 | 200.6 | 202.5 | 0 |
| 7 | with NPCs | Today | 180 | 200.0 | 200.6 | 201.2 | 0 |
| 7 | with NPCs | C | 180 | 200.0 | 200.7 | 201.2 | 0 |
| 8 | without NPCs | Today | 440 | 200.0 | 200.6 | 202.0 | 0 |
| 8 | without NPCs | C | 440 | 200.0 | 200.6 | 202.5 | 0 |
| 8 | with NPCs | Today | 180 | 200.0 | 200.6 | 201.6 | 0 |
| 8 | with NPCs | C | 180 | 200.0 | 200.6 | 202.1 | 0 |

A and D without the one-shot ran once, with run 1, and are set beside that run alone:

| Zone | Alternative | Walks | Intervals | Smallest | Median | p90 | p99 | Largest | Standard deviation | Late steps | `Idle` rows between two steps |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| without NPCs | Today | 40 | 440 | 194.0 | 200.0 | 200.6 | 201.9 | 206.3 | 0.77 | 0 | 0 |
| without NPCs | D | 40 | 440 | 197.2 | 200.1 | 201.1 | 202.8 | 205.3 | 0.81 | 0 | 0 |
| without NPCs | D without the one-shot | 40 | 440 | 195.1 | 200.0 | 200.7 | 202.2 | 208.8 | 0.76 | 0 | 0 |
| without NPCs | A | 40 | 440 | 194.4 | 200.0 | 200.7 | 202.5 | 204.3 | 0.74 | 0 | 0 |
| with NPCs | Today | 30 | 180 | 192.4 | 200.0 | 200.7 | 202.6 | 207.6 | 1.01 | 0 | 0 |
| with NPCs | D | 30 | 180 | 197.3 | 200.1 | 201.7 | 202.3 | 202.7 | 0.87 | 0 | 0 |
| with NPCs | D without the one-shot | 30 | 180 | 194.5 | 200.0 | 200.7 | 202.2 | 205.4 | 0.90 | 0 | 0 |
| with NPCs | A | 30 | 180 | 190.3 | 200.0 | 200.6 | 203.1 | 209.0 | 1.18 | 0 | 0 |

The first interval of each walk, apart from the rest:

| Zone | Alternative | First interval of a walk: number, median, largest | Every later interval: number, median, largest, standard deviation |
| --- | --- | --- | --- |
| without NPCs | Today, runs 1 to 4 | 160, 200.0, 201.1 | 1600, 200.0, 206.3, 0.58 |
| without NPCs | D, runs 1 to 4 | 160, 201.7, 205.3 | 1600, 200.0, 203.0, 0.47 |
| without NPCs | Today, runs 5 to 8 | 160, 200.1, 201.0 | 1600, 200.0, 202.8, 0.48 |
| without NPCs | C, runs 5 to 8 | 160, 200.1, 201.1 | 1600, 200.0, 202.5, 0.50 |
| without NPCs | D without the one-shot, run 1 | 40, 200.2, 201.2 | 400, 200.0, 208.8, 0.77 |
| without NPCs | A, run 1 | 40, 200.0, 201.0 | 400, 200.0, 204.3, 0.76 |
| with NPCs | Today, runs 1 to 4 | 120, 200.0, 202.7 | 600, 200.0, 207.6, 0.67 |
| with NPCs | D, runs 1 to 4 | 120, 201.6, 202.6 | 600, 200.0, 203.4, 0.55 |
| with NPCs | Today, runs 5 to 8 | 120, 200.1, 201.2 | 600, 200.0, 202.2, 0.47 |
| with NPCs | C, runs 5 to 8 | 120, 200.0, 201.0 | 600, 200.0, 202.2, 0.45 |
| with NPCs | D without the one-shot, run 1 | 30, 199.8, 201.5 | 150, 200.0, 205.4, 0.95 |
| with NPCs | A, run 1 | 30, 200.0, 200.7 | 150, 200.0, 209.0, 1.28 |

- **C's step timing is today's.** In the four paired runs the two medians and 90th percentiles
  are equal (200.0 and 200.6 ms in both zones), the 99th is equal or lower (201.2 and 201.2; 201.0
  against 201.2), the largest interval is no larger (202.5 against 202.8; 202.2 and 202.2), and
  the standard deviations are 0.49 against 0.48 and 0.45 against 0.47. Without NPCs C is the
  wider by 0.01 ms of standard deviation and 0.2 ms of span (198.2 to 202.5 against 198.7 to
  202.8). Today's own two sets of runs differ by more than that: 0.57 against 0.48 of standard
  deviation, and a largest interval of 206.3 against 202.8. C changes no line a player's step runs
  through, and its timing is inside the spread of today's own runs.
- **No alternative that was timed adds a late step** or puts an `Idle` row between two steps of a
  walk: A, C, D and D without the one-shot. B was not timed. By the scheduler, its one-step row
  first fires a step after the intent write that puts it back, so a press in a quiet zone without
  NPCs would wait a whole step, as it does under D without the one-shot.
- **Under D every interval after a walk's first is the host's interval**, with a standard
  deviation of 0.47 and 0.55 ms against today's 0.58 and 0.67 in the same runs.
- **Under D the first interval of a walk from rest is 1.7 and 1.6 ms longer than a step** (201.7
  and 201.6 ms at the median, 205.3 at most). The interval row is anchored when the opening tick
  runs, so its first tick carries that tick's lateness and its own, where two ticks of one row
  cancel theirs. It happens once per burst of work and does not accumulate.
- So D's distribution is wider than today's by that one interval: its 90th percentile is 0.4 and
  0.9 ms higher, its 99th 1.2 and 0.5, and its standard deviation 0.13 and 0.12. Its extremes over
  runs 1 to 4 are inside today's, but today's are run 1's, the loaded run: in runs 2 to 4 D's
  largest interval is 0.0 to 1.2 ms above today's. A frame is 16.7 ms and remote interpolation
  draws 100 to 500 ms in the past, so nothing drawn can show 1.7 ms.
- **D without the one-shot and A** have no such interval: their first intervals are 200.2 and
  199.8 ms at the median for the first, 200.0 and 200.0 for A.

**The row that ends a walk** is the same-tile `Idle` row the tick writes when it finds the walker
with nothing queued. The watcher's time from the walker's last step to that row:

| Zone | Alternative | Walks | Median | p90 | Largest |
| --- | --- | --- | --- | --- | --- |
| without NPCs | Today, runs 1 to 4 | 160 | 200.0 | 200.6 | 202.4 |
| without NPCs | D, runs 1 to 4 | 160 | 200.0 | 200.5 | 201.1 |
| without NPCs | Today, runs 5 to 8 | 160 | 199.9 | 200.6 | 202.3 |
| without NPCs | C, runs 5 to 8 | 160 | 200.0 | 200.7 | 201.6 |
| without NPCs | D without the one-shot, run 1 | 40 | 199.8 | 200.6 | 201.0 |
| without NPCs | A, run 1 | 40 | 199.8 | 200.6 | 200.8 |
| with NPCs | Today, runs 1 to 4 | 120 | 199.9 | 200.5 | 201.2 |
| with NPCs | D, runs 1 to 4 | 120 | 200.0 | 200.5 | 201.1 |
| with NPCs | Today, runs 5 to 8 | 120 | 199.9 | 200.6 | 201.8 |
| with NPCs | C, runs 5 to 8 | 120 | 200.0 | 200.5 | 201.8 |
| with NPCs | D without the one-shot, run 1 | 30 | 200.1 | 200.7 | 203.3 |
| with NPCs | A, run 1 | 30 | 200.1 | 200.6 | 201.8 |

Under C the row arrives 200.0 ms after the last step at the median in both zones, 0.1 ms after
today's 199.9 in the same runs, and never later than 201.8 against today's 202.3. Today's own two
sets of runs differ by the same 0.1 ms (200.0 and 199.9 without NPCs).

**A press from rest.** One `Face` sent to a zone at rest, 150 times a run, 1.3 to 1.7 seconds
apart: the time from the send to the row that acknowledges it.

| Alternative | Presses | Smallest | p10 | Median | Mean | p90 | Largest | Presses by 25 ms of wait, 0 to 200 and over |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Today, runs 1 to 4 | 600 | 2.2 | 31.0 | 94.7 | 103.3 | 187.5 | 201.6 | 51, 97, 92, 75, 28, 78, 91, 83, 5 |
| D, runs 1 to 4 | 600 | 2.3 | 32.2 | 95.4 | 104.2 | 188.2 | 202.2 | 46, 99, 89, 79, 29, 81, 85, 82, 10 |
| Today, runs 5 to 8 | 600 | 1.1 | 30.4 | 92.4 | 102.3 | 185.3 | 200.7 | 54, 95, 93, 76, 28, 79, 88, 84, 3 |
| C, runs 5 to 8 | 600 | 1.4 | 30.6 | 93.7 | 102.6 | 184.9 | 202.0 | 53, 96, 88, 80, 29, 75, 88, 88, 3 |
| D without the one-shot, run 1 | 150 | 201.7 | 202.2 | 202.8 | 202.9 | 203.6 | 207.0 | 0, 0, 0, 0, 0, 0, 0, 0, 150 |
| A, run 1 | 150 | 7.4 | 32.4 | 96.6 | 105.5 | 188.3 | 202.2 | 11, 24, 23, 19, 7, 20, 21, 22, 3 |

Today the wait is anywhere in a step, because the tick's phase is unrelated to the press. C keeps
that, since its tick is today's. D with the opening one-shot keeps it too: its one-shot fires at
the next multiple of `STEP_MS`. Without the one-shot the wait is one whole step every time the
zone was at rest, and still anywhere in a step when the zone's row is there (another player
walking, or a press within a second of the last), so how a press answers would depend on who else
is moving. That is why the one-shot is the default if D is built (section 6.5).

**A client that connects or reconnects mid-walk** is sent the same rows under C and under D as
today. One
12-step walk in the load zone, with a second watcher subscribing a second into it, and then the
walker's own socket dropped with its seventh input in flight:

| What | Today | C | D |
| --- | --- | --- | --- |
| The late watcher's initial rows | the walker's row as stored: tile 6, `Walking`, sequence 5 | the same row | the same row |
| Its next row | the step to tile 7, 57 ms later | the step to tile 7, 59 ms later | the step to tile 7, 62 ms later |
| The first watcher, when the walker's socket drops | the delete of the walker's row, 5 ms after the drop | the delete, 6 ms after | the delete, 8 ms after |
| The input in flight | discarded with the `move_intent` row; the character is saved on tile 7, the last step drained | the same | the same |
| The walker, connecting again 300 ms later and joining | its own row on tile 7, `Idle`, empty queue, sequence 0 | the same row | the same row |
| The schedule table, read every 0.1 s | the zone's interval row gone at the reading 193 ms after the drop: its next tick found the zone empty; a row again when the walker joins | as today, gone at the reading 211 ms after | the interval row gone at the reading 193 ms after the drop; no row when the walker joins; the one-shot at its first input |

**What arming adds to a walking player's rows.** C arms nothing: no intake reducer touches a
schedule row, and its walk is today's record for record. For the designs that arm, one 12-step
walk from rest in the load zone, every record of the commit log:

| Record, as a count times its bytes | Today | D | A |
| --- | --- | --- | --- |
| The first `enqueue_move`; under D and A it also inserts the one-shot row, 26 bytes | 1 × 509 | 1 × 535 | 1 × 535 |
| Each later `enqueue_move` | 11 × 165 | 11 × 165 | 11 × 165 |
| The tick that drains the first step; under D it also inserts the interval row and under A the next one-shot row, 26 bytes | 1 × 279 | 1 × 305 | 1 × 305 |
| Each later tick that drains a step; under A it also inserts the next one-shot row | 11 × 279 | 11 × 279 | 11 × 305 |
| The tick that settles the walker to `Idle` | 1 × 227 | 1 × 227 | 1 × 227 |
| The host's delete of a one-shot row | 0 | 1 × 56 | 12 × 56 and 1 × 34 |
| The tick that deletes the interval row, a second after the last step | 0 | 1 × 129 | 0 |
| The whole walk | 5,899 | 6,136 | 6,943 |

The first `enqueue_move` of this walk is 509 bytes because it also accrues the party's quality time,
which a move does once per cooldown and which writes the monster's rows. Under D a walk costs 237
bytes more than today, once, however long it is: two inserts of 26, the host's delete of 56, and 129
for the tick that deletes the interval row, which today is an empty tick. A second walk that starts
within a second of the first adds nothing: the interval row is still there. Under A every tick of
the walk carries 82 more.

Arming also adds reads to every intent write: the caller's `character` row, for its zone, and a
scan of the schedule table. `enqueue_move` took 123.4 µs inside the module under D against 111.4
today (8,791 calls each, one player walking in the zone without NPCs).

**A tick whose transaction fails.** A fault build of each module makes every `movement_tick` panic
for 500 ms on request. Two 12-step walks in the load zone: the fault set as the first input of
walk one is sent, and again as the sixth input of walk two is sent. The walker presses again when
an input has had no answer for 1.5 seconds.

| | Today | D | A |
| --- | --- | --- | --- |
| Fault at a walk's first input: the send to its acknowledging row | 594 ms | 1,698 ms: the input stood unanswered until the probe pressed again | 1,602 ms: the same |
| The schedule table after the failed tick | the interval row, still there | empty at the next reading, 118 ms after the one-shot row was first seen: the host had deleted it, and the interval row's insert was rolled back | empty |
| Fault mid-walk: the send to its acknowledging row | 568 ms | 568 ms | 1,569 ms: the walk stood until the next press |
| The watcher's longest gap between two steps of the faulted walk | 601 ms | 601 ms | 1,600 ms |

An interval row outlives a failed tick and its next tick runs, so today's walk and D's resume as
soon as the fault ends. A one-shot row does not: the host deletes it whether or not the reducer
committed, and what the reducer armed is rolled back with it. Under A every tick is a one-shot.
Under D only the first tick of a burst of work is, and the next `move_intent` write arms another.
The queue is not lost in either: both inputs drained in order once a tick ran. The 1.5 seconds are
the probe's. The game client does not send again by itself: a held key continues only when no sent
input is still owed (`docs/DECISIONS.md`, "Held keys"), so a held walk stays stopped until the
player lets go and presses again. C's tick and row are today's, so it recovers as today does.

**Publishing over a live database.** Today's module was published, a player joined and stood in
zone 0 (one interval row, id 1), and the prototype was published over it without deleting data.
The player's connection stayed open through the publish.

C needs nothing here: its rows are today's, and an NPC a publish catches `Walking` is settled by
the tick's own branch.

| | D | A |
| --- | --- | --- |
| The interval row the database held | deleted by its own first tick under the new module, within 0.3 s: the zone had no work | deleted by its own first tick, which armed a one-shot for the NPC's next step |
| NPC wander | stopped until the owner's `sync_content` call armed the zone's wander row; two wander ticks in the 2.5 s after it | carried on |

## 5. Scores

A `judge` scored six alternatives: today, A, B, C, D, and D without the opening one-shot (D′). It
was given sections 1 to 4 without the choice above and without sections 6 and 7; it also saw one
line of a draft of the decision entry, which favoured D. It scored C untimed; C's timing is in
section 4, inside the spread of today's own runs. The rubric was set before
scoring. Six criteria, 100 points:

1. (20) The smoothness contract holds as recorded: step timing, the row that ends a walk, the wait
   from a press to its tick, what a client that connects or reconnects mid-walk is sent, and the
   "Held keys" rules behaving as today. An alternative that adds a late step, an `Idle` row
   between two steps of a walk, or a later walk-ending row scores 0 here and cannot win.
2. (20) Commit log an hour across the six conditions, the single-player ones counting most.
3. (15) Reducer-thread time and bandwidth.
4. (20) How it fails and recovers: a tick whose transaction fails, a write that forgets to arm, a
   publish over a live database, the last player leaving, a host restart.
5. (15) What it changes and adds: schema, wire, anything a player could see or feel, new rows,
   reducers, states and rules that later changes must keep.
6. (10) Fit with the recorded decisions it touches and with rules being written once, in game-core.

Ties are broken by criterion 1, then 4. The effort of editing tests, baselines or file lists was
not scored.

| Criterion | Today | A | B | C | D | D′ |
| --- | --- | --- | --- | --- | --- | --- |
| 1. The smoothness contract | 20 | 17 | 10 | 20 | 18 | 13 |
| 2. Commit log an hour | 12 | 4 | 11 | 18 | 16 | 17 |
| 3. Reducer thread and bandwidth | 4 | 5 | 7 | 7 | 14 | 14 |
| 4. How it fails and recovers | 20 | 5 | 17 | 20 | 11 | 14 |
| 5. What it changes and adds | 15 | 8 | 8 | 13 | 5 | 6 |
| 6. Fit with decisions and game-core | 10 | 4 | 7 | 9 | 5 | 5 |
| Total | 81 | 43 | 60 | 87 | 69 | 69 |

The judge's reasons:

- **C (87, first).** A change of a few lines that halves the standing log beside the NPC (0.62
  against 1.26) and the bytes sent, takes 3 % off one walker's there, and leaves player paths,
  schedule rows and failure behaviour as they are. It removes none of the empty ticks, which is
  all it loses to D (criterion 3). Its one visible change, an NPC's step arriving as `Idle`,
  shows only under reduced motion.
- **Today (81).** An empty tick costs nothing on disk or on the wire, and recovery from a failed
  tick is the best there is. Its commit log is the NPC written twice, and it spends the reducer
  thread on empty ticks.
- **D (69).** It removes the empty ticks, and its standing log is as good as C's. It loses on how
  it fails (a failed opening one-shot strands the input, which the game client never sends again
  by itself), on what it adds (a table, a reducer, the rest rule, the one-shot), and on the
  wander cadence leaving game-core's `npc_step_due`.
- **D′ (69).** D's numbers less 82 bytes a burst, and no one-shot to fail. Every press from rest
  waits a whole step (202.8 ms against 94.7 at the median), which is what it loses to D on
  criterion 1; the tie goes to D on that criterion.
- **B (60).** Today wherever an NPC wanders. Elsewhere it still ticks 3,600 times an hour and its
  row swaps cost more log than they save. It was not timed; by the scheduler a press in a quiet
  zone waits a whole step, as under D′.
- **A (43).** More commit log in every cell but one, half as many transactions again for a
  walker, and every tick a one-shot that a failure strands.

**What would overturn the result.**

- The operator rules that the empty ticks must go, as a requirement and not a weighed cost. C, B
  and today are then out and D wins on the tie-break. The judge names one change worth measuring
  first: the intent write also inserts the interval row, which the opening tick replaces, so a
  failed opening tick is followed by an interval tick one step after the input (section 6.3).
- The operator accepts a whole step's wait for a press from rest. D′ then passes D.
- The operator refuses an NPC's step arriving as `Idle` because of what reduced motion then
  draws. C cannot ship and today stands.

The judge also checked sections 1 to 4 against the raw cells, the prototype diffs and the
scheduler's source. The sections above state the facts as it found them, on these matters:

- which alternatives were timed: C is, B is not;
- the 200.1 ms median of `docs/send-pipeline-depth.md`, measured in a browser, which these probes
  cannot be compared with;
- what covers a step that arrives as `Idle`, and what reduced motion draws for it;
- what the prototypes of A, B and D change beyond a one-line description;
- the host's own 6 transactions an hour in every cell;
- the bytes of B's row swap, and its cost with module-chosen ids being derived;
- whose 1.5 seconds a stranded input waited, and that the game client never sends again by itself;
- A and D′ having run once, under load;
- how much of an empty tick's cost is the module's own time.

## 6. The chosen design: C, and D if the empty ticks are to go (lpw-26.3)

### 6.1 C: the wander step is written once

One rule changes. Today the wander step writes the NPC's row as `apply_move` returns it, `Walking`
on the new tile, and the next tick writes it again as `Idle`. Under C the step is written at rest,
`Idle` on the new tile, through one game-core rule that the tick calls, and the tick after it finds
nothing to settle. The interval row, the tick's cadence, `npc_step_due`, every player path and
every schedule row stay as they are.

What a client is sent changes with it. A watcher of zone 0 was sent 38 rows for the NPC in 25
seconds today, 19 steps as `Walking` and 19 same-tile rows as `Idle`; under C it was sent 20, each a
step as `Idle`. The client's remote arm draws a row that says `Idle` on a tile the remote has not
reached as walking (`client/src/render/renderResolver.ts`), as it must for a player whose next input
reaches the server after the tick, so the slide and its walking frames are drawn as today. Two
things follow for zt-1:

- No test feeds the client a step that arrives as `Idle`: `renderResolver.test.ts` (np-a.7) feeds
  `Walking` steps followed by a same-tile `Idle` row. zt-1 adds that test.
- Under reduced motion a remote is drawn on its row's tile at once, with the row's `action`. An
  NPC's step is then drawn without the walking frame it shows for the 200 ms before today's
  settling row. That is a change a player who has asked for reduced motion can see.

### 6.2 Everything the interval tick does today, and how it is done

| The tick's duty today | Under C, the choice | Under D, if the empty ticks are to go |
| --- | --- | --- |
| **Draining one input per character per tick** | As today. | Unchanged, in `movement_tick`. An accepted input has a tick within one `STEP_MS`: the opening one-shot when the zone held no row, else the interval row's next tick. Within a zone no character drains twice within `STEP_MS`: ticks of one row are a step apart, the interval row's first tick is a step after the one-shot's, and a new one-shot is armed only when the interval row is gone, which is a second after the last input was applied. Across a warp the one-shot's second bound holds the pace: the step after a warp into a zone with no row is never less than a full step after the warp, as today. A character that warps into a zone already ticking drains on that zone's next tick, whatever its phase, as today. |
| **NPC wander** | On the tick, as today: one tick in five for each NPC, through `npc_step_due` and `npc_decide`. The step is written at rest through one game-core rule, so the tick after it writes no row for the NPC. | `npc_wander_tick`, once a second per zone, on the wander row. Each NPC of the zone that is not held by a conversation takes its `npc_decide` step. The cadence is the row's interval, so `npc_step_due` and its per-NPC phase go: the NPCs of one zone step on the same beat, in one transaction. The step is written at rest, through one game-core rule, so the row is written once per step. |
| **Releasing an NPC from a conversation that ended** | As today. | The wander beat computes which conversations are live exactly as the tick does (`conversation_is_live`: the owner in the zone and within talk range), and skips those NPCs. An NPC whose conversation ended steps on the next beat, within a second, as today. No row is written to release it. |
| **The drain lock while a battle holds a queue** | As today: the lock releases itself on the tick after the battle ends. | The tick still skips the drain and leaves the queue as it is. What changes: the lock does not release itself when the battle ends. A held queue is not work, so the tick publishes it once and the interval row goes a second after the last input was applied, and nothing arms a tick at the battle's end. A held input would drain on the first tick after the battle, which the owner's next intent write arms, ahead of that write's input. No input is held today: both places that insert a `battle` row empty each battler's queue with `drop_queued_moves` as their last step, and the intake reducers refuse input during a battle. zt-2 pins that with a test over every `battle` insert. |
| **The grass trigger** | As today. | Unchanged: it runs in the tick that drains the step onto tall grass. The battle it starts empties the walker's queue through `drop_queued_moves`, an intent write; the tick is running, so the zone holds a row, and the tick's own check at its end sees the unpublished queue and keeps the interval row for the tick that publishes it. |
| **Warps** | As today: the warp arms the tick of the zone the character arrives in. | Unchanged: resolved in the tick that drains the step onto the warp tile. The character arrives `Idle` with its queue cleared and published in that write, so the zone it arrives in has no work and gets no movement row; `arm_zone_wander` arms its wander row. The zone it left keeps its rows for as long as it has work or a player. |
| **Publishing the standing row and settling it to `Idle`** | As today for a player's character. An NPC's row is written at rest and is not settled after a step. | Unchanged code (`publish_standing`), and a tick always runs when one is owed: every intent write arms a tick, so an accepted input is published within one `STEP_MS` as today; and a drained step leaves the row `Walking`, which is work, so the next interval tick drains the next input or writes `Idle`. The row that ends a walk reaches a watcher 200.0 ms after the last step, as it does today (section 4). |
| **The disarm when the last player leaves** | As today: the tick that finds no player's character deletes its row. | Each interval row is removed by its own tick, as today, never by the paths that remove a character. The movement interval row goes at its next tick: a zone with no player's character has no work and nothing to wait a second for (193 ms after a disconnect, section 4). The wander row goes at its next beat, within a second. A zone with no NPC that wanders and no work holds no row at all. |
| **The NPC reset when the last player leaves** | As today, in that same tick. | The wander beat that finds no player's character sends the zone's NPCs home before it deletes its row: within a second of the last player leaving, where today it is within a step. `ensure_zone_schedules` also sends home the NPCs of every zone with no player's character, so a zone that lost its player while it had no wander row (the time between a publish and `sync_content`) is back in its authored state after `sync_content`. |
| **Recovery after a tick whose transaction failed** | As today: the interval row outlives the failure and its next tick runs (594 and 568 ms, section 4). | Interval ticks and wander beats recover as today: the row outlives the failure and its next tick runs (a 500 ms fault mid-walk cost the same 568 ms as today, section 4). The opening one-shot does not: the host deletes it whether or not the tick committed, and the interval row it inserted is rolled back, so the zone has work and no row until the next `move_intent` write arms another one-shot (measured: the input stood unanswered until the next press, then both drained in order). `ensure_zone_schedules` arms a one-shot for every zone with a player in it, so `sync_content` also restarts it. Nothing is lost while it waits. |
| **Converting the interval rows a live database holds at publish** | Nothing is converted: the rows are today's. An NPC the publish catches `Walking` is settled by the tick's own branch. | Nothing is converted. The row a database holds is an interval row of the same shape with a small id; under the new module its own next tick finds its zone without work and deletes it (measured: gone within 0.3 s of the publish, the player still connected). A zone a player was already standing in gets its wander row from `sync_content`, which every recipe that publishes over kept data calls, from the next character to enter it, or from the first intent write in it; until then its NPCs stand still. |
| **Arming at `init` and `sync_content`** | As today. | `ensure_zone_schedules` still removes the rows of zones that are gone, in both tables. For each zone with a player's character it arms the movement one-shot and the wander row. |
| **A zone whose map fails to load** | As today. | Today the tick logs the error and returns, five times a second while a player is in the zone. Under D the tick logs it, inserts no interval row and deletes its own, so the error is logged once for each intent write. |
| **A session that pre-dates `move_intent`** | As today. | The tick's two seeding branches stay. Such a character has no intent row, so it is not work; its first input seeds the row in `authorize_move`, which arms the tick. |

### 6.3 D: the rows

**`movement_tick_schedule`** keeps its columns. A zone holds a row only while it has work:

- **The opening one-shot.** One arming function inserts a `ScheduleAt::Time` row when the zone
  holds no row of either kind. Its time is the next multiple of `STEP_MS` on the server clock, or
  one `STEP_MS` after the writer's character was last touched (`move_started_at_ms`) when that is
  later. The function reads the character's row for its zone and that stamp, and it also arms the
  zone's wander row when that is missing.
- **Who arms.** Every write that can leave a `move_intent` row's queue or sequence number
  different from what the `character` row publishes goes through that function: `enqueue_move`,
  `set_move`, `clear_queue` and `drop_queued_moves`. The other writers cannot: `join_game` inserts
  a row equal to what it publishes, `authorize_move`'s seeding is followed by its caller's write,
  the load build's placement publishes in the same write, and a disconnect or an erasure deletes
  the row.
- **The interval row.** The tick a one-shot calls inserts a `ScheduleAt::Interval(STEP_MS)` row
  when the zone has none. The host deletes the one-shot row itself after that call. A tick whose
  zone's map does not load logs the error, inserts no interval row and deletes its own if it has
  one.
- **Its removal.** An interval tick deletes its own row when the zone has no work and no player's
  character in it has been touched for five steps (`move_started_at_ms`, which `apply_move` stamps
  on every drained input). An input that follows another within a second therefore rides the row
  that is there, and a zone nobody is in loses its row at the next tick.
- **Ids.** Both rows carry an id the module chooses, above 2^40 and derived from the zone, so no
  insert takes a value from the table's sequence (282 bytes each time it does, section 1) and no
  id meets one a live database's sequence handed out.

**`npc_wander_schedule`** is a new private scheduled table of the same three columns, calling a
new scheduler-only reducer `npc_wander_tick`. A zone holds one interval row, of
`NPC_STEP_TICKS` × `STEP_MS` (one second), while a player's character is in it and it has an NPC
whose `wander_radius` is above zero. Every path that puts a player's character into a zone arms it
(`join_game`, the tick's warp arm, the load build's placement, and `ensure_zone_schedules` at
`init` and `sync_content`). The beat that finds no player's character in the zone sends its NPCs
home and deletes the row.

**What work is** is one pure function of a character's row, its intent row and whether a battle
holds it: the row's `action` is not `Idle`; or the row's queue or sequence number differs from the
intent row's; or the intent row's queue is not empty and no battle holds it. A zone has work when
any character in it does.

**One change the judge names for D, not measured.** The intent write that finds no row inserts
the interval row as well as the one-shot, and the opening tick replaces that interval row with
one anchored at its own time. If the opening tick fails, its replacement is rolled back and the
row the intent write inserted fires one step after the input, so the zone does not wait for
another press. It costs one more insert of 26 bytes per burst. It is not part of D as sections
6.2 and 6.3 describe it; zt-2 measures it and takes it if it does what is said here.

### 6.4 What stays as recorded under either

- Movement intent stays private, and `movement_tick` stays the only writer of
  `character.move_queue` and `character.acked_seq`. Arming writes the schedule table and no public
  row.
- An empty zone still does no work, and no state depends on a tick having run: the wander counter
  is still the server clock, and whether a zone's interval row is there is derived from rows
  (`action`, the two queues, `move_started_at_ms`), never counted.
- The client's code does not change. Under C prediction, the held-key rules and remote
  interpolation read the same rows at the same times, and an NPC's step arrives as one row where
  it was two. Under D an NPC's step also arrives on its zone's beat, where today each NPC has a
  phase of its own.

### 6.5 What is the operator's to decide

Each has a default, which this record takes; the operator may overrule any of them
(monster-realm#888).

1. **Whether the empty ticks go at all.** Default: no; build C and stop. The operator's three
   reasons were disk, bandwidth and the reducer thread. An empty tick costs no disk and no
   bandwidth on 2.16.1. It costs 0.14 % of one hardware thread for each zone with a player at
   rest, of which 0.02 % is the module's own time. D takes that back and costs what section 5
   lists. The cost grows with zones that hold a resting player, not with players, so the answer
   may change when the world has many zones.
2. **An NPC's step under reduced motion** (C, section 6.1). Default: accept it.
3. **If D is built, its opening one-shot.** Default: keep it. It keeps the wait from a press at
   rest to its tick what it is today, anywhere from 0 to 200 ms, at the price of the 1.7 ms on a
   walk's first interval and of the failed opening tick. Without it that wait is one `STEP_MS`
   every time the zone was at rest (202.8 ms measured) and anywhere in a step when the zone's row
   is there, so how a press answers would depend on who else is moving; no row is ever a one-shot;
   and a burst costs 82 bytes less. By the client's send rule a held key sends its next step only
   after the row that answers the press, so a hold of under about 200 ms from rest would move one
   tile where it usually moves two today (the hold table of `docs/send-pipeline-depth.md`); that
   was not run. The change the judge names (section 6.3) would keep the one-shot and take away its
   failed tick; it is not measured.
4. **If D is built, its second of rest and its single beat.** A shorter rest saves up to four
   empty ticks per stop, which cost no commit log; a longer one keeps more presses off the
   one-shot. Only zone 0 has an NPC that wanders, and it has one; a second in the same zone would
   step in time with it, and a per-NPC phase needs one wander row per phase.

## 7. The slices that build it

The harness spec carries them as notes of lpw-26. Each is a behaviour change built test-first.
File lists were read at `26e1e085` and are read again when a slice is sectioned.

1. **zt-1: an NPC's step is written once, at rest (C).** After lpw-26. No schema change, no new
   row, no new reducer.
   - A game-core rule returns an NPC's step at rest, and the wander block of `movement_tick` writes
     what it returns. The rule goes below line 61 of `game-core/src/npc/rules.rs`, which
     `.cargo/mutants.toml` pins by line.
   - Touches: `game-core/src/npc/rules.rs` and its `rules_tests.rs`,
     `server-module/src/movement.rs` and its `movement_tests.rs`,
     `client/src/render/renderResolver.test.ts`, `docs/DECISIONS.md`, this file, and
     `docs/local-play.md` §4, §6 and §7, whose idle-player rows it measures again.
   - Holds: a wander step writes the NPC's row once, `Idle` on the new tile, and no later tick
     writes it to settle it; the tick's settling branch for a character with no intent row stays
     (a session that pre-dates `move_intent`, and an NPC a publish catches `Walking`); the client
     draws a step that arrives as `Idle` as a walk until the NPC is on its tile; an idle player
     beside the NPC costs 0.62 MiB of commit log an hour where it costs 1.26, by the method of
     `docs/local-play.md` §7; and that document's §4 does not say that each tick commits a
     transaction of about 72 bytes.
2. **zt-2: the empty ticks go (D).** After zt-1, and only on the operator's answer to question 1
   of section 6.5.
   - Adds the private scheduled table `npc_wander_schedule` and the scheduler-only reducer
     `npc_wander_tick`: an additive schema change. Regenerated bindings gain the row's type and
     nothing else (7 lines of `client/src/module_bindings/types.ts`, measured on the prototype), so
     `PROTOCOL_VERSION` rises by one with its `wireContract.json` entry and `MIN_CLIENT_PROTOCOL`
     stays.
   - The wander block and its conversation check move out of `movement_tick` into the beat;
     `npc_step_due` goes and the wander period is a game-core constant. One function arms, by the
     rules of section 6.3, and a census test fails a write that can leave a queue or sequence
     number unpublished without going through it. The tick inserts the interval row when a
     one-shot called it and deletes its own row by the rule of section 6.3. The entry paths arm
     the wander row and not the movement row. `ensure_zone_schedules` arms the rows of
     every zone with a player and sends home the NPCs of every zone without one. Rows carry
     module-chosen ids.
   - Touches: `game-core/src/npc/rules.rs`, `server-module/src/movement.rs`,
     `server-module/src/lib.rs`, `server-module/src/schema.rs` (the data-lifecycle entry), the
     censuses in `server-module/src/privacy_enforcement_tests.rs`, the load build's placement,
     `evals/baselines/table-schemas.json`, `evals/account-e2e.eval.mjs` (its copy of the
     data-lifecycle manifest), `client/src/module_bindings/types.ts`,
     `client/src/net/wireContract.json`, `game-core`'s protocol number,
     `sim-harness/src/bin/mr_load_driver.rs` and `ops/observability` (the scheduled-function rules
     name their functions, and a zone at rest reports no `movement_tick` latency, which the
     driver's breaking-point reading and the dashboard must take as healthy), `ARCHITECTURE.md`,
     `docs/DECISIONS.md`, `docs/runbooks/playtest-ops.md`, `docs/local-play.md` §4 and §6,
     `docs/spacetimedb-2.16.md` and this file.
   - Holds: a zone whose players have been at rest for more than a second runs no
     `movement_tick`; an accepted input is drained or published within one `STEP_MS`; within a
     zone no character drains twice within `STEP_MS`, and the step after a warp into a zone with
     no row is a full step after the warp; the row that ends a walk is written one tick after its
     last step; a tick opened by a one-shot that fails leaves the queue intact, and the next
     intent write drains it in order; an interval row a database held before the publish is gone
     after its first tick; every insert of a `battle` row is followed by `drop_queued_moves` for
     each battler; an NPC held by a conversation does not step and steps within a second of its
     end; a zone's NPCs are home within a second of its last player leaving; a zone with no NPC
     that wanders never holds a wander row.

zt-1 deletes its own line here. This file goes with zt-2, or with the change that records the
operator's no; `docs/DECISIONS.md` then states what is built, and the transaction costs of section
1 and the event-table answer of section 2 move to `docs/spacetimedb-2.16.md`.

## 8. How to repeat, and what was not measured

**Machine and software.** The machine of `docs/local-play.md` §7 (AMD Ryzen 9 9950X, 32 hardware
threads, Ubuntu 24.04 under WSL2, kernel 6.18.33.2). `spacetimedb-standalone` 2.16.1 (sha256
`f38e6a8f…584c5d`), started directly. Modules built with rustc 1.99.0, not run through `wasm-opt`.
`mr_load_driver` is `cargo build --release -p sim-harness --bin mr_load_driver` at `26e1e085`. The
scripted clients run on Node 24.22.3. Other work ran on the machine throughout: three other build
sessions compiled and ran tests. Over the 30 windows of section 3 the one-minute load average was
1.85 at the median and 18.8 at its highest.

**Confinement.** As §7: each host in its own systemd scope (`MemoryMax=2G`, `MemorySwapMax=0`),
pinned to the two threads of one core, on a fresh data directory, the module published over the
HTTP API by the identity the host minted. Ten hosts ran at once on threads 0 to 19; the drivers,
the scripted clients and the samplers ran on threads 20 to 31. The 30 cells ran as three batches:
today's six with D's standing and one-walking cells; D's eight-walking cells with A's six and C's
standing and one-walking cells with NPCs; C's other four with B's six.

**The cells of section 3.** Start the host, publish, start the load, wait 60 seconds, then sample
every 5 seconds for 30 minutes: the apparent size of `replicas/1/clog`, the scope's `cpu.stat`,
`/proc/<pid>/status`, and the host's `/v1/metrics`. A walking cell is §7's driver command (`--zones
1` puts its clients in load zone 10000). A standing cell is one scripted client that joins,
subscribes its own row and its zone, and sends nothing. §7 ran each condition three times and took
the median; here each cell is one run. Today's three cells in the zone with NPCs give 1.256, 8.234
and 45.097 MiB an hour, against §4's medians of 1.24, 8.21 and 44.99 on 2.11.0.

**The scripts** are on the branch `proto/lpw-26-rig` at `a5c8ff95`, with the probe module of
section 2: the host starter, the cell and batch runners, the sampler, the commit-log reader, the
scripted client (standing, walking, watching, pressing, with the fault and the dropped socket), and
the timing, fault and reconnect scenarios. The fault builds are `proto/lpw-26-today-fault` at
`91947685`, `proto/lpw-26-a-fault` at `444501ce` and `proto/lpw-26-d-fault` at `90ed38e7`: the
prototype plus a reducer that makes `movement_tick` panic for a number of milliseconds.

**Not measured.**

- The game client in a browser. Every probe is a scripted client at the socket, so the press-phase
  teleport share and the hold table of `docs/send-pipeline-depth.md` were not run. C and D leave
  the wait from a press to its tick as it is today (section 4), which is what those depend on.
  What the client draws for an NPC under C was read from its code (section 6.1), not run.
- A walk through a warp under D, a battle start on tall grass, a conversation with the NPC, and
  the existing test suites against any prototype.
- A host restart while schedule rows are armed: section 1 gives what the scheduler's source does.
- Three rules of section 6.3 the prototype does not have: the one-shot's second bound (one
  `STEP_MS` after the character was last touched), the wander row armed with the one-shot, and
  the NPC reset in `ensure_zone_schedules`. The prototype's tick also deletes its row on a map
  that fails to load, which no run exercised.
- B for step timing, and D without the one-shot for anything but step timing and the press wait.
- The change section 6.3 names from the judge: the interval row inserted with the one-shot.
- More than one run per cell, windows longer than 30 minutes, more than eight players, more than
  one zone with players in it, and any load but standing and walking.
- Whether inserting the interval row before the drain, not after it, shortens the first interval
  of a burst.
- A rest other than five steps before the interval row is removed, and a second NPC that wanders
  in one zone.
- Memory and start-up, which no alternative is expected to move: resident memory at the end of
  each window is in the raw samples.
