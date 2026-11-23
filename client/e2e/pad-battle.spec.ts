import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  awaitTacticalActive,
  EXECUTE_WAIT_MS,
  endTurn,
  endTurnIfLive,
  moveThenAttackByButtons,
  openMenu,
  pressButton,
  readCursorTile,
  readEventTags,
  readTactics,
  setPressSource,
  sides,
  TACTICS,
  type TacticsSnap,
  tileDistance,
  turnKey,
  waitExecuted,
  waitOwnTurnOrEnd,
} from './controls';
import { installFakePad } from './pad';
import { ownerSql, sqlRows } from './stdb';

// pad-battle.spec.ts — a wild tactical battle played on the mocked pad alone (gp-3, GP3.1). On the
// first own live turn LB and RB select the own unit (the open command menu closes and the cursor
// sits on that unit, nothing is submitted); A opens the command menu; Move, the D-pad cursor and A
// draft a Move; Skills, a skill and a target by the D-pad and A commit [Move, Skill] on the live
// turn, which the server executes: the transcript gains a Moved event for the unit and an Executed
// or Missed event, and the ticker shows lines for them. A turn whose reachable band fires nothing
// ends with Start (its step-toward draft executes as a Moved event) and the next own turn tries
// again, at most MAX_OWN_TURNS. After the firing turn, Start ends it while it is still live.
//
// INPUT RULE. Every in-battle input goes through `pressButton` or a controls.ts helper built on it,
// which press the fake pad (`setPressSource(page, 'pad')`). The hunt walks the world through the DEV
// `__game().step` hook, as battle-dpad.spec.ts does. No `page.keyboard`, no click, no key name. A
// capture-phase listener counts every keydown and keyup the page receives; the count is 0 when the
// battle starts and 0 at the end, and the fake pad's timestamp (bumped by each press) has grown.
//
// SEEDING (owner SQL, with a read-back). The starter's HP and defense columns are raised so it
// survives the approach turns; its attack is left alone so the wild usually survives the hit and the
// Start path runs.
//
// CLEANUP. One browser, context and identity; afterAll closes the browser.

const SEED_HP = 999;
const SEED_DEFENSE = 250;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls (recruit.spec MAX_WALK_STEPS). */
const MAX_WALK_STEPS = 120;
/** Own turns the test may spend before one commit [Move, Skill] fires. */
const MAX_OWN_TURNS = 6;
const STEP_WAIT_MS = 8_000;
/** One wait for the next own live turn in a wild battle. */
const TURN_WAIT_MS = 15_000;
/** How long the ticker may take to show lines for an executed turn. */
const TICKER_WAIT_MS = 10_000;
/** How long the shell may take to close its menu / move its cursor after a LB or RB press. */
const SELECT_WAIT_MS = 5_000;
/** How long the turn may take to end after the Start press. */
const START_END_WAIT_MS = EXECUTE_WAIT_MS;

const TICKER_LINES = '.tactics-battle .tactics-ticker li';

interface Tile {
  x: number;
  y: number;
}
interface OwnMonster {
  monsterId: string;
}
interface OngoingBattle {
  battleId: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ongoingBattle: OngoingBattle | null;
}
type Win = Window & {
  __game: () => GameSnap & { step: (d: string) => void };
  __gp3Keys?: number;
  __mrFakePad?: { timestamp: number };
};

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

const keyCount = (p: Page): Promise<number> =>
  p.evaluate(() => (window as unknown as Win).__gp3Keys ?? -1);

const padTimestamp = (p: Page): Promise<number> =>
  p.evaluate(() => (window as unknown as Win).__mrFakePad?.timestamp ?? -1);

const tickerLines = (p: Page): Promise<number> => p.locator(TICKER_LINES).count();

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

/** Walk the shuttle until a wild battle is ongoing, then wait for its tactical row Active and the
 *  shell on screen. */
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

/** The cursor tile as `x,y` (a poll-friendly value). */
async function cursorKey(p: Page): Promise<string> {
  const c = await readCursorTile(p);
  return `${c.x},${c.y}`;
}

/** LB or RB with the command menu open: the menu is gone and the cursor sits on `me`, and nothing
 *  was submitted (battle, round, turn and event count unchanged). */
async function selectByBumper(
  p: Page,
  bumper: 'LB' | 'RB',
  me: Tile,
  turn: TacticsSnap,
): Promise<void> {
  await openMenu(p, me);
  await pressButton(p, bumper);
  await expect(
    p.locator('.tactics-menu'),
    `${bumper} selects the own unit and closes the open command menu`,
  ).toHaveCount(0, { timeout: SELECT_WAIT_MS });
  await expect
    .poll(() => cursorKey(p), {
      message: `${bumper}: the cursor is on the own unit (${me.x},${me.y})`,
      timeout: SELECT_WAIT_MS,
    })
    .toBe(`${me.x},${me.y}`);
  const now = await readTactics(p);
  expect(
    now === null ? null : [now.battleId, now.phase, now.round, now.turnIdx, now.events],
    `${bumper} submitted nothing (same battle, round, turn and event count)`,
  ).toEqual([turn.battleId, 'Active', turn.round, turn.turnIdx, turn.events]);
}

test.describe
  .serial('gp-3 — the tactical battle on the pad', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      await installFakePad(ctx);
      await ctx.addInitScript(() => {
        const w = window as unknown as Win;
        w.__gp3Keys = 0;
        const bump = (): void => {
          w.__gp3Keys = (w.__gp3Keys ?? 0) + 1;
        };
        window.addEventListener('keydown', bump, true);
        window.addEventListener('keyup', bump, true);
      });
      page = await ctx.newPage();
      setPressSource(page, 'pad');
      await page.goto('/');
      await ready(page);
      const starter = (await snap(page)).ownMonsters[0];
      if (!starter || !/^[0-9]+$/.test(starter.monsterId)) {
        throw new Error('beforeAll: no starter with a decimal monsterId');
      }
      for (const table of ['monster', 'monster_pub']) {
        for (const [col, val] of [
          ['stat_defense', SEED_DEFENSE],
          ['stat_sp_defense', SEED_DEFENSE],
          ['stat_hp', SEED_HP],
          ['current_hp', SEED_HP],
        ] as const) {
          ownerSql(
            `UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${starter.monsterId}`,
            'seed',
          );
        }
      }
      // ANTI-NO-OP: read the seed back; a silent zero-row UPDATE leaves the starter fragile.
      const row = sqlRows(
        ownerSql(`SELECT * FROM monster WHERE monster_id = ${starter.monsterId}`, 'seed read'),
        'seed read',
      ).find((r) => r.monster_id === starter.monsterId);
      expect(row, 'the starter row is visible to the CLI').toBeDefined();
      expect(Number(row?.stat_hp), 'the starter row reads back the HP seed').toBe(SEED_HP);
      expect(Number(row?.stat_defense), 'the starter row reads back the defense seed').toBe(
        SEED_DEFENSE,
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('a wild tactical battle on the mocked pad alone: LB/RB select the unit, A opens the menu, Move and Skills by the D-pad and A commit [Move, Skill] that the server executes and the ticker shows, Start ends a live turn, and no key is pressed [gp-3.1]', async () => {
      // WRONG IMPL KILLED: LB / RB unrouted in the battle (the open menu stays, the cursor stays);
      // a bumper that submits or skips a turn; a pad A / D-pad that cannot open the menu, draft a
      // Move or confirm a skill and target; a commit the server never executes (no Moved, no
      // Executed / Missed); a ticker that shows no lines for the executed turn; a Start that
      // does not end a live turn; and an implementation that passes by pressing keys (the key
      // counter) or never reads the pad (its timestamp).
      test.setTimeout(300_000);
      const started = await huntEncounter(page, 'GP3.1');
      expect(await keyCount(page), 'no key event reached the page before the battle').toBe(0);
      const padAtStart = await padTimestamp(page);
      expect(padAtStart, 'the fake pad is installed (timestamp read)').toBeGreaterThanOrEqual(0);

      let last: string | null = null;
      let fired: TacticsSnap | null = null;
      const trace: string[] = [];
      for (let turn = 0; turn < MAX_OWN_TURNS && fired === null; turn += 1) {
        const t = await waitOwnTurnOrEnd(page, last, TURN_WAIT_MS);
        if (t.phase !== 'Active') {
          throw new Error(
            `GP3.1: the battle finished before a [Move, Skill] commit fired — trace: ${trace.join(' | ')}`,
          );
        }
        expect(t.battleId, 'the battle under test').toBe(started.battleId);
        last = turnKey(t);
        const { me, enemy } = sides(t);
        const tagsBefore = (await readEventTags(page)).length;
        const linesBefore = await tickerLines(page);
        const line = `r${t.round}:${t.turnIdx} me(${me.x},${me.y}) wild(${enemy.x},${enemy.y})hp${enemy.curHp}/${enemy.maxHp} d${tileDistance(me, enemy)}`;

        if (turn === 0) {
          // LB / RB select the own unit (the menu opened on it is closed by the cycle).
          await selectByBumper(page, 'RB', me, t);
          await selectByBumper(page, 'LB', me, t);
        }
        // A opens the command menu.
        await openMenu(page, me);

        const moved = await moveThenAttackByButtons(page, me, enemy, {
          allowKo: true,
          enemyHp: enemy.curHp,
        });
        if (moved.hit === 'attacked') {
          trace.push(`${line} attacked tries:${moved.tries}`);
          await waitExecuted(page, t.events);
          const after = await readTactics(page);
          expect(after, 'the battle is still shown after the commit').not.toBeNull();

          // (a) the server executed the turn: Moved for the unit plus Executed / Missed.
          await expect
            .poll(
              async () => {
                const fresh = (await readEventTags(page)).slice(tagsBefore);
                return {
                  moved: fresh.some((e) => e.tag === 'Moved' && e.unit === me.unitId),
                  hit: fresh.some((e) => e.tag === 'Executed' || e.tag === 'Missed'),
                };
              },
              {
                message: `GP3.1: the server executed [Move, Skill]: new events carry Moved for unit ${me.unitId} and Executed or Missed (trace: ${trace.join(' | ')})`,
                timeout: EXECUTE_WAIT_MS,
              },
            )
            .toEqual({ moved: true, hit: true });

          // (b) the ticker shows the executed turn's events.
          await expect
            .poll(() => tickerLines(page), {
              message: `GP3.1: the ticker grew past its ${linesBefore} lines within ${TICKER_WAIT_MS} ms`,
              timeout: TICKER_WAIT_MS,
            })
            .toBeGreaterThan(linesBefore);

          fired = after;
          // Start ends the turn only while it is still live.
          const now = await readTactics(page);
          if (now !== null && now.phase !== 'Finished') {
            const live =
              now.phase === 'Active' && now.turnState === 'Waiting' && turnKey(now) === turnKey(t);
            await endTurnIfLive(page, t);
            if (live) {
              await expect
                .poll(
                  async () => {
                    const s = await readTactics(page);
                    return s === null || s.phase === 'Finished' || turnKey(s) !== turnKey(t);
                  },
                  {
                    message: `GP3.1: Start ended turn ${turnKey(t)} within ${START_END_WAIT_MS} ms`,
                    timeout: START_END_WAIT_MS,
                  },
                )
                .toBe(true);
            }
          }
        } else {
          // Nothing fires from the band this turn: Start ends the step-toward draft.
          trace.push(
            `${line} ${moved.hit} tries:${moved.tries} dest:${moved.dest === null ? 'none' : `(${moved.dest.x},${moved.dest.y})`}`,
          );
          await endTurn(page);
          if (moved.dest !== null) {
            await expect
              .poll(
                async () =>
                  (await readEventTags(page))
                    .slice(tagsBefore)
                    .some((e) => e.tag === 'Moved' && e.unit === me.unitId),
                {
                  message: `GP3.1: the drafted step-toward Move executed (a Moved event for unit ${me.unitId}) within ${EXECUTE_WAIT_MS} ms (trace: ${trace.join(' | ')})`,
                  timeout: EXECUTE_WAIT_MS,
                },
              )
              .toBe(true);
          }
        }
      }
      if (fired === null) {
        throw new Error(
          `GP3.1: no [Move, Skill] commit fired within MAX_OWN_TURNS=${MAX_OWN_TURNS} own turns — trace: ${trace.join(' | ')}`,
        );
      }

      expect(await keyCount(page), 'no keydown or keyup reached the page during the battle').toBe(
        0,
      );
      expect(
        await padTimestamp(page),
        'the fake pad was used: its timestamp grew during the battle',
      ).toBeGreaterThan(padAtStart);
    });
  });
