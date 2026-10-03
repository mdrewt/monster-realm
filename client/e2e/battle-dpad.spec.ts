import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { VButton } from '../src/input/buttons';
import type { Stack } from '../src/ui/contextStack';
import { t } from '../src/ui/i18n/resolver';
import { pressButton } from './controls';

// battle-dpad.spec.ts — the D-pad battle (ctl-8j, CTL8J.2 / CTL8J.3): a wild battle played with the
// virtual buttons only, to an outcome, then continued from the outcome with A (battle one) and with
// B (battle two); and Start pressed mid-turn, three frames deep, returning to the untouched battle.
//
// INPUT RULE. Every in-battle input goes through `pressButton` (the hunt, which walks the world,
// uses the `__game().step` hook exactly as encounter-battle.spec.ts does). No key name, no click.
//
// STATE-DRIVEN PRESSES. The battle view's cursor is a focus: with focus OFF a cursor row (the
// heading, <body>, the world canvas) the first D-pad press only seats the kept cursor and moves
// nothing, so a press count tells nothing. Every press here is followed by a poll of the focused
// row (its `data-battle-list`, testid, text and aria-current); the next press is chosen from what
// the page shows, never counted blind. The two waits that are not a row are the turn advancing
// (`turnNumber` up, or the battle gone) and the continue (a loop that presses only while the stack
// is above its base, because the first A inside the 400 ms grace of an outcome is ignored).
//
// SEEDING (owner SQL, the encounter-battle.spec precedent). The starter's defense, attack and HP
// columns are raised. Measured: with only defense raised the starter FAINTED in the first battle
// (current_hp 0), and an all-fainted party gets no encounter, so the second battle's hunt found
// nothing. With attack 250 each wild falls in a hit or two, and HP 999 keeps the starter up over
// both battles, so both reach an outcome by the D-pad (any terminal outcome is still accepted).
// Levels are NOT seeded: two wins cannot lift a Lv5 starter past zone 0's Lv3-8 encounter bands.
// Any species may be met (a Water wild resists Fire but MAX_ATTACKS covers it).
//
// THE START ROUND TRIP (CTL8J.3, DEFERRED to ctl-13). The criterion says Start, then A opens
// Monsters, then Start again. Over a battle the main menu keeps Monsters DISABLED (its screen is
// not battleSafe: SCREEN_POLICY.boxView, mainMenuScreen battleReason; residual
// R-ctl-6c-MONSTERSRO), so A on it opens nothing and the criterion cannot be met yet. The first
// case is therefore titled CTL8J-3x, not CTL8J-3: it is the same battle round trip through Options
// > How to play, the one entry that is enabled over a battle (E0 in encounter-battle.spec.ts walks
// the same route): a second frame above the menu and ONE Start back to the battle alone.
//
// CLEANUP. One browser, context and identity; afterAll closes the browser.

const SEED_STAT = 250;
const SEED_HP = 999;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls (recruit.spec MAX_WALK_STEPS). */
const MAX_WALK_STEPS = 120;
/** Attacks per battle; at >= 1 net damage per hit this covers a Lv<=8 wild's HP. */
const MAX_ATTACKS = 30;
/** Cursor moves one `moveCursorTo` may spend before failing naming the row it is stuck on. */
const MAX_CURSOR_MOVES = 8;
/** Menu moves one `menuTo` may spend. */
const MAX_MENU_MOVES = 8;
/** Presses `continueWith` may spend (the first A inside the outcome's 400 ms grace is ignored). */
const MAX_CONTINUE_PRESSES = 12;
const STEP_WAIT_MS = 8_000;

interface Tile {
  x: number;
  y: number;
}
interface OwnMonster {
  monsterId: string;
  speciesId: number;
  level: number;
}
interface OngoingBattle {
  battleId: string;
  outcome: string;
  turnNumber: number;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ongoingBattle: OngoingBattle | null;
}
type Win = Window & { __game: () => GameSnap & { step: (d: string) => void } };

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as Win).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ongoingBattle: g.ongoingBattle,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as Partial<Win>;
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

function sql(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  if (!/^[A-Za-z0-9_ *=]+$/.test(query)) {
    throw new Error(`${label}: refusing a non-literal-shaped sql statement: ${query}`);
  }
  try {
    return execSync(`spacetime sql -s ${server} ${db} "${query}"`, {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime sql failed (CLI/infra): ${(err as Error).message}`);
  }
}

/** Tile-aware (1,2)<->(2,2) grass shuttle (recruit.spec shuttleDir). */
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South';
  if (tile.x === 1 && tile.y === 2) return 'East';
  if (tile.x === 2 && tile.y === 2) return 'West';
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

/** One step; resolves when the auth tile moved or a battle appeared. */
async function stepOne(p: Page, dir: string, from: Tile): Promise<void> {
  await p.evaluate((d) => (window as unknown as Win).__game().step(d), dir);
  await p.waitForFunction(
    (f: Tile) => {
      const g = (window as unknown as Win).__game();
      if (g.ongoingBattle !== null) return true;
      return g.ownAuthTile !== null && (g.ownAuthTile.x !== f.x || g.ownAuthTile.y !== f.y);
    },
    from,
    { timeout: STEP_WAIT_MS },
  );
}

/** Walk the shuttle until a wild battle is ongoing (any species), and its command list is up. A
 *  battle already ongoing is returned as is, so a case can continue the one before it. */
async function huntEncounter(p: Page): Promise<void> {
  for (let i = 0; i < MAX_WALK_STEPS; i++) {
    const g = await snap(p);
    if (g.ongoingBattle !== null) break;
    if (g.ownAuthTile === null) throw new Error('hunt: own tile vanished');
    await stepOne(p, shuttleDir(g.ownAuthTile), g.ownAuthTile);
  }
  expect(
    (await snap(p)).ongoingBattle,
    `no wild encounter within ${MAX_WALK_STEPS} steps`,
  ).not.toBeNull();
  await expect(p.getByTestId('battle-commands')).toBeVisible({ timeout: 10_000 });
}

type StackWin = Window & { __game: () => { stack: Stack; navActive: string | null } };
const readStack = (p: Page): Promise<Stack> =>
  p.evaluate(() => (window as unknown as StackWin).__game().stack);
const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as StackWin).__game().navActive);

/** Whether keyboard focus sits inside the battle overlay root (the parent of its title). */
const focusInsideBattle = (p: Page): Promise<boolean> =>
  p.evaluate(() => {
    const root = document.querySelector('[data-testid="battle-title"]')?.parentElement ?? null;
    return root?.contains(document.activeElement) === true;
  });

/** Whether the battle overlay root is shown. */
const battleRootShown = (p: Page): Promise<boolean> =>
  p.evaluate(() => {
    const root = document.querySelector('[data-testid="battle-title"]')?.parentElement;
    return root !== null && root !== undefined && root.style.display !== 'none';
  });

/** How many elements of the battle root are `aria-current="true"`. */
const currentCount = (p: Page): Promise<number> =>
  p.evaluate(() => {
    const root = document.querySelector('[data-testid="battle-title"]')?.parentElement;
    return root?.querySelectorAll('[aria-current="true"]').length ?? 0;
  });

/** The focused element when it is a battle row: its list, testid, text and whether it is the cursor. */
interface Row {
  list: string | null;
  testid: string | null;
  text: string;
  current: boolean;
}
const focusedRow = (p: Page): Promise<Row> =>
  p.evaluate(() => {
    const none = { list: null, testid: null, text: '', current: false };
    const root = document.querySelector('[data-testid="battle-title"]')?.parentElement;
    const el = document.activeElement;
    if (!root || !el || !root.contains(el)) return none;
    const list = el.getAttribute('data-battle-list');
    if (list === null) return none;
    return {
      list,
      testid: el.getAttribute('data-testid'),
      text: el.textContent ?? '',
      current: el.getAttribute('aria-current') === 'true',
    };
  });

/** Wait until the focused row satisfies `want`; fail naming `label` and the row it is on. */
async function waitRow(p: Page, want: (r: Row) => boolean, label: string): Promise<Row> {
  await expect
    .poll(async () => want(await focusedRow(p)), { timeout: 5_000, message: label })
    .toBe(true);
  return focusedRow(p);
}

/** The focused row, seating the kept cursor first when focus is off every row. With focus off a
 *  row a D-pad press only seats the cursor (it never moves or presses), so one press is enough and
 *  its result is read, not assumed. */
async function seatCursor(p: Page): Promise<Row> {
  const row = await focusedRow(p);
  if (row.list !== null) return row;
  await pressButton(p, 'Up');
  return waitRow(p, (r) => r.list !== null, 'seatCursor: a press did not seat the cursor on a row');
}

/** Press `button` from wherever the cursor is, then wait for the focused row to satisfy `want`. */
async function pressUntil(
  p: Page,
  button: VButton,
  want: (r: Row) => boolean,
  label: string,
): Promise<Row> {
  await seatCursor(p);
  await pressButton(p, button);
  return waitRow(p, want, `${label} (after ${button})`);
}

/** Walk the cursor with `dir` until the focused row is `testid`, reading the row after each press. */
async function moveCursorTo(p: Page, testid: string, dir: VButton): Promise<void> {
  for (let moves = 0; moves < MAX_CURSOR_MOVES; moves++) {
    const row = await seatCursor(p);
    if (row.testid === testid) return;
    await pressButton(p, dir);
    await expect
      .poll(
        async () => {
          const next = await focusedRow(p);
          return next.testid !== row.testid || next.text !== row.text || next.list !== row.list;
        },
        {
          timeout: 3_000,
          message: `moveCursorTo(${testid}): ${dir} from ${row.testid ?? row.text} did not move the cursor`,
        },
      )
      .toBe(true);
  }
  throw new Error(`moveCursorTo(${testid}): not reached in ${MAX_CURSOR_MOVES} ${dir} presses`);
}

/** Walk the main menu with Up until `navActive` is `key`, reading it after each press. */
async function menuTo(p: Page, key: string): Promise<void> {
  for (let moves = 0; moves < MAX_MENU_MOVES; moves++) {
    const at = await navActive(p);
    if (at === key) return;
    await pressButton(p, 'Up');
    await expect
      .poll(() => navActive(p), { timeout: 3_000, message: `menuTo(${key}): Up from ${at}` })
      .not.toBe(at);
  }
  throw new Error(`menuTo(${key}): not reached in ${MAX_MENU_MOVES} presses`);
}

/** Fight the battle with the D-pad (Fight, A, A on the first-seated skill) until the battle is gone
 *  from `ongoingBattle`; each attack waits for the turn to advance or the battle to end. Returns the
 *  outcome text shown. */
async function fightToOutcome(p: Page): Promise<string> {
  for (let attack = 0; attack < MAX_ATTACKS; attack++) {
    const before = (await snap(p)).ongoingBattle;
    if (before === null) break;
    await moveCursorTo(p, 'battle-command-fight', 'Up');
    await pressUntil(
      p,
      'A',
      (r) => r.list === 'skills' && r.current,
      'A on Fight opens the skill grid with the cursor on a skill',
    );
    await pressButton(p, 'A'); // the skill
    await p.waitForFunction(
      (prev: number) => {
        const b = (window as unknown as Win).__game().ongoingBattle;
        return b === null || b.turnNumber > prev;
      },
      before.turnNumber,
      { timeout: 15_000 },
    );
  }
  expect(
    (await snap(p)).ongoingBattle,
    `the battle is still ongoing after ${MAX_ATTACKS} D-pad attacks`,
  ).toBeNull();
  const outcomes = [
    t('battle.outcome.victory'),
    t('battle.outcome.defeat'),
    t('battle.outcome.fled'),
  ];
  const outcomeText = p.getByTestId('outcome-text');
  await expect(outcomeText).toBeVisible({ timeout: 10_000 });
  const text = (await outcomeText.textContent()) ?? '';
  expect(outcomes, 'the battle ended in a terminal outcome').toContain(text);
  return text;
}

/** Press `button` only while the stack is above its base (never at the base), polling each press
 *  for the stack to shrink; the first A inside an outcome's 400 ms grace is ignored, so a press
 *  that changes nothing is repeated. Fails after MAX_CONTINUE_PRESSES. */
async function continueWith(p: Page, button: 'A' | 'B'): Promise<void> {
  for (let presses = 0; presses < MAX_CONTINUE_PRESSES; presses++) {
    const stack = await readStack(p);
    if (stack.length <= 1) return;
    await pressButton(p, button);
    await expect
      .poll(async () => (await readStack(p)).length, { timeout: 1_500 })
      .toBeLessThan(stack.length)
      .catch(() => undefined); // unchanged (grace, or the server still settling): press again
  }
  const stack = await readStack(p);
  if (stack.length > 1) {
    throw new Error(
      `continueWith(${button}): the stack is still ${JSON.stringify(stack)} after ${MAX_CONTINUE_PRESSES} presses`,
    );
  }
}

test.describe
  .serial('ctl-8j — the battle on the D-pad', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let firstBattleId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      const starter = (await snap(page)).ownMonsters[0];
      if (!starter || !/^[0-9]+$/.test(starter.monsterId)) {
        throw new Error('beforeAll: no starter with a decimal monsterId');
      }
      for (const [col, val] of [
        ['stat_defense', SEED_STAT],
        ['stat_sp_defense', SEED_STAT],
        ['stat_attack', SEED_STAT],
        ['stat_sp_attack', SEED_STAT],
        ['stat_hp', SEED_HP],
        ['current_hp', SEED_HP],
      ] as const) {
        sql(`UPDATE monster SET ${col} = ${val} WHERE monster_id = ${starter.monsterId}`, 'seed');
      }
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('CTL8J-3x-START-HELP-START: the battle round trip through Options > How to play (Monsters is not battle-safe yet, so CTL8J.3 is deferred to ctl-13): Start mid-turn opens the main menu over the battle, a second frame opens above it (three deep), and ONE Start returns to the battle alone, the stack exactly [battle], the command list visible with the cursor still on Recruit, focus inside the battle, the same battle and turn', async () => {
      // WRONG IMPL KILLED: a Start from depth three that pops only the top frame (the menu is left
      // standing over the battle); a Start that leaves the stack longer than [battle] or changes
      // its battle; a menu round trip that submits or skips a turn; a battle view that comes back
      // with the cursor reset to Fight (CTL8I.3: the cursor is where the player left it), without
      // its command list, or with two aria-current elements; and focus left in the closed menu.
      // See the header: Monsters is not battle-safe yet (CTL8J.3 deferred to ctl-13), so the
      // second frame is Options > How to play, the one entry enabled over a battle.
      test.setTimeout(120_000);
      await huntEncounter(page);
      const started = (await snap(page)).ongoingBattle;
      if (started === null) throw new Error('CTL8J-3: no ongoing battle after the hunt');
      const id = started.battleId;
      firstBattleId = id;
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: id }]);

      // The cursor goes to Recruit by the D-pad, read after every press.
      await moveCursorTo(page, 'battle-command-recruit', 'Down');
      await expect(page.getByTestId('battle-command-recruit')).toHaveAttribute(
        'aria-current',
        'true',
      );

      // Start: the menu over the battle, on its first entry.
      await pressButton(page, 'Start');
      await expect(page.locator('#menu-overlay')).toBeVisible({ timeout: 5_000 });
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([
          { kind: 'battle', battleId: id },
          { kind: 'screen', id: 'menuView', overBattle: id },
        ]);
      expect(await navActive(page), 'the menu opens on its first entry').toBe('monsters');

      // A second frame above the menu: Options, then How to play (the enabled entry over a battle).
      await menuTo(page, 'options');
      await pressButton(page, 'A');
      await expect.poll(() => navActive(page), { timeout: 5_000 }).toBe('help');
      await pressButton(page, 'A');
      await expect(page.locator('#help-overlay')).toBeVisible({ timeout: 5_000 });
      await expect.poll(async () => (await readStack(page)).length, { timeout: 5_000 }).toBe(3);

      // ONE Start: the battle alone.
      await pressButton(page, 'Start');
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: id }]);
      await expect(page.locator('#menu-overlay')).toBeHidden({ timeout: 5_000 });
      await expect(page.locator('#help-overlay')).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'the battle is on screen').toBe(true);
      await expect(page.getByTestId('battle-commands')).toBeVisible();
      await expect(
        page.getByTestId('battle-command-recruit'),
        'the cursor is still on Recruit',
      ).toHaveAttribute('aria-current', 'true');
      expect(await currentCount(page), 'and it is the only cursor').toBe(1);
      await expect.poll(() => focusInsideBattle(page), { timeout: 5_000 }).toBe(true);
      const after = (await snap(page)).ongoingBattle;
      expect(after?.battleId, 'the same battle').toBe(id);
      expect(after?.turnNumber, 'and nothing was submitted').toBe(started.turnNumber);
    });

    test('CTL8J-2-DPAD-BATTLE-A: the same battle on the D-pad alone: Recruit asks Yes / No (the cursor on Yes) and B backs out twice, Fight and A twice attack until an outcome, and A continues from the outcome to the world', async () => {
      // WRONG IMPL KILLED: a Recruit list or confirm the D-pad cannot enter or leave; a confirm
      // whose cursor starts on No; a B that closes the whole Recruit step or the battle; a skill
      // grid the cursor cannot reach or press with A; an outcome A does not continue from (or one
      // that continues inside the 400 ms grace and skips the result); and a continue that leaves a
      // frame, the battle UI or a battle stack above the world.
      test.setTimeout(180_000);
      await huntEncounter(page); // the battle CTL8J-3 left standing
      const started = (await snap(page)).ongoingBattle;
      if (started === null) throw new Error('CTL8J-2-A: no ongoing battle');
      expect(started.battleId, 'this is the battle CTL8J-3 used').toBe(firstBattleId);

      // Recruit -> A -> No bait -> A -> Yes (the cursor) -> B -> No bait -> B -> Recruit -> Up -> Fight.
      await moveCursorTo(page, 'battle-command-recruit', 'Down');
      await pressUntil(
        page,
        'A',
        (r) => r.list === 'recruit' && r.testid === 'bait-option-none' && r.current,
        'A on Recruit opens the bait list on No bait',
      );
      await pressUntil(
        page,
        'A',
        (r) =>
          r.list === 'recruitConfirm' &&
          r.testid === 'recruit-action' &&
          r.current &&
          r.text === t('battle.recruit.yes'),
        'A on No bait asks, with the cursor on Yes',
      );
      await expect(page.getByTestId('recruit-confirm')).toContainText(
        t('battle.recruit.confirmNoBait'),
      );
      await pressUntil(
        page,
        'B',
        (r) => r.list === 'recruit' && r.testid === 'bait-option-none' && r.current,
        'B backs out of the question to the No bait row',
      );
      await expect(page.getByTestId('recruit-confirm')).toBeHidden({ timeout: 5_000 });
      await pressUntil(
        page,
        'B',
        (r) => r.list === 'commands' && r.testid === 'battle-command-recruit' && r.current,
        'B backs out of the list to the Recruit command',
      );
      await pressUntil(
        page,
        'Up',
        (r) => r.list === 'commands' && r.testid === 'battle-command-fight' && r.current,
        'Up: Fight',
      );
      expect(
        (await snap(page)).ongoingBattle?.turnNumber,
        'asking and backing out spent no turn',
      ).toBe(started.turnNumber);

      // Fight and A, A, until an outcome.
      await fightToOutcome(page);

      // A continues (pressed only while the stack is above the world).
      await continueWith(page, 'A');
      await expect.poll(() => readStack(page), { timeout: 5_000 }).toEqual([{ kind: 'world' }]);
      await expect(page.getByTestId('outcome-text')).toBeHidden({ timeout: 5_000 });
      await expect(page.getByTestId('battle-commands')).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'the battle UI is gone').toBe(false);
      expect((await snap(page)).ongoingBattle).toBeNull();
    });

    test('CTL8J-2-DPAD-BATTLE-B: a second battle on the D-pad alone reaches an outcome, and B continues from it to the world', async () => {
      // WRONG IMPL KILLED: a second battle the D-pad cannot play (state left over from the first:
      // a pick, a cursor, a lock); an outcome B does not continue from; and a continue that leaves
      // the stack above the world.
      test.setTimeout(180_000);
      await huntEncounter(page);
      const started = (await snap(page)).ongoingBattle;
      if (started === null) throw new Error('CTL8J-2-B: no ongoing battle');
      expect(started.battleId, 'a second battle, not the first again').not.toBe(firstBattleId);
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: started.battleId }]);

      await fightToOutcome(page);

      await continueWith(page, 'B');
      await expect.poll(() => readStack(page), { timeout: 5_000 }).toEqual([{ kind: 'world' }]);
      await expect(page.getByTestId('outcome-text')).toBeHidden({ timeout: 5_000 });
      await expect(page.getByTestId('battle-commands')).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'the battle UI is gone').toBe(false);
      expect((await snap(page)).ongoingBattle).toBeNull();
    });
  });
