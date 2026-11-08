import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressAccel, pressButton } from './controls';

// ui-controls.spec.ts — uif-13 (M-ui-foundation): the Controls frame on the kit and the text-size
// setting (UIF13.2 to UIF13.5), measured in Chromium at 1280x720.
//
// ORACLE RULE. Every expected size is a LITERAL derived from the one measured premise: at 1280x720 the
// UI scale is 1 and the root is 16px (ui-scale.spec.ts UIF2.4: rootPx 16, `--mr-ui-scale` "1"), so
// Large is exactly 24px, Extra large exactly 32px and Normal 16px again. The premise itself is asserted
// first (so a wrong viewport cannot satisfy the multiples). The root size is read with
// `getComputedStyle`; the inline root `font-size` must stay '' (an inline write would MASK the rem rule
// under test); `--mr-ui-scale` and `__game().stageScale` are compared as strings / numbers before and
// after, so the text size can never be a second scale calculation. Geometry claims (UIF13.5) compare
// measured rects with each other and with the viewport: no literal pixel is needed.
//
// WHAT IS PROVEN WHERE. The setting's pure parse / save / apply is displayPrefs.test.ts and the booted
// unit proof (property at once, storage, no renderer resize) is main.remap.test.ts; this file proves
// the two things only a real engine can: the CSS rule makes the root font-size follow the property
// (UIF13.3), and the saved size is already in force the first time the scaled chrome can show
// (UIF13.4: the first `--mr-ui-scale` write, and the first frame after it; frames before that write
// are Pixi's and the rem rule does not match yet, by design), and that the UI still fits at Extra
// large (UIF13.5).
//
// HYGIENE. Sorts after ui-chrome, before ui-feedback. ONE browser context, ONE player, closed in
// afterAll (a second context would add a presence row; golden.spec.ts asserts an exact count). The
// specs write `localStorage['mr.display']`; afterAll removes it. A reload re-joins as the same player.
// No fixed sleeps: every wait polls a bounded predicate.
//
// REDS AT MASTER: everything. There is no Display tab (RB RB lands on Shortcuts then Buttons), no
// `--mr-text-step` rule, and nothing reads `mr.display`.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
  navActive: string | null;
  stageScale: number | null;
}

/** The root font-size of the 1280x720 viewport at UI scale 1 (ui-scale.spec.ts UIF2.4 base case). */
const BASE_PX = 16;
const STORAGE_KEY = 'mr.display';
const LARGE_JSON = '{"v":1,"textStep":"large"}';
const XLARGE_JSON = '{"v":1,"textStep":"xlarge"}';
const NORMAL_JSON = '{"v":1,"textStep":"normal"}';

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    return g.stack.map(
      (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
    );
  });

const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().navActive);

const controlsActive = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document
        .querySelector('#controls-rows [aria-selected="true"]')
        ?.getAttribute('data-nav-key') ?? null,
  );

/** Down presses (each followed by a poll that the cursor moved) until `read` names `key`. */
async function downTo(
  p: Page,
  read: (p: Page) => Promise<string | null>,
  key: string,
  maxPresses: number,
  what: string,
): Promise<void> {
  for (let i = 0; i < maxPresses && (await read(p)) !== key; i += 1) {
    const before = await read(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => read(p), { message: `${what}: Down moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await read(p), `${what}: the cursor is on ${key}`).toBe(key);
}

interface RootRead {
  readonly px: number;
  readonly inlineFont: string;
  readonly scaleText: string;
  readonly stepText: string;
  readonly stage: number | null;
}

const readRoot = (p: Page): Promise<RootRead> =>
  p.evaluate(() => {
    const root = document.documentElement;
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      px: Number.parseFloat(getComputedStyle(root).fontSize),
      inlineFont: root.style.fontSize,
      scaleText: root.style.getPropertyValue('--mr-ui-scale'),
      stepText: root.style.getPropertyValue('--mr-text-step'),
      stage: g.stageScale,
    };
  });

const stored = (p: Page): Promise<string | null> =>
  p.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);

/** Seed (or remove) `mr.display` through the page's real localStorage, then reload and wait for the
 *  player to be back in the world. */
async function seedAndReload(p: Page, value: string | null): Promise<void> {
  await p.evaluate(
    ([key, v]) => {
      if (v === null) window.localStorage.removeItem(key as string);
      else window.localStorage.setItem(key as string, v);
    },
    [STORAGE_KEY, value] as const,
  );
  await p.reload();
  await ready(p);
}

/** Start, Options, A, Down to Controls, A: the Controls frame above the menu (ui-feedback.spec.ts). */
async function openControls(p: Page, label: string): Promise<void> {
  await closeAll(p);
  await pressButton(p, 'Start');
  await expect
    .poll(() => stackNames(p), { message: `${label}: Start opens the menu` })
    .toEqual(['world', 'menuView']);
  await downTo(p, navActive, 'options', 8, `${label}: the main menu`);
  await pressButton(p, 'A');
  await pressButton(p, 'Down');
  await expect
    .poll(() => navActive(p), { message: `${label}: Down moves onto Controls` })
    .toBe('controls');
  await pressButton(p, 'A');
  await expect
    .poll(() => stackNames(p), { message: `${label}: A opens Controls over the menu` })
    .toEqual(['world', 'menuView', 'controlsView']);
  await expect(p.locator('#controls-overlay'), `${label}: Controls is shown`).toBeVisible();
}

/** Controls, then RB RB onto the Display tab (cursor on Normal). */
async function openDisplay(p: Page, label: string): Promise<void> {
  await openControls(p, label);
  await pressButton(p, 'RB');
  await expect(
    p.locator('#controls-tab-shortcuts'),
    `${label}: RB reaches Shortcuts`,
  ).toHaveAttribute('aria-selected', 'true');
  await pressButton(p, 'RB');
  await expect(
    p.locator('#controls-tab-display'),
    `${label}: RB RB reaches Display`,
  ).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => controlsActive(p), { message: `${label}: on Normal` }).toBe('normal');
}

const rowHeight = (p: Page, key: string): Promise<number> =>
  p.evaluate((k) => {
    const el = document.querySelector(`#controls-rows [data-nav-key="${k}"]`);
    if (el === null) throw new Error(`no Display row ${k}`);
    return el.getBoundingClientRect().height;
  }, key);

/** Everything wrong with how `selector`'s element sits on screen: no box, outside the viewport, outside
 *  any container named in `inside`, outside ANY ancestor whose computed overflow is not `visible`
 *  (it would be clipped there), covered at its centre by something that is not itself or its own
 *  descendant, or text wider than its own box. An empty list means unclipped. */
const clipProblems = (
  p: Page,
  selector: string,
  inside: readonly string[] = [],
): Promise<string[]> =>
  p.evaluate(
    ([sel, containers]) => {
      const el = document.querySelector(sel as string);
      if (!(el instanceof HTMLElement)) return [`${sel}: not on the page`];
      const EPS = 0.5;
      const out: string[] = [];
      const r = el.getBoundingClientRect();
      const name = (n: Element): string =>
        `${n.tagName.toLowerCase()}${n.id === '' ? '' : `#${n.id}`}${
          typeof n.className === 'string' && n.className !== ''
            ? `.${n.className.split(' ')[0]}`
            : ''
        }`;
      const within = (box: DOMRect): boolean =>
        r.left >= box.left - EPS &&
        r.right <= box.right + EPS &&
        r.top >= box.top - EPS &&
        r.bottom <= box.bottom + EPS;
      if (r.width <= 0 || r.height <= 0) out.push('has no box');
      if (!within(new DOMRect(0, 0, window.innerWidth, window.innerHeight))) {
        out.push(`outside the viewport (${r.left},${r.top},${r.right},${r.bottom})`);
      }
      for (const c of containers as readonly string[]) {
        const box = document.querySelector(c);
        if (box === null) out.push(`container ${c} is not on the page`);
        else if (!within(box.getBoundingClientRect())) out.push(`outside ${c}`);
      }
      for (let a = el.parentElement; a !== null; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        if (!within(a.getBoundingClientRect())) {
          out.push(`clipped by ${name(a)} (overflow ${cs.overflowX}/${cs.overflowY})`);
        }
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !(hit === el || el.contains(hit))) {
        out.push(`covered at its centre by ${hit === null ? 'nothing' : name(hit)}`);
      }
      if (el.scrollWidth > el.clientWidth + 1) {
        out.push(`text wider than its box (${el.scrollWidth} > ${el.clientWidth})`);
      }
      return out;
    },
    [selector, inside] as const,
  );

/** Poll (bounded) until `selector` is unclipped: a cursor move scrolls the row into view, which may
 *  land a frame later. */
async function expectUnclipped(
  p: Page,
  selector: string,
  what: string,
  inside: readonly string[] = [],
): Promise<void> {
  await expect
    .poll(() => clipProblems(p, selector, inside), { message: what, timeout: 5_000 })
    .toEqual([]);
}

test.describe
  .serial('UIF13 — the Controls frame on the kit and the text-size setting, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      // The scaled-chrome probe (UIF13.4): on EVERY navigation of this context, (a) a MutationObserver
      // on the root's `style` attribute records {scale, step, px} after every style mutation, and (b) a
      // requestAnimationFrame wrapper records the first callback at which `--mr-ui-scale` is
      // non-empty (the first frame the uif-2 rem rule applies, so the first frame the scaled chrome
      // can show). Frames before that write (Pixi's ticker) are deliberately not measured: the rule
      // does not match until `--mr-ui-scale` is written, by design (UIF2.6). Registered before the
      // first goto so no navigation escapes it.
      await ctx.addInitScript(() => {
        type Rec = { scale: string; step: string; px: number };
        const w = window as unknown as { __mrStyleRecords?: Rec[]; __mrScaledFrame?: Rec };
        const records: Rec[] = [];
        w.__mrStyleRecords = records;
        const snap = (): Rec => {
          const root = document.documentElement;
          return {
            scale: root.style.getPropertyValue('--mr-ui-scale'),
            step: root.style.getPropertyValue('--mr-text-step'),
            px: Number.parseFloat(getComputedStyle(root).fontSize),
          };
        };
        const watch = (root: HTMLElement): void => {
          new MutationObserver(() => {
            records.push(snap());
          }).observe(root, { attributes: true, attributeFilter: ['style'] });
        };
        if (document.documentElement !== null) {
          watch(document.documentElement);
        } else {
          const boot = new MutationObserver(() => {
            if (document.documentElement !== null) {
              boot.disconnect();
              watch(document.documentElement);
            }
          });
          boot.observe(document, { childList: true });
        }
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
          original((t) => {
            if (w.__mrScaledFrame === undefined && document.documentElement !== null) {
              const s = snap();
              if (s.scale !== '') w.__mrScaledFrame = s;
            }
            cb(t);
          });
      });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      try {
        await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY);
      } finally {
        await browser.close();
      }
    });

    interface Rec {
      readonly scale: string;
      readonly step: string;
      readonly px: number;
    }
    const probe = (): Promise<{ records: Rec[]; scaledFrame: Rec | undefined }> =>
      page.evaluate(() => {
        const w = window as unknown as { __mrStyleRecords?: Rec[]; __mrScaledFrame?: Rec };
        return { records: w.__mrStyleRecords ?? [], scaledFrame: w.__mrScaledFrame };
      });

    /** The UIF13.4 oracle: when `--mr-ui-scale` is first non-empty (in the style mutations, and at the
     *  first frame the rule applies) the step is already `step` and the root is already `px`; and no
     *  record anywhere has the chrome scaled while the step is still empty. */
    async function expectStepBeforeScaledChrome(
      label: string,
      step: string,
      px: number,
    ): Promise<void> {
      const { records, scaledFrame } = await probe();
      expect(records.length, `${label}: at least one style mutation was seen`).toBeGreaterThan(0);
      const firstScaled = records.find((r) => r.scale !== '');
      expect(firstScaled, `${label}: a mutation wrote --mr-ui-scale`).toBeDefined();
      expect(firstScaled?.step, `${label}: (a) the step is set when the scale first lands`).toBe(
        step,
      );
      expect(
        firstScaled?.px,
        `${label}: (a) the root is stepped when the scale first lands`,
      ).toBeCloseTo(px, 3);
      expect(
        records.filter((r) => r.scale !== '' && r.step === ''),
        `${label}: the chrome is never scaled without the step`,
      ).toEqual([]);
      expect(scaledFrame, `${label}: a frame ran with the scale written`).toBeDefined();
      expect(scaledFrame?.step, `${label}: (b) the step at the first scaled frame`).toBe(step);
      expect(scaledFrame?.px, `${label}: (b) the root at the first scaled frame`).toBeCloseTo(
        px,
        3,
      );
    }

    test('UIF13.2 the Display tab is reached by the D-pad and A in the real frame: RB RB from Buttons, three rows, Down walks them, A on Large moves the current mark to it', async () => {
      // WRONG IMPL KILLED: a Display tab the shoulder buttons cannot reach; rows that are not the
      // three steps in order; a current mark that does not follow A; a Display strip tab that is not
      // selected after RB RB.
      await seedAndReload(page, null);
      await openDisplay(page, 'display');
      await expect(page.locator('#controls-tabs [role="tab"]'), 'three tabs').toHaveCount(3);
      await expect(
        page.locator('#controls-rows [data-nav-key]'),
        'the three steps, no Reset all',
      ).toHaveCount(3);
      await expect(page.locator('#controls-rows [data-nav-key="normal"]')).toHaveText(
        'Text size: Normal (current)',
      );
      await expect(page.locator('#controls-rows [data-nav-key="large"]')).toHaveText(
        'Text size: Large',
      );
      await expect(page.locator('#controls-rows [data-nav-key="xlarge"]')).toHaveText(
        'Text size: Extra large',
      );
      await downTo(page, controlsActive, 'large', 2, 'display');
      await pressButton(page, 'A');
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              [...document.querySelectorAll('#controls-rows [data-current]')].map((e) =>
                e.getAttribute('data-nav-key'),
              ),
            ),
          { message: 'A on Large marks Large current, and only Large' },
        )
        .toEqual(['large']);
      await expect(page.locator('#controls-rows [data-nav-key="large"]')).toHaveText(
        'Text size: Large (current)',
      );
      await expect(page.locator('#toast'), 'the outcome is toasted').toHaveText(
        'Text size: Large.',
      );
    });

    test('UIF13.3 choosing a size scales the root font-size by exactly that factor with the viewport scale untouched: Large 24px, Extra large 32px, Normal 16px again, the inline --mr-ui-scale, the inline root font-size and the stage scale unchanged, the exact JSON saved, and a Display row grows', async () => {
      // WRONG IMPL KILLED: a `--mr-text-step` nothing in the stylesheet reads (the root never moves);
      // a rule that only multiplies for 1.5 (Extra large or the return to Normal is wrong); a rule
      // that replaces `--mr-ui-scale` instead of composing with it; an inline root font-size written
      // from JS (masks the rule: the inline size is asserted empty); a write of `--mr-ui-scale` or a
      // renderer resize (the stage scale and the var string are compared); a save in another shape;
      // rows sized in px (a rem-sized row's height must grow with the root).
      test.setTimeout(120_000);
      await seedAndReload(page, null);
      await openDisplay(page, 'size');
      const base = await readRoot(page);
      expect(base.px, `PREMISE: 1280x720 at scale 1 is a ${BASE_PX}px root`).toBeCloseTo(
        BASE_PX,
        3,
      );
      expect(base.scaleText, 'PREMISE: the inline scale is 1').toBe('1');
      expect(base.inlineFont, 'no inline root font-size').toBe('');
      expect(base.stage, 'PREMISE: stageScale 2 at 1280x720').toBeCloseTo(2, 6);
      expect(base.stepText, 'the boot wrote the default step').toBe('1');
      const normalRow = await rowHeight(page, 'normal');

      await downTo(page, controlsActive, 'large', 2, 'size');
      await pressButton(page, 'A');
      await expect
        .poll(async () => (await readRoot(page)).px, {
          message: 'Large is exactly 1.5 x the base root size',
          timeout: 5_000,
        })
        .toBeCloseTo(BASE_PX * 1.5, 3);
      const large = await readRoot(page);
      expect(large.stepText, 'the property').toBe('1.5');
      expect(large.scaleText, '--mr-ui-scale is untouched').toBe(base.scaleText);
      expect(large.inlineFont, 'still no inline root font-size').toBe('');
      expect(large.stage, 'the stage scale is untouched').toBe(base.stage);
      expect(await stored(page), 'Large is saved').toBe(LARGE_JSON);
      const largeRow = await rowHeight(page, 'normal');
      expect(largeRow, 'a rem-sized row grew with the root').toBeGreaterThan(normalRow * 1.3);

      await pressButton(page, 'Down');
      await expect.poll(() => controlsActive(page)).toBe('xlarge');
      await pressButton(page, 'A');
      await expect
        .poll(async () => (await readRoot(page)).px, {
          message: 'Extra large is exactly 2 x the base root size (not only 1.5)',
          timeout: 5_000,
        })
        .toBeCloseTo(BASE_PX * 2, 3);
      const xlarge = await readRoot(page);
      expect(xlarge.stepText).toBe('2');
      expect(xlarge.scaleText, '--mr-ui-scale is untouched').toBe(base.scaleText);
      expect(xlarge.inlineFont).toBe('');
      expect(xlarge.stage).toBe(base.stage);
      expect(await stored(page), 'Extra large is saved').toBe(XLARGE_JSON);
      expect(await rowHeight(page, 'normal'), 'the row grew again').toBeGreaterThan(largeRow);

      await downTo(page, controlsActive, 'normal', 3, 'size');
      await pressButton(page, 'A');
      await expect
        .poll(async () => (await readRoot(page)).px, {
          message: 'Normal returns the root to the base size',
          timeout: 5_000,
        })
        .toBeCloseTo(BASE_PX, 3);
      const normal = await readRoot(page);
      expect(normal.stepText).toBe('1');
      expect(normal.scaleText).toBe(base.scaleText);
      expect(normal.stage).toBe(base.stage);
      expect(await stored(page), 'Normal is saved').toBe(NORMAL_JSON);
      expect(
        await rowHeight(page, 'normal'),
        'and the row is back to its first height',
      ).toBeCloseTo(normalRow, 1);
    });

    test('UIF13.4 a saved Large and a saved Extra large are the root size at the first frame the scaled chrome shows after a reload: the step is set before (or with) the first --mr-ui-scale write, and the chrome is never scaled without it', async () => {
      // WRONG IMPL KILLED: a size applied only when a frame runs, on the first resize, or after the
      // viewport scale landed (the chrome would show once at 16px: the record at the first scale
      // write would read a missing step and 16px); a size that is applied but never read back by the
      // rule; a boot that forgets the saved choice (16px); a size read from the wrong key.
      test.setTimeout(120_000);
      for (const [json, px, step] of [
        [LARGE_JSON, BASE_PX * 1.5, '1.5'],
        [XLARGE_JSON, BASE_PX * 2, '2'],
      ] as const) {
        await seedAndReload(page, json);
        await expectStepBeforeScaledChrome(json, step, px);
        const now = await readRoot(page);
        expect(now.px, `${json}: and it stays that size`).toBeCloseTo(px, 3);
        expect(now.inlineFont, `${json}: no inline root font-size`).toBe('');
        expect(await stored(page), `${json}: the boot never rewrites it`).toBe(json);
      }
    });

    test('UIF13.4 a garbage, a wrong-version and an out-of-set saved value read as Normal (16px) at the first frame the scaled chrome shows and are never rewritten by the boot', async () => {
      // WRONG IMPL KILLED: a clamp of an out-of-set step to the nearest one (it would not read 16px);
      // a parse error that stops the boot; a boot that "repairs" the value in place; a stale step
      // from the previous load (the property is read fresh by every document).
      test.setTimeout(120_000);
      for (const raw of ['{not json', '{"v":2,"textStep":"large"}', '{"v":1,"textStep":"huge"}']) {
        await seedAndReload(page, raw);
        await expectStepBeforeScaledChrome(raw, '1', BASE_PX);
        expect(await stored(page), `${raw}: the stored string is byte-identical`).toBe(raw);
      }
    });

    test('UIF13.5 with Extra large saved the root is 2 x the base size before anything else is measured', async () => {
      // WRONG IMPL KILLED: every later fit check run at the wrong size (a vacuous pass at 16px).
      await seedAndReload(page, XLARGE_JSON);
      const root = await readRoot(page);
      expect(root.px, 'the root is 2 x the base').toBeCloseTo(BASE_PX * 2, 3);
      expect(root.scaleText, 'the viewport scale is still 1').toBe('1');
    });

    test('UIF13.5 at Extra large every one of the seven main-menu rows is unclipped when the cursor is on it: inside every overflow ancestor and the viewport, hit-testable at its centre, its text within its box', async () => {
      // WRONG IMPL KILLED: a menu body that does not scroll (the last rows sit below the frame: the
      // clipping ancestor check), a row whose text spills its box (scrollWidth), a row covered by
      // the frame's own footer or another element (elementFromPoint), a scroll that never follows
      // the cursor (the active row stays out of view), a row count that quietly changed (7 pinned).
      test.setTimeout(120_000);
      await seedAndReload(page, XLARGE_JSON);
      expect((await readRoot(page)).px, 'PREMISE: Extra large is in force').toBeCloseTo(
        BASE_PX * 2,
        3,
      );
      await closeAll(page);
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'Start opens the menu' })
        .toEqual(['world', 'menuView']);
      const rows = page.locator('#menu-rows [role="option"]');
      await expect(rows, 'the main menu has seven rows').toHaveCount(7);
      const activeIndex = (): Promise<number> =>
        page.evaluate(() =>
          [...document.querySelectorAll('#menu-rows [role="option"]')].findIndex(
            (e) => e.getAttribute('aria-selected') === 'true',
          ),
        );
      for (let guard = 0; guard < 8 && (await activeIndex()) !== 0; guard += 1) {
        const before = await activeIndex();
        await pressButton(page, 'Down');
        await expect.poll(activeIndex, { message: 'Down moves the cursor' }).not.toBe(before);
      }
      for (let i = 0; i < 7; i += 1) {
        await expect.poll(activeIndex, { message: `the cursor is on row ${i}` }).toBe(i);
        await expectUnclipped(
          page,
          '#menu-rows [role="option"][aria-selected="true"]',
          `main menu row ${i} at Extra large`,
          ['#menu-overlay'],
        );
        if (i < 6) await pressButton(page, 'Down');
      }
      await closeAll(page);
    });

    test('UIF13.5 at Extra large the two Monsters tabs, Party then Storage, each sit inside the tab strip, the tab row and the viewport, unclipped', async () => {
      // WRONG IMPL KILLED: a tab label that outgrows its tab at 2x (the strip scrolls and the tab is
      // clipped), a tab pushed out of the row by the chips, a tab covered by a chip; a tab count that
      // changed (2 pinned).
      test.setTimeout(120_000);
      await seedAndReload(page, XLARGE_JSON);
      await closeAll(page);
      await pressAccel(page, 'V');
      await expect
        .poll(() => stackNames(page), { message: 'V opens Monsters' })
        .toEqual(['world', 'menuView', 'boxView']);
      await expect(page.locator('#monsters-tab-party'), 'Party is selected').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#monsters-tabs [role="tab"]'), 'exactly two tabs').toHaveCount(2);
      for (const tab of ['party', 'storage'] as const) {
        if (tab === 'storage') {
          await pressButton(page, 'RB');
          await expect(page.locator('#monsters-tab-storage'), 'RB selects Storage').toHaveAttribute(
            'aria-selected',
            'true',
          );
        }
        for (const each of ['party', 'storage'] as const) {
          await expectUnclipped(
            page,
            `#monsters-tab-${each}`,
            `Monsters tab ${each} (${tab} selected) at Extra large`,
            ['#monsters-tabs'],
          );
        }
        // The tab row is the strip's parent (the kit's `.mr-tabbar`): each tab sits inside it too.
        const outside = await page.evaluate(() => {
          const strip = document.getElementById('monsters-tabs');
          const row = strip?.parentElement;
          if (strip === null || row === null || row === undefined) return ['no tab row'];
          const rr = row.getBoundingClientRect();
          return [...strip.children]
            .map((t, i) => ({ i, r: t.getBoundingClientRect() }))
            .filter(
              ({ r }) =>
                r.left < rr.left - 0.5 ||
                r.right > rr.right + 0.5 ||
                r.top < rr.top - 0.5 ||
                r.bottom > rr.bottom + 0.5,
            )
            .map(({ i }) => `tab ${i} outside the tab row`);
        });
        expect(outside, `${tab} selected: every tab is inside the tab row`).toEqual([]);
      }
      await closeAll(page);
    });

    test('UIF13.5 at Extra large the Controls frame fits: the Buttons grid walked Down to Reset all has every active cell unclipped, and the three Display rows each are when the cursor is on them', async () => {
      // WRONG IMPL KILLED: a Controls frame whose grid does not scroll with the cursor (Reset all, 13
      // rows down, sits below the frame), a two-column cell whose text spills at 2x, a Display row
      // clipped by the frame, a count that changed (13 Buttons rows and 3 Display rows pinned).
      test.setTimeout(180_000);
      await seedAndReload(page, XLARGE_JSON);
      await openControls(page, 'controls xl');
      await expect(
        page.locator('#controls-rows [role="row"]'),
        '12 button rows + Reset all',
      ).toHaveCount(13);
      const active = '#controls-rows [aria-selected="true"]';
      await expectUnclipped(page, active, 'Controls: the first cell at Extra large', [
        '#controls-overlay',
      ]);
      for (let row = 1; row <= 12; row += 1) {
        const before = await controlsActive(page);
        await pressButton(page, 'Down');
        await expect
          .poll(() => controlsActive(page), { message: `Down to grid row ${row}` })
          .not.toBe(before);
        await expectUnclipped(page, active, `Controls: grid row ${row} at Extra large`, [
          '#controls-overlay',
        ]);
      }
      expect(await controlsActive(page), 'the walk ended on Reset all').toBe('reset');

      await pressButton(page, 'RB');
      await pressButton(page, 'RB');
      await expect(page.locator('#controls-tab-display')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#controls-rows [data-nav-key]'), 'three Display rows').toHaveCount(
        3,
      );
      for (const [i, key] of ['normal', 'large', 'xlarge'].entries()) {
        await expect
          .poll(() => controlsActive(page), { message: `Display cursor on ${key}` })
          .toBe(key);
        await expectUnclipped(page, active, `Controls Display row ${key} at Extra large`, [
          '#controls-overlay',
        ]);
        if (i < 2) await pressButton(page, 'Down');
      }
      await closeAll(page);
    });
  });
