// controls.spec.ts — gating tests for the e2e press helpers (ctl-6a). A fake in-page
// `window.__game` whose stack the test controls stands in for the game: no server, no Vite.
import { expect, type Page, test } from '@playwright/test';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import type { FrameId, Stack, UpperFrame } from '../src/ui/contextStack';
import {
  CLOSE_ALL_MAX_PRESSES,
  closeAll,
  fightToRecruit,
  pressAccel,
  pressButton,
  type RecruitTally,
  type TacticsSnap,
} from './controls';

// Every fake stack is typed as the real `Stack`, so a frame-shape drift fails client typecheck.
interface FakeWin {
  __stack: Array<Stack[number]>;
  __keys: string[];
  __game: () => { stack: Array<Stack[number]> };
}

const WORLD = { kind: 'world' } as const;
const screen = (id: FrameId): UpperFrame => ({ kind: 'screen', id });

/** Settle wait for the stuck-stack tests: their fake never changes the stack, so every press
 *  waits this out in full. The other tests keep `closeAll`'s default. */
const STUCK_SETTLE_MS = 300;

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
    const failure = await closeAll(page, STUCK_SETTLE_MS).then(
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
    // uif-16b (named intentional change): the text-entry owner renameView -> profileView: the name
    // field is a section of the one Profile frame, which owns its typing frame.
    await installFake(
      page,
      [WORLD, screen('menuView'), { kind: 'textEntry', owner: 'profileView' }],
      [],
    );
    const failure = await closeAll(page, STUCK_SETTLE_MS).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(failure, 'closeAll must reject on a stuck stack').not.toBeNull();
    // uif-16b (named intentional change): renameView -> profileView, the owner above.
    expect(failure).toContain('profileView');
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

// A fake tactical shell for `fightToRecruit`: one own unit beside a weak wild, a menu, a bait list
// and a forecast, all driven by the real bound keys. The Recruit pressed on the one allowed own
// turn resolves LATE (an in-page timer after the final A press), the way a server commit lands.
type LateOutcome = 'recruited' | 'failed' | 'ko';

interface FakeShellWin {
  __snap: TacticsSnap;
  __commits: number;
  __menuOpens: number;
  __resolved: boolean;
}

/** How long after the final A press the fake's commit resolves. */
const LATE_RESOLVE_MS = 400;
const WILD_HP = 10;
const WILD_MAX_HP = 40;
const WILD_PCT = 25;

const startSnap = (): TacticsSnap => ({
  battleId: '7',
  phase: 'Active',
  round: 1,
  turnIdx: 0,
  initiative: [1, 2],
  activeUnitId: 1,
  turnState: 'Waiting',
  owner: 'tactical',
  events: 0,
  deadlineMs: null,
  kind: 'Wild',
  format: 1,
  strikes: { A: 0, B: 0 },
  units: [
    { unitId: 1, side: 'A', mine: true, x: 1, y: 1, curHp: 50, maxHp: 50, state: 'Active' },
    {
      unitId: 2,
      side: 'B',
      mine: false,
      x: 2,
      y: 1,
      curHp: WILD_HP,
      maxHp: WILD_MAX_HP,
      state: 'Active',
    },
  ],
});

async function installTacticalShell(page: Page, late: LateOutcome): Promise<void> {
  await page.setContent('<html><body><div id="shell"></div></body></html>');
  await page.evaluate(
    ({ snap, late, delay, aKeys, downKeys }) => {
      const w = window as unknown as FakeShellWin & {
        __mrTactics: { battle: () => TacticsSnap };
        __game: () => { ongoingBattle: { battleId: string }; stack: unknown[] };
      };
      w.__snap = snap;
      w.__commits = 0;
      w.__menuOpens = 0;
      w.__resolved = false;
      w.__mrTactics = { battle: () => w.__snap };
      w.__game = () => ({
        ongoingBattle: { battleId: '7' },
        stack: [{ kind: 'battle', battleId: '7' }],
      });
      const shell = document.getElementById('shell') as HTMLElement;
      let stage: 'idle' | 'root' | 'bait' | 'aim' | 'done' = 'idle';
      let rows: { key: string; disabled: boolean }[] = [];
      let at = 0;
      const render = (): void => {
        const menu = rows
          .map(
            (r, i) =>
              `<div class="tactics-menu-row" data-row="${r.key}" aria-selected="${i === at}"${
                r.disabled ? ' aria-disabled="true"' : ''
              }></div>`,
          )
          .join('');
        shell.innerHTML =
          '<div class="tactics-tile--cursor" data-x="1" data-y="1"></div>' +
          (rows.length > 0 ? `<div class="tactics-menu">${menu}</div>` : '') +
          (stage === 'aim' ? '<div class="tactics-forecast">Recruit odds 55 %</div>' : '');
      };
      const resolve = (): void => {
        const wild = w.__snap.units[1];
        if (wild === undefined) throw new Error('fake: no wild');
        if (late === 'failed') {
          w.__snap = { ...w.__snap, round: 2, turnIdx: 0, turnState: 'Waiting' };
        } else {
          wild.state = late === 'recruited' ? 'Recruited' : 'Fainted';
          w.__snap = { ...w.__snap, phase: 'Finished', turnState: 'Done' };
        }
        w.__resolved = true;
      };
      render();
      window.addEventListener('keydown', (e) => {
        if (downKeys.includes(e.code) && rows.length > 0) {
          at = (at + 1) % rows.length;
        } else if (aKeys.includes(e.code)) {
          if (stage === 'idle') {
            stage = 'root';
            rows = [
              { key: 'recruit', disabled: false },
              { key: 'skills', disabled: true },
            ];
            at = 0;
            w.__menuOpens += 1;
          } else if (stage === 'root' && rows[at]?.key === 'recruit') {
            stage = 'bait';
            rows = [
              { key: 'bait:none', disabled: false },
              { key: 'bait:1', disabled: false },
            ];
            at = 0;
          } else if (stage === 'bait') {
            stage = 'aim';
            rows = [];
          } else if (stage === 'aim') {
            stage = 'done';
            w.__commits += 1;
            w.__snap = { ...w.__snap, turnState: 'Resolving' };
            setTimeout(resolve, delay);
          }
        }
        render();
      });
    },
    {
      snap: startSnap(),
      late,
      delay: LATE_RESOLVE_MS,
      aKeys: [...DEFAULT_BINDINGS.buttons.A],
      downKeys: [...DEFAULT_BINDINGS.buttons.Down],
    },
  );
}

async function fightOneOwnTurn(page: Page, late: LateOutcome) {
  await installTacticalShell(page, late);
  const tally: RecruitTally = { clicks: 0, hpPcts: [], forecastAttacks: 0 };
  const answer = await fightToRecruit(page, { maxOwnTurns: 1, baitKey: 'bait:1' }, tally);
  const seen = await page.evaluate(() => {
    const w = window as unknown as FakeShellWin;
    return { commits: w.__commits, menuOpens: w.__menuOpens, resolved: w.__resolved };
  });
  return { answer, tally, seen };
}

test.describe('rb-139 fightToRecruit', () => {
  test('a Recruit pressed on the last allowed own turn that succeeds answers recruited (rb-139.1)', async ({
    page,
  }) => {
    const { answer, tally, seen } = await fightOneOwnTurn(page, 'recruited');
    expect(answer, 'the loop waits for the last Recruit to resolve, then reports it').toBe(
      'recruited',
    );
    expect(seen.resolved, 'the answer came after the commit resolved').toBe(true);
    expect(seen.commits, 'exactly one Recruit was committed').toBe(1);
    expect(tally.clicks).toBe(1);
    expect(tally.hpPcts).toEqual([WILD_PCT]);
    expect(tally.forecastAttacks).toBe(0);
  });

  test('a late failed Recruit with the battle still active answers stalled and acts on no further turn (rb-139.2)', async ({
    page,
  }) => {
    const { answer, tally, seen } = await fightOneOwnTurn(page, 'failed');
    expect(seen.resolved, 'the answer came after the commit resolved').toBe(true);
    expect(answer, 'the battle is still active on a fresh own turn').toBe('stalled');
    expect(seen.commits, 'the bound holds: no second commit').toBe(1);
    expect(seen.menuOpens, 'the bound holds: the next own turn is not opened').toBe(1);
    expect(tally.clicks).toBe(1);
    expect(tally.hpPcts).toEqual([WILD_PCT]);
  });

  test('a Recruit followed by a finish with no recruit answers ended (rb-139.2 ended)', async ({
    page,
  }) => {
    const { answer, tally, seen } = await fightOneOwnTurn(page, 'ko');
    expect(seen.resolved, 'the answer came after the commit resolved').toBe(true);
    expect(answer).toBe('ended');
    expect(seen.commits).toBe(1);
    expect(tally.clicks).toBe(1);
  });
});
