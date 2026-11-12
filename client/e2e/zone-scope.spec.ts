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
// their character is not held at all. The one exception is by a warp: within four tiles of a warp
// tile (Manhattan, worldScope.ts PREFETCH_TILES) the client also holds the warp's destination
// zone, so the arrival draws that zone's characters on its first frame. What is read, all from
// `window.__game()`:
//   worldScope              the character query sets the live connection holds, and `settled`
//   characters[].zoneId     the store's rows, each with its zone
//   characters[].history    a remote's interpolation ring, oldest first
//   rendered[]              the entities the frame loop drew on its last frame
//   presenceCount           the `player` rows held
//
// WORLD FACTS (asserted at runtime, loudly): both players spawn on (1,1) in zone 0; column x=1
// is clean floor for y=1..4 in both zones; the warp tile is (1,5) in each zone and lands on (1,5)
// in the other; a character that lands on a warp tile does not warp again until it steps off and
// back on; row y=1 of zone 1 is clean floor for x=1..8; (2,1) is clean floor in both zones.
// The spawn (1,1) is exactly four tiles from the warp, so a character standing on it holds both
// zones; (2,1) is five tiles away, the nearest tile where it holds its own zone alone.

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
  rendered: { entityId: string }[];
  worldScope: ScopeSnap;
}
/** One animation frame of a warping player: the map drawn, the scope, and one other character. */
interface WarpFrame {
  mapZone: number;
  settled: boolean;
  /** The zone of the watched character's row, or null when the store does not hold it. */
  otherZone: number | null;
}
/** One animation frame of the watcher: the walker's row and ring as the watcher holds them. */
interface Frame {
  tile: Tile;
  history: Tile[];
}

const WARP: Tile = { x: 1, y: 5 };
const SPAWN: Tile = { x: 1, y: 1 };
/** Five tiles from the warp: the nearest tile of row y=1 outside the prefetch range. */
const AWAY: Tile = { x: 2, y: 1 };
const BOTH_ZONES: ScopeSnap['zones'] = [
  { zoneId: 0, state: 'active' },
  { zoneId: 1, state: 'active' },
];
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
      rendered: g.rendered,
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

/** Walks column x=1 from wherever on it the character stands (or from `AWAY`, one step east of
 *  its top) to (1, `y`). */
async function walkColumnTo(p: Page, y: number, label: string): Promise<void> {
  let at = (await snap(p)).ownAuthTile;
  if (at !== null && at.x === AWAY.x && at.y === AWAY.y) {
    expect(await walkPath(p, ['West'], label), `${label}: (1,1) is grass-free`).toBe('arrived');
    at = (await snap(p)).ownAuthTile;
  }
  if (at === null || at.x !== 1)
    throw new Error(`${label}: not on column x=1: ${JSON.stringify(at)}`);
  const dir = y > at.y ? 'South' : 'North';
  const steps = Array.from({ length: Math.abs(y - at.y) }, () => dir as 'South' | 'North');
  expect(await walkPath(p, steps, label), `${label}: the column is grass-free`).toBe('arrived');
}

/** From column x=1 of `zoneId`, walk to `AWAY` and wait until the zone on the far side of the warp
 *  has lingered out: the character then holds `zoneId` alone. */
async function leaveWarpRange(p: Page, zoneId: number, label: string): Promise<void> {
  const map = (await snap(p)).map;
  expect(map.zone_id, `${label}: is in zone ${zoneId}`).toBe(zoneId);
  assertColumn(map);
  if (!safeTile(map, AWAY)) {
    throw new Error(`zone-scope precondition: (2, 1) of zone ${zoneId} is not clean floor`);
  }
  await walkColumnTo(p, 1, label);
  expect(await walkPath(p, ['East'], label), `${label}: (2,1) is grass-free`).toBe('arrived');
  expect((await snap(p)).ownAuthTile, `${label}: stands five tiles from the warp`).toEqual(AWAY);
  await expect
    .poll(async () => (await snap(p)).worldScope.zones, {
      message: `${label}: five tiles from the warp, after the linger, zone ${zoneId} alone is held`,
      timeout: LINGER_WAIT_MS,
    })
    .toEqual([{ zoneId, state: 'active' }]);
}

/** From anywhere on column x=1 of `from` (or from `AWAY`), cross the warp into the other zone and settle there. */
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

    test('login settles on the own zone; on the spawn, four tiles from the warp, zone 1 is held too; one tile further the own-row set and zone 0 are all that is held, and every held character is in zone 0', async () => {
      for (const [label, p, other] of [
        ['A', a, bId],
        ['B', b, aId],
      ] as const) {
        expect((await snap(p)).ownAuthTile, `${label} spawns on (1,1)`).toEqual(SPAWN);
        await expect
          .poll(async () => (await snap(p)).worldScope, {
            message: `${label} on the spawn holds its own row, zone 0 and the warp's zone 1`,
            timeout: 10_000,
          })
          .toEqual({ own: 'active', zones: BOTH_ZONES, settled: true });
        expect(
          (await snap(p)).characters.some((c) => c.zoneId === 1),
          `${label} holds zone 1's characters (its shopkeeper) while in range of the warp`,
        ).toBe(true);
        expect(
          (await snap(p)).map.zone_id,
          `${label} draws zone 0: the prefetched zone is held, not shown`,
        ).toBe(0);

        await leaveWarpRange(p, 0, label);
        const s = await snap(p);
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
      expect(seenByA.worldScope.zones, 'A, five tiles from the warp, holds zone 0 alone').toEqual([
        { zoneId: 0, state: 'active' },
      ]);

      // B: zone 1 at once. On the arrival tile, which is the warp back, zone 0 stays held; five
      // tiles away it lingers out and its rows are dropped (the own row is not one).
      const justAfter = await snap(b);
      expect(
        justAfter.worldScope.zones,
        'on the arrival tile B holds zone 0 (the warp back) beside zone 1',
      ).toEqual(BOTH_ZONES);
      await leaveWarpRange(b, 1, 'B away from the warp back');
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

    test('B walks in zone 1 while A comes into range of the warp and then warps in: A holds every tile of the rest of B`s walk in order, and its ring for B reaches four consecutive tiles', async () => {
      // B to the west end of zone 1's y=1 row; A stands five tiles from the zone-0 warp.
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
      const aBefore = await snap(a);
      assertColumn(aBefore.map);
      expect(aBefore.ownAuthTile, 'A stands five tiles from the warp').toEqual(AWAY);
      expect(aBefore.worldScope.zones, 'A does not hold zone 1 yet').toEqual([
        { zoneId: 0, state: 'active' },
      ]);

      // A records B's row on every frame from now on; B is not in A's store yet.
      expect(aBefore.characters.some((c) => c.entityId === bId)).toBe(false);
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

      // B walks east by a held key (its window keeps focus). Meanwhile A steps into range of the
      // warp, so its zone-1 set is issued and applies while B is mid-walk.
      await b.bringToFront();
      await b.keyboard.down('ArrowRight');
      await a.evaluate(() => {
        (window as unknown as { __game: () => { step: (d: string) => void } })
          .__game()
          .step('West');
      });
      await b.waitForFunction(
        (want: number) =>
          ((window as unknown as { __game: () => Snap }).__game().ownAuthTile?.x ?? 0) >= want,
        ROW_END,
        { timeout: 15_000 },
      );
      await b.keyboard.up('ArrowRight');
      await crossWarp(a, 0, 'A into zone 1');
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

    test('A walks to the warp with B standing in zone 1: B is held before the warp, undrawn, and is in A`s characters on the first frame A draws zone 1; the scope never leaves settled', async () => {
      // A back to zone 0 and out of range of the warp, so it holds nothing of zone 1.
      await crossWarp(a, 1, 'A back to zone 0');
      await leaveWarpRange(a, 0, 'A in zone 0');
      const cold = await snap(a);
      expect(
        cold.characters.some((c) => c.entityId === bId),
        'ANTI-VACUITY: out of range, A does not hold B',
      ).toBe(false);
      const bTile = (await snap(b)).ownAuthTile;
      expect((await snap(b)).map.zone_id, 'B stands in zone 1').toBe(1);

      // One step into range: zone 1 is subscribed, B's row arrives, and nothing of it is drawn.
      await walkColumnTo(a, 1, 'A into range');
      await expect
        .poll(
          async () => {
            const s = await snap(a);
            const c = s.characters.find((x) => x.entityId === bId);
            return {
              zones: s.worldScope.zones,
              b: c === undefined ? null : { zoneId: c.zoneId, x: c.tileX, y: c.tileY },
            };
          },
          { message: 'four tiles from the warp A holds zone 1 and B in it', timeout: 10_000 },
        )
        .toEqual({ zones: BOTH_ZONES, b: { zoneId: 1, x: bTile?.x, y: bTile?.y } });
      await walkColumnTo(a, 4, 'A beside the warp');
      const beside = await snap(a);
      expect(beside.map.zone_id, 'A still draws zone 0').toBe(0);
      expect(
        beside.rendered.some((r) => r.entityId === bId),
        'B is in another zone: held, not drawn',
      ).toBe(false);

      // Every frame from here to the far side of the warp.
      await a.evaluate((id: string) => {
        const w = window as unknown as {
          __game: () => Snap;
          __warpFrames: WarpFrame[];
          __warpRec: boolean;
        };
        w.__warpFrames = [];
        w.__warpRec = true;
        const sample = (): void => {
          if (!w.__warpRec) return;
          const g = w.__game();
          const c = g.characters.find((x) => x.entityId === id);
          w.__warpFrames.push({
            mapZone: g.map.zone_id,
            settled: g.worldScope.settled,
            otherZone: c === undefined ? null : c.zoneId,
          });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, bId);
      await a.evaluate(() => {
        (window as unknown as { __game: () => { step: (d: string) => void } })
          .__game()
          .step('South');
      });
      await settledIn(a, 1, 'A in zone 1');
      await expect
        .poll(async () => (await snap(a)).rendered.some((r) => r.entityId === bId), {
          message: 'in zone 1 A draws B',
          timeout: 10_000,
        })
        .toBe(true);
      const frames = await a.evaluate(() => {
        const w = window as unknown as { __warpFrames: WarpFrame[]; __warpRec: boolean };
        w.__warpRec = false;
        return w.__warpFrames.slice();
      });
      const arrival = frames.findIndex((f) => f.mapZone === 1);
      expect(
        arrival,
        'ANTI-VACUITY: frames were sampled on both sides of the warp',
      ).toBeGreaterThan(0);
      expect(
        frames[arrival]?.otherZone,
        'on the first frame A draws zone 1, B`s row is already in the store, in zone 1',
      ).toBe(1);
      expect(
        frames.filter((f) => f.otherZone !== 1),
        'B`s row is held on every frame across the warp',
      ).toEqual([]);
      expect(
        frames.filter((f) => !f.settled),
        'the destination was applied before the warp: the scope never left settled',
      ).toEqual([]);
    });

    test('a second tab opened while the character is in zone 1 settles on zone 1, never on zone 0', async () => {
      // Out of range of the warp back, so the character holds zone 1 alone.
      await leaveWarpRange(a, 1, 'A away from the warp back');
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
