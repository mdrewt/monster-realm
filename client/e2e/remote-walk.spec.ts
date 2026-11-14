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
// The server writes a walking character's public `character` row once per step, and again on
// the same tile (action Idle) whenever a tick finds its move queue empty. The watcher's store
// keeps one snapshot per position (a same-tile row replaces the row and adds no snapshot), so
// its interpolation ring (depth 4) holds four consecutive tiles. While the remote is on a
// straight walk the watcher draws it past its newest tile, in the walk direction, at most half
// a tile and for at most JITTER_IDLE_GAP_STEPS (3) x STEP_MS after the newest step arrived, so
// a late step does not stop it; when the walk ends it settles back onto its last tile.
//
// The walker is driven by a held key (main.ts's real input path); the watcher never moves.
// Everything is read from the watcher's `window.__game()` once per animation frame:
//   characters[].tileX/Y    the remote's authoritative tile in the watcher's store
//   characters[].history    the remote's interpolation ring, oldest first
//   rendered[]              the position the frame loop last handed the renderer
// Frame times are the watcher's rAF timestamps; the key release is recorded on the same clock
// (the watcher page's performance.now()).
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
/** The continuation window, in steps: JITTER_IDLE_GAP_STEPS (client/src/shared/interpConfig.ts). */
const WINDOW_STEPS = 3;
/** The adaptive interpolation delay's cap, in steps: INTERP_MAX_DELAY_STEPS (render/config.ts). */
const MAX_DELAY_STEPS = 2.5;

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

    test('the remote sprite advances one tile per step, gliding without standing still, the ring holds four consecutive tiles, and it settles on the last tile [np-a.9]', async () => {
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
      // The release on the watcher's clock, read just BEFORE the key goes up: the stand-still
      // check below ends here, so reading it early can only shorten the checked span.
      const releaseAt = await watcher.evaluate(() => performance.now());
      await walker.keyboard.up('ArrowRight');
      // The walker settles, then the watcher's delayed render clock catches up, the
      // continuation window runs out and the remote settles back onto its last tile.
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
      await watcher.waitForTimeout(8 * stepMs);

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

      // When each tile reached the watcher: the first frame holding it (arrivals[k] is tile
      // start.x + k; arrivals[0] is the first frame).
      const arrivals = tiles.map((x) => (frames.find((f) => f.tile.x === x) as Frame).t);
      const arrivalLog = arrivals.map((t, k) => `${start.x + k}@${Math.round(t)}`).join(' ');
      // A STALLED step: one that reached the watcher more than the continuation window after
      // the step before it. Past the window the remote correctly settles back onto its newest
      // tile and waits there (up to half a tile backward, then still) until the late step's
      // slide starts, at most the delay cap after it arrives. That is network weather, not a
      // defect, so the stand-still and never-backward checks skip frames inside a stall
      // [previous arrival + window, late arrival + delay cap]. The other checks hold everywhere.
      // A run with no unstalled span between the second change and the release proves nothing
      // about np-a.9 and fails as inconclusive, printing the arrivals.
      const stalls: [number, number][] = [];
      for (let k = 1; k < arrivals.length; k += 1) {
        const gap = (arrivals[k] as number) - (arrivals[k - 1] as number);
        if (gap > WINDOW_STEPS * stepMs) {
          stalls.push([
            (arrivals[k - 1] as number) + WINDOW_STEPS * stepMs,
            (arrivals[k] as number) + MAX_DELAY_STEPS * stepMs,
          ]);
        }
      }
      const stalled = (t: number): boolean => stalls.some(([a, b]) => t >= a && t <= b);

      // 3. The sprite: never backwards through the walk, never a whole tile in one ordinary
      //    frame, and it is drawn BETWEEN every pair of tiles it crosses (a glide, not a jump).
      const EPS = 1e-6;
      for (let i = 1; i < frames.length; i += 1) {
        const prev = frames[i - 1] as Frame;
        const cur = frames[i] as Frame;
        expect(cur.drawn.y, 'the sprite stays on the corridor row').toBeCloseTo(CORRIDOR_Y, 6);
        const dx = cur.drawn.x - prev.drawn.x;
        if (cur.t <= releaseAt && !stalled(prev.t) && !stalled(cur.t)) {
          expect(
            dx,
            `the sprite never moves backwards while the key is held (frame ${i} at ` +
              `${Math.round(cur.t)}: ${prev.drawn.x} → ${cur.drawn.x}; arrivals ${arrivalLog})`,
          ).toBeGreaterThanOrEqual(-EPS);
        }
        // A frame shorter than half a step cannot legitimately cover a whole tile.
        if (cur.t - prev.t < stepMs / 2) {
          expect(
            dx,
            `no snap: the sprite jumped ${dx} tiles in a ${cur.t - prev.t}ms frame ` +
              `(${prev.drawn.x} → ${cur.drawn.x})`,
          ).toBeLessThan(1);
        }
      }
      // After the release: one settle back onto the last tile, at most half a tile, inside one
      // step (the remote was drawn at most 0.5 past its newest tile, and slews back at no more
      // than a tile per step).
      const backward = frames
        .map((cur, i) => ({ cur, prev: frames[i - 1] }))
        .filter(
          (p): p is { cur: Frame; prev: Frame } =>
            p.prev !== undefined &&
            p.cur.t > releaseAt &&
            !stalled(p.prev.t) &&
            !stalled(p.cur.t) &&
            p.cur.drawn.x - p.prev.drawn.x < -EPS,
        );
      const settled = backward.reduce((sum, p) => sum + (p.prev.drawn.x - p.cur.drawn.x), 0);
      expect(settled, `the settle after the release is at most half a tile`).toBeLessThanOrEqual(
        0.5 + EPS,
      );
      if (backward.length > 0) {
        const first = backward[0] as { cur: Frame; prev: Frame };
        const lastBack = backward[backward.length - 1] as { cur: Frame; prev: Frame };
        expect(
          lastBack.cur.t - first.prev.t,
          `the settle after the release takes at most one step (arrivals ${arrivalLog})`,
        ).toBeLessThanOrEqual(stepMs);
      }

      // 4. np-a.9: between the watcher's second authoritative position change for the walker
      //    and the key's release, the drawn position never stands still for a step or longer.
      const secondChange = arrivals[2];
      if (secondChange === undefined) throw new Error('the watcher saw fewer than two changes');
      const held = frames.filter((f) => f.t >= secondChange && f.t <= releaseAt);
      expect(
        held.filter((f) => !stalled(f.t)).length,
        `INCONCLUSIVE: no unstalled frames between the second change and the release ` +
          `(release ${Math.round(releaseAt)}; arrivals ${arrivalLog})`,
      ).toBeGreaterThan(1);
      // A run is consecutive frames with an identical drawn position; a stalled frame ends it.
      let runStart: Frame | undefined;
      for (let i = 0; i < held.length; i += 1) {
        const cur = held[i] as Frame;
        if (stalled(cur.t)) {
          runStart = undefined;
          continue;
        }
        const prev = runStart === undefined ? undefined : (held[i - 1] as Frame);
        const same =
          prev !== undefined &&
          Math.abs(cur.drawn.x - prev.drawn.x) <= EPS &&
          Math.abs(cur.drawn.y - prev.drawn.y) <= EPS;
        if (runStart === undefined || !same) runStart = cur;
        expect(
          cur.t - runStart.t,
          `the sprite stood still on x=${cur.drawn.x} from ${Math.round(runStart.t)} to ` +
            `${Math.round(cur.t)} (release ${Math.round(releaseAt)}; arrivals ${arrivalLog})`,
        ).toBeLessThan(stepMs);
      }

      // 5. np-a.9: within the window plus two steps after the last position change, the drawn
      //    position equals the walker's authoritative tile and stays there.
      const lastChange = arrivals[arrivals.length - 1] as number;
      const restBy = lastChange + (WINDOW_STEPS + 2) * stepMs;
      const resting = frames.filter((f) => f.t >= restBy);
      expect(
        resting.length,
        `ANTI-VACUITY: frames sampled after ${Math.round(restBy)} (last change ${Math.round(lastChange)})`,
      ).toBeGreaterThan(0);
      for (const f of resting) {
        expect(f.drawn.x, `on the final tile at ${Math.round(f.t)}`).toBeCloseTo(end.x, 6);
        expect(f.drawn.y).toBeCloseTo(CORRIDOR_Y, 6);
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
