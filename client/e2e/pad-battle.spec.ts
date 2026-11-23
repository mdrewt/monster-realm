import { type Browser, chromium, expect, type Page, test } from '@playwright/test';
import {
  awaitTacticalActive,
  type EventTag,
  EXECUTE_WAIT_MS,
  endTurn,
  endTurnIfLive,
  menuCursorTo,
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
// first own live turn A opens the command menu, then LB and RB select the own unit: each is pressed
// with the Move aim open (the menu gone, the band painted), and the aim closes to idle with the
// cursor on that unit, no draft and nothing submitted; A then opens the command menu again, which
// only an idle shell does. Move, the D-pad cursor and A draft a Move; Skills, a
// skill and a target commit [Move, Skill] on the live turn. The D-pad walks the menu rows; with one
// wild the skill aim opens on its only target, so the target step is A on the default aim. The
// server executes the commit: the transcript gains a Moved event for the unit, then an Executed or
// Missed event before any TurnEnded, and the ticker holds one line per event (the newest
// TICKER_CAP). A turn whose reachable band fires nothing ends with Start (its step-toward draft
// executes as a Moved event, then a TurnEnded for the unit) and the next own turn tries again, at
// most MAX_OWN_TURNS. After the firing turn Start ends a turn on every run: the firing turn when it
// is still live, else the next own turn, where Start is End Turn and the transcript gains a
// TurnEnded for the unit.
//
// INPUT RULE. Every in-battle input goes through `pressButton` or a controls.ts helper built on it,
// which press the fake pad (`setPressSource(page, 'pad')`). The hunt walks the world through the DEV
// `__game().step` hook, as battle-dpad.spec.ts does. No `page.keyboard`, no click, no key name. A
// capture-phase listener counts every keydown and keyup the page receives; the count is 0 when the
// battle starts and 0 at the end. The fake pad's timestamp (bumped by each press the test makes)
// has grown; the game's responses to those presses are what show it read the pad.
//
// SEEDING (owner SQL, with a read-back). The starter's HP and defense columns are raised
// (HP 999, defense 250) so it survives the approach turns, and its attack and special attack are set
// to 1 so the wild survives every hit within MAX_OWN_TURNS: the battle stays Active and the Start
// steps always run. A battle that finishes first fails the test with its trace.
//
// CLEANUP. One browser, context and identity; afterAll closes the browser.

const SEED_HP = 999;
const SEED_DEFENSE = 250;
const SEED_ATTACK = 1;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls (recruit.spec MAX_WALK_STEPS). */
const MAX_WALK_STEPS = 120;
/** Own turns the test may spend before one commit [Move, Skill] fires. */
const MAX_OWN_TURNS = 6;
const STEP_WAIT_MS = 8_000;
/** One wait for the next own live turn in a wild battle. */
const TURN_WAIT_MS = 15_000;
/** How long the ticker may take to show the lines for an executed turn. */
const TICKER_WAIT_MS = 10_000;
/** How long the shell may take to close its menu / aim after a LB or RB press. */
const SELECT_WAIT_MS = 5_000;
/** The ticker keeps the newest this-many lines (src/tactics/ticker.ts TICKER_CAP; that module is not
 *  imported here so the spec loads under Playwright without the game's string catalog). */
const TICKER_CAP = 50;

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

/** LB or RB, entered with the ROOT MENU open on `me` and leaving it open: Move and A open the aim
 *  (the menu gone, the band painted); the bumper's cycle selects the own unit and returns the shell
 *  to idle (no menu, no ghost), the cursor sits on `me`, and nothing was submitted (battle, round,
 *  turn and event count unchanged). The closing `openMenu` proves idle: A on the own unit opens its
 *  command menu, while an unrouted bumper leaves the aim (A opens nothing) and a `back` binding has
 *  already re-opened the root menu (the "no menu" check fails). The band is not asserted: a selected
 *  unit's reach band is painted at idle too. The cursor inside the aim is not moved (it writes the
 *  unit's cursor memory). */
async function selectByBumper(
  p: Page,
  bumper: 'LB' | 'RB',
  me: Tile,
  turn: TacticsSnap,
): Promise<void> {
  await menuCursorTo(p, 'move');
  await pressButton(p, 'A');
  await expect(
    p.locator('.tactics-menu'),
    `${bumper}: A on Move replaces the menu with the aim`,
  ).toHaveCount(0, { timeout: SELECT_WAIT_MS });
  await expect(
    p.locator(TACTICS.bandTile).first(),
    `${bumper}: the Move aim paints its band`,
  ).toBeVisible({ timeout: SELECT_WAIT_MS });
  await pressButton(p, bumper);
  await expect(
    p.locator('.tactics-menu'),
    `${bumper} selects the own unit: idle, no command menu re-opened`,
  ).toHaveCount(0, { timeout: SELECT_WAIT_MS });
  await expect(p.locator(TACTICS.ghost), `${bumper} drafted nothing (no ghost)`).toHaveCount(0);
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
  // A on the own unit opens its command menu only from idle: this A proves the bumper left the aim.
  await openMenu(p, me);
}

/** After a Start on `turn`: within EXECUTE_WAIT_MS its turn key differs or the phase is Finished. */
async function expectTurnEnded(p: Page, turn: TacticsSnap, what: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await readTactics(p);
        return s === null || s.phase === 'Finished' || turnKey(s) !== turnKey(turn);
      },
      {
        message: `GP3.1: Start ended ${what} within ${EXECUTE_WAIT_MS} ms`,
        timeout: EXECUTE_WAIT_MS,
      },
    )
    .toBe(true);
}

/** After a Start press: the transcript, beyond the `tagsBeforeStart` entries read just before it,
 *  gains a TurnEnded for `unitId` within EXECUTE_WAIT_MS. */
async function expectTurnEndedEvent(
  p: Page,
  unitId: number,
  tagsBeforeStart: number,
  what: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await readEventTags(p))
          .slice(tagsBeforeStart)
          .some((e) => e.tag === 'TurnEnded' && e.unit === unitId),
      {
        message: `GP3.1: Start on ${what} executed an end: a TurnEnded event for unit ${unitId} within ${EXECUTE_WAIT_MS} ms`,
        timeout: EXECUTE_WAIT_MS,
      },
    )
    .toBe(true);
}

/** Whether the new events carry our Moved (for `unitId`) followed, before any TurnEnded, by an
 *  Executed or Missed: our one commit's order is Moved, hit, and only then a TurnEnded, so a wild's
 *  later hit cannot satisfy it. */
function commitExecuted(fresh: EventTag[], unitId: number): boolean {
  const i = fresh.findIndex((e) => e.tag === 'Moved' && e.unit === unitId);
  if (i < 0) return false;
  const after = fresh.slice(i + 1);
  const end = after.findIndex((e) => e.tag === 'TurnEnded');
  const between = end < 0 ? after : after.slice(0, end);
  return between.some((e) => e.tag === 'Executed' || e.tag === 'Missed');
}

test.describe
  .serial('gp-3 — the tactical battle on the pad', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      const ctx = await browser.newContext();
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
          ['stat_attack', SEED_ATTACK],
          ['stat_sp_attack', SEED_ATTACK],
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
      expect(Number(row?.stat_attack), 'the starter row reads back the attack seed').toBe(
        SEED_ATTACK,
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('a wild tactical battle on the mocked pad alone: LB/RB select the unit, A opens the menu, Move and Skills by the D-pad and A commit [Move, Skill] that the server executes and the ticker shows, Start ends a live turn, and no key is pressed [gp-3.1]', async () => {
      // WRONG IMPL KILLED: LB / RB unrouted (the Move aim stays, so the A after it opens no menu),
      // or wired to `back` (the root menu re-opens at once, so "no menu" fails); a bumper that submits or skips a turn; a pad A / D-pad that cannot open
      // the menu, draft a Move or confirm a skill and target; a commit the server never executes
      // (no Moved, no Executed / Missed after it, before a TurnEnded); a ticker that does not hold
      // one line per event; a pad Start that does not end a turn (no turn change, no TurnEnded);
      // and an implementation that passes by pressing keys (the key counter). The pad timestamp
      // shows the TEST pressed the pad; the game's responses to those presses show it read them.
      test.setTimeout(300_000);
      const started = await huntEncounter(page, 'GP3.1');
      expect(await keyCount(page), 'no key event reached the page before the battle').toBe(0);
      const padAtStart = await padTimestamp(page);
      expect(padAtStart, 'the fake pad is installed (timestamp read)').toBeGreaterThanOrEqual(0);

      let last: string | null = null;
      let fired = false;
      /** Set wherever a pad Start was seen to end a live turn. */
      let startPressedOnLiveTurn = false;
      const trace: string[] = [];
      const finishedError = (where: string): Error =>
        new Error(`GP3.1: the battle finished ${where} — trace: ${trace.join(' | ')}`);
      for (let turn = 0; turn < MAX_OWN_TURNS && !fired; turn += 1) {
        const t = await waitOwnTurnOrEnd(page, last, TURN_WAIT_MS);
        if (t.phase !== 'Active') throw finishedError('before a [Move, Skill] commit fired');
        expect(t.battleId, 'the battle under test').toBe(started.battleId);
        last = turnKey(t);
        const { me, enemy } = sides(t);
        const tagsBefore = (await readEventTags(page)).length;
        const line = `r${t.round}:${t.turnIdx} me(${me.x},${me.y}) wild(${enemy.x},${enemy.y})hp${enemy.curHp}/${enemy.maxHp} d${tileDistance(me, enemy)}`;

        // A opens the command menu. On turn 0 the bumpers run with it open and leave it open (each
        // re-opens it with A), so no second openMenu: its A would activate a row.
        await openMenu(page, me);
        if (turn === 0) {
          await selectByBumper(page, 'RB', me, t);
          await selectByBumper(page, 'LB', me, t);
        }

        const moved = await moveThenAttackByButtons(page, me, enemy, {
          allowKo: true,
          enemyHp: enemy.curHp,
        });
        if (moved.hit === 'attacked') {
          trace.push(`${line} attacked tries:${moved.tries}`);
          await waitExecuted(page, t.events);

          // (a) the server executed OUR commit: Moved for the unit, then Executed / Missed, all
          // before any TurnEnded.
          await expect
            .poll(
              async () => commitExecuted((await readEventTags(page)).slice(tagsBefore), me.unitId),
              {
                message: `GP3.1: the server executed [Move, Skill]: Moved for unit ${me.unitId} then Executed or Missed before any TurnEnded (trace: ${trace.join(' | ')})`,
                timeout: EXECUTE_WAIT_MS,
              },
            )
            .toBe(true);

          // (b) the ticker holds one line per event (the newest TICKER_CAP), the newest non-empty.
          await expect
            .poll(
              async () => {
                const s = await readTactics(page);
                const lines = await tickerLines(page);
                return s !== null && lines === Math.min(TICKER_CAP, s.events);
              },
              {
                message: `GP3.1: the ticker holds min(${TICKER_CAP}, events) lines within ${TICKER_WAIT_MS} ms`,
                timeout: TICKER_WAIT_MS,
              },
            )
            .toBe(true);
          const newest = (await page.locator(TICKER_LINES).last().textContent()) ?? '';
          expect(newest.trim().length, 'GP3.1: the newest ticker line has text').toBeGreaterThan(0);

          fired = true;
          // Start ends the turn only while it is still live.
          const now = await readTactics(page);
          if (now === null || now.phase === 'Finished') {
            throw finishedError('after the firing commit, before Start ran');
          }
          const live =
            now.phase === 'Active' && now.turnState === 'Waiting' && turnKey(now) === turnKey(t);
          const tagsBeforeStart = (await readEventTags(page)).length;
          await endTurnIfLive(page, t);
          if (live) {
            await expectTurnEnded(page, t, `the firing turn ${turnKey(t)}`);
            await expectTurnEndedEvent(
              page,
              me.unitId,
              tagsBeforeStart,
              `the firing turn ${turnKey(t)}`,
            );
            startPressedOnLiveTurn = true;
          } else {
            // The commit spent the whole budget, so the server ended the turn: Start has not been
            // pressed. Press it on the next own live turn, which has no draft (End Turn).
            const next = await waitOwnTurnOrEnd(page, turnKey(t), TURN_WAIT_MS);
            if (next.phase !== 'Active') throw finishedError('before the follow-up Start ran');
            const nextMe = sides(next).me;
            const tagsBeforeNext = (await readEventTags(page)).length;
            await endTurn(page);
            await expectTurnEnded(page, next, `the follow-up turn ${turnKey(next)}`);
            await expectTurnEndedEvent(
              page,
              nextMe.unitId,
              tagsBeforeNext,
              `the follow-up turn ${turnKey(next)}`,
            );
            await expect
              .poll(async () => (await readTactics(page))?.events ?? 0, {
                message: `GP3.1: Start on turn ${turnKey(next)} executed an end: events grew past ${next.events} within ${EXECUTE_WAIT_MS} ms`,
                timeout: EXECUTE_WAIT_MS,
              })
              .toBeGreaterThan(next.events);
            startPressedOnLiveTurn = true;
          }
        } else {
          // Nothing fires from the band this turn: Start ends the step-toward draft.
          trace.push(
            `${line} ${moved.hit} tries:${moved.tries} dest:${moved.dest === null ? 'none' : `(${moved.dest.x},${moved.dest.y})`}`,
          );
          const tagsBeforeStart = (await readEventTags(page)).length;
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
            await expectTurnEndedEvent(
              page,
              me.unitId,
              tagsBeforeStart,
              `the step-toward turn ${turnKey(t)}`,
            );
            // The draft only reaches the server through Start's End Turn: Start ended a live turn.
            startPressedOnLiveTurn = true;
          }
        }
      }
      if (!fired) {
        throw new Error(
          `GP3.1: no [Move, Skill] commit fired within MAX_OWN_TURNS=${MAX_OWN_TURNS} own turns — trace: ${trace.join(' | ')}`,
        );
      }
      expect(
        startPressedOnLiveTurn,
        `GP3.1: the pad Start ended a live turn (trace: ${trace.join(' | ')})`,
      ).toBe(true);

      expect(await keyCount(page), 'no keydown or keyup reached the page during the battle').toBe(
        0,
      );
      expect(
        await padTimestamp(page),
        'the fake pad was used: its timestamp grew during the battle',
      ).toBeGreaterThan(padAtStart);
    });
  });
