import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressAccel } from './controls';

// PvP challenge overlay e2e — client-side UI wiring.
//
// SCOPE: validates that the PvP challenge overlay DOM is wired, P opens/closes it (ctl-11a:
// Social on Challenges, through the main menu), the empty-list state renders correctly, Escape
// closes it, and an accelerator pressed over another open screen REPLACES it (ctl-11a: the old
// mutual exclusivity is retired; the same-frame accelerators P, U and L act as Start).
//
// WHAT THESE TESTS KILL:
//   "DOM missing"       — regression in index.html that removes a child div;
//                         pvpView.ts constructor throws, overlay never opens
//   "P dead"            — regression in the router's accelerator path or pvpView wiring
//   "Escape dead"       — regression in the Escape (Start) → close path
//   "replace"           — an accelerator that does nothing over another open screen (the
//                         retired mutual exclusivity), or one that opens over it

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string; partySlot: number }>;
}

/** The context stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    return g.stack.map((f) => f.id ?? f.kind);
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

test.describe
  .serial('m16b — PvP challenge overlay UI wiring', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    // -------------------------------------------------------------------------
    // DOM structure: all required elements must exist (pvpView.ts constructor
    // throws if any are missing, crashing the PvP overlay wiring).
    // -------------------------------------------------------------------------
    test('PvP overlay DOM elements exist', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toHaveCount(1);
      await expect(page.locator('#pvp-challenge-status')).toHaveCount(1);
      await expect(page.locator('#pvp-challenge-incoming')).toHaveCount(1);
      await expect(page.locator('#pvp-challenge-outgoing')).toHaveCount(1);
      await expect(page.locator('#pvp-player-list')).toHaveCount(1);
      await expect(page.locator('#pvp-challenge-feedback')).toHaveCount(1);
    });

    // -------------------------------------------------------------------------
    // Initial state: overlay is hidden on page load (display: none in index.html).
    // -------------------------------------------------------------------------
    test('PvP overlay is initially hidden', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
    });

    // -------------------------------------------------------------------------
    // P opens Social on Challenges (ctl-11a: through the main menu, the cursor on the leaf);
    // pressing P again, with its own screen on top, acts as Start and closes it.
    // -------------------------------------------------------------------------
    test('KeyP toggles the PvP overlay', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#social-tab-challenges')).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'social']);

      // Toggle off (Start: the stack returns to the bare world).
      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world']);
    });

    // -------------------------------------------------------------------------
    // Escape (Start) closes the PvP overlay and the menu beneath it.
    // -------------------------------------------------------------------------
    test('Escape closes the PvP overlay', async () => {
      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      await page.keyboard.press('Escape');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world']);
    });

    // -------------------------------------------------------------------------
    // ctl-11a (named intentional change): was 'KeyP does not open PvP overlay when box overlay is
    // visible' (mutual exclusivity: the second key did nothing). An accelerator pressed over a
    // DIFFERENT open player screen REPLACES it: B opens Monsters, then P closes it and opens Social
    // on Challenges. The waitForTimeout(200) flushes are gone: every wait polls.
    // -------------------------------------------------------------------------
    test('ctl-11a: P replaces the open Monsters screen with Social on Challenges', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      // Open the Monsters screen (B): its root is a child div of #app, display:flex.
      await pressAccel(page, 'B');
      await expect(page.locator('[data-testid="box-title"]')).toBeVisible({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'boxView']);

      // P with Monsters open — Monsters is replaced, not refused.
      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#social-tab-challenges')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-testid="box-title"]')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'social']);

      // Cleanup: Start closes everything.
      await closeAll(page);
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // ctl-11a (named intentional change): was 'KeyB does not open box overlay when PvP overlay is
    // visible'. B now replaces the open Social screen with Monsters (Storage).
    // -------------------------------------------------------------------------
    test('ctl-11a: B replaces the open PvP overlay with the Monsters screen', async () => {
      // Open PvP overlay first (Social on Challenges).
      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      // B with Social open — Social is replaced, not refused. The Monsters root is a child div
      // of #app (display:flex when open).
      await pressAccel(page, 'B');
      await expect(page.locator('[data-testid="box-title"]')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'boxView']);

      // Cleanup: Start closes everything.
      await closeAll(page);
      await expect(page.locator('[data-testid="box-title"]')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // ctl-11a (named intentional change): was 'KeyP does not open PvP overlay when trade overlay is
    // visible'. P, U and L share the Social frame (their canonical paths all end in it), so with
    // Social open on Trades, P is its own screen's accelerator and acts as Start: it closes Social
    // rather than moving it to Challenges (it neither does nothing nor opens a second panel).
    // -------------------------------------------------------------------------
    test('ctl-11a: with the trade overlay open, P acts as Start and closes Social', async () => {
      // Open trade overlay (U).
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // P with Social open on Trades — Start.
      await pressAccel(page, 'P');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
      await expect.poll(() => stackNames(page)).toEqual(['world']);
    });

    // -------------------------------------------------------------------------
    // PvP overlay heading text: pvpView.ts sets "PvP Challenge" text on open.
    // -------------------------------------------------------------------------
    test('PvP overlay shows "PvP Challenge" heading when opened', async () => {
      await pressAccel(page, 'P');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      await expect(page.locator('#pvp-challenge-status')).toHaveText('PvP Challenge');

      // Cleanup.
      await page.keyboard.press('Escape');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });
  });

// ctl-8d (CTL8D.1, CTL8D.2): answering a challenge from the Social frame with the keyboard.
//
// Two players, each in its own chromium.launch() (two browsers, two SpacetimeDB identities: the
// pvp-side-b.spec.ts design). A challenges B through the DEV reducer hook (ctl-10b: the PvP overlay
// has no per-player Challenge button any more) and presses P to see its outgoing request. B never
// opens anything: the incoming challenge shows a banner (ctl-13: it no longer opens Social by itself),
// and B opens Social on its Challenges tab (P) with the cursor on the request. B answers it from the action sheet:
// A (Enter) opens Accept / Decline on Accept, Down then A on Decline asks Yes / No with No
// selected, Up then A on Yes declines. The request is then gone for both players. Decline, not
// Accept: it leaves no battle behind for the specs that run after this one, and answering is what
// closes the request (a pending request keeps its banner and badge).
//
// `__game()` is read only for readiness, the identities and closeAll's stack; every step is a key
// press or a click on the production DOM.
//
// WHAT THIS KILLS: a Social frame that opens on another tab for an incoming challenge or puts no
// cursor on it; a sheet that does not open on Enter, opens on Decline, or lists other actions; a
// Decline that sends at once or whose prompt defaults to Yes; and a Yes that sends nothing (the
// request would stay on both screens).
test.describe
  .serial('ctl-8d — answering a challenge from the Social sheet (two players)', () => {
    let browserA: Browser;
    let pageA: Page;
    let browserB: Browser;
    let pageB: Page;

    test.beforeAll(async () => {
      browserA = await chromium.launch();
      const ctxA: BrowserContext = await browserA.newContext();
      pageA = await ctxA.newPage();
      browserB = await chromium.launch();
      const ctxB: BrowserContext = await browserB.newContext();
      pageB = await ctxB.newPage();
      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([ready(pageA), ready(pageB)]);
    });

    test.afterAll(async () => {
      // Tolerant teardown (pvp-side-b.spec.ts precedent): a failing assertion above must not leave
      // either browser process orphaned.
      try {
        await browserA?.close();
      } catch {
        // ignore — may already be closed by an error path
      }
      try {
        await browserB?.close();
      } catch {
        // ignore
      }
    });

    test('ctl-8d: B is challenged, Social opens on Challenges with the cursor on the request, and B declines it from the sheet with the keyboard (No is the default)', async () => {
      test.setTimeout(120_000);
      const identityOf = (p: Page): Promise<string> =>
        p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().identity);
      const identityA = await identityOf(pageA);
      const identityB = await identityOf(pageB);
      expect(identityA, 'identityA must be non-empty').not.toBe('');
      expect(identityB, 'identityB must be non-empty').not.toBe('');
      expect(identityA, 'two players, two identities').not.toBe(identityB);
      // Nothing open on either side: A's P and B's P must open Social, not toggle it closed.
      await closeAll(pageA);
      await closeAll(pageB);

      // A challenges B. INTENTIONAL CHANGE (ctl-10b, CTL10B.2): the PvP overlay no longer lists
      // players or offers a per-player Challenge button. This case is about ANSWERING a challenge,
      // not starting one (the face-to-face start is proved by pvp-side-b.spec.ts and the unit
      // suites), so the challenge is sent through the DEV reducer hook, as pvp-full.spec.ts does,
      // with A's party ids. A then opens Social on Challenges (P) to see its outgoing request.
      await pageA.evaluate(async (target: string) => {
        const w = window as unknown as {
          __game: () => GameSnap;
          __mrPvp: { challengePvp(t: string, party: string[]): Promise<void> | undefined };
        };
        const party = w
          .__game()
          .ownMonsters.filter((m) => m.partySlot !== 255)
          .map((m) => m.monsterId);
        const sent = w.__mrPvp.challengePvp(target, party);
        if (sent === undefined) throw new Error('challengePvp: conn not ready');
        await sent;
      }, identityB);
      await pressAccel(pageA, 'P');
      await expect(pageA.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(pageA.locator('[data-testid="pvp-outgoing-label"]')).toBeVisible({
        timeout: 15_000,
      });

      // B: INTENTIONAL CHANGE (ctl-13, CTL13.2): the incoming challenge no longer opens Social by
      // itself. It shows the banner, and Social on Challenges opens when B asks for it (P), with
      // the cursor on the request.
      await expect(pageB.locator('#notice-banner')).toBeVisible({ timeout: 15_000 });
      await expect(
        pageB.locator('#pvp-challenge-overlay'),
        'nothing opened by itself',
      ).toBeHidden();
      await pressAccel(pageB, 'P');
      await expect(pageB.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(pageB.locator('[data-testid="pvp-incoming-label"]')).toBeVisible();
      await expect(pageB.locator('#pvp-challenge-overlay #social-tabs')).toHaveCount(1);
      await expect(pageB.locator('#social-tab-challenges')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(pageB.locator('#pvp-challenge-incoming')).toHaveAttribute(
        'aria-current',
        'true',
      );

      // A: the sheet, Accept then Decline, the cursor on Accept.
      await pageB.keyboard.press('Enter');
      await expect(pageB.locator('#social-sheet [data-nav-key]')).toHaveText(['Accept', 'Decline']);
      await expect(pageB.locator('#social-sheet [aria-selected="true"]')).toHaveText('Accept');

      // Down, A on Decline: the question, No selected; nothing is answered yet.
      await pageB.keyboard.press('ArrowDown');
      await expect(pageB.locator('#social-sheet [aria-selected="true"]')).toHaveText('Decline');
      await pageB.keyboard.press('Enter');
      await expect(pageB.locator('#social-prompt-text')).toBeVisible();
      await expect(pageB.locator('#social-prompt-text')).toHaveText('Decline this challenge?');
      await expect(pageB.locator('#social-confirm [aria-selected="true"]')).toHaveText('No');
      await expect(pageB.locator('[data-testid="pvp-incoming-label"]')).toBeVisible();

      // Up to Yes, A: declined. The request is gone for B and for A; no battle starts.
      await pageB.keyboard.press('ArrowUp');
      await expect(pageB.locator('#social-confirm [aria-selected="true"]')).toHaveText('Yes');
      await pageB.keyboard.press('Enter');
      await expect(pageB.locator('[data-testid="pvp-incoming-label"]')).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(pageA.locator('[data-testid="pvp-outgoing-label"]')).toHaveCount(0, {
        timeout: 15_000,
      });
    });
  });
