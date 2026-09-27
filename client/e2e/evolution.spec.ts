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

// evolution.spec.ts — a real browser drives the starter through a SINGLE-PATH auto-evolution
// (de-bloat Phase 3 gameplay smoke).
//
// SEEDING. The dev reducers are not callable from the page (recruit.spec.ts header), and none of
// them touches level/XP anyway. So the test raises the monster as the database OWNER through
// `spacetime sql` UPDATEs (the recruit.spec R3 / wallet-balance.spec owner-SQL precedent), one
// integer column per statement. Starter = Flameling (species 1). Seeded to level 20 with every
// essence pool at 0, exactly ONE authored edge out of species 1 is eligible
// (game-core/content/evolution_paths/000-core.ron):
//   edge 1 -> Pyroleo    : min_level 20, no other gate          ELIGIBLE
//   edge 2 -> Embersworn : Fire essence 150 + Friendly trust    not met
//   edge 3 -> Steamveil  : level 20 + Water essence 120         not met
// Single eligible path = auto-evolve on the next intent reducer (evolution.rs check_and_evolve).
// This spec deliberately exercises ONLY that single-path rule, so it stays valid across the
// planned multi-path player-prompt fix.
//
// TRIGGER. `care` (the raising overlay's Care button) tails into check_and_evolve
// (raising.rs care). A fresh identity's care cooldown anchor is 0, so the first care is allowed —
// deterministic, no battle RNG.
//
// CLEANUP. One browser, one context, one identity; afterAll closes the browser so the server's
// on_disconnect deletes the player row before golden.spec (presenceCount === 2) runs.

const FROM_NAME = 'Flameling'; // species 1 (content/species/000-core.ron)
const TO_NAME = 'Pyroleo'; // species 4
const TO_SPECIES_ID = 4;
const SEED_LEVEL = 20;
const SEED_XP = SEED_LEVEL * SEED_LEVEL * SEED_LEVEL; // xp_for_level = level^3 (rules.rs)

interface OwnMonster {
  monsterId: string;
  speciesId: number;
  nickname: string;
  level: number;
  partySlot: number;
}
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: OwnMonster[];
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return { identity: g.identity, ownAuthTile: g.ownAuthTile, ownMonsters: g.ownMonsters };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

/** Owner SQL, charset-validated before it reaches the shell (literal regexes only). */
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

/** Parse the CLI's pipe table (header, -+- separator, rows); an unknown shape THROWS. */
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

/** Blur whatever holds focus so the world owns it (main.ts worldHasFocus gates hotkeys). */
async function focusWorld(p: Page): Promise<void> {
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Text of the overlay whose h2 reads `title` ('' while hidden). recruit.spec box-root shape. */
async function overlayText(p: Page, title: string): Promise<string> {
  return p.evaluate((want) => {
    const h = Array.from(document.querySelectorAll('h2')).find((x) => x.textContent === want);
    const root = h?.parentElement?.parentElement;
    if (!root || root.style.display === 'none') return '';
    return root.textContent ?? '';
  }, title);
}

/** The box card's "<species> · Lv<n>" prefix, derived from the catalog entry itself. */
const boxCardPrefix = (species: string, level: number): string =>
  tf('box.card.stats', { species, level, current: 0, max: 0, percent: 0 }).split(' · HP')[0] ?? '';

test.describe
  .serial('Phase 3 smoke — single-path auto-evolution in a real browser', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let monsterId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('V1: seeded to Lv20, the evolution screen reports exactly one ready path (Pyroleo) and the box still shows Flameling', async () => {
      const s = await snap(page);
      expect(s.ownMonsters).toHaveLength(1);
      const starter = s.ownMonsters[0] as OwnMonster;
      expect(starter.speciesId).toBe(1);
      expect(/^[0-9]+$/.test(starter.monsterId), 'monsterId must be a decimal u64').toBe(true);
      monsterId = starter.monsterId;

      // Server truth (private monster) first, the owner-scoped projection (monster_pub) last.
      for (const table of ['monster', 'monster_pub']) {
        sql(`UPDATE ${table} SET xp = ${SEED_XP} WHERE monster_id = ${monsterId}`, 'V1 seed');
        sql(`UPDATE ${table} SET level = ${SEED_LEVEL} WHERE monster_id = ${monsterId}`, 'V1 seed');
      }
      await page.waitForFunction(
        (lvl) =>
          (window as unknown as { __game: () => GameSnap }).__game().ownMonsters[0]?.level === lvl,
        SEED_LEVEL,
        { timeout: 15_000 },
      );

      // The client evaluates the SAME shared eligibility predicate: one ready path, no picker.
      await focusWorld(page);
      await page.keyboard.press('KeyE');
      const readyNote = page.locator('[data-testid="evo-ready-note"]');
      await expect(readyNote).toHaveText(tf('evolution.card.ready', { species: TO_NAME }), {
        timeout: 10_000,
      });
      await expect(page.locator('[data-testid="evo-choice"]')).toHaveCount(0);

      // Nothing has fired yet: the box still lists the tier-0 form at the seeded level.
      await page.keyboard.press('KeyB'); // hide-switch sibling: replaces the evolution overlay
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix(FROM_NAME, SEED_LEVEL));
      await page.keyboard.press('Escape');
      await expect.poll(() => overlayText(page, t('box.title')), { timeout: 5_000 }).toBe('');
    });

    test('V2: Care (a real raising action) fires the single eligible path — the species change lands in the snapshot and the box', async () => {
      await focusWorld(page);
      await page.keyboard.press('KeyI');
      const care = page.getByRole('button', { name: t('raising.card.care'), exact: true });
      await care.click({ timeout: 10_000 });

      await page.waitForFunction(
        (sp) =>
          (window as unknown as { __game: () => GameSnap }).__game().ownMonsters[0]?.speciesId ===
          sp,
        TO_SPECIES_ID,
        { timeout: 15_000 },
      );
      const after = await snap(page);
      expect(after.ownMonsters).toHaveLength(1);
      expect(after.ownMonsters[0]?.monsterId).toBe(monsterId); // same monster, transformed
      expect(after.ownMonsters[0]?.level).toBe(SEED_LEVEL);

      await page.keyboard.press('Escape'); // close raising
      await focusWorld(page);
      await page.keyboard.press('KeyB');
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix(TO_NAME, SEED_LEVEL));
      await page.keyboard.press('Escape');
      await expect.poll(() => overlayText(page, t('box.title')), { timeout: 5_000 }).toBe('');
    });

    test('V3: the evolution notice names both forms, and OK acks it — the banner hides and the server queue is drained', async () => {
      // The banner sits below every overlay (z 60 vs 100); V2 closed them all.
      const banner = page.locator('#evolution-notice');
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#evolution-notice-label')).toHaveText(
        tf('evolutionNotice.reveal.anonymous', { from: FROM_NAME, to: TO_NAME }),
      );
      const ok = page.locator('#evolution-notice-ok');
      await expect(ok).toHaveText(t('evolutionNotice.ok'));

      const { identity } = await snap(page);
      const pendingFor = (): number =>
        sqlRows(sql('SELECT * FROM pending_evolution_notice', 'V3'), 'V3').filter(
          (r) => normId(r.owner_identity ?? '') === normId(identity),
        ).length;
      expect(pendingFor(), 'the reveal must be queued server-side before the ack').toBe(1);

      await ok.click();
      await expect(banner).toBeHidden({ timeout: 10_000 });
      await expect.poll(pendingFor, { timeout: 10_000 }).toBe(0);
    });
  });
