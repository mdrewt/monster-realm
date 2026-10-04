import { execFileSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { t, tf } from '../src/ui/i18n/resolver';
import { navItemId, navTabId } from '../src/ui/navRender';
import { closeAll, pressButton, readChip, readWorld, safeTile, stepTile, walkTo } from './controls';

// pointer.spec.ts — the operator's required flow, played with the MOUSE ONLY (ctl-15, CTL15.6).
// The keyboard twin is menu-flow.spec.ts (CTL11B.3); every step here must land where that spec's
// press lands, and a right-click goes back exactly one level.
//
//   click the Start chip       the main menu opens
//   click the Bag row          Bag opens above the menu; the menu stays underneath
//   click the Food tab         the Food pocket
//   click Power Root           its sheet (Feed)
//   click Feed                 the monster picker
//   click the A chip           the monster (the picker's cursor): "Fed ...", the picker closes
//   right-click                back to the menu, the cursor on Bag; THE MENU STAYS OPEN
//   click the Monsters row     Monsters opens on Party
//   click the monster, Move    "Moved to storage"
//   click the Storage tab, the monster, Move   "Moved to party"
//   click the Start chip       everything closes, back to the world
//   click the canvas           nothing faced: nothing happens (no frame, no step)
//   W                          the next press WALKS (the only key press of the flow)
//
// Every flow step is a real Playwright mouse action (`locator.click()` / `page.mouse`), never
// `pressButton` or a key, except the final W the criterion names. Each step asserts what a player
// sees (the frame, its cursor and feedback line) and what the page reports (`__game().stack`,
// `navActive`, the own inventory and monsters), so a click that "landed" but did nothing fails at
// that step.
//
// DEVIATIONS FROM THE SPEC'S CLICK LIST, each because the real game differs (the real game wins):
//  - ONE MONSTER (menu-flow.spec.ts's deviation, same reason): a second monster cannot be seeded
//    (owner `spacetime sql` cannot write the `nature_kind` enum column) and recruiting is battle
//    RNG. So "the Storage tab -> a monster -> Move" is played on the starter after it was first
//    moved to Storage from the Party tab (Monsters row -> the monster -> Move).
//  - THE MONSTER IS FED THROUGH THE A CHIP, NOT A CLICK ON ITS ROW. The content has ONE trainable
//    food (game-core/content/items/000-core.ron defines ids 1-5 and only Power Root, id 2, has a
//    `train_stat`; shops/000-core.ron stocks nothing else), so under the picker the Bag's item list
//    holds one row and the picker one monster. A click on the active item of a single-item list
//    beside another visible single-item list is a tie the dispatcher refuses BY DESIGN: which of
//    the two the D-pad drives cannot be proven from the DOM (residual R-ctl-15-DRIVEN: views must
//    mark the base list during a sub-phase; outside ctl-15's touches). The picker's cursor already
//    sits on the only monster, so this step clicks the hint bar's A chip (over a frame it reads A
//    "OK", ui/hintBarModel.ts case 'screen'), which presses A and feeds it: still mouse only, and
//    still "Fed ...", the picker closes. The refusal itself is not pinned here.
//  - THE SETUP WALK (menu-flow.spec.ts's): the final W must walk, and the spawn's north is a wall,
//    so the character first walks a grass-free, warp-free path to (6,2) (via `__game().step`, not
//    the keyboard or the mouse), before the first click.
//  - A CLICK ON AN ALREADY-ACTIVE ROW. Playwright moves the mouse onto an element before it clicks,
//    so the hover (CTL15.4) may already have moved the cursor to that row; the click then proves
//    the row driven (probe and undo) before A. The assertions are on outcomes, never on the presses.
//
// SEEDING (owner SQL, menu-flow.spec.ts's): one stack of Power Root (item id 2) INSERTed into the
// private `inventory` table for the page's identity, charset-validated and run WITHOUT a shell.
//
// DETERMINISM. No battle and no encounter; the only server work is the seed, one train and two
// party-slot moves. One browser, one context, one identity; afterAll closes the browser so the
// server's on_disconnect deletes the player row before golden.spec.

const FOOD_ITEM_ID = 2; // Power Root: `train_stat: Some(Attack)`, content/items/000-core.ron
const FOOD_NAME = 'Power Root';
const FOOD_SEED = 3;
const STARTER_SPECIES_NAME = 'Flameling'; // species 1, STARTER_SPECIES_ID

interface Tile {
  x: number;
  y: number;
}
interface OwnMonster {
  monsterId: string;
  speciesId: number;
  nickname: string;
  partySlot: number;
}
interface OwnItem {
  invId: string;
  itemId: number;
  count: number;
}
interface Frame {
  kind: string;
  id?: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: OwnMonster[];
  ownInventory: OwnItem[];
  stack: Frame[];
  navActive: string | null;
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
      stack: g.stack,
      navActive: g.navActive,
    };
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

/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = async (p: Page): Promise<string[]> =>
  (await snap(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );

/** Whether the element, and every ancestor, is displayed (no inline `display:none` anywhere up). */
const shown = (p: Page, selector: string): Promise<boolean> =>
  p.evaluate((sel) => {
    for (
      let n: Element | null = document.querySelector(sel);
      n instanceof HTMLElement;
      n = n.parentElement
    ) {
      if (n.style.display === 'none') return false;
    }
    return document.querySelector(sel) !== null;
  }, selector);

/** Owner SQL: charset-validated, run without a shell. Only literal-shaped statements pass. */
function ownerSql(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
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

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

/** A row of the main menu's root list, by the id the menu paints. */
const menuRow = (p: Page, key: string): Locator => p.locator(`#${navItemId('menu', null, key)}`);

/** The Monsters frame root: the box title's grandparent (the chain the other specs resolve). */
const boxRoot = (p: Page): Locator => p.locator('[data-testid="box-title"]').locator('xpath=../..');

/** The shown card of the monster in the Monsters frame (both panels stay in the DOM). Clicked near
 *  its top-left corner, on the name, clear of the card's own To Party / To Box buttons. */
async function clickCard(p: Page, monsterId: string): Promise<void> {
  const card = boxRoot(p).locator(`[data-nav-key="${monsterId}"]`).filter({ visible: true });
  await expect(card, 'one shown card for the monster').toHaveCount(1);
  await card.click({ position: { x: 10, y: 10 } });
}

/** Clicks Move in the Monsters sheet (the sheet must be open on the monster). */
async function clickMove(p: Page, name: string): Promise<void> {
  await expect(p.locator('#monsters-sheet-name'), 'the sheet names the monster').toHaveText(name);
  const move = p.locator(`#${navItemId('monstersSheet', null, 'move')}`);
  await expect(move, 'the sheet lists Move').toHaveText(t('box.sheet.move'));
  await move.click();
}

test.describe
  .serial('CTL15.6 — the operator`s flow, mouse only', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

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

    test('CTL15-6-POINTER-FLOW: the Start chip, the Bag row, the Food tab, the item, Feed, the A chip on the monster ("Fed"), a right-click back to the menu on Bag, the Monsters row, the monster and Move (to Storage), the Storage tab, the monster and Move ("Moved to party"), the Start chip (the world), a canvas click that does nothing, and W walks', async () => {
      test.setTimeout(120_000);

      // ---- seed: a food stack in the bag (owner SQL), read back through the page ---------------
      const start = await snap(page);
      expect(start.ownMonsters, 'a fresh identity holds exactly its starter').toHaveLength(1);
      const starter = start.ownMonsters[0] as OwnMonster;
      expect(starter.partySlot, 'the starter is in party slot 0').toBe(0);
      expect(starter.speciesId, 'and is the starter species').toBe(1);
      const name = starter.nickname !== '' ? starter.nickname : STARTER_SPECIES_NAME;
      const hex = normId(start.identity);
      expect(/^[0-9a-f]{64}$/.test(hex), 'the identity is 64 hex digits').toBe(true);
      ownerSql(
        `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${hex}, ${FOOD_ITEM_ID}, ${FOOD_SEED})`,
        'seed the food stack',
      );
      await page.waitForFunction(
        (a: { id: number; n: number }) =>
          (window as unknown as { __game: () => GameSnap })
            .__game()
            .ownInventory.some((i) => i.itemId === a.id && i.count === a.n),
        { id: FOOD_ITEM_ID, n: FOOD_SEED },
        { timeout: 15_000 },
      );

      await closeAll(page); // never presses at a base: a no-op unless a stale frame is up
      expect(await stackNames(page), 'precondition: the bare world').toEqual(['world']);

      // ---- setup walk (no mouse, no key): a post whose NORTH neighbour is walkable --------------
      const POST: Tile = { x: 6, y: 2 };
      const world = await readWorld(page);
      expect(safeTile(world.map, POST), 'the setup post is a safe tile').toBe(true);
      expect(
        safeTile(world.map, stepTile(POST, 'North')),
        'and so is the tile north of it, which the final W must walk onto',
      ).toBe(true);
      expect(await walkTo(page, POST, 'pointer setup walk'), 'the setup walk meets no battle').toBe(
        'arrived',
      );
      expect((await snap(page)).ownAuthTile, 'the character stands on the post').toEqual(POST);
      expect(await stackNames(page), 'the setup walk opened nothing').toEqual(['world']);

      // ---- 1. the Start chip: the main menu opens ----------------------------------------------
      await page.locator('#chip-start').click();
      await expect
        .poll(() => stackNames(page), { message: 'the Start chip opens the menu' })
        .toEqual(['world', 'menuView']);
      expect(await shown(page, '#menu-overlay'), 'the menu is shown').toBe(true);
      await expect(page.locator('#menu-overlay .mr-frame-title')).toHaveText(t('menu.title'));

      // ---- 2. the Bag row: Bag opens above the menu, which stays underneath --------------------
      await menuRow(page, 'bag').click();
      await expect
        .poll(() => stackNames(page), { message: 'a click on Bag pushes Bag above the menu' })
        .toEqual(['world', 'menuView', 'raisingView']);
      await expect(page.locator('[data-testid="raising-title"]'), 'the Bag frame').toHaveText(
        t('raising.title'),
      );
      expect(await shown(page, '#menu-overlay'), 'the menu stays open underneath').toBe(true);
      expect((await snap(page)).navActive, 'with its cursor on Bag').toBe('bag');
      await expect(
        page.locator(`#${navTabId('bag', 'bait')}`),
        'the Bag opens on its first pocket',
      ).toHaveAttribute('aria-selected', 'true');

      // ---- 3. the Food tab ----------------------------------------------------------------------
      await page.locator(`#${navTabId('bag', 'food')}`).click();
      await expect(
        page.locator(`#${navTabId('bag', 'food')}`),
        'the click selects the Food pocket',
      ).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`#${navTabId('bag', 'bait')}`)).toHaveAttribute(
        'aria-selected',
        'false',
      );
      const foodRow = page.locator(`#${navItemId('bag', 'food', String(FOOD_ITEM_ID))}`);
      await expect(foodRow, 'the pocket lists the food with its count').toHaveText(
        tf('raising.inventory.item', { name: FOOD_NAME, count: FOOD_SEED }),
      );
      expect(await stackNames(page), 'a tab click opens nothing').toEqual([
        'world',
        'menuView',
        'raisingView',
      ]);

      // ---- 4. the food row: its sheet, the cursor on Feed ----------------------------------------
      await foodRow.click();
      await expect(page.locator('#bag-sheet'), 'a click on the food opens its sheet').toBeVisible();
      const feed = page.locator(`#${navItemId('bagsheet', null, 'feed')}`);
      await expect(feed).toHaveText(t('bag.action.feed'));

      // ---- 5. Feed: the monster picker -----------------------------------------------------------
      await feed.click();
      await expect(
        page.locator('#bag-picker-title'),
        'a click on Feed opens the picker',
      ).toHaveText(t('bag.picker.title'));
      const picker = page.locator('#bag-picker [role="option"]');
      await expect(picker, 'the picker lists the one monster').toHaveCount(1);
      await expect(picker.first()).toHaveText(name);
      await expect(picker.first(), 'the picker cursor is on the monster').toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        (await snap(page)).ownInventory.find((i) => i.itemId === FOOD_ITEM_ID)?.count,
        'nothing is fed before the picker is answered',
      ).toBe(FOOD_SEED);

      // ---- 6. the A chip (OK) on the monster: "Fed ...", the picker closes ----------------------
      // Deviation (header): the monster's row click is a refused single-item tie (R-ctl-15-DRIVEN);
      // the A chip presses A on the picker's cursor, the only monster.
      const aChip = page.locator('#hint-bar [data-button="A"]');
      await expect(aChip, 'over a frame the bar offers A (OK)').toHaveCount(1);
      await expect(aChip.locator('.mr-chip-verb')).toHaveText(t('chrome.chip.ok'));
      await aChip.click();
      await expect
        .poll(
          async () => (await snap(page)).ownInventory.find((i) => i.itemId === FOOD_ITEM_ID)?.count,
          { message: 'the server consumed one food', timeout: 15_000 },
        )
        .toBe(FOOD_SEED - 1);
      const fed = page.locator('#bag-status');
      await expect(fed, 'the feedback line reports the feed').toHaveText(
        tf('box.feedback.fed', { name }),
      );
      await expect(fed).toHaveAttribute('data-feedback', 'ok');
      await expect(page.locator('#bag-picker-title'), 'the picker closed').toBeHidden();
      expect(await stackNames(page), 'feeding left the frames as they were').toEqual([
        'world',
        'menuView',
        'raisingView',
      ]);

      // ---- 7. right-click: back to the menu, the cursor on Bag, THE MENU STAYS OPEN ---------------
      const titleBox = await page.locator('[data-testid="raising-title"]').boundingBox();
      expect(titleBox, 'the Bag title has a box to right-click').not.toBeNull();
      const tb = titleBox as { x: number; y: number; width: number; height: number };
      await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2, { button: 'right' });
      await expect
        .poll(() => stackNames(page), { message: 'a right-click pops exactly Bag' })
        .toEqual(['world', 'menuView']);
      expect(await shown(page, '[data-testid="raising-title"]'), 'Bag is closed').toBe(false);
      expect(await shown(page, '#menu-overlay'), 'the menu is still open').toBe(true);
      expect((await snap(page)).navActive, 'its cursor is on Bag').toBe('bag');
      await expect(page.locator('#menu-rows')).toHaveAttribute(
        'aria-activedescendant',
        navItemId('menu', null, 'bag'),
      );

      // ---- 8. the Monsters row: Monsters opens on Party ------------------------------------------
      await menuRow(page, 'monsters').click();
      await expect
        .poll(() => stackNames(page), { message: 'a click on Monsters pushes Monsters' })
        .toEqual(['world', 'menuView', 'boxView']);
      await expect(page.locator('[data-testid="box-title"]')).toHaveText(t('box.title'));
      await expect(page.locator('#monsters-tab-party'), 'it opens on Party').toHaveAttribute(
        'aria-selected',
        'true',
      );

      // ---- 9. the monster, Move: "Moved to storage" ----------------------------------------------
      await clickCard(page, starter.monsterId);
      await clickMove(page, name);
      await expect
        .poll(async () => (await snap(page)).ownMonsters[0]?.partySlot, {
          message: 'the server moved the starter to Storage',
          timeout: 15_000,
        })
        .toBe(255);
      await expect(
        boxRoot(page).locator('.mr-frame-feedback[data-feedback="ok"]'),
        'the feedback line reports the move',
      ).toHaveText(t('box.feedback.movedToBox'));

      // ---- 10. the Storage tab, the monster, Move: "Moved to party" ------------------------------
      await page.locator('#monsters-tab-storage').click();
      await expect(
        page.locator('#monsters-tab-storage'),
        'the click selects Storage',
      ).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#monsters-tab-party')).toHaveAttribute('aria-selected', 'false');
      await clickCard(page, starter.monsterId);
      await clickMove(page, name);
      await expect
        .poll(async () => (await snap(page)).ownMonsters[0]?.partySlot, {
          message: 'the server moved the starter back to the party',
          timeout: 15_000,
        })
        .toBe(0);
      await expect(
        boxRoot(page).locator('.mr-frame-feedback[data-feedback="ok"]'),
        'the feedback line reports the move',
      ).toHaveText(t('box.feedback.movedToParty'));
      expect(await stackNames(page)).toEqual(['world', 'menuView', 'boxView']);

      // ---- 11. the Start chip: everything closes, back to the world ------------------------------
      await page.locator('#chip-start').click();
      await expect
        .poll(() => stackNames(page), { message: 'the Start chip closes every frame' })
        .toEqual(['world']);
      expect(await shown(page, '#menu-overlay'), 'the menu is closed').toBe(false);
      expect(await shown(page, '[data-testid="box-title"]'), 'and Monsters with it').toBe(false);

      // ---- 12. a canvas click with nothing faced does nothing -------------------------------------
      expect((await snap(page)).ownAuthTile, 'still on the post').toEqual(POST);
      expect(await readChip(page), 'precondition: nothing is faced (no interact chip)').toBeNull();
      await page.locator('#app canvas').first().click();
      // A negative needs a settle; the W below then proves every earlier input was processed.
      await page.waitForTimeout(500);
      expect(await stackNames(page), 'the canvas click opened nothing').toEqual(['world']);
      expect((await snap(page)).ownAuthTile, 'and moved nobody').toEqual(POST);

      // ---- 13. W walks ----------------------------------------------------------------------------
      await pressButton(page, 'Up');
      await expect
        .poll(async () => (await snap(page)).ownAuthTile, {
          message: 'the first D-pad press after the mouse flow walks one tile North',
          timeout: 8_000,
        })
        .toEqual(stepTile(POST, 'North'));
      expect(await stackNames(page), 'still the bare world').toEqual(['world']);
    });
  });
