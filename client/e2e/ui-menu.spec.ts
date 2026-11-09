import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressButton } from './controls';

// ui-menu.spec.ts — uif-15b (M-ui-foundation): the main menu's root leaves, measured in Chromium
// (UIF15B.5). Social is a root LEAF that opens the four-tab Social frame directly (UIF15B.1), so
// every root leaf (Monsters, Inventory, Journal, Social) behaves alike: A opens it above the menu,
// B returns to the menu root with the cursor on that same entry, and a second B closes the menu.
//
// ORACLE RULE. The leaf keys are the menu table's `open` rows, spelled out here as literals (the
// unit suite main.menu.test.ts derives them from MENU_ENTRIES with an anti-vacuity count; this spec
// only needs the browser's view of the same four), and every state is read off the page: the stack
// through `__game()`, the menu cursor through `__game().navActive`, shown-ness through Playwright's
// visibility. Nothing is read back from the module under test.
//
// HYGIENE. ONE browser context, ONE player, closed in afterAll (a second context would add a
// presence row; golden.spec.ts asserts an exact count). No encounter, no battle, no RNG, no fixed
// sleep: every wait polls a bounded predicate.
//
// REDS AT MASTER: the Social row is a group, so A on it enters a Social sub-list (the stack stays
// [world, menuView]) instead of opening the Social frame.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
  navActive: string | null;
}

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    return g.stack.map(
      (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
    );
  });

const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().navActive);

/** Down presses (each followed by a poll that the cursor moved) until `read` names `key`. */
async function downTo(
  p: Page,
  read: (p: Page) => Promise<string | null>,
  key: string,
  maxPresses: number,
  what: string,
): Promise<void> {
  for (let i = 0; i < maxPresses && (await read(p)) !== key; i += 1) {
    const before = await read(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => read(p), { message: `${what}: Down moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await read(p), `${what}: the cursor is on ${key}`).toBe(key);
}

/** The root leaves of the menu, in display order, and the frame each opens above the menu. */
const LEAVES: ReadonlyArray<readonly [string, string]> = [
  ['monsters', 'boxView'],
  ['bag', 'raisingView'],
  ['journal', 'questLogView'],
  ['social', 'social'],
];

test.describe
  .serial('UIF15B — every root leaf of the main menu opens and B returns to the menu, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF15B.5 Start opens the menu; A on Social opens the Social frame with its tab strip, B returns to the menu with the cursor on Social; A on each other root leaf opens its screen, B returns to the menu on that entry; a last B closes the menu to the bare world', async () => {
      // WRONG IMPL KILLED: a Social row that is still a group (A enters a sub-list: the stack stays
      // [world, menuView] and no Social frame shows); a leaf whose B closes the whole menu (the
      // stack would be [world]); a return that lands on the first entry (the cursor is forgotten
      // across the child); a Social return that lands in a Social sub-list (the old two-level
      // detour); a menu left hidden or covered after the return; a root B that does not close.
      test.setTimeout(90_000);
      await closeAll(page);
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'Start opens the menu' })
        .toEqual(['world', 'menuView']);
      await expect(page.locator('#menu-overlay'), 'the menu is shown').toBeVisible();

      let checked = 0;
      for (const [key, frame] of LEAVES) {
        await downTo(page, navActive, key, 8, `${key}: the main menu`);
        await pressButton(page, 'A');
        await expect
          .poll(() => stackNames(page), { message: `${key}: A opens ${frame} over the menu` })
          .toEqual(['world', 'menuView', frame]);
        if (key === 'social') {
          await expect(
            page.locator('#social-tab-players'),
            'social: the Social frame is on Players at fresh memory',
          ).toHaveAttribute('aria-selected', 'true');
          await expect(
            page.locator('#social-tabs'),
            'social: the four-tab strip is shown',
          ).toBeVisible();
        }

        await pressButton(page, 'B');
        await expect
          .poll(() => stackNames(page), { message: `${key}: B closes only the child` })
          .toEqual(['world', 'menuView']);
        await expect(
          page.locator('#menu-overlay'),
          `${key}: the menu is shown again`,
        ).toBeVisible();
        await expect
          .poll(() => navActive(page), { message: `${key}: the cursor is back on ${key}` })
          .toBe(key);
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: all four root leaves were driven').toBe(4);

      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'B at the menu root closes it' })
        .toEqual(['world']);
    });
  });
