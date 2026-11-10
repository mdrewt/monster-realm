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
import { t, tf } from '../src/ui/i18n/resolver';
import {
  attackByButtons,
  awaitTacticalActive,
  draftMoveToward,
  endTurn,
  endTurnIfLive,
  fightToOutcome,
  fleeByButtons,
  moveThenAttackByButtons,
  openMenu,
  pressAccel,
  pressButton,
  readEventTags,
  readTactics,
  sides,
  TACTICS,
  type TacticsSnap,
  throughResults,
  tileDistance,
  turnKey,
  waitExecuted,
  waitOwnTurnOrEnd,
} from './controls';
import { sqlRows } from './stdb';

// encounter-battle.spec.ts — walk into grass, meet a wild monster, fight it to a WIN (de-bloat
// Phase 3 gameplay smoke).
//
// WHAT THIS ADDS OVER recruit.spec.ts. recruit R1 proves grass -> encounter -> the Recruit row;
// R2 weakens + recruits. Nothing else asserts that an attack's HP drop RENDERS, that a win GRANTS
// anything, or that the world RESUMES after the results. Those three are this file's tests. E0
// (ctl-6c) runs first, on the very battle E1 then fights: it reads PAINT ORDER (a hit-test with
// `inert` lifted, plus the computed z-index ordering) to check that the main menu opens over an
// Active battle, and the help it leads to, paint above that battle.
//
// bt-16 (BT16.2) — NAMED INTENTIONAL CHANGE: the grass now opens a TACTICAL wild battle (the 1v1
// command list, skill grid, "HP x/y · affinity" cards and `outcome-text` never appear for a live
// battle). SURVIVING CHECKS, each named at its assertion:
//   - E0: the battle frame's root is the tactical shell `.tactics-battle` (main.ts mounts it on the
//     one `battleView` frame id); the stack, inert, paint-order and focus oracles are unchanged.
//     Start at the tactical shell is End Turn (bt-11, BT11.6: battlePolicy `battleButton` leaves
//     Start to the shell), so the main menu is opened over the battle by the Monsters ACCELERATOR
//     (`B`, CTL11A.1: pop to the base, open the menu, pick Monsters) — Monsters is not battle-safe,
//     so the menu stays the top frame over the battle on its Monsters entry. Start still closes the
//     menu back to the battle. "Nothing was submitted" is read as the tactical row's round, turnIdx
//     and event count (the anchor's turnNumber never advances under tactics), on an own live turn
//     (a 300 s PvE window, so nothing advances on its own while the menu is up).
//   - E1: retired "Fight → skill cell → the opponent card's HP drop renders" → an attack committed
//     through Skills → the forecast panel → A makes the enemy unit's HP readout on the HUD (its FOE
//     info box) drop AND its `readTactics().units` HP drop.
//   - E1b (ci-fix-20261107T2101): the CORE tactical turn by buttons, which no spec drove before —
//     a foe out of every skill's reach from the start tile is hit in ONE turn by Move then Skill
//     from the ghost tile (`moveThenAttackByButtons`: the Move drafted, the menu re-opened, Skills
//     → the forecast → A; the commit is [Move, Skill]). Oracles: the unit stands on the ghost tile
//     after the commit, and the transcript since the turn began holds its `Moved` and an
//     `Executed`. WHY IT EXISTS: master went red on 8ac38368 in E2 — a Skittish Sproutlet kites
//     to distance 5 whenever the player ends adjacent, and the old fight helper only ever stepped
//     to the nearest tile and ended the turn, so 16 own turns passed with no hit. Non-lethal like
//     E1 (a KO would pay XP, level the starter to 8 and recompute its seeded stats before E2).
//   - E2: retired "`outcome-text` reads Victory!" → `fightToOutcome` by buttons → the results
//     title is the victory string (catalog `battle.outcome.victory`), the server's battle row is
//     `SideAWins`, the box shows Lv8 (the XP grant) and the wallet is credited (SQL).
//
// SEEDING (owner SQL, the recruit / wallet-balance precedent — no reducer is page-callable). The
// starter is raised to level 7 with xp = 8^3 - 1, so ANY win levels it to 8 — a VISIBLE XP grant in
// the box. The seed level MUST stay inside zone 0's encounter bands (Lv3-7 / Lv4-8): a Lv9+ party
// meets nothing in zone 0. HP 999 and defences 250 keep the starter standing through every battle
// here (battle-dpad's measured precedent). Attack is left on its natural roll for E1 (a hit that
// does NOT KO, so the HUD repaints the drop on an Active battle); E2 raises attack and sp_attack to
// 250 before its hunt so the starter ALWAYS wins on a landed hit. Level 8 stays far below every
// evolution gate out of species 1 (min_level 20 / essence gates).
//
// E1b adds a TEMPORARY speed seed: `stat_speed = SEED_SPEED` on monster + monster_pub (read back).
// Initiative is `stats.speed` descending, so the starter always acts first, and the spawn rows
// (y=1 vs y=5) put that opening own turn at distance >= 4 — out of every Flameling skill's reach
// (Ember range 2-3, Fire Fang 1) — deterministically. Stride length is the SPECIES base speed
// (content), so nothing else moves. E1b writes the natural speed back (read back) BEFORE its own
// final assertion, so E2 runs on CI's natural initiative (the wild may act first and kite).
//
// BOUNDS ARE NUMBERS, not damage arithmetic (tactical damage is game-core `tactics::resolve`):
// MAX_OWN_TURNS per battle, MAX_E1_BATTLES / MAX_E1B_BATTLES / MAX_WIN_BATTLES re-hunts, each wait
// bounded.
//
// CLEANUP. One browser/context/identity; afterAll closes the browser (on_disconnect deletes the
// player row before golden.spec's presenceCount === 2).

const SEED_LEVEL = 7;
const SEED_XP = 8 * 8 * 8 - 1; // one short of level 8 (xp_for_level = level^3)
const SEED_DEFENSE = 250;
const SEED_HP = 999;
/** E2's win seed (battle-dpad's precedent): any landed hit KOs a zone-0 wild. */
const SEED_ATTACK = 250;
/** Shuttle steps per hunt; only the East step onto (2,2) rolls. 120 steps ~ 60 grass entries,
 *  P(no encounter) = 0.8^60 ~ 1.5e-6 (recruit.spec MAX_WALK_STEPS arithmetic). */
const MAX_WALK_STEPS = 120;
/** Own turns per battle: a board is crossed in a few strides, and a kiting (Skittish) wild is
 *  answered on the first own turn it is in reach by `fightToOutcome`'s Move-then-Skill. 16 is
 *  slack: a stall now means a dead button or a changed AI, never a kiter. */
const MAX_OWN_TURNS = 16;
/** E1 battles to try for a NON-lethal landed hit (a lethal forecast is fled and re-hunted). */
const MAX_E1_BATTLES = 4;
/** E1b's initiative seed: far above any zone-0 wild's speed, so the starter always acts first and
 *  its opening own turn is at the spawn distance (>= 4, out of every Flameling skill's reach). */
const SEED_SPEED = 999;
/** E1b battles to try for a NON-lethal Move-then-Skill on the opening turn. A re-hunt means the
 *  opening geometry offered only a lethal forecast (`kills`: a KO would level the starter before
 *  E2) or no band tile a skill fires from (`none`: a choke map or a pack-mate in the way). */
const MAX_E1B_BATTLES = 6;
/** E2 battles to try for a WIN (a wild that auto-flees or a round cap ends a battle otherwise). */
const MAX_WIN_BATTLES = 3;
const STEP_WAIT_MS = 8_000;
/** How long the HUD may take to repaint the enemy's HP after the hit lands. */
const HUD_REPAINT_MS = 10_000;

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

/** Walk the shuttle until a wild battle is ongoing (a battle already ongoing is returned as is, so
 *  E1 continues E0's battle), then wait for its tactical row to be Active (a one-monster party is a
 *  pack of one: Active at once; `awaitTacticalActive` deploys by buttons if it ever is not). */
async function huntEncounter(p: Page, label: string): Promise<TacticsSnap> {
  let found = false;
  for (let i = 0; i < MAX_WALK_STEPS && !found; i++) {
    const g = await snap(p);
    if (g.ongoingBattle !== null) {
      found = true;
      break;
    }
    if (g.ownAuthTile === null) throw new Error('hunt: own tile vanished');
    await stepOne(p, shuttleDir(g.ownAuthTile), g.ownAuthTile).catch(() => undefined);
  }
  expect(
    (await snap(p)).ongoingBattle,
    `no wild encounter within ${MAX_WALK_STEPS} steps`,
  ).not.toBeNull();
  const active = await awaitTacticalActive(p, label);
  expect(active.phase, `${label}: the encounter is an Active tactical battle`).toBe('Active');
  expect(active.kind, `${label}: a WILD tactical battle`).toBe('Wild');
  return active;
}

/** The SQL outcome of battle `battleId`: true when the server's row names SideAWins (the variant
 *  prints bare on 2.6.0 and snake_case-tagged on 2.8.1 — recruit.spec R3's rendering-agnostic match). */
function sqlSideAWins(battleId: string, label: string): boolean {
  if (!/^[0-9]+$/.test(battleId)) throw new Error(`${label}: non-decimal battle id ${battleId}`);
  const out = sql(`SELECT * FROM battle WHERE battle_id = ${battleId}`, label);
  if (!out.includes(battleId))
    throw new Error(`${label}: no battle row ${battleId}: ${out.slice(0, 300)}`);
  return /side_?a_?wins/i.test(out);
}

async function overlayText(p: Page, title: string): Promise<string> {
  return p.evaluate((want) => {
    const h = Array.from(document.querySelectorAll('h2')).find((x) => x.textContent === want);
    const root = h?.parentElement?.parentElement;
    if (!root || root.style.display === 'none') return '';
    return root.textContent ?? '';
  }, title);
}

/** The enemy unit's HP as the HUD's FOE info box paints it (tactics/hud.ts `.tactics-info-hp`,
 *  "HP cur/max"): its first number, or NaN when the row is not painted. */
const hudEnemyHp = (p: Page, unitId: number): Promise<number> =>
  p.evaluate((id) => {
    const el = document.querySelector(
      `.tactics-battle .tactics-info--foe .tactics-info-row[data-unit-id="${id}"] .tactics-info-hp`,
    );
    const m = /(\d+)/.exec(el?.textContent ?? '');
    return m === null ? Number.NaN : Number(m[1]);
  }, unitId);

/** A viewport point the layering probes hit-test. */
interface Point {
  x: number;
  y: number;
}
/** The read-only `__game()` fields E0 reads beyond `GameSnap`. */
type StackWin = Window & { __game: () => { stack: Stack; navActive: string | null } };

const readStack = (p: Page): Promise<Stack> =>
  p.evaluate(() => (window as unknown as StackWin).__game().stack);
const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as StackWin).__game().navActive);

/** bt-16: the battle frame's root is the tactical shell (`.tactics-battle`, tacticsBattle.ts: the
 *  constructed root that holds the frame title), shown while its display is not none. */
const BATTLE_ROOT = '.tactics-battle';
const battleRootShown = (p: Page): Promise<boolean> =>
  p.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    return root !== null && root.style.display !== 'none';
  }, BATTLE_ROOT);

/** The layering probes: the viewport centre, the centre of the battle title and a point near the
 *  top-left corner, all inside the viewport. Taken while the battle title is on screen. */
const probePoints = (p: Page): Promise<Point[]> =>
  p.evaluate((sel) => {
    const title = document.querySelector(`${sel} [data-testid="battle-title"]`);
    if (title === null) throw new Error('probe: the battle title is missing');
    const r = title.getBoundingClientRect();
    return [
      { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      { x: 12, y: 12 },
    ];
  }, BATTLE_ROOT);

/** Which overlay owns the topmost element under each probe: 'help', 'menu', 'battle', or the stray
 *  element's tag and id (classified in that order).
 *
 *  'paint' answers what is PAINTED on top, i.e. what the player sees. ui/overlayA11y.ts marks
 *  every frame beneath the top one `inert`, and Chromium drops inert subtrees from hit-testing, so
 *  a plain elementFromPoint skips the suspended battle even where it paints over the menu
 *  (measured). So 'paint' removes `inert` from every element carrying it, hit-tests every point,
 *  then restores exactly those attributes in a `finally`, all in ONE synchronous evaluate: no page
 *  script, task or frame runs while it is lifted, and a throw cannot leave the page altered.
 *
 *  'pointer' is the plain, inert-respecting hit-test: what a click would land on. It is NOT a
 *  layering oracle. */
const hitOwners = (p: Page, points: Point[], mode: 'paint' | 'pointer'): Promise<string[]> =>
  p.evaluate(
    ({ pts, lift, sel }) => {
      const battleRoot = document.querySelector(sel);
      const menu = document.getElementById('menu-overlay');
      const help = document.getElementById('help-overlay');
      const lifted: { el: Element; value: string }[] = lift
        ? Array.from(document.querySelectorAll('[inert]'), (el) => ({
            el,
            value: el.getAttribute('inert') ?? '',
          }))
        : [];
      try {
        for (const { el } of lifted) el.removeAttribute('inert');
        return pts.map(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (el === null) return 'nothing';
          if (help?.contains(el)) return 'help';
          if (menu?.contains(el)) return 'menu';
          if (battleRoot?.contains(el)) return 'battle';
          return `other:${el.tagName.toLowerCase()}#${el.id}`;
        });
      } finally {
        for (const { el, value } of lifted) el.setAttribute('inert', value);
      }
    },
    { pts: points, lift: mode === 'paint', sel: BATTLE_ROOT },
  );

/** Whether the battle root carries `inert` (a frame suspended under another one). */
const battleInert = (p: Page): Promise<boolean> =>
  p.evaluate((sel) => document.querySelector(sel)?.hasAttribute('inert') === true, BATTLE_ROOT);

/** One overlay root's computed `position` and numeric `z-index` ('auto' or a missing root reads as
 *  NaN, which no ordering assertion accepts). */
interface Layer {
  position: string;
  z: number;
}
interface Layers {
  battle: Layer;
  menu: Layer;
  help: Layer;
}

/** The stacking facts of the battle root, #menu-overlay and #help-overlay. */
const layers = (p: Page): Promise<Layers> =>
  p.evaluate((sel) => {
    const read = (el: Element | null | undefined): Layer => {
      if (el === null || el === undefined) return { position: 'missing', z: Number.NaN };
      const cs = getComputedStyle(el);
      return { position: cs.position, z: cs.zIndex === 'auto' ? Number.NaN : Number(cs.zIndex) };
    };
    return {
      battle: read(document.querySelector(sel)),
      menu: read(document.getElementById('menu-overlay')),
      help: read(document.getElementById('help-overlay')),
    };
  }, BATTLE_ROOT);

/** The second, independent layering oracle: all three roots are `position: fixed` (so each one's
 *  z-index applies) and the top overlay's computed z-index is strictly above the battle's. Only the
 *  ORDER is pinned, never a literal value. */
function expectStackedAbove(l: Layers, top: 'menu' | 'help'): void {
  expect(
    { battle: l.battle.position, menu: l.menu.position, help: l.help.position },
    'every overlay root is position:fixed',
  ).toEqual({ battle: 'fixed', menu: 'fixed', help: 'fixed' });
  expect(l[top].z, `the #${top}-overlay z-index is above the battle root's`).toBeGreaterThan(
    l.battle.z,
  );
}

/** Whether keyboard focus sits inside the menu overlay or inside the battle root. */
const focusInside = (p: Page, where: 'menu' | 'battle'): Promise<boolean> =>
  p.evaluate(
    ({ w, sel }) => {
      const root =
        w === 'menu' ? document.getElementById('menu-overlay') : document.querySelector(sel);
      return root?.contains(document.activeElement) === true;
    },
    { w: where, sel: BATTLE_ROOT },
  );

/** Moves the main menu's cursor with Up until `navActive` is `key`, bounded by MAX_MENU_MOVES. */
const MAX_MENU_MOVES = 8;
async function menuTo(p: Page, key: string): Promise<void> {
  for (let moves = 0; moves < MAX_MENU_MOVES; moves++) {
    const at = await navActive(p);
    if (at === key) return;
    await pressButton(p, 'Up');
    await expect
      .poll(() => navActive(p), { timeout: 3_000, message: `menuTo(${key}): Up from ${at}` })
      .not.toBe(at);
  }
  throw new Error(`menuTo(${key}): not reached in MAX_MENU_MOVES=${MAX_MENU_MOVES} presses`);
}

/** bt-16: opens the main menu over the Active tactical battle with the Monsters accelerator
 *  (Start is the shell's End Turn): the menu opens over the battle and Monsters, not battle-safe,
 *  opens nothing above it. Should a leaf ever open, ONE B steps back to the menu. Asserts the stack
 *  is exactly [battle, menu over that battle]. */
async function openMenuOverBattle(p: Page, battleId: string): Promise<void> {
  await pressAccel(p, 'B');
  await expect(p.locator('#menu-overlay')).toBeVisible({ timeout: 5_000 });
  const stack = await readStack(p);
  if (stack.length > 2) await pressButton(p, 'B');
  await expect
    .poll(() => readStack(p), { timeout: 5_000 })
    .toEqual([
      { kind: 'battle', battleId },
      { kind: 'screen', id: 'menuView', overBattle: battleId },
    ]);
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
      for (const table of ['monster', 'monster_pub']) {
        for (const [col, val] of [
          ['stat_defense', SEED_DEFENSE],
          ['stat_sp_defense', SEED_DEFENSE],
          ['stat_hp', SEED_HP],
          ['current_hp', SEED_HP],
          ['xp', SEED_XP],
          ['level', SEED_LEVEL],
        ] as const) {
          sql(`UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${monsterId}`, 'seed');
        }
      }
      // ANTI-NO-OP: read the seed back. A silent zero-row UPDATE would leave the starter on its
      // natural roll: a fainted starter meets no encounter, with no pointer to the cause.
      const row = sqlRows(
        sql(`SELECT * FROM monster WHERE monster_id = ${monsterId}`, 'seed'),
        'seed',
      ).find((r) => r.monster_id === monsterId);
      expect(row, 'the starter row is visible to the CLI').toBeDefined();
      expect(Number(row?.stat_hp), 'the starter row reads back the HP seed').toBe(SEED_HP);
      expect(Number(row?.stat_defense), 'the starter row reads back the defense seed').toBe(
        SEED_DEFENSE,
      );
      await page.waitForFunction(
        (lvl) => (window as unknown as Win).__game().ownMonsters[0]?.level === lvl,
        SEED_LEVEL,
        { timeout: 15_000 },
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('E0 (CTL6C.1): the main menu opened over an Active tactical battle paints over it (hit-tested), Options > How to play paints help over both, B goes back to the menu and Start back to the untouched battle (bt-16: the frame root is the tactical shell; the menu opens by its accelerator)', async () => {
      // WRONG IMPL KILLED: a menu or help painted UNDER the battle shell, a z-index not above the
      // battle's (a menu the player cannot see while it takes every key). MEASURED TRAP: the
      // battle under the menu is `inert` (ui/overlayA11y.ts) and Chromium drops inert subtrees
      // from hit-testing, so the 'paint' probe lifts `inert` to read paint order, and
      // expectStackedAbove pins the computed z-index order as a second oracle. Also: an open that
      // hides the battle to show the menu; a menu not stamped over the battle (the stack shape);
      // focus left in the battle under the menu; a close that does not return to the battle (the
      // stack, the focus and the probes); and a menu round trip that submits or skips a turn (the
      // tactical round, turnIdx and event count are unchanged). E1 continues on this SAME battle.
      test.setTimeout(120_000);
      const active = await huntEncounter(page, 'E0');
      // SURVIVING CHECK (bt-16): the frame root is `.tactics-battle` (was the 1v1 battleView).
      await expect(page.locator(`${BATTLE_ROOT} [data-testid="battle-title"]`)).toHaveText(
        t('battle.title'),
      );
      const id = active.battleId;
      // An own live turn: the PvE window is 300 s, so nothing advances while the menu is up.
      const own = await waitOwnTurnOrEnd(page, null, 15_000);
      expect(own.phase, 'E0: an own live turn on an Active battle').toBe('Active');
      const all = (owner: string): string[] => [owner, owner, owner];
      const points = await probePoints(page);
      expect(points, 'three layering probes').toHaveLength(3);

      // ANTI-VACUITY: before the menu every probe lands in the battle shell.
      await expect
        .poll(() => hitOwners(page, points, 'paint'), { timeout: 5_000 })
        .toEqual(all('battle'));
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: id }]);
      await expect.poll(() => focusInside(page, 'battle'), { timeout: 5_000 }).toBe(true);

      // SURVIVING CHECK (bt-16): retired "Start opens the menu" (Start is the shell's End Turn,
      // BT11.6) → the Monsters accelerator opens the main menu over the battle.
      await openMenuOverBattle(page, id);
      // ANTI-VACUITY (the measured trap): the battle under the menu is suspended `inert`.
      expect(await battleInert(page), 'the battle under the menu is inert').toBe(true);
      await expect
        .poll(() => hitOwners(page, points, 'paint'), { timeout: 5_000 })
        .toEqual(all('menu'));
      expectStackedAbove(await layers(page), 'menu');
      await expect
        .poll(() => hitOwners(page, points, 'pointer'), { timeout: 5_000 })
        .toEqual(all('menu'));
      expect(await battleRootShown(page), 'the battle stays shown under the menu').toBe(true);
      expect((await snap(page)).ongoingBattle?.battleId, 'the same battle goes on').toBe(id);
      await expect.poll(() => focusInside(page, 'menu'), { timeout: 5_000 }).toBe(true);

      // How to play: help opens above the menu over the battle, and is what is seen.
      // uif-15c (UIF15C.4, named intentional change): How to play is a root entry; no group A/Down
      // step. Was: menuTo 'options', A (entered on How to play), A.
      await menuTo(page, 'help');
      await expect.poll(() => navActive(page), { timeout: 5_000 }).toBe('help');
      await pressButton(page, 'A');
      await expect(page.locator('#help-overlay')).toBeVisible({ timeout: 5_000 });
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([
          { kind: 'battle', battleId: id },
          { kind: 'screen', id: 'menuView', overBattle: id },
          { kind: 'screen', id: 'helpView', overBattle: id },
        ]);
      await expect
        .poll(() => hitOwners(page, points, 'paint'), { timeout: 5_000 })
        .toEqual(all('help'));
      expectStackedAbove(await layers(page), 'help');
      expect(await battleRootShown(page), 'the battle stays shown under help').toBe(true);

      // B closes help alone: the menu is what the player sees again.
      await pressButton(page, 'B');
      await expect(page.locator('#help-overlay')).toBeHidden({ timeout: 5_000 });
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([
          { kind: 'battle', battleId: id },
          { kind: 'screen', id: 'menuView', overBattle: id },
        ]);
      await expect
        .poll(() => hitOwners(page, points, 'paint'), { timeout: 5_000 })
        .toEqual(all('menu'));

      // Start closes the menu: back to the untouched battle.
      await pressButton(page, 'Start');
      await expect(page.locator('#menu-overlay')).toBeHidden({ timeout: 5_000 });
      await expect
        .poll(() => readStack(page), { timeout: 5_000 })
        .toEqual([{ kind: 'battle', battleId: id }]);
      await expect
        .poll(() => hitOwners(page, points, 'paint'), { timeout: 5_000 })
        .toEqual(all('battle'));
      await expect.poll(() => focusInside(page, 'battle'), { timeout: 5_000 }).toBe(true);
      const after = await readTactics(page);
      expect(after?.battleId, 'the battle is still the same one').toBe(id);
      // SURVIVING CHECK (bt-16): retired "turnNumber unchanged" → round, turnIdx and events.
      expect(
        after === null ? null : [after.phase, after.round, after.turnIdx, after.events],
        'and nothing was submitted: the same Active round, turn and event count',
      ).toEqual(['Active', own.round, own.turnIdx, own.events]);
    });

    test('E1: a grass encounter opens the tactical battle UI, and an attack committed through Skills → the forecast panel → A drops the enemy unit`s HP on the HUD and in the tactical rows (bt-16: was Fight → skill cell → the HP card)', async () => {
      // SURVIVING CHECK (bt-16): retired "Fight → skill cell → the opponent card's HP drop
      // renders" → the HUD's FOE info box readout drops AND `readTactics().units` drops. A
      // NON-lethal hit is required (a KO ends the battle and the results panel takes the frame
      // before the HUD repaints): a forecast that can only KO, or a miss, is retried on the next
      // own turn, and a battle offering only lethal hits is fled and re-hunted (MAX_E1_BATTLES).
      test.setTimeout(300_000);
      let dropped = false;
      for (let battle = 0; battle < MAX_E1_BATTLES && !dropped; battle += 1) {
        await huntEncounter(page, `E1 battle ${battle}`);
        await expect(page.locator(`${BATTLE_ROOT} [data-testid="battle-title"]`)).toBeVisible();
        let last: string | null = null;
        let lethalOnly = false;
        for (let turn = 0; turn < MAX_OWN_TURNS && !dropped && !lethalOnly; turn += 1) {
          const tt = await waitOwnTurnOrEnd(page, last, 15_000);
          if (tt.phase !== 'Active') break;
          last = turnKey(tt);
          const { me, enemy } = sides(tt);
          const hudBefore = await hudEnemyHp(page, enemy.unitId);
          await openMenu(page, me);
          const hit = await attackByButtons(page, { allowKo: false, enemyHp: enemy.curHp });
          if (hit === 'kills') {
            lethalOnly = true;
            await endTurn(page);
            break;
          }
          if (hit === 'attacked') {
            await waitExecuted(page, tt.events);
            const now = await readTactics(page);
            const target = now?.units.find((u) => u.unitId === enemy.unitId);
            if (
              now !== null &&
              now.phase === 'Active' &&
              target !== undefined &&
              target.curHp < enemy.curHp
            ) {
              expect(hudBefore, 'E1: the HUD painted the enemy HP before the hit').toBe(
                enemy.curHp,
              );
              await expect
                .poll(() => hudEnemyHp(page, enemy.unitId), {
                  message: `E1: the HUD's foe info box repaints the dropped HP within ${HUD_REPAINT_MS} ms`,
                  timeout: HUD_REPAINT_MS,
                })
                .toBe(target.curHp);
              expect(target.curHp, 'E1: the tactical row`s enemy HP dropped').toBeLessThan(
                enemy.curHp,
              );
              dropped = true;
            }
            await endTurn(page);
            continue;
          }
          if (tileDistance(me, enemy) > 1) await draftMoveToward(page, enemy);
          await endTurn(page);
        }
        // Leave the battle (dropped or not) on a fresh own turn: Flee needs the whole budget.
        const lastKey = last;
        const next = await waitOwnTurnOrEnd(page, lastKey, 15_000);
        if (next.phase === 'Active') await fleeByButtons(page);
        await throughResults(page, `E1 battle ${battle}`);
      }
      expect(
        dropped,
        `E1: a NON-lethal hit landed and the HUD repainted the drop within ${MAX_E1_BATTLES} battles`,
      ).toBe(true);
    });

    test("E1b: an out-of-reach foe is hit in one turn by Move then Skill from the ghost tile (the kiting wild's answer)", async () => {
      // WRONG IMPL KILLED: a fight step that only walks toward the foe and ends the turn (the
      // 8ac38368 stall: no hit from d>=4), a skill pressed from the START tile (greyed: the PRE
      // oracle), a Move drafted but dropped from the commit (the unit is not on the ghost tile, no
      // `Moved` in the transcript), a Skills row that ignores the ghost tile or the post-Move
      // budget (`none` in every battle), and a commit whose skill never executes. The `Executed`
      // carries no unit in the transcript reader, so it is attributed by ORDER: our skill's
      // `Executed` sits after our `Moved` and before our own `TurnEnded` (the foe's reply, which a
      // full-budget commit runs in the same transaction, comes after our `TurnEnded`).
      // NON-lethal like E1 (`allowKo: false`): a KO would level the starter and recompute its
      // seeded stats before E2, so a lethal-only opening is fled and re-hunted. The speed restore
      // runs in a `finally`, so a throw inside the battle loop still writes the natural speed back
      // before E2. A full-budget commit ends the turn server-side, so the exit ends the turn only
      // if it is still ours (`endTurnIfLive`).
      test.setTimeout(300_000);
      const readSpeed = (label: string): number => {
        const row = sqlRows(
          sql(`SELECT * FROM monster WHERE monster_id = ${monsterId}`, label),
          label,
        ).find((r) => r.monster_id === monsterId);
        return Number(row?.stat_speed);
      };
      const writeSpeed = (speed: number, label: string): void => {
        for (const table of ['monster', 'monster_pub']) {
          sql(`UPDATE ${table} SET stat_speed = ${speed} WHERE monster_id = ${monsterId}`, label);
        }
      };
      // E1b-SEED: the natural speed first (the restore target), then the initiative seed.
      const naturalSpeed = readSpeed('E1b seed');
      expect(
        Number.isInteger(naturalSpeed) && naturalSpeed > 0,
        `E1b: the starter's natural speed reads back as a positive integer (got ${naturalSpeed})`,
      ).toBe(true);
      writeSpeed(SEED_SPEED, 'E1b seed');
      expect(readSpeed('E1b seed'), 'the starter row reads back the speed seed').toBe(SEED_SPEED);

      let done = false;
      const outcomes: string[] = [];
      try {
        for (let battle = 0; battle < MAX_E1B_BATTLES && !done; battle += 1) {
          const label = `E1b battle ${battle}`;
          await huntEncounter(page, label);
          const t = await waitOwnTurnOrEnd(page, null, 15_000);
          if (t.phase !== 'Active') {
            outcomes.push(`${battle}:${t.phase}`);
            await throughResults(page, label);
            continue;
          }
          const { me, enemy } = sides(t);
          const opening = tileDistance(me, enemy);
          // E1b-PRE: the seed puts the opening own turn at the spawn distance, out of every reach.
          expect(
            opening,
            `E1b: the starter acts first at the spawn distance: me (${me.x},${me.y}) to foe ` +
              `(${enemy.x},${enemy.y}) is d>=4 (round ${t.round}, turnIdx ${t.turnIdx})`,
          ).toBeGreaterThanOrEqual(4);
          await openMenu(page, me);
          await expect(
            page.locator(TACTICS.menuRow('skills')),
            'E1b: no skill reaches the foe from the start tile at d>=4 — the Skills row is greyed',
          ).toHaveAttribute('aria-disabled', 'true', { timeout: 5_000 });

          // E1b-FIRE: Move then Skill in one turn, from the ghost tile.
          const r = await moveThenAttackByButtons(page, me, enemy, {
            allowKo: false,
            enemyHp: enemy.curHp,
          });
          if (r.hit === 'attacked') {
            const dest = r.dest;
            expect(dest, 'E1b: the Move went somewhere').not.toBeNull();
            if (dest === null) throw new Error('E1b: the Move went somewhere (dest is null)');
            expect(
              { x: dest.x, y: dest.y },
              'E1b: the ghost tile is not the start tile',
            ).not.toEqual({ x: me.x, y: me.y });
            await waitExecuted(page, t.events);
            await expect
              .poll(
                async () => {
                  const now = await readTactics(page);
                  const mine = now?.units.find((u) => u.unitId === me.unitId);
                  return mine === undefined ? null : { x: mine.x, y: mine.y };
                },
                {
                  message:
                    'E1b: the Move executed before the skill: the unit stands on the ghost tile',
                  timeout: 5_000,
                },
              )
              .toEqual({ x: dest.x, y: dest.y });
            await expect
              .poll(
                async () => {
                  const since = (await readEventTags(page)).slice(t.events);
                  const moved = since.findIndex((e) => e.tag === 'Moved' && e.unit === me.unitId);
                  if (moved < 0) return 'no Moved for the unit';
                  const ended = since.findIndex(
                    (e, i) => i > moved && e.tag === 'TurnEnded' && e.unit === me.unitId,
                  );
                  const executed = since.findIndex((e, i) => i > moved && e.tag === 'Executed');
                  if (executed < 0) return 'no Executed after the Move';
                  if (ended >= 0 && executed > ended) {
                    return 'the first Executed after the Move is past the unit TurnEnded (the foe reply)';
                  }
                  return 'ok';
                },
                {
                  message:
                    "E1b: the transcript shows the unit's Move, then its skill executing before its turn ended",
                  timeout: 5_000,
                },
              )
              .toBe('ok');
            const after = await readTactics(page);
            // Information only: a pack's first aim may hit a pack-mate, and a Heavy can miss.
            const foe = after?.units.find((u) => u.unitId === enemy.unitId);
            console.log(
              `[E1b] battle ${battle}: d${opening} -> ghost (${dest.x},${dest.y}) after ` +
                `${r.tries} tries; foe ${enemy.unitId} hp ${enemy.curHp} -> ` +
                `${foe?.curHp ?? '?'}; phase ${after?.phase ?? 'null'}`,
            );
            outcomes.push(`${battle}:attacked tries:${r.tries}`);
            await endTurnIfLive(page, t);
            if (after?.phase === 'Active') {
              const next = await waitOwnTurnOrEnd(page, turnKey(t), 15_000);
              if (next.phase === 'Active') await fleeByButtons(page);
            }
            await throughResults(page, 'E1b');
            done = true;
            continue;
          }
          // `kills` (every firing tile forecasts a KO) or `none` (no band tile fires from this
          // opening geometry): leave on the next own turn and re-hunt.
          console.log(
            `[E1b] battle ${battle}: d${opening} -> ${r.hit} after ${r.tries} tries; re-hunting`,
          );
          outcomes.push(`${battle}:${r.hit} tries:${r.tries}`);
          await endTurn(page);
          const next = await waitOwnTurnOrEnd(page, turnKey(t), 15_000);
          if (next.phase === 'Active') await fleeByButtons(page);
          await throughResults(page, label);
        }
      } finally {
        // E1b-RESTORE: in a `finally`, so a throw inside the loop still restores the natural
        // speed before E2.
        writeSpeed(naturalSpeed, 'E1b restore');
      }
      expect(readSpeed('E1b restore'), 'the starter row reads back its natural speed').toBe(
        naturalSpeed,
      );
      // E1b-DONE
      expect(
        done,
        `E1b: a Move-then-Skill landed within MAX_E1B_BATTLES=${MAX_E1B_BATTLES} battles ` +
          `(outcomes: ${outcomes.length === 0 ? 'none' : outcomes.join(', ')})`,
      ).toBe(true);
    });

    test('E2: fighting to a win by buttons shows the victory title, the server records SideAWins, grants XP (visible level-up in the box) and currency (server wallet) (bt-16: was outcome-text)', async () => {
      // SURVIVING CHECK (bt-16): retired "`outcome-text` reads Victory!" → `fightToOutcome` by
      // buttons → the results title is the catalog victory string and the server's battle row is
      // SideAWins (never "any outcome": a battle that ends otherwise is re-hunted, MAX_WIN_BATTLES).
      test.setTimeout(420_000);
      for (const table of ['monster', 'monster_pub']) {
        for (const col of ['stat_attack', 'stat_sp_attack']) {
          sql(
            `UPDATE ${table} SET ${col} = ${SEED_ATTACK} WHERE monster_id = ${monsterId}`,
            'E2 seed',
          );
        }
      }
      const seeded = sqlRows(
        sql(`SELECT * FROM monster WHERE monster_id = ${monsterId}`, 'E2 seed'),
        'E2 seed',
      ).find((r) => r.monster_id === monsterId);
      expect(Number(seeded?.stat_attack), 'the starter row reads back the attack seed').toBe(
        SEED_ATTACK,
      );
      let won = false;
      for (let battle = 0; battle < MAX_WIN_BATTLES && !won; battle += 1) {
        const start = await huntEncounter(page, `E2 battle ${battle}`);
        const end = await fightToOutcome(page, {
          maxOwnTurns: MAX_OWN_TURNS,
          label: `E2 battle ${battle}`,
        });
        expect(end.phase, 'E2: the battle finished').toBe('Finished');
        const title = page.locator(`${TACTICS.results} [data-testid="battle-title"]`);
        await expect(title, 'E2: the results panel shows its title').toBeVisible({
          timeout: 20_000,
        });
        const titleText = ((await title.textContent()) ?? '').trim();
        await throughResults(page, `E2 battle ${battle}`);
        const sideAWins = sqlSideAWins(start.battleId, 'E2');
        console.log(
          `[bt-16 E2] battle ${battle}: title "${titleText}", SQL SideAWins ${sideAWins}`,
        );
        if (sideAWins) {
          expect(titleText, 'E2: the results title is the victory string').toBe(
            t('battle.outcome.victory'),
          );
          won = true;
        }
      }
      expect(won, `E2: a battle was won (SQL SideAWins) within ${MAX_WIN_BATTLES} battles`).toBe(
        true,
      );

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

      // Visible XP: the box card now reads Lv8. The results already advanced to the world base
      // (throughResults), so B opens Monsters through the main menu.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect.poll(async () => (await readStack(page)).length, { timeout: 5_000 }).toBe(1);
      await pressAccel(page, 'B');
      await expect
        .poll(() => overlayText(page, t('box.title')), { timeout: 10_000 })
        .toContain(boxCardPrefix('Flameling', SEED_LEVEL + 1));
      await page.keyboard.press('Escape');
      await expect.poll(() => overlayText(page, t('box.title')), { timeout: 5_000 }).toBe('');
    });

    test('E3: with the results dismissed, the world resumes — no battle UI and a step moves the character', async () => {
      // SURVIVING CHECK (bt-16): retired "`outcome-text` hidden" → the tactical results panel is
      // hidden (and no shell is shown).
      await expect(page.locator(TACTICS.results)).toBeHidden({ timeout: 5_000 });
      expect(await battleRootShown(page), 'no battle shell').toBe(false);
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
