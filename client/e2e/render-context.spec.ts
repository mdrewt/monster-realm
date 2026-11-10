import { expect, type Page, test } from '@playwright/test';

// render-context.spec.ts — who draws the world, and that it survives a WebGL context loss.
//
// 1. ONE DRAW PER FRAME. Pixi's own ticker is stopped; the frame loop draws. The canvas is cleared
//    exactly once per animation frame: zero means the frame loop stopped drawing (the world would
//    freeze on its last resize), two means a second owner is drawing again.
// 2. CONTEXT RESTORE. A browser may drop a page's WebGL context at any time (GPU process restart,
//    driver reset, a backgrounded mobile tab). Pixi restores image-backed textures by itself, but a
//    texture that was RENDERED (the baked terrain chunks) comes back empty, so the renderer must
//    re-bake on restore.
//
// ORACLES. (1) counts `clear` calls on the WebGL prototypes against `requestAnimationFrame`
// callbacks. (2) compares two screenshots of the same idle scene, before the loss and after the
// restore, pixel by pixel in the page. Reduced motion holds the water and warp animations on frame
// 0, so the only legitimate differences are a wandering NPC's few tiles.
//
// HYGIENE. One page per test, closed with it; no fixed sleep decides an assertion.
//
// WHAT EACH TEST CATCHES. Without the re-bake the terrain stays blank after a restore: 30% of the
// 1280x720 canvas differs on a 10x7 zone, 98% on a zone that fills the canvas. With the per-frame
// draw removed the clear count is 0; with Pixi's ticker started as well it is 2 per frame.

test.use({ viewport: { width: 1280, height: 720 }, contextOptions: { reducedMotion: 'reduce' } });

/** Largest share of the canvas a wandering NPC can repaint between the two screenshots. */
const MAX_CHANGED_FRACTION = 0.02;
/** Animation frames the one-draw-per-frame count runs over. */
const COUNTED_FRAMES = 60;

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as {
        __game?: () => { identity: string; ownAuthTile: unknown };
      };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

const canvasShot = async (p: Page): Promise<string> =>
  (await p.locator('canvas').screenshot()).toString('base64');

/** Decode both PNGs in the page; the share of pixels that differ (no image dependency in the
 *  test runner). */
const changedFraction = (p: Page, first: string, second: string): Promise<number> =>
  p.evaluate(
    async ([a, b]) => {
      const pixels = async (png: string): Promise<Uint8ClampedArray> => {
        const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [pa, pb] = [await pixels(a), await pixels(b)];
      if (pa.length !== pb.length) return 1;
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) changed++;
      }
      return changed / (pa.length / 4);
    },
    [first, second] as const,
  );

/** Lose the canvas's WebGL context, then restore it; resolves once the restore event fired. */
const loseAndRestoreContext = (p: Page): Promise<{ lost: boolean; restored: boolean }> =>
  p.evaluate(
    () =>
      new Promise<{ lost: boolean; restored: boolean }>((resolve, reject) => {
        const canvas = document.querySelector('canvas');
        const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
        const ext = gl?.getExtension('WEBGL_lose_context');
        if (!canvas || !gl || !ext) {
          reject(new Error('no WebGL context with WEBGL_lose_context on the world canvas'));
          return;
        }
        let lost = false;
        canvas.addEventListener(
          'webglcontextlost',
          () => {
            lost = gl.isContextLost();
            // Restoring inside the lost event is not allowed; do it on the next task.
            setTimeout(() => ext.restoreContext(), 0);
          },
          { once: true },
        );
        canvas.addEventListener(
          'webglcontextrestored',
          () => resolve({ lost, restored: !gl.isContextLost() }),
          { once: true },
        );
        ext.loseContext();
      }),
  );

test('the frame loop draws the world exactly once per animation frame', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __clears: number };
    w.__clears = 0;
    for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
      const clear = proto.clear;
      proto.clear = function (this: WebGLRenderingContext, mask: number): void {
        w.__clears++;
        clear.call(this, mask);
      };
    }
  });
  await page.goto('/');
  await ready(page);

  const clears = await page.evaluate(
    (frames) =>
      new Promise<number>((resolve) => {
        const w = window as unknown as { __clears: number };
        let left = frames;
        let start = 0;
        const tick = (): void => {
          // Start counting from inside a frame, so both ends of the window fall on a frame edge.
          if (left === frames) start = w.__clears;
          if (left-- === 0) resolve(w.__clears - start);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    COUNTED_FRAMES,
  );
  // One frame of slack at each end: this callback and the frame loop's are separate callbacks
  // of the same animation frame.
  expect(clears, 'canvas clears over the counted frames').toBeGreaterThanOrEqual(
    COUNTED_FRAMES - 1,
  );
  expect(clears, 'canvas clears over the counted frames').toBeLessThanOrEqual(COUNTED_FRAMES + 1);
});

test('the world redraws its terrain after a WebGL context loss and restore', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await ready(page);

  // The scene is drawn and still: two consecutive screenshots agree.
  let before = await canvasShot(page);
  await expect
    .poll(
      async () => {
        const next = await canvasShot(page);
        const changed = await changedFraction(page, before, next);
        before = next;
        return changed;
      },
      { message: 'the idle scene settles', timeout: 20_000 },
    )
    .toBeLessThanOrEqual(MAX_CHANGED_FRACTION);

  expect(await loseAndRestoreContext(page), 'the context was lost, then restored').toEqual({
    lost: true,
    restored: true,
  });

  await expect
    .poll(async () => changedFraction(page, before, await canvasShot(page)), {
      message: 'the restored world matches the world before the loss',
      timeout: 20_000,
    })
    .toBeLessThanOrEqual(MAX_CHANGED_FRACTION);
});
