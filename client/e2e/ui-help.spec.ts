import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressButton } from './controls';

// ui-help.spec.ts — uif-14 (M-ui-foundation): How to Play as Introduction | Encyclopedia on the kit
// (UIF14.1, UIF14.4, UIF14.5, UIF14.7), measured in Chromium at 1280x720.
//
// WHAT IS PROVEN WHERE. The model, the screen's phases, the view's DOM and the announcements are unit
// specs (helpModel / helpScreen / helpView / main.help); this file proves what only a real engine can:
// the two tabs and the D-pad over the real list with the cursor remembered per tab (UIF14.1, UIF14.4),
// the detail sheet CENTRED over the still-visible list, B back to the same entry and a mouse click
// outside the sheet closing it through the kit's pointer rule (UIF14.5), and axe clean on Help in all
// three states (UIF14.7). The Report a problem row and UIF14.3 are deferred (hidden dependency:
// ui/battlePolicy.ts), so nothing here touches them.
//
// HYGIENE. Sorts after ui-controls. ONE browser context, ONE player, closed in afterAll (a second
// context would add a presence row; golden.spec.ts asserts an exact count). Every test starts from a
// closed Help (`closeAll`). No fixed sleeps: every wait polls a bounded predicate.
//
// REDS AT MASTER: everything. Help opens three tabs (This screen, All controls, Goals) with no
// Encyclopedia, no entry cursor and no detail sheet.
//
// LATE DEFERRED FOCUS (ci-fix-20261109T0400). The last test proves the FIXTURE, not the product:
// `openHelp` must return only once the open has settled (the overlay's deferred initial focus on
// `#help-title` has landed), else that focus can land after the keys and scroll the frame back to
// its top. It holds the page's zero-delay timers back so the late focus is deterministic, not luck.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
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

/** The Encyclopedia row carrying the cursor, by its entry key. */
const cursorKey = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document.querySelector('#help-encyclopedia .is-active')?.getAttribute('data-nav-key') ?? null,
  );

/** The text of the Encyclopedia row `key`. */
const rowText = (p: Page, key: string): Promise<string> =>
  p.evaluate((k) => {
    const el = document.querySelector(`#help-encyclopedia [data-nav-key="${k}"]`);
    if (el === null) throw new Error(`no Encyclopedia row ${k}`);
    return el.textContent ?? '';
  }, key);

const SHEET = '#help-overlay [data-context-sheet]';

/** Select opens How to Play at the world; waits for the overlay. */
async function openHelp(p: Page, label: string): Promise<void> {
  await closeAll(p);
  await pressButton(p, 'Select');
  await expect
    .poll(() => stackNames(p), { message: `${label}: Select opens the help frame` })
    .toEqual(['world', 'helpView']);
  await expect(p.locator('#help-overlay'), `${label}: Help is shown`).toBeVisible();
}

/** Open Help, RB onto the Encyclopedia. */
async function openEncyclopedia(p: Page, label: string): Promise<void> {
  await openHelp(p, label);
  await pressButton(p, 'RB');
  await expect(
    p.locator('#help-tab-encyclopedia'),
    `${label}: RB reaches the Encyclopedia`,
  ).toHaveAttribute('aria-selected', 'true');
  await expect(p.locator('#help-encyclopedia'), `${label}: its list is shown`).toBeVisible();
}

/** Down presses, each followed by a poll that the cursor moved, until the cursor reads `key`. */
async function downTo(p: Page, key: string, maxPresses: number, what: string): Promise<void> {
  for (let i = 0; i < maxPresses && (await cursorKey(p)) !== key; i += 1) {
    const before = await cursorKey(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => cursorKey(p), { message: `${what}: Down moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await cursorKey(p), `${what}: the cursor is on ${key}`).toBe(key);
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const boxOf = (p: Page, selector: string): Promise<Box> =>
  p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no ${sel}`);
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Non-vacuity floor for one scanned Help state: a page that failed to render passes ~0 rules.
 *  Measured on the uif-14 build in Chromium, twice, identical: Introduction 23, Encyclopedia 25, an
 *  entry detail 25; the floor is the lowest minus 2, as a11y.spec.ts's PASSES_FLOOR_HELP is. */
const AXE_PASSES_FLOOR = 21;

async function expectAxeClean(p: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page: p }).withTags(AXE_TAGS).exclude('canvas').analyze();
  expect(results.testEngine.name, `${state}: results did not come from axe-core`).toBe('axe-core');
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    `${state}: axe reported WCAG 2.x A/AA violations`,
  ).toEqual([]);
  expect(
    results.passes.length,
    `${state}: axe evaluated only ${results.passes.length} passing rule(s) (floor ${AXE_PASSES_FLOOR}): the page probably did not render`,
  ).toBeGreaterThanOrEqual(AXE_PASSES_FLOOR);
  // The undecidable set stays the one known rule (colour contrast over the canvas), as a11y.spec.ts.
  expect(
    results.incomplete.map((v) => v.id).filter((id) => id !== 'color-contrast'),
    `${state}: axe could not decide a rule outside the pinned set`,
  ).toEqual([]);
}

test.describe
  .serial('UIF14 — How to Play: Introduction and Encyclopedia on the kit, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      // `newContext()` (not `newPage()`): @axe-core/playwright refuses a page made on the browser.
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

    test('UIF14.1 Select opens How to Play with exactly two tabs, Introduction selected, its two paragraphs shown, the Encyclopedia list hidden and no All controls tab or panel; RB and LB switch the tab', async () => {
      // WRONG IMPL KILLED: the old three-tab Help (All controls kept: feedback 110); an opening on
      // the Encyclopedia; both panels shown; a tab strip the shoulder buttons cannot drive; the
      // retired panel ids still in the page.
      await openHelp(page, 'tabs');
      const tabs = page.locator('#help-tabs [role="tab"]');
      await expect(tabs, 'exactly two tabs').toHaveCount(2);
      await expect(tabs.nth(0)).toHaveText('Introduction');
      await expect(tabs.nth(1)).toHaveText('Encyclopedia');
      await expect(tabs.nth(0), 'it opens on Introduction').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#help-intro p'), 'two paragraphs').toHaveCount(2);
      await expect(page.locator('#help-intro')).toBeVisible();
      await expect(page.locator('#help-encyclopedia')).toBeHidden();
      for (const id of ['help-controls', 'help-goals', 'help-screen', 'help-note']) {
        await expect(page.locator(`#${id}`), `#${id} is gone`).toHaveCount(0);
      }
      await pressButton(page, 'RB');
      await expect(tabs.nth(1), 'RB: the Encyclopedia').toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#help-intro')).toBeHidden();
      await expect(page.locator('#help-encyclopedia')).toBeVisible();
      await pressButton(page, 'LB');
      await expect(tabs.nth(0), 'LB: back to Introduction').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await closeAll(page);
    });

    test('UIF14.4 the Encyclopedia lists sixteen terms as a D-pad list: Down walks the cursor, and the cursor is remembered per tab (Down x3, LB to Introduction, RB back, still the fourth term)', async () => {
      // WRONG IMPL KILLED: a list the D-pad cannot walk; fewer than the sixteen mechanics the spec
      // names; a cursor reset by the tab switch (feedback: remembered per tab); a cursor mark only
      // colour (the active row is also aria-selected).
      await openEncyclopedia(page, 'list');
      const rows = page.locator('#help-encyclopedia [data-nav-key]');
      await expect(rows, 'sixteen entries').toHaveCount(16);
      await expect
        .poll(() => cursorKey(page), { message: 'the cursor opens on the first entry' })
        .toBe('party');
      await expect(
        page.locator('#help-encyclopedia [data-nav-key].is-active'),
        'exactly one active row',
      ).toHaveCount(1);
      await expect(
        page.locator('#help-encyclopedia [data-nav-key].is-active'),
        'the active row is aria-selected',
      ).toHaveAttribute('aria-selected', 'true');
      await downTo(page, 'bait', 3, 'list');
      const baitText = await rowText(page, 'bait');

      await pressButton(page, 'LB');
      await expect(page.locator('#help-tab-intro')).toHaveAttribute('aria-selected', 'true');
      await pressButton(page, 'RB');
      await expect(page.locator('#help-tab-encyclopedia')).toHaveAttribute('aria-selected', 'true');
      await expect
        .poll(() => cursorKey(page), { message: 'the cursor is remembered per tab' })
        .toBe('bait');
      expect(await rowText(page, 'bait'), 'and the row still reads its term').toBe(baitText);
      await closeAll(page);
    });

    test('UIF14.5 A opens the entry as a detail sheet centred over the still-visible list; B closes it back to the same entry with Help open; a mouse click outside the sheet (on the frame, not a row) closes it the same way', async () => {
      // WRONG IMPL KILLED: a sheet that is not shown or is anchored to a corner (the spec says
      // "centred", the detail variant is never anchored); a list hidden behind the modal; a heading
      // that is not the opened entry's term; a B that closes Help with the sheet or resets the cursor
      // to the first entry (feedback 114); a click outside that does nothing (the kit's pointer rule,
      // WF1-A8) or that closes Help or activates a row.
      await openEncyclopedia(page, 'detail');
      await downTo(page, 'essence', 5, 'detail');
      const term = await rowText(page, 'essence');
      const sheet = page.locator(SHEET);
      await expect(sheet, 'no sheet before A').toBeHidden();

      await pressButton(page, 'A');
      await expect(sheet, 'A opened the sheet').toBeVisible();
      await expect(sheet.locator('.mr-sheet-title'), 'heading = the term').toHaveText(term);
      await expect(sheet.locator('.mr-sheet-prose'), 'prose is not empty').not.toHaveText('');
      await expect(sheet.locator('[data-nav-key]'), 'exactly one row, the Back row').toHaveCount(1);
      await expect(
        page.locator('#help-encyclopedia'),
        'the list stays visible behind',
      ).toBeVisible();

      const s = await boxOf(page, SHEET);
      const l = await boxOf(page, '#help-encyclopedia');
      const f = await boxOf(page, '#help-overlay');
      expect(s.left >= f.left - 1 && s.right <= f.right + 1, 'the sheet is inside the frame').toBe(
        true,
      );
      expect(s.top >= f.top - 1 && s.bottom <= f.bottom + 1, 'vertically too').toBe(true);
      expect(
        s.left < l.right && l.left < s.right && s.top < l.bottom && l.top < s.bottom,
        'the sheet sits over the list',
      ).toBe(true);
      const sheetMid = (s.left + s.right) / 2;
      const frameMid = (f.left + f.right) / 2;
      expect(Math.abs(sheetMid - frameMid), 'centred horizontally in the frame').toBeLessThan(8);

      await pressButton(page, 'B');
      await expect(sheet, 'B closed the sheet').toBeHidden();
      expect(await stackNames(page), 'Help is still open').toEqual(['world', 'helpView']);
      expect(await cursorKey(page), 'the same entry is active').toBe('essence');

      // The pointer rule: a click on the frame outside the open sheet presses B.
      await pressButton(page, 'A');
      await expect(sheet, 'reopened').toBeVisible();
      const title = await boxOf(page, '#help-title');
      const probe = {
        x: (title.left + title.right) / 2,
        y: (title.top + title.bottom) / 2,
      };
      const s2 = await boxOf(page, SHEET);
      expect(
        probe.x >= s2.left && probe.x <= s2.right && probe.y >= s2.top && probe.y <= s2.bottom,
        'fixture: the click point (the frame title) is outside the sheet',
      ).toBe(false);
      await page.mouse.click(probe.x, probe.y);
      await expect(sheet, 'a click outside closed the sheet').toBeHidden();
      expect(await stackNames(page), 'Help is still open after the click').toEqual([
        'world',
        'helpView',
      ]);
      expect(await cursorKey(page), 'the same entry is active after the click').toBe('essence');
      await closeAll(page);
    });

    test('UIF14.5 at the Extra large text step the detail opened on the last entry lies fully inside the visible frame', async () => {
      // WRONG IMPL KILLED: the sheet left at the overlay's scroll origin (absolutely positioned with
      // no account of scrollTop), so after the list scrolled to the last entry it opens above the
      // visible frame (measured: top -166, bottom 72 at scrollTop 375).
      try {
        await page.evaluate(() => {
          document.documentElement.style.setProperty('--mr-text-step', '2');
        });
        await openEncyclopedia(page, 'xl detail');
        await pressButton(page, 'Up');
        await expect
          .poll(() => cursorKey(page), { message: 'Up wraps to the last entry' })
          .toBe('ranked');
        await expect
          .poll(
            () => page.evaluate(() => document.getElementById('help-overlay')?.scrollTop ?? 0),
            {
              message: 'FIXTURE: the overlay is scrolled (else this test is vacuous)',
            },
          )
          .toBeGreaterThan(0);

        await pressButton(page, 'A');
        const sheet = page.locator(SHEET);
        await expect(sheet, 'A opened the sheet').toBeVisible();
        const s = await boxOf(page, SHEET);
        const f = await boxOf(page, '#help-overlay');
        const vh = await page.evaluate(() => window.innerHeight);
        expect(s.top, 'the sheet is not above the frame').toBeGreaterThanOrEqual(f.top - 1);
        expect(s.bottom, 'the sheet is not below the frame').toBeLessThanOrEqual(f.bottom + 1);
        expect(s.top, 'the sheet top is on screen').toBeGreaterThanOrEqual(0);
        expect(s.bottom, 'the sheet bottom is on screen').toBeLessThanOrEqual(vh);

        await pressButton(page, 'B');
        await expect(sheet, 'B closed the sheet').toBeHidden();
        expect(await cursorKey(page), 'the same entry is active').toBe('ranked');
      } finally {
        await page.evaluate(() => {
          document.documentElement.style.removeProperty('--mr-text-step');
        });
        await closeAll(page);
      }
    });

    test('UIF14.7 axe finds no WCAG 2.x A/AA violation on How to Play on Introduction, on the Encyclopedia, and with an entry detail open', async () => {
      // WRONG IMPL KILLED: a tab panel or sheet with an unnamed region / listbox, a tab with no
      // tablist, an aria-selected row outside a listbox, a modal sheet with no accessible name, or
      // contrast under 4.5:1 on the new rows and prose. Non-vacuity: a pass floor per state, and the
      // DOM each state promises is asserted before it is scanned.
      await openHelp(page, 'axe');
      await expect(page.locator('#help-intro p')).toHaveCount(2);
      await expectAxeClean(page, 'How to Play: Introduction');

      await pressButton(page, 'RB');
      await expect(page.locator('#help-encyclopedia [data-nav-key]')).toHaveCount(16);
      await expectAxeClean(page, 'How to Play: Encyclopedia');

      await pressButton(page, 'A');
      await expect(page.locator(SHEET)).toBeVisible();
      await expectAxeClean(page, 'How to Play: entry detail');
      await closeAll(page);
    });

    test('UIF14.5 fixture: with the late deferred focus held back past the keys, at the Extra large text step the Help frame stays scrolled to the cursor on the last entry once the heading has its focus', async () => {
      // WRONG FIXTURE KILLED: an `openHelp` that returns before the open's deferred focus has
      // landed — RB and Up race it, the focus lands on the heading after the cursor moved and
      // scrolls the frame back to its top (master CI run 42555008331: scrollTop 0 on `ranked`); and
      // its silent twin, the focus landing after the XL test's guard but before A, which makes that
      // test's sheet geometry pass vacuously at scrollTop 0.
      // The hold: the unsettled fixture's open-to-Up latency measured 31-75 ms, so 1500 ms keeps
      // its keys ahead of the focus even on a loaded machine. It cannot be "until released": a
      // settled `openHelp` waits for that very focus.
      const ZERO_DELAY_HOLD_MS = 1500;
      const scrollTop = (): Promise<number> =>
        page.evaluate(() => document.getElementById('help-overlay')?.scrollTop ?? 0);
      const heldFocus = (): Promise<boolean> =>
        page.evaluate(() => {
          const w = window as unknown as { __mrHeldFocus?: boolean };
          return w.__mrHeldFocus === true;
        });
      try {
        await page.evaluate((hold) => {
          type Timer = (handler: unknown, delay?: number, ...args: unknown[]) => number;
          const w = window as unknown as {
            setTimeout: Timer;
            __mrRealSetTimeout?: Timer;
            __mrHeldFocus?: boolean;
          };
          const real = w.setTimeout;
          w.__mrRealSetTimeout = real;
          w.__mrHeldFocus = false;
          // Delegates to the real timer and returns ITS id (overlayA11y clears it on a re-open).
          w.setTimeout = (handler, delay, ...args) => {
            if (typeof handler !== 'function' || (delay !== undefined && delay !== 0)) {
              return real.call(window, handler, delay, ...args);
            }
            const fn = handler as (...a: unknown[]) => void;
            const held = (): void => {
              const before = document.activeElement;
              try {
                fn(...args);
              } finally {
                const title = document.getElementById('help-title');
                if (title !== null && before !== title && document.activeElement === title) {
                  w.__mrHeldFocus = true;
                }
              }
            };
            return real.call(window, held, hold);
          };
          document.documentElement.style.setProperty('--mr-text-step', '2');
        }, ZERO_DELAY_HOLD_MS);
        await openEncyclopedia(page, 'late focus');
        await pressButton(page, 'Up');
        await expect
          .poll(() => cursorKey(page), { message: 'late focus: Up wraps to the last entry' })
          .toBe('ranked');
        expect(
          await scrollTop(),
          'FIXTURE: the overlay is scrolled to the cursor (else this test is vacuous)',
        ).toBeGreaterThan(0);

        await expect(
          page.locator('#help-title'),
          'late focus: the heading receives the open initial focus',
        ).toBeFocused();
        expect(
          await heldFocus(),
          'FIXTURE: the hold did not carry the overlay initial focus, so this test no longer exercises the late-focus ordering',
        ).toBe(true);
        expect(
          await scrollTop(),
          'the frame is still scrolled to the cursor after the late focus landed',
        ).toBeGreaterThan(0);
        expect(await cursorKey(page), 'late focus: the cursor is still on the last entry').toBe(
          'ranked',
        );
      } finally {
        try {
          await page.evaluate(() => {
            const w = window as unknown as { setTimeout: unknown; __mrRealSetTimeout?: unknown };
            if (w.__mrRealSetTimeout !== undefined) w.setTimeout = w.__mrRealSetTimeout;
            w.__mrRealSetTimeout = undefined;
            document.documentElement.style.removeProperty('--mr-text-step');
          });
        } finally {
          await closeAll(page);
        }
      }
    });
  });
