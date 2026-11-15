# e2e flake register

The e2e tests that have failed on CI with no code defect behind the failure, and whose fix has
not merged. An entry gives the test, the runs, the signature, every forcing recipe tried with its
counts, the verdict (product or test) and its next step. An entry leaves when its fix merges: the
change that fixes it deletes it.

The rerun listing is the `e2e` job summary's table of tests that passed only on a rerun (one
warning annotation each). A test it lists that has no entry here and no row of its own is a new
flake: add an entry.

| # | Test | State | Next step |
|---|---|---|---|
| 1 | `ui-feedback.spec.ts` UIF4B.2 rename: the name field stays hidden after N | signature forced, flake not reproduced | read the trace of its next rerun listing |
| 2 | `tactics-wild.spec.ts` BT12-5-WILD-RECRUIT and `recruit.spec.ts` R2: a recruit reported as none | cause shown by forcing, CI path inferred; fixed in BT12-5-WILD-RECRUIT, open in R2 | the follow-up slice in the entry |
| 3 | `zone-scope.spec.ts` "A walks to the warp": no frame sampled before the warp | not studied | read the trace run 43690080900 kept |
| 4 | `remote-walk.spec.ts` np-a.9: the sprite stands still past its bound | not studied here | its own row, `R-np-a-flake` |

## How the recipes were run

Commit `218e6020` of `master`, in a scratch worktree, on an AMD Ryzen 9 9950X (32 logical CPUs)
under WSL2. Headless Chromium under Playwright 1.61.1 against the Vite 6.4.4 dev client and a
SpacetimeDB 2.11.0 standalone host of its own, in memory, publishing the `dev_reducers` module.
One run is one fresh Playwright process on a freshly published database. No probe file is in the
repository; each recipe says what it changes.

The tables give, per recipe, its runs and how many of them ended with the entry's CI signature.
Reaching the signature is not reproducing the flake: a recipe reproduces the flake only when it
gets there without supplying the missing cause itself.

## 1. UIF4B.2 rename: the name field stays hidden after N

**Test.** `client/e2e/ui-feedback.spec.ts`, "UIF4B.2 the rename frame: a valid rename's success
toast moves no box …", in its first window (1280x720).

**Run.** 43554594387 attempt 1 (PR #770, shard 4 of 5, 2026-11-14). It is the first test of the
shard's first file. The same tree passed on attempt 2. Seen once.

**Signature.** After `page.goto('/')`, `ready()` (an identity and the own character are present),
a resize, `closeAll` and a hidden toast, the test presses the N accelerator and waits 10 s:

```
TimeoutError: page.waitForSelector: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('[data-testid="rename-input"]') to be visible
    24 × locator resolved to hidden <input type="text" maxlength="24" id="rename-input" data-testid="rename-input" aria-labelledby="rename-title"/>
```

**What the log fixes.** `aria-labelledby="rename-title"` is set by the `RenameView` constructor
and is absent from `index.html`. Playwright polls at once and then after 20, 50, 100, 100 and
500 ms, and all 24 polls are one collapsed line, so every poll saw a page with its views mounted.
The test took 14.4 s with its `beforeAll`; less the 10 s wait, the press came about 4.4 s in.

**Where a press is dropped without a word.** Between the keydown and the visible field
(`client/src/main.ts`, `client/src/input/router.ts`) the press goes nowhere, silently, when:

- focus is outside the game screen (`outsideGameScreen`);
- the session terminal holds the screen (`sessionGateBlocks`);
- a Ctrl, Alt or Meta chord is down, the event is an OS key repeat, or Controls is capturing a
  key;
- the focused element owns the key, a text field or a button, or the key is part of an IME
  composition (`ownership` is not `router`);
- the live table binds no accelerator to the key's code, after a remap or a cleared slot
  (`accelForCode`);
- the top frame denies accelerators: a prompt, a text entry, or a server-owned screen, the battle
  view or a conversation (`accelDecision`);
- a frame the pop to the base cannot take stays on top (`openAccelPath`);
- `identity === ''` (`openAccelPath`): from page load until the join lands only the C accelerator
  opens a frame. The handler calls `preventDefault` on the keydown anyway.

On a page in its first join none of these holds by the time `ready()` returns. The last held only
until the join landed, and the others need a state such a page does not create: focus is on
`<body>` until a frame opens, the session terminal shows only in a tab that has signed in, the
table is the default one, and nothing pushes a prompt, a text entry, the battle view or a
conversation by itself. In the 29 traced
presses with no injected reload the target and the focused element were `<body>`, no modifier was
down, the stack held the world frame alone, the page had joined, and the press opened the menu
and Profile. The views are mounted before `connect()`, so every document has a span between its
view mount and its join in which N is dropped; the document `ready()` saw is past it.

**Attempts.**

| Recipe | What it does | Runs | Signature |
|---|---|---|---|
| shard order | the rename test alone (`-g "the rename frame"`, `CI=1`), first test of a fresh process, the Vite dependency cache (`client/node_modules/.vite`) moved away before each run. The CI test is its shard's first, so nothing runs before it there either | 42 | 0 |
| probe | the same steps in a tracing probe: a capture-phase keydown log (target, focus, joined, stack before and one task after), navigation, socket and page-error counts; cold cache | 1 | 0 |
| one core | the probe, cold cache, the whole process tree pinned to one core (`taskset -c 0`) | 12 | 0 |
| CPU 6x | the probe under Chromium CPU throttle 6x (`Emulation.setCPUThrottlingRate`) | 8 | 0 |
| CPU 20x | the probe under Chromium CPU throttle 20x | 8 | 0 |
| timers held | the probe; from `ready` until after the result every `setTimeout` callback is parked | 10 | 0 |
| held join | after `ready` and the test's own steps the page is reloaded with server-to-page frames of the SpacetimeDB socket held (`page.routeWebSocket`); N is pressed once `#rename-input[aria-labelledby]` is attached | 5 | 5 |
| reload 0 ms | `page.reload({ waitUntil: 'commit' })`, not awaited, issued 0 ms before the test's own steps; nothing held | 6 | 0 |
| reload 100 ms | the same, 100 ms before | 6 | 0 |
| reload 200 ms | the same, 200 ms before | 6 | 0 |
| reload 300 ms | the same, 300 ms before | 6 | 5 |
| reload 450 ms | the same, 450 ms before | 6 | 0 |
| reload 700 ms | the same, 700 ms before | 6 | 0 |

The two recipes that reach the signature supply the second document themselves. With the join
held, all 5 runs gave the call log above to the character; the keydown log read not joined, the
world frame alone before and after; and a second N after the frames were released opened the
field in all 5. With a bare reload the outcome depends on where the press lands in the new
document:

- 0 ms: `Execution context was destroyed` in the resize poll, 6 of 6.
- 100 ms: `closeAll: window.__game is missing`, 6 of 6.
- 200 ms: hidden for 10 s, but the call log opens with a poll that saw the field without its
  `aria-labelledby`, 6 of 6.
- 300 ms: the CI call log, 5 of 6; the field opened in the sixth.
- 450 ms and 700 ms: the page had joined again and the field opened, 12 of 12.

So on this machine the signature needs a reload that starts about 300 ms before the press. In the
39 probe runs with no injected reload the main frame navigated exactly once. Vite's own reload
sources (a dependency re-optimisation, a changed module with no HMR boundary, a changed `.html`,
`tsconfig` or config file, a lost HMR socket) were read from its server bundle; none fired in any
run, the cold cache already listed every dependency, and none has a known source in the CI job.

**Verdict.** Not reproduced. The signature is a press on a document that has mounted its views
and has not joined. Both recipes that reach it inject that document, and nothing found makes the
CI job produce one after `ready()`; the 81 runs that inject nothing never reached it. Neither the
product nor the test is shown wrong.

**Next step.** Its next rerun listing. A failed shard keeps each failed test's trace and the
SpacetimeDB log for 14 days (`e2e-failure-<shard>-<attempt>`); runs 43554594387 and 43362803625
kept none. The trace holds the action log, the console, the network log and a film strip, and no
DOM snapshot. It separates three cases:

- Two main-frame navigations before the press: the press hit a new document before its join.
  Whatever reloaded the page is the cause, a test or environment fix; the held-join recipe forces
  it.
- One navigation, and the network log shows the SpacetimeDB socket closed or reopened around the
  press: the client closes Profile when it reconnects, and the frame closed as it opened. A
  product question; its forcing test holds the rebuilt connection's frames and presses N.
- One navigation and a live socket: one of the other conditions held. The film strip shows what
  had the screen or the focus.

## 2. A recruit on the last allowed own turn is reported as none

**Tests.** `client/e2e/tactics-wild.spec.ts` BT12-5-WILD-RECRUIT and `client/e2e/recruit.spec.ts`
R2. Each has its own copy of one loop, `fightToRecruit`: up to `MAX_OWN_TURNS` (16) own turns of
close in, weaken, Recruit. When the loop reports no recruit, its caller hunts another wild.

**Run.** 43362803625 attempt 1 (PR #751, shard 3 of 5, 2026-11-13), BT12-5-WILD-RECRUIT. The
shard passed on attempt 2. Seen once. R2 has no such failure in the runs read for this register.

**Signature.**

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 3

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate

  562 |         .poll(async () => (await readOwnMonsters(page)).length, { timeout: 15_000 })
> 563 |         .toBe(2);
```

Three monsters are the starter and two recruits. The test ran 34.9 s; less the 15 s poll, 19.9 s
of `beforeAll` and body. A one-battle pass on the same tree ran 8.7 s.

**Cause.** A loop that answers as soon as its bound is spent reports a Recruit pressed on the
sixteenth own turn as none: that press has not resolved yet. When its roll succeeds the battle
ends with the wild recruited, the caller finds nothing to flee, passes the results panel and
recruits a second wild. The tree of run 43362803625 has that loop. BT12-5-WILD-RECRUIT's loop on
`master` waits for the last turn before it answers (PR #752). R2's copy returns `'stalled'` once
the sixteenth turn is spent; its caller waits for the turn, sees the battle finished, and keeps
the `'stalled'` answer.

**Attempts.** The last column counts runs that ended with three or more own monsters, the count
the CI run's final poll read.

| Recipe | What it does | Runs | Third monster |
|---|---|---|---|
| plain | BT12-5-WILD-RECRUIT as on `master`, instrumented: a per-turn log, and an in-page sampler that reads the tactical state on every macrotask for 2 s after each Recruit press | 19 | 0 |
| CPU 4x | plain under Chromium CPU throttle 4x | 8 | 0 |
| frames late | plain with every server-to-page frame delivered 150 ms late, in order | 8 | 0 |
| bound 6 | plain with `MAX_OWN_TURNS` lowered to 6 | 12 | 0 |
| Recruit held | plain at 16; once the wild is weak and adjacent the loop takes no action until its last own turn and presses Recruit there | 6 | 0 |
| early answer, bound 6 | the loop of run 43362803625's tree (answers once the bound is spent) on `master`'s product, `MAX_OWN_TURNS` lowered to 6 | 12 | 1 |
| early answer, Recruit held | that loop at 16 with Recruit held; the probe catches the caller's flee throw and goes on | 8 | 7 |
| R2, Recruit held | R2 as on `master`, Recruit held in the first encounter | 12 | 5 |
| R2 waiting, Recruit held | R2 with its loop waiting for the last turn, Recruit held in the first encounter | 12 | 0 |

What the rows show:

- **Early answer, Recruit held.** 33 Recruit presses landed on the sixteenth own turn and 20
  succeeded. All 20 were answered "no recruit". 9 passed silently into the next hunt, the path to
  the CI signature. 11 made the caller's flee throw `fleeByButtons: the battle is Finished`: the
  roll landed between the caller's own-turn wait and its flee. The probe went on past both, so 7
  of 8 runs ended with three or four monsters. Under the test itself the first such press ends
  the run with one signature or the other.
- **Recruit held.** 12 presses on the sixteenth turn, 6 succeeded, all 6 answered "recruited";
  every run ended with two monsters.
- **Bound 6.** The early answer reported a real recruit as none in 2 of 12 runs, and one of them
  ended with three monsters; `master`'s loop caught 3 last-turn recruits in 12 runs. PR #752
  records the same pair at a bound of 6 to 7: 15 of 80, and 0 of 75 with the wait.
- **R2, Recruit held.** 9 of the 12 runs reached a Recruit on the sixteenth turn of the first
  encounter. In 5 it succeeded, the encounter was logged `stalled`, a later one recruited again
  (the second in 3 runs, the third in 2), and the test failed `Expected: 2 Received: 3`. With the
  loop waiting, 8 of 12 runs reached that press, 5 succeeded and all 5 were logged `recruited`.
- **No other path.** Across the 73 BT12-5-WILD-RECRUIT probe runs the sampler saw 86 recruits
  land. Each arrived as one step: `Finished`, the wild `Recruited` and one more own monster
  together. A read of the helpers, the server's recruit path and the client store found no second
  way to two recruits: a success ends its battle in the same transaction, and a finished battle
  accepts no commit.

**Does run 43362803625 fit.** Not shown: it kept no trace. What can be checked fits.

- Time. The 19.9 s holds two battles: two results panels (3 s each in that tree), two hunts
  (median 1.5 s here) and two fights. A battle that reaches a Recruit on its sixteenth turn is
  attacks and failed recruits, about 0.2 s each here: a 3 s fight. A Skittish wild that keeps its
  distance never lets the starter stand adjacent and draws no Recruit press at all (6 of the 41
  battles in the plain, CPU 4x and frames late rows).
- Rate. In those three rows, 79 Recruit presses, 35 succeeded (44 %); the first press of a
  battle fell on own turn 4 to 11 and the latest press on turn 12. Own turns count from 1. A
  battle that first presses Recruit on own turn t presses it again on every later own turn until
  one succeeds, each press an independent 44 %. With the first-press turns as observed, the
  chance that the press on turn 16 is the first to succeed is the sum over t of
  P(first press on turn t) x 0.56^(16 - t) x 0.44: about 1 battle in 480. CI saw one failure in
  the 197 runs created from 2026-11-07 to 2026-11-13.
- Run 42328156037, half an hour before those days, and the other 24 failed or rerun runs of
  those days have 20 failed job logs that ran Playwright, every attempt included. None holds the
  sibling signature (`fleeByButtons: the battle is Finished`) or a second BT12-5-WILD-RECRUIT
  failure.

**Verdict.** The test is wrong, not the product: the loop answers before its last press resolves.
BT12-5-WILD-RECRUIT waits (PR #752); R2 does not. That run 43362803625 hit this path is inferred.
A third monster on a rerun listing of BT12-5-WILD-RECRUIT would refute it and reopen this entry.

**Follow-up slice: `th-7`, the recruit loop has one home.** Test, not product.

- `touches:` `client/e2e/controls.ts`, `client/e2e/controls.spec.ts`,
  `client/e2e/recruit.spec.ts`, `client/e2e/tactics-wild.spec.ts`.
- The loop moves to `controls.ts` and both specs call it. It takes its own-turn bound as an
  argument and keeps R2's three answers and its press and HP bookkeeping, and
  BT12-5-WILD-RECRUIT's count of forecast attacks. R2's caller reads `'stalled'` only after the
  last turn has been waited for. Neither spec keeps a local `fightToRecruit`.
- Forcing regression test: a case in `controls.spec.ts` in which a Recruit pressed on the last
  allowed own turn resolves only after the loop's last iteration, and the loop answers
  `'recruited'`. The loop's steps read the tactical shell's DOM (the cursor tile, the menu rows,
  the bait list, the forecast) as well as `__mrTactics` and `__game`, so the case either fakes
  that much of the shell on a served-nothing page or drives the loop through its steps passed as
  arguments. It is run red against a copy of R2's present loop and green against the waiting
  loop, both runs recorded.
- After the move, the R2 and early-answer Recruit-held recipes above are run on both specs: no
  run ends with an extra monster.

## 3. zone-scope "A walks to the warp": no frame sampled before the warp

**Test.** `client/e2e/zone-scope.spec.ts`, "A walks to the warp with B standing in zone 1: B is
held before the warp, undrawn, and is in A's characters on the first frame A draws zone 1 …".

**Run.** 43690080900 attempt 1 (PR #791, shard 5 of 5, 2026-11-15). The run has had no rerun. The
PR changes one file under `docs/` on top of `5fdc4712`, whose own `master` run (43683515399)
passed, so the same code was green once and red once.

**Signature.**

```
Error: ANTI-VACUITY: frames were sampled on both sides of the warp

expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

The test starts a `requestAnimationFrame` sampler, steps A onto the warp, and looks for the first
sampled frame that draws zone 1. Index 0 means the first frame the sampler recorded already drew
zone 1: no frame was recorded on the zone 0 side. The assertion the test is about (B's row is in
the store on that frame) was not reached.

**Cause.** Not studied; no recipe was run. A first reading, unmeasured: the sampler's first
callback ran after the warp had been drawn, which needs animation frames to stall for longer than
the step takes to land.

**Next step.** A study of the trace this run kept: artifact `e2e-failure-5-1` of run
43690080900, until 2026-11-29.

## 4. remote-walk np-a.9: the sprite stands still past its bound

**Test.** `client/e2e/remote-walk.spec.ts`, "with a step every other tick and an Idle …"
(np-a.9).

**Runs.** 43637897095 attempt 1 (PR #780) and 43648331632 attempt 1 (`master` `630369c3`), both
2026-11-14; each passed on attempt 2.

**Cause.** Not studied here. Its row reads it as the arrival jitter of steps on CI against a
timing threshold.

**Next step.** Its own row, `R-np-a-flake`.

## Rerun census, 2026-11-15T00:00Z to 11:56Z

Method: every CI run created from 2026-11-15T00:00Z, read at 2026-11-15T11:56Z
(`actions/runs?created=>=2026-11-15T00:00:00Z`). A run with `run_attempt` above 1 is a rerun, and
its attempt 1 jobs name the tests that failed. A failed run with no rerun is read for a tree that
was green on another run.

| Runs | Passed | Cancelled | Failed | Rerun |
|---|---|---|---|---|
| 27 | 24 | 2 | 1 | 0 |

No test failed on attempt 1 and passed on a rerun in the window: no run was rerun, and the rerun
listing in the `e2e` job lists nothing. The two cancelled runs are earlier pushes of PR #791 with
no failed test.

| Test | Run | What happened | Mapped to |
|---|---|---|---|
| `zone-scope.spec.ts` "A walks to the warp" | 43690080900 | failed once, not rerun, on code that was green on run 43683515399 | entry 3 |

## Follow-up rows

| Entry | Row | Lifts when |
|---|---|---|
| 1 | `R-th-1-RENAME-HIDDEN` | the rename test is next listed as passed on a rerun |
| 2 | `R-th-1-RECRUIT-LASTTURN` | `th-7` merges |
| 3 | `R-th-1-ZONESCOPE-FRAMES` | the zone-scope test is next listed as passed on a rerun, or a study of the kept trace names a cause |

Entry 4's row, `R-np-a-flake`, lifts with its own follow-up.
