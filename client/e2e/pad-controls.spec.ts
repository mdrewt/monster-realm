import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { CONTROLS_STORAGE_KEY } from '../src/input/bindingStore';
import { PAD_DEFAULT_BINDINGS } from '../src/input/padBindings';
import { t } from '../src/ui/i18n/resolver';
import { closeAll, livePadBindings, pressButton, setPressSource } from './controls';
import { installFakePad, padHold, padPress } from './pad';

// pad-controls.spec.ts — the pad remap flow, played with the MOCKED PAD ONLY (the milestone's one
// e2e for it). The context gets the fake pad (`pad.ts` `installFakePad`) before the first `goto`,
// and the page presses through it (`setPressSource(page, 'pad')`), so every `pressButton` below,
// and `closeAll`, presses the pad button the page's LIVE pad table binds:
//
//   Start (9), Down (13) to Controls, A (0)    the Controls frame opens above the menu
//   Right, Right, Down x4                       the cursor walks onto the Confirm (A) row's Pad cell
//   A                                           "Press a pad button for Confirm (A)..." waits
//   button 3 held for 300 ms                    the cell shows Y's glyph, no second capture starts,
//                                               and Info (Y)'s Pad cell shows A's glyph (button 0)
//   B (1), Up                                   back to the menu, the cursor on How to play
//   button 0, then button 3                     0 (Info now) confirms nothing; 3 (Confirm now) opens
//                                               How to play
//   B, then pressButton(A)                      pad-mode pressButton presses the LIVE A, button 3
//
// Raw `padPress` is used only for the two probes of step 6 (which index confirms); every other press
// is `pressButton`'s. A "button 0 did nothing" read is taken right after the press: `padPress` waits
// two animation frames after the release, so whatever the press would open is on `__game().stack` by
// then. Every other wait polls observable state; the 300 ms hold is the flow's own gesture.
//
// DETERMINISM. One browser, one context, one identity. No walk, no battle. The test ends by removing
// `mr.controls` and reloading (in a `finally`, so a failure mid-flow leaves no remap behind), and
// afterAll closes the browser so the server's on_disconnect deletes the player row.

/** U+2026, built from its code point (never a pasted character). */
const ELLIPSIS = String.fromCharCode(0x2026);

interface Tile {
  x: number;
  y: number;
}
interface Frame {
  kind: string;
  id?: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  stack: Frame[];
  navActive: string | null;
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      stack: g.stack,
      navActive: g.navActive,
    };
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

/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = async (p: Page): Promise<string[]> =>
  (await snap(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );

const navActive = async (p: Page): Promise<string | null> => (await snap(p)).navActive;

/** The Controls cursor: the `data-nav-key` of the `aria-selected` cell in `#controls-rows`. */
const controlsActive = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document
        .querySelector('#controls-rows [aria-selected="true"]')
        ?.getAttribute('data-nav-key') ?? null,
  );

/** One Controls grid cell, by its `data-nav-key`. */
const cell = (p: Page, key: string): Locator => p.locator(`#controls-rows [data-nav-key="${key}"]`);

/** What a Pad cell reads: the plan's English `${label} (pad): ${key}`. */
const padCellText = (label: string, key: string): string => `${label} (pad): ${key}`;

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

test.describe
  .serial('the pad remap flow, pad only', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      await installFakePad(ctx); // before the first goto: the page loads with the pad present
      page = await ctx.newPage();
      setPressSource(page, 'pad');
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('on the mocked pad only, Start, Down to Controls, A, the Confirm (A) Pad cell, A, then pad button 3 held for 300 ms: the cell shows Y`s glyph with no second capture started, Info (Y) is on button 0, and the next menu choice is confirmed by button 3 [gp-5.10]', async () => {
      test.setTimeout(120_000);
      const labelA = t('controls.button.a');
      const labelY = t('controls.button.y');
      try {
        // ---- the fake pad is the page's one pad, and nothing is remapped yet --------------------
        expect(
          await page.evaluate(() => navigator.getGamepads().map((p) => (p === null ? null : p.id))),
          'the page reads the fake pad in slot 0 and nothing else',
        ).toEqual(['mr-fake-pad (STANDARD GAMEPAD)', null, null, null]);
        expect(await livePadBindings(page), 'precondition: the default pad table').toEqual(
          PAD_DEFAULT_BINDINGS,
        );
        await closeAll(page);
        expect(await stackNames(page), 'precondition: the bare world').toEqual(['world']);

        // ---- 1. Start, Down to Controls, A: the Controls frame above the menu --------------------
        await pressButton(page, 'Start');
        await expect
          .poll(() => stackNames(page), { message: 'pad Start opens the menu' })
          .toEqual(['world', 'menuView']);
        await downTo(page, navActive, 'controls', 7, 'the main menu');
        await pressButton(page, 'A');
        await expect
          .poll(() => stackNames(page), { message: 'pad A on Controls opens it above the menu' })
          .toEqual(['world', 'menuView', 'controlsView']);
        await expect(page.locator('#controls-tab-buttons'), 'on the Buttons tab').toHaveAttribute(
          'aria-selected',
          'true',
        );

        // ---- 2. onto the Confirm (A) row's Pad cell ------------------------------------------------
        await expect
          .poll(() => controlsActive(page), { message: 'Controls opens on the first cell' })
          .toBe('Up_0');
        const walk = [
          ['Right', 'Up_1'],
          ['Right', 'Up_pad'],
          ['Down', 'Down_pad'],
          ['Down', 'Left_pad'],
          ['Down', 'Right_pad'],
          ['Down', 'A_pad'],
        ] as const;
        for (const [button, key] of walk) {
          await pressButton(page, button);
          await expect
            .poll(() => controlsActive(page), { message: `pad ${button} onto ${key}` })
            .toBe(key);
        }
        await expect(cell(page, 'A_pad'), 'Confirm (A) is on button 0').toHaveText(
          padCellText(labelA, 'A'),
        );
        await expect(cell(page, 'Y_pad'), 'Info (Y) is on button 3').toHaveText(
          padCellText(labelY, 'Y'),
        );

        // ---- 3. A: the Pad capture waits ------------------------------------------------------------
        await pressButton(page, 'A');
        await expect(
          page.locator('#controls-capture'),
          'A on the Pad cell starts it',
        ).toBeVisible();
        await expect(page.locator('#controls-capture'), 'the pad prompt').toHaveText(
          `Press a pad button for ${labelA}${ELLIPSIS}`,
        );

        // ---- 4. button 3 held for 300 ms: bound, swapped, and no second capture -----------------
        await padHold(page, 3, 300);
        await expect(cell(page, 'A_pad'), 'the cell shows Y`s glyph').toHaveText(
          padCellText(labelA, 'Y'),
        );
        await expect(
          page.locator('#controls-capture'),
          'no capture waits: the held button 3 started no second one',
        ).toBeHidden();
        await expect(cell(page, 'Y_pad'), 'Info (Y) is on button 0, A`s glyph').toHaveText(
          padCellText(labelY, 'A'),
        );
        await expect
          .poll(
            async () => {
              const live = await livePadBindings(page);
              return [live.buttons.A, live.buttons.Y];
            },
            { message: 'mr.controls holds A on 3 and Y on 0' },
          )
          .toEqual([[3], [0]]);
        expect(await stackNames(page), 'the frame stays open').toEqual([
          'world',
          'menuView',
          'controlsView',
        ]);

        // ---- 5. B, Up: back to the menu, onto How to play -----------------------------------------
        await pressButton(page, 'B');
        await expect
          .poll(() => stackNames(page), { message: 'pad B pops Controls back to the menu' })
          .toEqual(['world', 'menuView']);
        await pressButton(page, 'Up');
        await expect.poll(() => navActive(page), { message: 'Up onto How to play' }).toBe('help');

        // ---- 6. button 0 confirms nothing; button 3 confirms -------------------------------------
        await padPress(page, 0);
        expect(await stackNames(page), 'button 0 (Info now) does not confirm').toEqual([
          'world',
          'menuView',
        ]);
        expect(await navActive(page), 'and the cursor did not move').toBe('help');
        await padPress(page, 3);
        await expect
          .poll(() => stackNames(page), { message: 'button 3 (Confirm now) opens How to play' })
          .toEqual(['world', 'menuView', 'helpView']);

        // ---- 7. pad-mode pressButton presses the LIVE table's A, button 3 -------------------------
        await pressButton(page, 'B');
        await expect
          .poll(() => stackNames(page), { message: 'B closes How to play' })
          .toEqual(['world', 'menuView']);
        expect(await navActive(page), 'the cursor is on How to play').toBe('help');
        await pressButton(page, 'A');
        await expect
          .poll(() => stackNames(page), { message: 'pressButton(A) pressed button 3' })
          .toEqual(['world', 'menuView', 'helpView']);
        await closeAll(page);
        expect(await stackNames(page)).toEqual(['world']);
      } finally {
        // ---- restore the default tables: the context leaves nothing behind ------------------------
        await page.evaluate(
          (key: string) => window.localStorage.removeItem(key),
          CONTROLS_STORAGE_KEY,
        );
        await page.reload();
        await ready(page);
      }
      expect(await livePadBindings(page), 'the default pad table is back').toEqual(
        PAD_DEFAULT_BINDINGS,
      );
    });
  });
