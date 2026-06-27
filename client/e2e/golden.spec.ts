import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// M5a golden flows — the two-window regression net (ADR-0009/0012/0013). Two real
// browser contexts (=> two identities) against one authoritative world. Asserts on
// the window.__game() STATE snapshot, NEVER pixels; reads STEP_MS + the zone map
// from the hook (never hard-coded). One shared 2-player world (describe.serial) so
// presence stays 2 throughout; global-setup republished --delete-data first.

interface Tile {
  x: number;
  y: number;
}
interface Snap {
  identity: string;
  stepMs: number;
  map: { width: number; height: number; walkable: boolean[] };
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  ownPredictedTile: Tile | null;
  presenceCount: number;
  characters: { entityId: string; tileX: number; tileY: number }[];
}

const OFFSET: Record<string, Tile> = {
  North: { x: 0, y: -1 },
  South: { x: 0, y: 1 },
  West: { x: -1, y: 0 },
  East: { x: 1, y: 0 },
};

const snap = (p: Page): Promise<Snap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => Snap }).__game();
    // Strip the methods/promise; keep only serializable state for the test.
    return {
      identity: g.identity,
      stepMs: g.stepMs,
      map: g.map,
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      ownPredictedTile: g.ownPredictedTile,
      presenceCount: g.presenceCount,
      characters: g.characters,
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

function walkable(map: Snap['map'], x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.walkable[y * map.width + x] ?? false;
}
function dirWhere(map: Snap['map'], t: Tile, want: boolean): string | null {
  for (const [d, o] of Object.entries(OFFSET)) {
    if (walkable(map, t.x + o.x, t.y + o.y) === want) return d;
  }
  return null;
}

test.describe
  .serial('M5a — two-window POC golden flows', () => {
    let browser: Browser;
    let ctxA: BrowserContext;
    let ctxB: BrowserContext;
    let a: Page;
    let b: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctxA = await browser.newContext();
      ctxB = await browser.newContext();
      a = await ctxA.newPage();
      b = await ctxB.newPage();
      await a.goto('/');
      await b.goto('/');
      await ready(a);
      await ready(b);
      // Both joined: each window converges, via its subscription, to seeing 2 characters.
      await a.waitForFunction(
        () => (window as unknown as { __game: () => Snap }).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
      await b.waitForFunction(
        () => (window as unknown as { __game: () => Snap }).__game().presenceCount === 2,
        null,
        { timeout: 30_000 },
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('both clients see each other (distinct identities)', async () => {
      const ga = await snap(a);
      const gb = await snap(b);
      expect(ga.characters.length).toBe(2);
      expect(gb.characters.length).toBe(2);
      expect(ga.identity).not.toBe(gb.identity);
      expect(ga.identity).toBeTruthy();
    });

    test('A→B movement syncs and prediction converges (predicted == authoritative)', async () => {
      const ga = await snap(a);
      const dir = dirWhere(ga.map, ga.ownAuthTile as Tile, true);
      expect(dir, 'a walkable neighbor exists').not.toBeNull();
      const o = OFFSET[dir as string];
      const target: Tile = {
        x: (ga.ownAuthTile as Tile).x + o.x,
        y: (ga.ownAuthTile as Tile).y + o.y,
      };
      await a.evaluate(
        (d) =>
          (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
        dir as string,
      );
      // A: authoritative advances to target AND predicted matches it (4-step reconcile).
      await a.waitForFunction(
        (t: Tile) => {
          const g = (window as unknown as { __game: () => Snap }).__game();
          return (
            !!g.ownAuthTile &&
            g.ownAuthTile.x === t.x &&
            g.ownAuthTile.y === t.y &&
            !!g.ownPredictedTile &&
            g.ownPredictedTile.x === t.x &&
            g.ownPredictedTile.y === t.y
          );
        },
        target,
        { timeout: 15_000 },
      );
      // B sees A's character at the new authoritative tile (cross-window sync).
      await b.waitForFunction(
        (args: { id: string; t: Tile }) => {
          const c = (window as unknown as { __game: () => Snap })
            .__game()
            .characters.find((x) => x.entityId === args.id);
          return !!c && c.tileX === args.t.x && c.tileY === args.t.y;
        },
        { id: ga.ownEntityId as string, t: target },
        { timeout: 15_000 },
      );
    });

    test('B→A movement syncs (symmetric)', async () => {
      const gb = await snap(b);
      const dir = dirWhere(gb.map, gb.ownAuthTile as Tile, true);
      expect(dir).not.toBeNull();
      const o = OFFSET[dir as string];
      const target: Tile = {
        x: (gb.ownAuthTile as Tile).x + o.x,
        y: (gb.ownAuthTile as Tile).y + o.y,
      };
      await b.evaluate(
        (d) =>
          (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
        dir as string,
      );
      await a.waitForFunction(
        (args: { id: string; t: Tile }) => {
          const c = (window as unknown as { __game: () => Snap })
            .__game()
            .characters.find((x) => x.entityId === args.id);
          return !!c && c.tileX === args.t.x && c.tileY === args.t.y;
        },
        { id: gb.ownEntityId as string, t: target },
        { timeout: 15_000 },
      );
    });

    test('wall bump leaves predicted == authoritative (the canonical no-desync net)', async () => {
      const ga = await snap(a);
      const before = ga.ownAuthTile as Tile;
      const wall = dirWhere(ga.map, before, false);
      expect(wall, 'a wall/boundary neighbor exists').not.toBeNull();
      await a.evaluate(
        (d) =>
          (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
        wall as string,
      );
      // Bounded wait keyed to STEP_MS (no silent retry): the server (dis)allows the move.
      await a.waitForTimeout(ga.stepMs * 5);
      const after = await snap(a);
      // Same rule both sides => the wall move is refused identically; no desync, no move.
      expect(after.ownAuthTile).toEqual(before);
      expect(after.ownPredictedTile).toEqual(after.ownAuthTile);
    });
  });
