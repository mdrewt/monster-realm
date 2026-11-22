import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { renderShellConfigScript, type TargetKind } from '../src/net/shellDocument';
import { type Dir, readWorld, safeTile, stepTile, type Tile, walkPath } from './controls';
import { ownerSql, sqlRows } from './stdb';

// local-identity.spec.ts: where the page keeps its anonymous reconnect token decides who a new
// page of the same browser profile is.
//
//   local     the token lives in the origin's localStorage: a page closed and a new page opened
//             in the same profile resume the same identity and the same character, and a second
//             page opened while the first is connected joins as that identity too; closing
//             either page leaves the character in the world while the other stays connected;
//   test      the token lives in per-tab sessionStorage, and an anonymous page joins: a new page
//             joins as a new identity;
//   official  the token lives in per-tab sessionStorage: a new page is a new identity. The suite's
//             build names an issuer (playwright.config.ts), so an anonymous page of an official
//             target shows the sign-in screen and joins nothing. Its leg of the control waits for
//             an identity and the sign-in screen, never for a tile (the page holds none), and holds
//             over several reads that neither a tile nor a player row appears.
//
// "The same profile" is ONE BrowserContext kept open across the page close. Every later page is
// opened with `ctx.newPage()`, never `window.open` or a popup, which would copy the opener's
// sessionStorage and void the per-tab control case.
//
// The shell document is served by routing `/shell-config.js` (as shell-config.spec.ts does), so
// the suite's own server and database are reached under the target kind each test names.
//
// SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db). Each test, and each
// leg of the control test, opens its own context and closes it in a finally, then waits for the
// `player` table to hold no identity outside the set it read on entry: other spec files assert
// exact populations. No fixed sleep: every wait polls a predicate with a bound.
//
// The JSON reporter records titles and error text, so no title or assertion message here carries
// a token value; only storage KEYS (target uri and db) and public identities are compared.

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
}

const SUITE_URI = process.env.VITE_STDB_URI?.trim() || 'ws://127.0.0.1:3000';
const SUITE_DB = process.env.VITE_STDB_DB?.trim() || 'monster-realm';
/** The prefix of every reconnect-token key. */
const TOKEN_PREFIX = 'mr.authToken.v1|';
/** The reconnect-token key for the suite target. */
const SUITE_TOKEN_KEY = `${TOKEN_PREFIX}${encodeURIComponent(SUITE_URI)}|${encodeURIComponent(SUITE_DB)}`;
/** How long a closed page's connection may take to end on the server. */
const SESSION_END_MS = 15_000;
/** How long a row must stay put after a page closes, while the other page stays connected. */
const ROW_HELD_MS = 5_000;
/** The directions a one-tile walk tries, in order. */
const WALK_DIRS: readonly Dir[] = ['East', 'South', 'West', 'North'];

/** An identity as lowercase hex without a `0x`. */
function bareHex(identity: string): string {
  const lower = identity.trim().toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/** The `player` table's identities, lowercase hex without a `0x`. */
function playerIdentities(label: string): string[] {
  return sqlRows(ownerSql('SELECT * FROM player', label), label).map((row) =>
    bareHex(row.identity ?? ''),
  );
}

/** How many `player` rows `identity` has. */
function rowsFor(identity: string, label: string): number {
  return playerIdentities(label).filter((id) => id === identity).length;
}

/** Identities in the `player` table that were not in `before`. */
function newPlayers(before: readonly string[], label: string): string[] {
  return playerIdentities(label).filter((id) => !before.includes(id));
}

/** Serve the suite target as a shell document of `kind` to every page of `ctx`. */
async function serveShellDocument(ctx: BrowserContext, kind: TargetKind): Promise<void> {
  await ctx.route('**/shell-config.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: renderShellConfigScript({ connection: { uri: SUITE_URI, db: SUITE_DB, kind } }),
    }),
  );
}

/** Open a new page of `ctx` on the game and wait until it holds an identity and an own
 *  authoritative tile; return both. */
async function openJoined(
  ctx: BrowserContext,
  label: string,
): Promise<{ page: Page; identity: string; tile: Tile }> {
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
  const snap = await page.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, ownAuthTile: g.ownAuthTile };
  });
  const tile = snap.ownAuthTile;
  if (tile === null) throw new Error(`${label}: the joined page lost its own tile`);
  const identity = bareHex(snap.identity);
  expect(identity, `${label}: a non-empty identity`).not.toBe('');
  return { page, identity, tile };
}

/** Walk the page's character one safe tile (grass-free, warp-free) and return the authoritative
 *  tile it landed on, which differs from the one it left. */
async function walkOneTile(page: Page, label: string): Promise<Tile> {
  const w = await readWorld(page);
  const from = w.ownAuthTile;
  if (from === null) throw new Error(`${label}: no authoritative own tile to walk from`);
  const dir = WALK_DIRS.find((d) => safeTile(w.map, stepTile(from, d)));
  if (dir === undefined) {
    throw new Error(`${label}: no safe tile next to (${from.x},${from.y}) to walk onto`);
  }
  const outcome = await walkPath(page, [dir], label);
  expect(outcome, `${label}: the step onto a safe tile starts no battle`).toBe('arrived');
  const after = (await readWorld(page)).ownAuthTile;
  if (after === null) throw new Error(`${label}: the character lost its tile after the step`);
  expect(after, `${label}: the authoritative tile changed`).not.toEqual(from);
  return after;
}

/** The reconnect-token keys in the page's localStorage and sessionStorage. */
function tokenKeys(page: Page): Promise<{ local: string[]; session: string[] }> {
  return page.evaluate((prefix: string) => {
    const keys = (s: Storage): string[] =>
      Array.from({ length: s.length }, (_, i) => s.key(i) ?? '').filter((k) =>
        k.startsWith(prefix),
      );
    return { local: keys(window.localStorage), session: keys(window.sessionStorage) };
  }, TOKEN_PREFIX);
}

/** Over ROW_HELD_MS, every read of the `player` table shows exactly one row for `identity`. */
async function expectRowHeld(identity: string, label: string): Promise<void> {
  const until = Date.now() + ROW_HELD_MS;
  let reads = 0;
  while (reads < 2 || Date.now() < until) {
    expect(rowsFor(identity, label), `${label}: read ${reads + 1}, the row is still there`).toBe(1);
    reads += 1;
    // Each read is one blocking CLI round trip; let pending I/O run between reads.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The keys of the rows the menu frame shows, in order. */
function rowKeys(page: Page): Promise<string[]> {
  return page
    .locator('#menu-overlay #menu-rows [data-nav-key]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-nav-key') ?? ''));
}

/** The page's own authoritative tile, or null. */
function ownTile(page: Page): Promise<Tile | null> {
  return page.evaluate(
    () => (window as unknown as { __game: () => GameSnap }).__game().ownAuthTile,
  );
}

/** Open a new page of `ctx` on the game and wait until it holds an identity and shows the sign-in
 *  screen: the menu frame is up with exactly the `signIn` row. No tile is waited for, since a page
 *  asked to sign in holds none. Return the page and its identity. */
async function openAtSignIn(
  ctx: BrowserContext,
  label: string,
): Promise<{ page: Page; identity: string }> {
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      return w.__game !== undefined && w.__game().identity !== '';
    },
    null,
    { timeout: 30_000 },
  );
  const identity = bareHex(
    await page.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().identity),
  );
  expect(identity, `${label}: the identity is 64 hex digits`).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.locator('#menu-overlay'), `${label}: the sign-in screen is up`).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(() => rowKeys(page), {
      message: `${label}: the sign-in screen offers exactly the sign-in row`,
      timeout: 10_000,
    })
    .toEqual(['signIn']);
  return { page, identity };
}

/** Over ROW_HELD_MS (at least two reads), the page holds no own tile and the `player` table holds
 *  no row for `identity`: the join is withheld, not merely late. */
async function expectJoinWithheld(page: Page, identity: string, label: string): Promise<void> {
  const until = Date.now() + ROW_HELD_MS;
  let reads = 0;
  while (reads < 2 || Date.now() < until) {
    expect(rowsFor(identity, label), `${label}: read ${reads + 1}, no player row`).toBe(0);
    expect(await ownTile(page), `${label}: read ${reads + 1}, no own tile`).toBeNull();
    reads += 1;
    // Each server read is one blocking CLI round trip; let pending I/O run between reads.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

test.describe
  .serial('a local target keeps the player on the device; an official one keeps it per tab', () => {
    let browser: Browser;

    test.beforeAll(async () => {
      browser = await chromium.launch();
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('LPW2-5-RESUME: a closed page of a local target is resumed, same identity and same tile, by a new page of the same profile [lpw-2.5]', async () => {
      test.setTimeout(120_000);
      const before = playerIdentities('resume: players before');
      const ctx = await browser.newContext();
      try {
        await serveShellDocument(ctx, 'local');
        const first = await openJoined(ctx, 'resume: page 1');
        const spawn = first.tile;
        const walked = await walkOneTile(first.page, 'resume: page 1');
        expect(walked, 'resume: page 1 stands off its spawn tile').not.toEqual(spawn);
        await expect
          .poll(() => rowsFor(first.identity, 'resume: page 1 row'), {
            message: 'resume: page 1 has a player row',
            timeout: 15_000,
          })
          .toBe(1);

        await first.page.close();
        await expect
          .poll(() => rowsFor(first.identity, 'resume: page 1 closed'), {
            message: 'resume: the server ended page 1 session (its player row is gone)',
            timeout: SESSION_END_MS,
          })
          .toBe(0);

        const second = await openJoined(ctx, 'resume: page 2');
        expect(second.identity, 'resume: page 2 resumes page 1 identity').toBe(first.identity);
        await expect
          .poll(
            async () => {
              const t = (await readWorld(second.page)).ownAuthTile;
              return t === null ? 'none' : `${t.x},${t.y}`;
            },
            { message: 'resume: page 2 stands on the tile page 1 walked to', timeout: 10_000 },
          )
          .toBe(`${walked.x},${walked.y}`);
        expect(await tokenKeys(second.page), 'resume: the token key lives in localStorage').toEqual(
          { local: [SUITE_TOKEN_KEY], session: [] },
        );
      } finally {
        await ctx.close();
      }
      await expect
        .poll(() => newPlayers(before, 'resume: players after close'), {
          message: 'resume: the closed context leaves no player behind',
          timeout: SESSION_END_MS,
        })
        .toEqual([]);
    });

    test('LPW2-6-CONTROL: a new page of a test target joins as a new identity, and a new page of an official target is a new identity held at the sign-in screen, each keeping its token per tab [lpw-2.6]', async () => {
      test.setTimeout(180_000);

      // Leg "test": a per-tab target an anonymous page joins.
      const testBefore = playerIdentities('control test: players before');
      const testCtx = await browser.newContext();
      try {
        await serveShellDocument(testCtx, 'test');
        const first = await openJoined(testCtx, 'control test: page 1');
        await first.page.close();
        await expect
          .poll(() => rowsFor(first.identity, 'control test: page 1 closed'), {
            message: 'control test: the server ended page 1 session (its player row is gone)',
            timeout: SESSION_END_MS,
          })
          .toBe(0);

        const second = await openJoined(testCtx, 'control test: page 2');
        expect(second.identity, 'control test: page 2 is a different identity').not.toBe(
          first.identity,
        );
        expect(
          await tokenKeys(second.page),
          'control test: the token key lives in sessionStorage',
        ).toEqual({ local: [], session: [SUITE_TOKEN_KEY] });
      } finally {
        await testCtx.close();
      }
      await expect
        .poll(() => newPlayers(testBefore, 'control test: players after close'), {
          message: 'control test: the closed context leaves no player behind',
          timeout: SESSION_END_MS,
        })
        .toEqual([]);

      // Leg "official": the suite's build names an issuer, so an anonymous page is asked to sign
      // in and joins nothing.
      const officialBefore = playerIdentities('control official: players before');
      const officialCtx = await browser.newContext();
      try {
        await serveShellDocument(officialCtx, 'official');
        const first = await openAtSignIn(officialCtx, 'control official: page 1');
        expect(await ownTile(first.page), 'control official: page 1 has no own tile').toBeNull();
        expect(
          await tokenKeys(first.page),
          'control official: page 1 keeps its token key in sessionStorage, none on the device',
        ).toEqual({ local: [], session: [SUITE_TOKEN_KEY] });
        await expectJoinWithheld(first.page, first.identity, 'control official: page 1');
        await first.page.close();

        const second = await openAtSignIn(officialCtx, 'control official: page 2');
        expect(second.identity, 'control official: page 2 is a different identity').not.toBe(
          first.identity,
        );
        expect(
          await tokenKeys(second.page),
          'control official: page 2 keeps its token key in sessionStorage, none on the device',
        ).toEqual({ local: [], session: [SUITE_TOKEN_KEY] });
        expect(await ownTile(second.page), 'control official: page 2 has no own tile').toBeNull();
        await expectJoinWithheld(second.page, second.identity, 'control official: page 2');
      } finally {
        await officialCtx.close();
      }
      await expect
        .poll(() => newPlayers(officialBefore, 'control official: players after close'), {
          message: 'control official: the closed context leaves no player behind',
          timeout: SESSION_END_MS,
        })
        .toEqual([]);
    });

    test('LPW2-7-SHARED: two pages of a local target share one identity, and closing either leaves the character in the world while the other plays on [lpw-2.7]', async () => {
      test.setTimeout(180_000);
      const before = playerIdentities('shared: players before');
      const ctx = await browser.newContext();
      let identity = '';
      try {
        await serveShellDocument(ctx, 'local');
        const a = await openJoined(ctx, 'shared: page A');
        identity = a.identity;

        const b = await openJoined(ctx, 'shared: page B');
        expect(b.identity, 'shared: page B joins as page A identity').toBe(a.identity);
        expect(await tokenKeys(b.page), 'shared: page B holds the device token key').toEqual({
          local: [SUITE_TOKEN_KEY],
          session: [],
        });
        await expect
          .poll(() => rowsFor(identity, 'shared: A and B open'), {
            message: 'shared: exactly one player row for the shared identity',
            timeout: 15_000,
          })
          .toBe(1);

        await b.page.close();
        await expectRowHeld(identity, 'shared: B closed');
        await walkOneTile(a.page, 'shared: page A after B closed');
        expect(rowsFor(identity, 'shared: A walked'), 'shared: the row is still there').toBe(1);

        const c = await openJoined(ctx, 'shared: page C');
        expect(c.identity, 'shared: page C joins as the same identity').toBe(identity);
        await a.page.close();
        await expectRowHeld(identity, 'shared: A closed');
        await walkOneTile(c.page, 'shared: page C after A closed');
        expect(rowsFor(identity, 'shared: C walked'), 'shared: the row is still there').toBe(1);
      } finally {
        await ctx.close();
      }
      if (identity !== '') {
        await expect
          .poll(() => rowsFor(identity, 'shared: context closed'), {
            message: 'shared: closing the last page ends the session (the row is gone)',
            timeout: SESSION_END_MS,
          })
          .toBe(0);
      }
      await expect
        .poll(() => newPlayers(before, 'shared: players after close'), {
          message: 'shared: the closed context leaves no player behind',
          timeout: SESSION_END_MS,
        })
        .toEqual([]);
    });
  });
