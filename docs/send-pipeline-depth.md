# Send-pipeline depth: one step in flight, or two?

**No-go.** A held key keeps sending one `Step` at a time, on both continuation emitters.

- Against a local server a second step in flight gives a watcher nothing. A step already
  lands on every server tick at either depth: the median interval between a walker's position
  changes is 200 ms, none is late, and the watcher draws no stand-still interval.
- Allowed on both emitters, it teleports the own avatar in 7.8 % of presses from rest at 60 Hz
  and 27.1 % at 30 Hz, against 0.0 % and 1.3 % with one step.
- Allowed on the frame loop alone, it keeps today's teleport share, but the server then refuses
  a turn pressed during a walk (30 of 30 presses), a committed hold travels a tile further,
  and every walk starts faster than walking speed.
- What one step in flight costs is paid on a slow link. From about 92 ms each way at 60 Hz
  steps start to miss a tick, and from about 100 ms every step does and the walk halves in
  speed; a second step removes that. No change measured here keeps that gain without the
  costs above ("What a later change must hold").

Measured on commit `c9674f5b`, with the continued-walk render for remote players and the
turn-first press in place, against SpacetimeDB 2.11.0 on the same machine, in headless Chromium
under Playwright 1.61.1, on the vite dev client. `STEP_MS` is 200 ms, `MOVE_QUEUE_CAP` is 2 and
`HOLD_COMMIT_MS` is 150 ms. The depth changes were made in a scratch worktree; none is in the
repository.

## The question

A held direction key walks a character by sending one `Step` at a time. Both continuation
emitters in `client/src/main.ts` (the frame loop, and the divergence branch of
`reconcileFromStore`) send only when `predictor.outstandingSteps === 0` and `owed.count === 0`:
nothing sent is still unanswered, and the queue the server last published is empty. The server
drains one input per character per tick, and its queue holds two.

Would letting one more step be in flight (`<= 1` in place of `=== 0`, on both counts) give
every player who watches a walker a steadier stream of position changes? The hard constraint
is the press-phase teleport: the share of presses from rest in which the own avatar jumps
instead of sliding.

## Variants

| Name in this file | Frame-loop emitter | Divergence emitter |
|---|---|---|
| Depth 1 | `=== 0` (what ships) | `=== 0` (what ships) |
| Depth 2 | `<= 1` | `<= 1` |
| Depth 2, frame loop only | `<= 1` | `=== 0` |

Each cell is the condition on both counts: `<= 1` stands for
`predictor.outstandingSteps <= 1 && owed.count <= 1`. "`<= 1`" names no emitter, so the third
variant is measured beside the literal one.

## The rule the verdict follows

Written before the press runs finished. A variant gets a go only if all three hold:

1. **A watcher gains.** At a link delay the game is played at, the watcher receives fewer late
   steps (position changes 1.5 × `STEP_MS` or more apart) or draws fewer stand-still intervals
   than at depth 1.
2. **The teleport constraint holds.** At 60 Hz and at 30 Hz its share of presses with a teleport
   is not higher than depth 1's at the sample taken.
3. **The press rules stay as recorded** in `docs/DECISIONS.md` ("Held keys", "Turning in place",
   "Bounded client prediction"): a press made during a held walk is accepted, and a tap sends
   one input.

A variant that fails 2 is a no-go whatever else it gains. A variant that passes 2 and 3 but
gains a watcher nothing at the delays the game is played at today is a no-go for now, and what
it would buy on a slower link is recorded for whoever reopens the question.

## Results

### Held 20-tile walk: what a watcher receives and draws

One player holds a direction for 20 tiles; a second browser watches. An interval is the time
between two consecutive position changes of the walker as the watcher receives them. A
stand-still interval is a stretch in which the watcher's drawn position of the walker does not
change. Both browsers and the server are on one machine, with no added delay.

| Depth | Link | Walks | Intervals | Median | p90 | Above STEP_MS | 1.5 × STEP_MS or more | Stand-still 50 ms or more, per walk | Stand-still 100 ms or more, per walk |
|---|---|---|---|---|---|---|---|---|---|
| 1 | local | 10 | 190 | 200.1 ms | 202.2 ms | 51.1 % | 0.0 % | 0.00 | 0.00 |
| 2 | local | 10 | 190 | 200.1 ms | 202.6 ms | 50.5 % | 0.0 % | 0.00 | 0.00 |
| 2, frame loop only | local | 10 | 190 | 200.0 ms | 202.0 ms | 43.2 % | 0.0 % | 0.00 | 0.00 |

Depth changes nothing here. The server ticks every 200 ms and every tick carries a step, so
the interval is the tick: the largest of the 570 was 227 ms and one exceeded 225 ms. "Above
`STEP_MS`" is therefore about half at every depth. It counts intervals a millisecond or two
longer than 200 ms and says nothing about late steps; the share at 1.5 × `STEP_MS` or more
does, and it is zero. No same-tile `Idle` row arrived between two steps of any walk, and the
watcher drew the walker moving on every frame from its second step to the key's release. When
the key comes up the watcher draws the walker back half a tile, at every depth: that is the
continued-walk render settling, not the send pipeline.

With a delay added to the walker's socket, each way:

| Depth | Added delay each way | Walks | Median | p90 | 1.5 × STEP_MS or more | Watcher: stand-still 50 ms or more, per walk | Walker speed | Walker: own stand-still 100 ms or more, per walk |
|---|---|---|---|---|---|---|---|---|
| 1 | none (route in place) | 6 | 200.1 ms | 202.4 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 2 | none (route in place) | 6 | 200.0 ms | 201.6 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 2, frame loop only | none (route in place) | 6 | 200.1 ms | 201.5 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 1 | 60 ms | 6 | 200.1 ms | 201.2 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 2 | 60 ms | 6 | 200.1 ms | 201.1 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 2, frame loop only | 60 ms | 6 | 200.0 ms | 201.1 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 1 | 85 ms | 4 | 199.9 ms | 201.4 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 2, frame loop only | 85 ms | 4 | 200.0 ms | 201.2 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 1 | 100 ms | 6 | 400.1 ms | 403.0 ms | 100.0 % | 0.00 | 2.50 tiles/s | 18.00 |
| 2 | 100 ms | 6 | 200.1 ms | 202.4 ms | 0.0 % | 0.67 | 5.00 tiles/s | 0.00 |
| 2, frame loop only | 100 ms | 6 | 200.0 ms | 201.4 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 1 | 150 ms | 6 | 400.0 ms | 406.1 ms | 100.0 % | 0.17 | 2.50 tiles/s | 18.00 |
| 2 | 150 ms | 6 | 200.0 ms | 203.9 ms | 0.0 % | 1.00 | 5.00 tiles/s | 0.00 |
| 2, frame loop only | 150 ms | 6 | 200.1 ms | 203.0 ms | 0.0 % | 0.00 | 5.00 tiles/s | 0.00 |
| 1 | 40 to 120 ms | 6 | 202.1 ms | 400.9 ms | 36.0 % | 3.00 | 3.73 tiles/s | 6.67 |
| 2 | 40 to 120 ms | 6 | 200.0 ms | 202.2 ms | 0.0 % | 0.33 | 4.99 tiles/s | 0.00 |
| 2, frame loop only | 40 to 120 ms | 6 | 200.1 ms | 202.5 ms | 0.0 % | 0.00 | 5.03 tiles/s | 0.00 |

One step in flight holds a step per tick up to 85 ms each way and loses it at 100 ms. By the
code, the next step is sent on the first frame after the row that drained the one before, and
has to reach the server before the next tick: a step misses its tick once twice the delay plus
the wait for that frame exceeds `STEP_MS`. Steps therefore start to miss from about 92 ms each
way at 60 Hz (83 ms at 30 Hz), and from about 100 ms every step misses. The server then writes
a same-tile `Idle` row in each gap (114 of 114 at 100 ms), the walker moves at half speed, and
its own avatar stops on every tile. The watcher is spared most of that: its render keeps the
walker moving between late steps, so it draws a smooth walk at half speed. On the uneven link a
third of the steps are late and the watcher does see it, with three stand-stills of 50 ms or
more per walk.

A second step in flight removes the late steps and restores the walking speed, on either pair
of emitters: the server's queue holds the next step while the one after travels. That is the
gain this study found, and it lies entirely past the delay limit. With `<= 1` on both emitters
the watcher's drawn walker was also slow to start: in 15 of the 18 walks at 100 ms, 150 ms and
the uneven link it first moved 167 to 317 ms after the walker's first step reached the watcher,
against 50 ms at most at depth 1 and with the frame loop only. The cause was not traced.

### Press-phase teleports

From rest, a direction key goes down for 650 ms and comes up; the press falls on every phase of
the server tick. A teleport is a frame in which the own avatar's drawn position jumps 0.9 tile
or more. `facing` starts with the character facing the pressed direction, so the press steps at
once; `turn` starts with it facing away, so the press turns first. Runs A and C rotate the
order of the cells, run B shuffles it, and run D adds 60 ms each way.

| Depth | Frame rate | Start | Presses with a teleport | Share | 95 % interval | Run |
|---|---|---|---|---|---|---|
| 1 | 60 Hz | facing | 0 of 200 | 0.0 % | 0.0 to 1.9 % | A |
| 2 | 60 Hz | facing | 13 of 200 | 6.5 % | 3.8 to 10.8 % | A |
| 2, frame loop only | 60 Hz | facing | 0 of 200 | 0.0 % | 0.0 to 1.9 % | A |
| 1 | 30 Hz | facing | 4 of 200 | 2.0 % | 0.8 to 5.0 % | A |
| 2 | 30 Hz | facing | 57 of 200 | 28.5 % | 22.7 to 35.1 % | A |
| 2, frame loop only | 30 Hz | facing | 2 of 200 | 1.0 % | 0.3 to 3.6 % | A |
| 1 | 60 Hz | facing | 0 of 150 | 0.0 % | 0.0 to 2.5 % | B |
| 2 | 60 Hz | facing | 14 of 150 | 9.3 % | 5.6 to 15.1 % | B |
| 2, frame loop only | 60 Hz | facing | 0 of 150 | 0.0 % | 0.0 to 2.5 % | B |
| 1 | 30 Hz | facing | 0 of 150 | 0.0 % | 0.0 to 2.5 % | B |
| 2 | 30 Hz | facing | 40 of 150 | 26.7 % | 20.2 to 34.3 % | B |
| 2, frame loop only | 30 Hz | facing | 1 of 150 | 0.7 % | 0.1 to 3.7 % | B |
| 1 | 60 Hz | turn | 0 of 100 | 0.0 % | 0.0 to 3.7 % | C |
| 2 | 60 Hz | turn | 8 of 100 | 8.0 % | 4.1 to 15.0 % | C |
| 2, frame loop only | 60 Hz | turn | 0 of 100 | 0.0 % | 0.0 to 3.7 % | C |
| 1 | 30 Hz | turn | 2 of 100 | 2.0 % | 0.6 to 7.0 % | C |
| 2 | 30 Hz | turn | 25 of 100 | 25.0 % | 17.5 to 34.3 % | C |
| 2, frame loop only | 30 Hz | turn | 1 of 100 | 1.0 % | 0.2 to 5.4 % | C |
| 1 | 60 Hz | facing | 0 of 100 | 0.0 % | 0.0 to 3.7 % | D |
| 2 | 60 Hz | facing | 10 of 100 | 10.0 % | 5.5 to 17.4 % | D |
| 2, frame loop only | 60 Hz | facing | 0 of 100 | 0.0 % | 0.0 to 3.7 % | D |

Depth 1 teleports in 0 of 450 presses at 60 Hz and 6 of 450 at 30 Hz (runs A to C). Depth 2
teleports in 35 of 450 and 122 of 450: it breaks the constraint at both frame rates, from
either start, with or without link delay. Depth 2 on the frame loop only teleports in 0 of 450
and 4 of 450, which the sample cannot tell from depth 1.

Every teleport fell between 167 and 249 ms after the press: on the frames that follow the first
continuation step, which goes out when the hold passes `HOLD_COMMIT_MS`. None fell later in a
press or in the steady part of any walk.

### What a second step costs the walker

**A committed hold travels a tile further.** Tiles travelled by one press, 40 presses per cell
at 60 Hz:

| Hold | Start | Depth 1 | Depth 2 | Depth 2, frame loop only |
|---|---|---|---|---|
| 120 ms | facing | 1 tile in 40 | 1 tile in 40 | 1 tile in 40 |
| 180 ms | facing | 2 tiles in 35, 1 tile in 5 | 3 tiles in 34, 2 tiles in 6 | 3 tiles in 37, 2 tiles in 3 |
| 250 ms | facing | 2 tiles in 35, 3 tiles in 5 | 3 tiles in 32, 4 tiles in 8 | 3 tiles in 31, 4 tiles in 9 |
| 120 ms | turn | 0 tiles in 40 | 0 tiles in 40 | 0 tiles in 40 |
| 180 ms | turn | 1 tile in 35, 0 tiles in 5 | 2 tiles in 32, 1 tile in 8 | 2 tiles in 29, 1 tile in 11 |
| 250 ms | turn | 1 tile in 30, 2 tiles in 10 | 2 tiles in 29, 3 tiles in 11 | 2 tiles in 32, 3 tiles in 8 |

Tiles are counted from the inputs the press sent: on this row every accepted input moves one
tile, except the turn a `turn` start begins with. A tap shorter than `HOLD_COMMIT_MS` is
untouched: one input at every depth. In every longer cell the tiles travelled shift up by one
at depth 2. The pipeline is one step deeper, the first continuation step leaves at the commit
threshold without waiting for the row that answers the press, and whatever is in the pipeline
when the key comes up is still walked. A 650 ms hold travels 4.23 tiles on average at depth 1
and 5.22 with a second step on the frame loop (runs A and B, 60 Hz). Prediction then runs two
tiles ahead of the authoritative tile where it runs one today, and after the key comes up the
server moves the character two more tiles where it moves one.

**Every walk starts fast.** The avatar slides toward the predicted tile, and at depth 2 the
second and third tiles are predicted within a frame or two of each other. The largest distance
the avatar covers in any 200 ms of a press has a median of 1.3 tiles at depth 1 and of 2.0, twice
walking speed, with a second step on the frame loop (runs A and B, 60 Hz, presses without a
teleport). It reaches 1.5 tiles in 29.4 % of presses at depth 1 and in all of them at depth 2.

**A turn pressed during a walk is refused.** East is held; north goes down as well, mid-walk:

| Depth | Presses | Presses the server refused | Tiles east after the press | Press to the first step north, median |
|---|---|---|---|---|
| 1 | 30 | 0 of 30 | 1 in 30 | 501 ms |
| 2 | 30 | 27 of 30 | 2 in 30 | 535 ms |
| 2, frame loop only | 30 | 30 of 30 | 2 in 29, 3 in 1 | 509 ms |

With two steps in flight the server's queue is full from just after each tick until the next,
and `enqueue_move` refuses a third input. A press is not held back by the continuation gate, so
the `Face` is sent and refused, and the server never queues it. The walk turns when the
held-key continuation sends a `Step` north, which turns and moves in one input: the turn in
place that "Turning in place" gives a press mid-walk does not happen, and the character walks
two more tiles east where it walks one. By the same code a jump pressed mid-walk meets the same
full queue; that was not run.

## Why

**A step already lands on every tick.** With one step in flight the next step leaves on the
first frame after the row that acknowledges the one before. At local delay that is at most a
frame after the tick, with most of a tick to spare. A second step in flight cannot add steps to
ticks that all have one.

**By the code, the divergence emitter makes every teleport.** Outside a long frame gap and
reduced motion, `RenderResolver` snaps the own avatar when the predicted tile is two or more
tiles from the slide clock's target, which happens when prediction gains two tiles between two
drawn frames. The frame-loop emitter sends after the frame's `predictor.drain`, so its step is
predicted on the next frame: it adds one tile per frame at most. The divergence emitter runs
inside a reconcile, between frames. When a row arrives in the one frame between a continuation
send and its drain, the reconcile brings in the step just sent: replayed if it is still
unanswered, taken from the row if the row drained it. `Predictor.reconcile` reports that one
tile as a divergence, the divergence emitter sends another step at once, and the next frame's
drain predicts it (a second tile): a snap.

- At depth 1 the emitter fires only when nothing is outstanding after the reconcile, so the row
  has to be the one that drained the step sent a frame earlier. Only the first continuation
  step can be drained that fast, and only when two frames span more than `STEP_MS` −
  `HOLD_COMMIT_MS` (50 ms) plus the round trip. That means a frame of more than 25 ms: not at a
  steady 60 Hz, in about 2 % of presses at 30 Hz by the code, and in 6 of 450 here.
- With `<= 1` on the divergence emitter, any row that arrives in that frame fires it, since one
  outstanding step is then the normal state. A frame is a twelfth of a tick at 60 Hz, which
  gives about 8 %. At 30 Hz it is a sixth, and the second continuation step, sent a frame
  after the first, opens the same window again: 25 to 33 %.
- With `<= 1` on the frame loop only, the divergence emitter keeps the depth 1 condition and
  the depth 1 share.

The measured shares match the ones these orderings give. The frame-loop-only variant changes
nothing but which emitter may send, and it has depth 1's share.

**The server's queue has room for one press only while one step is in flight.**
`MOVE_QUEUE_CAP` is 2. At depth 1 the queue holds one step for most of each tick and a press
takes the second place. At depth 2 the held key takes both.

## Alternatives scored

Four alternatives, scored from 0 to 10 against the rule above, independently of the
measurements. The watcher's gain and the press rules count twice, and the teleport constraint
is a gate. The scores are advisory: the verdict follows the rule alone.

| Alternative | Watcher's gain at local delay | Teleport constraint | Press rules | Gain on a slow link | Evidence and size | Total of 60 |
|---|---|---|---|---|---|---|
| Keep one step in flight | 5 | holds | 10 | 0 | 9 | 39 |
| `<= 1` on both emitters | 5 | fails | 1 | 8 | 3 | out |
| `<= 1` on the frame loop only | 5 | holds | 1 | 10 | 5 | 27 |
| Frame loop only, with a queue of 3 and a second step only on a slow link | 5 | not measured | 6 | 7 | 2 | 31 |

A 5 for the watcher's gain is parity: no alternative changes the stream at local delay. The
last row scores on what it is expected to do; none of what it adds was run.

The strongest case against keeping one step is the slow link. A private server hosted for
friends, or the official one, can sit 100 ms or more away from a player, and that player then
walks at half speed. How much that weighs today is not something these measurements settle.
They do settle that the two changes measured are not the remedy: one teleports, and the other
gives up the press rules for every player to help the distant one.

## How to repeat

Everything below ran from a scratch worktree of the commit under test. The probe and the gate
change are not in the repository: this section is what there is to rebuild them from. The
client was the vite dev build (it carries the DEV `window.__game()` hook), with the prediction
wasm from `just wasm`, in Playwright's headless Chromium at its default launch flags, on Linux
under WSL2 with 32 logical CPUs.

| Run | What | Cells | Per cell |
|---|---|---|---|
| Walk, direct socket | held 20-tile walk, watched | 3 variants | 10 walks |
| Walk, delay route | the same, the walker's socket delayed | 3 variants × no delay, 60, 100, 150 and 40 to 120 ms; 2 variants at 85 ms | 6 walks (4 at 85 ms) |
| A | press from rest, `facing` start | 3 variants × 60 and 30 Hz | 200 presses |
| B | as A, cell order shuffled | 3 variants × 60 and 30 Hz | 150 presses |
| C | press from rest, `turn` start | 3 variants × 60 and 30 Hz | 100 presses |
| D | as A, 60 ms each way | 3 variants at 60 Hz | 100 presses |
| Hold | presses of 120, 180 and 250 ms | 3 variants × 3 holds × 2 starts at 60 Hz | 40 presses |
| Second direction | north pressed during a held walk east | 3 variants | 30 presses |

No walk or press failed or was left out. Two copies of the probe, each with its own database
and dev server, shared the machine for every run except most of run B. A frame longer than 1.5
times its nominal period turned up in 47 of run A's 1200 presses, 4 of run C's 600 and 50 of
run D's 300, and in none of run B's 900. One press of run A had a frame of 100 ms, too long to
judge for a jump; it showed none.

### Server and database

```sh
spacetime start --data-dir "$SCRATCH/data" --listen-addr 127.0.0.1:3741   # its own port and data
cd "$SCRATCH/worktree/client" && npm ci && (cd .. && just wasm)
STDB_SERVER=http://127.0.0.1:3741 VITE_STDB_URI=ws://127.0.0.1:3741 \
  VITE_STDB_DB=send-depth-study MR_E2E_PORT=5471 \
  npx playwright test e2e/<probe>.spec.ts --project=default --trace off
```

The e2e global setup publishes the module to `VITE_STDB_DB` with `--delete-data`, so every run
starts on an empty database of its own. `--trace off` keeps Playwright's tracing out of the
timing.

### The gate change

Both emitters read their slack from a global the probe sets, so one page serves every variant
and a variant is switched between two presses. Slack 0 is the shipped gate: both counts are
non-negative integers.

```ts
// beside `const owed = new OwedInputs();`
const sendSlack = (which: 'frame' | 'div'): number =>
  (globalThis as { __sendSlack?: { frame: number; div: number } }).__sendSlack?.[which] ?? 0;

// reconcileFromStore, the divergence emitter
if (diverged && predictor.outstandingSteps <= sendSlack('div') && owed.count <= sendSlack('div') && movementGate()) {

// the frame loop, below predictor.drain(now)
if (predictor.outstandingSteps <= sendSlack('frame') && owed.count <= sendSlack('frame') && movementGate()) {
```

Depth 1 is `{ frame: 0, div: 0 }`, depth 2 is `{ frame: 1, div: 1 }`, and depth 2 on the frame
loop only is `{ frame: 1, div: 0 }`. The probe sets the variant and the frame rate with
`page.evaluate` before each walk or press:

```ts
await page.evaluate(() => {
  window.__sendSlack = { frame: 1, div: 0 };
  window.__halfRate = true; // 30 Hz, see below
});
```

### The probe

A Playwright spec in the scratch worktree's `client/e2e/`. It launches its own Chromium, opens
one browser context per player and reads only `window.__game()`. An init script, installed
before any client code, adds three things to each page:

- **A frame-rate switch.** Every `requestAnimationFrame` callback is queued and run from one
  native callback per display frame, in registration order. With the switch on, the queue runs
  on every second display frame, so the game's frame loop and the recorder both run at 30 Hz.
  Measured frame intervals: 16.7 ms median and 16.8 ms at the 95th percentile with it off,
  33.3 ms and 33.4 ms with it on.

  ```ts
  const native = window.requestAnimationFrame.bind(window);
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1, vsync = 0, pumping = false;
  const pump = (t: number): void => {
    vsync += 1;
    if (!window.__halfRate || vsync % 2 === 0) {
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) {
        try { cb(t); } catch (e) { queueMicrotask(() => { throw e; }); }
      }
    }
    if (queue.size > 0) native(pump);
    else pumping = false;
  };
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.set(id, cb);
    if (!pumping) { pumping = true; native(pump); }
    return id;
  };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  ```

- **Key stamps.** A capture-phase `keydown`/`keyup` listener on `window` records
  `performance.now()`, so a press is timed on the page's clock.
- **Socket stamps** (watcher only). `window.WebSocket` is subclassed to record
  `performance.now()` for every incoming message, in a listener added in the constructor, before
  the SDK's own.

A recorder, started before each walk or press, pushes one row per animation frame: the frame
time, the own avatar's drawn position (`rendered[]`), the predicted tile, the authoritative tile,
`moveSendCount`, `moveRejectCount`, the acknowledged sequence number and the published queue
length; on the watcher also the walker's tile, action and drawn position. Its callback is
registered after the game's frame callback and both re-arm themselves, so each row reads the
frame the game has just drawn. Offsets, shuffles and delays come from a seeded generator
(mulberry32, seed 20261114; 7741 for run B).

Both players walk with the DEV `step()` hook from the spawn down column 1 of zone 0, through the
warp at (1, 5), to row 7 of zone 1. That row is open floor, path and sand from x = 1 to x = 29,
with no grass and no warp: the only straight 20-tile run without wild encounters.

**Held walk.** The watcher stands at (2, 5). The walker waits at rest until the watcher has
drawn it on its tile for four steps plus a random part of a step, then a direction key goes
down. The key comes up when the walker's predicted tile is 20 tiles from the start, and the
recorders stop eight steps after the walker is at rest. Walks alternate east and west, so every
walk but the first of a run starts with a turn. The three variants are interleaved, and the
variant that walks first rotates.

- A **position-change interval** is the time between the socket messages that carried two
  consecutive tiles of the walker to the watcher. A change is matched to the one message stamped
  between the frame before the one that first shows the tile (less 20 ms) and one frame after
  it; a change with no such message is left out with both of its intervals. Every change in
  these runs was matched.
- A **stand-still interval** is a run of frames, between the first frame that shows the walker's
  second tile and the key's release, in which the watcher's drawn position of the walker does
  not change.

**Link delay.** The walker's socket goes through `page.routeWebSocket`, with one delay line per
direction: each message leaves after the profile's delay and never before the message ahead of
it. The watcher's socket is direct. "40 to 120 ms each way" draws the delay of every message
uniformly from that range. The walks with no added delay ran on a direct socket; a control run
with the route in place and no delay gave the same numbers.

```ts
function makeLane(delayMs: () => number): (send: () => void) => void {
  const q: { due: number; send: () => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pump = (): void => {
    timer = null;
    while (q.length > 0 && q[0].due <= performance.now() + 0.25) q.shift().send();
    if (q.length > 0) timer = setTimeout(pump, Math.max(0, q[0].due - performance.now()));
  };
  return (send) => {
    const ms = delayMs();
    if (ms <= 0 && q.length === 0) return send();
    const due = Math.max(performance.now() + ms, q.length > 0 ? q[q.length - 1].due : 0);
    q.push({ due, send });
    if (timer === null) timer = setTimeout(pump, Math.max(0, due - performance.now()));
  };
}
await page.routeWebSocket(/.*/, (ws) => {
  const server = ws.connectToServer();
  const up = makeLane(delayMs);
  const down = makeLane(delayMs);
  ws.onMessage((m) => up(() => server.send(m)));
  server.onMessage((m) => down(() => ws.send(m)));
});
```

**Press from rest.** One player on row 7. Before each press the probe sets the variant and the
frame rate, taps the character to the facing the cell needs (the walk direction for a `facing`
start, the opposite for a `turn` start), waits for rest (nothing queued, predicted and
authoritative tiles equal, drawn on the tile, action `Idle`), waits 350 ms plus an offset, starts
the recorder and waits 90 ms. Then the key goes down for the cell's hold time (650 ms in the
teleport cells) and comes up, and the recorder stops 120 ms after the character is at rest. The
character walks east while x ≤ 15 and west otherwise. A step sent on the frame of the release
is neither predicted nor acknowledged yet and reads as rest, so the end tile can be read one
step early: tiles are counted from the inputs sent, and run B and the second-direction run
wait 250 ms after the release before they test for rest.

- The **offset** sweeps one tick: `((k × 0.618 + c / cells) mod 1) × STEP_MS` for round `k` and
  the cell's place `c` in the round, plus up to 4 ms of seeded noise. The press therefore falls
  on every phase of the server tick: sorted into eight 25 ms bins, the last open-ended, the
  delay from the press to its first acknowledgement fills all eight in 17 of the 18 cells of
  runs A to C and seven in the other.
- One round presses every cell once, so a run has as many rounds as presses per cell. The
  95 % interval is the Wilson score interval.
- The cell order rotates by one each round (runs A, C and D and the hold run) or is a fresh
  seeded shuffle each round (run B).
- A **teleport** is one frame shorter than half a step in which the own avatar's drawn position
  moves 0.9 tile or more. A slide would need the drawn position more than five tiles behind its
  target to cover that in a 33 ms frame, and prediction never runs that far ahead; a snap moves
  the avatar at least one tile.

**A second direction mid-walk.** From (12, 7), east goes down; 700 ms plus the swept offset
later north goes down as well; 500 ms later both come up.

## What a later change must hold

A change that puts a second step in flight to keep walking speed on a slow link has to show,
with the probe above, on a direct socket and at 100 ms, 150 ms and 40 to 120 ms each way:

- **The teleport bound.** No more presses with a teleport than depth 1, from `facing` and `turn`
  starts: 0 of 450 at 60 Hz and 6 of 450 at 30 Hz here. The divergence emitter keeps `=== 0`.
- **A press during a held walk is accepted** (0 of 30 refused here), for which a second
  continuation step and `MOVE_QUEUE_CAP` 2 leave no room.
- **At local delay a hold travels what it does today** (the depth 1 column of the hold table),
  so the second step is in flight only while the round trip needs it.

Two more findings are left for later work. Depth 1 itself teleports in 6 of 450 presses at
30 Hz, through the divergence emitter firing on a reconcile that moved prediction forward; the
comment on the drain order in the frame loop says that order takes the share to zero, and at
30 Hz it does not. And the half-speed walk on a slow link stands until a change meets the three
conditions above.

## Verdict

**No-go.** One step in flight stays on both emitters, and `docs/DECISIONS.md` ("Held keys")
records why.

- No watcher gains at the delay the game is played at today, a local server: no late step and
  no stand-still interval in the 10 walks at each depth.
- `<= 1` on both emitters fails the teleport constraint: 35 of 450 presses at 60 Hz and
  122 of 450 at 30 Hz, against 0 of 450 and 6 of 450.
- `<= 1` on the frame loop only holds the teleport constraint and fails the press rules (30 of
  30 turns pressed mid-walk refused); it also adds a tile to every committed hold.

How much the slow link should weigh is a question for the game's owner and is put to them with
this record. The no-go does not wait on the answer: neither change measured here is the remedy.
