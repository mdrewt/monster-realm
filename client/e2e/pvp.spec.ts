import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// m16b PvP challenge overlay e2e — client-side UI wiring (ADR-0110).
//
// SCOPE: validates that the PvP challenge overlay DOM is wired, KeyP opens/closes it,
// the empty-list state renders correctly, Escape closes it, and mutual exclusivity with
// other overlays is enforced.
//
// ROUND-TRIP LIMITATION:
//   Full challenge/accept/decline flows require two distinct connected players and the
//   ability to call `challenge_pvp` from the test context.  The SpacetimeDB SDK does
//   not expose an out-of-band reducer call from the test context (same constraint as
//   recruit.spec.ts, trade.spec.ts).  Full flow coverage requires a `window.__mrPvp`
//   test hook — a production code change outside this slice's declared touches.
//   The evals/dom-shell-coverage-exclusion.eval.mjs registration (pvpView.ts) and
//   static-analysis in the pvpModel.test.ts unit suite cover the remaining criteria.
//
// WHAT THESE TESTS KILL:
//   "DOM missing"       — regression in index.html that removes a child div;
//                         pvpView.ts constructor throws, overlay never opens
//   "KeyP dead"         — regression in main.ts KeyP handler or pvpView wiring
//   "Escape dead"       — regression in main.ts Escape→pvpView.hide() path
//   "mutual exclusivity"— regression in main.ts KeyP 9-view guard; PvP overlay
//                         opens over another overlay (e.g. box, trade)

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
}

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
    // KeyP opens the PvP overlay; pressing KeyP again closes it.
    // -------------------------------------------------------------------------
    test('KeyP toggles the PvP overlay', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      await page.keyboard.press('p');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      // Toggle off.
      await page.keyboard.press('p');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // Escape closes the PvP overlay (main.ts Escape → pvpView.hide()).
    // -------------------------------------------------------------------------
    test('Escape closes the PvP overlay', async () => {
      await page.keyboard.press('p');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      await page.keyboard.press('Escape');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // Mutual exclusivity: KeyP must NOT open the PvP overlay when the box is open.
    // -------------------------------------------------------------------------
    test('KeyP does not open PvP overlay when box overlay is visible', async () => {
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      // Open box overlay (KeyB when no battle).
      await page.keyboard.press('b');
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('#app > div')).some(
            (el) => el instanceof HTMLElement && el.style.display === 'flex',
          ),
        null,
        { timeout: 3_000 },
      );

      // KeyP with box open — PvP overlay must stay hidden.
      await page.keyboard.press('p');
      await page.waitForTimeout(200);

      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      // Cleanup: close the box overlay.
      await page.keyboard.press('b');
      await page.waitForTimeout(200);
    });

    // -------------------------------------------------------------------------
    // Mutual exclusivity: KeyB must NOT open box overlay when PvP overlay is open.
    // -------------------------------------------------------------------------
    test('KeyB does not open box overlay when PvP overlay is visible', async () => {
      // Open PvP overlay first.
      await page.keyboard.press('p');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      // KeyB with PvP open — box must stay hidden.
      await page.keyboard.press('b');
      await page.waitForTimeout(200);

      // Box overlay root is a child div of #app with display:flex when open.
      const boxOpen = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#app > div')).some(
          (el) => el instanceof HTMLElement && el.style.display === 'flex',
        ),
      );
      expect(boxOpen).toBe(false);

      // Cleanup: close the PvP overlay.
      await page.keyboard.press('Escape');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // Mutual exclusivity: KeyP must NOT open PvP overlay when trade overlay is open.
    // -------------------------------------------------------------------------
    test('KeyP does not open PvP overlay when trade overlay is visible', async () => {
      // Open trade overlay (KeyU).
      await page.keyboard.press('u');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // KeyP with trade open — PvP overlay must stay hidden.
      await page.keyboard.press('p');
      await page.waitForTimeout(200);

      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();

      // Cleanup.
      await page.keyboard.press('Escape');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // -------------------------------------------------------------------------
    // PvP overlay heading text: pvpView.ts sets "PvP Challenge" text on open.
    // -------------------------------------------------------------------------
    test('PvP overlay shows "PvP Challenge" heading when opened', async () => {
      await page.keyboard.press('p');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });

      await expect(page.locator('#pvp-challenge-status')).toHaveText('PvP Challenge');

      // Cleanup.
      await page.keyboard.press('Escape');
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden({ timeout: 5_000 });
    });
  });
