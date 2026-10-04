import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressAccel, pressButton } from './controls';

// M15c trade overlay e2e — client-side UI wiring.
//
// SCOPE: validates that the trade overlay DOM is wired, U opens/closes it (ctl-11a: through the
// main menu, so the stack is [world, menuView, social]), the "No active trade" state renders
// correctly, and an accelerator pressed over another open screen REPLACES it (ctl-11a: the old
// mutual exclusivity is retired).  These tests run against a single browser context.
//
// WHAT THESE TESTS KILL:
//   "DOM missing"           — regression in index.html that removes a child div;
//                             tradeView.ts constructor throws, overlay never opens
//   "U dead"                — regression in the router's accelerator path or tradeView wiring
//   "status blank"          — tradeModel.ts buildTradeViewModel returns no-trade
//                             but tradeView.ts:78 sets wrong text
//   "Escape dead"           — regression in the Escape (Start) → close path
//   "replace"               — an accelerator that does nothing over another open screen (the
//                             retired mutual exclusivity), or one that opens its screen over it

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
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
    // Verifies the U accelerator wiring AND the tradeModel no-trade path. ctl-11a: U opens
    // Social through the main menu (the menu beneath, the cursor on Trades), and U again, with
    // its own screen on top, acts as Start: the stack ends at the bare world.
    // ---------------------------------------------------------------------------
    test('U opens trade overlay with "No active trade"', async () => {
      // Ensure overlay is hidden before starting.
      await expect(page.locator('#trade-overlay')).toBeHidden();

      await pressAccel(page, 'U');

      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      // tradeView.ts:78 sets this text for the no-trade state.
      await expect(page.locator('#trade-status')).toHaveText('No active trade');
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'social']);

      // Cleanup: close the overlay before next test (U on its own screen is Start).
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world']);
    });

    // ---------------------------------------------------------------------------
    // Escape (Start) closes the trade overlay and the menu beneath it.
    // ---------------------------------------------------------------------------
    test('Escape closes the trade overlay', async () => {
      // Open it.
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // Close with Escape.
      await page.keyboard.press('Escape');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world']);
    });

    // ---------------------------------------------------------------------------
    // ctl-11a (named intentional change): the old mutual exclusivity — "when the box overlay is
    // open, KeyU must NOT open trade" (test 'KeyU does not open trade overlay when box overlay is
    // visible') — is retired. An accelerator pressed over a DIFFERENT open player screen REPLACES
    // it: B opens Monsters (Storage), then U closes it and opens Social on Trades, one menu above
    // the base. The two waitForTimeout(200) flushes of the old test are gone: every wait polls.
    // ---------------------------------------------------------------------------
    test('ctl-11a: U replaces the open Monsters screen with Social on Trades', async () => {
      // Ensure trade overlay starts hidden.
      await expect(page.locator('#trade-overlay')).toBeHidden();

      // Open the Monsters screen: B (Storage). Its root is a child div of #app, display:flex.
      await pressAccel(page, 'B');
      await expect(page.locator('[data-testid="box-title"]')).toBeVisible({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'boxView']);
      await expect(page.locator('#trade-overlay')).toBeHidden();

      // Now U: Monsters is replaced, not refused.
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#trade-status')).toHaveText('No active trade');
      await expect(page.locator('[data-testid="box-title"]')).toBeHidden({ timeout: 5_000 });
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'social']);

      // Cleanup: Start closes everything.
      await closeAll(page);
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // ---------------------------------------------------------------------------
    // Regression: overlay content area is empty (not showing stale data) when
    // no offer exists.  Both my-side and their-side innerHTML must be blank.
    // ---------------------------------------------------------------------------
    test('trade overlay shows empty sides when no active trade', async () => {
      // Open the overlay.
      await pressAccel(page, 'U');
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

      // Cleanup (U on its own screen is Start).
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
    });

    // ---------------------------------------------------------------------------
    // ctl-11a (named intentional change): the old 'trade open: G/Q/H keys do not open overlays
    // (16.5c-1)' test asserted that, with the trade overlay open, KeyG (shop), KeyQ (quest log) and
    // KeyH (heal) opened nothing. It is retired in two parts.
    //   - DELETED BY NAME (B16): the 'g' and 'h' presses and their `#shop-overlay` /
    //     `#heal-overlay` hidden checks. KeyG and KeyH are bound to nothing, so the checks could
    //     never fail: they asserted nothing.
    //   - REPLACED: 'q' is LB now. With Social open it moves the Social tab (Trades to Players) and
    //     still opens no Journal; J, an accelerator over a DIFFERENT open player screen, REPLACES
    //     Social with the Journal (the exclusivity guard it used to hit is gone).
    //
    // WHAT THIS KILLS: a Q that opens the Journal again (or leaves the Social frame); a J that is
    // refused while Social is open, or that opens the Journal over it (two roots shown, or the
    // stack holding Social and the Journal together).
    // ---------------------------------------------------------------------------
    test('ctl-11a: with Social open, Q (LB) opens no Journal and J replaces Social with the Journal', async () => {
      // Ensure we start with no overlays open.
      await expect(page.locator('#trade-overlay')).toBeHidden();

      // Open the trade overlay via U.
      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });

      // Q is LB: the previous Social tab (Players), never the Journal.
      await pressButton(page, 'LB');
      await expect(page.locator('#social-tabs [aria-selected="true"]')).toHaveText('Players', {
        timeout: 5_000,
      });
      await expect(page.locator('#quest-log-overlay')).toBeHidden();
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'social']);

      // E is RB: back to Trades.
      await pressButton(page, 'RB');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#social-tabs [aria-selected="true"]')).toHaveText('Trades');

      // J replaces Social with the Journal. The Journal's root is judged by its inline display (an
      // empty quest log has no box, so toBeVisible would read it hidden).
      await pressAccel(page, 'J');
      await expect(page.locator('#quest-log-overlay')).toHaveCSS('display', 'block', {
        timeout: 5_000,
      });
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
      await expect.poll(() => stackNames(page)).toEqual(['world', 'menuView', 'questLogView']);

      // Cleanup: Start closes the Journal and the menu.
      await closeAll(page);
      await expect(page.locator('#quest-log-overlay')).toHaveCSS('display', 'none', {
        timeout: 5_000,
      });
    });

    // ---------------------------------------------------------------------------
    // ctl-8d (CTL8D.1, CTL8D.3): U opens the Social frame on its Trades tab. The tab strip
    // (Players | Trades | Challenges | Rankings) sits in the shown panel's root, and RB / LB switch
    // the panel: Challenges is the pvp root, Trades the trade root. PageDown / PageUp (the aliases)
    // are pressed by name; ctl-11a: pressButton('RB') / ('LB') press E / Q, the primary keys, which
    // were not routed to a screen before Q and E became LB and RB.
    //
    // WHAT THIS KILLS: a Social frame with no tab strip, or one whose strip stays in the hidden
    // root; tabs in another order or with other labels; RB / LB that do not switch the shown
    // panel; and a close that leaves a Social root painted.
    // ---------------------------------------------------------------------------
    test('ctl-8d: U opens Social on Trades with four tabs; PageDown / PageUp and E / Q switch the panel', async () => {
      await expect(page.locator('#trade-overlay')).toBeHidden();

      await pressAccel(page, 'U');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#social-tabs')).toHaveCount(1);
      await expect(page.locator('#social-tabs [role="tab"]')).toHaveText([
        'Players',
        'Trades',
        'Challenges',
        'Rankings',
      ]);
      await expect(page.locator('#trade-overlay #social-tabs [aria-selected="true"]')).toHaveText(
        'Trades',
      );

      // RB: the Challenges tab, over the pvp root; the strip moved with it.
      await page.keyboard.press('PageDown');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#trade-overlay')).toBeHidden();
      await expect(page.locator('#social-tabs')).toHaveCount(1);
      await expect(
        page.locator('#pvp-challenge-overlay #social-tabs [aria-selected="true"]'),
      ).toHaveText('Challenges');

      // LB: back to the Trades tab, over the trade root.
      await page.keyboard.press('PageUp');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
      await expect(page.locator('#trade-overlay #social-tabs [aria-selected="true"]')).toHaveText(
        'Trades',
      );

      // ctl-11a (CTL11A.3): E is RB and Q is LB, the same switch through the primary keys.
      await pressButton(page, 'RB');
      await expect(page.locator('#pvp-challenge-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#trade-overlay')).toBeHidden();
      await expect(
        page.locator('#pvp-challenge-overlay #social-tabs [aria-selected="true"]'),
      ).toHaveText('Challenges');
      await pressButton(page, 'LB');
      await expect(page.locator('#trade-overlay')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
      await expect(page.locator('#trade-overlay #social-tabs [aria-selected="true"]')).toHaveText(
        'Trades',
      );

      // Cleanup: Start closes the Social frame, whichever panel shows.
      await page.keyboard.press('Escape');
      await expect(page.locator('#trade-overlay')).toBeHidden({ timeout: 5_000 });
      await expect(page.locator('#pvp-challenge-overlay')).toBeHidden();
    });
  });
