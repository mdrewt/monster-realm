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
  closeAll,
  dpadCursorTo,
  menuCursorTo,
  pressButton,
  readBandTiles,
  readOwnMonsters,
  readTactics,
  TACTICS,
  type TacticsSnap,
  type Tile,
} from './controls';

// tactics-wild.spec.ts — the tactical wild flow driven by VIRTUAL BUTTONS only (bt-12, BT12.5).
//
// Battle 1 (a pack of 1 — no deploy panel): move + attack with the forecast panel up, weaken the
// wild, recruit it adjacent, the results panel, the world. Battle 2 (a pack of 2): the deploy
// confirm screen lists the pack, X opens the editor, B backs out, A deploys; the wild hits us; Flee;
// the results panel; the damaged HP persists on the monster row. The party at join is ONE monster
// and `dev_start_tactical_wild` refuses a pack above the conscious party, so the pack ≥ 2 start is
// the SECOND battle's, after battle 1's recruit (moved into the party by owner SQL, an integer
// column) grew the party — the recorded BT12.5 interpretation.
//
// SEEDING (owner SQL + `spacetime call`, the encounter-battle / menu-flow precedents; dev reducers are
// not page-callable): the starter is made sturdy (300 HP, 250 defences) so no wild can KO it, and its
// attack is 1 so a Light hit never KOs a weakened wild; bait (item 1) is inserted into its bag. The
// bait is the only recruit lever the UI has: recruit odds are 80‰ base + up to 500‰ for missing HP +
// 150‰ bait, so a weakened wild is recruited on roughly 60-70 % of attempts; MAX_RECRUIT_ATTEMPTS
// and MAX_BATTLES bound the retries (P(all fail) < 1 %).
//
// Every battle action is a key press (`pressButton`): the shell's menu, bands, aims and Start; the
// DEV `__mrTactics` hook and the DOM are read, never written. No click: a focused button owns Space.
// CLEANUP: one browser; afterAll closes it (golden.spec's presence count).

const SEED_HP = 300;
const SEED_DEFENSE = 250;
const SEED_ATTACK = 1;
const BAIT_ITEM_ID = 1;
const BAIT_SEED = 9;
/** The wild is recruited (not hit again) at or under this share of its max HP. */
const WEAK_PCT = 45;
/** Battle-1 restarts (a KO'd wild, a timed-out loop) before the test gives up. */
const MAX_BATTLES = 4;
/** Own turns per battle before it is abandoned (Flee) and restarted. */
const MAX_OWN_TURNS = 16;
/** The longest one wait for the next own turn may take (the AI's turns plus the presentation pad). */
const TURN_WAIT_MS = 30_000;

interface GameSnap {
  identity: string;
  ownMonsters: { monsterId: string; speciesId: number; partySlot: number }[];
  stack: Stack;
}
type Win = Window & { __game: () => GameSnap; __mrDeploySeen?: number };

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

/** `dev_start_tactical_wild(player, Some(pack))` as the module OWNER (the CLI identity). Each
 *  reducer argument is its own JSON literal; an `Option<u8>` is `{"some": n}` (CLI 2.11, measured). */
function devStartWild(identityHex: string, pack: number, label: string): void {
  const { server, db } = stdbTarget(label);
  const hex = normId(identityHex);
  if (!/^[0-9a-f]{64}$/.test(hex) || !Number.isInteger(pack) || pack < 1 || pack > 3) {
    throw new Error(`${label}: refusing non-literal-shaped input ${identityHex} / ${pack}`);
  }
  try {
    execFileSync(
      'spacetime',
      ['call', '-s', server, db, 'dev_start_tactical_wild', `"0x${hex}"`, `{"some":${pack}}`],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch (err) {
    throw new Error(`${label}: dev_start_tactical_wild failed: ${(err as Error).message}`);
  }
}

const manhattan = (a: Tile, b: Tile): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const turnKey = (t: TacticsSnap): string => `${t.battleId}:${t.round}:${t.turnIdx}`;

/** Waits for the next OWN live turn (a `Waiting` state on one of our units, with a turn key other
 *  than `after`) or the Finished phase; returns the snapshot. */
async function waitOwnTurnOrEnd(p: Page, after: string | null): Promise<TacticsSnap> {
  await p.waitForFunction(
    (prev: string | null) => {
      const hook = (window as unknown as { __mrTactics?: { battle(): TacticsSnap | null } })
        .__mrTactics;
      const t = hook?.battle() ?? null;
      if (t === null) return false;
      if (t.phase === 'Finished') return true;
      if (t.phase !== 'Active' || t.turnState !== 'Waiting') return false;
      const unit = t.units.find((u) => u.unitId === t.activeUnitId);
      if (unit === undefined || !unit.mine) return false;
      return `${t.battleId}:${t.round}:${t.turnIdx}` !== prev;
    },
    after,
    { timeout: TURN_WAIT_MS },
  );
  const t = await readTactics(p);
  if (t === null) throw new Error('waitOwnTurnOrEnd: the battle vanished');
  return t;
}

/** The active own unit and the nearest conscious wild of `t`. */
function sides(t: TacticsSnap): {
  me: TacticsSnap['units'][number];
  wild: TacticsSnap['units'][number];
} {
  const me = t.units.find((u) => u.unitId === t.activeUnitId);
  if (me === undefined || !me.mine) throw new Error('sides: no active own unit');
  const wilds = t.units.filter((u) => u.side === 'B' && u.state === 'Active');
  wilds.sort((a, b) => manhattan(a, me) - manhattan(b, me));
  const wild = wilds[0];
  if (wild === undefined) throw new Error('sides: no conscious wild');
  return { me, wild };
}

/** Opens the active own unit's command menu: the cursor on its tile, then A. */
async function openMenu(p: Page, me: Tile): Promise<void> {
  await dpadCursorTo(p, me);
  await pressButton(p, 'A');
  await expect(p.locator('.tactics-menu'), 'A on the own unit opens its menu').toHaveCount(1, {
    timeout: 5_000,
  });
}

/** Move: the band tile nearest the wild, confirmed with A (a drafted, reversible Move). */
async function draftMoveToward(p: Page, wild: Tile): Promise<boolean> {
  await menuCursorTo(p, 'move');
  await pressButton(p, 'A');
  await expect(p.locator(TACTICS.bandTile).first(), 'the Move aim paints a band').toBeVisible({
    timeout: 5_000,
  });
  const band = await readBandTiles(p);
  const open = band.filter((tile) => !(tile.x === wild.x && tile.y === wild.y));
  open.sort((a, b) => manhattan(a, wild) - manhattan(b, wild));
  const dest = open[0];
  if (dest === undefined) {
    await pressButton(p, 'B'); // leave the aim
    return false;
  }
  await dpadCursorTo(p, dest);
  await pressButton(p, 'A');
  await expect(p.locator(TACTICS.bandTile), 'A on a band tile drafts the Move').toHaveCount(0, {
    timeout: 5_000,
  });
  return true;
}

/** Skills → the first offered skill → the forecast panel is up → A commits the whole draft. */
async function attackWithForecast(p: Page): Promise<string> {
  await menuCursorTo(p, 'skills');
  await pressButton(p, 'A');
  const skill = p
    .locator('.tactics-menu-row[data-row^="skill:"]:not([aria-disabled="true"])')
    .first();
  await expect(skill, 'the Skills sub-list offers a skill').toBeVisible({ timeout: 5_000 });
  const key = await skill.getAttribute('data-row');
  if (key === null) throw new Error('attackWithForecast: a skill row without a key');
  await menuCursorTo(p, key);
  await pressButton(p, 'A');
  const forecast = p.locator(TACTICS.forecast);
  await expect(forecast, 'aiming the skill shows the forecast panel').toHaveCount(1, {
    timeout: 5_000,
  });
  const text = (await forecast.textContent()) ?? '';
  expect(text, 'the forecast carries a hit percentage').toMatch(/\d+ ?%/);
  await pressButton(p, 'A'); // commits [draft…, Skill] on a live turn
  return text;
}

/** Recruit → the bait row → the aim (the forecast with the odds) → A. Returns false when the Recruit
 *  row is absent or greyed (not adjacent, no full budget). */
async function recruitWithBait(p: Page): Promise<boolean> {
  const row = p.locator(TACTICS.menuRow('recruit'));
  if ((await row.count()) !== 1 || (await row.getAttribute('aria-disabled')) === 'true') {
    return false;
  }
  await menuCursorTo(p, 'recruit');
  await pressButton(p, 'A');
  await menuCursorTo(p, `bait:${BAIT_ITEM_ID}`);
  await pressButton(p, 'A');
  await expect(p.locator(TACTICS.forecast), 'the recruit aim shows its odds').toHaveCount(1, {
    timeout: 5_000,
  });
  await pressButton(p, 'A');
  return true;
}

/** Waits for the results panel, lets it auto-advance, and expects the world base back. */
async function throughResults(p: Page, label: string): Promise<void> {
  await expect(p.locator(TACTICS.results), `${label}: the results panel shows`).toBeVisible({
    timeout: 20_000,
  });
  await expect(p.locator(`${TACTICS.results} [data-testid="battle-title"]`)).toBeVisible();
  await expect.poll(async () => (await snap(p)).stack.length, { timeout: 20_000 }).toBe(1);
  await expect(p.locator(TACTICS.results), `${label}: the results panel closed`).toBeHidden();
}

/** Battle 1's live-turn loop. Resolves true when the wild was recruited, false when the battle
 *  ended or stalled without a recruit (the caller restarts). */
async function fightToRecruit(p: Page): Promise<boolean> {
  let last: string | null = null;
  let forecasts = 0;
  for (let turn = 0; turn < MAX_OWN_TURNS; turn += 1) {
    const t = await waitOwnTurnOrEnd(p, last);
    if (t.phase === 'Finished')
      return t.units.some((u) => u.side === 'B' && u.state === 'Recruited');
    last = turnKey(t);
    const { me, wild } = sides(t);
    await openMenu(p, me);
    const adjacent = manhattan(me, wild) === 1;
    const weak = wild.curHp * 100 <= wild.maxHp * WEAK_PCT;
    if (adjacent && weak) {
      if (await recruitWithBait(p)) continue;
    }
    if (manhattan(me, wild) <= 2 && !weak) {
      await attackWithForecast(p);
      forecasts += 1;
      continue;
    }
    // Out of reach (or weak but not adjacent): step toward it, then end the turn.
    const drafted = await draftMoveToward(p, wild);
    if (!drafted) {
      await pressButton(p, 'B');
    }
    await pressButton(p, 'Start'); // the live draft plus EndTurn
  }
  expect(forecasts, 'at least one attack was forecast').toBeGreaterThan(0);
  return false;
}

/** Flee on a fresh own turn (the whole budget), once the wild has damaged us. */
async function takeAHitThenFlee(p: Page, baseline: Map<string, number>): Promise<void> {
  let last: string | null = null;
  for (let turn = 0; turn < MAX_OWN_TURNS; turn += 1) {
    const t = await waitOwnTurnOrEnd(p, last);
    if (t.phase === 'Finished') throw new Error('takeAHitThenFlee: the battle ended on its own');
    last = turnKey(t);
    const { me, wild } = sides(t);
    const hurt = t.units.some(
      (u) => u.mine && u.curHp < (baseline.get(String(u.unitId)) ?? u.maxHp),
    );
    await openMenu(p, me);
    if (hurt) {
      await menuCursorTo(p, 'flee');
      await pressButton(p, 'A');
      return;
    }
    if (manhattan(me, wild) > 1) await draftMoveToward(p, wild);
    await pressButton(p, 'Start');
  }
  throw new Error(`takeAHitThenFlee: no wild hit us in ${MAX_OWN_TURNS} own turns`);
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
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
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
          ['stat_attack', SEED_ATTACK],
        ] as const) {
          ownerSql(`UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${starterId}`, 'seed');
        }
      }
      const row = sqlRows(
        ownerSql(
          `SELECT monster_id, stat_hp, stat_attack FROM monster WHERE monster_id = ${starterId}`,
          'seed',
        ),
        'seed',
      ).find((r) => r.monster_id === starterId);
      expect(Number(row?.stat_hp), 'the starter row reads back the HP seed').toBe(SEED_HP);
      expect(Number(row?.stat_attack), 'the starter row reads back the attack seed').toBe(
        SEED_ATTACK,
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

    test('BT12-5-WILD-RECRUIT: a pack of one starts straight into the tactical shell (no deploy panel); by menu, bands, aims and Start alone the starter closes in, attacks with the forecast up, weakens the wild and recruits it adjacent; the results panel lists the recruit and the world returns', async () => {
      test.setTimeout(240_000);
      await closeAll(page);
      let recruited = false;
      for (let battle = 0; battle < MAX_BATTLES && !recruited; battle += 1) {
        devStartWild(identity, 1, `battle ${battle}`);
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
            const next = await waitOwnTurnOrEnd(page, null);
            if (next.phase === 'Active') {
              await openMenu(page, sides(next).me);
              await menuCursorTo(page, 'flee');
              await pressButton(page, 'A');
            }
          }
        }
        await throughResults(page, `battle ${battle}`);
      }
      expect(recruited, `a wild was recruited within ${MAX_BATTLES} battles`).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as Win).__mrDeploySeen ?? 0),
        'a pack of one never showed the deploy panel',
      ).toBe(0);
      await expect
        .poll(async () => (await readOwnMonsters(page)).length, { timeout: 15_000 })
        .toBe(2);
    });

    test('BT12-5-WILD-FLEE: with the recruit in the party a pack of two shows the deploy confirm listing both wilds; X opens the editor and B backs out; A deploys the remembered formation into the shell; after the pack damages us, Flee ends the battle fled and the lower HP persists on the monster row', async () => {
      test.setTimeout(240_000);
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
      const before = new Map((await readOwnMonsters(page)).map((m) => [m.monsterId, m.currentHp]));

      devStartWild(identity, 2, 'pack of two');
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
      ).toHaveCount(1, {
        timeout: 5_000,
      });
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

      // The unit → monster HP baseline: every own unit starts at its monster's current HP.
      const unitBaseline = new Map<string, number>();
      for (const u of t?.units ?? []) if (u.mine) unitBaseline.set(String(u.unitId), u.curHp);
      await takeAHitThenFlee(page, unitBaseline);
      await throughResults(page, 'pack of two');

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
