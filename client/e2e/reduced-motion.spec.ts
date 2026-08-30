import { expect, test } from '@playwright/test';

// rb-20 (residual R-m23-s11-X11) — the browser-tier reduced-motion oracle.
// ADR-0219.
//
// SCOPE, STATED PLAINLY SO A LATER READER DOES NOT WIDEN IT (ADR-0219 D1). This
// tier covers the STYLESHEET arm of A11Y-27 — `client/src/styles.css:94-99`'s
// `.hp-fill` transition, neutralised by `@media (prefers-reduced-motion: reduce)`
// — and NOT the RENDERER arm.
//
// The stylesheet is loaded by a `<link rel="stylesheet" href="/src/styles.css">`
// in `client/index.html:12`, not a `.ts` import, so it applies on a bare
// `page.goto('/')` with no SpacetimeDB connection, no player join, and no RNG.
// Its whole mechanism IS the browser's media-query engine, which is exactly
// what happy-dom (`renderResolver.test.ts`) cannot model.
//
// The RENDERER arm is NOT gated here, and MEASURED, cannot be from this slice's
// `touches:`: `client/src/main.ts:2807` calls `resolver.resolve({ characters,
// ownEntityId, predicted, snapped, now, currentZoneId })` with no `reduceMotion`
// key, so `renderResolver.ts:83`'s `reduceMotion = false` parameter default
// applies on every frame of the shipped client, and `motionPreferenceFromWindow`
// (`client/src/render/motionPreference.ts`) has ZERO production importers. No
// browser oracle can turn that arm green until a `main.ts` call-site edit lands
// — ledger gate rb-20 RM-7, DEFERred to `backlog`. A test here asserting the
// renderer honours reduced motion would red permanently; one asserting today's
// behaviour would cement the bug. DO NOT relabel this tier "A11Y-27, gated" —
// that is precisely the false green ADR-0219 exists to prevent.
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
  // styles.css:95-99 is BOTH present AND matching (verified against a real
  // Chromium at authoring time; see RED-EVIDENCE.md).
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
