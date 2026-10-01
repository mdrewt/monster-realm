// controls.ts — the e2e press helpers (ctl-6a). Specs press virtual buttons and accelerators
// through here, never raw key names, so a binding change lands in one place. Imports only
// pure modules, so it loads under Playwright without Vite.
import { expect, type Page } from '@playwright/test';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import type { Accel, VButton } from '../src/input/buttons';
import type { Frame, Stack } from '../src/ui/contextStack';

/** Start presses `closeAll` spends before it fails naming the stuck top frame (CTL6A.1). */
export const CLOSE_ALL_MAX_PRESSES = 5;
/** How long one Start press may take to change the stack (a dialogue close is a server round
 *  trip) before `closeAll` presses again. */
const CLOSE_ALL_SETTLE_MS = 4_000;

/** Presses the first key bound to `button` in `DEFAULT_BINDINGS`. */
export async function pressButton(page: Page, button: VButton): Promise<void> {
  await page.keyboard.press(DEFAULT_BINDINGS.buttons[button][0]);
}

/** Presses the first key bound to the accelerator `accel` in `DEFAULT_BINDINGS`. */
export async function pressAccel(page: Page, accel: Accel): Promise<void> {
  await page.keyboard.press(DEFAULT_BINDINGS.accels[accel][0]);
}

/** `closeAll` gave up: Start did not bring the stack back to its base (CTL6A.1). */
export class StuckStackError extends Error {}

const readStack = (page: Page): Promise<Stack> =>
  page.evaluate(() => {
    const game = (window as unknown as { __game?: () => { stack: Stack } }).__game;
    if (game === undefined) throw new Error('closeAll: window.__game is missing (DEV build only)');
    return game().stack;
  });

const frameName = (f: Frame): string => {
  switch (f.kind) {
    case 'world':
      return 'world';
    case 'battle':
      return `battle:${f.battleId}`;
    case 'screen':
    case 'prompt':
      return `${f.kind}:${f.id}`;
    case 'textEntry':
      return `textEntry:${f.owner}`;
  }
};

/** Presses Start only while `__game().stack` is above its base; returns once it is at the base.
 *  Fails naming the stuck top frame after `CLOSE_ALL_MAX_PRESSES` presses (CTL6A.1). Never
 *  presses at a base, so it is safe both before and after Escape becomes Start (ctl-6b). */
export async function closeAll(page: Page): Promise<void> {
  const start = DEFAULT_BINDINGS.buttons.Start[0];
  for (let presses = 0; ; presses++) {
    const before = await readStack(page);
    if (before.length <= 1) return;
    if (presses === CLOSE_ALL_MAX_PRESSES) {
      const top = before[before.length - 1];
      throw new StuckStackError(
        `closeAll: stuck top frame ${frameName(top)} after ${presses} Start (${start}) presses ` +
          `(stack length ${before.length})`,
      );
    }
    await page.keyboard.press(start);
    const was = JSON.stringify(before);
    await expect
      .poll(async () => JSON.stringify(await readStack(page)), { timeout: CLOSE_ALL_SETTLE_MS })
      .not.toBe(was)
      .catch(() => undefined); // unchanged: press again, up to the bound
  }
}
