import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// Remote-walk e2e: one browser context WATCHES another walk a straight line.
//
// A walking character costs the server one `character` row write per step, so a watcher
// receives one update per step: its interpolation ring (depth 4) holds four consecutive
// tiles, and the remote sprite glides tile to tile at the server's cadence. A second write
// per step (a queue or ack write on the public row at accept) would fill half the ring with
// repeats of a tile, halving the history the interpolator has to bracket the render time.
//
// The walker is driven by a held key (main.ts's real input path); the watcher never moves.
// Everything is read from the watcher's `window.__game()` once per animation frame:
//   characters[].tileX/Y    the remote's authoritative tile in the watcher's store
//   characters[].history    the remote's interpolation ring, oldest first
//   rendered[]              the position the frame loop last handed the renderer
//
// WORLD FACTS (asserted at runtime, loudly): both players spawn on (1,1) in zone 0, and the
// y=1 row is walkable and grass-free for x=1..8.

interface Tile {
  x: number;
  y: number;
}
interface Snap {
  identity: string;
  stepMs: number;
  map: { zone_id: number; width: number; height: number; walkable: boolean[]; grass: boolean[] };
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  ownPredictedTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; tileX: number; tileY: number; history: Tile[] }[];
  rendered: { entityId: string; x: number; y: number }[];
}

/** One animation frame of the watcher: where it holds and draws the walker. */
interface Frame {
  t: number;
  tile: Tile;
  history: Tile[];
  drawn: Tile;
}

const CORRIDOR_Y = 1;
/** Tiles the walker must cover for the ring (depth 4) to have turned over more than once. */
const MIN_STEPS = 5;

const snap = (p: Page): Promise<Snap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => Snap }).__game();
    return {
      identity: g.identity,
      stepMs: g.stepMs,
      map: g.map,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      ownPredictedTile: g.ownPredictedTile,
      presenceCount: g.presenceCount,
      characters: g.characters,
      rendered: g.rendered,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => Snap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

test.describe
  .serial('remote walk — a watcher sees one update per step', () => {
    let browser: Browser;
    let ctxWalker: BrowserContext;
    let ctxWatcher: BrowserContext;
    let walker: Page;
    let watcher: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctxWalker = await browser.newContext();
      ctxWatcher = await browser.newContext();
      walker = await ctxWalker.newPage();
      watcher = await ctxWatcher.newPage();
      await walker.goto('/');
      await watcher.goto('/');
      await ready(walker);
      await ready(watcher);
      for (const p of [walker, watcher]) {
        await p.waitForFunction(
          () => (window as unknown as { __game: () => Snap }).__game().presenceCount === 2,
          null,
          { timeout: 30_000 },
        );
      }
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('the remote sprite advances one tile per step, gliding, and the ring holds four consecutive tiles', async () => {
      const w0 = await snap(walker);
      const start = w0.ownAuthTile;
      const walkerId = w0.ownEntityId;
      if (start === null || walkerId === null) throw new Error('the walker has no character row');
      expect(start, 'precondition: the walker stands on the spawn tile').toEqual({
        x: 1,
        y: CORRIDOR_Y,
      });
      for (let x = 1; x <= 8; x += 1) {
        const i = CORRIDOR_Y * w0.map.width + x;
        if (w0.map.walkable[i] !== true || w0.map.grass[i] === true) {
          throw new Error(
            `remote-walk precondition: (${x}, ${CORRIDOR_Y}) must be walkable and grass-free`,
          );
        }
      }
      const stepMs = w0.stepMs;
      await watcher.waitForFunction(
        (id: string) => {
          const g = (window as unknown as { __game: () => Snap }).__game();
          return (
            g.characters.some((c) => c.entityId === id) && g.rendered.some((r) => r.entityId === id)
          );
        },
        walkerId,
        { timeout: 15_000 },
      );

      await watcher.evaluate((id: string) => {
        const w = window as unknown as {
          __game: () => Snap;
          __remoteFrames: Frame[];
          __remoteRec: boolean;
        };
        w.__remoteFrames = [];
        w.__remoteRec = true;
        const sample = (t: number): void => {
          if (!w.__remoteRec) return;
          const g = w.__game();
          const c = g.characters.find((x) => x.entityId === id);
          const r = g.rendered.find((x) => x.entityId === id);
          if (c !== undefined && r !== undefined) {
            w.__remoteFrames.push({
              t,
              tile: { x: c.tileX, y: c.tileY },
              history: c.history,
              drawn: { x: r.x, y: r.y },
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, walkerId);

      // The walker's window must hold keyboard focus for the whole hold: main.ts releases
      // every held key on a window blur. No canvas click here: both characters stand on the
      // spawn tile, and a click on a player opens the world sheet, which blocks movement.
      await walker.bringToFront();
      await walker.keyboard.down('ArrowRight');
      await walker.waitForFunction(
        (want: number) =>
          ((window as unknown as { __game: () => Snap }).__game().ownAuthTile?.x ?? 0) >= want,
        1 + MIN_STEPS,
        { timeout: 15_000 },
      );
      await walker.keyboard.up('ArrowRight');
      // The walker settles, then the watcher's delayed render clock catches up and holds.
      await walker.waitForFunction(
        () => {
          const g = (window as unknown as { __game: () => Snap }).__game();
          const a = g.ownAuthTile;
          const q = g.ownPredictedTile;
          return a !== null && q !== null && a.x === q.x && a.y === q.y;
        },
        null,
        { timeout: 10_000 },
      );
      await watcher.waitForTimeout(6 * stepMs);

      const frames = await watcher.evaluate(() => {
        const w = window as unknown as { __remoteFrames: Frame[]; __remoteRec: boolean };
        w.__remoteRec = false;
        return w.__remoteFrames.slice();
      });
      const end = (await snap(walker)).ownAuthTile;
      if (end === null) throw new Error('the walker lost its character row');
      const steps = end.x - start.x;
      expect(steps, 'ANTI-VACUITY: the walker actually walked').toBeGreaterThanOrEqual(MIN_STEPS);
      expect(end.y, 'the walk stays on the corridor row').toBe(CORRIDOR_Y);
      expect(frames.length, 'ANTI-VACUITY: the watcher sampled frames').toBeGreaterThan(steps * 4);

      // 1. The authoritative tile the watcher holds: every tile of the line, in order.
      const tiles: number[] = [];
      for (const f of frames) {
        expect(f.tile.y, 'the remote never leaves the corridor row').toBe(CORRIDOR_Y);
        if (tiles[tiles.length - 1] !== f.tile.x) tiles.push(f.tile.x);
      }
      expect(
        tiles,
        'the watcher receives each tile of the walk exactly once, in order: no tile skipped, ' +
          'none revisited',
      ).toEqual(Array.from({ length: steps + 1 }, (_, i) => start.x + i));

      // 2. One update per step: at some frame mid-walk the ring is four consecutive tiles.
      const rings = frames.map((f) => f.history.map((h) => h.x));
      const consecutive = rings.filter(
        (r) => r.length === 4 && r.every((x, i) => i === 0 || x === (r[i - 1] as number) + 1),
      );
      expect(
        consecutive.length,
        'during a straight walk the interpolation ring (depth 4) must at some frame hold four ' +
          'CONSECUTIVE tiles. Two row updates per step leave it holding each tile twice, so ' +
          `this never happens. Rings seen: ${[...new Set(rings.map((r) => r.join(',')))].join(' | ')}`,
      ).toBeGreaterThanOrEqual(1);

      // 3. The sprite: never backwards, never a whole tile in one ordinary frame, and it
      //    is drawn BETWEEN every pair of tiles it crosses (a glide, not a jump).
      const EPS = 1e-6;
      for (let i = 1; i < frames.length; i += 1) {
        const prev = frames[i - 1] as Frame;
        const cur = frames[i] as Frame;
        expect(cur.drawn.y, 'the sprite stays on the corridor row').toBeCloseTo(CORRIDOR_Y, 6);
        const dx = cur.drawn.x - prev.drawn.x;
        expect(
          dx,
          `the sprite never moves backwards (frame ${i}: ${prev.drawn.x} → ${cur.drawn.x})`,
        ).toBeGreaterThanOrEqual(-EPS);
        // A frame shorter than half a step cannot legitimately cover a whole tile.
        if (cur.t - prev.t < stepMs / 2) {
          expect(
            dx,
            `no snap: the sprite jumped ${dx} tiles in a ${cur.t - prev.t}ms frame ` +
              `(${prev.drawn.x} → ${cur.drawn.x})`,
          ).toBeLessThan(1);
        }
      }
      for (let k = start.x; k < end.x; k += 1) {
        expect(
          frames.some((f) => f.drawn.x > k + EPS && f.drawn.x < k + 1 - EPS),
          `the sprite is drawn between tiles ${k} and ${k + 1} on at least one frame`,
        ).toBe(true);
      }
      const last = frames[frames.length - 1] as Frame;
      expect(last.drawn.x, 'the sprite comes to rest on the final tile').toBeCloseTo(end.x, 6);
    });
  });
