import { type Browser, type BrowserContext, chromium, expect, test } from '@playwright/test';
import { renderShellConfigScript } from '../src/net/shellDocument';
import { ownerSql, sqlRows } from './stdb';

// shell-config.spec.ts: the page takes its SpacetimeDB target from the shell document the host
// serves as `/shell-config.js`, at run time.
//
//   absent database   `/shell-config.js` is replaced (Playwright routing) by a document naming a
//                     database that does not exist on the suite's server: the client reports the
//                     connect failure on the status line, holds no identity and no own character,
//                     and the suite database's `player` table does not grow;
//   dev server's own  no routing: the dev server serves a document naming the suite's server and
//                     database, the page global holds exactly that, and the client joins the world.
//
// SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db). Each test opens its
// own context and closes it in a finally; the second test joins one player and waits for the
// server to delete its `player` row after the close, so no later spec sees an extra presence. No
// fixed sleep: every wait polls a predicate with a bound.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
}

const SUITE_URI = process.env.VITE_STDB_URI?.trim() || 'ws://127.0.0.1:3000';
const SUITE_DB = process.env.VITE_STDB_DB?.trim() || 'monster-realm';
/** Inside the database-name charset, and never published by any suite. */
const ABSENT_DB = 'mr-e2e-no-such-database-0';

/** The `player` table's identities, lowercase hex without a `0x`. */
function playerIdentities(label: string): string[] {
  return sqlRows(ownerSql('SELECT * FROM player', label), label).map((row) =>
    (row.identity ?? '').toLowerCase().replace(/^0x/, ''),
  );
}

test.describe
  .serial('the page connects to the target its shell document names', () => {
    let browser: Browser;

    test.beforeAll(async () => {
      browser = await chromium.launch();
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('a document naming an absent database reports the connect failure and joins no one', async () => {
      const before = playerIdentities('absent: players before');
      const ctx: BrowserContext = await browser.newContext();
      try {
        await ctx.route('**/shell-config.js', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            body: renderShellConfigScript({
              connection: { uri: SUITE_URI, db: ABSENT_DB, kind: 'test' },
            }),
          }),
        );
        const page = await ctx.newPage();
        // Every WebSocket the page opens, by URL: the SDK dials `<uri>/v1/database/<db>/subscribe`.
        const sockets: string[] = [];
        page.on('websocket', (ws) => {
          sockets.push(ws.url());
        });
        await page.goto('/');

        await expect
          .poll(
            () => sockets.some((u) => new URL(u).pathname.includes(`/v1/database/${ABSENT_DB}/`)),
            { message: 'the client dials the routed database', timeout: 30_000 },
          )
          .toBe(true);
        expect(
          sockets.filter((u) => new URL(u).pathname.includes(`/v1/database/${SUITE_DB}/`)),
          'the client never dials the suite database',
        ).toEqual([]);

        await expect
          .poll(() => page.locator('#status').textContent(), {
            message: 'the status line reports the connect failure',
            timeout: 30_000,
          })
          .toMatch(/^connect:/);
        const snap = await page.evaluate(() => {
          const w = window as unknown as { __game?: () => GameSnap };
          if (w.__game === undefined) return null;
          const g = w.__game();
          return { identity: g.identity, ownAuthTile: g.ownAuthTile };
        });
        expect(snap, 'the DEV hook is installed').not.toBeNull();
        expect(snap?.identity, 'no identity: the client never connected').toBe('');
        expect(snap?.ownAuthTile, 'no own character').toBeNull();
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __MR_SHELL_CONFIG__?: unknown }).__MR_SHELL_CONFIG__,
          ),
          'the page read the routed document',
        ).toEqual({ connection: { uri: SUITE_URI, db: ABSENT_DB, kind: 'test' } });

        // Another spec's row may leave meanwhile, so the claim is "no identity that was not there".
        expect(
          playerIdentities('absent: players after').filter((id) => !before.includes(id)),
          'no player joined the suite database',
        ).toEqual([]);
      } finally {
        await ctx.close();
      }
    });

    test('the dev server`s own document names the suite target, and the client joins its world', async () => {
      const before = playerIdentities('own: players before');
      const ctx: BrowserContext = await browser.newContext();
      try {
        const page = await ctx.newPage();
        const shellResponse = page.waitForResponse(
          (r) => new URL(r.url()).pathname === '/shell-config.js',
          { timeout: 15_000 },
        );
        await page.goto('/');
        const res = await shellResponse;
        expect(res.status(), '/shell-config.js is served').toBe(200);
        expect(res.headers()['content-type'] ?? '', 'as JavaScript').toMatch(/^text\/javascript\b/);

        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __MR_SHELL_CONFIG__?: unknown }).__MR_SHELL_CONFIG__,
          ),
          'the page global holds the suite target',
        ).toEqual({ connection: { uri: SUITE_URI, db: SUITE_DB, kind: 'test' } });

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
        const identity = await page.evaluate(() =>
          (window as unknown as { __game: () => GameSnap }).__game().identity.toLowerCase(),
        );
        const own = identity.replace(/^0x/, '');
        await expect
          .poll(() => playerIdentities('own: players joined'), {
            message: 'the joined player has a row in the suite database',
            timeout: 15_000,
          })
          .toContain(own);
      } finally {
        await ctx.close();
      }
      await expect
        .poll(() => playerIdentities('own: players after close').length, {
          message: 'the closed context leaves no player behind',
          timeout: 15_000,
        })
        .toBe(before.length);
    });
  });
