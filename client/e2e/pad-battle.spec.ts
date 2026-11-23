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
  type EventTag,
  EXECUTE_WAIT_MS,
  endTurn,
  endTurnIfLive,
  livePadBindings,
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
import { installFakePad, padHold } from './pad';
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

// =============================================================================================
// Hold Y clears a READY plan, on the mocked pad alone.
//
// MEASURED DEVIATION from the criterion's "during the wild's turn": the server runs a wild's AI
// turn inside the transaction that ends the turn before it (game-core `tactics/queue.rs`: the chain
// of pre-queued and AI turns runs inside one call), so a wild battle never shows the client a
// wild's turn to plan in. A wild battle's one pre-queue window is a SECOND own unit while the first
// one's turn is live (the wild window is 300 s), and that is the window used here. A donor
// identity's starter joins this identity's party (owner SQL on `monster` and `monster_pub`, the
// trade-full.spec `setMonsterColumn` shape), the encounter fields both monsters, and on the first
// own live turn the OTHER own unit is planned (End Turn), submitted with Start, and cleared by
// holding pad Y for 600 ms. Initiative is not controlled: that unit may have acted already this
// round, so its plan is for its next turn; the oracle is the server's row, never a chip state.
//
// The server oracle is owner SQL on the private `battle_queue` (one READY row per unit, keyed by
// the unit id); the client oracle is `.tactics-strip--locked`, which the shell paints exactly when
// the selected unit has a READY plan and no draft (the precondition of the hold). "No confirm row"
// is counted by a MutationObserver installed before the hold, so a confirm painted and removed
// between two polls is still seen; the test ends by opening the confirm on purpose, which the
// observer must count. Every in-battle input is a pad press (`pressButton` in pad mode, `padHold`
// for Y); the capture-phase key counter stays 0. The donor's context closes once its starter is
// given away; afterAll closes the browser.
// =============================================================================================

/** How long pad Y is held: the criterion's number, past the router's 500 ms hold threshold. */
const HOLD_Y_MS = 600;
/** How long a READY row may take to reach, or leave, the server after a press. */
const QUEUE_WAIT_MS = 15_000;
/** How long the client may take to paint what the server holds. */
const CLIENT_WAIT_MS = 10_000;
/** The party slots, 0 to 5. */
const PARTY_SLOTS = 6;
/** RB presses spent putting the cursor on the other own unit (two own units: one press). */
const MAX_RB_PRESSES = 3;

const SHELL_MENU = `${TACTICS.shell} .tactics-menu`;
const LOCKED_STRIP = `${TACTICS.shell} .tactics-strip--locked`;
const STRIP_CHIPS = `${TACTICS.shell} .tactics-strip .tactics-chip`;
const CONFIRM_ROW = '.tactics-menu-row[data-row="clearYes"]';

interface PartyMonster {
  monsterId: string;
  partySlot: number;
}
interface PartySnap {
  identity: string;
  ownMonsters: PartyMonster[];
}
type HoldWin = Window & {
  __game: () => { identity: string; ownMonsters: PartyMonster[] };
  __mrClearYesSeen?: number;
};

const partySnap = (p: Page): Promise<PartySnap> =>
  p.evaluate(() => {
    const g = (window as unknown as HoldWin).__game();
    return {
      identity: g.identity,
      ownMonsters: g.ownMonsters.map((m) => ({ monsterId: m.monsterId, partySlot: m.partySlot })),
    };
  });

/** A capture-phase counter of every keydown and keyup the context's pages receive (`keyCount`). */
async function countKeys(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const w = window as unknown as Win;
    w.__gp3Keys = 0;
    const bump = (): void => {
      w.__gp3Keys = (w.__gp3Keys ?? 0) + 1;
    };
    window.addEventListener('keydown', bump, true);
    window.addEventListener('keyup', bump, true);
  });
}

/** An identity as 64 lowercase hex digits, checked: owner SQL takes it as a `0x` literal. */
function hexIdentity(id: string, label: string): string {
  const s = id.trim().toLowerCase();
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${label}: not a hex identity: ${id}`);
  return h;
}

/** A decimal id, checked, so it can sit in an owner-SQL literal. */
function decimalId(id: string, label: string): string {
  if (!/^[0-9]+$/.test(id)) throw new Error(`${label}: not a decimal id: ${id}`);
  return id;
}

/** Owner SQL: one column of one monster, on the private row AND its `monster_pub` projection (the
 *  server writes both together), as trade-full.spec does. */
function setMonsterColumn(
  monsterId: string,
  column: 'owner_identity' | 'party_slot',
  value: string,
  label: string,
): void {
  const mid = decimalId(monsterId, label);
  if (!/^(0x[0-9a-f]{64}|[0-9]+)$/.test(value)) throw new Error(`${label}: bad value ${value}`);
  for (const table of ['monster', 'monster_pub'] as const) {
    ownerSql(`UPDATE ${table} SET ${column} = ${value} WHERE monster_id = ${mid}`, label);
  }
}

/** A monster's owner (hex, no `0x`) and party slot on `table`, by owner SQL; null without a row. */
function serverOwnerAndSlot(
  table: 'monster' | 'monster_pub',
  monsterId: string,
  label: string,
): { owner: string; partySlot: string } | null {
  const mid = decimalId(monsterId, label);
  const row = sqlRows(
    ownerSql(
      `SELECT monster_id, owner_identity, party_slot FROM ${table} WHERE monster_id = ${mid}`,
      label,
    ),
    label,
  )[0];
  if (row === undefined) return null;
  const owner = (row.owner_identity ?? '').trim().toLowerCase();
  return {
    owner: owner.startsWith('0x') ? owner.slice(2) : owner,
    partySlot: (row.party_slot ?? '').trim(),
  };
}

/** The unit ids holding a READY row in `battleId` on the server (owner SQL, `battle_queue`). */
function serverReadyUnits(battleId: string, label: string): number[] {
  const id = decimalId(battleId, label);
  return sqlRows(ownerSql(`SELECT unit_id FROM battle_queue WHERE battle_id = ${id}`, label), label)
    .map((r) => Number((r.unit_id ?? '').trim()))
    .sort((a, b) => a - b);
}

/** Owner SQL: the sturdy, harmless seed (HP 999, defenses 250, attacks 1) on one monster's private
 *  row and projection, read back from the private row. */
function seedSturdy(monsterId: string, label: string): void {
  const mid = decimalId(monsterId, label);
  for (const table of ['monster', 'monster_pub']) {
    for (const [col, val] of [
      ['stat_defense', SEED_DEFENSE],
      ['stat_sp_defense', SEED_DEFENSE],
      ['stat_attack', SEED_ATTACK],
      ['stat_sp_attack', SEED_ATTACK],
      ['stat_hp', SEED_HP],
      ['current_hp', SEED_HP],
    ] as const) {
      ownerSql(`UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${mid}`, label);
    }
  }
  const row = sqlRows(
    ownerSql(`SELECT * FROM monster WHERE monster_id = ${mid}`, label),
    label,
  ).find((r) => r.monster_id === mid);
  expect(row, `${label}: the row is visible to the CLI`).toBeDefined();
  expect(Number(row?.stat_hp), `${label}: the HP seed reads back`).toBe(SEED_HP);
  expect(Number(row?.stat_defense), `${label}: the defense seed reads back`).toBe(SEED_DEFENSE);
  expect(Number(row?.stat_attack), `${label}: the attack seed reads back`).toBe(SEED_ATTACK);
}

/** RB until the shell's cursor sits on `unit` (a cycle selects the next own unit and puts the
 *  cursor on its tile), bounded by MAX_RB_PRESSES; fails naming the tile. */
async function rbOnto(p: Page, unit: Tile, label: string): Promise<void> {
  const want = `${unit.x},${unit.y}`;
  for (let presses = 0; presses < MAX_RB_PRESSES && (await cursorKey(p)) !== want; presses += 1) {
    await pressButton(p, 'RB');
    await expect
      .poll(() => cursorKey(p), { timeout: 2_000 })
      .toBe(want)
      .catch(() => undefined);
  }
  expect(
    await cursorKey(p),
    `${label}: RB put the cursor on the other own unit (${want}) within ${MAX_RB_PRESSES} presses`,
  ).toBe(want);
}

/** On `unit`, the selected own unit in pre-queue: A opens ITS command menu (a pre-queue menu, so
 *  it offers Submit), End Turn appends to the draft (the menu closes, one drafted chip), and Start
 *  submits the draft. */
async function preQueueEndTurn(p: Page, unit: Tile, label: string): Promise<void> {
  await openMenu(p, unit);
  await expect(
    p.locator(`${TACTICS.shell} ${TACTICS.menuRow('submit')}`),
    `${label}: A opened the pre-queue menu (it offers Submit)`,
  ).toHaveCount(1, { timeout: CLIENT_WAIT_MS });
  await menuCursorTo(p, 'end');
  await pressButton(p, 'A');
  await expect(p.locator(SHELL_MENU), `${label}: End Turn closes the menu`).toHaveCount(0, {
    timeout: CLIENT_WAIT_MS,
  });
  await expect(p.locator(STRIP_CHIPS), `${label}: End Turn is drafted, not sent`).toHaveCount(1, {
    timeout: CLIENT_WAIT_MS,
  });
  await pressButton(p, 'Start');
}

test.describe
  .serial('Hold Y on the pad clears a READY plan', () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      // Two boots (each `ready` waits up to 30 s), the transfer and the seeding.
      test.setTimeout(150_000);
      browser = await chromium.launch();
      // The donor: its own context, so its own identity, booted only to give its starter away.
      const donorCtx = await browser.newContext();
      const donor = await donorCtx.newPage();
      await donor.goto('/');
      await ready(donor);
      const given = await partySnap(donor);

      const ctx = await browser.newContext();
      await installFakePad(ctx);
      await countKeys(ctx);
      page = await ctx.newPage();
      setPressSource(page, 'pad');
      await page.goto('/');
      await ready(page);
      const mine = await partySnap(page);
      const hex = hexIdentity(mine.identity, 'the test identity');
      expect(hexIdentity(given.identity, 'the donor'), 'the donor is another identity').not.toBe(
        hex,
      );
      expect(mine.ownMonsters, 'the test identity holds its one starter').toHaveLength(1);
      expect(given.ownMonsters, 'and so does the donor').toHaveLength(1);
      const own = decimalId(mine.ownMonsters[0]?.monsterId ?? '', 'the starter');
      const gift = decimalId(given.ownMonsters[0]?.monsterId ?? '', 'the donor`s starter');
      const used = new Set(mine.ownMonsters.map((m) => m.partySlot));
      const slot = Array.from({ length: PARTY_SLOTS }, (_, i) => i).find((s) => !used.has(s));
      if (slot === undefined) throw new Error('beforeAll: no free party slot');
      setMonsterColumn(gift, 'owner_identity', `0x${hex}`, 'the donor`s starter to this identity');
      setMonsterColumn(gift, 'party_slot', `${slot}`, 'the donor`s starter into a free slot');
      for (const table of ['monster', 'monster_pub'] as const) {
        expect(
          serverOwnerAndSlot(table, gift, `${table} read-back`),
          `${table}: the donor's starter is this identity's, in party slot ${slot}`,
        ).toEqual({ owner: hex, partySlot: `${slot}` });
      }
      await donorCtx.close();
      await expect
        .poll(
          async () =>
            (await partySnap(page)).ownMonsters
              .filter((m) => m.partySlot >= 0 && m.partySlot < PARTY_SLOTS)
              .map((m) => m.monsterId)
              .sort(),
          {
            message: `the test page lists both monsters in its party within ${CLIENT_WAIT_MS} ms`,
            timeout: CLIENT_WAIT_MS,
          },
        )
        .toEqual([own, gift].sort());
      seedSturdy(own, 'seed the starter');
      seedSturdy(gift, 'seed the donor`s starter');
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('a wild battle on the mocked pad alone: on the first own live turn RB selects the OTHER own unit and A, End Turn and Start pre-queue its plan (a READY row on the server, the strip locked); pad Y held 600 ms clears that row with no confirm row ever painted and the live turn untouched; A, End Turn and Start then submit a plan that reaches the server again; no key is pressed [gp-6.9]', async () => {
      // WRONG IMPL KILLED: a Y hold that never reaches the shell (main.ts lists no hold-capable
      // button, or the router never arms: the row stays); a hold read as a tap (a hint line, the
      // row stays); a hold that opens the Clear plan confirm (the observer counts it); a hold that
      // ends the live unit's turn or submits (the turn key moves); a clear that keeps the unit's
      // in-flight key (the re-plan's Start is swallowed: no row comes back); an implementation that
      // passes by pressing keys (the key counter).
      test.setTimeout(300_000);
      const started = await huntEncounter(page, 'Hold Y');
      expect(await keyCount(page), 'no key event reached the page before the battle').toBe(0);
      const padAtStart = await padTimestamp(page);
      expect(padAtStart, 'the fake pad is installed (timestamp read)').toBeGreaterThanOrEqual(0);
      expect(
        started.units.filter((u) => u.mine && u.state === 'Active').length,
        'both own monsters are on the board',
      ).toBe(2);

      const t = await waitOwnTurnOrEnd(page, null, TURN_WAIT_MS);
      if (t.phase !== 'Active') {
        throw new Error('Hold Y: the battle finished before the first own live turn');
      }
      const live = sides(t).me;
      const other = t.units.find((u) => u.mine && u.state === 'Active' && u.unitId !== live.unitId);
      if (other === undefined) {
        throw new Error(`Hold Y: no second own unit beside the live unit ${live.unitId}`);
      }
      const battleId = decimalId(t.battleId, 'the battle id');
      const otherId = other.unitId;
      const queued = (label: string): boolean =>
        serverReadyUnits(battleId, label).includes(otherId);
      expect(queued('before the plan'), `no READY row for unit ${other.unitId} yet`).toBe(false);

      // RB to the other own unit, then End Turn pre-queued and submitted with Start.
      await rbOnto(page, other, 'the plan');
      await preQueueEndTurn(page, other, 'the plan');
      await expect
        .poll(async () => queued('the plan'), {
          message: `the server holds unit ${other.unitId}'s READY row within ${QUEUE_WAIT_MS} ms of Start`,
          timeout: QUEUE_WAIT_MS,
        })
        .toBe(true);
      await expect(
        page.locator(LOCKED_STRIP),
        'the client shows the READY plan locked on the selected unit',
      ).toHaveCount(1, { timeout: CLIENT_WAIT_MS });
      await expect(page.locator(SHELL_MENU), 'the shell is idle before the hold').toHaveCount(0);
      const beforeHold = await readTactics(page);
      expect(beforeHold === null ? null : turnKey(beforeHold), 'still the live turn').toBe(
        turnKey(t),
      );

      // The confirm-row observer, then pad Y held.
      await page.evaluate((sel: string) => {
        const w = window as unknown as HoldWin;
        w.__mrClearYesSeen = document.querySelector(sel) === null ? 0 : 1;
        const hit = (n: Node): boolean =>
          n instanceof Element && (n.matches(sel) || n.querySelector(sel) !== null);
        new MutationObserver((records) => {
          for (const r of records) {
            const added = Array.from(r.addedNodes).some(hit);
            const turned = r.type === 'attributes' && hit(r.target);
            if (added || turned) w.__mrClearYesSeen = (w.__mrClearYesSeen ?? 0) + 1;
          }
        }).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['data-row'],
        });
      }, CONFIRM_ROW);
      const yIndex = (await livePadBindings(page)).buttons.Y[0];
      if (yIndex === undefined) {
        throw new Error('Hold Y: the live pad table binds no pad button to Y');
      }
      await padHold(page, yIndex, HOLD_Y_MS);
      await expect
        .poll(async () => queued('after the hold'), {
          message: `holding pad Y ${HOLD_Y_MS} ms cleared unit ${other.unitId}'s READY row on the server within ${QUEUE_WAIT_MS} ms`,
          timeout: QUEUE_WAIT_MS,
        })
        .toBe(false);
      const confirmsSeen = (): Promise<number> =>
        page.evaluate(() => (window as unknown as HoldWin).__mrClearYesSeen ?? -1);
      expect(await confirmsSeen(), 'no Clear plan confirm row was ever painted').toBe(0);
      await expect(page.locator(LOCKED_STRIP), 'the client drops the READY plan').toHaveCount(0, {
        timeout: CLIENT_WAIT_MS,
      });
      await expect(page.locator(SHELL_MENU), 'the hold opened no menu').toHaveCount(0);
      const afterHold = await readTactics(page);
      expect(
        afterHold === null
          ? null
          : [afterHold.phase, afterHold.turnState, afterHold.activeUnitId, turnKey(afterHold)],
        'the live turn is untouched: nothing else was sent',
      ).toEqual(['Active', 'Waiting', live.unitId, turnKey(t)]);

      // The plan submitted after the clear reaches the server.
      await preQueueEndTurn(page, other, 'the re-plan');
      await expect
        .poll(async () => queued('the re-plan'), {
          message: `the re-planned READY row for unit ${other.unitId} reaches the server within ${QUEUE_WAIT_MS} ms of Start`,
          timeout: QUEUE_WAIT_MS,
        })
        .toBe(true);
      await expect(page.locator(LOCKED_STRIP), 'the re-plan shows locked').toHaveCount(1, {
        timeout: CLIENT_WAIT_MS,
      });

      // ANTI-VACUITY: the observer counts the confirm the menu's Clear plan row paints; B backs out
      // of it twice, sending nothing.
      await openMenu(page, other);
      await menuCursorTo(page, 'clear');
      await pressButton(page, 'A');
      await expect(
        page.locator(`${TACTICS.shell} ${CONFIRM_ROW}`),
        'the Clear plan row opens its confirm',
      ).toHaveCount(1, { timeout: CLIENT_WAIT_MS });
      expect(await confirmsSeen(), 'the observer counted the confirm row').toBeGreaterThan(0);
      await pressButton(page, 'B');
      await pressButton(page, 'B');
      await expect(page.locator(SHELL_MENU), 'B, B: back to idle').toHaveCount(0, {
        timeout: CLIENT_WAIT_MS,
      });
      expect(queued('after the confirm control'), 'the re-planned row is still held').toBe(true);

      expect(await keyCount(page), 'no keydown or keyup reached the page during the battle').toBe(
        0,
      );
      expect(await padTimestamp(page), 'the fake pad was used during the battle').toBeGreaterThan(
        padAtStart,
      );
    });
  });
