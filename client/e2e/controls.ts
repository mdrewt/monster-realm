// controls.ts — the e2e press helpers (ctl-6a). Specs press virtual buttons and accelerators
// through here, never raw key names, so a binding change lands in one place. Imports only
// pure modules, so it loads under Playwright without Vite.
import type { Page } from '@playwright/test';
import type { Accel, VButton } from '../src/input/buttons';

/** Start presses `closeAll` spends before it fails naming the stuck top frame (CTL6A.1). */
export const CLOSE_ALL_MAX_PRESSES = 5;

/** Presses the first key bound to `button` in `DEFAULT_BINDINGS`. */
export async function pressButton(_page: Page, _button: VButton): Promise<void> {
  throw new Error('ctl-6a: pressButton not implemented');
}

/** Presses the first key bound to the accelerator `accel` in `DEFAULT_BINDINGS`. */
export async function pressAccel(_page: Page, _accel: Accel): Promise<void> {
  throw new Error('ctl-6a: pressAccel not implemented');
}

/** Presses Start only while `__game().stack` is above its base; returns once it is at the base. */
export async function closeAll(_page: Page): Promise<void> {
  throw new Error('ctl-6a: closeAll not implemented');
}
