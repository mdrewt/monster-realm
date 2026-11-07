import { execSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { t } from '../src/ui/i18n/resolver';
import {
  attackByButtons,
  awaitTacticalActive,
  closeAll,
  draftMoveToward,
  endTurn,
  expectPosted,
  faceTile,
  fightToOutcome,
  fleeByButtons,
  interactChip,
  menuCursorTo,
  NO_BAIT_ROW,
  openMenu,
  pressAccel,
  pressButton,
  readTactics,
  recruitByButtons,
  StuckStackError,
  sides,
  TACTICS,
  type TacticsSnap,
  throughResults,
  tileDistance,
  turnKey,
  waitExecuted,
  waitOwnTurnOrEnd,
  walkTo,
} from './controls';

// recruit.spec.ts — gameplay-driven recruit flow (EARS 13.5h-1).
//
// DESIGN RATIONALE
// ================
// These tests drive the recruit flow using ONLY the real game loop:
// walk onto grass → encounter wild monster → weaken → recruit. No reducer is called from the
// page; the test cannot authenticate as the browser identity (DbConnection is built without
// .withToken; the SDK persists no token in a form the page JS can access). Seeding is owner SQL
// (`spacetime sql` runs as the module OWNER — the tactics-wild / wallet-balance precedent).
//
// bt-16 (BT16.2) — NAMED INTENTIONAL CHANGE: the grass now opens a TACTICAL wild battle; the 1v1
// command list (Fight / Recruit / Run), its skill grid, the "HP x/y · affinity" cards, the
// `bait-selector` and its Yes / No `recruit-action`, and `outcome-text` never appear for a live
// battle. SURVIVING CHECKS, each named at its test:
//   - R1: retired "`recruit-action` visible + an empty `bait-selector`" → on an own turn NOT
//     adjacent to the wild the Recruit row is GREYED, and on an own turn ADJACENT (a full budget)
//     it is live and its bait list shows NO bait row for a fresh inventory — only the no-bait choice
//     (`bait:none`, tacticsBattle.ts).
//   - R2: retired the 1v1 weaken + Recruit loop → tactics-wild's weaken-then-recruit loop by
//     buttons (`attackByButtons` with the forecast's KO guard, then `recruitByButtons` with the
//     seeded bait) → ownMonsters +1, the recruit in the BOX (partySlot 255).
//   - R3: retired "`outcome-text` reads Victory! + SQL SideAWins for R2's battle" → a battle fought
//     to a WIN by buttons (`fightToOutcome`; the starter seeded to win) → the results title is the
//     catalog victory string and the server's battle row is SideAWins.
//
// SEEDING (owner SQL, after R1 so R1's "fresh inventory" holds): R2 makes the starter sturdy (300
// HP, 250 defences — tactics-wild's precedent) and puts bait (item 1) in its bag; R3 raises attack
// to 250 and HP to 999 so any landed hit KOs a zone-0 wild (battle-dpad's precedent).
//
// BOUNDED-RETRY POLICY
// ====================
// Every loop has a named MAX_* constant. The test fails with a descriptive message when a bound
// is exceeded; it never waits forever.
//
// MOVEMENT PROTOCOL
// =================
// The server drains one queued move per 200 ms (STEP_MS); the client queue cap is 2. We send
// one step at a time and wait for (ownAuthTile changed OR ongoingBattle appeared) before the next.
// NEVER call step() while ongoingBattle is non-null.

// ---------------------------------------------------------------------------
// Snapshot shape — mirrors the REAL window.__game() snapshot.
// ---------------------------------------------------------------------------

interface Tile {
  x: number;
  y: number;
}

interface OwnMonster {
  monsterId: string; // bigint serialised as string
  speciesId: number;
  nickname: string;
  level: number;
  partySlot: number; // 255 = box (PARTY_SLOT_NONE)
}

interface OwnInventoryItem {
  invId: string;
  itemId: number;
  count: number;
}

interface OngoingBattle {
  battleId: string; // bigint serialised as string
  outcome: string; // 'Ongoing' only — Ongoing-filter in store.ongoingBattle()
  turnNumber: number;
}

interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ownInventory: OwnInventoryItem[];
  ongoingBattle: OngoingBattle | null; // null when no Ongoing battle (terminal rows excluded)
}

// ---------------------------------------------------------------------------
// Tunable empirical constants.
// ---------------------------------------------------------------------------
/** Max walk steps per encounter hunt. The (1,2)↔(2,2) shuttle enters grass on
 *  every 2nd step (only the East step onto (2,2) rolls), so 80 steps ≈ 40 grass
 *  entries: P(no encounter) = 0.8^40 ≈ 1.3e-4. */
const MAX_WALK_STEPS = 80;
/** R2: battles to try for a recruit. Recruit odds are 80‰ base + up to 500‰ for missing HP +
 *  150‰ bait (roughly 50-70 % per adjacent attempt, several attempts per battle — tactics-wild's
 *  measured BT12.5 loop, 5 battles); 10 leaves margin for kiting and KO'd wilds. */
const MAX_ENCOUNTERS = 10;
/** Own turns per battle before it is abandoned (Flee) and the grass re-hunted. */
const MAX_OWN_TURNS = 16;
/** R1: own turns spent closing in until the wild is adjacent on a fresh turn. */
const MAX_APPROACH_TURNS = 12;
/** R1: battles to try for an adjacent own turn (a wild that kites or flees is re-hunted). */
const MAX_R1_BATTLES = 3;
/** R3: battles to try for a WIN (an auto-fleeing wild or a round cap ends one otherwise). */
const MAX_WIN_BATTLES = 3;
/** Max heal attempts (30s cooldown per heal; KO recovery path). */
const MAX_HEALS = 2;
/** Max pre-encounter HP-restoration heals (flee-damage recovery, separate from KO-recovery). */
const MAX_FLEE_HEALS = 30;
/** Step-wait timeout per move in ms (200 ms drain + network + margin). */
const STEP_WAIT_MS = 8_000;
/** One wait for the next own live turn in a wild battle (the AI's turns plus the pad). */
const TURN_WAIT_MS = 15_000;
/** The wild is recruited (not hit again) at or under this share of its max HP. */
const WEAK_PCT = 45;
/** R2 seeds (tactics-wild's precedent): no wild can KO the starter; bait in the bag. */
const SEED_HP = 300;
const SEED_DEFENSE = 250;
const BAIT_ITEM_ID = 1;
const BAIT_SEED = 9;
/** R3 seeds (battle-dpad's precedent): any landed hit KOs a zone-0 wild. */
const WIN_ATTACK = 250;
const WIN_HP = 999;

// ---------------------------------------------------------------------------
// Grass tiles in zone 0. Spawn is (1,1); row y=1 is all floor x=1..8; (2,2) is the nearest grass
// tile. shuttleDir is TILE-AWARE (not a fixed cycle): deriving the next direction from the
// CURRENT authoritative tile keeps the walk pinned to the (1,2)↔(2,2) shuttle and self-corrects
// any drift. Only the East step onto (2,2) rolls an encounter.
// ---------------------------------------------------------------------------
function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South'; // spawn → (1,2)
  if (tile.x === 1 && tile.y === 2) return 'East'; // → (2,2) grass (roll)
  if (tile.x === 2 && tile.y === 2) return 'West'; // → (1,2) floor
  // Drift recovery: route back toward (1,2).
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
      ongoingBattle: g.ongoingBattle,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

// ---------------------------------------------------------------------------
// stepOne: send one directional step and wait for the authoritative tile to
// change OR for an ongoingBattle to appear — whichever comes first.
// Precondition: must NOT be called while ongoingBattle is non-null.
// ---------------------------------------------------------------------------
async function stepOne(p: Page, dir: string, fromTile: Tile): Promise<'moved' | 'battle'> {
  await p.evaluate(
    (d) => (window as unknown as { __game: () => { step: (x: string) => void } }).__game().step(d),
    dir,
  );
  const result = await p.waitForFunction(
    (args: { fromX: number; fromY: number }) => {
      const g = (window as unknown as { __game: () => GameSnap }).__game();
      if (g.ongoingBattle !== null) return 'battle';
      if (
        g.ownAuthTile !== null &&
        (g.ownAuthTile.x !== args.fromX || g.ownAuthTile.y !== args.fromY)
      ) {
        return 'moved';
      }
      return false;
    },
    { fromX: fromTile.x, fromY: fromTile.y },
    { timeout: STEP_WAIT_MS },
  );
  return result.jsonValue() as Promise<'moved' | 'battle'>;
}

/** Walks the shuttle until a wild battle is ongoing (MAX_WALK_STEPS), then waits for its tactical
 *  row Active (a one-monster party is a pack of one; `awaitTacticalActive` deploys by buttons if it
 *  ever is not). */
async function huntEncounter(p: Page, label: string): Promise<TacticsSnap> {
  let found = false;
  for (let i = 0; i < MAX_WALK_STEPS && !found; i++) {
    const g = await snap(p);
    if (g.ongoingBattle !== null) {
      found = true;
      break;
    }
    const tile = g.ownAuthTile ?? { x: 1, y: 1 };
    try {
      if ((await stepOne(p, shuttleDir(tile), tile)) === 'battle') found = true;
    } catch {
      // stepOne timed out (a wall bump): the next shuttle direction is re-derived.
    }
  }
  expect(found, `${label}: a wild battle within MAX_WALK_STEPS=${MAX_WALK_STEPS}`).toBe(true);
  const active = await awaitTacticalActive(p, label);
  expect(active.kind, `${label}: a WILD tactical battle`).toBe('Wild');
  return active;
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
    return execSync(`spacetime sql -s ${server} ${db} "${query}"`, {
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    throw new Error(`${label}: spacetime sql failed (CLI/infra): ${(err as Error).message}`);
  }
}

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

/** Owner-SQL seed of the starter's stat columns in `monster` and `monster_pub`. */
function seedStarter(
  monsterId: string,
  cols: readonly (readonly [string, number])[],
  label: string,
): void {
  if (!/^[0-9]+$/.test(monsterId)) throw new Error(`${label}: non-decimal monster id ${monsterId}`);
  for (const table of ['monster', 'monster_pub']) {
    for (const [col, val] of cols) {
      ownerSql(`UPDATE ${table} SET ${col} = ${val} WHERE monster_id = ${monsterId}`, label);
    }
  }
}

// ---------------------------------------------------------------------------
// waitForBattleCleared: wait until ongoingBattle is null (fled or ended).
// ---------------------------------------------------------------------------
async function waitForBattleCleared(p: Page): Promise<void> {
  await p.waitForFunction(
    () => (window as unknown as { __game: () => GameSnap }).__game().ongoingBattle === null,
    null,
    { timeout: 15_000 },
  );
}

// ---------------------------------------------------------------------------
// ctl-10a: Box heal retired — healing happens ONLY at the bound healer (B13,
// CTL10A.4). The Box's "Heal Party" button is gone; the party heals by walking
// to the heal location, facing it, A (the heal frame opens on Yes, the default)
// and A again (Yes sends heal_party for THAT location; the cursor moves to No).
//
// WORLD FACTS (re-derived from game-core/content this session):
//   - heal_locations/000-core.ron: exactly ONE row — location_id 1, ZONE 0, tile
//     (8,3), cost_item_id None (free), cooldown_ms 30000. heal_party is
//     zone-scoped and REJECTED silently inside the 30 s cooldown, hence the
//     bounded retry below.
//   - zone_maps/000-core.ron zone 0: (8,3) is itself TALL GRASS ('~', row y=3).
//     Its 4-neighbours: (7,3) floor, (8,2) grass, (8,4) grass, (9,3) wall. So
//     the ONLY grass-free tile beside it is (7,3), and facing it means ARRIVING
//     on (7,3) by an East step from (6,3) — a step always sets the facing
//     (game-core world.rs apply_move), and an East step FROM (7,3) would walk
//     onto the grass heal tile (heal tiles and characters never block).
//   - The walk: from the (1,2)/(2,2) shuttle north to row y=1, east to (6,1),
//     south to (6,3), east onto (7,3) — computed by controls.ts safePath (BFS
//     over walkable, non-grass, non-warp tiles of __game().map), so it can
//     never roll an encounter or warp, and a drifted start still finds it.
//   - elder_oak (home (5,5), wander_radius 2) never reaches (6,1), (6,2),
//     (6,3), (7,3) or (8,3) — all Manhattan >= 3 from home — so the heal tile
//     is the ONLY candidate in front: A runs Heal at once (no picker), and the
//     chip reads `[Enter] Heal — Healer`.
//   - There is no __game() teleport hook (snapshot() exposes step/jump and a
//     test-only zone-map setter only), so the walk is scripted steps.
// ---------------------------------------------------------------------------
const HEAL_POST: Tile = { x: 7, y: 3 };
/** The shuttle's floor tile, where every heal walk returns (shuttleDir resumes there). */
const SHUTTLE_HOME: Tile = { x: 1, y: 2 };
/** The chip while the heal location is the one faced candidate (CTL10A.3). */
const HEALER_CHIP = interactChip('Heal', 'Healer');
/** Heal tries per heal: a heal inside the 30 s server cooldown is rejected silently, so one
 *  try is not enough. Each try ≈ 9 s (open, Yes, close, box check with a 6 s poll), so 8 tries
 *  ≈ 72 s covers a full cooldown window. */
const MAX_HEAL_TRIES = 8;
/** Box opens per check: KeyB toggles, so it is pressed only while the box is closed; the bound
 *  covers transient races (20 × 500 ms = 10 s), not a wait for server state. */
const MAX_BOX_OPEN_TRIES = 20;

/** What the box must show for a heal to count: 'revived' = no monster at HP 0 (the KO path),
 *  'restored' = every monster at ≥ 80% HP (the flee-damage path). */
type HealWant = 'revived' | 'restored';

const boxTitle = (p: Page) => p.locator('[data-testid="box-title"]');

/** Opens the box (Monsters frame) with the B accelerator. closeAll first: a frame left over a
 *  finished battle (the results panel) is continued by Start; closeAll presses Start only above
 *  the base and fails naming a frame Start cannot close (StuckStackError). */
async function openBox(p: Page): Promise<boolean> {
  for (let i = 0; i < MAX_BOX_OPEN_TRIES; i++) {
    if (
      !(await boxTitle(p)
        .isVisible()
        .catch(() => false))
    ) {
      await closeAll(p);
      await pressAccel(p, 'B');
    }
    const open = await boxTitle(p)
      .waitFor({ state: 'visible', timeout: 500 })
      .then(() => true)
      .catch(() => false);
    if (open) return true;
  }
  return false;
}

/** Closes the box and confirms it is gone before anything steps (Start pops to the base). */
async function closeBox(p: Page): Promise<void> {
  await closeAll(p);
  await expect(boxTitle(p)).toBeHidden({ timeout: 5_000 });
}

/** Reads the box's HP state, polling up to `timeoutMs` for `want`'s condition. The box lists
 *  each monster as "HP cur/max (pct%)" and is subscription-driven. Scoped to the box frame
 *  (the `.mr-frame` holding the box title). An HP-less box never counts as healed. */
async function boxHpMeets(p: Page, want: HealWant, timeoutMs: number): Promise<boolean> {
  return p
    .waitForFunction(
      (w: HealWant) => {
        const title = document.querySelector('[data-testid="box-title"]');
        const root = title?.closest('.mr-frame');
        if (!(root instanceof HTMLElement) || root.style.display === 'none') return false;
        const text = root.textContent ?? '';
        const ms = [...text.matchAll(/HP (\d+)\/(\d+)/g)];
        if (ms.length === 0) return false;
        if (w === 'revived') return !text.includes('HP 0/');
        return ms.every((match) => {
          const cur = parseInt(match[1] ?? '0', 10);
          const max = parseInt(match[2] ?? '0', 10);
          return max > 0 && cur / max >= 0.8;
        });
      },
      want,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

/** ctl-10a: Box heal retired — walks to the bound healer, heals there, and walks back to the
 *  shuttle. Each try: at a bare world base, assert the post (7,3) and the East facing and the
 *  exact chip, A (the heal frame opens with the cursor on Yes), A (Yes: heal_party for
 *  location 1; the cursor moves to No), close the frame BEFORE KeyB, then read the box HP for
 *  `want`. Returns whether the box showed `want` within MAX_HEAL_TRIES tries. */
async function healAtHealer(p: Page, want: HealWant, who: string): Promise<boolean> {
  await closeAll(p);
  if ((await faceTile(p, HEAL_POST, 'East', `${who}: walk to the healer`)) === 'battle') {
    throw new Error(
      `${who}: a wild battle started on the walk to the healer — the walk is grass-free by ` +
        'construction (controls.ts safePath); re-derive the WORLD FACTS above',
    );
  }
  const healFrame = p.locator('#heal-overlay');
  const yes = p.locator('#heal-root-yes');
  const no = p.locator('#heal-root-no');
  let healed = false;
  for (let i = 0; i < MAX_HEAL_TRIES && !healed; i++) {
    await closeAll(p);
    await expectPosted(p, HEAL_POST, 'East', `${who}: at the healer`);
    await expect(
      p.locator('#interact-prompt'),
      `${who}: facing the heal tile (8,3), the chip names the healer`,
    ).toHaveText(HEALER_CHIP, { timeout: 10_000 });
    await pressButton(p, 'A');
    await expect(healFrame, `${who}: A facing the heal tile opens the heal frame`).toBeVisible({
      timeout: 10_000,
    });
    await expect(yes, `${who}: the heal frame opens on Yes (the default)`).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await pressButton(p, 'A');
    await expect(no, `${who}: A on Yes heals, then the cursor moves to No`).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 5_000 },
    );
    await closeAll(p); // close the heal frame before KeyB
    await expect(healFrame).toBeHidden({ timeout: 5_000 });
    if (!(await openBox(p))) {
      throw new Error(`${who}: box did not open after ${MAX_BOX_OPEN_TRIES} closeAll+B attempts`);
    }
    healed = await boxHpMeets(p, want, 6_000);
    await closeBox(p);
  }
  const back = await walkTo(p, SHUTTLE_HOME, `${who}: walk back to the shuttle`);
  if (back === 'battle') {
    throw new Error(`${who}: a wild battle started on the grass-free walk back to the shuttle`);
  }
  return healed;
}

/** The KO path: the party fainted, so heal at the healer until no monster is at HP 0. */
async function reviveAtHealer(p: Page): Promise<void> {
  if (!(await healAtHealer(p, 'revived', 'reviveAtHealer'))) {
    throw new Error(`reviveAtHealer: party still fainted after ${MAX_HEAL_TRIES} heal attempts`);
  }
}

// ---------------------------------------------------------------------------
// restoreHpBeforeEncounter: open the box, check HP, and heal at the healer if
// below 80%. Called at the start of each R2 battle to undo HP depletion that a fled battle
// persists. The HP check stays in the box at the shuttle (fast path: no walk when the party is
// healthy); only a low party walks to the healer (ctl-10a: Box heal retired).
// Returns true if a heal was performed, false if HP was already adequate or the box could not be
// opened.
// ---------------------------------------------------------------------------
async function restoreHpBeforeEncounter(p: Page): Promise<boolean> {
  // A frame closeAll cannot close is the latched case: skip the heal rather than fail.
  let boxOpen: boolean;
  try {
    boxOpen = await openBox(p);
  } catch (e) {
    if (!(e instanceof StuckStackError)) throw e;
    console.log(`restoreHpBeforeEncounter: ${e.message}, skipping heal`);
    return false; // another overlay is latched; skip and proceed
  }
  if (!boxOpen) {
    console.log('restoreHpBeforeEncounter: box did not open after 20 tries, skipping heal');
    return false; // another overlay is latched; skip and proceed
  }

  const needsHeal = await p
    .waitForFunction(
      () => {
        const title = document.querySelector('[data-testid="box-title"]');
        const root = title?.closest('.mr-frame');
        if (!(root instanceof HTMLElement) || root.style.display === 'none') return 'no-box';
        const text = root.textContent ?? '';
        const ms = [...text.matchAll(/HP (\d+)\/(\d+)/g)];
        if (!ms.length) return 'no-hp';
        const anyLow = ms.some((match) => {
          const cur = parseInt(match[1] ?? '0', 10);
          const max = parseInt(match[2] ?? '0', 10);
          return max > 0 && cur / max < 0.8;
        });
        return anyLow ? 'low' : 'ok';
      },
      null,
      { timeout: 5_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 'ok');

  await closeBox(p);
  if (needsHeal !== 'low') return false;

  const restored = await healAtHealer(p, 'restored', 'restoreHpBeforeEncounter');
  if (!restored) console.log('restoreHpBeforeEncounter: HP still below 80% after the healer');
  return true;
}

/** R2's live-turn loop (tactics-wild's BT12.5 loop): close in, weaken with the forecast's KO
 *  guard, recruit adjacent with the seeded bait. Resolves 'recruited', or 'ended' / 'stalled'
 *  (the caller flees a stalled battle and re-hunts). */
async function fightToRecruit(
  p: Page,
  counts: { clicks: number; lastKey: string | null },
): Promise<'recruited' | 'ended' | 'stalled'> {
  let last: string | null = null;
  counts.lastKey = null;
  for (let turn = 0; turn < MAX_OWN_TURNS; turn += 1) {
    const tt = await waitOwnTurnOrEnd(p, last, TURN_WAIT_MS);
    if (tt.phase === 'Finished') {
      return tt.units.some((u) => u.side === 'B' && u.state === 'Recruited')
        ? 'recruited'
        : 'ended';
    }
    last = turnKey(tt);
    counts.lastKey = last;
    const { me, enemy: wild } = sides(tt);
    await openMenu(p, me);
    if (tileDistance(me, wild) === 1) {
      const weak = wild.curHp * 100 <= wild.maxHp * WEAK_PCT;
      if (weak && (await recruitByButtons(p, `bait:${BAIT_ITEM_ID}`))) {
        counts.clicks += 1;
        continue;
      }
      const hit = await attackByButtons(p, { allowKo: false, enemyHp: wild.curHp });
      if (hit === 'attacked') {
        await waitExecuted(p, tt.events);
        await endTurn(p);
        continue;
      }
      if (hit === 'kills' && (await recruitByButtons(p, `bait:${BAIT_ITEM_ID}`))) {
        counts.clicks += 1;
        continue;
      }
      await endTurn(p);
      continue;
    }
    const drafted = await draftMoveToward(p, wild);
    if (!drafted) await pressButton(p, 'B'); // leave the menu
    await endTurn(p);
  }
  return 'stalled';
}

// ---------------------------------------------------------------------------
// Suite (describe.serial: one page, sequential tests).
// ---------------------------------------------------------------------------

test.describe
  .serial('M13.5h — wild recruit flow (gameplay-driven)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let starterId = '';

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      const starter = (await snap(page)).ownMonsters[0];
      if (!starter || !/^[0-9]+$/.test(starter.monsterId)) {
        throw new Error('beforeAll: no starter with a decimal monsterId');
      }
      starterId = starter.monsterId;
    });

    test.afterAll(async () => {
      await browser.close();
    });

    // -------------------------------------------------------------------------
    // R1 (EARS 13.5h-1, criterion 1):
    //   WHEN the player walks onto a grass tile, a wild battle MAY start.
    //   SURVIVING CHECK (bt-16): retired "`recruit-action` visible + `bait-selector` with zero
    //   `data-recruit-bonus` rows" → the Recruit row is GREYED on an own turn not adjacent to the
    //   wild, LIVE on an own turn adjacent to it (a full budget), and its bait list offers NO bait
    //   row for a fresh inventory — exactly one `bait:` row, the no-bait choice. Then Flee.
    // -------------------------------------------------------------------------
    test('R1: the Recruit row is greyed when not adjacent and live when adjacent, and its bait list offers no bait row in a fresh inventory (bt-16: was recruit-action + an empty bait-selector)', async () => {
      test.setTimeout(300_000);
      expect(
        (await snap(page)).ownInventory.filter((s) => s.itemId === BAIT_ITEM_ID).length,
        'fixture: a fresh inventory holds no bait',
      ).toBe(0);

      let sawGreyed = false;
      let checked = false;
      // Both halves are required: a wild already adjacent on the first own turn gives the live
      // half only, so the battle is fled and the grass re-hunted until the greyed half is seen too.
      for (let battle = 0; battle < MAX_R1_BATTLES && !(checked && sawGreyed); battle += 1) {
        await huntEncounter(page, `R1 battle ${battle}`);
        let last: string | null = null;
        const doneHere = false;
        for (let turn = 0; turn < MAX_APPROACH_TURNS && !doneHere; turn += 1) {
          const tt = await waitOwnTurnOrEnd(page, last, TURN_WAIT_MS);
          if (tt.phase !== 'Active') break;
          last = turnKey(tt);
          const { me, enemy } = sides(tt);
          await openMenu(page, me);
          const recruitRow = page.locator(TACTICS.menuRow('recruit'));
          await expect(recruitRow, 'R1: a wild battle`s menu offers the Recruit row').toHaveCount(
            1,
            {
              timeout: 5_000,
            },
          );
          if (tileDistance(me, enemy) > 1) {
            await expect(
              recruitRow,
              'R1: NOT adjacent to the wild, the Recruit row is greyed',
            ).toHaveAttribute('aria-disabled', 'true');
            sawGreyed = true;
            await draftMoveToward(page, enemy);
            await endTurn(page);
            continue;
          }
          // Adjacent on a fresh own turn: the row is live and its bait list holds no bait.
          await expect(
            recruitRow,
            'R1: adjacent with a full budget, the Recruit row is live',
          ).not.toHaveAttribute('aria-disabled', 'true');
          await menuCursorTo(page, 'recruit');
          await pressButton(page, 'A');
          await expect(
            page.locator(TACTICS.menuRow(NO_BAIT_ROW)),
            'R1: the bait list offers the no-bait choice',
          ).toHaveCount(1, { timeout: 5_000 });
          await expect(
            page.locator('.tactics-menu-row[data-row^="bait:"]'),
            'R1: a fresh inventory offers NO bait row — only the no-bait choice',
          ).toHaveCount(1);
          await pressButton(page, 'B'); // the bait list → the root menu
          await expect(page.locator(TACTICS.menuRow('flee'))).toHaveCount(1, { timeout: 5_000 });
          checked = true;
          doneHere = true;
          // Flee from the open root menu (Flee needs the whole budget: nothing was spent).
          await fleeByButtons(page);
        }
        if (!doneHere) {
          // The wild kited out of reach or the battle ended: leave it and re-hunt.
          const now = await readTactics(page);
          if (now !== null && now.phase === 'Active') {
            const next = await waitOwnTurnOrEnd(page, last, TURN_WAIT_MS);
            if (next.phase === 'Active') await fleeByButtons(page);
          }
        }
        await waitForBattleCleared(page);
        await throughResults(page, `R1 battle ${battle}`);
      }
      expect(checked, `R1: an own turn adjacent to the wild within ${MAX_R1_BATTLES} battles`).toBe(
        true,
      );
      expect(sawGreyed, 'R1: the greyed Recruit row was seen on a non-adjacent own turn').toBe(
        true,
      );
    });

    // -------------------------------------------------------------------------
    // R2 (EARS 13.5h-1, criterion 2):
    //   WHEN the player weakens a wild monster and Recruits, THE recruit SHALL eventually
    //   succeed: ownMonsters.length increases by 1 and the new monster has partySlot === 255.
    //   SURVIVING CHECK (bt-16): retired the 1v1 weaken + Recruit (Fight / bait list / Yes) loop →
    //   tactics-wild's weaken-then-`recruitByButtons` loop with the seeded bait.
    // -------------------------------------------------------------------------
    test('R2: a recruit by buttons after weakening the wild increments ownMonsters by 1 with partySlot 255 (bt-16: tactics-wild`s weaken-then-recruit loop)', async () => {
      // Budget: up to MAX_ENCOUNTERS battles of up to MAX_OWN_TURNS own turns, plus the
      // pre-encounter heal walks (≈ 90 s worst case each).
      test.setTimeout(1_800_000);
      seedStarter(
        starterId,
        [
          ['stat_hp', SEED_HP],
          ['current_hp', SEED_HP],
          ['stat_defense', SEED_DEFENSE],
          ['stat_sp_defense', SEED_DEFENSE],
        ],
        'R2 seed',
      );
      ownerSql(
        `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${normId((await snap(page)).identity)}, ${BAIT_ITEM_ID}, ${BAIT_SEED})`,
        'R2 seed bait',
      );
      await expect
        .poll(
          async () =>
            (await snap(page)).ownInventory.find((s) => s.itemId === BAIT_ITEM_ID)?.count ?? 0,
          { message: 'R2: the seeded bait reaches the page', timeout: 15_000 },
        )
        .toBe(BAIT_SEED);

      const beforeSnap = await snap(page);
      const countBefore = beforeSnap.ownMonsters.length;
      const monsterIdsBefore = new Set(beforeSnap.ownMonsters.map((m) => m.monsterId));

      let recruited = false;
      let healCount = 0;
      let fleeHealCount = 0;
      let encountersUsed = 0;
      const counts: { clicks: number; lastKey: string | null } = { clicks: 0, lastKey: null };

      for (let enc = 0; enc < MAX_ENCOUNTERS && !recruited; enc++) {
        encountersUsed = enc + 1;
        if (fleeHealCount < MAX_FLEE_HEALS && (await restoreHpBeforeEncounter(page))) {
          fleeHealCount++;
        }
        await huntEncounter(page, `R2 enc ${enc + 1}`);
        const result = await fightToRecruit(page, counts);
        if (result === 'stalled') {
          // A FRESH own turn (after the last End Turn's key): Flee needs the whole budget.
          const next = await waitOwnTurnOrEnd(page, counts.lastKey, TURN_WAIT_MS);
          if (next.phase === 'Active') await fleeByButtons(page);
        }
        await waitForBattleCleared(page);
        const results = await throughResults(page, `R2 enc ${enc + 1}`);
        console.log(`R2 enc ${enc + 1}: ${result}`);
        if (result === 'recruited') {
          expect(results, 'R2: the results panel lists the recruit').toContain('joined your team!');
          recruited = true;
          break;
        }
        // A party KO'd by the wild blocks encounters: revive at the healer (bounded).
        if (result === 'ended' && results.includes(t('battle.outcome.defeat'))) {
          if (healCount >= MAX_HEALS) {
            throw new Error(`R2: exceeded MAX_HEALS (${MAX_HEALS}); party fainted too often`);
          }
          healCount++;
          await reviveAtHealer(page);
        }
      }

      console.log(
        `R2 diagnostics: encounters=${encountersUsed} recruitClicks=${counts.clicks} heals=${healCount} fleeHeals=${fleeHealCount} recruited=${recruited}`,
      );
      expect(recruited, `R2: did not recruit within MAX_ENCOUNTERS=${MAX_ENCOUNTERS}`).toBe(true);

      await expect
        .poll(async () => (await snap(page)).ownMonsters.length, { timeout: 15_000 })
        .toBe(countBefore + 1);
      const afterSnap = await snap(page);
      const newMonster = afterSnap.ownMonsters.find((m) => !monsterIdsBefore.has(m.monsterId));
      if (newMonster === undefined) {
        throw new Error('R2: newly recruited monster must appear in ownMonsters (monsterId diff)');
      }
      // The recruited monster goes to the box (partySlot === 255 = PARTY_SLOT_NONE).
      expect(newMonster.partySlot).toBe(255);
    });

    // -------------------------------------------------------------------------
    // R3 (EARS 13.5h-1, criterion 3):
    //   SURVIVING CHECK (bt-16): retired "the outcome frame shows exactly 'Victory!' + SQL
    //   SideAWins for R2's battle" (`outcome-text` is the 1v1 view's) → a battle fought to a WIN
    //   by buttons (`fightToOutcome`; the starter seeded to win) → the results title is the
    //   catalog victory string AND spacetime sql names SideAWins for that battle. Never "any
    //   outcome": a battle that ends otherwise is re-hunted (MAX_WIN_BATTLES).
    // -------------------------------------------------------------------------
    test('R3: a battle won by buttons shows the victory title and spacetime sql confirms SideAWins (bt-16: was outcome-text)', async () => {
      test.setTimeout(420_000);
      seedStarter(
        starterId,
        [
          ['stat_attack', WIN_ATTACK],
          ['stat_sp_attack', WIN_ATTACK],
          ['stat_hp', WIN_HP],
          ['current_hp', WIN_HP],
        ],
        'R3 seed',
      );
      let won = false;
      for (let battle = 0; battle < MAX_WIN_BATTLES && !won; battle += 1) {
        const start = await huntEncounter(page, `R3 battle ${battle}`);
        const battleId = start.battleId;
        if (!/^[0-9]+$/.test(battleId)) {
          throw new Error(`R3: battleId is not a decimal u64 string: ${battleId}`);
        }
        const end = await fightToOutcome(page, {
          maxOwnTurns: MAX_OWN_TURNS,
          label: `R3 battle ${battle}`,
        });
        expect(end.phase, 'R3: the battle finished').toBe('Finished');
        const title = page.locator(`${TACTICS.results} [data-testid="battle-title"]`);
        await expect(title, 'R3: the results panel shows its title').toBeVisible({
          timeout: 20_000,
        });
        const titleText = ((await title.textContent()) ?? '').trim();
        await throughResults(page, `R3 battle ${battle}`);

        // Server truth: the outcome tag lives in the `state` struct column (schema.rs Battle row),
        // so SELECT * prints it; rendering-agnostic (2.6.0 bare `SideAWins`, 2.8.1 snake_case).
        const sqlOutput = ownerSql(`SELECT * FROM battle WHERE battle_id = ${battleId}`, 'R3');
        expect(sqlOutput.includes(battleId), `R3: the battle row ${battleId} exists`).toBe(true);
        const sideAWins = /side_?a_?wins/i.test(sqlOutput);
        console.log(`R3 battle ${battle}: title "${titleText}", SQL SideAWins ${sideAWins}`);
        if (sideAWins) {
          expect(titleText, 'R3: the results title is the victory string').toBe(
            t('battle.outcome.victory'),
          );
          won = true;
        }
      }
      expect(
        won,
        `R3: a battle was won (SQL SideAWins) within MAX_WIN_BATTLES=${MAX_WIN_BATTLES}`,
      ).toBe(true);
    });

    // -------------------------------------------------------------------------
    // R4 (RE-ANCHOR — test.fixme, real blocker documented):
    //   Bait-list classify-by-data: a bait item grants recruit_bonus > 0. The test would: grant a
    //   bait item, enter a battle, assert the bait list has >= 1 row for it, assert no non-bait
    //   item appears.
    //
    //   RE-ANCHOR REASON (pre-bt-16, unchanged): a bait item can only be granted to the
    //   browser-session identity through a test-only hook on __game() (not exposed; owned by a
    //   client/src slice), the shop (~7 KO battles of currency — over the e2e budget), or a
    //   `spacetime call` with the browser token (not reachable from the test process). bt-16 note:
    //   R2 now seeds bait by owner SQL and recruits WITH it (`bait:1`), which covers the positive
    //   half of this criterion on the tactical bait list.
    // -------------------------------------------------------------------------
    test.fixme('R4: bait selector lists only items with recruit_bonus > 0 (blocked: __game() test-hook not exposed; owned by a client/src slice)', async () => {
      // STEP 1: grant a bait item (requires __game().grantBait(itemId, qty) — not yet exposed).
      // STEP 2: trigger a wild battle (grass walk as in R1).
      // STEP 3: on an own turn adjacent to the wild, Recruit → the bait list.
      // STEP 4: assert >= 1 `bait:<itemId>` row and that every non-`bait:none` row is a bait.
      // Clean up: Flee, as in R1.
    });
  });
