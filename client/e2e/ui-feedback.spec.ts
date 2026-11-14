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
// frame's own deferred initial focus is scroll-free (ui/overlayA11y.ts focuses its anchor with
// `preventScroll`), and the fixtures still wait for it before the first read so every read sees
// a settled open: the rename waits for its field to be focused, and `openControls` for the rows.
//
// SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db). This file sorts after
// ui-chrome and before ui-scale. It joins exactly ONE player in ONE browser context, closed in
// afterAll, so the server's on_disconnect deletes the `player` row and no later spec sees an extra
// presence (golden.spec.ts sorts before it and asserts an exact presence count). The Controls case
// binds a key, so it removes `mr.controls` and reloads in a finally: the page never leaves a custom
// table behind. No encounter, no battle, no fixed sleep: every wait polls a DOM or `__game()`
// predicate with a bound.
//
// LATE DEFERRED FOCUS. The last test proves the PRODUCT: the Controls frame's deferred initial
// focus on `#controls-rows` lands AFTER the cursor was walked and the first rect read was taken,
// and moves no box of the 640x240 frame. It parks the page's zero-delay timers until the first
// read is taken and then releases them, so the late focus is ordered by the test, not by timing,
// and it shows that a focus which does scroll is seen by the same read (else the no-move claim is
// vacuous).

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

    /** Opens Controls over the menu and returns as soon as the frame is visible (no settle). */
    const openControlsFrame = async (label: string): Promise<void> => {
      // Start, Down to Controls, A: the Controls frame above the menu (remap.spec). Controls is a
      // root entry of the menu (UIF15C.4), so there is no group and no Down-into-sub-list step.
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
    };

    const openControls = async (label: string): Promise<void> => {
      await openControlsFrame(label);
      // SETTLE. The overlay moves focus to its rows one macrotask AFTER it opens (the deferred,
      // scroll-free initial focus of ui/overlayA11y.ts). The open is over once the rows have the
      // focus (the pending timer is inert from then on), so every read below sees a settled open.
      // The rows do get it in this spec: every open here starts with focus outside the frame (on
      // the page body, or on the menu beneath, which is blurred as Controls opens over it). A
      // retried predicate with the expect timeout as its bound, not a sleep.
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

    test('UIF4B.2 the Controls frame: a deferred focus that lands on the rows after the cursor walk and the first read moves no box of the frame at 640x240', async () => {
      // The UNSETTLED ordering, on purpose: the frame opens, the cursor is walked to X_0 (its
      // nearest-scroll moves the 640x240 shell), `before` is read, and only then does the held
      // deferred focus land on the rows. That focus is scroll-free, so the shell keeps its
      // scrollTop and the tab strip and the rows grid keep their rects to the pixel. The
      // counter-proof at the end blurs the rows and focuses them with a plain `.focus()` in the
      // same state: that scrolling focus DOES move a box, so the equality is a real measurement,
      // not a frame that cannot move.
      // The hold is inside the PAGE: every zero-delay timer is parked (on the real timer, with
      // HOLD_FALLBACK_MS as a bound so nothing parks forever) until the test calls
      // `__mrReleaseHeld()` right after the first read, which re-arms each still-pending one at
      // zero delay. A parked timer the product clears (overlayA11y clears its pending focus when
      // another frame opens over its frame, on a re-open and on a close) is dropped from the park,
      // so the release never runs a cleared callback. The test itself never sleeps: every wait in
      // it is a retried predicate or two animation frames (requestAnimationFrame is not held).
      const HOLD_FALLBACK_MS = 20_000;
      const label = 'late focus';
      const BOXES = ['#controls-overlay', '#controls-tabs', '#controls-rows'] as const;
      interface FrameRead {
        rects: Rect[];
        scrollTop: number;
        rowsFocused: boolean;
        heldFocus: boolean;
      }
      /** Two animation frames, then the rects, the shell's scrollTop and the focus, in one pass. */
      const readFrame = (): Promise<FrameRead> =>
        page.evaluate(async (sels: readonly string[]): Promise<FrameRead> => {
          await new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          );
          const rects = sels.map((s) => {
            const el = document.querySelector(s);
            if (el === null) throw new Error(`late focus: ${s} is not on the page`);
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          });
          const overlay = document.getElementById('controls-overlay');
          const rows = document.getElementById('controls-rows');
          if (overlay === null || rows === null) {
            throw new Error('late focus: the shell or the rows are not on the page');
          }
          return {
            rects,
            scrollTop: overlay.scrollTop,
            rowsFocused: document.activeElement === rows,
            heldFocus: (window as unknown as { __mrHeldFocus?: boolean }).__mrHeldFocus === true,
          };
        }, BOXES);
      try {
        await setWindow({ width: 640, height: 240 });
        await closeAll(page);
        await page.evaluate((fallback) => {
          type Timer = (handler: unknown, delay?: number, ...args: unknown[]) => number;
          type Clear = (id?: number) => void;
          const w = window as unknown as {
            setTimeout: Timer;
            clearTimeout: Clear;
            __mrRealSetTimeout?: Timer;
            __mrRealClearTimeout?: Clear;
            __mrHeldFocus?: boolean;
            __mrReleaseHeld?: () => number;
          };
          const realSet = w.setTimeout;
          const realClear = w.clearTimeout;
          w.__mrRealSetTimeout = realSet;
          w.__mrRealClearTimeout = realClear;
          w.__mrHeldFocus = false;
          // Parked id -> its wrapped callback. The id returned to the page is the real timer's,
          // so a product clearTimeout reaches the real timer and leaves the park too.
          const parked = new Map<number, () => void>();
          let holding = true;
          w.setTimeout = (handler, delay, ...args) => {
            if (!holding || typeof handler !== 'function' || (delay !== undefined && delay !== 0)) {
              return realSet.call(window, handler, delay, ...args);
            }
            const fn = handler as (...a: unknown[]) => void;
            const held = (): void => {
              parked.delete(id);
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
            const id = realSet.call(window, held, fallback);
            parked.set(id, held);
            return id;
          };
          w.clearTimeout = (id) => {
            if (id !== undefined) parked.delete(id);
            realClear.call(window, id);
          };
          w.__mrReleaseHeld = () => {
            holding = false;
            const pending = [...parked.entries()];
            parked.clear();
            for (const [id, held] of pending) {
              realClear.call(window, id);
              realSet.call(window, held, 0);
            }
            return pending.length;
          };
        }, HOLD_FALLBACK_MS);

        // No settle: the walk and the first read run while the focus is parked.
        await openControlsFrame(label);
        await downTo(page, controlsActive, 'X_0', 13, `${label}: the Controls grid`);
        const before = await readFrame();
        expect(
          before.rowsFocused || before.heldFocus,
          'FIXTURE: the deferred focus landed before the first read, so this test no longer exercises the late-focus ordering',
        ).toBe(false);
        expect(
          before.scrollTop,
          'FIXTURE: the cursor walk scrolled the shell at 640x240 (else the frame has no scroll to keep)',
        ).toBeGreaterThan(0);

        const released = await page.evaluate(() =>
          (window as unknown as { __mrReleaseHeld: () => number }).__mrReleaseHeld(),
        );
        expect(released, 'FIXTURE: the overlay focus timer was parked').toBeGreaterThan(0);
        await expect(
          page.locator('#controls-rows'),
          `${label}: the rows receive the open initial focus`,
        ).toBeFocused();
        const after = await readFrame();
        expect(
          after.heldFocus,
          'FIXTURE: the parked overlay initial focus is what put the focus on the rows',
        ).toBe(true);
        expect(after.scrollTop, `${label}: the shell did not scroll when the focus landed`).toBe(
          before.scrollTop,
        );
        for (const [k, sel] of BOXES.entries()) {
          expect(
            after.rects[k],
            `${label}: ${sel} did not move when the deferred focus landed`,
          ).toEqual(before.rects[k]);
        }

        // COUNTER-PROOF: in this very state a focus that scrolls moves the frame's boxes, and the
        // same read sees it.
        await page.evaluate(() => {
          const rows = document.getElementById('controls-rows');
          if (rows === null) throw new Error('late focus: the rows are not on the page');
          rows.blur();
          rows.focus();
        });
        const scrolled = await readFrame();
        expect(scrolled.rowsFocused, 'FIXTURE: the plain focus is on the rows').toBe(true);
        expect(
          scrolled.scrollTop,
          'FIXTURE: a plain focus on the rows scrolls the shell (else the no-move claim above is vacuous)',
        ).not.toBe(after.scrollTop);
        expect(
          scrolled.rects,
          'FIXTURE: a scrolling focus on the rows moves a box of the frame',
        ).not.toEqual(after.rects);
      } finally {
        try {
          await page.evaluate(() => {
            const w = window as unknown as {
              setTimeout: unknown;
              clearTimeout: unknown;
              __mrRealSetTimeout?: unknown;
              __mrRealClearTimeout?: unknown;
              __mrReleaseHeld?: () => number;
            };
            w.__mrReleaseHeld?.();
            if (w.__mrRealSetTimeout !== undefined) w.setTimeout = w.__mrRealSetTimeout;
            if (w.__mrRealClearTimeout !== undefined) w.clearTimeout = w.__mrRealClearTimeout;
            w.__mrRealSetTimeout = undefined;
            w.__mrRealClearTimeout = undefined;
            w.__mrReleaseHeld = undefined;
          });
        } finally {
          await closeAll(page);
          await setWindow({ width: 1280, height: 720 });
        }
      }
    });
  });
