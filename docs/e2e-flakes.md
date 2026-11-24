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
| 3 | `R-th-1-ZONESCOPE-FRAMES` | the zone-scope test is next listed as passed on a rerun, or a study of the kept trace names a cause |

Entry 4's row, `R-np-a-flake`, lifts with its own follow-up.
