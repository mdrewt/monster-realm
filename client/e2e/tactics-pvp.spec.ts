import { execFileSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { Stack } from '../src/ui/contextStack';
import {
  armRowProbe,
  closeAll,
  deployByButtons,
  dpadCursorTo,
  menuCursorTo,
  openFaceToFace,
  pressButton,
  readEventTags,
  readRowProbe,
  readSecrecy,
  readTactics,
  TACTICS,
  type TacticsSnap,
  type Tile,
} from './controls';

// tactics-pvp.spec.ts — bt-15 increment A: the PvP pick, the PvP deploy panel and the secrecy of a
// two-browser PvP battle (BT15.1, BT15.4), driven by VIRTUAL BUTTONS only.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md §bt-15 BT15.1 / BT15.4; plan
// memory/projects/monster-realm-bt-15-plan.md §2 BT15.4 + §6 (H3 vacuous secrecy oracles, M3 e2e
// vacuity); the tester brief's items 17-19, T4 and its Lens fold (the fold wins).
//
// TWO BROWSERS (pvp-full.spec.ts): two `chromium.launch()` instances are two SpacetimeDB identities.
// A is the challenger and side A of every battle `dev_start_tactical_pvp(A, B, Some(1))` starts; B is
// side B. Both join with ONE starter, so every battle is format 1 (N > 1 is unit / boot tested:
// pvpModel / actionSheetModel / main.input / main.dispatch).
//
// SEEDING: owner SQL (`spacetime sql`) and owner calls (`spacetime call`), literal-shaped and
// charset-checked (tactics-wild.spec.ts's idioms); dev reducers are not page-callable. The two
// starters get DISTINCT random letter-only nicknames, so "B's page never shows A's monster" is a
// real oracle (two Flamelings would share a species name) with a positive control on A's page.
//
// ORDER: T1 (the pick), T2 (secrecy + AFK forfeit), T4 (the server refuses private tables to B —
// needs B's browser alive), T3 (disconnect: closes browser B). `test.describe.serial`.
//
// TIMING: the PvP turn window is read off the LIVE clock rows (owner SQL over `battle_clock`:
// `deadline_ms - window_open_ms`), never a copied constant; the bounds below are slack on top of it.
//
// HOOKS READ (DEV, API freeze): `__mrPvp.challengeFormats()`, `__mrPvp.battleById(id)`,
// `__mrPvp.declineChallenge(id)` (B declines T1's challenge: the decline UI is not under test here),
// `__mrTactics.battle()` (+ kind, format, strikes, deadlineMs), `secrecy()`, `armRowProbe()` /
// `rowProbe()`, `eventTags()`, `probeSubscribe(sql)`.
//
// RED REASON (tests-only tree): the Challenge confirm is Yes / No (openFaceToFace finds no size
// pick), `challengeFormats` / `secrecy` / `armRowProbe` / `rowProbe` / `eventTags` /
// `probeSubscribe` do not exist, `battle()` carries no kind / format / strikes, and a PvP Deploying
// battle builds the wild deploy panel (the opponent's roster as the pack, no lock, no countdown).
//
// CLEANUP: afterAll closes both browsers (try/catch: B is closed inside T3).

/** How long a join may take to show the player in the world. */
const JOIN_MS = 30_000;
/** How long a phase change (start, deploy → Active, Finished) may take to reach a page. */
const PHASE_MS = 15_000;
/** How long a lock / a row may take to reach the page after a press. */
const LOCK_ACK_MS = 10_000;
/** How long the other page is watched for a stray row after a lock / a pre-queue. */
const SECRECY_SETTLE_MS = 2_000;
/** The four AFK strikes that forfeit (design §9.1). */
const AFK_STRIKES = 4;
/** Slack per window on top of the live window length (the presentation pad, scheduling). */
const TURN_SLACK_MS = 10_000;
/** The disconnect finish bound: strictly below one 30 s PvP window, so a window expiry (an
 *  AutoPass strike) cannot be what finishes the battle. */
const DISCONNECT_FINISH_MS = 20_000;
/** Active must arrive at least this long before the deploy deadline: the 45 s auto-fill must never
 *  be what completes the deploy. */
const DEADLINE_MARGIN_MS = 5_000;

interface GameSnap {
  identity: string;
  ownMonsters: { monsterId: string; nickname: string; partySlot: number }[];
  stack: Stack;
}
interface ChallengeFormat {
  challengeId: string;
  challenger: string;
  target: string;
  format: number;
}
type Win = Window & {
  __game: () => GameSnap;
  __mrPvp: {
    challengeFormats(): ChallengeFormat[];
    declineChallenge(challengeId: string): Promise<void> | undefined;
    battleById(battleId: string): { outcome: string } | null;
  };
  __mrTactics: { probeSubscribe(sql: string): Promise<'applied' | 'error'> };
};

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as Win).__game();
    return { identity: g.identity, ownMonsters: g.ownMonsters, stack: g.stack };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as Partial<Win>;
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownMonsters.length > 0;
    },
    null,
    { timeout: JOIN_MS },
  );
}

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

function stdbTarget(label: string): { server: string; db: string } {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  return { server, db };
}

function runSql(query: string, label: string): string {
  const { server, db } = stdbTarget(label);
  try {
    return execFileSync('spacetime', ['sql', '-s', server, db, query], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime sql failed (CLI/infra): ${(err as Error).message}`);
  }
}

/** Owner SQL (literal-shaped statements only: letters, digits, spaces, `* = ( ) ,`). */
function ownerSql(query: string, label: string): string {
  if (!/^[A-Za-z0-9_ *=(),]+$/.test(query)) {
    throw new Error(`${label}: refusing a non-literal-shaped sql statement: ${query}`);
  }
  return runSql(query, label);
}

/** Sets a monster's nickname in `monster` and `monster_pub` by owner SQL. The only quoted literal
 *  this spec writes: a decimal id and a letters-only nickname, both checked. */
function setNickname(monsterId: string, nickname: string, label: string): void {
  if (!/^[0-9]+$/.test(monsterId) || !/^[A-Za-z]{4,16}$/.test(nickname)) {
    throw new Error(`${label}: refusing non-literal-shaped input ${monsterId} / ${nickname}`);
  }
  for (const table of ['monster', 'monster_pub']) {
    runSql(`UPDATE ${table} SET nickname = '${nickname}' WHERE monster_id = ${monsterId}`, label);
  }
}

function sqlRows(stdout: string, label: string): Record<string, string>[] {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const header = lines.shift();
  const separator = lines.shift();
  if (header === undefined || separator === undefined || !/^[-+]+$/.test(separator.trim())) {
    throw new Error(`${label}: unrecognised spacetime sql table: ${stdout.slice(0, 300)}`);
  }
  const cols = header.split('|').map((c) => c.trim());
  return lines.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/** The digits of an SQL cell (`123`, `(some = 123)`), or null (`(none = ())`, empty). */
const cellNumber = (cell: string | undefined): number | null => {
  const digits = /\d{4,}/.exec(cell ?? '');
  return digits === null ? null : Number(digits[0]);
};

/** `dev_start_tactical_pvp(challenger, opponent, Some(format))` as the module OWNER. */
function devStartPvp(aHex: string, bHex: string, format: number, label: string): void {
  const { server, db } = stdbTarget(label);
  const a = normId(aHex);
  const b = normId(bHex);
  if (
    !/^[0-9a-f]{64}$/.test(a) ||
    !/^[0-9a-f]{64}$/.test(b) ||
    !Number.isInteger(format) ||
    format < 1 ||
    format > 3
  ) {
    throw new Error(`${label}: refusing non-literal-shaped input ${aHex} / ${bHex} / ${format}`);
  }
  try {
    execFileSync(
      'spacetime',
      [
        'call',
        '-s',
        server,
        db,
        'dev_start_tactical_pvp',
        `"0x${a}"`,
        `"0x${b}"`,
        `{"some":${format}}`,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    throw new Error(`${label}: dev_start_tactical_pvp failed: ${(err as Error).message}`);
  }
}

/** The PvP turn window of `battleId`, from its LIVE clock rows: the largest `deadline_ms -
 *  window_open_ms` among rows with an open window (the deploy rows carry no open). */
async function liveWindowMs(battleId: string, label: string): Promise<number> {
  if (!/^[0-9]+$/.test(battleId)) throw new Error(`${label}: non-decimal battle id ${battleId}`);
  let longest = 0;
  await expect
    .poll(
      () => {
        const rows = sqlRows(
          ownerSql(
            `SELECT window_open_ms, deadline_ms FROM battle_clock WHERE battle_id = ${battleId}`,
            label,
          ),
          label,
        );
        for (const r of rows) {
          const open = cellNumber(r.window_open_ms);
          const deadline = cellNumber(r.deadline_ms);
          if (open !== null && deadline !== null && deadline > open) {
            longest = Math.max(longest, deadline - open);
          }
        }
        return longest;
      },
      { message: `${label}: a clock row with an open window`, timeout: PHASE_MS },
    )
    .toBeGreaterThan(0);
  return longest;
}

/** Polls `__mrTactics.battle()` until `pred` holds; returns that snapshot. */
async function waitTactics(
  p: Page,
  pred: (t: TacticsSnap) => boolean,
  timeout: number,
  message: string,
): Promise<TacticsSnap> {
  let last: TacticsSnap | null = null;
  await expect
    .poll(
      async () => {
        last = await readTactics(p);
        return last !== null && pred(last);
      },
      { message, timeout, intervals: [100, 250, 500] },
    )
    .toBe(true);
  // `last` is written inside the poll closure, which control-flow analysis does not follow.
  const seen = last as TacticsSnap | null;
  if (seen === null) throw new Error(`${message}: no battle`);
  return seen;
}

const activeUnit = (t: TacticsSnap): TacticsSnap['units'][number] | undefined =>
  t.units.find((u) => u.unitId === t.activeUnitId);
const turnKey = (t: TacticsSnap): string => `${t.battleId}:${t.round}:${t.turnIdx}`;

/** Lets a playing beat sequence drain (B skips it), so the next press is an input. */
async function settle(p: Page): Promise<void> {
  const playing = p.locator(`${TACTICS.shell}.tactics-battle--playing`);
  if ((await playing.count()) > 0) {
    await pressButton(p, 'B');
    await expect(playing, 'B drained the playback').toHaveCount(0, { timeout: 5_000 });
  }
}

/** Opens the own unit's command menu: the cursor on its tile, then A. */
async function openMenu(p: Page, me: Tile): Promise<void> {
  await settle(p);
  await dpadCursorTo(p, me);
  await pressButton(p, 'A');
  await expect(p.locator('.tactics-menu'), 'A on the own unit opens its menu').toHaveCount(1, {
    timeout: 5_000,
  });
}

/** Waits for the results panel, lets it auto-advance, and expects the world base back. */
async function throughResults(p: Page, label: string): Promise<void> {
  await expect(p.locator(TACTICS.results), `${label}: the results panel shows`).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(async () => (await snap(p)).stack.length, { timeout: 20_000 }).toBe(1);
  await expect(p.locator(TACTICS.results), `${label}: the results panel closed`).toBeHidden();
}

/** The whole seconds a `.tactics-countdown` line shows (its first number), or null. */
async function countdownSeconds(p: Page): Promise<number | null> {
  const el = p.locator(`${TACTICS.deploy} .tactics-countdown`);
  if ((await el.count()) !== 1) return null;
  const m = /(\d+)/.exec((await el.textContent()) ?? '');
  return m === null ? null : Number(m[1]);
}

/** Starts a format-1 PvP battle A vs B and waits for both deploy panels; returns its id, the
 *  deploy deadline (A's own clock, epoch ms) and the snapshot each side read. */
async function startPvp(
  a: Page,
  b: Page,
  label: string,
): Promise<{ battleId: string; deployDeadline: number }> {
  await closeAll(a);
  await closeAll(b);
  devStartPvp((await snap(a)).identity, (await snap(b)).identity, 1, label);
  const ta = await waitTactics(
    a,
    (t) => t.owner === 'deploy' && t.phase === 'Deploying',
    PHASE_MS,
    `${label}: A's deploy panel owns the frame`,
  );
  const tb = await waitTactics(
    b,
    (t) => t.owner === 'deploy' && t.battleId === ta.battleId,
    PHASE_MS,
    `${label}: B's deploy panel owns the frame for the same battle`,
  );
  expect([ta.kind, tb.kind], `${label}: a PvP battle on both pages`).toEqual(['Pvp', 'Pvp']);
  expect([ta.format, tb.format], `${label}: format 1`).toEqual([1, 1]);
  const deployDeadline = Number(ta.deadlineMs ?? Number.NaN);
  expect(
    Number.isFinite(deployDeadline),
    `${label}: A's own clock carries the deploy deadline`,
  ).toBe(true);
  return { battleId: ta.battleId, deployDeadline };
}

/** A random letters-only nickname (a distinct marker per run). */
const nick = (prefix: string): string =>
  `${prefix}${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;

test.describe
  .serial('bt-15 — PvP pick, deploy secrecy and AFK by virtual buttons (BT15.1, BT15.4)', () => {
    let browserA: Browser;
    let ctxA: BrowserContext;
    let pageA: Page;
    let browserB: Browser;
    let ctxB: BrowserContext;
    let pageB: Page;
    let idA = '';
    let idB = '';

    test.beforeAll(async () => {
      browserA = await chromium.launch();
      ctxA = await browserA.newContext();
      pageA = await ctxA.newPage();
      browserB = await chromium.launch();
      ctxB = await browserB.newContext();
      pageB = await ctxB.newPage();
      await pageA.goto('/');
      await pageB.goto('/');
      await Promise.all([ready(pageA), ready(pageB)]);
      idA = (await snap(pageA)).identity;
      idB = (await snap(pageB)).identity;
      expect(normId(idA), 'two browsers, two identities').not.toBe(normId(idB));
    });

    test.afterAll(async () => {
      try {
        await browserA?.close();
      } catch {
        // already closed on an error path
      }
      try {
        await browserB?.close();
      } catch {
        // closed inside T3; a double close is tolerated
      }
    });

    test('BT15-1-E2E-PICK: face to face, A on Challenge opens the size pick (a one-monster party: 1 vs 1, No, the first selected) and A sends the challenge with format 1; B declines [BT15-1]', async () => {
      // WRONG IMPL KILLED: the legacy Yes / No confirm (openFaceToFace polls the size rows and
      // fails on Yes / No); a pick that opens on No or offers a size the party cannot field; a
      // challenge sent with the whole party ignoring the pick (format would still be 1 here — the
      // N > 1 kill is the unit / boot suites'); no challenge row at all (the send never reached the
      // server: no A→B row in challengeFormats).
      test.setTimeout(120_000);
      expect((await snap(pageA)).ownMonsters, 'fixture: A joined with one monster').toHaveLength(1);
      await openFaceToFace(pageA, 'Challenge', undefined, pageB);
      let found: ChallengeFormat | undefined;
      await expect
        .poll(
          async () => {
            const rows = await pageA.evaluate(() =>
              (window as unknown as Win).__mrPvp.challengeFormats(),
            );
            found = rows.find(
              (r) => normId(r.challenger) === normId(idA) && normId(r.target) === normId(idB),
            );
            return found?.format ?? null;
          },
          { message: 'the A→B challenge row with format 1', timeout: PHASE_MS },
        )
        .toBe(1);
      // `found` is written inside the poll closure, which control-flow analysis does not follow.
      const challengeId = (found as ChallengeFormat | undefined)?.challengeId ?? '';
      expect(/^[0-9]+$/.test(challengeId), 'a decimal challenge id').toBe(true);
      await expect
        .poll(
          async () =>
            pageB.evaluate(
              (id) =>
                (window as unknown as Win).__mrPvp
                  .challengeFormats()
                  .some((r) => r.challengeId === id),
              challengeId,
            ),
          { message: 'B sees the challenge', timeout: PHASE_MS },
        )
        .toBe(true);
      await pageB.evaluate(
        (id) => (window as unknown as Win).__mrPvp.declineChallenge(id),
        challengeId,
      );
      await expect
        .poll(
          async () =>
            pageA.evaluate(
              (id) =>
                (window as unknown as Win).__mrPvp
                  .challengeFormats()
                  .some((r) => r.challengeId === id),
              challengeId,
            ),
          { message: 'the declined challenge leaves the open rows', timeout: PHASE_MS },
        )
        .toBe(false);
      await closeAll(pageA);
      await closeAll(pageB);
    });

    test('BT15-4-SECRECY-AFK: in a two-browser PvP battle B never receives A`s deploy row, A`s pre-queue or a pre-commit indicator, never shows A`s monster, the deploy panel paints no roster and a <=45 s countdown on both pages, both lock by Deploy before Active, and four AFK auto-passes of B forfeit the battle to A [BT15-4]', async () => {
      // WRONG IMPL KILLED: the PvP deploy panel built by the wild branch (the opponent's roster as
      // `.tactics-deploy-wilds`, A's nickname in B's DOM); a server that broadcasts the first lock
      // or a pre-queue (B's row probe counts a deploy / queue callback, B's `deploys` carries A's
      // row, B's `queues` a row, B's DOM a `.tactics-chip-lock`, B's turn bar changes); a lock that
      // is a client-side latch only (A's own row never reads locked); the Wild-only countdown (no
      // countdown on a PvP deploy panel); a deploy completed by the 45 s auto-fill instead of the
      // buttons (Active later than 5 s before the deadline); an AFK rule that strikes the ACTIVE
      // player (strikes.A > 0) or forfeits after a number of strikes other than four, or on the
      // wrong unit; a forfeit that awards the AFK side.
      test.setTimeout(600_000);
      const starterA = (await snap(pageA)).ownMonsters[0];
      const starterB = (await snap(pageB)).ownMonsters[0];
      if (starterA === undefined || starterB === undefined) throw new Error('no starters');
      const nickA = nick('Alfa');
      const nickB = nick('Bravo');
      setNickname(starterA.monsterId, nickA, 'nickname A');
      setNickname(starterB.monsterId, nickB, 'nickname B');
      for (const [p, m, n] of [
        [pageA, starterA.monsterId, nickA],
        [pageB, starterB.monsterId, nickB],
      ] as const) {
        await expect
          .poll(async () => (await snap(p)).ownMonsters.find((x) => x.monsterId === m)?.nickname, {
            message: `the nickname ${n} reaches its owner's page`,
            timeout: PHASE_MS,
          })
          .toBe(n);
      }

      const { battleId, deployDeadline } = await startPvp(pageA, pageB, 'T2');
      const deployA = pageA.locator(TACTICS.deploy);
      const deployB = pageB.locator(TACTICS.deploy);
      await expect(deployA).toBeVisible();
      await expect(deployB).toBeVisible();
      await expect(deployA, 'A`s panel names A`s own starter').toContainText(nickA);
      await expect(deployB, 'B`s panel names B`s own starter').toContainText(nickB);
      await expect(
        pageB.locator('.tactics-deploy-wilds'),
        'B`s panel paints no roster list (absent from the DOM)',
      ).toHaveCount(0);
      await expect(pageA.locator('.tactics-deploy-wilds'), 'nor A`s').toHaveCount(0);
      expect(
        (await pageB.evaluate(() => document.documentElement.outerHTML)).includes(nickA),
        'B`s whole document never contains A`s monster',
      ).toBe(false);
      expect(
        (await pageA.evaluate(() => document.documentElement.outerHTML)).includes(nickA),
        'positive control: A`s document does',
      ).toBe(true);
      for (const [who, p] of [
        ['A', pageA],
        ['B', pageB],
      ] as const) {
        await expect
          .poll(() => countdownSeconds(p), {
            message: `${who}: the deploy panel shows the countdown`,
            timeout: LOCK_ACK_MS,
          })
          .not.toBeNull();
        const s = (await countdownSeconds(p)) ?? 999;
        expect(s, `${who}: the countdown is the 45 s deploy window`).toBeLessThanOrEqual(45);
        expect(s, `${who}: and still running`).toBeGreaterThan(0);
      }

      // A deploys by buttons; B watches with its row probe armed.
      await armRowProbe(pageB);
      await deployByButtons(pageA, 'A deploys');
      await expect
        .poll(
          async () => {
            const s = await readSecrecy(pageA);
            return s.deploys.some((d) => normId(d.owner) === normId(s.me) && d.locked);
          },
          { message: 'A`s own deploy row reads locked', timeout: LOCK_ACK_MS },
        )
        .toBe(true);
      const rowsA = pageA.locator(`${TACTICS.deploy} .tactics-menu-row`);
      await expect
        .poll(
          async () =>
            `${await rowsA.count()}/${await pageA.locator(`${TACTICS.deploy} .tactics-menu-row[aria-disabled="true"]`).count()}`,
          { message: 'every A row is aria-disabled', timeout: LOCK_ACK_MS },
        )
        .toBe('2/2');
      await expect(
        pageA.locator(`${TACTICS.deploy} p.tactics-deploy-status`),
        'A shows the locked status line',
      ).toBeVisible();
      await pageB.waitForTimeout(SECRECY_SETTLE_MS);
      const secB = await readSecrecy(pageB);
      expect(
        secB.deploys.map((d) => [normId(d.owner) === normId(secB.me), d.locked]),
        'B holds exactly its own, unlocked deploy row — never A`s',
      ).toEqual([[true, false]]);
      expect((await readRowProbe(pageB)).deploy, 'B received no deploy row callback').toBe(0);
      expect(
        await pageB.locator(`${TACTICS.deploy} .tactics-menu-row[aria-disabled="true"]`).count(),
        'B`s panel is untouched by A`s lock',
      ).toBe(0);

      // B deploys by buttons: locked (or already through to Active), well before the deadline.
      await deployByButtons(pageB, 'B deploys');
      let bLockedOrActive = false;
      await expect
        .poll(
          async () => {
            const s = await readSecrecy(pageB);
            const t = await readTactics(pageB);
            bLockedOrActive =
              s.deploys.some((d) => normId(d.owner) === normId(s.me) && d.locked) ||
              t?.phase === 'Active';
            return bLockedOrActive;
          },
          { message: 'B`s own row locked (or the battle Active)', timeout: LOCK_ACK_MS },
        )
        .toBe(true);
      const activeA = await waitTactics(
        pageA,
        (t) => t.phase === 'Active' && t.battleId === battleId,
        PHASE_MS,
        'A reaches Active',
      );
      await waitTactics(pageB, (t) => t.phase === 'Active', PHASE_MS, 'B reaches Active');
      const activeAt = Date.now();
      expect(
        deployDeadline - activeAt,
        'Active arrived at least 5 s before the deploy deadline: the buttons deployed, not the auto-fill',
      ).toBeGreaterThanOrEqual(DEADLINE_MARGIN_MS);
      const unitA = activeA.units.find((u) => u.mine);
      const unitB = activeA.units.find((u) => !u.mine);
      if (unitA === undefined || unitB === undefined) throw new Error('one unit per side expected');
      const windowMs = await liveWindowMs(battleId, 'T2 window');

      // When B's unit is active, A pre-queues a non-empty [EndTurn] draft and submits it.
      let t = await readTactics(pageA);
      if (t !== null && activeUnit(t)?.unitId === unitA.unitId && t.turnState === 'Waiting') {
        await settle(pageA);
        await pressButton(pageA, 'Start'); // A's live turn: End Turn
      }
      t = await waitTactics(
        pageA,
        (x) => x.phase === 'Active' && x.turnState === 'Waiting' && x.activeUnitId === unitB.unitId,
        windowMs + TURN_SLACK_MS,
        'B`s unit becomes the active one',
      );
      const turnbarB = pageB.locator('.tactics-turnbar');
      await expect(turnbarB, 'B paints a turn bar').toHaveCount(1);
      const turnbarBefore = await turnbarB.innerHTML();
      await armRowProbe(pageB);
      const me = t.units.find((u) => u.unitId === unitA.unitId) as Tile;
      await openMenu(pageA, me);
      await menuCursorTo(pageA, 'end');
      await pressButton(pageA, 'A'); // appends the EndTurn chip
      await pressButton(pageA, 'Start'); // Submit the pre-queue
      await expect(
        pageA.locator('.tactics-chip-lock'),
        'A shows its committed pre-queue',
      ).not.toHaveCount(0, { timeout: LOCK_ACK_MS });
      await pageB.waitForTimeout(SECRECY_SETTLE_MS);
      expect((await readSecrecy(pageB)).queues, 'B holds no queue row').toEqual([]);
      expect((await readRowProbe(pageB)).queue, 'B received no queue row callback').toBe(0);
      await expect(
        pageB.locator('.tactics-chip-lock'),
        'B shows no pre-commit indicator',
      ).toHaveCount(0);
      expect(
        await turnbarB.innerHTML(),
        'B`s turn bar is byte-identical across A`s pre-queue',
      ).toBe(turnbarBefore);
      expect(
        (await pageB.evaluate(() => document.documentElement.outerHTML)).includes(nickA),
        'still no A monster in B`s document',
      ).toBe(false);

      // AFK: B presses nothing; A acts on every own turn until the battle finishes.
      const afkBound = AFK_STRIKES * (windowMs + TURN_SLACK_MS) + windowMs + 60_000;
      const afkStart = Date.now();
      let last: string | null = null;
      let maxStrikesB = 0;
      for (;;) {
        expect(Date.now() - afkStart, 'the AFK forfeit within its bound').toBeLessThan(afkBound);
        const snapA = await waitTactics(
          pageA,
          (x) =>
            x.phase === 'Finished' ||
            (x.phase === 'Active' &&
              x.turnState === 'Waiting' &&
              x.activeUnitId === unitA.unitId &&
              turnKey(x) !== last),
          2 * windowMs + TURN_SLACK_MS,
          'A`s next own turn or the finish',
        );
        if (snapA.phase === 'Finished') break;
        expect(snapA.strikes.A, 'A acts every turn: never struck').toBe(0);
        maxStrikesB = Math.max(maxStrikesB, snapA.strikes.B);
        last = turnKey(snapA);
        await settle(pageA);
        await pressButton(pageA, 'Start'); // End Turn (or a no-op when the READY plan ran)
      }
      const elapsed = Date.now() - afkStart;
      const tags = await readEventTags(pageA);
      const autoPasses = tags.filter((e) => e.tag === 'AutoPass');
      expect(autoPasses.length, 'exactly four AutoPass strikes').toBe(AFK_STRIKES);
      expect(
        autoPasses.every((e) => e.unit === unitB.unitId),
        'every AutoPass is on B`s unit',
      ).toBe(true);
      const end = tags.find((e) => e.tag === 'BattleEnd');
      expect(end?.how ?? null, 'the BattleEnd records how it ended').not.toBeNull();
      expect(maxStrikesB, 'B`s strikes climbed on the clock rows').toBeGreaterThanOrEqual(
        AFK_STRIKES - 1,
      );
      expect(elapsed, 'at least three full windows passed').toBeGreaterThanOrEqual(
        (AFK_STRIKES - 1) * windowMs,
      );
      const final = await readTactics(pageA);
      expect(final?.strikes.A ?? 0, 'A was never struck').toBe(0);
      expect(
        await pageA.evaluate(
          (id) => (window as unknown as Win).__mrPvp.battleById(id)?.outcome,
          battleId,
        ),
        'the AFK side B forfeits: side A wins',
      ).toBe('SideAWins');
      await throughResults(pageA, 'T2 A');
      await throughResults(pageB, 'T2 B');
    });

    test('BT15-4-PRIVATE-TABLES: from a fresh page of B`s browser (same identity, a new connection) the server refuses ad-hoc subscriptions to battle_deploy, battle_queue and battle_secret, while my_battle_deploy is applied [BT15-4]', async () => {
      // WRONG IMPL KILLED: a private table made public (a client could read the opponent's deploy,
      // queue or secret by subscribing to it directly — the exact leak the views exist to close);
      // a probe that reports 'error' for everything (the positive control my_battle_deploy must be
      // 'applied'). Replaces the vacuous `present` roster check (plan §6 H3).
      test.setTimeout(120_000);
      const probe = await ctxB.newPage();
      try {
        await probe.goto('/');
        await ready(probe);
        expect(normId((await snap(probe)).identity), 'the same identity as B').toBe(normId(idB));
        const sub = (sql: string): Promise<'applied' | 'error'> =>
          probe.evaluate((q) => (window as unknown as Win).__mrTactics.probeSubscribe(q), sql);
        for (const table of ['battle_deploy', 'battle_queue', 'battle_secret']) {
          expect(await sub(`SELECT * FROM ${table}`), `${table} is refused`).toBe('error');
        }
        expect(await sub('SELECT * FROM my_battle_deploy'), 'positive control: the view').toBe(
          'applied',
        );
      } finally {
        await probe.close();
      }
    });

    test('BT15-4-DISCONNECT: closing B`s only connection mid-battle finishes it for A within 20 s with side A winning and no AutoPass strike [BT15-4]', async () => {
      // WRONG IMPL KILLED: a disconnect that is not a forfeit (the battle waits for B's windows to
      // expire: four AutoPass strikes, minutes, never within 20 s); a disconnect awarded to the
      // disconnected side; a finish that records no reason.
      test.setTimeout(180_000);
      const { battleId } = await startPvp(pageA, pageB, 'T3');
      await deployByButtons(pageA, 'T3 A deploys');
      await deployByButtons(pageB, 'T3 B deploys');
      await waitTactics(
        pageA,
        (t) => t.phase === 'Active' && t.battleId === battleId,
        PHASE_MS,
        'T3: A reaches Active',
      );
      await waitTactics(pageB, (t) => t.phase === 'Active', PHASE_MS, 'T3: B reaches Active');
      const closedAt = Date.now();
      await browserB.close();
      await waitTactics(
        pageA,
        (t) => t.phase === 'Finished' && t.battleId === battleId,
        DISCONNECT_FINISH_MS,
        'T3: A sees the battle Finished within 20 s of the disconnect',
      );
      expect(Date.now() - closedAt, 'under one PvP window').toBeLessThan(DISCONNECT_FINISH_MS);
      const tags = await readEventTags(pageA);
      expect(
        tags.filter((e) => e.tag === 'AutoPass'),
        'no AutoPass strike',
      ).toEqual([]);
      expect(
        tags.find((e) => e.tag === 'BattleEnd')?.how ?? null,
        'the BattleEnd records how it ended',
      ).not.toBeNull();
      expect(
        await pageA.evaluate(
          (id) => (window as unknown as Win).__mrPvp.battleById(id)?.outcome,
          battleId,
        ),
        'the disconnected side B loses',
      ).toBe('SideAWins');
      await throughResults(pageA, 'T3 A');
    });
  });
