import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// Remote-walk e2e: one browser context WATCHES another walk a straight line, twice.
//
// The server writes a walking character's public `character` row once per step, and again on
// the same tile (action Idle) whenever a tick finds its move queue empty. The watcher's store
// keeps one snapshot per position (a same-tile row replaces the row and adds no snapshot), so
// its interpolation ring (depth 4) holds four consecutive tiles. While the remote is on a
// straight walk the watcher draws it past its newest tile, in the walk direction, at most half
// a tile and for at most JITTER_IDLE_GAP_STEPS (3) x STEP_MS after the newest step arrived, so
// a late step does not stop it; when the walk ends it settles back onto its last tile.
//
// 1. HELD walk (east). The walker's outgoing WebSocket messages are held, and released by the
//    walker's own Idle row. The client sends its next step only once the row acknowledging the
//    previous one arrives; that tick writes the row with action Walking, and the NEXT tick,
//    finding the queue empty (the step is held), writes the same-tile Idle row. Released on
//    that Idle row, the step reaches the server just after that tick and well before the next
//    (the release costs one walker frame and a call into the test process), so every step
//    misses exactly one tick, and the watcher receives the stream players reported: position
//    change, a same-tile Idle row one step later, the next position change two steps after the
//    previous one. Asserted as a precondition, so a run where the hold did not shape the
//    stream, or where a step missed two ticks, cannot pass.
// 2. UNHELD walk (back west). Localhost: a step on every tick, no Idle row between steps.
//    It protects the one-step-per-tick stream: the ring, the order, the glide, no snap, the
//    settle.
// Both walks share the two contexts and the corridor, and each starts from rest; the hold is a
// switch the route reads.
//
// The walker is driven by a held key (main.ts's real input path); the watcher never moves.
// Everything is read from the watcher's `window.__game()` once per animation frame:
//   characters[].tileX/Y    the remote's authoritative tile in the watcher's store
//   characters[].action     the remote's row action (Idle rows are visible here)
//   characters[].history    the remote's interpolation ring, oldest first
//   rendered[]              the position the frame loop last handed the renderer
// Frame times are the watcher's rAF timestamps; the key release is recorded on the same clock
// (the watcher page's performance.now()).
//
// WORLD FACTS (asserted at runtime, loudly): both players spawn on (1,1) in zone 0, and the
// y=1 row is walkable and grass-free for x=1..8. Each walk ends short of the corridor's ends,
// so the remote is continued toward a walkable tile and the settle back is exercised.

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
  characters: {
    entityId: string;
    tileX: number;
    tileY: number;
    action: string;
    history: Tile[];
  }[];
  rendered: { entityId: string; x: number; y: number }[];
}

/** One animation frame of the watcher: where it holds and draws the walker. */
interface Frame {
  t: number;
  tile: Tile;
  action: string;
  history: Tile[];
  drawn: Tile;
}

const CORRIDOR_Y = 1;
const CORRIDOR_MIN_X = 1;
const CORRIDOR_MAX_X = 8;
/** The continuation window, in steps: JITTER_IDLE_GAP_STEPS (client/src/shared/interpConfig.ts). */
const WINDOW_STEPS = 3;
/** The adaptive interpolation delay's cap, in steps: INTERP_MAX_DELAY_STEPS (render/config.ts). */
const MAX_DELAY_STEPS = 2.5;
/**
 * Read by the walker's WebSocket route on every message the page sends: when set, the message
 * is held in `heldWalkerSends` instead of reaching the server. Rows from the server reach the
 * walker as they arrive. The held walk sets it, and a walker-page observer releases the held step
 * on the walker's own same-tile Idle row, so the step lands on the server just after the tick
 * that wrote that row. A fixed delay cannot give this stream: the walker's frame time adds to
 * it, so on a slow machine a step misses two ticks and arrives a whole continuation window
 * after the one before.
 */
let holdWalkerSends = false;

/** The walker's held sends, oldest first; each forwards one message to the server. */
const heldWalkerSends: (() => void)[] = [];

/** Forward every held send to the server, in the order the page sent them. */
function releaseHeldWalkerSends(): void {
  for (const send of heldWalkerSends.splice(0)) send();
}

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

/** What one recorded walk yields. */
interface Walk {
  frames: Frame[];
  start: Tile;
  end: Tile;
  /** +1 east, -1 west. */
  dir: 1 | -1;
  releaseAt: number;
  stepMs: number;
}

test.describe
  .serial('remote walk — a watcher sees the walker keep walking between steps', () => {
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
      // Installed before the walker navigates, so its SpacetimeDB connection goes through the
      // route, and the walker page can call the release. The route holds what the page sends
      // while `holdWalkerSends` is set and forwards it at once otherwise. It installs no
      // server-side handler, so Playwright forwards every server message to the page unchanged.
      await walker.exposeFunction('__releaseWalkerSends', releaseHeldWalkerSends);
      await walker.routeWebSocket(/.*/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => {
          if (holdWalkerSends) heldWalkerSends.push(() => server.send(m));
          else server.send(m);
        });
      });
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

    /**
     * From rest, hold `key` until the walker's predicted tile is `steps` tiles from where it
     * stands, release, let everything settle, and return the watcher's frames. The key goes down
     * only after the walker has stood on its start tile, held by the watcher, for longer than the
     * continuation window. The release is read on the watcher's clock just BEFORE the key goes
     * up, so the checked span can only be shorter.
     */
    async function walk(key: 'ArrowRight' | 'ArrowLeft', steps: number): Promise<Walk> {
      const dir = key === 'ArrowRight' ? 1 : -1;
      const w0 = await snap(walker);
      const start = w0.ownAuthTile;
      const walkerId = w0.ownEntityId;
      if (start === null || walkerId === null) throw new Error('the walker has no character row');
      expect(start.y, 'precondition: the walker stands on the corridor row').toBe(CORRIDOR_Y);
      for (let x = CORRIDOR_MIN_X; x <= CORRIDOR_MAX_X; x += 1) {
        const i = CORRIDOR_Y * w0.map.width + x;
        if (w0.map.walkable[i] !== true || w0.map.grass[i] === true) {
          throw new Error(
            `remote-walk precondition: (${x}, ${CORRIDOR_Y}) must be walkable and grass-free`,
          );
        }
      }
      const target = start.x + dir * steps;
      // The walk ends at least one tile inside the corridor, so the tile ahead is walkable.
      expect(target, 'precondition: the walk ends inside the corridor').toBeGreaterThan(
        CORRIDOR_MIN_X,
      );
      expect(target).toBeLessThan(CORRIDOR_MAX_X);
      const stepMs = w0.stepMs;
      // The watcher holds and draws the walker at rest on its start tile.
      await watcher.waitForFunction(
        ({ id, x }: { id: string; x: number }) => {
          const g = (window as unknown as { __game: () => Snap }).__game();
          const c = g.characters.find((d) => d.entityId === id);
          const r = g.rendered.find((d) => d.entityId === id);
          return c !== undefined && c.tileX === x && r !== undefined && Math.abs(r.x - x) < 1e-9;
        },
        { id: walkerId, x: start.x },
        { timeout: 15_000 },
      );
      // The walk starts from rest as the watcher's store measures it: the walker has stood on
      // its start tile for longer than the continuation window, so the walk's first position
      // change is no jitter sample (the store takes one only from position changes at most that
      // window apart, and a same-tile row moves no base) and the render delay starts from the
      // value it holds at rest. A walk that starts sooner after the walker's row first arrives
      // raises the delay early and shortens how long a renderer that never continues stands
      // still. The wait is the window plus one step: the step of slack puts the first change
      // strictly past the store's `<=` gate at the window.
      await watcher.waitForTimeout((WINDOW_STEPS + 1) * stepMs);

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
              action: c.action,
              history: c.history,
              drawn: { x: r.x, y: r.y },
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, walkerId);

      // The walker's window must hold keyboard focus for the whole hold: main.ts releases
      // every held key on a window blur. No canvas click here: a click on a player opens the
      // world sheet, which blocks movement.
      await walker.bringToFront();
      await walker.keyboard.down(key);
      await walker.waitForFunction(
        (want: number) =>
          (window as unknown as { __game: () => Snap }).__game().ownPredictedTile?.x === want,
        target,
        { timeout: 20_000 },
      );
      const releaseAt = await watcher.evaluate(() => performance.now());
      await walker.keyboard.up(key);
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
      return { frames, start, end, dir, releaseAt, stepMs };
    }

    /** When each tile reached the watcher: the first frame holding it (index k = k-th tile). */
    function arrivalsOf(w: Walk): { tiles: number[]; arrivals: number[]; log: string } {
      const tiles: number[] = [];
      for (const f of w.frames) {
        expect(f.tile.y, 'the remote never leaves the corridor row').toBe(CORRIDOR_Y);
        if (tiles[tiles.length - 1] !== f.tile.x) tiles.push(f.tile.x);
      }
      const arrivals = tiles.map((x) => (w.frames.find((f) => f.tile.x === x) as Frame).t);
      const log = arrivals.map((t, k) => `${tiles[k]}@${Math.round(t)}`).join(' ');
      return { tiles, arrivals, log };
    }

    /**
     * A STALLED step: one that reached the watcher more than the continuation window after the
     * step before it. Past the window the remote correctly settles back onto its newest tile and
     * waits there until the late step's slide starts, at most the delay cap after it arrives.
     * That is network weather, not a defect, so the stand-still and never-backward checks skip
     * frames inside [previous arrival + window, late arrival + delay cap].
     */
    function stalledIn(arrivals: readonly number[], stepMs: number): (t: number) => boolean {
      const stalls: [number, number][] = [];
      for (let k = 1; k < arrivals.length; k += 1) {
        const prev = arrivals[k - 1] as number;
        const cur = arrivals[k] as number;
        if (cur - prev > WINDOW_STEPS * stepMs) {
          stalls.push([prev + WINDOW_STEPS * stepMs, cur + MAX_DELAY_STEPS * stepMs]);
        }
      }
      return (t) => stalls.some(([a, b]) => t >= a && t <= b);
    }

    /**
     * The longest run of consecutive frames with an identical drawn position in [from, to],
     * measured as last-frame time minus first-frame time; a stalled frame ends a run. Also the
     * number of unstalled frames considered.
     */
    function longestStill(
      frames: readonly Frame[],
      from: number,
      to: number,
      stalled: (t: number) => boolean,
    ): { ms: number; at: string; counted: number } {
      const EPS = 1e-6;
      const span = frames.filter((f) => f.t >= from && f.t <= to);
      let runStart: Frame | undefined;
      let best = { ms: 0, at: 'none' };
      let counted = 0;
      for (let i = 0; i < span.length; i += 1) {
        const cur = span[i] as Frame;
        if (stalled(cur.t)) {
          runStart = undefined;
          continue;
        }
        counted += 1;
        const prev = runStart === undefined ? undefined : (span[i - 1] as Frame);
        const same =
          prev !== undefined &&
          Math.abs(cur.drawn.x - prev.drawn.x) <= EPS &&
          Math.abs(cur.drawn.y - prev.drawn.y) <= EPS;
        if (runStart === undefined || !same) runStart = cur;
        const ms = cur.t - runStart.t;
        if (ms > best.ms) {
          best = {
            ms,
            at: `x=${cur.drawn.x} from ${Math.round(runStart.t)} to ${Math.round(cur.t)}`,
          };
        }
      }
      return { ...best, counted };
    }

    /** Every np-a.9 assertion, and what the one-step-per-tick stream always guaranteed. */
    function checkWalk(w: Walk, minSteps: number): { arrivals: number[]; log: string } {
      const { frames, start, end, dir, releaseAt, stepMs } = w;
      const steps = (end.x - start.x) * dir;
      expect(steps, 'ANTI-VACUITY: the walker actually walked').toBeGreaterThanOrEqual(minSteps);
      expect(end.y, 'the walk stays on the corridor row').toBe(CORRIDOR_Y);
      expect(frames.length, 'ANTI-VACUITY: the watcher sampled frames').toBeGreaterThan(steps * 4);

      // 1. The authoritative tile the watcher holds: every tile of the line, in order.
      const { tiles, arrivals, log } = arrivalsOf(w);
      expect(
        tiles,
        'the watcher receives each tile of the walk exactly once, in order: no tile skipped, ' +
          'none revisited',
      ).toEqual(Array.from({ length: steps + 1 }, (_, i) => start.x + dir * i));
      const stalled = stalledIn(arrivals, stepMs);

      // 2. The sprite: never backwards while the key is held, never a whole tile in one
      //    ordinary frame, and drawn BETWEEN every pair of tiles it crosses (a glide).
      const EPS = 1e-6;
      for (let i = 1; i < frames.length; i += 1) {
        const prev = frames[i - 1] as Frame;
        const cur = frames[i] as Frame;
        expect(cur.drawn.y, 'the sprite stays on the corridor row').toBeCloseTo(CORRIDOR_Y, 6);
        const along = (cur.drawn.x - prev.drawn.x) * dir;
        if (cur.t <= releaseAt && !stalled(prev.t) && !stalled(cur.t)) {
          expect(
            along,
            `the sprite never moves backwards while the key is held (frame ${i} at ` +
              `${Math.round(cur.t)}: ${prev.drawn.x} → ${cur.drawn.x}; arrivals ${log})`,
          ).toBeGreaterThanOrEqual(-EPS);
        }
        // A frame shorter than half a step cannot legitimately cover a whole tile.
        if (cur.t - prev.t < stepMs / 2) {
          expect(
            Math.abs(along),
            `no snap: the sprite jumped ${along} tiles in a ${cur.t - prev.t}ms frame ` +
              `(${prev.drawn.x} → ${cur.drawn.x})`,
          ).toBeLessThan(1);
        }
      }
      for (let k = Math.min(start.x, end.x); k < Math.max(start.x, end.x); k += 1) {
        expect(
          frames.some((f) => f.drawn.x > k + EPS && f.drawn.x < k + 1 - EPS),
          `the sprite is drawn between tiles ${k} and ${k + 1} on at least one frame`,
        ).toBe(true);
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
            (p.cur.drawn.x - p.prev.drawn.x) * dir < -EPS,
        );
      const settled = backward.reduce(
        (sum, p) => sum + Math.abs(p.prev.drawn.x - p.cur.drawn.x),
        0,
      );
      expect(settled, 'the settle after the release is at most half a tile').toBeLessThanOrEqual(
        0.5 + EPS,
      );
      if (backward.length > 0) {
        const first = backward[0] as { cur: Frame; prev: Frame };
        const lastBack = backward[backward.length - 1] as { cur: Frame; prev: Frame };
        expect(
          lastBack.cur.t - first.prev.t,
          `the settle after the release takes at most one step (arrivals ${log})`,
        ).toBeLessThanOrEqual(stepMs);
      }

      // 3. np-a.9: between the watcher's second authoritative position change for the walker
      //    and the key's release, the drawn position never stands still for a step or longer.
      const secondChange = arrivals[2];
      if (secondChange === undefined) throw new Error('the watcher saw fewer than two changes');
      const still = longestStill(frames, secondChange, releaseAt, stalled);
      expect(
        still.counted,
        `INCONCLUSIVE: no unstalled frames between the second change and the release ` +
          `(release ${Math.round(releaseAt)}; arrivals ${log})`,
      ).toBeGreaterThan(1);
      expect(
        still.ms,
        `np-a.9: the sprite stood still ${Math.round(still.ms)} ms (${still.at}; release ` +
          `${Math.round(releaseAt)}; arrivals ${log})`,
      ).toBeLessThan(stepMs);

      // 4. np-a.9: within the window plus two steps after the last position change, the drawn
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
      const last = frames[frames.length - 1] as Frame;
      expect(last.drawn.x, 'the sprite comes to rest on the final tile').toBeCloseTo(end.x, 6);

      // 5. One snapshot per position: at some frame mid-walk the ring is four consecutive tiles.
      const rings = frames.map((f) => f.history.map((h) => h.x));
      const consecutive = rings.filter(
        (r) => r.length === 4 && r.every((x, i) => i === 0 || x === (r[i - 1] as number) + dir),
      );
      expect(
        consecutive.length,
        'during a straight walk the interpolation ring (depth 4) must at some frame hold four ' +
          'CONSECUTIVE tiles. A snapshot per row update leaves it holding a tile twice. ' +
          `Rings seen: ${[...new Set(rings.map((r) => r.join(',')))].join(' | ')}`,
      ).toBeGreaterThanOrEqual(1);
      return { arrivals, log };
    }

    test('with a step every other tick and an Idle row between steps, the remote keeps walking, never pausing 100 ms, and settles on the last tile [np-a.9]', async () => {
      // The walker's sends are held for the whole walk. Once per walker frame the observer
      // notices a new send, and releases the held step once the walker's own row is Idle. The
      // client sends its next step only after the row acknowledging the previous one arrives,
      // and the tick that drained that step wrote it with action Walking; a held step cannot
      // reach the server, so only the next tick, finding the queue empty, writes Idle. A row
      // that is already Idle when the send goes out releases it at once: the press at the
      // standing start (the row is Idle at rest) and the step after a turn in place (the turn's
      // row is Idle).
      holdWalkerSends = true;
      let w: Walk;
      try {
        await walker.evaluate(() => {
          const win = window as unknown as {
            __game: () => {
              moveSendCount: number;
              ownEntityId: string | null;
              characters: { entityId: string; action: string }[];
            };
            __releaseWalkerSends: () => Promise<void>;
            __holdObserving: boolean;
          };
          win.__holdObserving = true;
          let sent = win.__game().moveSendCount;
          let pending = false;
          const observe = (): void => {
            if (!win.__holdObserving) return;
            const g = win.__game();
            if (g.moveSendCount !== sent) {
              sent = g.moveSendCount;
              pending = true;
            }
            const me = g.characters.find((c) => c.entityId === g.ownEntityId);
            if (pending && me?.action === 'Idle') {
              pending = false;
              // Handled: main.ts records an unhandled rejection as a client error and shows its
              // error overlay, and a fault in the test's release is not the client's.
              win.__releaseWalkerSends().catch(() => {});
            }
            requestAnimationFrame(observe);
          };
          requestAnimationFrame(observe);
        });
        w = await walk('ArrowRight', 6); // (1,1) -> (7,1); (8,1) ahead is walkable
      } finally {
        holdWalkerSends = false;
        releaseHeldWalkerSends();
        // Tolerant: a closed walker page must not replace the walk's own error.
        await walker
          .evaluate(() => {
            (window as unknown as { __holdObserving: boolean }).__holdObserving = false;
          })
          .catch(() => {});
      }
      const { frames, releaseAt, stepMs } = w;
      const { tiles, arrivals, log } = arrivalsOf(w);

      // PRECONDITION — the hold shaped the stream: the watcher received the reported stream.
      // Between consecutive position changes it saw a same-tile Idle row, and the changes came
      // about two steps apart, not three, and no step inside the checked span missed two ticks.
      // Without it this test would only repeat the unheld one, or test a stream where a step
      // misses two ticks.
      let withIdle = 0;
      const gaps: number[] = [];
      for (let k = 2; k < arrivals.length; k += 1) {
        const from = arrivals[k - 1] as number;
        const to = arrivals[k] as number;
        gaps.push(to - from);
        if (
          frames.some(
            (f) => f.t > from && f.t < to && f.tile.x === tiles[k - 1] && f.action === 'Idle',
          )
        ) {
          withIdle += 1;
        }
      }
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
      expect(
        withIdle,
        `PRECONDITION: an Idle row on the same tile between most position changes ` +
          `(${withIdle} of ${gaps.length}; arrivals ${log})`,
      ).toBeGreaterThanOrEqual(Math.ceil(gaps.length / 2));
      expect(
        median,
        `PRECONDITION: position changes about two steps apart (arrivals ${log})`,
      ).toBeGreaterThanOrEqual(1.5 * stepMs);
      // 2.5 steps: midway between the two-step stream and the three-step stream of a step that
      // missed two ticks.
      expect(
        median,
        `PRECONDITION: position changes about two steps apart, not three (arrivals ${log})`,
      ).toBeLessThan(2.5 * stepMs);
      // Every gap inside the checked span [arrivals[2], releaseAt]: k = 2 ends at the second
      // change, before the span. Read from `arrivals`, since `gaps` is sorted above.
      const missedTwo: string[] = [];
      for (let k = 3; k < arrivals.length; k += 1) {
        const at = arrivals[k] as number;
        const gap = at - (arrivals[k - 1] as number);
        if (at <= releaseAt && gap >= 2.5 * stepMs) {
          missedTwo.push(`${Math.round(gap)} ms ending at ${tiles[k]}@${Math.round(at)}`);
        }
      }
      expect(
        missedTwo,
        `PRECONDITION: a step missed two ticks inside the checked span (gaps ` +
          `${missedTwo.join(', ')}; arrivals ${log})`,
      ).toEqual([]);

      // np-a.9 for this stream. np-a.3 states the bound for exactly this stream (steps two
      // STEP_MS apart with same-tile Idle rows between them): no interval of 100 ms (STEP_MS / 2)
      // or more standing still. np-a.9's own "STEP_MS or longer" reads 183 ms of stand-still per
      // tile as a pass, so this bound, between the second authoritative position change and the
      // release (stalls exempt, as in checkWalk), is what proves the remote keeps walking on
      // this stream. Measured: about 33 ms at most; 133 ms on the first checked tile for a
      // renderer that never continues a walk; about 183 ms on every tile for a store that keeps
      // a snapshot per same-tile row.
      const secondChange = arrivals[2];
      if (secondChange === undefined) throw new Error('the watcher saw fewer than two changes');
      const still = longestStill(frames, secondChange, releaseAt, stalledIn(arrivals, stepMs));
      expect(
        still.ms,
        `the sprite stood still ${Math.round(still.ms)} ms (${still.at}; release ` +
          `${Math.round(releaseAt)}; arrivals ${log})`,
      ).toBeLessThan(stepMs / 2);

      checkWalk(w, 6);
    });

    test('with a step every tick, the remote advances one tile per step, gliding, the ring holds four consecutive tiles, and it settles on the last tile [np-a.9]', async () => {
      holdWalkerSends = false;
      const w = await walk('ArrowLeft', 5); // (7,1) -> (2,1); (1,1) ahead is walkable
      checkWalk(w, 5);
    });
  });
