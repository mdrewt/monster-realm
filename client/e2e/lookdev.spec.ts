import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// lookdev.spec.ts — wap-9 (M-world-art-pass): the look-dev scene. WAP9.5 (the post stack is
// deterministic under the injected clock, visibly grades the world, and keeps tile edges hard)
// and WAP9.6 (the per-pass frame-time measurement; printed, never gated).
//
// EVIDENCE LABEL: real modules + real Pixi + real filters + software GL (headless Chromium) + a
// FIXTURE map. The page is the real index.html on the Vite dev server with main.ts route-aborted
// (the ui-social.spec.ts fixture-page precedent: nothing connects). The page-side code is a STRING
// importing the real WorldRenderer; it builds an 18x9 map holding all ten terrain classes in 3x3
// blocks, one heal landmark and one warp. Pixels are read in the SAME task as render()
// (drawImage of the Pixi canvas onto a 2D canvas) and every diff is computed page-side.
//
// GEOMETRY (1280x720 CSS, integer scale): the 18x9 map is 576x288 source px; the viewport is
// 640x360 source px at stageScale 2, so the map is centred with a 64 CSS px margin left and right
// and a 72 CSS px margin above and below. A vertical block boundary at tile t (3, 6, 9, 12, 15)
// is at CSS x = 64 + 64 t. The same CSS geometry holds at deviceScaleFactor 2 (device px double).
//
// THE HARD-STEP CHECK (d) AND HOW IT BITES. Rows are picked from the stack-OFF frame: a strong luma
// step between columns X-1 and X with flat neighbours (X-2,X-1) and (X,X+1) (the art is nearest-
// scaled, so a straight tile edge is exactly that). In the stack-ON frame the SHARPNESS
// step / (step + the two neighbour diffs) must stay >= 0.75. A pass rendered at half resolution
// is bilinearly upsampled: the step splits over three columns, step/(step+nbrs) ~= 0.5, and the
// test fails. At DPR 1 a world.ts that never applies `resolution` is pixel-identical (Pixi's
// filter default is 1), so the same check also runs in a second context at DPR 2, where a dropped
// resolution IS half resolution.
//
// No fixed sleeps: every wait is a bounded promise. Both contexts close in afterAll.

const VIEWPORT = { width: 1280, height: 720 } as const;
const NOW = 1600;
const OFF = { lightmap: false, bloom: false, godray: false, lut: false } as const;
const ON = { lightmap: true, bloom: true, godray: true, lut: true } as const;
const PASSES = ['lightmap', 'bloom', 'godray', 'lut'] as const;
type Toggles = Record<(typeof PASSES)[number], boolean>;
type Keyframe = 'day' | 'dusk' | 'night';

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

interface ShotOptions {
  readonly toggles: Toggles;
  readonly keyframe: Keyframe;
  readonly nowMs: number;
  readonly reduceMotion?: boolean;
  /** false => render only, no setPostStack call (same stack object). */
  readonly set?: boolean;
}

interface SharpResult {
  readonly qualified: number;
  readonly failed: number;
  readonly bad: ReadonlyArray<{ X: number; y: number; so: number; sn: number; nb: number }>;
}

interface Lk {
  shot(name: string, o: ShotOptions): number;
  diff(a: string, b: string, rect: Rect | null, thresh: number): { count: number; total: number };
  equal(a: string, b: string): boolean;
  colours(name: string): number;
  sharp(off: string, on: string, xs: readonly number[], y0: number, y1: number): SharpResult;
  time(
    configs: ReadonlyArray<{ name: string; toggles: Toggles }>,
    frames: number,
  ): Array<{ name: string; msPerFrame: number }>;
}

// The page-side fixture. Single quotes and concatenation only: this is a template literal.
const LOOKDEV_MOUNT = `(async () => {
  const { WorldRenderer } = await import('/src/render/world.ts');
  const W = 18, H = 9;
  const ORDER = [
    'Floor', 'Wall', 'TallGrass', 'Path', 'Sand', 'ShallowWater',
    'DeepWater', 'Rock', 'Tree', 'Bush', 'Floor', 'Wall',
    'Sand', 'DeepWater', 'Rock', 'Path', 'Tree', 'TallGrass',
  ];
  const terrain = [], walkable = [], grass = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const kind = ORDER[Math.floor(y / 3) * 6 + Math.floor(x / 3)];
      terrain.push(kind);
      walkable.push(kind !== 'Wall' && kind !== 'Rock' && kind !== 'Tree' && kind !== 'DeepWater');
      grass.push(kind === 'TallGrass');
    }
  }
  const raw = {
    zone_id: 1, width: W, height: H, walkable, grass, terrain,
    warps: [{ from: { x: 10, y: 7 }, to_zone: 2, to_tile: { x: 1, y: 1 } }],
    landmarks: [{ kind: 'heal', x: 1, y: 2 }],
  };
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const renderer = new WorldRenderer();
  await renderer.init(mount, raw);
  const canvas = mount.querySelector('canvas');
  const frames = {};
  const lum = (d, x, y, w) => {
    const i = (y * w + x) * 4;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  };
  window.__lk = {
    shot(name, o) {
      if (o.set !== false) renderer.setPostStack({ toggles: o.toggles, keyframe: o.keyframe });
      renderer.render([], 8, 4, { nowMs: o.nowMs, reduceMotion: o.reduceMotion === true });
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(canvas, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      frames[name] = d;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 1) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
      return h;
    },
    diff(a, b, rect, thresh) {
      const A = frames[a], B = frames[b], w = canvas.width, hgt = canvas.height;
      const r = rect || { x0: 0, y0: 0, x1: w, y1: hgt };
      let count = 0;
      for (let y = r.y0; y < r.y1; y += 1) {
        for (let x = r.x0; x < r.x1; x += 1) {
          const i = (y * w + x) * 4;
          const m = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
          if (m >= thresh) count += 1;
        }
      }
      return { count, total: (r.x1 - r.x0) * (r.y1 - r.y0) };
    },
    equal(a, b) {
      const A = frames[a], B = frames[b];
      if (A.length !== B.length) return false;
      for (let i = 0; i < A.length; i += 1) if (A[i] !== B[i]) return false;
      return true;
    },
    colours(name) {
      const d = frames[name];
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] >> 3) * 1024 + (d[i + 1] >> 3) * 32 + (d[i + 2] >> 3));
      return seen.size;
    },
    sharp(offName, onName, xs, y0, y1) {
      const off = frames[offName], on = frames[onName], w = canvas.width;
      let qualified = 0, failed = 0;
      const bad = [];
      for (const X of xs) {
        for (let y = y0; y < y1; y += 1) {
          const o0 = lum(off, X - 2, y, w), o1 = lum(off, X - 1, y, w);
          const o2 = lum(off, X, y, w), o3 = lum(off, X + 1, y, w);
          const so = Math.abs(o2 - o1);
          if (so < 50 || Math.abs(o1 - o0) > 4 || Math.abs(o3 - o2) > 4) continue;
          qualified += 1;
          const n0 = lum(on, X - 2, y, w), n1 = lum(on, X - 1, y, w);
          const n2 = lum(on, X, y, w), n3 = lum(on, X + 1, y, w);
          const sn = Math.abs(n2 - n1);
          const nb = Math.abs(n1 - n0) + Math.abs(n3 - n2);
          if (!(sn >= 0.35 * so && sn / (sn + nb) >= 0.75)) {
            failed += 1;
            if (bad.length < 5) bad.push({ X, y, so, sn, nb });
          }
        }
      }
      return { qualified, failed, bad };
    },
    time(configs, count) {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const px = new Uint8Array(4);
      const out = [];
      for (const cfg of configs) {
        renderer.setPostStack({ toggles: cfg.toggles, keyframe: 'day' });
        for (let i = 0; i < 3; i += 1) {
          renderer.render([], 8, 4, { nowMs: 1600 + i * 16, reduceMotion: false });
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        const t0 = performance.now();
        for (let i = 0; i < count; i += 1) {
          renderer.render([], 8, 4, { nowMs: 1700 + i * 16, reduceMotion: false });
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        }
        out.push({ name: cfg.name, msPerFrame: (performance.now() - t0) / count });
      }
      return out;
    },
  };
  return { w: canvas.width, h: canvas.height, dpr: window.devicePixelRatio };
})()`;

const lk = <A extends unknown[], R>(p: Page, method: keyof Lk, ...args: A): Promise<R> =>
  p.evaluate(
    ([m, a]) => {
      const api = (window as unknown as { __lk: Record<string, (...x: unknown[]) => unknown> })
        .__lk;
      return (api[m as string] as (...x: unknown[]) => unknown)(...(a as unknown[]));
    },
    [method, args] as const,
  ) as Promise<R>;

const shot = (p: Page, name: string, o: ShotOptions): Promise<number> => lk(p, 'shot', name, o);
const diff = (
  p: Page,
  a: string,
  b: string,
  rect: Rect | null,
  thresh: number,
): Promise<{ count: number; total: number }> => lk(p, 'diff', a, b, rect, thresh);
const equal = (p: Page, a: string, b: string): Promise<boolean> => lk(p, 'equal', a, b);

/** Device-px geometry of the fixture map for a given device pixel ratio. */
function geo(dpr: number) {
  return {
    map: { x0: 64 * dpr, y0: 72 * dpr, x1: 1216 * dpr, y1: 648 * dpr } satisfies Rect,
    // The far void: a thin strip on the left edge and one along the top, well outside the map.
    voidStrips: [
      { x0: 0, y0: 0, x1: 12 * dpr, y1: 720 * dpr },
      { x0: 0, y0: 0, x1: 1280 * dpr, y1: 12 * dpr },
    ] satisfies Rect[],
    boundaries: [3, 6, 9, 12, 15].map((t) => (64 + 64 * t) * dpr),
  };
}

/** The first nowMs whose stack-off frame equals the nowMs 0 stack-off frame (water and warp loop). */
async function loopedNow(p: Page): Promise<number> {
  await shot(p, 'none@0', { toggles: OFF, keyframe: 'day', nowMs: 0 });
  for (const candidate of [12_800, 67_200, 336_000, 1_008_000, 2_016_000]) {
    await shot(p, 'none@T', { toggles: OFF, keyframe: 'day', nowMs: candidate });
    if (await equal(p, 'none@0', 'none@T')) return candidate;
  }
  throw new Error('no candidate nowMs repeats the stack-off frame; the animation periods changed');
}

async function openLookDev(
  browser: Browser,
  dpr: number,
  abortGlob?: string,
): Promise<{ ctx: BrowserContext; page: Page; warnings: string[] }> {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
  await ctx.route('**/src/main.ts*', (route) => route.abort());
  if (abortGlob !== undefined) await ctx.route(abortGlob, (route) => route.abort());
  const page = await ctx.newPage();
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.goto('/');
  await page.waitForLoadState('load');
  expect(
    await page.evaluate(() => typeof (window as unknown as { __game?: unknown }).__game),
    'main.ts did not run',
  ).toBe('undefined');
  const size = (await page.evaluate(LOOKDEV_MOUNT)) as { w: number; h: number; dpr: number };
  expect(size, 'the Pixi canvas backing store is the viewport at the device ratio').toEqual({
    w: 1280 * dpr,
    h: 720 * dpr,
    dpr,
  });
  return { ctx, page, warnings };
}

/** The hard-step check (d) on one page: stack-off vs stack-on, day keyframe. */
async function expectHardSteps(page: Page, dpr: number): Promise<void> {
  const g = geo(dpr);
  await shot(page, 'step-off', { toggles: OFF, keyframe: 'day', nowMs: NOW });
  await shot(page, 'step-on', { toggles: ON, keyframe: 'day', nowMs: NOW });
  const result = await lk<unknown[], SharpResult>(
    page,
    'sharp',
    'step-off',
    'step-on',
    g.boundaries,
    g.map.y0,
    g.map.y1,
  );
  // Non-vacuity: the map really has many strong, flat-sided vertical edges to test.
  expect(
    result.qualified,
    `stack-off frame must hold many strong flat-sided tile edges (saw ${result.qualified})`,
  ).toBeGreaterThanOrEqual(40);
  expect(
    result.failed,
    `edges blurred by the stack: ${JSON.stringify(result.bad)} of ${result.qualified} rows`,
  ).toBeLessThanOrEqual(Math.floor(result.qualified * 0.02));
}

test.describe
  .serial('WAP9 — the look-dev scene (real renderer + filters, fixture map, software GL)', () => {
    let browser: Browser;
    let ctx1: BrowserContext;
    let ctx2: BrowserContext;
    let p1: Page;
    let p2: Page;

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      browser = await chromium.launch();
      const one = await openLookDev(browser, 1);
      ctx1 = one.ctx;
      p1 = one.page;
      const two = await openLookDev(browser, 2);
      ctx2 = two.ctx;
      p2 = two.page;
    });

    test.afterAll(async () => {
      await ctx1?.close();
      await ctx2?.close();
      await browser?.close();
    });

    test('WAP9.5 the stack-on frame differs from the stack-off frame across the map and leaves the far void untouched', async () => {
      // WRONG IMPL KILLED: a stack that never attaches (setPostStack builds filters nobody
      // renders through: the frames are identical); filters attached to the stage instead of the
      // world container (the void strips change too); an effect confined to a few pixels.
      test.setTimeout(120_000);
      const g = geo(1);
      await shot(p1, 'off', { toggles: OFF, keyframe: 'day', nowMs: NOW });
      await shot(p1, 'on', { toggles: ON, keyframe: 'day', nowMs: NOW });
      expect(await lk<unknown[], number>(p1, 'colours', 'off')).toBeGreaterThanOrEqual(20);
      const inside = await diff(p1, 'off', 'on', g.map, 3);
      expect(
        inside.count / inside.total,
        'a meaningful fraction of the map area changes with the stack on',
      ).toBeGreaterThanOrEqual(0.25);
      for (const strip of g.voidStrips) {
        const outside = await diff(p1, 'off', 'on', strip, 1);
        expect(outside.count, 'the void beyond the map is the clear colour, unfiltered').toBe(0);
      }
    });

    test('WAP9.5 two renders with identical nowMs, toggles and keyframe are byte-identical, also across a stack rebuild', async () => {
      // WRONG IMPL KILLED: a wall-clock or Math.random read in the stack (frames differ run to
      // run); state that survives a rebuild (the third frame differs from the first); a blank
      // canvas (the colour-count guard).
      test.setTimeout(120_000);
      const opts: ShotOptions = { toggles: ON, keyframe: 'dusk', nowMs: 7777 };
      await shot(p1, 'rep-1', opts);
      await shot(p1, 'rep-2', { ...opts, set: false });
      await shot(p1, 'rep-3', opts);
      expect(await lk<unknown[], number>(p1, 'colours', 'rep-1')).toBeGreaterThanOrEqual(20);
      expect(await equal(p1, 'rep-1', 'rep-2'), 'render twice, same stack').toBe(true);
      expect(await equal(p1, 'rep-1', 'rep-3'), 'rebuild with the same arguments').toBe(true);
    });

    test('WAP9.5 the day and night keyframes produce clearly different frames', async () => {
      // WRONG IMPL KILLED: a keyframe that is ignored (day == night); a LUT that is loaded but
      // not applied; a night grade that differs by a handful of pixels.
      test.setTimeout(120_000);
      const g = geo(1);
      await shot(p1, 'day', { toggles: ON, keyframe: 'day', nowMs: NOW });
      await shot(p1, 'night', { toggles: ON, keyframe: 'night', nowMs: NOW });
      const d = await diff(p1, 'day', 'night', g.map, 3);
      expect(d.count / d.total).toBeGreaterThanOrEqual(0.5);
    });

    test('WAP9.5 each pass alone changes the frame; godray moves with time and holds under reduced motion; the lut follows the keyframe', async () => {
      // WRONG IMPL KILLED: a pass that is built but contributes nothing (alone == none); a godray
      // whose time is not driven by nowMs (t=0 == t=T); a godray that ignores reduceMotion (the RM
      // frames differ); a lut that ignores the keyframe (day == night alone). The nowMs pair is
      // chosen so the water and warp animation repeat, so only the godray can make the frames differ.
      test.setTimeout(180_000);
      const g = geo(1);
      await shot(p1, 'none', { toggles: OFF, keyframe: 'day', nowMs: NOW });
      const floors = { lightmap: 1000, bloom: 20, godray: 500, lut: 1000 } as const;
      for (const pass of PASSES) {
        await shot(p1, `alone-${pass}`, {
          toggles: { ...OFF, [pass]: true },
          keyframe: 'day',
          nowMs: NOW,
        });
        const d = await diff(p1, 'none', `alone-${pass}`, g.map, 1);
        expect(d.count, `${pass} alone must change the frame`).toBeGreaterThanOrEqual(floors[pass]);
      }

      const T = await loopedNow(p1);
      const godrayOnly = { ...OFF, godray: true };
      await shot(p1, 'gd@0', { toggles: godrayOnly, keyframe: 'day', nowMs: 0 });
      await shot(p1, 'gd@T', { toggles: godrayOnly, keyframe: 'day', nowMs: T });
      const moved = await diff(p1, 'gd@0', 'gd@T', g.map, 1);
      expect(moved.count, 'godray at nowMs 0 vs the looped nowMs differs').toBeGreaterThanOrEqual(
        200,
      );
      await shot(p1, 'gdrm@0', {
        toggles: godrayOnly,
        keyframe: 'day',
        nowMs: 0,
        reduceMotion: true,
      });
      await shot(p1, 'gdrm@T', {
        toggles: godrayOnly,
        keyframe: 'day',
        nowMs: T,
        reduceMotion: true,
      });
      expect(await equal(p1, 'gdrm@0', 'gdrm@T'), 'reduced motion holds the godray').toBe(true);
      // The held godray is a real frame, not a blank one.
      expect((await diff(p1, 'none@0', 'gdrm@0', g.map, 1)).count).toBeGreaterThanOrEqual(200);

      await shot(p1, 'lut-night', {
        toggles: { ...OFF, lut: true },
        keyframe: 'night',
        nowMs: NOW,
      });
      const lutDelta = await diff(p1, 'alone-lut', 'lut-night', g.map, 3);
      expect(lutDelta.count / lutDelta.total, 'lut day vs night alone').toBeGreaterThanOrEqual(0.5);
    });

    test('WAP9.5 a tile edge stays a one-pixel hard step with the stack on (device ratio 1)', async () => {
      // WRONG IMPL KILLED: filters rendering at half resolution (a bilinear resample spreads the
      // step over three columns: step/(step + neighbours) ~ 0.5 < 0.75); a blur pass over the
      // world; a stack that flattens the edge (the 0.35 floor on the step).
      test.setTimeout(120_000);
      await expectHardSteps(p1, 1);
    });

    test('WAP9.5 a tile edge stays a one-pixel hard step with the stack on (device ratio 2: the renderer resolution reaches every filter)', async () => {
      // WRONG IMPL KILLED: a world.ts that never applies the planned `resolution` (Pixi's filter
      // default is 1, so every pass renders at HALF the 2x backing store and the step blurs) -
      // invisible at ratio 1, caught here.
      test.setTimeout(180_000);
      await expectHardSteps(p2, 2);
    });

    test('WAP9.4 a LUT that fails to load disables the stack with one warning and an unfiltered frame, and a working keyframe brings it back', async () => {
      // WRONG IMPL KILLED: a failure that throws or blanks the canvas (the colour-count guard); a
      // half-built stack left attached (the frame differs from the stack-off frame); a warning per
      // frame or none at all (exactly one 'post stack disabled' across two renders); a fallback that
      // never recovers (setPostStack day must filter again).
      test.setTimeout(180_000);
      const g = geo(1);
      const fresh = await openLookDev(browser, 1, '**/assets/lut-night.png');
      try {
        const { page, warnings } = fresh;
        // The night LUT's own load-failure line is a separate message and is not counted.
        warnings.length = 0;
        await shot(page, 'n-off', { toggles: OFF, keyframe: 'day', nowMs: NOW });
        await shot(page, 'n-night', { toggles: ON, keyframe: 'night', nowMs: NOW });
        await shot(page, 'n-night-2', { toggles: ON, keyframe: 'night', nowMs: NOW, set: false });
        expect(
          warnings.filter((w) => w.includes('post stack disabled')),
          `console warnings: ${JSON.stringify(warnings)}`,
        ).toHaveLength(1);
        expect(await lk<unknown[], number>(page, 'colours', 'n-night')).toBeGreaterThanOrEqual(20);
        expect(await equal(page, 'n-off', 'n-night'), 'a disabled stack draws the bare world').toBe(
          true,
        );
        expect(await equal(page, 'n-off', 'n-night-2')).toBe(true);

        await shot(page, 'n-day', { toggles: ON, keyframe: 'day', nowMs: NOW });
        const back = await diff(page, 'n-off', 'n-day', g.map, 3);
        expect(back.count / back.total, 'the day keyframe filters again').toBeGreaterThanOrEqual(
          0.25,
        );
      } finally {
        await fresh.ctx.close();
      }
    });

    test('WAP9.6 per-pass frame time: none, each pass alone, all four (printed, not gated)', async () => {
      // A MEASUREMENT, not a budget gate (spec backlog: "A frame-time gate per pass"): the table
      // goes to the console and the test annotations for the style guide. It fails only when the
      // measurement cannot run.
      test.setTimeout(300_000);
      const FRAMES = 20;
      const configs = [
        { name: 'none', toggles: OFF },
        ...PASSES.map((pass) => ({ name: pass, toggles: { ...OFF, [pass]: true } as Toggles })),
        { name: 'all', toggles: ON },
      ];
      const rows = await lk<unknown[], Array<{ name: string; msPerFrame: number }>>(
        p1,
        'time',
        configs,
        FRAMES,
      );
      expect(rows.map((r) => r.name)).toEqual(['none', ...PASSES, 'all']);
      const table = rows.map((r) => `${r.name.padEnd(9)} ${r.msPerFrame.toFixed(2)} ms/frame`);
      const text = `WAP9.6 frame time, ${FRAMES} frames each, 1280x720 DPR 1, software GL:\n${table.join('\n')}`;
      console.log(text);
      test.info().annotations.push({ type: 'WAP9.6 frame-time', description: text });
      for (const r of rows) {
        expect(Number.isFinite(r.msPerFrame)).toBe(true);
        expect(r.msPerFrame).toBeGreaterThan(0);
      }
    });
  });
