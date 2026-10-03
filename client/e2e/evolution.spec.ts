import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import { routedBindings } from '../src/input/router';
import { t, tf } from '../src/ui/i18n/resolver';
import { pressButton } from './controls';

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
// TRIGGER. `care` tails into check_and_evolve (raising.rs care). Since ctl-8c it is pressed on the
// Monsters frame's sheet: KeyB opens the frame on Storage (empty for a fresh identity), RB shows
// the Party (the router's RB is PageDown until ctl-11a: KeyE, the binding table's first RB key,
// still opens the evolution overlay through the legacy ladder), A opens the slot-0 starter's sheet
// on Summary, Down moves to Care and A sends it. A fresh identity's care cooldown anchor is 0, so
// the first care is allowed — deterministic, no battle RNG.
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
      // Close the evolution overlay first: opening it moved focus inside it, and the KeyB hotkey
      // only fires while the WORLD owns focus (main.ts worldHasFocus) or the box is already open.
      await page.keyboard.press('Escape');
      await expect(readyNote).toBeHidden({ timeout: 5_000 });
      await focusWorld(page);
      await page.keyboard.press('KeyB');
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix(FROM_NAME, SEED_LEVEL));
      await page.keyboard.press('Escape');
      await expect.poll(() => overlayText(page, t('box.title')), { timeout: 5_000 }).toBe('');
    });

    test('V2: Care on the Monsters sheet (KeyB, RB to the Party, A on the starter, Down to Care, A) fires the single eligible path — the species change lands in the snapshot and in the still-open frame`s live card', async () => {
      await focusWorld(page);
      await page.keyboard.press('KeyB');
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix(FROM_NAME, SEED_LEVEL));
      // RB as the router reads it (PageDown), not the binding table's first RB key (KeyE).
      await page.keyboard.press(routedBindings(DEFAULT_BINDINGS).buttons.RB[0]);
      await pressButton(page, 'A'); // the slot-0 starter's sheet, on Summary
      await pressButton(page, 'Down'); // Care
      await pressButton(page, 'A'); // care -> check_and_evolve

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

      // The Monsters frame is still open and its cards are live: the new form shows in it.
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix(TO_NAME, SEED_LEVEL));
      await page.keyboard.press('Escape'); // Start: back to the world
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
      // The caller's queue row SURVIVES an empty drain by design (evolution.rs
      // ack_evolution_notices doc), so the oracle is its `entries` cell: the CLI renders each
      // reveal as "(monster_id = N, from_species = A, to_species = B, ...)" and an empty Vec as
      // a blank cell (measured live).
      const entriesFor = (): string | undefined =>
        sqlRows(sql('SELECT * FROM pending_evolution_notice', 'V3'), 'V3').find(
          (r) => normId(r.owner_identity ?? '') === normId(identity),
        )?.entries;
      const queued = entriesFor() ?? '';
      expect(queued, 'the reveal must be queued server-side before the ack').toContain(
        `monster_id = ${monsterId}, from_species = 1, to_species = ${TO_SPECIES_ID}`,
      );

      await ok.click();
      await expect(banner).toBeHidden({ timeout: 10_000 });
      await expect.poll(entriesFor, { timeout: 10_000 }).toBe('');
    });
  });
