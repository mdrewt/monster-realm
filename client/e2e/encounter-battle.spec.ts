import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { t, tf } from '../src/ui/i18n/resolver';

// encounter-battle.spec.ts — walk into grass, meet a wild monster, fight it to a WIN (de-bloat
// Phase 3 gameplay smoke).
//
// WHAT THIS ADDS OVER recruit.spec.ts. recruit R1 already proves grass -> encounter -> recruit
// button -> Flee, and R2 weakens + recruits; its R3 sees "Victory!" only when a win happened by
// accident. Nothing asserts that an attack's HP drop RENDERS, that a win GRANTS anything, or that
// the world RESUMES after the terminal frame is dismissed. Those three are this file's tests.
//
// SEEDING (owner SQL, the recruit.spec R3 / wallet-balance.spec precedent — the dev reducers are
// not page-callable). The starter is raised to level 7 with xp = 8^3 - 1, so ANY win levels it
// to 8 (battle_xp_reward is >= 1, xp.rs) — a VISIBLE XP grant in the box. The seed level MUST stay
// inside zone 0's encounter bands (Lv3-7 / Lv4-8, content/encounters/000-core.ron):
// game-core roll_encounter only draws entries whose band contains the PARTY level, so a Lv9+
// party meets nothing in zone 0 (measured: a Lv10 seed walked 120 grass steps without a roll). Its defense columns are
// raised so a zone-0 wild (Lv3-8) cannot KO it; attack is left natural, so a kill normally takes
// several hits and E1 sees an intermediate HP frame. Level 8 stays far below every evolution gate
// out of species 1 (min_level 20 / essence gates), so no evolution can fire here.
//
// Water wilds (Tidalin) resist Fire and are fled, exactly as recruit.spec does — bounded.
// No millisecond-class assertions: every wait is a multi-second waitForFunction.
//
// CLEANUP. One browser/context/identity; afterAll closes the browser (on_disconnect deletes the
// player row before golden.spec's presenceCount === 2).

const SEED_LEVEL = 7;
const SEED_XP = 8 * 8 * 8 - 1; // one short of level 8 (xp_for_level = level^3)
const SEED_DEFENSE = 250;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls. 120 steps ~ 60 grass entries,
 *  P(no encounter) = 0.8^60 ~ 1.5e-6 (recruit.spec MAX_WALK_STEPS arithmetic). */
const MAX_WALK_STEPS = 120;
/** Encounters to try before giving up; P(Water) = 7/22 each, so P(all Water in 8) ~ 1e-4. */
const MAX_ENCOUNTERS = 8;
/** Attacks per battle; at >= 1 net damage per hit this always covers a Lv<=8 wild's HP. */
const MAX_ATTACKS = 30;
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
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ongoingBattle: { battleId: string; outcome: string; turnNumber: number } | null;
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

/** Battle-card HP lines in DOM order: [0] opponent, [1] own (battleView appends the opponent
 *  card first; the box's "HP x/y (pct%)" has no " · " so it cannot match). */
async function battleHp(p: Page): Promise<{ cur: number; max: number; affinity: string }[]> {
  const texts = await p.locator('text=/HP \\d+\\/\\d+ · /').allTextContents();
  return texts.flatMap((s) => {
    const m = /HP (\d+)\/(\d+) · (\S+)/.exec(s);
    return m ? [{ cur: Number(m[1]), max: Number(m[2]), affinity: m[3] ?? '' }] : [];
  });
}

/** Walk the shuttle until a non-Water wild battle is ongoing (Water wilds are fled). */
async function huntNonWaterEncounter(p: Page): Promise<void> {
  for (let enc = 0; enc < MAX_ENCOUNTERS; enc++) {
    let found = false;
    for (let i = 0; i < MAX_WALK_STEPS && !found; i++) {
      const g = await snap(p);
      if (g.ongoingBattle !== null) {
        found = true;
        break;
      }
      if (g.ownAuthTile === null) throw new Error('hunt: own tile vanished');
      await stepOne(p, shuttleDir(g.ownAuthTile), g.ownAuthTile);
    }
    expect(found, `no wild encounter within ${MAX_WALK_STEPS} steps`).toBe(true);
    await expect.poll(async () => (await battleHp(p)).length, { timeout: 10_000 }).toBe(2);
    const [opp] = await battleHp(p);
    if (opp?.affinity !== 'Water') return;
    await p.getByRole('button', { name: t('battle.action.flee'), exact: true }).click();
    await p.waitForFunction(
      () => (window as unknown as Win).__game().ongoingBattle === null,
      null,
      {
        timeout: 15_000,
      },
    );
  }
  throw new Error(`hunt: only Water wilds in ${MAX_ENCOUNTERS} encounters`);
}

/** Click the first PvE skill button ("<name> (<power>) · <affinity>") and wait for the turn to
 *  advance or the battle to end. */
async function attackOnce(p: Page): Promise<void> {
  const before = (await snap(p)).ongoingBattle;
  if (before === null) throw new Error('attackOnce: no ongoing battle');
  await p
    .locator('button:visible')
    .filter({ hasText: /\(\d+\) · / })
    .first()
    .click({ timeout: 10_000 });
  await p.waitForFunction(
    (prev: number) => {
      const b = (window as unknown as Win).__game().ongoingBattle;
      return b === null || b.turnNumber > prev;
    },
    before.turnNumber,
    { timeout: 15_000 },
  );
}

async function overlayText(p: Page, title: string): Promise<string> {
  return p.evaluate((want) => {
    const h = Array.from(document.querySelectorAll('h2')).find((x) => x.textContent === want);
    const root = h?.parentElement?.parentElement;
    if (!root || root.style.display === 'none') return '';
    return root.textContent ?? '';
  }, title);
}

const boxCardPrefix = (species: string, level: number): string =>
  tf('box.card.stats', { species, level, current: 0, max: 0, percent: 0 }).split(' · HP')[0] ?? '';

test.describe
  .serial('Phase 3 smoke — grass encounter fought to a win', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let identity = '';
    let monsterId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      const s = await snap(page);
      identity = s.identity;
      const starter = s.ownMonsters[0];
      if (!starter || !/^[0-9]+$/.test(starter.monsterId)) {
        throw new Error('beforeAll: no starter with a decimal monsterId');
      }
      monsterId = starter.monsterId;
      for (const [col, val] of [
        ['stat_defense', SEED_DEFENSE],
        ['stat_sp_defense', SEED_DEFENSE],
      ] as const) {
        sql(`UPDATE monster SET ${col} = ${val} WHERE monster_id = ${monsterId}`, 'seed');
      }
      for (const table of ['monster', 'monster_pub']) {
        sql(`UPDATE ${table} SET xp = ${SEED_XP} WHERE monster_id = ${monsterId}`, 'seed');
        sql(`UPDATE ${table} SET level = ${SEED_LEVEL} WHERE monster_id = ${monsterId}`, 'seed');
      }
      await page.waitForFunction(
        (lvl) => (window as unknown as Win).__game().ownMonsters[0]?.level === lvl,
        SEED_LEVEL,
        { timeout: 15_000 },
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('E1: a grass encounter opens the battle UI, and a submitted attack renders the opponent HP drop', async () => {
      test.setTimeout(90_000);
      await huntNonWaterEncounter(page);
      await expect(
        page.getByRole('heading', { name: t('battle.title'), exact: true }),
      ).toBeVisible();

      const [oppBefore] = await battleHp(page);
      if (!oppBefore) throw new Error('E1: opponent HP line missing');
      await attackOnce(page);
      // The terminal frame keeps both cards, so this reads correctly even on a one-hit KO.
      await expect
        .poll(async () => (await battleHp(page))[0]?.cur ?? Number.NaN, { timeout: 10_000 })
        .toBeLessThan(oppBefore.cur);
    });

    test('E2: fighting on to a win shows Victory!, grants XP (visible level-up in the box) and currency (server wallet)', async () => {
      test.setTimeout(90_000);
      for (let i = 0; i < MAX_ATTACKS; i++) {
        if ((await snap(page)).ongoingBattle === null) break;
        await attackOnce(page);
      }
      expect((await snap(page)).ongoingBattle, `battle still ongoing after ${MAX_ATTACKS}`).toBe(
        null,
      );
      await expect(page.getByTestId('outcome-text')).toHaveText(t('battle.outcome.victory'), {
        timeout: 10_000,
      });

      await page.waitForFunction(
        (lvl) => (window as unknown as Win).__game().ownMonsters[0]?.level === lvl,
        SEED_LEVEL + 1,
        { timeout: 15_000 },
      );
      const mon = sqlRows(sql('SELECT * FROM monster_pub', 'E2'), 'E2').find(
        (r) => r.monster_id === monsterId,
      );
      expect(Number(mon?.xp), 'the win must add XP on top of the seed').toBeGreaterThan(SEED_XP);
      const wallet = sqlRows(sql('SELECT * FROM player_wallet', 'E2'), 'E2').find(
        (r) => normId(r.owner_identity ?? '') === normId(identity),
      );
      expect(Number(wallet?.balance), 'the win must credit currency').toBeGreaterThan(0);

      // Visible XP: the box card now reads Lv8. Escape first dismisses the terminal frame.
      await page.keyboard.press('Escape');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('KeyB');
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix('Flameling', SEED_LEVEL + 1));
      await page.keyboard.press('Escape');
      await expect.poll(() => overlayText(page, t('box.title')), { timeout: 5_000 }).toBe('');
    });

    test('E3: with the terminal frame dismissed, the world resumes — no battle UI and a step moves the character', async () => {
      await expect(page.getByTestId('outcome-text')).toBeHidden({ timeout: 5_000 });
      const s = await snap(page);
      expect(s.ongoingBattle).toBe(null);
      const from = s.ownAuthTile;
      if (from === null) throw new Error('E3: own tile missing');
      // Step onto FLOOR (never grass) so no new encounter can interfere.
      const dir =
        from.x === 2 && from.y === 2
          ? 'West'
          : from.x === 1 && from.y === 2
            ? 'North'
            : shuttleDir(from);
      await stepOne(page, dir, from);
      const after = await snap(page);
      expect(after.ongoingBattle).toBe(null);
      expect(after.ownAuthTile).not.toEqual(from);
    });
  });
