# 0172 — Test-integrity residuals and movement-rejection diagnostics

**Status:** Accepted
**Date:** 2026-08-01
**Slice:** 11r-h (M-postgate-eleventh-review-residuals — test-integrity & diagnostics residuals; EARS E1-1..E1-2, E2-1..E2-3, E3-1..E3-4, E4-1..E4-4, E5-1..E5-9)
**Supersedes:** —
**Amends:** ADR-0130, ADR-0157
**Subsystems:** ci-gates, client-ui, movement-netcode
**Decision:** De-vacuify three assertions (RT-SZ-02, F-5f, the M14d weather pin), add a grantBait revival tripwire for R4, and trace movement rejections into the F9 bundle via a rate-limited, overlay-filtered breadcrumb plus a dev fate line.

## Context

The eleventh-review residuals spec batches five test-integrity and diagnostics items into
slice 11r-h. Four are gates that do not bite and one is a blind spot:

1. **RT-SZ-02** (`client/src/net/switchZoneAtomicity.test.ts`) was `expect(true).toBe(true)`
   under a prose header that declared itself "a documentation test — no assertion required".
2. **`rt_w14_valid_01_validate_content_weather_guard_is_vacuous`**
   (`game-core/src/combat/redteam_m14d_weather_desync.rs`) documented a kill condition —
   `let _valid = matches!(…)` in `content.rs` — that **no longer exists**. `content.rs:824-834`
   is now an exhaustive `match` with no wildcard arm. The test's name and 25-line rationale
   asserted a defect the codebase had already fixed.
3. **F-5f** (`client/src/main.wiring.test.ts`) wrapped its assertions in `if (gateIdx >= 0)`
   and closed with a trailing `expect(true).toBe(true)` — so a deleted DEV gate made the whole
   test pass silently.
4. **R4** (`client/e2e/recruit.spec.ts:1004`) is a `test.fixme` whose stated revival condition
   ("a client/src slice exposes `__game().grantBait(itemId, qty)`") sits outside
   `spec-gap-revival`'s existing expiry and dev_reducers tripwires, so the hook could land
   with the test staying parked forever.
5. **Movement rejections were invisible.** `main.ts`'s `enqueueMove` `.catch` repaired
   prediction and returned; an F9 bug bundle from a rubber-banding player showed nothing at all.

Two facts discovered during plan review reshaped the work and are recorded here because they
are non-obvious and were both load-bearing errors in the first draft.

## Decision

### D1 — Breadcrumb rate limit: 3 s minimum gap, session cap 16, inclusive count carried

`errorRing` is a 64-slot FIFO (`client/src/ui/errorRing.ts:11`) whose primary duty is holding
crash records for the F9 bundle. A per-rejection breadcrumb would flush it: a rubber-band
episode at the observed ~5 rejections/second destroys the ring in ~13 seconds. A minimum-gap
throttle alone reduces the rate but stays unbounded — 192 s of continuous rejection still
evicts everything. So the policy is **both**: `{ minGapMs: 3_000, cap: 16 }`, with the number
of rejections since the previous breadcrumb (inclusive of the emitted one, labelled `count=`)
and the breadcrumb index (`breadcrumb=k/16`) carried in the message, so magnitude survives
suppression and truncation self-announces without an extra branch.

**The honest counter-argument, accepted:** the cap has no decay. A benign episode in minute 1
permanently occupies 16/64 = 25 % of the ring and permanently disables movement diagnostics for
a genuine incident in minute 60. Accepted because the remaining 48 slots are reserved for the
crash records the bundle exists to carry. Revisit if a playtest bundle is ever observed to be
breadcrumb-starved.

**Correction to an earlier draft of this ADR** (it claimed the cap was safe partly because "the
console fate line stays complete for the whole session"): that is FALSE in the build where it
matters. `resolveDevLogLevel(undefined, …)` returns `'off'`, `makeFateLogger` returns `undefined`
at `'off'`, and the call site is `fateLogger?.(…)` — so a playtester, who will not have
`VITE_MR_DEVLOG` set, gets no fate lines at all. Past breadcrumb 16 there is therefore **no
record of movement rejections anywhere** in a default playtest build: `moveRejectLimit.pending`
keeps counting but is never emitted and never read. The cap is still the right call against ring
flooding, but this is the accurate statement of its cost, and closing it (a single
cap-exhaustion breadcrumb carrying the final count) is a named follow-up below.

The clock is `performance.now()` (monotonic), not `Date.now()` — `main.ts` already uses it on
the movement path. `rateLimitTick` is nonetheless specified to treat a backwards clock jump as
"emit", never as "suppress forever", and that case is unit-tested.

### D2 — Fate lines ignore the noisy-reducer filter (deliberate asymmetry with sends)

`shouldLogReducer` excludes `enqueueMove` at level `'send'` because sends run ~5/second while
walking. A **rejection** is rare and is precisely the event a developer who turned the log on
wants to see. Routing fates through the send policy would hide the one interesting
`enqueueMove` line at the default level unless the developer also opted into the 5/s flood —
the filter would suppress signal, not noise. `makeFateLogger` therefore gates on
`level !== 'off'` only. This asymmetry is recorded explicitly so a future reader does not
"fix" it by delegating to `shouldLogReducer`.

Residual: a pathological server could make rejections frequent. The fate sink is the dev
console (unbounded, DEV-only, never the bundle), so the cost is bounded to console spam.

### D3 — The breadcrumb is bundle-bound but overlay-filtered, in `main.ts`

**The first draft was wrong** and the error is worth recording. It claimed a direct
`errorRing.push(…)` "bypasses the overlay". It bypasses the *synchronous* render, not the
overlay: `errorRing` **is** the overlay's data source. `main.ts:596-599` renders
`buildErrorOverlayModel(errorRing.snapshot())` on the *next* unrelated error, and
`errorOverlayModel.ts:24` shows the newest 8 records. A raw breadcrumb would therefore
(a) surface movement rejections to the player — exactly what M2 §3 forbids — and (b) with a cap
of 16 > displayCap of 8, evict every genuine error from the visible window.

Resolution, entirely inside the slice's touch-set: the breadcrumb still enters `errorRing` (so
it reaches the F9 bundle, which is the whole point), and `pushError`'s render call filters it
out by message prefix:
`buildErrorOverlayModel(errorRing.snapshot().filter((r) => !r.message.startsWith(MOVE_REJECT_PREFIX)))`.
A single `MOVE_REJECT_PREFIX` const is read by both the formatter and the filter, pinned by a
source-scan tooth so the two sites cannot drift apart.

Rejected alternatives: a dedicated `ErrorSource: 'movement'` variant (fans out to
`errorRing.ts`, `errorOverlayModel.ts`, `bugBundle.ts` and three test files — outside this
slice's declared touch-set, and the fan-out buys nothing the prefix filter does not); and
capping breadcrumbs below `displayCap` (reduces but does not remove the visibility).

`pushError` was previously the sole writer to `errorRing`. This slice adds a second, deliberately
overlay-free writer. That is a real amendment to ADR-0130's funnel and is why it is written down.

### D4 — `noteMoveRejection` must be total

The helper runs inside a rejection `.catch`. If it throws, the handler's promise rejects, which
reaches `main.ts:609`'s `unhandledrejection` listener, which calls `pushError`, which **shows
the overlay** — turning a silent movement rejection into the user-visible error M2 §3 forbids.
The body is therefore wrapped in `try { … } catch { }`, mirroring the identical guarantee
`devLog.ts`'s send sink already gives ("a throwing sink must NEVER take the game down"), and a
tooth pins it — including the ORDERING (the `try` opens before every throwing call and the
`catch` closes after all of them), because a decorative `try { void 0; } catch {}` parked after
the real work satisfies a presence-only scan while leaving the failure path fully open.

Scope note: this makes `noteMoveRejection` total. The two statements that precede it in the
`.catch` — `predictor.dropRejected(seq, epoch)` and `reconcileFromStore()` — are outside any
`try` and always were; `reconcileFromStore` is total by construction (its own internal
try/catch, the 12.5c-4 no-throw contract). This decision does not change that, and does not
claim to.

### D5 — Item 2: rewrite as a positive pin, not delete; plus a negative control

`validate_content` is called by 56 sites including `sync_content_inner`, and "content
validation accepts every weather-setting skill" is a live invariant that nothing else pins —
the other `validate_content` tests all pin *rejections*. Deleting would remove a lie at the
cost of leaving real behaviour unguarded, so the test is rewritten: renamed to
`rt_w14_valid_01_validate_content_accepts_every_weather_kind`, widened from Rain-only to a
table over **all four** `WeatherKind` variants, one skill per iteration so the failure message
can name the variant.

A positive `is_ok()` pin over inputs that structurally cannot be rejected is barely stronger
than the vacuity it replaces — the whole-function mutant `validate_content(..) { Ok(()) }`
survives it. The rewrite therefore includes a **negative control** in the same table: a
weather-setting skill that is independently invalid, asserted `is_err()`. That proves the
fixture actually reaches the skill-validation loop.

Honest limitation: no runtime test can red the replacement of the exhaustive `match` with a
`_ => {}` wildcard. That arm is compiler-enforced only, and the doc-comment now says so instead
of claiming a runtime gate.

### D6 — Item 1 anchor placement, and what actually pins RT-SZ-02

The seeding-reconcile assertion stays under the RT-SZ-02 anchor in
`switchZoneAtomicity.test.ts` rather than moving to `predictor.test.ts` (whose `:117` case
already covers the *empty-queue* seeding reconcile). The RT-SZ-02 version is deliberately
stronger: its `authQueue` is non-empty and the reconcile's own drain **advances the predicted
tile**, so it asserts both `diverged === false` *and* the moved tile — which is what stops
"false because nothing happened" from being a new flavour of vacuous pass. A contrast case
(a genuinely diverging reconcile returns `true`) kills the always-`false` mutant.

Recorded because it is the subtle part: **a `Predictor` unit test does not pin RT-SZ-02's
actual subject.** RT-SZ-02 is about the *batch listener* falling through to reconcile after a
zone switch (the pre-8c18860 behaviour was an unconditional early `return`). So the slice also
adds a source-scan tooth over the region between the zone-mismatch branch and the
`predictor.reconcile(` call, asserting the only `return` there is the guarded e-2/M13.5e
failed-switch form. A naive "no `return` after `switchZone`" tooth would have been wrong —
that legitimate guard exists at `main.ts:731`.

### D7 — The F-5 family's gate needle matched a comment

`main.ts:1699` is a **comment** containing the literal `if (import.meta.env.DEV)`, so
`src.indexOf('if (import.meta.env.DEV)')` — the computation used by every F-5 test — returned
the comment, 147 lines above the real gate at `:1846`. Consequence: deleting the real DEV gate
(shipping the debug hooks into production bundles) left `gateIdx >= 0` passing. The family read
as a hard gate and was not one.

Fixed with one shared helper, `devGateIndex(src)`: the needle `'\nif (import.meta.env.DEV) {'`
against **comment-stripped** source, guarded by `expectUniqueAnchor`. All five siblings
(F-5a, F-5b, F-5c, F-5d, F-5e) are re-pointed at it along with F-5f — leaving two competing
definitions of "the gate index" side by side, one correct and one silently wrong, would have
been a worse SSOT violation than not touching them.

Verified, not assumed: the red-team pass re-ran the "delete the real DEV gate" mutation against
**origin/master's** copy of `main.wiring.test.ts` (6 passed / 0 failed — the hole is real) and
against this slice's copy (6 failed — closed).

F-5f itself becomes four falsifiable assertions with no conditional and no `expect(true)`:
the gate resolves; `).__mrBuild =` occurs exactly once; the gate **block** does not contain the
build stamp (containment, not index ordering — ordering false-fails on a correct repositioning
of the stamp above the gate, and goes vacuous when any top-level code is inserted before it);
and the gate block **does** contain all three DEV hooks. That states F-5f's real subject: the
three hooks are inside, the intentionally-ungated build stamp is outside.

### D8 — The `grantBait` revival tripwire and its accepted bypass vectors

A third detector joins `spec-gap-revival`'s existing expiry and dev_reducers tripwires,
mirroring their shape exactly: RED when `client/e2e/recruit.spec.ts` still carries a
`test.fixme` citing `grantBait` **and** any live line under `client/src/` names `grantBait`.
`recruit.spec.ts` is not edited — the token is already in its fixme prose.

Accepted bypass vectors, documented in the eval's own header as well as here:
- **The uncovered half of the anchor.** R4's condition reads "`__game().grantBait(itemId, qty)`
  **or equivalent** test-hook". A hook shipped as `grantItem`/`giveItem`/`debugGrant` satisfies
  the anchor and leaves this gate green. The detector covers the literal token only. Pinning the
  `__game()` snapshot key-set would close it and is flagged as a follow-up.
- `client/src/**/*.test.ts` is excluded — a unit test naming the hook is not an exposed hook.
- `client/src/module_bindings/**` is excluded: the SDK camelCases reducer names, so regenerating
  bindings from a `dev_reducers`-featured module would drop a `grantBait` into
  `module_bindings/grant_bait_reducer.ts` and fire on an event that is **not** the revival
  condition.
- **Both comment syntaxes are removed before the token test.** Block comments are stripped
  wholesale (reusing the m16.5a `stripBlockComments` scanner) and each surviving line is then
  truncated at its first `//`. The first implementation only handled line-prefixes, and the
  red-team pass measured it RED on two inputs that are exactly the sentence someone will write:
  a trailing `x(); /* deliberately no grantBait hook, see ADR-0172 */`, and a multi-line block
  whose continuation lines carry no leading `*` (biome does not force that prefix). Either one
  turns the whole `spec-gap-revival` eval red on a correct tree — and a false-alarming gate gets
  deleted rather than fixed, which is the failure this whole slice is about. Teeth GB2/GB2b/
  GB2c/GB2d cover all three comment forms. Accepted under-detection from the `//` truncation: a
  `//` inside a string literal earlier on the line hides the rest of that line.
- The directory walk uses `readdirSync(…, { withFileTypes: true })`. An unguarded `statSync`
  threw `ENOENT` on a dangling symlink and reddened the entire eval with a misleading "cannot
  walk client/src"; dirents also classify a symlink AS a symlink, so a linked directory cannot
  recurse and a linked file cannot drag in a target outside `client/src`.
- Extensions scanned are `.ts/.tsx/.mts/.cts/.js/.jsx`. `.mjs`/`.cjs` are deliberately excluded:
  every eval file is `.mjs`, and admitting that extension would let a symlink point this
  detector at its own fixtures.
- `evals/**` is never scanned, so the detector's own synthetic fixtures cannot self-trip it.
  Confirmed under symlink attack (`client/src/zz -> ../../evals` leaves the gate green).

A `GB-ANCHOR` tooth asserts the fixme still cites the token **today**; without it the tripwire
would go dormant the moment the prose is reworded. Its failure message instructs the reader to
delete the tripwire and its anchor together when R4 is finally revived.

## Consequences

- Three assertions that could not fail now can; two `expect(true)` sites (the only two in
  `client/src/**/*.test.ts`) are gone; one dormant revival condition has a tripwire.
- Movement rejections are traceable in an F9 bundle without becoming visible to the player.
- All rate-limit arithmetic lives in `devLog.ts` as a pure, unit-tested transition
  (`rateLimitTick`) taking an options object — `main.ts` is coverage-excluded, so leaving the
  counters there would have left three cheating implementations (omitted increment, swapped
  bare-`number` args, counter reset before formatting) invisible to every gate.
- `main.ts`'s wiring itself remains source-scanned rather than executed. That is the standing
  limitation of a coverage-excluded shell; this slice shrinks the unexecuted surface rather than
  removing it.
- Deliberately **not** built: a general vacuous-assertion class scanner over
  `client/src/**/*.test.ts`. It would guard against a future recurrence, not a currently-open
  defect (this slice removes both existing sites), and it is a clean cut — parked as a follow-up.
- Deliberately **not** built: an inbound-event logger. `formatFateLine` is shaped generically
  enough for one, but the obs-e caller does not exist and was not speculated into being.

### Named follow-ups (found by this slice's own red-team pass, deliberately out of scope)

1. **The durable fix for the item-5 teeth.** `noteMoveRejection` is a coverage-excluded shell
   function pinned by source scanning. The red-team pass wrote **eight** intent-breaking
   implementations that passed all 1827 client tests, all 74 evals and `tsc`: the ring push
   moved out of `if (tick.emit)`; `cap: 0` / `minGapMs: 0`; the prefix interpolated anywhere but
   position 0 (defeating the overlay filter's `startsWith`); a `|| true` filter; a decorative
   `try { void 0; } catch {}`; `moveRejectLimit = RATE_LIMIT_INITIAL`; `Date.now()`; and a
   block-bodied fate sink calling a hoisted `archiveDevLine` that pushes into the ring. **All
   eight now red** — the teeth were strengthened with ordering and verbatim assertions and each
   kill was re-measured. But the durable answer is to extract the helper's body into an
   injectable unit under `client/src/net/` (`makeMoveRejectRecorder({ fate, ring, clock,
   policy })`) and unit-test emit-guard / prefix / totality / state-carry executably, leaving
   `main.ts` with one call for the scan to pin. That needs a new file, which is outside this
   slice's declared touch-set.
2. **`W-DEVLOG-EAGER (c)` has the identical one-hop-indirection hole on the SEND side.** It
   scans `DEVLOG_RING_NEEDLES` only inside `makeSendLogger(`'s balanced-paren argument list, so
   a named helper defeats it exactly as it defeated the first draft of `W-11RH-FATE-SINK`. This
   is inherited, not introduced here, and its file region is outside this slice's scope. The
   same verbatim-sink pin fixes it.
3. **The `grantBait` tripwire's "or equivalent" half stays uncovered** (see D8). A
   `__game()`-key-set detector would close it.
4. **A cap-exhaustion breadcrumb** carrying the final suppressed count, so a default playtest
   build is not silent past breadcrumb 16 (see the correction in D1).
5. **`main.ts` is at ~50.3 % comments** and three source-scan teeth anti-vacuity-guard on
   `stripped.length > raw.length / 2`. Headroom after this slice is ~408 characters, and the
   failure message ("the block-comment strip bailed early") misdiagnoses the real cause. The
   guard should be structural (assert a known tail anchor survives the strip) rather than a size
   ratio — otherwise the next well-documented slice trips three teeth for the wrong reason.
6. **A vacuous-assertion class scanner** over `client/src/**/*.test.ts` (see above).
