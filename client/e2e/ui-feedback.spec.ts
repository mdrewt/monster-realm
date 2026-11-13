import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { CONTROLS_STORAGE_KEY } from '../src/input/bindingStore';
import { t } from '../src/ui/i18n/resolver';
import { closeAll, pressAccel, pressButton } from './controls';

// ui-feedback.spec.ts: uif-4b (M-ui-foundation, UIF4B.2): every per-view message goes through the
// one seam, and showing it moves NO box of the frame that owns the flow (feedback item 058).
//
// Two flows, each measured at 1280x720 AND 640x240 against the REAL stylesheet, with exact equality
// (tolerance 0, never loosened):
//
//   the rename frame   a valid rename's success shows on #toast (the toast is anchored above frames and
//                      takes no layout), so the overlay, the name field, the save button and the
//                      current-name line keep their rects to the pixel;
//   the Controls frame a refused key paints its hint on the frame's own strip (#controls-feedback, the
//                      zero-layout-height sticky strip) and a bound key's line is a toast; the frame,
//                      its tab strip and its rows grid keep their rects through both.
//
// NOT ASSERTED: that the toast clears the Save button or the active cell. The toast is an overlay by
// design (anchored above every frame), so overlapping a control at a 240px window is legal; the
// clause UIF4B.2 states is that no box MOVES, and that is what is measured.
//
// ORACLE RULE. Every rect is read with `getBoundingClientRect` in one synchronous in-page pass, right
// after the state under test is reached (the toast or the strip is proven visible with its exact text
// first, so the "after" is never a vacuous no-op), and no control is clicked or focused between the
// two reads (a click scrolls its target into view at 640x240 and would move rects by itself): the
// rename submits with Enter in its focused field, and the Controls capture is driven by keys. A
// frame's own deferred initial focus is such a focus too, so it has landed before the first read:
// the rename waits for its field to be focused, and `openControls` for the rows.
//
// SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db). This file sorts after
// ui-chrome and before ui-scale. It joins exactly ONE player in ONE browser context, closed in
// afterAll, so the server's on_disconnect deletes the `player` row and no later spec sees an extra
// presence (golden.spec.ts sorts before it and asserts an exact presence count). The Controls case
// binds a key, so it removes `mr.controls` and reloads in a finally: the page never leaves a custom
// table behind. No encounter, no battle, no fixed sleep: every wait polls a DOM or `__game()`
// predicate with a bound.
//
// LATE DEFERRED FOCUS (ci-fix-20261113T2045). The last test proves the FIXTURE, not the product:
// `openControls` must return only once the frame's deferred initial focus on `#controls-rows` has
// landed, else that focus can land between two reads and scroll the 640x240 shell, moving the tab
// strip and the rows grid by itself. It holds the page's zero-delay timers back so the late focus
// is deterministic, not luck.

interface Frame {
  kind: string;
  id?: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  stack: Frame[];
  navActive: string | null;
}
interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const WINDOWS = [
  { width: 1280, height: 720 },
  { width: 640, height: 240 },
] as const;

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

const stackNames = async (p: Page): Promise<string[]> =>
  (await snap(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );

const navActive = async (p: Page): Promise<string | null> => (await snap(p)).navActive;

const controlsActive = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document
        .querySelector('#controls-rows [aria-selected="true"]')
        ?.getAttribute('data-nav-key') ?? null,
  );

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

/** The rects of `selectors`, read in one synchronous in-page pass (no frame between the reads). */
const rectsOf = (p: Page, selectors: readonly string[]): Promise<Rect[]> =>
  p.evaluate((sels: readonly string[]): Rect[] => {
    return sels.map((s) => {
      const el = document.querySelector(s);
      if (el === null) throw new Error(`rectsOf: ${s} is not on the page`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }, selectors);

test.describe
  .serial('UIF4B.2 — a per-view message moves no box of its frame', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    const setWindow = async (w: { width: number; height: number }): Promise<void> => {
      await page.setViewportSize({ width: w.width, height: w.height });
      await expect
        .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
        .toEqual([w.width, w.height]);
    };

    const openControls = async (label: string): Promise<void> => {
      // Start, Down to Controls, A: the Controls frame above the menu (remap.spec).
      // uif-15c (UIF15C.4): Controls is a root entry of the menu, so there is no group and no
      // Down-into-sub-list step.
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: `${label}: Start opens the menu` })
        .toEqual(['world', 'menuView']);
      await downTo(page, navActive, 'controls', 7, `${label}: the main menu`);
      await expect
        .poll(() => navActive(page), {
          message: `${label}: the cursor is on Controls before A`,
        })
        .toBe('controls');
      await pressButton(page, 'A');
      await expect
        .poll(() => stackNames(page), { message: `${label}: A opens Controls over the menu` })
        .toEqual(['world', 'menuView', 'controlsView']);
      await expect(page.locator('#controls-overlay')).toBeVisible();
      // SETTLE. The overlay moves focus to its rows one macrotask AFTER it opens (the deferred
      // initial focus of ui/overlayA11y.ts), and that focus scrolls the 640x240 shell. A key or a
      // rect read that beats it races it: the cursor scrolls the shell part of the way, then the
      // late focus scrolls it further and every box inside the shell moves. The open is over once
      // the rows have the focus (the pending timer is inert from then on). The rows do get it in
      // this spec: every open here starts with focus outside the frame (on the page body, or on
      // the menu beneath, which is blurred as Controls opens over it). A retried predicate with
      // the expect timeout as its bound, not a sleep.
      await expect(
        page.locator('#controls-rows'),
        `${label}: the open settled on the rows`,
      ).toBeFocused();
    };

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

    test('UIF4B.2 the rename frame: a valid rename`s success toast moves no box (the frame, the name field, the save button, the current-name line), at 1280x720 and 640x240', async () => {
      test.setTimeout(120_000);
      const BOXES = [
        '#rename-overlay',
        '#rename-current',
        '#rename-input',
        '#rename-submit',
      ] as const;
      try {
        for (const [i, w] of WINDOWS.entries()) {
          const label = `rename ${w.width}x${w.height}`;
          await setWindow(w);
          await closeAll(page);
          await expect(
            page.locator('#toast'),
            `${label}: no toast stands before the rename`,
          ).toBeHidden({ timeout: 15_000 });
          await pressAccel(page, 'N');
          await page.waitForSelector('[data-testid="rename-input"]', {
            state: 'visible',
            timeout: 10_000,
          });
          await expect(page.locator('[data-testid="rename-input"]')).toBeFocused();
          const newName = `UFeed${i}${String(Date.now() % 100_000)}`;
          await page.fill('[data-testid="rename-input"]', newName);
          await expect(
            page.locator('#rename-submit'),
            `${label}: a valid draft enables save`,
          ).toBeEnabled();

          const before = await rectsOf(page, BOXES);
          // Enter in the focused field submits the trimmed draft (no click: a click would scroll).
          await page.keyboard.press('Enter');
          await expect(page.locator('#toast'), `${label}: the success toast shows`).toBeVisible({
            timeout: 15_000,
          });
          await expect(page.locator('#toast'), `${label}: its exact text`).toHaveText(
            t('chrome.rename.updated'),
          );
          const after = await rectsOf(page, BOXES);

          for (const [k, sel] of BOXES.entries()) {
            expect(after[k], `${label}: ${sel} did not move by any amount`).toEqual(before[k]);
          }
          expect(
            await page.locator('[data-testid="rename-feedback"]').count(),
            `${label}: the retired rename line is not on the page`,
          ).toBe(0);
        }
      } finally {
        await closeAll(page);
        await setWindow({ width: 1280, height: 720 });
      }
    });

    test('UIF4B.2 the Controls frame: a refused-key hint on its strip and a bound key`s toast move no box (the frame, its tab strip, its rows), at 1280x720 and 640x240', async () => {
      test.setTimeout(180_000);
      const BOXES = ['#controls-overlay', '#controls-tabs', '#controls-rows'] as const;
      try {
        for (const w of WINDOWS) {
          const label = `controls ${w.width}x${w.height}`;
          await setWindow(w);
          await closeAll(page);
          await expect(page.locator('#toast'), `${label}: no toast stands`).toBeHidden({
            timeout: 15_000,
          });

          await openControls(label);
          // The X row's Alt slot (main.remap.test.ts's protected-refusal case): Down to X_0, Right.
          await downTo(page, controlsActive, 'X_0', 13, `${label}: the Controls grid`);
          await pressButton(page, 'Right');
          await expect
            .poll(() => controlsActive(page), { message: `${label}: Right moves onto X_1` })
            .toBe('X_1');
          await pressButton(page, 'A');
          await expect(
            page.locator('#controls-capture'),
            `${label}: a capture waits`,
          ).toBeVisible();

          // The empty strip is collapsed (precondition: the "after" below is a real change).
          await expect(
            page.locator('#controls-feedback'),
            `${label}: the strip starts empty`,
          ).toBeHidden();
          const before = await rectsOf(page, BOXES);

          // A PROTECTED refusal (Backspace would empty B, the only key it has): the key is
          // prevented, so no browser default (a Tab would move focus and scroll the shell, and
          // that scroll, not the hint, would be measured). The hint shows on the strip only.
          await page.keyboard.press('Backspace');
          await expect(
            page.locator('#controls-feedback'),
            `${label}: the hint shows`,
          ).toBeVisible();
          await expect(
            page.locator('#controls-feedback'),
            `${label}: the protected reason`,
          ).toHaveText(t('controls.refused.protected'));
          await expect(page.locator('#toast'), `${label}: the hint is not a toast`).toBeHidden();
          const withHint = await rectsOf(page, BOXES);
          for (const [k, sel] of BOXES.entries()) {
            expect(withHint[k], `${label}: ${sel} did not move when the hint showed`).toEqual(
              before[k],
            );
          }

          // A bound key (K): the line is a toast, the capture ends and the strip empties.
          await page.keyboard.press('KeyK');
          await expect(page.locator('#toast'), `${label}: the bound toast shows`).toBeVisible();
          await expect(page.locator('#toast'), `${label}: its exact text`).toHaveText(
            t('controls.bound'),
          );
          await expect(
            page.locator('#controls-feedback'),
            `${label}: the strip is empty again`,
          ).toBeHidden();
          const withToast = await rectsOf(page, BOXES);
          for (const [k, sel] of BOXES.entries()) {
            expect(withToast[k], `${label}: ${sel} did not move when the toast showed`).toEqual(
              before[k],
            );
          }
          // Put the default back for the next window: a second K on a K slot cancels, so remove
          // the saved table and reload instead (also what the finally below does).
          await page.evaluate((key: string) => localStorage.removeItem(key), CONTROLS_STORAGE_KEY);
          await page.reload();
          await ready(page);
        }
      } finally {
        await page.evaluate((key: string) => localStorage.removeItem(key), CONTROLS_STORAGE_KEY);
        await page.reload();
        await ready(page);
        await closeAll(page);
        await setWindow({ width: 1280, height: 720 });
      }
    });

    test('UIF4B.2 fixture: openControls waits out a late deferred focus on the rows before any further key is sent, so at 640x240 no box of the Controls frame moves once the rows have their focus', async () => {
      // The two orderings. SETTLED fixture: `openControls` waits out the hold, the rows take their
      // focus (which scrolls the 640x240 shell), and only then is the cursor walked to X_0, so
      // every read is at the same scroll. UNSETTLED fixture: the walk runs inside the hold and the
      // cursor's own nearest-scroll moves the shell part of the way, `before` is read there, then
      // the late focus scrolls the shell further and the tab strip and the rows grid move.
      // The hold is inside the PAGE (it delays the product's own zero-delay timer); the test itself
      // never sleeps, every wait in it is a retried predicate.
      // While installed, the hold delays EVERY zero-delay timer in the page, not only the
      // overlay's; any other one is only slowed.
      // The value: the hold starts at the Controls open, and an unsettled fixture is red only
      // while its first read comes before the held focus. The unsettled fixture's
      // open-to-first-read latency measures under 100 ms unthrottled and 959 ms at 20x CPU
      // throttle, so 1500 ms keeps that read ahead of the focus on a loaded machine. It is a
      // duration and not "until released" because a settled `openControls` waits for that
      // very focus. It must stay under the expect timeout (5 s) that bounds the settle in
      // `openControls`.
      const ZERO_DELAY_HOLD_MS = 1500;
      const label = 'late focus';
      const BOXES = ['#controls-overlay', '#controls-tabs', '#controls-rows'] as const;
      const heldFocus = (): Promise<boolean> =>
        page.evaluate(() => {
          const w = window as unknown as { __mrHeldFocus?: boolean };
          return w.__mrHeldFocus === true;
        });
      try {
        await setWindow({ width: 640, height: 240 });
        await closeAll(page);
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
          // Delegates to the real timer and returns ITS id: overlayA11y clears a pending timer
          // by that id when another frame opens over its frame, on a re-open, and on a close
          // (the menu's held timer is cleared that way when Controls opens over it).
          w.setTimeout = (handler, delay, ...args) => {
            if (typeof handler !== 'function' || (delay !== undefined && delay !== 0)) {
              return real.call(window, handler, delay, ...args);
            }
            const fn = handler as (...a: unknown[]) => void;
            const held = (): void => {
              const prior = document.activeElement;
              try {
                fn(...args);
              } finally {
                const rows = document.getElementById('controls-rows');
                if (rows !== null && prior !== rows && document.activeElement === rows) {
                  w.__mrHeldFocus = true;
                }
              }
            };
            return real.call(window, held, hold);
          };
        }, ZERO_DELAY_HOLD_MS);

        await openControls(label);
        await downTo(page, controlsActive, 'X_0', 13, `${label}: the Controls grid`);
        const before = await rectsOf(page, BOXES);

        await expect(
          page.locator('#controls-rows'),
          'late focus: the rows receive the open initial focus',
        ).toBeFocused();
        expect(
          await heldFocus(),
          'FIXTURE: the hold did not carry the overlay initial focus onto the rows, so this test no longer exercises the late-focus ordering',
        ).toBe(true);
        const after = await rectsOf(page, BOXES);
        for (const [k, sel] of BOXES.entries()) {
          expect(
            after[k],
            `late focus: ${sel} did not move when the deferred focus landed`,
          ).toEqual(before[k]);
        }

        const shell = await page.evaluate(() => {
          const overlay = document.getElementById('controls-overlay');
          const cell = document.querySelector('#controls-rows [aria-selected="true"]');
          if (overlay === null || cell === null) {
            throw new Error('late focus: the shell or the active cell is not on the page');
          }
          const o = overlay.getBoundingClientRect();
          const scrollportBottom = o.top + overlay.clientTop + overlay.clientHeight;
          return {
            scrollTop: overlay.scrollTop,
            clearance: scrollportBottom - cell.getBoundingClientRect().bottom,
          };
        });
        expect(
          shell.scrollTop,
          'FIXTURE: the shell is scrolled at 640x240 (else no focus can move a box and this test is vacuous)',
        ).toBeGreaterThan(0);
        expect(
          shell.clearance,
          'FIXTURE: the focus scrolled the shell past the active cell`s nearest-scroll (else a late focus moves no box and this test is vacuous)',
        ).toBeGreaterThan(0);
      } finally {
        try {
          await page.evaluate(() => {
            const w = window as unknown as { setTimeout: unknown; __mrRealSetTimeout?: unknown };
            if (w.__mrRealSetTimeout !== undefined) w.setTimeout = w.__mrRealSetTimeout;
            w.__mrRealSetTimeout = undefined;
          });
        } finally {
          await closeAll(page);
          await setWindow({ width: 1280, height: 720 });
        }
      }
    });
  });
