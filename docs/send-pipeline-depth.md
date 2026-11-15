# Send-pipeline depth: one step in flight, or two?

**Status: measurement in progress.** This file states the question, the variants, the rule the
verdict follows and the method. The results and the verdict are added when the runs finish.

## The question

A held direction key walks a character by sending one `Step` at a time. Both continuation
emitters in `client/src/main.ts` (the frame loop, and the divergence branch of
`reconcileFromStore`) send only when `predictor.outstandingSteps === 0` and `owed.count === 0`:
nothing sent is still unanswered, and the server's published queue is empty. The server drains
one input per character per tick (`STEP_MS`, 200 ms), and its queue holds two
(`MOVE_QUEUE_CAP`).

Would letting one more step be in flight (`<= 1` in place of `=== 0`) give every player who
watches a walker a steadier stream of position changes? The hard constraint is the press-phase
teleport: the share of presses from rest in which the own avatar jumps instead of sliding.

## Variants

| Name | Frame-loop emitter | Divergence emitter |
|---|---|---|
| Depth 1 | `=== 0` (what ships) | `=== 0` (what ships) |
| Depth 2 | `<= 1` | `<= 1` |
| Depth 2, frame loop only | `<= 1` | `=== 0` |

"`<= 1`" names no emitter, so the third variant is measured beside the literal one.

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
