import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { Stack } from '../src/ui/contextStack';
import { t } from '../src/ui/i18n/resolver';
import {
  awaitTacticalActive,
  draftMoveToward,
  endTurn,
  fightToOutcome,
  menuCursorTo,
  NO_BAIT_ROW,
  openMenu,
  pressAccel,
  pressButton,
  readTactics,
  sides,
  TACTICS,
  type TacticsSnap,
  tileDistance,
  turnKey,
  waitOwnTurnOrEnd,
} from './controls';

// battle-dpad.spec.ts — the D-pad battle (ctl-8j, CTL8J.2 / CTL8J.3): a wild battle played with the
// virtual buttons only, to an outcome, then continued from the outcome with A (battle one) and with
// B (battle two); and the main menu opened mid-turn, three frames deep, returning to the untouched
// battle with ONE Start.
//
// bt-16 (BT16.2) — NAMED INTENTIONAL CHANGE: the grass opens a TACTICAL wild battle; the 1v1 command
// list (Fight / Recruit / Run), its skill grid, the bait list's Yes / No confirm and `outcome-text`
// never appear for a live battle. SURVIVING CHECKS, each named at its test:
//   - CTL8J-3x: the tactical shell is the battle root; Start at the shell is End Turn (bt-11,
//     BT11.6), so the main menu is opened mid-turn by the Monsters ACCELERATOR (CTL11A.1; Monsters is
//     not battle-safe, so the menu stays the top frame); Options > How to play opens the third
//     frame; ONE Start returns to the shell alone — the stack exactly [battle], `.tactics-battle`
//     visible, the same battle / round / turnIdx / events (nothing submitted), focus inside the shell.
//   - CTL8J-2-A: on an own turn ADJACENT to the wild, Recruit opens its bait list; B backs out to
//     the root menu and B closes the menu (the tactical equivalent of Yes / No + B×2), spending
//     nothing; `fightToOutcome` by buttons; the results panel, A continues (or the auto-advance) to
//     the world; `ongoingBattle` null.
//   - CTL8J-2-B: a second hunt to an outcome; B continues to the world.
//
// INPUT RULE. Every in-battle input goes through `pressButton` / `pressAccel` (the hunt, which walks
// the world, uses the `__game().step` hook exactly as encounter-battle.spec.ts does). No key name, no
// click. Every wait is bounded and named.
//
// SEEDING (owner SQL, the encounter-battle.spec precedent). The starter's defense, attack and HP
// columns are raised: with attack 250 each wild falls in a hit, and HP 999 keeps the starter up over
// every battle, so each reaches an outcome by the buttons (any terminal outcome is accepted here:
// this spec is about the D-pad, encounter-battle E2 owns the win). Levels are NOT seeded: two wins
// cannot lift a Lv5 starter past zone 0's Lv3-8 encounter bands.
//
// CLEANUP. One browser, context and identity; afterAll closes the browser.

const SEED_STAT = 250;
const SEED_HP = 999;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls (recruit.spec MAX_WALK_STEPS). */
const MAX_WALK_STEPS = 120;
/** Own turns a battle may take to an outcome (a hit KOs; the rest is closing in). */
const MAX_OWN_TURNS = 16;
/** Own turns CTL8J-2-A may spend closing in until the wild stands adjacent on a fresh turn. */
const MAX_APPROACH_TURNS = 12;
/** Menu moves one `menuTo` may spend. */
const MAX_MENU_MOVES = 8;
/** Presses `continueWith` may spend (the first A inside the outcome's 400 ms grace is ignored). */
const MAX_CONTINUE_PRESSES = 12;
const STEP_WAIT_MS = 8_000;
/** One wait for the next own live turn in a wild battle. */
const TURN_WAIT_MS = 15_000;

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

/** Walk the shuttle until a wild battle is ongoing (any species), then wait for its tactical row
 *  Active and the shell on screen. A battle already ongoing is returned as is, so a case can
 *  continue the one before it. */
async function huntEncounter(p: Page, label: string): Promise<TacticsSnap> {
  for (let i = 0; i < MAX_WALK_STEPS; i++) {
    const g = await snap(p);
    if (g.ongoingBattle !== null) break;
    if (g.ownAuthTile === null) throw new Error('hunt: own tile vanished');
    await stepOne(p, shuttleDir(g.ownAuthTile), g.ownAuthTile).catch(() => undefined);
  }
  expect(
    (await snap(p)).ongoingBattle,
    `no wild encounter within ${MAX_WALK_STEPS} steps`,
  ).not.toBeNull();
  const active = await awaitTacticalActive(p, label);
  expect(active.phase, `${label}: an Active tactical battle`).toBe('Active');
  await expect(p.locator(TACTICS.shell), `${label}: the tactical shell is on screen`).toBeVisible({
    timeout: 10_000,
  });
  return active;
}

type StackWin = Window & { __game: () => { stack: Stack; navActive: string | null } };
const readStack = (p: Page): Promise<Stack> =>
  p.evaluate(() => (window as unknown as StackWin).__game().stack);
const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as StackWin).__game().navActive);

/** Whether keyboard focus sits inside the tactical shell (the battle root since bt-16). */
const focusInsideBattle = (p: Page): Promise<boolean> =>
  p.evaluate((sel) => {
    const root = document.querySelector(sel);
    return root?.contains(document.activeElement) === true;
  }, TACTICS.shell);

/** Whether the battle root (the tactical shell) is shown. */
const battleRootShown = (p: Page): Promise<boolean> =>
  p.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    return root !== null && root.style.display !== 'none';
  }, TACTICS.shell);

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

/** The results panel is shown with a terminal outcome title (victory, defeat or fled). */
async function expectTerminalResults(p: Page, label: string): Promise<string> {
  const title = p.locator(`${TACTICS.results} [data-testid="battle-title"]`);
  await expect(title, `${label}: the results panel shows`).toBeVisible({ timeout: 20_000 });
  const text = ((await title.textContent()) ?? '').trim();
  expect(
    [t('battle.outcome.victory'), t('battle.outcome.defeat'), t('battle.outcome.fled')],
    `${label}: the battle ended in a terminal outcome`,
  ).toContain(text);
  return text;
}

/** Press `button` only while the stack is above its base (never at the base), polling each press
 *  for the stack to shrink; the first A inside an outcome's 400 ms grace is ignored, so a press
 *  that changes nothing is repeated. The results panel may also auto-advance on its own (main.ts),
 *  which this accepts. Fails after MAX_CONTINUE_PRESSES. */
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
      for (const table of ['monster', 'monster_pub']) {
        for (const [col, val] of [
          ['stat_defense', SEED_STAT],
          ['stat_sp_defense', SEED_STAT],
          ['stat_attack', SEED_STAT],
          ['stat_sp_attack', SEED_STAT],
          ['stat_hp', SEED_HP],
          ['current_hp', SEED_HP],
        ] as const) {
          sql(
            `UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${starter.monsterId}`,
            'seed',
          );
        }
      }
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('CTL8J-3x-START-HELP-START: the battle round trip through Options > How to play (Monsters is not battle-safe, so CTL8J.3 is deferred): the main menu opened mid-turn over the tactical shell, a second frame above it (three deep), and ONE Start returns to the shell alone, the stack exactly [battle], the shell visible, focus inside it, the same battle, round, turn and event count (bt-16: the menu opens by its accelerator; was the 1v1 command list with the cursor on Recruit)', async () => {
      // WRONG IMPL KILLED: a Start from depth three that pops only the top frame (the menu is left
      // standing over the battle); a Start that leaves the stack longer than [battle] or changes
      // its battle; a menu round trip that submits or skips a turn (round / turnIdx / events
      // move); a shell that does not come back shown; and focus left in the closed menu.
      // SURVIVING CHECK (bt-16): retired "Start opens the menu; the command list comes back with
      // the cursor still on Recruit" → the Monsters accelerator opens the menu (Start is the
      // shell's End Turn, BT11.6); the shell comes back with the battle, round, turn and events
      // untouched.
      test.setTimeout(120_000);
      const started = await huntEncounter(page, 'CTL8J-3x');
      const id = started.battleId;
      firstBattleId = id;
      // Mid-turn: an own live turn (a 300 s PvE window: nothing advances while the menu is up).
      const own = await waitOwnTurnOrEnd(page, null, TURN_WAIT_MS);
      expect(own.phase, 'CTL8J-3x: an own live turn').toBe('Active');
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: id }]);

      // The menu over the battle, on its Monsters entry (not battle-safe: nothing opens above it).
      await pressAccel(page, 'B');
      await expect(page.locator('#menu-overlay')).toBeVisible({ timeout: 5_000 });
      if ((await readStack(page)).length > 2) await pressButton(page, 'B');
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([
          { kind: 'battle', battleId: id },
          { kind: 'screen', id: 'menuView', overBattle: id },
        ]);

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
      expect(await battleRootShown(page), 'the battle shell is on screen').toBe(true);
      await expect(page.locator(TACTICS.shell)).toBeVisible();
      await expect.poll(() => focusInsideBattle(page), { timeout: 5_000 }).toBe(true);
      const after = await readTactics(page);
      expect(
        after === null
          ? null
          : [after.battleId, after.phase, after.round, after.turnIdx, after.events],
        'the same battle, and nothing was submitted (round, turn and event count unchanged)',
      ).toEqual([id, 'Active', own.round, own.turnIdx, own.events]);
    });

    test('CTL8J-2-DPAD-BATTLE-A: the same battle on the buttons alone: adjacent, Recruit opens its bait list, B backs out to the menu and B closes it spending nothing; the buttons fight to an outcome and A continues from the results to the world (bt-16: was Recruit Yes / No + B×2, Fight + A)', async () => {
      // WRONG IMPL KILLED: a Recruit list the buttons cannot enter or leave; a B that closes the
      // whole menu from the bait list or ends the battle; a back-out that spends the turn (round,
      // turnIdx, events move); an outcome A does not continue from; and a continue that leaves a
      // frame, the battle UI or a battle stack above the world.
      // SURVIVING CHECK (bt-16): retired "Recruit → No bait → Yes/No (cursor on Yes) → B → B →
      // Fight" → on an own turn ADJACENT to the wild: Recruit → the bait list (`bait:none` first)
      // → B (back to the root menu) → B (the menu closes) — nothing spent — then `fightToOutcome`.
      test.setTimeout(240_000);
      const started = await huntEncounter(page, 'CTL8J-2-A'); // the battle CTL8J-3 left standing
      expect(started.battleId, 'this is the battle CTL8J-3 used').toBe(firstBattleId);

      // Close in until the wild stands adjacent on a FRESH own turn (Recruit needs the whole budget).
      let last: string | null = null;
      let adjacent: TacticsSnap | null = null;
      for (let turn = 0; turn < MAX_APPROACH_TURNS && adjacent === null; turn += 1) {
        const tt = await waitOwnTurnOrEnd(page, last, TURN_WAIT_MS);
        if (tt.phase !== 'Active') break;
        last = turnKey(tt);
        const { me, enemy } = sides(tt);
        if (tileDistance(me, enemy) === 1) {
          adjacent = tt;
          break;
        }
        await openMenu(page, me);
        const recruitRow = page.locator(TACTICS.menuRow('recruit'));
        await expect(recruitRow, 'not adjacent: the Recruit row is greyed').toHaveAttribute(
          'aria-disabled',
          'true',
        );
        await draftMoveToward(page, enemy);
        await endTurn(page);
      }
      if (adjacent === null) {
        throw new Error(
          `CTL8J-2-A: the wild never stood adjacent on a fresh own turn within MAX_APPROACH_TURNS=${MAX_APPROACH_TURNS}`,
        );
      }
      const { me } = sides(adjacent);
      await openMenu(page, me);
      await menuCursorTo(page, 'recruit');
      await pressButton(page, 'A');
      await expect(
        page.locator(TACTICS.menuRow(NO_BAIT_ROW)),
        'A on Recruit opens the bait list with its no-bait row',
      ).toHaveCount(1, { timeout: 5_000 });
      await pressButton(page, 'B');
      await expect(
        page.locator(TACTICS.menuRow('recruit')),
        'B backs out of the bait list to the root menu',
      ).toHaveCount(1, { timeout: 5_000 });
      await expect(page.locator(TACTICS.menuRow(NO_BAIT_ROW))).toHaveCount(0);
      await pressButton(page, 'B');
      await expect(page.locator('.tactics-menu'), 'B closes the menu').toHaveCount(0, {
        timeout: 5_000,
      });
      const backedOut = await readTactics(page);
      expect(
        backedOut === null
          ? null
          : [backedOut.phase, backedOut.round, backedOut.turnIdx, backedOut.events],
        'asking and backing out spent no turn',
      ).toEqual(['Active', adjacent.round, adjacent.turnIdx, adjacent.events]);

      // The buttons, to an outcome.
      const end = await fightToOutcome(page, { maxOwnTurns: MAX_OWN_TURNS, label: 'CTL8J-2-A' });
      expect(end.phase, 'CTL8J-2-A: the battle finished').toBe('Finished');
      await expectTerminalResults(page, 'CTL8J-2-A');

      // A continues (pressed only while the stack is above the world; the auto-advance also counts).
      await continueWith(page, 'A');
      await expect.poll(() => readStack(page), { timeout: 5_000 }).toEqual([{ kind: 'world' }]);
      await expect(page.locator(TACTICS.results)).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'the battle UI is gone').toBe(false);
      expect((await snap(page)).ongoingBattle).toBeNull();
    });

    test('CTL8J-2-DPAD-BATTLE-B: a second battle on the buttons alone reaches an outcome, and B continues from it to the world (bt-16: the tactical results panel)', async () => {
      // WRONG IMPL KILLED: a second battle the buttons cannot play (state left over from the first:
      // a draft, a cursor, a lock); an outcome B does not continue from; and a continue that
      // leaves the stack above the world.
      test.setTimeout(240_000);
      const started = await huntEncounter(page, 'CTL8J-2-B');
      expect(started.battleId, 'a second battle, not the first again').not.toBe(firstBattleId);
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: started.battleId }]);

      const end = await fightToOutcome(page, { maxOwnTurns: MAX_OWN_TURNS, label: 'CTL8J-2-B' });
      expect(end.phase, 'CTL8J-2-B: the battle finished').toBe('Finished');
      await expectTerminalResults(page, 'CTL8J-2-B');

      await continueWith(page, 'B');
      await expect.poll(() => readStack(page), { timeout: 5_000 }).toEqual([{ kind: 'world' }]);
      await expect(page.locator(TACTICS.results)).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'the battle UI is gone').toBe(false);
      expect((await snap(page)).ongoingBattle).toBeNull();
    });
  });
