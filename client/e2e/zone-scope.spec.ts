import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { RawTileMap } from '../src/render/map';
import { safeTile, walkPath } from './controls';

// Zone scope e2e: two players, two zones, one real server.
//
// A client subscribes `character` for its own row and for the zone that row is in, never for the
// world. `player` is world-wide. So a player in another zone is still counted and listed, and
// their character is not held at all. What is read, all from `window.__game()`:
//   worldScope              the character query sets the live connection holds, and `settled`
//   characters[].zoneId     the store's rows, each with its zone
//   characters[].history    a remote's interpolation ring, oldest first
//   presenceCount           the `player` rows held
//
// WORLD FACTS (asserted at runtime, loudly): both players spawn on (1,1) in zone 0; column x=1
// is clean floor for y=1..4 in both zones; the warp tile is (1,5) in each zone and lands on (1,5)
// in the other; a character that lands on a warp tile does not warp again until it steps off and
// back on; row y=1 of zone 1 is clean floor for x=1..8.

interface Tile {
  x: number;
  y: number;
}
interface ScopeSnap {
  own: 'pending' | 'active' | null;
  zones: { zoneId: number; state: 'pending' | 'active' }[];
  settled: boolean;
}
interface Snap {
  identity: string;
  map: RawTileMap;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; zoneId: number; tileX: number; tileY: number; history: Tile[] }[];
  worldScope: ScopeSnap;
}
/** One animation frame of the watcher: the walker's row and ring as the watcher holds them. */
interface Frame {
  tile: Tile;
  history: Tile[];
}

const WARP: Tile = { x: 1, y: 5 };
const SPAWN: Tile = { x: 1, y: 1 };
/** The scope's linger (worldScope.ts LINGER_MS) plus its 500 ms tick and slack. */
const LINGER_WAIT_MS = 15_000;

const snap = (p: Page): Promise<Snap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => Snap }).__game();
    return {
      identity: g.identity,
      map: g.map,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      presenceCount: g.presenceCount,
      characters: g.characters,
      worldScope: g.worldScope,
    };
  });

/** Joined, own row held, and the scope settled on the zone the own row is in. */
async function settledIn(p: Page, zoneId: number, label: string): Promise<void> {
  await p
    .waitForFunction(
      (zone: number) => {
        const w = window as unknown as { __game?: () => Snap };
        if (!w.__game) return false;
        const g = w.__game();
        return (
          g.identity !== '' &&
          g.ownAuthTile !== null &&
          g.map.zone_id === zone &&
          g.worldScope.settled &&
          g.worldScope.zones.some((z) => z.zoneId === zone && z.state === 'active')
        );
      },
      zoneId,
      { timeout: 30_000 },
    )
    .catch(async () => {
      const s = await snap(p);
      throw new Error(
        `${label}: not settled in zone ${zoneId}: map zone ${s.map.zone_id}, own tile ` +
          `${JSON.stringify(s.ownAuthTile)}, scope ${JSON.stringify(s.worldScope)}`,
      );
    });
}

/** Column x=1, y=1..4, must be safe to walk (floor, no grass, no warp) on `map`. */
function assertColumn(map: RawTileMap): void {
  for (let y = 1; y <= 4; y += 1) {
    if (!safeTile(map, { x: 1, y })) {
      throw new Error(
        `zone-scope precondition: (1, ${y}) of zone ${map.zone_id} is not clean floor`,
      );
    }
  }
  if (!(map.warps ?? []).some((w) => w.from.x === WARP.x && w.from.y === WARP.y)) {
    throw new Error(`zone-scope precondition: zone ${map.zone_id} has no warp on (1, 5)`);
  }
}

/** Walks column x=1 from wherever on it the character stands to (1, `y`). */
async function walkColumnTo(p: Page, y: number, label: string): Promise<void> {
  const at = (await snap(p)).ownAuthTile;
  if (at === null || at.x !== 1)
    throw new Error(`${label}: not on column x=1: ${JSON.stringify(at)}`);
  const dir = y > at.y ? 'South' : 'North';
  const steps = Array.from({ length: Math.abs(y - at.y) }, () => dir as 'South' | 'North');
  expect(await walkPath(p, steps, label), `${label}: the column is grass-free`).toBe('arrived');
}

/** From anywhere on column x=1 of `from`, cross the warp into the other zone and settle there. */
async function crossWarp(p: Page, from: number, label: string): Promise<void> {
  const to = from === 0 ? 1 : 0;
  const before = await snap(p);
  expect(before.map.zone_id, `${label}: starts in zone ${from}`).toBe(from);
  assertColumn(before.map);
  // A character standing on the warp tile (it landed there) steps off first.
  if (before.ownAuthTile?.x === WARP.x && before.ownAuthTile?.y === WARP.y) {
    await walkColumnTo(p, 4, label);
  }
  await walkColumnTo(p, 4, label);
  // The last step is the warp: the own tile does not move to (1,5) of this zone, the zone changes.
  await p.evaluate(() => {
    (window as unknown as { __game: () => { step: (d: string) => void } }).__game().step('South');
  });
  await settledIn(p, to, label);
  expect((await snap(p)).ownAuthTile, `${label}: the warp lands on (1,5)`).toEqual(WARP);
}

test.describe
  .serial('zone scope — characters are held per zone, players world-wide', () => {
    let browser: Browser;
    let ctxA: BrowserContext;
    let ctxB: BrowserContext;
    let a: Page;
    let b: Page;
    let aId = '';
    let bId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctxA = await browser.newContext();
      ctxB = await browser.newContext();
      a = await ctxA.newPage();
      b = await ctxB.newPage();
      await a.goto('/');
      await settledIn(a, 0, 'A');
      await b.goto('/');
      await settledIn(b, 0, 'B');
      for (const p of [a, b]) {
        await p.waitForFunction(
          () => (window as unknown as { __game: () => Snap }).__game().presenceCount === 2,
          null,
          { timeout: 30_000 },
        );
      }
      aId = (await snap(a)).ownEntityId ?? '';
      bId = (await snap(b)).ownEntityId ?? '';
      expect(aId, 'A has a character').not.toBe('');
      expect(bId, 'B has a character').not.toBe('');
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('login settles on the own zone alone: the own-row set and zone 0, and every held character is in zone 0', async () => {
      for (const [label, p, other] of [
        ['A', a, bId],
        ['B', b, aId],
      ] as const) {
        const s = await snap(p);
        expect(s.ownAuthTile, `${label} spawns on (1,1)`).toEqual(SPAWN);
        expect(s.worldScope, `${label} holds its own row and zone 0, nothing else`).toEqual({
          own: 'active',
          zones: [{ zoneId: 0, state: 'active' }],
          settled: true,
        });
        expect(
          s.characters.filter((c) => c.zoneId !== 0),
          `${label} holds no character outside zone 0`,
        ).toEqual([]);
        expect(
          s.characters.some((c) => c.entityId === other),
          `${label} holds the other player's character`,
        ).toBe(true);
        expect(
          s.characters.length,
          `${label} holds more than the two players: zone 0's NPCs came with the zone`,
        ).toBeGreaterThan(2);
      }
    });

    test('B in zone 1 is absent from A`s characters while A still counts two players; once B`s linger passes, B holds no zone-0 character', async () => {
      const npcsInZone0 = (await snap(b)).characters.filter(
        (c) => c.entityId !== aId && c.entityId !== bId,
      ).length;
      expect(npcsInZone0, 'ANTI-VACUITY: zone 0 has NPCs for B to drop').toBeGreaterThan(0);

      await crossWarp(b, 0, 'B to zone 1');

      // A holds zone 0 only: B's row left that set, so it is deleted, not merely hidden.
      await expect
        .poll(async () => (await snap(a)).characters.some((c) => c.entityId === bId), {
          message: 'B left zone 0: A must drop B`s character row',
          timeout: 10_000,
        })
        .toBe(false);
      const seenByA = await snap(a);
      expect(
        seenByA.characters.filter((c) => c.zoneId !== 0),
        'A holds no character outside zone 0',
      ).toEqual([]);
      expect(seenByA.presenceCount, 'the player directory is world-wide: still two').toBe(2);
      expect(seenByA.worldScope.zones, 'A never subscribed zone 1').toEqual([
        { zoneId: 0, state: 'active' },
      ]);

      // B: zone 1 at once; zone 0 lingers, then its rows are dropped (the own row is not one).
      const justAfter = await snap(b);
      expect(
        justAfter.worldScope.zones,
        'right after the warp B still holds zone 0 (its linger) beside zone 1',
      ).toEqual([
        { zoneId: 0, state: 'active' },
        { zoneId: 1, state: 'active' },
      ]);
      await expect
        .poll(async () => (await snap(b)).worldScope.zones, {
          message: 'after the linger B holds zone 1 alone',
          timeout: LINGER_WAIT_MS,
        })
        .toEqual([{ zoneId: 1, state: 'active' }]);
      await expect
        .poll(async () => (await snap(b)).characters.filter((c) => c.zoneId !== 1), {
          message: 'the zone-0 rows B held are dropped with their set',
          timeout: 10_000,
        })
        .toEqual([]);
      const settledB = await snap(b);
      expect(
        settledB.characters.some((c) => c.entityId === bId),
        'B keeps its own row: the own-row set covers it',
      ).toBe(true);
      expect(settledB.presenceCount, 'B still counts two players').toBe(2);
      expect(settledB.worldScope.settled).toBe(true);
    });

    test('B walks back into A`s zone and appears on the arrival tile; B walks out again and vanishes', async () => {
      await crossWarp(b, 1, 'B back to zone 0');
      await expect
        .poll(
          async () => {
            const c = (await snap(a)).characters.find((x) => x.entityId === bId);
            return c === undefined ? null : { zoneId: c.zoneId, x: c.tileX, y: c.tileY };
          },
          { message: 'A sees B arrive in zone 0 on (1,5)', timeout: 10_000 },
        )
        .toEqual({ zoneId: 0, x: WARP.x, y: WARP.y });
      expect((await snap(a)).presenceCount).toBe(2);

      await crossWarp(b, 0, 'B out to zone 1');
      await expect
        .poll(async () => (await snap(a)).characters.some((c) => c.entityId === bId), {
          message: 'B left again: A drops the row',
          timeout: 10_000,
        })
        .toBe(false);
      expect((await snap(a)).presenceCount).toBe(2);
    });

    test('B walks in zone 1 while A warps in: A holds every tile of the rest of B`s walk in order, and its ring for B reaches four consecutive tiles', async () => {
      // B to the west end of zone 1's y=1 row; A to the tile above the zone-0 warp.
      await walkColumnTo(b, 4, 'B off the warp tile');
      await walkColumnTo(b, 1, 'B to (1,1) of zone 1');
      const bMap = (await snap(b)).map;
      expect(bMap.zone_id).toBe(1);
      const ROW_END = 8;
      for (let x = 1; x <= ROW_END; x += 1) {
        if (!safeTile(bMap, { x, y: 1 })) {
          throw new Error(`zone-scope precondition: (${x}, 1) of zone 1 is not clean floor`);
        }
      }
      assertColumn((await snap(a)).map);
      await walkColumnTo(a, 4, 'A beside the warp');

      // A records B's row on every frame from now on; B is not in A's store yet.
      expect((await snap(a)).characters.some((c) => c.entityId === bId)).toBe(false);
      await a.evaluate((id: string) => {
        const w = window as unknown as {
          __game: () => Snap;
          __scopeFrames: Frame[];
          __scopeRec: boolean;
        };
        w.__scopeFrames = [];
        w.__scopeRec = true;
        const sample = (): void => {
          if (!w.__scopeRec) return;
          const c = w.__game().characters.find((x) => x.entityId === id);
          if (c !== undefined) {
            w.__scopeFrames.push({ tile: { x: c.tileX, y: c.tileY }, history: c.history });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, bId);

      // B walks east by a held key (its window keeps focus); A steps onto the warp meanwhile.
      await b.bringToFront();
      await b.keyboard.down('ArrowRight');
      await a.evaluate(() => {
        (window as unknown as { __game: () => { step: (d: string) => void } })
          .__game()
          .step('South');
      });
      await b.waitForFunction(
        (want: number) =>
          ((window as unknown as { __game: () => Snap }).__game().ownAuthTile?.x ?? 0) >= want,
        ROW_END,
        { timeout: 15_000 },
      );
      await b.keyboard.up('ArrowRight');
      await settledIn(a, 1, 'A in zone 1');
      const end = (await snap(b)).ownAuthTile;
      if (end === null) throw new Error('B lost its character row');
      expect(end.y, 'B stayed on the row').toBe(1);
      await expect
        .poll(
          async () => {
            const c = (await snap(a)).characters.find((x) => x.entityId === bId);
            return c === undefined ? null : c.tileX;
          },
          { message: 'A holds B on its final tile', timeout: 10_000 },
        )
        .toBe(end.x);

      const frames = await a.evaluate(() => {
        const w = window as unknown as { __scopeFrames: Frame[]; __scopeRec: boolean };
        w.__scopeRec = false;
        return w.__scopeFrames.slice();
      });
      expect(frames.length, 'ANTI-VACUITY: A sampled B').toBeGreaterThan(0);
      const tiles: number[] = [];
      for (const f of frames) {
        expect(f.tile.y, 'B never leaves the row in A`s store').toBe(1);
        if (tiles[tiles.length - 1] !== f.tile.x) tiles.push(f.tile.x);
      }
      const first = tiles[0] as number;
      expect(
        end.x - first,
        'ANTI-VACUITY: A`s zone-1 set applied while B still had at least four steps to walk ' +
          `(first tile held ${first}, last ${end.x}); otherwise this test saw no walk`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        tiles,
        'from the first tile A held (the applied set`s snapshot) to the last, A received every ' +
          'tile exactly once and in order: the snapshot and the updates after it leave no gap ' +
          'and repeat no step',
      ).toEqual(Array.from({ length: end.x - first + 1 }, (_, i) => first + i));
      const rings = frames.map((f) => f.history.map((h) => h.x));
      const consecutive = rings.filter(
        (r) => r.length === 4 && r.every((x, i) => i === 0 || x === (r[i - 1] as number) + 1),
      );
      expect(
        consecutive.length,
        'A`s interpolation ring for B (depth 4) must at some frame hold four consecutive tiles. ' +
          `Rings seen: ${[...new Set(rings.map((r) => r.join(',')))].join(' | ')}`,
      ).toBeGreaterThanOrEqual(1);
    });

    test('a second tab opened while the character is in zone 1 settles on zone 1, never on zone 0', async () => {
      const first = await snap(a);
      expect(first.map.zone_id, 'precondition: A is in zone 1').toBe(1);
      // A tab opened from the page copies its sessionStorage, so it connects with the same token:
      // the same identity, whose character already stands in zone 1.
      const [tab] = await Promise.all([
        ctxA.waitForEvent('page'),
        a.evaluate(() => {
          window.open('/');
        }),
      ]);
      await settledIn(tab, 1, 'the second tab');
      const second = await snap(tab);
      expect(second.identity, 'the second tab is the same identity').toBe(first.identity);
      expect(second.ownEntityId).toBe(first.ownEntityId);
      expect(second.ownAuthTile, 'on the tile the character stands on').toEqual(first.ownAuthTile);
      expect(second.worldScope, 'zone 1 and nothing else: zone 0 was never assumed').toEqual({
        own: 'active',
        zones: [{ zoneId: 1, state: 'active' }],
        settled: true,
      });
      expect(
        second.characters.filter((c) => c.zoneId !== 1),
        'the second tab holds no character outside zone 1',
      ).toEqual([]);
      expect(
        second.characters.some((c) => c.entityId === bId),
        'and it holds B, who is in zone 1',
      ).toBe(true);
      expect(second.presenceCount, 'one identity, two tabs: still two players').toBe(2);

      await tab.close();
      // The first tab is untouched: same zone, still settled, B still held.
      await settledIn(a, 1, 'A after the second tab closed');
      const after = await snap(a);
      expect(after.presenceCount).toBe(2);
      expect(after.characters.some((c) => c.entityId === bId)).toBe(true);
    });
  });
