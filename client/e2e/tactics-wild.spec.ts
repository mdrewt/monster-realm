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
  attackByButtons,
  closeAll,
  draftMoveToward,
  endTurn,
  fleeByButtons,
  menuCursorTo,
  OWN_TURN_WAIT_MS,
  openMenu,
  pressButton,
  readOwnMonsters,
  readTactics,
  recruitByButtons,
  sides,
  TACTICS,
  type TacticsSnap,
  type Tile,
  throughResults,
  tileDistance,
  turnKey,
  waitExecuted,
  waitOwnTurnOrEnd,
} from './controls';

// tactics-wild.spec.ts — the tactical wild flow driven by VIRTUAL BUTTONS only (bt-12, BT12.5).
//
// Battle 1 (a pack of 1 — no deploy panel): move + attack with the forecast panel up, weaken the
// wild, recruit it adjacent, the results panel, the world. Battle 2 (a pack of 2): the deploy
// confirm screen lists the pack, X opens the editor, B backs out, A deploys; the wild hits us; Flee;
// the results panel; the damaged HP persists on the monster row.
//
// bt-16 (BT16.2) — HOW A BATTLE STARTS (named intentional change): `dev_start_tactical_wild` is
// DELETED by the cutover; every battle here starts the way a player's does, by walking onto grass
// (the (1,2)<->(2,2) shuttle of encounter-battle / recruit). The writer clamps the pack to the
// conscious party, so battle 1 — a ONE-monster party — is always a pack of 1 (asserted: one side-B
// unit, the deploy panel never shown). Battle 2 needs a pack >= 2: the party is two after battle 1's
// recruit is moved into it (owner SQL, an integer column), and zone 0 rolls packs 1/2 at 60/30 %
// (+10 % three, clamped to two): a pack of 1 is fled on its first own turn and the grass re-hunted,
// bounded by MAX_PACK_HUNTS, ONE budget shared by every attempt
// (P(30 packs of 1) = 0.6^30 ~ 2e-7).
//
// SEEDING (owner SQL, the encounter-battle / menu-flow precedents): the starter is made sturdy
// (300 HP, 250 defences) so no wild can KO it; bait (item 1) is inserted into its bag. An attack is
// committed only when the FORECAST's max damage is below the wild's HP (the shell's own numbers,
// read off the panel), so no hit ever KOs; the recruit is attempted adjacent once the wild is weak or
// the next hit would KO it. Recruit odds are 80‰ base + up to 500‰ for missing HP + 150‰ bait
// (roughly 50-70 % per attempt); MAX_OWN_TURNS and MAX_BATTLES bound the retries.
//
// Every battle action is a key press (`pressButton`): the shell's menu, bands, aims and Start; the
// DEV `__mrTactics` hook and the DOM are read, never written. No click: a focused button owns Space.
// The walk to the grass uses the `__game().step` hook exactly as encounter-battle.spec.ts does.
// CLEANUP: one browser; afterAll closes it (golden.spec's presence count).

const SEED_HP = 300;
/** The recruit's seeded HP: below the starter's SEED_HP so the recruit stays the wild's preferred
 *  target at equal distance — the second party slot's damage write-back keeps being exercised by
 *  the persistence oracle — yet far above what MAX_PACK_HUNTS hits of ~2–3 damage at SEED_DEFENSE
 *  can take, so it never faints and never clamps the pack to 1. */
const RECRUIT_SEED_HP = 120;
const SEED_DEFENSE = 250;
const BAIT_ITEM_ID = 1;
/** The wild is recruited (not hit again) at or under this share of its max HP. */
const WEAK_PCT = 45;
/** Battle-1 restarts (a KO'd wild, a kiting wild, a timed-out loop) before the test gives up. */
const MAX_BATTLES = 5;
/** Battle-2 restarts (a pack that never lands a hit) before the test gives up. */
const MAX_FLEE_BATTLES = 3;
/** Own turns per battle before it is abandoned (Flee) and restarted. */
const MAX_OWN_TURNS = 16;
/** Bait seeded into the bag: one per possible live Recruit (MAX_BATTLES battles × MAX_OWN_TURNS
 *  own turns). A Recruit debits one bait, success or not, and an empty bag drops the `bait:1` row
 *  (recruit.spec precedent). */
const BAIT_SEED = MAX_BATTLES * MAX_OWN_TURNS;
/** The longest one wait for the next own turn may take (the AI's turns plus the presentation pad;
 *  measured ~1 s), so a stalled battle fails on its named bound, not on the test timeout. */
const TURN_WAIT_MS = OWN_TURN_WAIT_MS;
/** bt-16: ONE budget of grass hunts shared by every BT12-5-WILD-FLEE attempt (not per attempt; a
 *  pack of 1 is fled and re-hunted): P(30 packs of 1) = 0.6^30 ~ 2e-7. Measured cost: ≤ ~11 s per
 *  pack-1 hunt including the flee and the results panel, so the whole budget fits the test
 *  timeout. */
const MAX_PACK_HUNTS = 30;
/** bt-16: shuttle steps per hunt; only the East step onto (2,2) rolls. 120 steps ~ 60 grass
 *  entries, P(no encounter) = 0.8^60 ~ 1.5e-6 (encounter-battle.spec MAX_WALK_STEPS). */
const MAX_WALK_STEPS = 120;
/** One step's bound: the 200 ms server drain + network + margin. */
const STEP_WAIT_MS = 8_000;
/** How long a hunted battle's tactical row may take to reach the page. */
const BATTLE_ROW_MS = 20_000;

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: { monsterId: string; speciesId: number; partySlot: number }[];
  ongoingBattle: { battleId: string } | null;
  stack: Stack;
}
type Win = Window & {
  __game: () => GameSnap & { step: (d: string) => void };
  __mrDeploySeen?: number;
};

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as Win).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ongoingBattle: g.ongoingBattle,
      stack: g.stack,
    };
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
    { timeout: 30_000 },
  );
}

function stdbTarget(label: string): { server: string; db: string } {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  return { server, db };
}

/** Owner SQL (literal-shaped statements only: letters, digits, spaces, `* = ( ) ,`). */
function ownerSql(query: string, label: string): string {
  const { server, db } = stdbTarget(label);
  if (!/^[A-Za-z0-9_ *=(),]+$/.test(query)) {
    throw new Error(`${label}: refusing a non-literal-shaped sql statement: ${query}`);
  }
  try {
    return execFileSync('spacetime', ['sql', '-s', server, db, query], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime sql failed (CLI/infra): ${(err as Error).message}`);
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

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

/** Tile-aware (1,2)<->(2,2) grass shuttle (encounter-battle / recruit shuttleDir). */
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South';
  if (tile.x === 1 && tile.y === 2) return 'East';
  if (tile.x === 2 && tile.y === 2) return 'West';
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

/** bt-16: walks the grass shuttle (one `__game().step` at a time, each bounded by STEP_WAIT_MS)
 *  until a battle's anchor is ongoing, then waits (≤ BATTLE_ROW_MS) for ITS tactical row; fails
 *  naming MAX_WALK_STEPS. Returns the battle's first tactical snapshot (Deploying or Active). */
async function huntWild(p: Page, label: string): Promise<TacticsSnap> {
  await closeAll(p);
  for (let i = 0; i < MAX_WALK_STEPS; i += 1) {
    const g = await snap(p);
    if (g.ongoingBattle !== null) break;
    if (g.ownAuthTile === null) throw new Error(`${label}: own tile vanished`);
    const from = g.ownAuthTile;
    await p.evaluate((d) => (window as unknown as Win).__game().step(d), shuttleDir(from));
    await p
      .waitForFunction(
        (f: Tile) => {
          const s = (window as unknown as Win).__game();
          if (s.ongoingBattle !== null) return true;
          return s.ownAuthTile !== null && (s.ownAuthTile.x !== f.x || s.ownAuthTile.y !== f.y);
        },
        from,
        { timeout: STEP_WAIT_MS },
      )
      .catch(() => undefined); // a wall bump: the next shuttle direction is re-derived
  }
  const battle = (await snap(p)).ongoingBattle;
  if (battle === null) {
    throw new Error(`${label}: no wild encounter within MAX_WALK_STEPS=${MAX_WALK_STEPS} steps`);
  }
  let t: TacticsSnap | null = null;
  await expect
    .poll(
      async () => {
        t = await readTactics(p);
        return t?.battleId ?? null;
      },
      {
        message: `${label}: the encounter's tactical row reaches the page within ${BATTLE_ROW_MS} ms`,
        timeout: BATTLE_ROW_MS,
      },
    )
    .toBe(battle.battleId);
  // `t` is written inside the poll closure, which control-flow analysis does not follow.
  const seen = t as TacticsSnap | null;
  if (seen === null) throw new Error(`${label}: no tactical row`);
  return seen;
}

/** How many attacks were committed with the forecast up, across the whole test. */
let forecastAttacks = 0;

/** Battle 1's live-turn loop. Resolves true when the wild was recruited, false when the battle
 *  ended or stalled without a recruit (the caller restarts). */
async function fightToRecruit(p: Page): Promise<boolean> {
  let last: string | null = null;
  for (let turn = 0; turn < MAX_OWN_TURNS; turn += 1) {
    const t = await waitOwnTurnOrEnd(p, last, TURN_WAIT_MS);
    if (t.phase === 'Finished')
      return t.units.some((u) => u.side === 'B' && u.state === 'Recruited');
    last = turnKey(t);
    const { me, enemy: wild } = sides(t);
    await openMenu(p, me);
    if (tileDistance(me, wild) === 1) {
      const weak = wild.curHp * 100 <= wild.maxHp * WEAK_PCT;
      // Recruit and Flee cost the whole budget: each is the FIRST and only action of a turn.
      if (weak && (await recruitByButtons(p, `bait:${BAIT_ITEM_ID}`))) continue;
      const hit = await attackByButtons(p, { allowKo: false, enemyHp: wild.curHp });
      if (hit === 'attacked') {
        forecastAttacks += 1;
        // The attack executed on the live turn; the turn is still ours: end it (the shell re-arms
        // once the unit's spent budget lands).
        await waitExecuted(p, t.events);
        await endTurn(p);
        continue;
      }
      // The next hit could KO it: it is weak enough to recruit, whatever WEAK_PCT says.
      if (hit === 'kills' && (await recruitByButtons(p, `bait:${BAIT_ITEM_ID}`))) continue;
      await endTurn(p); // nothing to do adjacent this turn: EndTurn
      continue;
    }
    // Out of reach: step toward it (a drafted, reversible Move), then end the turn.
    const drafted = await draftMoveToward(p, wild);
    if (!drafted) await pressButton(p, 'B'); // the Move aim had no band tile: leave the menu
    await endTurn(p); // the live draft plus EndTurn
  }
  return false;
}

/** Flee on a fresh own turn (the whole budget) once a wild has damaged us: true. False when no wild
 *  landed a hit within MAX_OWN_TURNS (the battle is then abandoned with a Flee anyway). */
async function takeAHitThenFlee(p: Page, baseline: Map<string, number>): Promise<boolean> {
  let last: string | null = null;
  for (let turn = 0; turn < MAX_OWN_TURNS; turn += 1) {
    const t = await waitOwnTurnOrEnd(p, last, TURN_WAIT_MS);
    if (t.phase === 'Finished') throw new Error('takeAHitThenFlee: the battle ended on its own');
    last = turnKey(t);
    const { me, enemy: wild } = sides(t);
    const hurt = t.units.some(
      (u) => u.mine && u.curHp < (baseline.get(String(u.unitId)) ?? u.maxHp),
    );
    await openMenu(p, me);
    if (hurt || turn === MAX_OWN_TURNS - 1) {
      await menuCursorTo(p, 'flee');
      await pressButton(p, 'A');
      return hurt;
    }
    if (tileDistance(me, wild) > 1) await draftMoveToward(p, wild);
    await endTurn(p);
  }
  return false;
}

/** The grass-hunt budget BT12-5-WILD-FLEE shares across its attempts: `left` hunts remain of
 *  MAX_PACK_HUNTS; `single` packs of 1 were met so far. */
interface PackHuntBudget {
  left: number;
  single: number;
}

/** bt-16: hunts until the grass opens a pack of >= 2 (Deploying with the deploy panel), spending
 *  the SHARED `budget` (one hunt per grass battle met). A pack of 1 (Active at once) is fled on its
 *  first own turn and its results passed, then the grass re-hunted; fails naming the hunts spent,
 *  the packs of 1 met and MAX_PACK_HUNTS once the budget is gone. */
async function huntPackOfTwo(p: Page, label: string, budget: PackHuntBudget): Promise<TacticsSnap> {
  while (budget.left > 0) {
    const hunt = MAX_PACK_HUNTS - budget.left;
    budget.left -= 1;
    const t = await huntWild(p, `${label} hunt ${hunt}`);
    if (t.phase === 'Deploying') return t;
    budget.single += 1;
    console.log(`[bt-16 ${label}] hunt ${hunt}: a pack of 1 (phase ${t.phase}) — fled, re-hunting`);
    await fleeByButtons(p);
    await throughResults(p, `${label} pack-of-one ${hunt}`);
  }
  throw new Error(
    `${label}: the shared hunt budget is spent — ${MAX_PACK_HUNTS - budget.left} hunts spent, ` +
      `${budget.single} packs of 1 met, of MAX_PACK_HUNTS=${MAX_PACK_HUNTS} — no pack of 2 met`,
  );
}

test.describe
  .serial('bt-12 BT12.5 — the tactical wild flow by virtual buttons', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let identity = '';
    let starterId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      // "The deploy panel was ever shown": counted by an observer installed before the app boots,
      // so a panel that flashes between two polls is still seen.
      await page.addInitScript(() => {
        const w = window as unknown as Win;
        w.__mrDeploySeen = 0;
        new MutationObserver(() => {
          for (const el of document.querySelectorAll('.tactics-deploy')) {
            if ((el as HTMLElement).style.display !== 'none')
              w.__mrDeploySeen = (w.__mrDeploySeen ?? 0) + 1;
          }
        }).observe(document, { subtree: true, childList: true, attributes: true });
      });
      await page.goto('/');
      await ready(page);
      const s = await snap(page);
      identity = s.identity;
      const starter = s.ownMonsters[0];
      if (!starter || !/^[0-9]+$/.test(starter.monsterId)) {
        throw new Error('beforeAll: no starter with a decimal monsterId');
      }
      starterId = starter.monsterId;
      for (const table of ['monster', 'monster_pub']) {
        for (const [col, val] of [
          ['stat_hp', SEED_HP],
          ['current_hp', SEED_HP],
          ['stat_defense', SEED_DEFENSE],
          ['stat_sp_defense', SEED_DEFENSE],
        ] as const) {
          ownerSql(`UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${starterId}`, 'seed');
        }
      }
      const row = sqlRows(
        ownerSql(
          `SELECT monster_id, stat_hp, stat_defense FROM monster WHERE monster_id = ${starterId}`,
          'seed',
        ),
        'seed',
      ).find((r) => r.monster_id === starterId);
      expect(Number(row?.stat_hp), 'the starter row reads back the HP seed').toBe(SEED_HP);
      expect(Number(row?.stat_defense), 'the starter row reads back the defence seed').toBe(
        SEED_DEFENSE,
      );
      ownerSql(
        `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${normId(identity)}, ${BAIT_ITEM_ID}, ${BAIT_SEED})`,
        'seed bait',
      );
      await expect
        .poll(async () => (await readOwnMonsters(page))[0]?.maxHp, { timeout: 15_000 })
        .toBe(SEED_HP);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('BT12-5-WILD-RECRUIT: a grass encounter with a one-monster party is a pack of one that starts straight into the tactical shell (no deploy panel); by menu, bands, aims and Start alone the starter closes in, attacks with the forecast up, weakens the wild and recruits it adjacent; the results panel lists the recruit and the world returns', async () => {
      // SURVIVING CHECK (bt-16): retired `devStartWild(identity, 1)` (the dev reducer is deleted) →
      // the battle starts on grass; its pack of one is asserted (one side-B unit, never a deploy panel).
      test.setTimeout(600_000);
      await closeAll(page);
      let recruited = false;
      for (let battle = 0; battle < MAX_BATTLES && !recruited; battle += 1) {
        const start = await huntWild(page, `battle ${battle}`);
        expect(start.kind, 'a grass encounter opens a WILD tactical battle').toBe('Wild');
        expect(start.phase, 'a pack of one is Active at once (no Deploying phase)').toBe('Active');
        expect(
          start.units.filter((u) => u.side === 'B').length,
          'a one-monster party always meets a pack of exactly one',
        ).toBe(1);
        await expect(page.locator(TACTICS.shell), 'the shell owns the frame').toBeVisible({
          timeout: 20_000,
        });
        await expect(page.locator(`${TACTICS.shell} [data-testid="battle-title"]`)).toBeVisible();
        await expect(page.locator(`${TACTICS.shell}[aria-modal="true"]`)).toHaveCount(1);
        recruited = await fightToRecruit(page);
        if (!recruited) {
          // Abandon a stalled battle: Flee on the next own turn, then let the results pass.
          const t = await readTactics(page);
          if (t !== null && t.phase === 'Active') {
            const next = await waitOwnTurnOrEnd(page, null, TURN_WAIT_MS);
            if (next.phase === 'Active') await fleeByButtons(page);
          }
        }
        const results = await throughResults(page, `battle ${battle}`);
        if (recruited) {
          expect(results, 'the results panel lists the recruit').toContain('joined your team!');
        }
      }
      expect(recruited, `a wild was recruited within ${MAX_BATTLES} battles`).toBe(true);
      expect(
        forecastAttacks,
        'at least one attack was committed with the forecast up',
      ).toBeGreaterThan(0);
      expect(
        await page.evaluate(() => (window as unknown as Win).__mrDeploySeen ?? 0),
        'a pack of one never showed the deploy panel',
      ).toBe(0);
      await expect
        .poll(async () => (await readOwnMonsters(page)).length, { timeout: 15_000 })
        .toBe(2);
    });

    test('BT12-5-WILD-FLEE: with the recruit in the party a grass pack of two shows the deploy confirm listing both wilds; X opens the editor and B backs out; A deploys the remembered formation into the shell; after the pack damages us, Flee ends the battle fled and the lower HP persists on the monster row', async () => {
      // SURVIVING CHECK (bt-16): retired `devStartWild(identity, 2)` (the dev reducer is deleted) →
      // the grass is hunted until it rolls a pack of 2 (`huntPackOfTwo`, bounded by MAX_PACK_HUNTS).
      test.setTimeout(1_200_000);
      const own = await readOwnMonsters(page);
      const recruit = own.find((m) => m.monsterId !== starterId);
      if (recruit === undefined) throw new Error('no recruit to field');
      for (const table of ['monster', 'monster_pub']) {
        ownerSql(
          `UPDATE ${table} SET party_slot = 1 WHERE monster_id = ${recruit.monsterId}`,
          'party',
        );
      }
      await expect
        .poll(
          async () =>
            (await readOwnMonsters(page)).filter((m) => m.partySlot >= 0 && m.partySlot < 6).length,
          {
            timeout: 15_000,
          },
        )
        .toBe(2);
      // The recruit is seeded sturdy too: pack-1 battles auto-deploy the remembered formation
      // (both monsters) and the wild targets the lowest-HP unit, so an unseeded recruit (~20 HP)
      // can faint across the pack-1 flees — and a fainted recruit clamps every later pack to 1.
      // RECRUIT_SEED_HP stays below the starter's SEED_HP, so the recruit is still the preferred
      // target at equal distance and its slot's damage write-back stays exercised.
      for (const table of ['monster', 'monster_pub']) {
        for (const [col, val] of [
          ['stat_hp', RECRUIT_SEED_HP],
          ['current_hp', RECRUIT_SEED_HP],
          ['stat_defense', SEED_DEFENSE],
          ['stat_sp_defense', SEED_DEFENSE],
        ] as const) {
          ownerSql(
            `UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${recruit.monsterId}`,
            'seed recruit',
          );
        }
      }
      await expect
        .poll(
          async () =>
            (await readOwnMonsters(page)).find((m) => m.monsterId === recruit.monsterId)?.maxHp,
          {
            message: 'the recruit reads back the HP seed RECRUIT_SEED_HP within 15000 ms',
            timeout: 15_000,
          },
        )
        .toBe(RECRUIT_SEED_HP);

      // ONE hunt budget across every attempt (MAX_PACK_HUNTS).
      const packHunts: PackHuntBudget = { left: MAX_PACK_HUNTS, single: 0 };
      let before = new Map<string, number>();
      // A pack that never lands a hit (two wilds kiting out of range) is fled and restarted.
      let hurt = false;
      for (let attempt = 0; attempt < MAX_FLEE_BATTLES && !hurt; attempt += 1) {
        const start = await huntPackOfTwo(page, `pack of two ${attempt}`, packHunts);
        // The pre-battle HP of THIS pack-2 battle (the write-back happens only at battle end), so
        // a pack-1 flee's damage can never satisfy the persistence oracle below.
        before = new Map((await readOwnMonsters(page)).map((m) => [m.monsterId, m.currentHp]));
        expect(start.kind, 'a grass encounter opens a WILD tactical battle').toBe('Wild');
        const deploy = page.locator(TACTICS.deploy);
        await expect(deploy, 'the deploy confirm screen shows').toBeVisible({ timeout: 20_000 });
        await expect(page.locator(TACTICS.wildRow), 'the pack is listed').toHaveCount(2);
        await expect(page.locator(`${TACTICS.deploy} [data-row="deploy"]`)).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await pressButton(page, 'X');
        await expect(
          page.locator(`${TACTICS.deploy} [data-row="slot-0"]`),
          'X opens the editor',
        ).toHaveCount(1, { timeout: 5_000 });
        await pressButton(page, 'B');
        await expect(
          page.locator(`${TACTICS.deploy} [data-row="edit"]`),
          'B backs out to the confirm screen',
        ).toHaveAttribute('aria-selected', 'true', { timeout: 5_000 });
        await pressButton(page, 'Up');
        await expect(page.locator(`${TACTICS.deploy} [data-row="deploy"]`)).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await pressButton(page, 'A');
        await expect(page.locator(TACTICS.shell), 'A deploys into the shell').toBeVisible({
          timeout: 20_000,
        });
        await expect(deploy).toBeHidden();
        const t = await readTactics(page);
        expect(t?.units.filter((u) => u.mine).length, 'both party monsters are fielded').toBe(2);

        // The unit → HP baseline: every own unit starts at its monster's current HP.
        const unitBaseline = new Map<string, number>();
        for (const u of t?.units ?? []) if (u.mine) unitBaseline.set(String(u.unitId), u.curHp);
        hurt = await takeAHitThenFlee(page, unitBaseline);
        const results = await throughResults(page, `pack of two ${attempt}`);
        expect(results, 'the results panel reads the fled outcome').toContain('Got away safely!');
      }
      expect(hurt, `a wild landed a hit within ${MAX_FLEE_BATTLES} pack battles`).toBe(true);

      const after = await readOwnMonsters(page);
      const damaged = after.filter((m) => m.currentHp < (before.get(m.monsterId) ?? 0));
      expect(damaged.length, 'a fled battle persists the damage taken').toBeGreaterThan(0);
      for (const m of damaged) {
        const row = sqlRows(
          ownerSql(
            `SELECT monster_id, current_hp FROM monster WHERE monster_id = ${m.monsterId}`,
            'hp',
          ),
          'hp',
        ).find((r) => r.monster_id === m.monsterId);
        expect(Number(row?.current_hp), 'the monster row carries the damaged HP').toBe(m.currentHp);
        expect(m.currentHp, 'strictly below the pre-battle HP').toBeLessThan(
          before.get(m.monsterId) ?? 0,
        );
      }
    });
  });
