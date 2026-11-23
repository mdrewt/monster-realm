// pad.ts — the mocked Gamepad API for the e2e specs. `installFakePad` adds an init script that
// puts ONE standard-mapping pad in the page before any game script runs: `window.__mrFakePad`,
// answered by an own `navigator.getGamepads` as `[pad, null, null, null]`, the SAME object on every
// call, mutated in place (as a browser may reuse one snapshot), so the game's pad source must copy
// what it reads. `padPress` / `padHold` set a button down, let the game's frame loop poll it, and
// set it up again.
//
// Each wait is two animation frames in the page, so the game's own rAF callback has run at least
// once after the change. Foreground pages only: a background page's rAF is throttled, and a press
// there would not be polled within the wait.
//
// Imports only Playwright types, so it loads under Playwright without Vite.
import type { BrowserContext, Page } from '@playwright/test';

/** The standard mapping's button count: 0 to 15, and 16 (Home / Guide). */
const FAKE_PAD_BUTTONS = 17;

interface FakePadButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}
interface FakePad {
  index: number;
  id: string;
  connected: boolean;
  mapping: string;
  timestamp: number;
  buttons: FakePadButton[];
  axes: number[];
}
type FakePadWindow = Window & { __mrFakePad?: FakePad };

/** The init script: one fake pad in `window.__mrFakePad`, and `navigator.getGamepads` over it. */
const fakePadScript = (buttons: number): void => {
  const pad = {
    index: 0,
    id: 'mr-fake-pad (STANDARD GAMEPAD)',
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    buttons: Array.from({ length: buttons }, () => ({ pressed: false, touched: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
  (window as unknown as FakePadWindow).__mrFakePad = pad;
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => [pad, null, null, null],
  });
};

/** Install the fake pad on every page of `target` (a context) or on `target` itself (a page),
 *  for each document loaded after the call: call it before the first `goto`. */
export async function installFakePad(target: Page | BrowserContext): Promise<void> {
  // The two branches are the same call: TypeScript cannot call the generic `addInitScript` on the
  // `Page | BrowserContext` union, so each member type gets its own call site.
  if ('newPage' in target) await target.addInitScript(fakePadScript, FAKE_PAD_BUTTONS);
  else await target.addInitScript(fakePadScript, FAKE_PAD_BUTTONS);
}

/** Wait two animation frames in the page. */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

/** Set the fake pad's button `index` pressed (value 1) or released (value 0). */
async function setButton(page: Page, index: number, pressed: boolean): Promise<void> {
  await page.evaluate(
    (a: { index: number; pressed: boolean }) => {
      const pad = (window as unknown as FakePadWindow).__mrFakePad;
      if (pad === undefined) {
        throw new Error('pad.ts: window.__mrFakePad is missing (call installFakePad before goto)');
      }
      const button = pad.buttons[a.index];
      if (button === undefined) throw new Error(`pad.ts: the fake pad has no button ${a.index}`);
      button.pressed = a.pressed;
      button.touched = a.pressed;
      button.value = a.pressed ? 1 : 0;
      pad.timestamp += 1;
    },
    { index, pressed },
  );
}

/** One press of the fake pad's button `index`: down, two frames, up, two frames. */
export async function padPress(page: Page, index: number): Promise<void> {
  await setButton(page, index, true);
  await twoFrames(page);
  await setButton(page, index, false);
  await twoFrames(page);
}

/** The fake pad's button `index` held for `ms` after the frames that poll its press, then released. */
export async function padHold(page: Page, index: number, ms: number): Promise<void> {
  await setButton(page, index, true);
  await twoFrames(page);
  await page.waitForTimeout(ms);
  await setButton(page, index, false);
  await twoFrames(page);
}
