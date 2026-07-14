import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// M15c trade overlay e2e — client-side UI wiring (ADR-0107).
//
// SCOPE: validates that the trade overlay DOM is wired, KeyU opens/closes it,
// the "No active trade" state renders correctly, and mutual exclusivity with
// other overlays is enforced.  These tests run against a single browser context.
//
// ROUND-TRIP LIMITATION (hidden dependency, documented here):
//   The full propose→respond→confirm flow requires two distinct players and the
//   ability to call `propose_trade` / `respond_trade` / `confirm_trade` from the
//   test.  The SpacetimeDB SDK does not expose an out-of-band reducer call from
//   the test context (DbConnection has no accessible token — same constraint as
//   recruit.spec.ts).  Full flow coverage would require a `window.__mrTrade`
//   test hook in main.ts (exposing conn.reducers.proposeTrade etc.) — a production
//   code change outside this slice's declared touches.  That hook is recorded as a
//   follow-up dependency; the evals/trade-*.eval.mjs trio provides static-analysis
//   coverage for TR-2..TR-18 in the interim.
//
// WHAT THESE TESTS KILL:
//   "DOM missing"           — regression in index.html that removes a child div;
//                             tradeView.ts constructor throws, overlay never opens
//   "KeyU dead"             — regression in main.ts KeyU handler or tradeView wiring
//   "status blank"          — tradeModel.ts buildTradeViewModel returns no-trade
//                             but tradeView.ts:78 sets wrong text
//   "Escape dead"           — regression in main.ts Escape→tradeView.hide() path
//   "mutual exclusivity"    — regression in main.ts KeyU 8-view guard; trade overlay
//                             opens over another overlay (e.g. box)

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
  .serial('M15c — trade overlay UI wiring', () => {
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

    // ---------------------------------------------------------------------------
    // DOM structure: all required elements must exist (tradeView.ts constructor
    // will throw if any are missing, crashing the trade overlay wiring).
    // ---------------------------------------------------------------------------
    test('trade overlay DOM elements exist', async () => {
      await expect(page.locator('#trade-overlay')).toHaveCount(1);
      await expect(page.locator('#trade-status')).toHaveCount(1);
      await expect(page.locator('#trade-my-side')).toHaveCount(1);
      await expect(page.locator('#trade-their-side')).toHaveCount(1);
      await expect(page.locator('#trade-actions')).toHaveCount(1);
      await expect(page.locator('#trade-feedback')).toHaveCount(1);
    });

    // ---------------------------------------------------------------------------
    // Initial state: overlay is hidden on page load (display: none via index.html).
    // ---------------------------------------------------------------------------
    test('trade overlay is initially hidden', async () => {
      await expect(page.locator('#trade-overlay')).toBeHidden();
    });

    // ---------------------------------------------------------------------------
    // KeyU opens the trade overlay showing "No active trade" when no offer exists.
    // Verifies the KeyU handler wiring AND the tradeModel no-trade path.
    // ---------------------------------------------------------------------------
    test('KeyU opens trade overlay with "No active trade"', async () => {
      // Ensure overlay is hidden before starting.
      await expect(page.locator('#trade-overlay')).toBeHidden();

      await page.keyboard.press('u');

      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      // tradeView.ts:78 sets this text for the no-trade state.
      await expect(page.locator('#trade-status')).toHaveText('No active trade');

      // Cleanup: close the overlay before next test.
      await page.keyboard.press('u');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // ---------------------------------------------------------------------------
    // Escape closes the trade overlay (main.ts Escape → tradeView.hide()).
    // ---------------------------------------------------------------------------
    test('Escape closes the trade overlay', async () => {
      // Open it.
      await page.keyboard.press('u');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // Close with Escape.
      await page.keyboard.press('Escape');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // ---------------------------------------------------------------------------
    // Mutual exclusivity: when box overlay is open, KeyU must NOT open trade.
    // Verifies the 8-view guard in the main.ts KeyU handler (main.ts:478-487).
    // The box overlay opens with KeyB when no battle is active (shouldToggleBox).
    // ---------------------------------------------------------------------------
    test('KeyU does not open trade overlay when box overlay is visible', async () => {
      // Ensure trade overlay starts hidden.
      await expect(page.locator('#trade-overlay')).toBeHidden();

      // Open box overlay.  KeyB opens it when no battle is active.
      // BoxView.show() sets style.display = 'flex' on a child div of #app.
      await page.keyboard.press('b');

      // Wait for the box overlay root to become display:flex (synchronous DOM mutation,
      // but waitForFunction is deterministic — avoids any residual event-loop lag).
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('#app > div')).some(
            (el) => el instanceof HTMLElement && el.style.display === 'flex',
          ),
        null,
        { timeout: 3_000 },
      );

      // Now press KeyU — with a box overlay visible, trade must stay hidden.
      await page.keyboard.press('u');
      await page.waitForTimeout(200); // let event loop flush

      await expect(page.locator('#trade-overlay')).toBeHidden();

      // Cleanup: close the box overlay.
      await page.keyboard.press('b');
      await page.waitForTimeout(200);
    });

    // ---------------------------------------------------------------------------
    // Regression: overlay content area is empty (not showing stale data) when
    // no offer exists.  Both my-side and their-side innerHTML must be blank.
    // ---------------------------------------------------------------------------
    test('trade overlay shows empty sides when no active trade', async () => {
      // Open the overlay.
      await page.keyboard.press('u');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // Both side panels must be empty (no stale cards/items from a prior render).
      const mySideContent = await page.locator('#trade-my-side').innerHTML();
      const theirSideContent = await page.locator('#trade-their-side').innerHTML();
      expect(mySideContent.trim()).toBe('');
      expect(theirSideContent.trim()).toBe('');

      // No action buttons when no active trade (tradeView.ts renders no buttons
      // for the no-trade state).
      const actionsContent = await page.locator('#trade-actions').innerHTML();
      expect(actionsContent.trim()).toBe('');

      // Cleanup.
      await page.keyboard.press('u');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });
  });
