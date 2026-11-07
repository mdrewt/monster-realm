import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressButton } from './controls';

// ui-scale.spec.ts — uif-2 (M-ui-foundation): ONE viewport scale drives the world (integer) and the
// UI (continuous `--mr-ui-scale` on the root font size), measured in Chromium (UIF2.4 to UIF2.6).
//
// ORACLE RULE. Every expected value is a LITERAL (scale 1.2, title 24px, deviceScale 3, ...). The
// only live read of the var is the proportion check, which compares the title to the var it is
// meant to follow. The uiKit `withRootFontSize` probe is NOT used: it writes an inline root font
// size and would mask the very rule under test, so each sample first asserts the inline size is ''.
// Window changes: `setViewportSize` at dpr 1; CDP `Emulation.setDeviceMetricsOverride` at dpr 1.25.
// MEASURED: a dpr-only override fires NO resize event, so size and dpr always change together, and
// `setViewportSize` after an override resets dpr to 1.
//
// HYGIENE. Sorts after ui-chrome, before wallet. ONE browser context, ONE player, closed in afterAll
// (a second context would add a presence row; golden.spec.ts asserts an exact count). UIF2.6 uses a
// second PAGE in the same context whose main.ts is route-aborted, so it never connects. No fixed
// sleeps: every wait polls a bounded predicate.
//
// REDS AT MASTER: everything. No `--mr-ui-scale` is written, the root stays 16px, and `__game()`
// has no `stageScale`; UIF2.6's fallback (16px, then 32px once the var is set) needs the new rule.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
  stageScale: number | null;
}

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

const TITLE = '#menu-overlay .mr-frame-title';

async function openMenu(p: Page): Promise<void> {
  await closeAll(p);
  await pressButton(p, 'Start');
  await expect
    .poll(() => stackNames(p), { message: 'Start opens the menu' })
    .toEqual(['world', 'menuView']);
  await expect(p.locator('#menu-overlay'), 'the menu is shown').toBeVisible();
  await expect(p.locator(TITLE), 'with its title').toBeVisible();
}

interface Measured {
  iw: number;
  ih: number;
  dpr: number;
  inlineFont: string;
  rootPx: number;
  titlePx: number;
  varText: string;
  stage: number | null;
  canvasW: number;
  canvasH: number;
  rect: { x: number; y: number; width: number; height: number } | null;
  letterbox: number;
}

const measure = (p: Page): Promise<Measured> =>
  p.evaluate((titleSel) => {
    const root = document.documentElement;
    const title = document.querySelector(titleSel);
    const canvas = document.querySelector('canvas');
    const g = (window as unknown as { __game: () => { stageScale: number | null } }).__game();
    const r = canvas === null ? null : canvas.getBoundingClientRect();
    return {
      iw: window.innerWidth,
      ih: window.innerHeight,
      dpr: window.devicePixelRatio,
      inlineFont: root.style.fontSize,
      rootPx: Number.parseFloat(getComputedStyle(root).fontSize),
      titlePx: title === null ? Number.NaN : Number.parseFloat(getComputedStyle(title).fontSize),
      varText: root.style.getPropertyValue('--mr-ui-scale'),
      stage: g.stageScale,
      canvasW: canvas === null ? -1 : canvas.width,
      canvasH: canvas === null ? -1 : canvas.height,
      rect: r === null ? null : { x: r.x, y: r.y, width: r.width, height: r.height },
      letterbox: document.querySelectorAll('[class*="letterbox" i], [id*="letterbox" i]').length,
    };
  }, TITLE);

const nextFrame = (p: Page): Promise<void> =>
  p.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

interface Case {
  readonly w: number;
  readonly h: number;
  readonly dpr: number;
  readonly scale: number;
  readonly rootPx: number;
  readonly titlePx: number;
  readonly deviceScale: number;
  readonly scaleText?: string;
}

const CASES = {
  base: {
    w: 1280,
    h: 720,
    dpr: 1,
    scale: 1,
    scaleText: '1',
    rootPx: 16,
    titlePx: 20,
    deviceScale: 2,
  },
  dpr125: {
    w: 1536,
    h: 864,
    dpr: 1.25,
    scale: 1.2,
    scaleText: '1.2',
    rootPx: 19.2,
    titlePx: 24,
    deviceScale: 3,
  },
  fullHd: {
    w: 1920,
    h: 1080,
    dpr: 1,
    scale: 1.5,
    scaleText: '1.5',
    rootPx: 24,
    titlePx: 30,
    deviceScale: 3,
  },
  floor: {
    w: 960,
    h: 540,
    dpr: 1,
    scale: 0.875,
    scaleText: '0.875',
    rootPx: 14,
    titlePx: 17.5,
    deviceScale: 2,
  },
  ceiling: {
    w: 3840,
    h: 2160,
    dpr: 1,
    scale: 3,
    scaleText: '3',
    rootPx: 48,
    titlePx: 60,
    deviceScale: 6,
  },
  between: {
    w: 1000,
    h: 800,
    dpr: 1,
    scale: 1.1111111,
    rootPx: 17.777778,
    titlePx: 22.222222,
    deviceScale: 2,
  },
} as const satisfies Record<string, Case>;

test.describe
  .serial('UIF2 — one viewport scale for the world and the UI, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let cdp: CDPSession;
    /** title px / live var, one per size UIF2.4 measured. */
    const ratios: number[] = [];

    /** Change the window and wait until the page itself reports it and the var caught up. */
    async function setWindow(w: number, h: number, dpr: number, scale: number): Promise<void> {
      if (dpr === 1) {
        await page.setViewportSize({ width: w, height: h });
      } else {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: w,
          height: h,
          deviceScaleFactor: dpr,
          mobile: false,
        });
      }
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), {
          message: `the window reports ${w}x${h}@${dpr}`,
          timeout: 10_000,
        })
        .toEqual([w, h, dpr]);
      await expect
        .poll(async () => Number.parseFloat((await measure(page)).varText), {
          message: `--mr-ui-scale reaches ${scale}`,
          timeout: 10_000,
        })
        .toBeCloseTo(scale, 6);
      await nextFrame(page);
    }

    async function checkCase(c: Case): Promise<Measured> {
      await setWindow(c.w, c.h, c.dpr, c.scale);
      await expect(page.locator(TITLE), 'the menu stays open and visible').toBeVisible();
      // The stage scale is held by the renderer; poll it to the literal, bounded.
      const stage = c.deviceScale / c.dpr;
      await expect
        .poll(async () => (await measure(page)).stage, {
          message: `stageScale reaches ${stage}`,
          timeout: 10_000,
        })
        .toBeCloseTo(stage, 6);
      const m = await measure(page);
      const tag = `${c.w}x${c.h}@${c.dpr}`;
      expect(m.inlineFont, `${tag}: no inline root font-size (no probe in play)`).toBe('');
      if (c.scaleText !== undefined) expect(m.varText, `${tag} var text`).toBe(c.scaleText);
      expect(m.rootPx, `${tag} root font-size`).toBeCloseTo(c.rootPx, 3);
      expect(m.titlePx, `${tag} title font-size`).toBeCloseTo(c.titlePx, 3);
      expect(m.titlePx / Number.parseFloat(m.varText), `${tag} title / live var`).toBeCloseTo(
        20,
        4,
      );
      ratios.push(m.titlePx / Number.parseFloat(m.varText));
      expect((m.stage as number) * m.dpr, `${tag} stageScale x dpr`).toBeCloseTo(c.deviceScale, 6);
      expect(m.canvasW, `${tag} canvas backing width`).toBe(Math.round(c.w * c.dpr));
      expect(m.canvasH, `${tag} canvas backing height`).toBe(Math.round(c.h * c.dpr));
      return m;
    }

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      page = await ctx.newPage();
      cdp = await ctx.newCDPSession(page);
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF2.4 1280x720@1: root 16px, title 20px, deviceScale 2', async () => {
      await openMenu(page);
      const m = await checkCase(CASES.base);
      expect(m.stage, 'stageScale 2 (an integer at dpr 1)').toBeCloseTo(2, 6);
    });

    test('UIF2.4 1536x864@1.25: scale 1.2, title 24px, deviceScale 3, stageScale 2.4', async () => {
      const m = await checkCase(CASES.dpr125);
      expect(m.stage, 'stageScale = 3 / 1.25').toBeCloseTo(2.4, 6);
    });

    test('UIF2.4 1920x1080@1: scale 1.5, title 30px, deviceScale 3', async () => {
      const m = await checkCase(CASES.fullHd);
      expect(m.stage).toBeCloseTo(3, 6);
    });

    test('UIF2.4 floor 960x540@1: scale 0.875, title 17.5px, deviceScale 2', async () => {
      const m = await checkCase(CASES.floor);
      expect(m.stage).toBeCloseTo(2, 6);
    });

    test('UIF2.4 ceiling 3840x2160@1: scale 3, title 60px, deviceScale 6', async () => {
      const m = await checkCase(CASES.ceiling);
      expect(m.stage).toBeCloseTo(6, 6);
    });

    test('UIF2.4 in-between 1000x800@1: scale 1.1111 (no snapping), title 22.22px, deviceScale 2', async () => {
      const m = await checkCase(CASES.between);
      expect(m.stage).toBeCloseTo(2, 6);
      expect(Number.parseFloat(m.varText)).toBeCloseTo(1.1111111, 6);
      expect(Number.isInteger(m.titlePx), 'the title size is not an integer step').toBe(false);
    });

    test('UIF2.4 the title size is the same constant multiple of the live --mr-ui-scale at every size', () => {
      expect(ratios, 'six sizes were measured').toHaveLength(6);
      const first = ratios[0] as number;
      expect(first).toBeCloseTo(20, 4);
      for (const r of ratios) expect(r).toBeCloseTo(first, 4);
    });

    test('UIF2.5 at 1000x900, 1600x600, 2560x1080 @1 the canvas box equals the window and the stage scale stays an integer', async () => {
      const wanted = [
        { w: 1000, h: 900, scale: 1.25, deviceScale: 3 },
        { w: 1600, h: 600, scale: 0.875, deviceScale: 2 },
        { w: 2560, h: 1080, scale: 1.5, deviceScale: 3 },
      ];
      for (const c of wanted) {
        await setWindow(c.w, c.h, 1, c.scale);
        await expect
          .poll(async () => (await measure(page)).stage, {
            message: `stageScale reaches ${c.deviceScale} at ${c.w}x${c.h}`,
            timeout: 10_000,
          })
          .toBeCloseTo(c.deviceScale, 6);
        const m = await measure(page);
        const tag = `${c.w}x${c.h}`;
        expect(m.rect, `${tag}: a canvas exists`).not.toBeNull();
        expect(m.rect, `${tag}: the canvas box is the window box, no fixed-ratio box`).toEqual({
          x: 0,
          y: 0,
          width: c.w,
          height: c.h,
        });
        expect(Number.isInteger(m.stage), `${tag}: the stage scale is an integer at dpr 1`).toBe(
          true,
        );
        expect(m.letterbox, `${tag}: no letterbox element`).toBe(0);
      }
    });

    test('UIF2.5 the visible tile count differs between windows that share an integer scale', async () => {
      const tilesAcross = async (
        w: number,
        h: number,
        scale: number,
      ): Promise<[number, number]> => {
        await setWindow(w, h, 1, scale);
        await expect
          .poll(async () => (await measure(page)).stage, { timeout: 10_000 })
          .toBeCloseTo(3, 6);
        const m = await measure(page);
        return [m.stage as number, m.iw / ((m.stage as number) * 32)];
      };
      const [stageA, tilesA] = await tilesAcross(1000, 900, 1.25);
      const [stageB, tilesB] = await tilesAcross(2560, 1080, 1.5);
      expect(stageA).toBeCloseTo(3, 6);
      expect(stageB).toBeCloseTo(3, 6);
      expect(tilesA).toBeCloseTo(10.416667, 4);
      expect(tilesB).toBeCloseTo(26.666667, 4);
      expect(tilesB).toBeGreaterThan(tilesA);
    });

    test('UIF2.6 with main.ts blocked (no scale ever written) the root is 16px, and setting --mr-ui-scale scales it', async () => {
      await ctx.route('**/src/main.ts*', (route) => route.abort());
      const bare = await ctx.newPage();
      try {
        await bare.setViewportSize({ width: 1920, height: 1080 });
        await bare.goto('/');
        await bare.waitForLoadState('load');
        const probe = () =>
          bare.evaluate(() => {
            const root = document.documentElement;
            return {
              game: typeof (window as unknown as { __game?: unknown }).__game,
              rootPx: getComputedStyle(root).fontSize,
              inline: root.style.getPropertyValue('--mr-ui-scale'),
              rules: document.styleSheets.length,
            };
          });
        const before = await probe();
        expect(before.game, 'main.ts did not run').toBe('undefined');
        expect(before.rules, 'the stylesheet link loaded').toBeGreaterThan(0);
        expect(before.inline, 'nothing wrote the var').toBe('');
        expect(before.rootPx, 'no var: the fallback scale is 1').toBe('16px');

        await bare.evaluate(() => document.documentElement.style.setProperty('--mr-ui-scale', '2'));
        await expect
          .poll(() => bare.evaluate(() => getComputedStyle(document.documentElement).fontSize), {
            message: 'the rule reads the var',
            timeout: 5_000,
          })
          .toBe('32px');

        await bare.evaluate(() => document.documentElement.style.removeProperty('--mr-ui-scale'));
        await expect
          .poll(() => bare.evaluate(() => getComputedStyle(document.documentElement).fontSize), {
            timeout: 5_000,
          })
          .toBe('16px');
      } finally {
        await bare.close();
        await ctx.unroute('**/src/main.ts*');
      }
    });
  });
