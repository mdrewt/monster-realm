import { expect, test } from '@playwright/test';

// rb-20 (residual R-m23-s11-X11) — the browser-tier reduced-motion oracle.
// ADR-0219.
//
// SCOPE, STATED PLAINLY SO A LATER READER DOES NOT WIDEN IT (ADR-0219 D1). This
// tier covers the STYLESHEET arm of A11Y-27 — `client/src/styles.css:91-99`'s
// `.hp-fill` transition, neutralised by `@media (prefers-reduced-motion: reduce)`
// — and NOT the RENDERER arm.
//
// The stylesheet is loaded by a `<link rel="stylesheet" href="/src/styles.css">`
// in `client/index.html:12`, not a `.ts` import, so it applies on a bare
// `page.goto('/')` with no SpacetimeDB connection, no player join, and no RNG.
// Its whole mechanism IS the browser's media-query engine, which is exactly
// what happy-dom (`renderResolver.test.ts`) cannot model.
//
// The RENDERER arm WAS not gated here at rb-20, and MEASURED, could not be fixed
// from that slice's `touches:`: `client/src/main.ts:2807` calls
// `resolver.resolve({ characters, ownEntityId, predicted, snapped, now,
// currentZoneId })` with no `reduceMotion` key, so `renderResolver.ts:83`'s
// `reduceMotion = false` parameter default applies on every frame of the
// shipped client, and `motionPreferenceFromWindow`
// (`client/src/render/motionPreference.ts`) has ZERO production importers.
//
// rb-38 adds the renderer-arm PAIR below as a DISCLOSURE artifact, not a green
// gate. `client/src/main.ts` is OUT OF SCOPE for rb-38 (same as it was for
// rb-20), so the fix cannot land in this slice either. The reduce-polarity test
// is EXPECTED TO RED on master, for exactly the missing-`reduceMotion`-key
// reason above (`window.__game().sawFractionalOwnMotion`, main.ts:254/1933,
// flips true because the own slide clock keeps gliding fractionally under the
// OS preference), and MUST keep reding until a successor slice wires the live
// preference into that `resolve()` call. DO NOT "fix" it by editing either new
// test to assert today's (broken) behaviour, and DO NOT relabel this tier
// "A11Y-27, gated" until the renderer-arm pair is actually green — that is
// precisely the false green ADR-0219 exists to prevent. The EXACTLY-TWO-TESTS
// accounting below (plan §6 finding 5) is scoped to the STYLESHEET arm only;
// the renderer-arm pair is separate and additional.
//
// WHY THE BUILT-IN `page` FIXTURE, NOT `chromium.launch()` + `browser.newContext()`
// (rb-19's shape in `a11y.spec.ts`, forced on it by `@axe-core/playwright`
// refusing a directly-created page). MEASURED (ADR-0219 D5, plan §6 finding 5):
// under a manually-created, SHARED context, `emulateMedia` set in one test leaks
// forward into every later test in the file — a live trap for the RM-7 follow-up
// this same file is the landing spot for. The `page` fixture is the Playwright
// path that actually applies the ACTIVE PROJECT's `use` options
// (`client/playwright.config.ts`'s `reduced-motion` project), and it hands each
// `test()` body a fresh context, so Test B's `emulateMedia` call cannot leak
// into Test A or into any later file the same project collects.
//
// EXACTLY TWO TESTS (plan-review outcome, ADR-0219, plan §6 finding 5). An
// earlier draft carried a third assertion pinning `matchMedia().media` against
// the `REDUCED_MOTION_QUERY` string constant — cut, because that constant lives
// on the DEFERRED renderer arm and is already triple-pinned elsewhere in the
// unit suite, and the typo'd-prelude case it targeted
// (`(prefers-reduced-motion)` with no `: reduce` value) is caught by the
// two-polarity pair below anyway: Chromium treats that prelude as truthy in
// BOTH polarities, so it would report the SAME `transitionDuration` in Test A
// and Test B, and the mirror-image assertion in Test B would catch it.

test('the reduced-motion project config reaches Chromium, and the @media guard is evaluated', async ({
  page,
}) => {
  // NO emulateMedia call anywhere above this line, and none follows it in this
  // test. That absence IS the gate: if this test called
  // `page.emulateMedia({ reducedMotion: 'reduce' })` here, it would stay green
  // even with `use: { contextOptions: { reducedMotion: 'reduce' } }` deleted
  // from `client/playwright.config.ts` entirely — which is to say it would gate
  // nothing about the PROJECT CONFIG the residual asks for (ADR-0219 D3 / D5).
  await page.goto('/');

  // 1) THE END-TO-END CLAIM. This can only read `true` because Chromium was
  // launched with `contextOptions.reducedMotion: 'reduce'` from the ACTIVE
  // PROJECT — nothing in this test file, and nothing in `client/index.html`,
  // sets it. If this reads `false`, either the `reduced-motion` Playwright
  // project (RM-1) is missing or misspelled, or the collection boundary (RM-2)
  // routed this spec to the wrong project.
  const matchesReduce = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    matchesReduce,
    'matchMedia("(prefers-reduced-motion: reduce)").matches was false. This assertion is the ' +
      'WHOLE end-to-end claim: it can only be true because of the `reduced-motion` Playwright ' +
      'PROJECT (client/playwright.config.ts, use.contextOptions.reducedMotion), never because of ' +
      'anything this test file does — it calls emulateMedia() nowhere. Either that project is ' +
      "absent/misspelled, or this spec ran under the wrong project (the 'default' project's " +
      "testIgnore and this project's testMatch are both required).",
  ).toBe(true);

  // 2) THE STYLESHEET REALLY LOADED — an INDEPENDENT probe that touches no
  // `.hp-fill` rule at all. Without this, a `'0s'` result in clause 3 below is
  // EXACTLY what "styles.css never loaded" also reports (the UA default
  // transition-duration is `0s`), so a bare `.hp-fill` assertion cannot tell
  // "the guard fired" from "nothing loaded". `.sr-only` (styles.css:57-67) has
  // no relationship to motion; its `position: absolute` applies
  // UNCONDITIONALLY, so this proves the <link> resolved and its rules apply at
  // all, independent of anything reduced-motion related.
  await page.evaluate(() => {
    const el = document.createElement('span');
    el.className = 'sr-only a11y-rb20-sronly-probe';
    document.body.appendChild(el);
  });
  const srOnlyProbe = page.locator('.a11y-rb20-sronly-probe');
  await expect(
    srOnlyProbe,
    'the .sr-only stylesheet rule (styles.css:57-67) did not apply `position: absolute` to an ' +
      'injected probe. This is the anti-vacuity clause: without it, the transitionDuration ' +
      'check below cannot distinguish "the reduced-motion guard fired" from "the stylesheet ' +
      'never loaded at all".',
  ).toHaveCSS('position', 'absolute');
  await page.evaluate(() => {
    document.querySelector('.a11y-rb20-sronly-probe')?.remove();
  });

  // 3) THE BEHAVIOUR. Inject a fresh `.hp-fill` probe — never a production
  // element; this spec joins no player and never opens the battle view — and
  // read its computed transition-duration. `'0s'` is the value Chromium reports
  // when the `@media (prefers-reduced-motion: reduce)` guard at
  // styles.css:95-99 is BOTH present AND matching. MEASURED, not assumed, against
  // this repo's pinned Chromium (playwright 1.61.1) over the real styles.css:
  //   reducedMotion 'reduce'        -> transitionDuration '0s',   transitionProperty 'none'
  //   reducedMotion 'no-preference' -> transitionDuration '0.3s', transitionProperty 'width'
  // and `.sr-only` computed `position: absolute` in BOTH, which is why clause 2
  // above is a valid stylesheet-loaded probe independent of the guard.
  const reducedDuration = await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'hp-fill';
    document.body.appendChild(el);
    const value = getComputedStyle(el).transitionDuration;
    el.remove();
    return value;
  });
  expect(
    reducedDuration,
    `getComputedStyle(.hp-fill).transitionDuration was '${reducedDuration}', expected '0s'. ` +
      'With clause 1 already true (the OS preference reached Chromium), a non-zero value here ' +
      'means the @media block at styles.css:95-99 was deleted, mis-scoped, or loses the cascade ' +
      "to the base rule — see ADR-0219 and rb-10/rb-17's cascade-order note at styles.css:76-80.",
  ).toBe('0s');
});

test('with the preference off, the same rule animates (the guard is conditional, not blanket)', async ({
  page,
}) => {
  // The mirror image (ADR-0219 D3 / plan §2.3 T3). This flips the OS preference
  // for THIS test's own, freshly-created context only — it cannot contaminate
  // the previous test, because the built-in `page` fixture gives every test() a
  // new context (see the file header: a shared `browser.newContext()`
  // measurably leaks `emulateMedia` forward, which is why this file does not
  // use one).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');

  const matchesReduce = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    matchesReduce,
    'matchMedia("(prefers-reduced-motion: reduce)").matches was true immediately after ' +
      "requesting emulateMedia({ reducedMotion: 'no-preference' }) — either emulateMedia is not " +
      'taking effect in this context, or a reduced-motion emulation from elsewhere is leaking in.',
  ).toBe(false);

  const noPreferenceDuration = await page.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'hp-fill';
    document.body.appendChild(el);
    const value = getComputedStyle(el).transitionDuration;
    el.remove();
    return value;
  });
  // THIS is the assertion the first test's clause 3 alone cannot substitute
  // for (ADR-0219 D3 / plan §2.3 T3). A '0s' result here — with the OS
  // preference explicitly OFF — is exactly what EACH of these wrong
  // implementations would also report on the FIRST test alone:
  //   * a stylesheet that never loaded (UA default transition-duration is 0s)
  //   * `transition: none` written on `.hp-fill` UNCONDITIONALLY, outside any
  //     @media block at all
  //   * a probe element that never actually entered the document
  //   * a typo'd @media prelude, e.g. `(prefers-reduced-motion)` with no
  //     `: reduce` value — Chromium treats that prelude as truthy in BOTH
  //     polarities, so it would report '0s' here too, identically to the first
  //     test, and only THIS mirror-image assertion tells the two apart
  // Only a rule that is genuinely CONDITIONAL on the media query reports the
  // authored, non-zero duration when the preference is off.
  expect(
    noPreferenceDuration,
    `getComputedStyle(.hp-fill).transitionDuration was '${noPreferenceDuration}' with ` +
      "reduced-motion explicitly OFF; expected '0.3s' (styles.css:91-93's base rule, `transition: " +
      "width 0.3s`). A '0s' result here means the guard is not actually CONDITIONAL on the media " +
      'query — see the wrong-implementation list in the comment above this assertion.',
  ).toBe('0.3s');
});

// ============================================================================
// rb-38 — THE RENDERER ARM (A11Y-27, EARS gate E1). Read the file header above
// FIRST — in particular the updated RENDERER ARM note it now carries.
//
// THIS PAIR IS A KNOWN-DEFECT DISCLOSURE, NOT A GREEN GATE. `client/src/main.ts`
// is OUT OF SCOPE for rb-38, so the fix cannot land here — but the CORRECT
// expectation can, and does. The reduce-polarity test below asserts what the
// renderer SHOULD do, as an ordinary test, with exactly ONE assertion wrapped in
// a narrow known-defect guard (see "THE KNOWN-DEFECT BOUNDARY" inside it).
//
// THE THREE IDIOMS CONSIDERED, AND WHY THE NARROW GUARD WON (rb-38 review):
//   * `test.fixme()` is this repo's existing idiom for a blocked-on-another-slice
//     e2e (`client/e2e/recruit.spec.ts:1008`), but it SKIPS — and `just a11y-e2e`
//     half 4 reds on `stats.skipped !== 0` by design, because "a skipped a11y
//     test is a silently ungated one". A fixme here would break the nightly tier.
//   * `test.fail()` was implemented and then REJECTED, on measured evidence. It
//     marks the WHOLE test body expected-to-fail, so it swallows every OTHER
//     failure too: with `window.__game` deleted (total boot failure) this test
//     reported `1 passed` in isolation under `test.fail()`. It converts the
//     test's own anti-vacuity clauses into decoration.
//   * THE NARROW `try`/`catch` GUARD actually used keeps every other assertion —
//     matchMedia, readiness, the fresh-latch precondition, the did-it-actually-
//     move check — as an ORDINARY HARD GATE that reds the build, while
//     tolerating the one known-broken assertion in the one direction that is
//     currently true. It keeps the load-bearing alarm property: **it flips to
//     RED the moment the bug is fixed**, forcing whoever wires
//     `motionPreferenceFromWindow()` into `client/src/main.ts:2807`'s
//     `resolver.resolve({...})` call to come back and delete the guard.
//
// DO NOT "fix" this by asserting today's behaviour (`.toBe(true)`). That would
// cement the bug and is exactly the false green ADR-0219 exists to prevent.
// The ledger gate (rb-38 E1) stays DEFERred until the wiring lands: this pair
// documents and detects the gap, it does not close it.
//
// KNOWN LIMIT OF THE ALARM, STATED SO IT IS NOT MISTAKEN FOR COVERAGE (rb-38
// red-team finding 2, MEASURED). The alarm watches the OWN-entity render path
// only. A PARTIAL fix that wires `reduceMotion` correctly but honours it solely
// on `renderResolver.ts`'s REMOTE-character branch produces a real, user-visible
// change and yet NO signal here — measured `expected=4 unexpected=0`, identical
// to an untouched tree. Covering the remote branch needs a second joined player,
// which collides with `golden.spec.ts`'s exact `presenceCount === 2` assertion,
// so it is deliberately out of scope for this file. Do not read a green run here
// as "reduced motion is fully handled".
//
// THE OBSERVABLE: `sawFractionalOwnMotion` (`client/src/main.ts:254`, read via
// `window.__game()` at `client/src/main.ts:1933`) — a STICKY DEV latch the
// frame loop itself sets the first time the own character's RESOLVED render
// position is not an integer tile (`client/src/main.ts:2815-2830`, the "sticky
// latch" comment). Only the own slide clock's `positionAt`
// (`client/src/render/slideClock.ts:42-48`) can produce a fractional value on
// that path — the predicted tile fed into `RenderResolver.resolve` is always an
// integer — so a `true` reading can ONLY have come from an in-flight slide
// interpolation frame. `renderResolver.ts:106-116` documents the exact
// mechanism this pins: `reduceMotion` forces `snapTo(tile, now)` EVERY frame,
// which sets `origin === target === tile`, so `positionAt` can never return a
// fractional value while it is honoured. The observable is a direct,
// load-bearing proxy for "did the renderer actually snap under reduced
// motion" — not an incidental side effect of something else.
//
// WHY `__game().step(dir)` AND NOT SYNTHETIC KEYBOARD (contrast with
// `movement-input.spec.ts`'s header, which explains why THAT file must use
// real keyboard events): that file exists to exercise `held`/keydown
// continuation gating, which is orthogonal to what this pair measures. `step()`
// bypasses `held` entirely but still drives the identical
// `predictor.enqueue -> resolver.resolve` path either way (the frame body at
// `client/src/main.ts:2793-2814` runs the same regardless of how the intent was
// sent), so it isolates the renderer claim from the input layer entirely.
//
// ANTI-VACUITY: `rendererArmReady()` requires a non-empty `identity` and a
// non-null `ownAuthTile` (the `movement-input.spec.ts` idiom, capped at the
// same 30s) before either test proceeds, and each test additionally asserts
// the own tile's x actually advanced by exactly one after `step('East')`.
// Without that second check, "sawFractionalOwnMotion is false" is exactly what
// "the character — or the whole game — never moved at all" would also report.
//
// WORLD FACT this pair depends on (same as `movement-input.spec.ts`, checked
// LOUD at runtime rather than assumed): zone 0's spawn tile is (1,1), and the
// y=1 row is a grass-free, walkable corridor for x=1..8, so a single East step
// from spawn can never wake a wild encounter — which would open the battle
// overlay and freeze the slide mid-test for a reason unrelated to reduced
// motion, and would be indistinguishable from "the renderer snapped".
// ============================================================================

interface RendererArmTile {
  x: number;
  y: number;
}

interface RendererArmMap {
  zone_id: number;
  width: number;
  height: number;
  walkable: boolean[];
  grass: boolean[];
}

interface RendererArmSnap {
  identity: string;
  stepMs: number;
  map: RendererArmMap;
  ownAuthTile: RendererArmTile | null;
  ownPredictedTile: RendererArmTile | null;
  sawFractionalOwnMotion: boolean;
}

type RendererArmPage = import('@playwright/test').Page;

/** DUPLICATED LOCALLY on purpose — the `client/e2e/` convention (see
 *  `movement-input.spec.ts`'s own note): every spec carries its own
 *  snapshot/ready() rather than importing a sibling spec's. */
const rendererArmSnap = (p: RendererArmPage): Promise<RendererArmSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => RendererArmSnap }).__game();
    return {
      identity: g.identity,
      stepMs: g.stepMs,
      map: g.map,
      ownAuthTile: g.ownAuthTile,
      ownPredictedTile: g.ownPredictedTile,
      sawFractionalOwnMotion: g.sawFractionalOwnMotion,
    };
  });

async function rendererArmReady(p: RendererArmPage): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => RendererArmSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Throws LOUD (never skips) if the tile one East of `t0` is not a walkable,
 *  grass-free tile in the LIVE zone map — the `corridorEastWest` precondition
 *  idiom from `movement-input.spec.ts`, trimmed to the single step this pair
 *  needs. */
function assertEastStepIsSafe(map: RendererArmMap, t0: RendererArmTile): void {
  const idx = t0.y * map.width + (t0.x + 1);
  if (map.walkable[idx] !== true || map.grass[idx] === true) {
    throw new Error(
      `world-fact precondition failed: (${t0.x + 1}, ${t0.y}) is not a walkable, grass-free ` +
        'tile in the live zone map — this pair assumes the documented zone-0 y=1 corridor ' +
        '(movement-input.spec.ts) and cannot safely take a single East step from spawn',
    );
  }
}

/** Step East once via the DEV hook (bypasses `held` — see the header note on
 *  why that is correct for THIS pair) and wait for authority to actually reach
 *  `(t0.x + 1, t0.y)`, with a stepMs-scaled settle margin afterwards so every
 *  intermediate render frame of the glide has had a chance to run. The
 *  waitForFunction timeout is swallowed ON PURPOSE (`movement-input.spec.ts`
 *  idiom): falling through to the explicit tile assertion in each test turns an
 *  opaque poll timeout into a precise expected/received diagnostic. */
async function rendererArmStepEastAndSettle(
  p: RendererArmPage,
  t0: RendererArmTile,
  stepMs: number,
): Promise<void> {
  await p.evaluate(() => {
    (window as unknown as { __game: () => { step: (dir: string) => void } }).__game().step('East');
  });
  await p
    .waitForFunction(
      (want: RendererArmTile) => {
        const g = (window as unknown as { __game: () => RendererArmSnap }).__game();
        const a = g.ownAuthTile;
        const q = g.ownPredictedTile;
        return (
          a !== null &&
          q !== null &&
          a.x === want.x &&
          a.y === want.y &&
          q.x === want.x &&
          q.y === want.y
        );
      },
      { x: t0.x + 1, y: t0.y },
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await p.waitForTimeout(Math.round(stepMs * 1.5));
}

test('RENDERER ARM (E1, KNOWN DEFECT — guarded): under the reduced-motion project, the own character NEVER renders a fractional sub-tile position', async ({
  page,
}) => {
  // NO emulateMedia call anywhere in this test — same load-bearing absence, and
  // for the identical reason, as the file's first stylesheet-arm test above
  // (design constraint 1, rb-38): the ENTIRE end-to-end claim rests on the
  // `reduced-motion` Playwright PROJECT (`client/playwright.config.ts`,
  // `use.contextOptions.reducedMotion: 'reduce'`) reaching the renderer, not on
  // anything this test body does. Calling `emulateMedia('reduce')` here would
  // keep this test green even with the project config deleted entirely.
  await page.goto('/');
  await rendererArmReady(page);

  // Sanity, same style as the file's first stylesheet-arm test's clause 1: if
  // this reads false, the project/collection wiring is broken and nothing
  // below can mean what it claims to about the RENDERER.
  const matchesReduce = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    matchesReduce,
    'matchMedia("(prefers-reduced-motion: reduce)").matches was false at the top of the ' +
      "renderer-arm test — the `reduced-motion` project's contextOptions never reached this " +
      'page, so a reading on sawFractionalOwnMotion below would prove nothing about the ' +
      'RENDERER honouring reduced motion (it could just as well be an ordinary context).',
  ).toBe(true);

  const before = await rendererArmSnap(page);
  expect(
    before.identity,
    'window.__game().identity was empty after rendererArmReady() resolved — the readiness wait ' +
      'is supposed to guarantee a live identity before any scenario runs',
  ).not.toBe('');
  expect(
    before.ownAuthTile,
    'ANTI-VACUITY precondition: window.__game().ownAuthTile was null after readiness — the own ' +
      'character row must be live before this test can claim anything about how it renders',
  ).not.toBeNull();
  expect(
    before.sawFractionalOwnMotion,
    'sawFractionalOwnMotion was already true on a FRESH page/context before any move was ' +
      'issued — either this context is not actually fresh (page-fixture isolation broke), or ' +
      "something moved the own character before this test's own step() call",
  ).toBe(false);

  // biome-ignore lint/style/noNonNullAssertion: asserted not-null immediately above
  const t0 = before.ownAuthTile!;
  assertEastStepIsSafe(before.map, t0);
  await rendererArmStepEastAndSettle(page, t0, before.stepMs);

  const after = await rendererArmSnap(page);
  // ANTI-VACUITY: the move must have actually happened. Without this, whatever
  // sawFractionalOwnMotion reads below is indistinguishable from "step()
  // silently failed" or "the game never actually processed the intent".
  expect(after.ownAuthTile, 'own authoritative tile went null mid-scenario').not.toBeNull();
  expect(
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null immediately above
    after.ownAuthTile!.x,
    `ANTI-VACUITY: a single East step() from (${t0.x}, ${t0.y}) must actually move the own ` +
      `character to x=${t0.x + 1}; observed x=${after.ownAuthTile?.x}. If this is not t0.x + 1, ` +
      "sawFractionalOwnMotion's value below (whatever it is) proves nothing about rendering, " +
      'because nothing was ever rendered in motion at all',
  ).toBe(t0.x + 1);

  // THE GATE (E1). EXPECTED TO RED on master: `client/src/main.ts:2807`'s
  // `resolver.resolve({...})` call passes no `reduceMotion` key, so
  // `renderResolver.ts:83`'s `reduceMotion = false` default applies, the own
  // slide clock's `setTarget` (not `snapTo`) arm runs every frame of this
  // step, and `positionAt` reports a fractional value at some point during the
  // STEP_MS glide — flipping this latch to `true` even though the OS-level
  // preference (clause above) was ON the whole time. A correct renderer wiring
  // (main.ts threading a live `motionPreferenceFromWindow()` read into
  // `reduceMotion`) forces `snapTo` every frame instead
  // (renderResolver.ts:106-116), so `positionAt` can only ever report the
  // exact integer target tile, and this latch would never flip.
  //
  // WRONG IMPLEMENTATIONS THIS ASSERTION KILLS, once a successor slice
  // attempts a fix: (a) reading `motionPreferenceFromWindow()` only ONCE at
  // startup instead of per-frame — undetectable by THIS specific assertion if
  // the initial read happens to be correct, but the current, permanently-false
  // wiring this red proves is today's actual state; (b) wiring a value that
  // never actually reaches the `reduceMotion` key of the resolve() call args
  // (e.g. computed but unused) — this assertion stays red, identically to
  // today; (c) any wiring that supplies `reduceMotion` correctly for the
  // remote-character branch (renderResolver.ts:125-153) while leaving the
  // OWN-entity branch (renderResolver.ts:93-124) on the `false` default — the
  // remote branch never touches this own-only latch, so a remote-only fix
  // leaves this exact assertion red.
  // THE KNOWN-DEFECT BOUNDARY. Everything above this point is an ORDINARY HARD
  // GATE — matchMedia, readiness, the fresh-latch precondition and the
  // did-it-actually-move check all red the build normally. ONLY the single
  // assertion below is tolerated, and only in the one direction that is
  // currently true.
  //
  // This is deliberately NOT `test.fail()` (rb-38 review finding). `test.fail()`
  // marks the WHOLE test body expected-to-fail, so it also swallows a broken
  // `__game()` hook, a boot failure, a readiness timeout, or a regression in any
  // anti-vacuity clause — all of which would report identically to the known
  // defect. MEASURED: with `window.__game` deleted entirely and the blanket
  // `test.fail()` in place, this test reported `1 passed` in isolation. The
  // narrow try/catch below cannot do that: a boot failure now throws out of
  // `rendererArmReady()` long before this line.
  let rendererHonoursReducedMotion: boolean;
  try {
    expect(after.sawFractionalOwnMotion).toBe(false);
    rendererHonoursReducedMotion = true;
  } catch {
    rendererHonoursReducedMotion = false;
  }
  expect(
    rendererHonoursReducedMotion,
    'THE RENDERER ARM IS FIXED — and this guard is now the only thing failing. That is BY ' +
      'DESIGN (rb-38): the renderer now honours the OS reduced-motion preference, so the ' +
      'known-defect disclosure is obsolete. DELETE this try/catch block and assert directly ' +
      "instead: `expect(after.sawFractionalOwnMotion, '<diagnostic>').toBe(false);`. Then " +
      'update the rb-38 E1 ledger gate from DEFERred to met, and drop the KNOWN-DEFECT wording ' +
      "from this file's header and from the justfile a11y-e2e half-4 comment. " +
      'CONVERSELY, if you are reading this because the value is `false` and you want it to ' +
      'stop failing: it is NOT failing — `false` is the passing value today. Do NOT invert the ' +
      'assertion above to accept fractional motion; that cements the bug and is exactly the ' +
      'false green ADR-0219 exists to prevent.',
  ).toBe(false);
});

test('RENDERER ARM mirror image: with the OS preference OFF, the own character DOES render fractional sub-tile motion (proves the pair is not vacuously all-snapped)', async ({
  page,
}) => {
  // Mirrors the file's second stylesheet-arm test: flips the OS preference for
  // THIS test's own fresh context only (page-fixture isolation — see the file
  // header's WHY-THE-BUILT-IN-page-FIXTURE note). This is design constraint 2
  // (rb-38): without this half of the pair, an "always snapped" implementation
  // — one that ignores the preference entirely and simply never glides the own
  // character — would pass the reduce-polarity test above for the wrong
  // reason, and nothing in this file would be able to tell the two apart.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await rendererArmReady(page);

  const matchesReduce = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  expect(
    matchesReduce,
    'matchMedia("(prefers-reduced-motion: reduce)").matches was true immediately after ' +
      "requesting emulateMedia({ reducedMotion: 'no-preference' }) — either emulateMedia is not " +
      'taking effect in this context, or a reduced-motion emulation from elsewhere is leaking in.',
  ).toBe(false);

  const before = await rendererArmSnap(page);
  expect(
    before.identity,
    'window.__game().identity was empty after rendererArmReady() resolved',
  ).not.toBe('');
  expect(
    before.ownAuthTile,
    'ANTI-VACUITY precondition: window.__game().ownAuthTile was null after readiness',
  ).not.toBeNull();
  expect(
    before.sawFractionalOwnMotion,
    'sawFractionalOwnMotion was already true on a FRESH page/context before any move was issued',
  ).toBe(false);

  // biome-ignore lint/style/noNonNullAssertion: asserted not-null immediately above
  const t0 = before.ownAuthTile!;
  assertEastStepIsSafe(before.map, t0);
  await rendererArmStepEastAndSettle(page, t0, before.stepMs);

  const after = await rendererArmSnap(page);
  expect(after.ownAuthTile, 'own authoritative tile went null mid-scenario').not.toBeNull();
  expect(
    // biome-ignore lint/style/noNonNullAssertion: asserted not-null immediately above
    after.ownAuthTile!.x,
    `ANTI-VACUITY: a single East step() from (${t0.x}, ${t0.y}) must actually move the own ` +
      `character to x=${t0.x + 1}; observed x=${after.ownAuthTile?.x}`,
  ).toBe(t0.x + 1);

  // THE MIRROR-IMAGE ASSERTION (design constraint 2, rb-38). This is the ONLY
  // thing in this pair that tells "the renderer genuinely reads and honours
  // the OS preference" apart from "the renderer ALWAYS snaps, unconditionally,
  // and reduced motion happens to never matter" — a wrong implementation that
  // would flip the FIRST test's assertion green for the wrong reason (e.g.
  // `reduceMotion` hardcoded `true`, or the own-clock branch rewritten to
  // always call `snapTo` regardless of any preference at all). With the OS
  // preference explicitly OFF, an UNCHANGED render pipeline (today's tree, and
  // any correctly-fixed future wiring) must still glide the own character
  // across the sub-tile positions between (t0.x, t0.y) and (t0.x + 1, t0.y)
  // over STEP_MS (`slideClock.ts:42-48`'s `positionAt` interpolation), so this
  // latch MUST flip to true.
  expect(
    after.sawFractionalOwnMotion,
    'sawFractionalOwnMotion was still false after a move with the OS reduced-motion ' +
      'preference explicitly OFF (matchMedia confirmed OFF above). A correctly functioning ' +
      'slide clock MUST glide through fractional sub-tile positions here (slideClock.ts:42-48). ' +
      '`false` means the own-entity render path is snapping to the target tile ' +
      'UNCONDITIONALLY, regardless of any reduced-motion preference at all — exactly the false ' +
      'green this mirror-image test exists to catch (an "always snapped" implementation would ' +
      'otherwise pass the reduce-polarity test above for the wrong reason).',
  ).toBe(true);
});
