import { expect, type Page, test } from '@playwright/test';

// render-context.spec.ts — the world survives a WebGL context loss.
//
// A browser may drop a page's WebGL context at any time (GPU process restart, driver reset, a
// backgrounded mobile tab). Pixi restores image-backed textures by itself, but a texture that was
// RENDERED (the baked terrain chunks) comes back empty, so the renderer must re-bake on restore.
// The same screenshots prove the frame loop is what draws: Pixi's own ticker is stopped, so a
// frame loop that stopped drawing would leave the canvas one flat colour.
//
// ORACLE. Two screenshots of the same idle scene, before the loss and after the restore, compared
// pixel by pixel in the page. Reduced motion holds the water and warp animations on frame 0, so the
// only legitimate differences are a wandering NPC's few tiles.
//
// HYGIENE. One page, closed with the test; no fixed sleep decides an assertion.
//
// REDS AT MASTER: the restore assertion. The terrain stays blank after a restore there (measured:
// 30% of the 1280x720 canvas differs on the 10x7 zone, 98% on a zone that fills the canvas).

test.use({ viewport: { width: 1280, height: 720 }, contextOptions: { reducedMotion: 'reduce' } });

/** Largest share of the canvas a wandering NPC can repaint between the two screenshots. */
const MAX_CHANGED_FRACTION = 0.02;
/** A drawn world shows far more colours than this; a canvas nothing drew to shows one. */
const MIN_DRAWN_COLOURS = 8;

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

interface Comparison {
  readonly changedFraction: number;
  readonly coloursInFirst: number;
}

/** Decode both PNGs in the page and compare them (no image dependency in the test runner). */
const compare = (p: Page, first: string, second: string): Promise<Comparison> =>
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
      if (pa.length !== pb.length) return { changedFraction: 1, coloursInFirst: 0 };
      const colours = new Set<number>();
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        colours.add((pa[i] << 16) | (pa[i + 1] << 8) | pa[i + 2]);
        if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) changed++;
      }
      return { changedFraction: changed / (pa.length / 4), coloursInFirst: colours.size };
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

test('the world redraws its terrain after a WebGL context loss and restore', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // The scene is drawn and still: two consecutive screenshots agree.
  let before = await canvasShot(page);
  await expect
    .poll(
      async () => {
        const next = await canvasShot(page);
        const result = await compare(page, before, next);
        before = next;
        return result.changedFraction;
      },
      { message: 'the idle scene settles', timeout: 20_000 },
    )
    .toBeLessThanOrEqual(MAX_CHANGED_FRACTION);
  const drawn = await compare(page, before, before);
  expect(drawn.coloursInFirst, 'the frame loop drew the world').toBeGreaterThan(MIN_DRAWN_COLOURS);

  expect(await loseAndRestoreContext(page), 'the context was lost, then restored').toEqual({
    lost: true,
    restored: true,
  });

  await expect
    .poll(async () => (await compare(page, before, await canvasShot(page))).changedFraction, {
      message: 'the restored world matches the world before the loss',
      timeout: 20_000,
    })
    .toBeLessThanOrEqual(MAX_CHANGED_FRACTION);
});
