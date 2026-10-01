// controls.spec.ts — gating tests for the e2e press helpers (ctl-6a). A fake in-page
// `window.__game` whose stack the test controls stands in for the game: no server, no Vite.
import { expect, type Page, test } from '@playwright/test';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import type { FrameId, Stack, UpperFrame } from '../src/ui/contextStack';
import { CLOSE_ALL_MAX_PRESSES, closeAll, pressAccel, pressButton } from './controls';

// Every fake stack is typed as the real `Stack`, so a frame-shape drift fails client typecheck.
interface FakeWin {
  __stack: Array<Stack[number]>;
  __keys: string[];
  __game: () => { stack: Array<Stack[number]> };
}

const WORLD = { kind: 'world' } as const;
const screen = (id: FrameId): UpperFrame => ({ kind: 'screen', id });

/** A `pops` entry meaning "this Escape clears every upper frame at once". */
const POP_ALL = -1;

/** Installs the fake game. The nth Escape pops the top frame after `pops[n]` ms (0 = at once,
 *  `POP_ALL` = clears to the base at once); an Escape past the end of `pops` (or any Escape
 *  when `pops` is empty) does nothing. */
async function installFake(page: Page, stack: Stack, pops: number[]): Promise<void> {
  await page.setContent('<html><body></body></html>');
  await page.evaluate(
    ({ stack, pops }) => {
      const w = window as unknown as FakeWin;
      w.__stack = [...stack];
      w.__keys = [];
      w.__game = () => ({ stack: w.__stack });
      let escapes = 0;
      window.addEventListener('keydown', (e) => {
        w.__keys.push(e.code);
        if (e.code !== 'Escape') return;
        const delay = pops[escapes++];
        if (delay === undefined) return;
        if (delay < 0) w.__stack.length = 1;
        else if (delay === 0) w.__stack.pop();
        else setTimeout(() => w.__stack.pop(), delay);
      });
    },
    { stack, pops },
  );
}

const keysSeen = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as FakeWin).__keys);
const stackLength = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as FakeWin).__game().stack.length);

test.describe('ctl-6a controls.ts', () => {
  test('CTL6A.1 stuck prompt frame over a battle base', async ({ page }) => {
    test.setTimeout(60_000);
    await installFake(
      page,
      [
        { kind: 'battle', battleId: '7' },
        { kind: 'prompt', id: 'helpView' },
      ],
      [],
    );
    const failure = await closeAll(page).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(failure, 'closeAll must reject on a stuck stack').not.toBeNull();
    expect(failure).toContain('helpView');
    const keys = await keysSeen(page);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.length).toBeLessThanOrEqual(CLOSE_ALL_MAX_PRESSES);
    expect(keys).toEqual(Array.from({ length: CLOSE_ALL_MAX_PRESSES }, () => 'Escape'));
  });

  test('CTL6A.1 stuck textEntry frame', async ({ page }) => {
    test.setTimeout(60_000);
    await installFake(
      page,
      [WORLD, screen('menuView'), { kind: 'textEntry', owner: 'renameView' }],
      [],
    );
    const failure = await closeAll(page).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(failure, 'closeAll must reject on a stuck stack').not.toBeNull();
    expect(failure).toContain('renameView');
    expect(failure, 'the message names the stuck TOP frame only').not.toContain('menuView');
    expect((await keysSeen(page)).length).toBe(CLOSE_ALL_MAX_PRESSES);
  });

  test('ctl-6a closeAll pops to base', async ({ page }) => {
    test.setTimeout(30_000);
    await installFake(page, [WORLD, screen('menuView'), screen('helpView')], [0, 2_500]);
    const started = Date.now();
    await closeAll(page);
    // It waits for the stack to change, not a fixed sleep: any fixed sleep >= 2.5 s costs >= 5 s
    // over two presses, and a shorter one presses again before the late pop lands.
    expect(Date.now() - started).toBeLessThan(4_500);
    await page.waitForTimeout(150); // a late over-press would land here
    expect(await stackLength(page)).toBe(1);
    expect(await keysSeen(page)).toEqual(['Escape', 'Escape']);
  });

  test('ctl-6a closeAll re-reads the stack after each press', async ({ page }) => {
    await installFake(page, [WORLD, screen('menuView'), screen('helpView')], [POP_ALL]);
    await closeAll(page);
    await page.waitForTimeout(150); // a blind second press would land here
    expect(await stackLength(page)).toBe(1);
    expect(await keysSeen(page)).toEqual(['Escape']);
  });

  test('ctl-6a closeAll fails loudly without __game', async ({ page }) => {
    await page.setContent('<html><body></body></html>');
    const failure = await closeAll(page).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(failure, 'closeAll must reject when there is no __game').not.toBeNull();
    expect(failure).toContain('__game');
  });

  test('ctl-6a closeAll at base presses nothing', async ({ page }) => {
    await installFake(page, [WORLD], [0, 0, 0]);
    await closeAll(page);
    await page.waitForTimeout(100);
    expect(await keysSeen(page)).toEqual([]);

    await installFake(page, [{ kind: 'battle', battleId: '7' }], [0, 0, 0]);
    await closeAll(page);
    await page.waitForTimeout(100);
    expect(await keysSeen(page)).toEqual([]);
    expect(await stackLength(page)).toBe(1);
  });

  test('ctl-6a pressButton/pressAccel press the first bound key', async ({ page }) => {
    await installFake(page, [WORLD], []);
    await pressButton(page, 'Start');
    await pressButton(page, 'A');
    await pressButton(page, 'B');
    await pressAccel(page, 'J');
    await pressAccel(page, 'B');
    expect(await keysSeen(page)).toEqual(['Escape', 'Enter', 'Backspace', 'KeyJ', 'KeyB']);

    // The table itself is the SSOT: the first bound key, whatever the table says.
    await page.evaluate(() => {
      (window as unknown as FakeWin).__keys.length = 0;
    });
    await pressButton(page, 'Start');
    await pressButton(page, 'A');
    await pressButton(page, 'B');
    await pressAccel(page, 'J');
    await pressAccel(page, 'B');
    expect(await keysSeen(page)).toEqual([
      DEFAULT_BINDINGS.buttons.Start[0],
      DEFAULT_BINDINGS.buttons.A[0],
      DEFAULT_BINDINGS.buttons.B[0],
      DEFAULT_BINDINGS.accels.J[0],
      DEFAULT_BINDINGS.accels.B[0],
    ]);
  });
});
