# e2e flake register

The e2e tests that have failed on CI with no code defect behind the failure, and whose fix has
not merged. An entry gives the test, the runs, the signature, every forcing recipe tried with its
count, the verdict (product or test) and the change that closes it. The change that fixes an
entry deletes it.

| # | Test | State | Closes with |
|---|---|---|---|
| 1 | `ui-feedback.spec.ts` UIF4B.2 rename: the name field stays hidden after N | not reproduced | its next rerun listing |
| 2 | `tactics-wild.spec.ts` BT12-5-WILD-RECRUIT and `recruit.spec.ts` R2: a recruit reported as none | cause reproduced; half fixed | the follow-up slice below |
| 3 | `zone-scope.spec.ts` "A walks to the warp": no frame sampled before the warp | not studied | its next rerun listing |

## How the recipes were run

Commit `218e6020` of `master`, in a scratch worktree, on an AMD Ryzen 9 9950X (32 logical CPUs)
under WSL2. Headless Chromium under Playwright 1.61.1 against the Vite 6.4.4 dev client and a
SpacetimeDB 2.11.0 standalone host of its own, in memory, publishing the `dev_reducers` module.
One run is one fresh Playwright process on a freshly published database. No probe file is in the
repository; each recipe below says what it changes, which is enough to rebuild it.

A count reads "reproduced / runs". "Reproduced" means the run ended with the CI signature of
its entry, not merely that it failed.

## 1. UIF4B.2 rename: the name field stays hidden after N

**Test.** `client/e2e/ui-feedback.spec.ts`, "UIF4B.2 the rename frame: a valid rename's success
toast moves no box", in its first window (1280x720).

**Run.** 43554594387 attempt 1 (PR #770, shard 4 of 5, 2026-11-14). It is the first test of the
shard's first file. The same tree passed on attempt 2. Seen once.

**Signature.** After `page.goto('/')`, `ready()` (an identity and the own character are present),
a resize, `closeAll` and a hidden toast, the test presses the N accelerator and waits 10 s:

```
TimeoutError: page.waitForSelector: Timeout 10000ms exceeded.
  - waiting for locator('[data-testid="rename-input"]') to be visible
    24 × locator resolved to hidden <input type="text" maxlength="24" id="rename-input"
         data-testid="rename-input" aria-labelledby="rename-title"/>
```

**What the log fixes.** `aria-labelledby="rename-title"` is set by the `RenameView` constructor
and is absent from `index.html`. All 24 polls, the first a few milliseconds after the press, are
one collapsed line, so every poll saw a page with its views mounted. The test took 14.4 s, its
`beforeAll` included, so the press came about 4.4 s after it started.

**The one silent drop on this path.** `openAccelPath` (`client/src/main.ts`) returns without a
word while `identity === ''`, which holds from page load until the join lands; only the C
accelerator opens a frame there. The keydown is still `preventDefault`ed. A read of every gate
between the keydown and the visible field found no other silent drop on a joined page: the views
are mounted before `connect()`, no menu entry is disabled at the world, and nothing but a battle,
a conversation or a reconnect sweep pops a player frame.

**Attempts.**

| Recipe | Runs | Reproduced |
|---|---|---|
| Shard order: the file alone, its rename test first in a fresh process, the Vite dependency cache (`client/node_modules/.vite`) moved away before each run | 42 | 0 |
| The same steps in a tracing probe (a capture-phase keydown log, navigation, socket and page-error counts), cold cache | 1 | 0 |
| Tracing probe, cold cache, the whole process tree pinned to one core (`taskset -c 0`) | 12 | 0 |
| Tracing probe, Chromium CPU throttle 6x (`Emulation.setCPUThrottlingRate`) | 8 | 0 |
| Tracing probe, Chromium CPU throttle 20x | 8 | 0 |
| Tracing probe, timers held: from `ready` until after the result every `setTimeout` callback is parked | 10 | 0 |
| Held join: after `ready` the page is reloaded with server-to-page frames of the SpacetimeDB socket held (`page.routeWebSocket`), and N is pressed once `#rename-input[aria-labelledby]` is attached | 5 | 5 |
| Reload issued 0 ms before the test's own steps (`page.reload`, awaited to commit only), nothing held | 6 | 0 |
| Reload issued 100 ms before | 6 | 0 |
| Reload issued 200 ms before | 6 | 0 |
| Reload issued 300 ms before | 6 | 5 |
| Reload issued 450 ms before | 6 | 0 |
| Reload issued 700 ms before | 6 | 0 |

The two recipes that reproduce it inject the second document themselves. With the join held, all
5 runs gave the call log above to the character, the keydown log read `joined: false`, stack
`['world']` before and after, and a second N after the frames were released opened the field in
all 5. With a bare reload the outcome depends on where the press lands in the new document:

- 0 ms: `Execution context was destroyed` in the resize poll, 6 of 6.
- 100 ms: `closeAll: window.__game is missing`, 6 of 6.
- 200 ms: hidden for 10 s, but the call log has two lines (the first polls saw the field without
  its `aria-labelledby`), 6 of 6.
- 300 ms: the CI call log, 5 of 6; the field opened in the sixth.
- 450 ms and 700 ms: the page had joined again and the field opened, 12 of 12.

So on this machine the signature needs a reload that starts about 300 ms before the press. In the
39 probe runs with no injected reload the main frame navigated exactly once. Vite's own reload
sources (a dependency re-optimisation, a changed module with no HMR boundary, a changed `.html`,
`tsconfig` or config file, a lost HMR socket) were read from its server bundle; none fired in any
run, the cold cache already listed every dependency, and none has a known source in the CI job.

**Verdict.** Not reproduced. The signature is the press landing on a document that has mounted its
views and has not joined, and `ready()` rules that out for the document it saw; nothing found
replaces that document. Neither the product nor the test is shown wrong.

**Closes with.** Its next rerun listing by the `e2e` job. A failed shard keeps each failed test's
trace and the SpacetimeDB log for 14 days (`e2e-failure-<shard>-<attempt>`); neither run in this
register's first two entries had one. The trace answers one question. Two main-frame navigations
before the press: the cause is whatever reloaded the page, a test or environment fix. One
navigation and a press with `identity === ''`: the join was undone, a product fix, with the
held-join recipe as its red-first test.

## 2. A recruit on the last allowed own turn is reported as none

**Tests.** `client/e2e/tactics-wild.spec.ts` BT12-5-WILD-RECRUIT and `client/e2e/recruit.spec.ts`
R2. Each has its own copy of one loop, `fightToRecruit`: up to `MAX_OWN_TURNS` (16) own turns of
close in, weaken, Recruit; when the loop reports no recruit, its caller hunts another wild.

**Run.** 43362803625 attempt 1 (PR #751, shard 3 of 5, 2026-11-13), BT12-5-WILD-RECRUIT. The
shard passed on attempt 2. Seen once. R2 has not failed this way on CI.

**Signature.**

```
Error: expect(received).toBe(expected) // Object.is equality
Expected: 2
Received: 3
  - Timeout 15000ms exceeded while waiting on the predicate
> .poll(async () => (await readOwnMonsters(page)).length, { timeout: 15_000 }).toBe(2);
```

Three monsters are the starter and two recruits. The test ran 34.9 s: about 0.9 s of `beforeAll`,
19.0 s of body and the 15 s poll. A one-battle pass on the same tree ran 8.7 s.

**Cause.** In the tree that failed, the loop returned "no recruit" as soon as its sixteenth own
turn was spent. A Recruit pressed on that turn had not resolved yet. When its roll succeeded, the
battle ended with the wild recruited, the caller found nothing to flee, passed the results panel
and recruited a second wild. PR #752 made the BT12-5-WILD-RECRUIT loop wait for that turn before
it answers. R2's copy still returns `'stalled'` once the sixteenth turn is spent; its caller waits
for the turn, sees the battle finished, and keeps the `'stalled'` answer.

**Attempts.**

| Recipe | Runs | Reproduced |
|---|---|---|
| BT12-5-WILD-RECRUIT as on `master`, instrumented: a per-turn log and an in-page sampler of the tactical state on every macrotask for 2 s after each Recruit press | 19 | 0 |
| The same, Chromium CPU throttle 4x | 8 | 0 |
| The same, every server-to-page frame delivered 150 ms late, in order | 8 | 0 |
| The same, `MAX_OWN_TURNS` lowered to 6 | 12 | 0 |
| The same at 16, Recruit held: once the wild is weak and adjacent the loop takes no action until its last own turn and presses Recruit there | 6 | 0 |
| The failing tree's loop (answers once the bound is spent) on `master`'s product, `MAX_OWN_TURNS` lowered to 6 | 12 | 1 |
| The failing tree's loop at 16, Recruit held | 8 | 7 |
| R2 as on `master`, Recruit held in the first encounter | 12 | 5 |
| R2 with the loop waiting for its last turn, Recruit held in the first encounter | 12 | 0 |

What the rows show:

- **The failing tree's loop at 16.** 33 Recruit presses landed on the sixteenth own turn and 20
  succeeded. All 20 were answered "no recruit": 9 passed silently into the next hunt, and 11 made
  the caller's flee throw `fleeByButtons: the battle is Finished` (the roll landed between the
  caller's own-turn wait and its flee). The probe caught that throw and went on, so a run kept
  recruiting: 7 of 8 runs ended with three or four monsters. In the test as it stood, the first
  such press ends the run with one signature or the other.
- **The loop on `master` at 16.** 12 presses on the sixteenth turn, 6 succeeded, all 6 answered
  "recruited"; every run ended with two monsters.
- **Bound 6.** The failing tree's loop answered "no recruit" for a real recruit in 2 of 12 runs
  and one of them ended with three monsters; `master`'s loop caught 3 last-turn recruits in 12
  runs. PR #752 measured the same pair at a bound of 6 to 7: 15 of 80, and 0 of 75 with the wait.
- **R2 on `master`.** 9 of the 12 runs reached a Recruit on the sixteenth turn of the first
  encounter. In 5 it succeeded, the encounter was logged `stalled`, the next one recruited again,
  and the test failed `Expected: 2 Received: 3`. With the loop waiting, 8 of 12 runs reached that
  press, 5 succeeded and all 5 were logged `recruited`.
- **No other path.** Across the 73 tactics-wild probe runs the sampler saw 86 recruits land. Each
  arrived as one step: `Finished`, the wild `Recruited` and one more own monster together. A read
  of the helpers, the server's recruit path and the client store found no second way to two
  recruits: a success ends its battle in the same transaction, and a finished battle accepts no
  commit.

**Does the CI run fit.** Not shown, since no trace exists for it. What can be checked fits:

- Time. A kiting wild never lets the starter stand adjacent, so it draws no Recruit press (6 of 41
  battles played without forcing: all sixteen turns spent moving, 5.4 to 11.1 s for the four with
  no frame delay). A battle that reaches a Recruit on its sixteenth turn is attacks and failed
  recruits, about 0.2 s each here: a 3 s fight. The failing run's 19.0 s of body holds two results
  panels (3 s each in that tree), two hunts (median 1.5 s here), the board-art check and two
  fights.
- Rate. In 35 runs played without forcing, 79 Recruit presses, 35 succeeded (44 %); the first
  press fell on own turn 4 to 11 and the latest on 12. From those, a successful press on the
  sixteenth turn is about 1 battle in 480. CI saw one failure in the 197 runs created in the week
  up to PR #752 (2026-11-07 to 2026-11-13).
- The sibling signature (`fleeByButtons: the battle is Finished`) appears in none of the 20 failed
  job logs of that week that ran Playwright (25 runs, every attempt).

**Verdict.** The test is wrong, not the product: the loop answers before its last press resolves.
BT12-5-WILD-RECRUIT is fixed by PR #752. That this is what run 43362803625 hit is inferred: a
third monster on a rerun listing of BT12-5-WILD-RECRUIT after the follow-up below would refute it
and reopen this entry.

**Follow-up slice: `th-7`, the recruit loop has one home.** Test, not product.

- `touches:` `client/e2e/controls.ts`, `client/e2e/controls.spec.ts`,
  `client/e2e/recruit.spec.ts`, `client/e2e/tactics-wild.spec.ts`.
- The loop moves to `controls.ts` and both specs call it. It keeps R2's three answers and its
  press and HP bookkeeping, and BT12-5-WILD-RECRUIT's count of forecast attacks, as arguments; R2's
  caller reads `'stalled'` only after the last turn has been waited for. Neither spec keeps a
  local `fightToRecruit`.
- Forcing regression test: a fake-page case in `controls.spec.ts` (an in-page `__mrTactics`, no
  server) where a Recruit pressed on the last allowed own turn resolves only after the loop's last
  iteration; the loop answers `'recruited'`. It is run red against R2's present shape and green
  against the waiting shape, both recorded.
- After the move, the Recruit-held recipe is run on both specs: no run ends with an extra monster.

## 3. zone-scope "A walks to the warp": no frame sampled before the warp

**Test.** `client/e2e/zone-scope.spec.ts`, "A walks to the warp with B standing in zone 1: B is
held before the warp, undrawn, and is in A's characters on the first frame A draws zone 1".

**Run.** 43690080900 attempt 1 (PR #791, shard 5 of 5, 2026-11-15). The run has had no rerun. The
PR changes one file under `docs/` on top of `5fdc4712`, whose own `master` run (43683515399)
passed, so the same code was green once and red once.

**Signature.**

```
Error: ANTI-VACUITY: frames were sampled on both sides of the warp
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

**Closes with.** Its next rerun listing, or a study of the trace this run kept: artifact
`e2e-failure-5-1` of run 43690080900, until 2026-11-29.

## Reruns since 2026-11-15

Method: every CI run created from 2026-11-15T00:00Z, read at 2026-11-15T11:56Z
(`actions/runs?created=>=2026-11-15T00:00:00Z`); a run with `run_attempt` above 1 is a rerun, and
its attempt 1 jobs name the tests that failed; a failed run with no rerun is read for a tree that
was green on another run.

| Runs | Passed | Cancelled | Failed | Rerun |
|---|---|---|---|---|
| 27 | 24 | 2 | 1 | 0 |

No test failed on attempt 1 and passed on a rerun in the window: no run was rerun. The `e2e` job's
own listing of such tests shipped at 2026-11-15T09:06Z inside the window, and no run since has had
a rerun for it to list.

| Test | Run | What happened | Mapped to |
|---|---|---|---|
| `zone-scope.spec.ts` "A walks to the warp" | 43690080900 | failed once, not rerun, on code that was green on run 43683515399 | entry 3 |

## Follow-up rows

| Entry | Row | Lifts when |
|---|---|---|
| 1 | `R-th-1-RENAME-HIDDEN` | the rename test is next listed as passed on a rerun |
| 2 | `R-th-1-RECRUIT-LASTTURN` | `th-7` merges |
| 3 | `R-th-1-ZONESCOPE-FRAMES` | the zone-scope test is next listed, or its kept trace is read |
