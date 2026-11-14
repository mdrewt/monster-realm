import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import {
  type Dir,
  DPAD_BUTTON,
  faceTile,
  liveBindings,
  oppositeDir,
  pressButton,
  readWorld,
  safeTile,
  stepTile,
  type Tile,
  walkPath,
} from './controls';

// np-c2 — a press of a direction the character does not face turns it first.
//
// A press of a direction key sends `Face`: game-core turns a character that does not face that
// way, on its tile, and steps one that already does. A held press continues with `Step`s once the
// hold is committed and the `Face` is acknowledged. Each test below drives the real keyboard
// path (the live binding table, through controls.ts) and reads positions and facing from the
// AUTHORITATIVE character rows through the DEV `__game()` hook, never from prediction.
//   [np-c2.3]  a tap of a direction not faced turns the character on its tile and it stays there
//              past two STEP_MS; a second tap of it moves exactly one tile.
//   [np-c2.4]  one held press of a direction not faced: the row's first change is the turn on the
//              same tile, then the walk visits (2,1) and (3,1); exactly one keydown arrives.
//   [np-c2.5]  standing beside the stationary shopkeeper facing away, a tap toward her turns the
//              character on its tile; A then opens HER conversation.
//   [np-c2.6]  a watching context renders a remote player that tap-turns on its tile at every
//              sampled frame until that player's next position change.
//
// Each test is self-contained: it launches its own browser, joins fresh players and closes the
// browser in a `finally`, so one test runs alone after a fresh publish and no player stays
// joined for the next spec file (playwright.config.ts: specs assert the exact live population).
// No dev reducer is called. `__game().step` (a `Step`) is used for setup walks only.
//
// WORLD FACTS (asserted at runtime, loudly): a new player spawns in zone 0 on (1,1) facing
// South; row y=1 of zone 0 is grass-free and walkable for x=1..8 (walls at x=0 and x=9). Column
// x=1 is grass-free from y=1 to the warp source (1,5), which lands on zone 1 (1,5)
// (shop-npc.spec.ts WORLD FACTS). In zone 1 the shopkeeper `tideglass_shopkeeper` is pinned on
// her home (8,1) (wander_radius 0) and greets with "Hello, customer!"; (7,1) is her one safe
// 4-neighbour. The post and the facings are derived from the live map and her row.
//
// NO BigInt crosses page.evaluate: the hook's entity ids are decimal strings.

/** One character as the DEV hook reports it (main.ts `snapshot().characters`). */
interface HookChar {
  entityId: string;
  zoneId: number;
  tileX: number;
  tileY: number;
  facing: string;
}

/** The slice of `__game()` this file reads. */
interface Hook {
  identity: string;
  stepMs: number;
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  characters: HookChar[];
  rendered: { entityId: string; x: number; y: number }[];
}

type HookWindow = { __game: () => Hook };

/** One distinct state of the own character row, as np-c2.4's in-page recorder saw it. */
interface RowObs {
  x: number;
  y: number;
  facing: string;
}

/** One keydown np-c2.4's capture-phase counter saw. */
interface KeyDownObs {
  code: string;
  repeat: boolean;
}

/** One animation frame of np-c2.6's watcher: its row for the remote player and where it drew it. */
interface WatchSample {
  t: number;
  tileX: number;
  tileY: number;
  facing: string;
  rx: number;
  ry: number;
}

/** The corridor row and its walkable span (WORLD FACTS). */
const CORRIDOR_Y = 1;
const CORRIDOR_MIN_X = 1;
const CORRIDOR_MAX_X = 8;
const SPAWN: Tile = { x: 1, y: 1 };
/** The continuation window, in steps: JITTER_IDLE_GAP_STEPS (client/src/shared/interpConfig.ts). */
const WINDOW_STEPS = 3;
/** The adaptive interpolation delay's cap, in steps: INTERP_MAX_DELAY_STEPS (render/config.ts). */
const MAX_DELAY_STEPS = 2.5;
/** "Drawn on the tile": remote-walk.spec.ts's `toBeCloseTo(tile, 6)`, i.e. |drawn - tile| < 5e-7. */
const ON_TILE_EPS = 5e-7;
/** The fewest watcher frames the turn window must hold for np-c2.6 to have measured anything. */
const MIN_TURN_FRAMES = 10;

/** The shopkeeper's pinned home (npcs/000-core.ron, wander_radius 0) and the zone she lives in. */
const SHOPKEEPER_HOME: Tile = { x: 8, y: 1 };
const SHOP_ZONE = 1;
const SHOPKEEPER_NPC_ID = 'tideglass_shopkeeper';
const GREETING = 'Hello, customer!';
/** Expansion order for the shopkeeper's neighbours (fixed, so the derived post is deterministic). */
const DIRS: readonly Dir[] = ['North', 'South', 'East', 'West'];

const tileName = (t: Tile | null): string => (t === null ? '(none)' : `(${t.x},${t.y})`);

/** The own authoritative tile and facing, as one comparable string. */
async function posted(p: Page): Promise<string> {
  const w = await readWorld(p);
  return `${tileName(w.ownAuthTile)} facing ${w.ownFacing ?? '(none)'}`;
}

// Each spec carries its own ready() (client/e2e convention).
async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => Hook };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** A fresh player in its own context of `browser`, joined and live. */
async function join(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await ready(page);
  return page;
}

const readStepMs = (p: Page): Promise<number> =>
  p.evaluate(() => (window as unknown as HookWindow).__game().stepMs);

/** LOUD precondition: the player stands on the zone-0 spawn (1,1) facing South, and the y=1
 *  corridor is safe (walkable, grass-free, no warp) for x=1..8 in the live map. */
async function expectFreshSpawn(p: Page, label: string): Promise<void> {
  await expect
    .poll(() => posted(p), {
      message: `${label}: a fresh player stands on the spawn (1,1) facing South`,
      timeout: 10_000,
    })
    .toBe(`${tileName(SPAWN)} facing South`);
  const w = await readWorld(p);
  expect(w.map.zone_id, `${label}: the spawn is in zone 0`).toBe(0);
  for (let x = CORRIDOR_MIN_X; x <= CORRIDOR_MAX_X; x += 1) {
    expect(
      safeTile(w.map, { x, y: CORRIDOR_Y }),
      `${label}: (${x},${CORRIDOR_Y}) must be walkable, grass-free and no warp in the live map`,
    ).toBe(true);
  }
}

test.describe('np-c2 — a press of a direction the character does not face turns it first', () => {
  test('a tap of a direction the character does not face turns it on its tile, and a second tap moves it exactly one tile [np-c2.3]', async () => {
    test.setTimeout(90_000);
    const browser = await chromium.launch();
    try {
      const page = await join(browser);
      await expectFreshSpawn(page, 'np-c2.3');
      const stepMs = await readStepMs(page);
      expect(stepMs, 'the hook reports the real STEP_MS').toBeGreaterThan(0);
      await page.bringToFront();

      // Tap East from South: a turn.
      await pressButton(page, 'Right');
      await expect
        .poll(async () => (await readWorld(page)).ownFacing, {
          message: 'np-c2.3: the tap of East must turn the authoritative row to face East',
          timeout: 8_000,
        })
        .toBe('East');
      expect(
        await posted(page),
        'np-c2.3: a tap of a direction the character does not face turns it ON ITS TILE: the ' +
          'row that faces East must still stand on (1,1)',
      ).toBe('(1,1) facing East');
      // A late step is the defect: the turned character stays put for more than two STEP_MS.
      await page.waitForTimeout(3 * stepMs);
      expect(
        await posted(page),
        `np-c2.3: ${3 * stepMs} ms after the turn the character still stands on (1,1) facing East`,
      ).toBe('(1,1) facing East');

      // Tap East again, now facing East: one tile.
      await pressButton(page, 'Right');
      await expect
        .poll(async () => tileName((await readWorld(page)).ownAuthTile), {
          message: 'np-c2.3: the second tap of East, facing East, must move the character',
          timeout: 8_000,
        })
        .not.toBe('(1,1)');
      expect(await posted(page), 'np-c2.3: the second tap moves exactly one tile East').toBe(
        '(2,1) facing East',
      );
      await page.waitForTimeout(3 * stepMs);
      expect(
        await posted(page),
        'np-c2.3: the second tap moved EXACTLY one tile: nothing more arrives after it',
      ).toBe('(2,1) facing East');
    } finally {
      await browser.close();
    }
  });

  test('a held direction the character does not face turns it on its tile, then walks at least two tiles with no second press [np-c2.4]', async () => {
    test.setTimeout(90_000);
    const browser = await chromium.launch();
    try {
      const page = await join(browser);
      await expectFreshSpawn(page, 'np-c2.4');
      const code = (await liveBindings(page)).buttons.Right[0];
      if (code === undefined) throw new Error('np-c2.4: Right has no key in the live table');

      // The recorders, armed BEFORE the press: every distinct (x, y, facing) of the own row, one
      // read per animation frame, and every keydown in the capture phase.
      await page.evaluate(() => {
        const w = window as unknown as HookWindow & {
          __np4Rows: RowObs[];
          __np4Downs: KeyDownObs[];
          __np4Rec: boolean;
        };
        w.__np4Rows = [];
        w.__np4Downs = [];
        w.__np4Rec = true;
        window.addEventListener(
          'keydown',
          (e) => {
            if (w.__np4Rec) w.__np4Downs.push({ code: e.code, repeat: e.repeat });
          },
          true,
        );
        const sample = (): void => {
          if (!w.__np4Rec) return;
          const g = w.__game();
          const own = g.characters.find((c) => c.entityId === g.ownEntityId);
          if (own !== undefined) {
            const last = w.__np4Rows[w.__np4Rows.length - 1];
            if (
              last === undefined ||
              last.x !== own.tileX ||
              last.y !== own.tileY ||
              last.facing !== own.facing
            ) {
              w.__np4Rows.push({ x: own.tileX, y: own.tileY, facing: own.facing });
            }
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.waitForFunction(
        () => (window as unknown as { __np4Rows: RowObs[] }).__np4Rows.length > 0,
        null,
        { timeout: 5_000 },
      );

      await page.bringToFront();
      await page.keyboard.down(code);
      await page
        .waitForFunction(
          () => {
            const t = (window as unknown as HookWindow).__game().ownAuthTile;
            return t !== null && t.y === 1 && t.x >= 3;
          },
          null,
          { timeout: 15_000 },
        )
        .catch(() => undefined); // the trail assertions below name what happened instead
      await page.keyboard.up(code);

      const { rows, downs } = await page.evaluate(() => {
        const w = window as unknown as {
          __np4Rows: RowObs[];
          __np4Downs: KeyDownObs[];
          __np4Rec: boolean;
        };
        w.__np4Rec = false;
        return { rows: w.__np4Rows.slice(), downs: w.__np4Downs.slice() };
      });
      const trail = rows.map((r) => `(${r.x},${r.y}) ${r.facing}`).join(' → ');

      expect(
        rows[0],
        `np-c2.4: the recorder starts on the spawn facing South. Trail: ${trail}`,
      ).toEqual({ x: 1, y: 1, facing: 'South' });
      expect(
        rows[1],
        'np-c2.4: the first change of the own row is the TURN on the same tile, (1,1) facing ' +
          `East, not a step. Trail: ${trail}`,
      ).toEqual({ x: 1, y: 1, facing: 'East' });
      const at2 = rows.findIndex((r) => r.x === 2 && r.y === 1 && r.facing === 'East');
      const at3 = rows.findIndex((r) => r.x === 3 && r.y === 1 && r.facing === 'East');
      expect(
        at2,
        `np-c2.4: after the turn the hold walks onto (2,1). Trail: ${trail}`,
      ).toBeGreaterThan(1);
      expect(
        at3,
        `np-c2.4: and then onto (3,1), with no second press. Trail: ${trail}`,
      ).toBeGreaterThan(at2);
      const fresh = downs.filter((d) => !d.repeat);
      expect(
        fresh.map((d) => d.code),
        'np-c2.4: exactly one keydown (not an OS repeat) drove the whole walk',
      ).toEqual([code]);
    } finally {
      await browser.close();
    }
  });

  test('a tap toward an adjacent NPC the character faces away from turns it on its tile, and A opens that NPC`s conversation [np-c2.5]', async () => {
    test.setTimeout(180_000);
    const browser = await chromium.launch();
    try {
      const page = await join(browser);
      await expectFreshSpawn(page, 'np-c2.5');

      // Zone 0: down column x=1 to the warp source (1,5), which lands on zone 1 (1,5).
      const z0 = await readWorld(page);
      for (let y = 2; y <= 4; y += 1) {
        expect(safeTile(z0.map, { x: 1, y }), `np-c2.5: (1,${y}) is a safe tile`).toBe(true);
      }
      expect(
        (z0.map.warps ?? []).some((w) => w.from.x === 1 && w.from.y === 5),
        'np-c2.5: (1,5) in zone 0 is the warp source to zone 1',
      ).toBe(true);
      expect(
        await walkPath(page, ['South', 'South', 'South', 'South'], 'np-c2.5 zone 0'),
        'np-c2.5: the zone-0 column is grass-free',
      ).toBe('arrived');
      await expect
        .poll(async () => (await readWorld(page)).map.zone_id, {
          message: 'np-c2.5: stepping onto (1,5) warps to zone 1',
          timeout: 20_000,
        })
        .toBe(SHOP_ZONE);

      // Her row: a non-player character on her home tile in zone 1 (she never wanders).
      await expect
        .poll(
          () =>
            page.evaluate((zone: number) => {
              const g = (window as unknown as HookWindow).__game();
              return g.characters
                .filter((c) => c.entityId !== g.ownEntityId && c.zoneId === zone)
                .map((c) => `(${c.tileX},${c.tileY})`);
            }, SHOP_ZONE),
          {
            message: `np-c2.5: the stationary shopkeeper stands on her home ${tileName(SHOPKEEPER_HOME)}`,
            timeout: 15_000,
          },
        )
        .toContain(tileName(SHOPKEEPER_HOME));

      // The post: her first safe 4-neighbour in the live zone-1 map; `toward` faces her from it.
      const z1 = await readWorld(page);
      const toward = DIRS.find((d) => safeTile(z1.map, stepTile(SHOPKEEPER_HOME, oppositeDir(d))));
      if (toward === undefined) {
        throw new Error(
          `np-c2.5: the shopkeeper's home ${tileName(SHOPKEEPER_HOME)} has no safe 4-neighbour ` +
            'in the live zone-1 map; re-derive the post',
        );
      }
      const post = stepTile(SHOPKEEPER_HOME, oppositeDir(toward));
      const away = oppositeDir(toward);
      // Setup with `Step`s: onto the post facing AWAY from her (the arriving step comes from her
      // own tile, which characters may stand on).
      expect(
        await faceTile(page, post, away, 'np-c2.5 post'),
        'np-c2.5: the zone-1 walk is grass-free',
      ).toBe('arrived');
      expect(await posted(page), 'np-c2.5: on the post facing away from her').toBe(
        `${tileName(post)} facing ${away}`,
      );
      expect((await readWorld(page)).stackLength, 'np-c2.5: a bare world base').toBe(1);
      await expect(page.locator('#dialogue-overlay'), 'np-c2.5: no dialogue yet').toBeHidden();

      // The tap toward her: a turn on the post.
      await page.bringToFront();
      await pressButton(page, DPAD_BUTTON[toward]);
      await expect
        .poll(async () => (await readWorld(page)).ownFacing, {
          message: `np-c2.5: the tap must turn the authoritative row to face her (${toward})`,
          timeout: 8_000,
        })
        .toBe(toward);
      expect(
        await posted(page),
        `np-c2.5: the tap toward her turns the character ON ITS TILE ${tileName(post)}; a ` +
          'character on her tile would reach her through its own tile, not by facing her',
      ).toBe(`${tileName(post)} facing ${toward}`);

      await pressButton(page, 'A');
      await expect(
        page.locator('#dialogue-overlay'),
        'np-c2.5: A opens a conversation',
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator('#dialogue-npc-name'),
        'np-c2.5: the conversation is the shopkeeper`s',
      ).toHaveText(SHOPKEEPER_NPC_ID);
      await expect(page.locator('#dialogue-node-text')).toHaveText(GREETING);
      expect(await posted(page), 'np-c2.5: A moved nobody').toBe(
        `${tileName(post)} facing ${toward}`,
      );
    } finally {
      await browser.close();
    }
  });

  test('a watcher renders a remote player that tap-turns on its tile at every sampled frame until its next position change [np-c2.6]', async () => {
    test.setTimeout(120_000);
    const browser = await chromium.launch();
    try {
      const a = await join(browser);
      const b = await join(browser);
      await expectFreshSpawn(a, 'np-c2.6 A');
      const wa = await readWorld(a);
      const aId = wa.ownEntityId;
      const origin = wa.ownAuthTile;
      if (aId === null || origin === null) throw new Error('np-c2.6: A has no character row');
      const stepMs = await readStepMs(b);
      expect(stepMs, 'the hook reports the real STEP_MS').toBeGreaterThan(0);

      // B holds A's row on the origin facing South, and draws A at rest on it.
      await b.waitForFunction(
        (o: { id: string; x: number; y: number; eps: number }) => {
          const g = (window as unknown as HookWindow).__game();
          const c = g.characters.find((d) => d.entityId === o.id);
          const r = g.rendered.find((d) => d.entityId === o.id);
          return (
            c !== undefined &&
            c.tileX === o.x &&
            c.tileY === o.y &&
            c.facing === 'South' &&
            r !== undefined &&
            Math.abs(r.x - o.x) < o.eps &&
            Math.abs(r.y - o.y) < o.eps
          );
        },
        { id: aId, x: origin.x, y: origin.y, eps: ON_TILE_EPS },
        { timeout: 30_000 },
      );

      // B's recorder: per animation frame, its row for A and the position it drew A at.
      await b.evaluate((id: string) => {
        const w = window as unknown as HookWindow & {
          __np6: WatchSample[];
          __np6Rec: boolean;
        };
        w.__np6 = [];
        w.__np6Rec = true;
        const sample = (t: number): void => {
          if (!w.__np6Rec) return;
          const g = w.__game();
          const c = g.characters.find((d) => d.entityId === id);
          const r = g.rendered.find((d) => d.entityId === id);
          if (c !== undefined && r !== undefined) {
            w.__np6.push({
              t,
              tileX: c.tileX,
              tileY: c.tileY,
              facing: c.facing,
              rx: r.x,
              ry: r.y,
            });
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, aId);

      // A taps East, a direction it does not face.
      await a.bringToFront();
      await pressButton(a, 'Right');
      await b.waitForFunction(
        (id: string) =>
          (window as unknown as HookWindow).__game().characters.find((d) => d.entityId === id)
            ?.facing === 'East',
        aId,
        { timeout: 8_000 },
      );
      const sawTurnAt = await b.evaluate(() => performance.now());
      await expect
        .poll(async () => (await readWorld(a)).ownFacing, {
          message: 'np-c2.6: A`s own row faces East',
          timeout: 8_000,
        })
        .toBe('East');
      const aAfterTurn = (await readWorld(a)).ownAuthTile;

      // Keep sampling through the continuation window plus the interpolation delay, and a step.
      await b.waitForTimeout((WINDOW_STEPS + MAX_DELAY_STEPS + 1) * stepMs);

      // The bound: A taps East again, now facing East, and B's row for A leaves the origin.
      const secondTapAt = await b.evaluate(() => performance.now());
      await pressButton(a, 'Right');
      await b.waitForFunction(
        (o: { id: string; x: number; y: number }) => {
          const c = (window as unknown as HookWindow)
            .__game()
            .characters.find((d) => d.entityId === o.id);
          return c !== undefined && (c.tileX !== o.x || c.tileY !== o.y);
        },
        { id: aId, x: origin.x, y: origin.y },
        { timeout: 8_000 },
      );
      const samples = await b.evaluate(() => {
        const w = window as unknown as { __np6: WatchSample[]; __np6Rec: boolean };
        w.__np6Rec = false;
        return w.__np6.slice();
      });

      const offTile = (s: WatchSample): boolean => s.tileX !== origin.x || s.tileY !== origin.y;
      const bound = samples.find((s) => s.t >= secondTapAt && offTile(s));
      if (bound === undefined) {
        throw new Error('np-c2.6: B never recorded a frame with A off its tile after the 2nd tap');
      }
      const before = samples.filter((s) => s.t < bound.t);
      const drawnOff = before
        .filter(
          (s) =>
            Math.abs(s.rx - origin.x) >= ON_TILE_EPS || Math.abs(s.ry - origin.y) >= ON_TILE_EPS,
        )
        .map(
          (s) =>
            `t=${Math.round(s.t)} drawn (${s.rx.toFixed(3)},${s.ry.toFixed(3)}) row ` +
            `(${s.tileX},${s.tileY}) ${s.facing}`,
        );
      expect(
        drawnOff.slice(0, 8),
        `np-c2.6: until A's next position change (B's row for A left ${tileName(origin)} at ` +
          `t=${Math.round(bound.t)}; the turn reached B at ${Math.round(sawTurnAt)}, the second ` +
          `tap was sent at ${Math.round(secondTapAt)}), B draws A on ${tileName(origin)} at every ` +
          `sampled frame; ${drawnOff.length} of ${before.length} frames drew it elsewhere`,
      ).toEqual([]);

      // Anti-vacuity: B sampled the turn window, and saw the turn on the origin.
      const turnWindow = before.filter((s) => s.t >= sawTurnAt && s.t < secondTapAt);
      expect(
        turnWindow.length,
        'np-c2.6: B sampled frames between seeing the turn and the second tap',
      ).toBeGreaterThanOrEqual(MIN_TURN_FRAMES);
      expect(
        before.some((s) => !offTile(s) && s.facing === 'East'),
        `np-c2.6: B's row for A showed the turn (East) on ${tileName(origin)}`,
      ).toBe(true);
      expect(
        tileName(aAfterTurn),
        'np-c2.6: A`s authoritative tile did not change across the turn',
      ).toBe(tileName(origin));
    } finally {
      await browser.close();
    }
  });
});
