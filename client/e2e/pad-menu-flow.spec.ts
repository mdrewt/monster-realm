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
import { navItemId } from '../src/ui/navRender';
import {
  closeAll,
  faceTile,
  pressButton,
  readWorld,
  safeTile,
  setPressSource,
  stepTile,
} from './controls';
import { installFakePad } from './pad';
import { ownerSql } from './stdb';

// pad-menu-flow.spec.ts — the operator's required menu flow, played with the MOCKED PAD ONLY: the
// mirror of menu-flow.spec.ts, press by press and assertion by assertion. The context gets the fake
// pad (`pad.ts` `installFakePad`) before the first `goto`, and the page presses through it
// (`setPressSource(page, 'pad')`), so every `pressButton` below, and `closeAll`, presses the pad
// button the default pad table binds:
//
//   Start (9)              the main menu opens on Monsters
//   Down (13)              the cursor moves to Bag
//   A (0)                  Bag opens above the menu; the menu stays underneath
//   RB (5)                 the Food pocket
//   A, A, A                the berry's sheet (Feed), the monster picker, the monster: "Fed ..."
//   B (1)                  back to the menu, the cursor on Bag; THE MENU STAYS OPEN
//   Up (12), A             Monsters opens on Party
//   A, Down x5, A          the monster's sheet, down to Move, Move: "Moved to storage"
//   RB, A, Down x5, A      the Storage tab, the sheet, Move: "Moved to party"
//   Start                  everything closes, back to the world
//   Up                     the next press WALKS (the snapshot position moves one tile North)
//
// Each pad press holds its button for two animation frames, well under the hold-commit threshold,
// so the final Up is one Face of the faced direction: one tile, no continuation.
//
// The seeding, the setup walk and every assertion are menu-flow.spec.ts's, for the same reasons
// (its header records the deviations from the design table: one monster, the longer sheet, no
// breadcrumb, the Bag's first pocket, the setup walk onto (6,2) facing North). The setup walk uses
// the DEV `__game().step` through `faceTile`, not a press, so the flow's presses are all the pad's.
//
// SEEDING (owner SQL): one stack of Power Root (item id 2, a trainable food) INSERTed into the
// private `inventory` table for the page's identity, the column list named, `0` for the auto_inc
// key, an `0x<64 hex>` identity literal; charset-validated and run WITHOUT a shell.
//
// DETERMINISM. No battle and no encounter (the setup walk and the final step only enter safe
// tiles); the only server work is the seed, one train, and two party-slot moves. One browser, one
// context, one identity; afterAll closes the browser so the server's on_disconnect deletes the
// player row before the next spec.

const FOOD_ITEM_ID = 2; // Power Root: `train_stat: Some(Attack)`, content/items/000-core.ron
const FOOD_NAME = 'Power Root';
const FOOD_SEED = 3;
const STARTER_SPECIES_NAME = 'Flameling'; // species 1, STARTER_SPECIES_ID
// Every expected string below is built with t / tf from the catalog, never pasted.

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

/** The stack as base-first names: the base kind, then each upper frame's id (the main.accel shape). */
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

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

/** The cursor row of the main menu's root list, by the id the menu paints. */
const menuRow = (p: Page, key: string): Locator => p.locator(`#${navItemId('menu', null, key)}`);

/** The Monsters frame root: the box title's grandparent (the chain the other specs resolve). */
const boxRoot = (p: Page): Locator => p.locator('[data-testid="box-title"]').locator('xpath=../..');

/** One Down press, then the sheet's cursor must be on `key` (never a blind count). */
async function sheetDownTo(p: Page, key: string): Promise<void> {
  await pressButton(p, 'Down');
  await expect(
    p.locator(`#${navItemId('monstersSheet', null, key)}`),
    `the Monsters sheet cursor is on ${key}`,
  ).toHaveAttribute('aria-selected', 'true');
}

/** Opens the monster's sheet from the list (A) and walks the cursor down to Move. */
async function openSheetAtMove(p: Page, name: string): Promise<void> {
  await pressButton(p, 'A'); // the monster's sheet, the cursor on Summary
  await expect(p.locator('#monsters-sheet-name'), 'the sheet names the monster').toHaveText(name);
  await expect(
    p.locator(`#${navItemId('monstersSheet', null, 'summary')}`),
    'the sheet opens on Summary',
  ).toHaveAttribute('aria-selected', 'true');
  for (const key of ['care', 'feed', 'evolve', 'nickname', 'move']) await sheetDownTo(p, key);
  // Close is the sheet's last row, one Down past Move; Up comes back to Move, so A below is still
  // Move. Up is asserted by the row it lands on, like every Down.
  const rows = p.locator('[data-context-sheet] [role="option"]');
  await expect(rows.last(), 'Close is the last row of the sheet').toHaveAttribute(
    'id',
    navItemId('monstersSheet', null, 'close'),
  );
  await expect(rows.last()).toHaveText(t('kit.sheet.close'));
  await sheetDownTo(p, 'close');
  await pressButton(p, 'Up');
  await expect(
    p.locator(`#${navItemId('monstersSheet', null, 'move')}`),
    'Up from Close is Move again',
  ).toHaveAttribute('aria-selected', 'true');
}

test.describe
  .serial('the operator`s menu flow, pad only', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      await installFakePad(ctx); // before the first goto: the page loads with the pad present
      page = await ctx.newPage();
      setPressSource(page, 'pad');
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('on the mocked pad only, Start, Down, A (Bag), RB (Food), A A A (feed the berry), B (the menu stays open), Up A (Monsters on Party), A and five Downs and A (Move to Storage), RB A and five Downs and A (Move to Party), Start (the world), and the next D-pad press walks one tile North [gp-2.8]', async () => {
      test.setTimeout(120_000);

      // ---- the fake pad is the page's one pad ------------------------------------------------
      expect(
        await page.evaluate(() => navigator.getGamepads().map((p) => (p === null ? null : p.id))),
        'the page reads the fake pad in slot 0 and nothing else',
      ).toEqual(['mr-fake-pad (STANDARD GAMEPAD)', null, null, null]);

      // ---- seed: a berry in the bag (owner SQL), read back through the page -------------------
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
      expect(await shown(page, '#menu-overlay'), 'precondition: no menu').toBe(false);

      // ---- setup walk (before any menu press): a post whose NORTH neighbour is walkable ----------
      // The spawn's north is a wall, and the flow's last press is Up. (6,2) sits on the clean x=6
      // lane; it, (6,1) and its approach (6,3) are asserted safe (walkable, no grass, no warp) from
      // the live map. The walk arrives on the post FACING North (`faceTile`: from (6,3), a step
      // North), so the flow's last Up press, a press of the faced direction, steps.
      const POST: Tile = { x: 6, y: 2 };
      const world = await readWorld(page);
      expect(safeTile(world.map, POST), 'the setup post is a safe tile').toBe(true);
      expect(
        safeTile(world.map, stepTile(POST, 'North')),
        'and so is the tile north of it, which the final Up must walk onto',
      ).toBe(true);
      expect(
        safeTile(world.map, stepTile(POST, 'South')),
        'and so is its approach south of it, from which the walk arrives facing North',
      ).toBe(true);
      expect(
        await faceTile(page, POST, 'North', 'pad-menu-flow setup walk'),
        'the setup walk meets no battle',
      ).toBe('arrived');
      expect((await snap(page)).ownAuthTile, 'the character stands on the post').toEqual(POST);
      expect(await stackNames(page), 'the setup walk opened nothing').toEqual(['world']);

      // ---- 1. Start: the main menu opens on Monsters -----------------------------------------
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'Start opens the menu' })
        .toEqual(['world', 'menuView']);
      expect((await snap(page)).navActive, 'the cursor is on Monsters').toBe('monsters');
      expect(await shown(page, '#menu-overlay'), 'the menu is shown').toBe(true);
      await expect(page.locator('#menu-overlay .mr-frame-title'), 'the menu`s title').toHaveText(
        t('menu.title'),
      );
      await expect(
        page.locator('#menu-rows'),
        'the menu paints its cursor on Monsters',
      ).toHaveAttribute('aria-activedescendant', navItemId('menu', null, 'monsters'));
      await expect(menuRow(page, 'monsters')).toHaveAttribute('aria-selected', 'true');

      // ---- 2. Down: the cursor moves to Bag ---------------------------------------------------
      await pressButton(page, 'Down');
      await expect.poll(async () => (await snap(page)).navActive).toBe('bag');
      await expect(page.locator('#menu-rows')).toHaveAttribute(
        'aria-activedescendant',
        navItemId('menu', null, 'bag'),
      );
      await expect(menuRow(page, 'bag'), 'Bag is the active row').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(menuRow(page, 'monsters'), 'Monsters is not').toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(await stackNames(page), 'moving the cursor opens nothing').toEqual([
        'world',
        'menuView',
      ]);

      // ---- 3. A: Bag opens above the menu, which stays underneath -----------------------------
      await pressButton(page, 'A');
      await expect
        .poll(() => stackNames(page), { message: 'A on Bag pushes Bag above the menu' })
        .toEqual(['world', 'menuView', 'raisingView']);
      await expect(
        page.locator('[data-testid="raising-title"]'),
        'the Bag frame is shown',
      ).toBeVisible();
      await expect(page.locator('[data-testid="raising-title"]'), 'and titled').toHaveText(
        t('raising.title'),
      );
      expect(await shown(page, '#menu-overlay'), 'the menu stays open underneath').toBe(true);
      expect((await snap(page)).navActive, 'with its cursor still on Bag').toBe('bag');
      await expect(
        page.locator('#bag-tab-bait'),
        'the Bag opens on its first pocket (Bait, the lowest item id)',
      ).toHaveAttribute('aria-selected', 'true');

      // ---- 4. RB: the Food pocket, the cursor on the berry ------------------------------------
      await pressButton(page, 'RB');
      await expect(page.locator('#bag-tab-food'), 'RB selects the Food pocket').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#bag-tab-bait'), 'and leaves Bait').toHaveAttribute(
        'aria-selected',
        'false',
      );
      const berryRow = page.locator(`#${navItemId('bag', 'food', String(FOOD_ITEM_ID))}`);
      await expect(berryRow, 'the cursor is on the berry').toHaveAttribute('aria-selected', 'true');
      await expect(berryRow, 'which shows its count').toHaveText(
        tf('raising.inventory.item', { name: FOOD_NAME, count: FOOD_SEED }),
      );

      // ---- 5. A, A, A: the berry's sheet (Feed), the monster picker, the monster -------------
      await pressButton(page, 'A');
      await expect(page.locator('#bag-sheet'), 'A on the berry opens its sheet').toBeVisible();
      await expect(
        page.locator(`#${navItemId('bagsheet', null, 'feed')}`),
        'with the cursor on Feed',
      ).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`#${navItemId('bagsheet', null, 'feed')}`)).toHaveText(
        t('bag.action.feed'),
      );

      await pressButton(page, 'A');
      // The picker is the Bag's ContextSheet (heading `#bagsheet-sheet-title`, rows under
      // `#bag-sheet`), and it ends with a Back row, so it lists the one monster THEN Back.
      await expect(page.locator('#bagsheet-sheet-title'), 'A on Feed opens the picker').toHaveText(
        t('bag.picker.title'),
      );
      const picker = page.locator('#bag-sheet [role="option"]');
      await expect(
        picker,
        'the picker lists the one monster (a second cannot be seeded), then Back',
      ).toHaveCount(2);
      await expect(picker.last(), 'the last row is Back').toHaveText(t('kit.sheet.back'));
      await expect(picker.first(), 'by its name').toHaveText(name);
      await expect(picker.first(), 'with the cursor on it').toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        (await snap(page)).ownInventory.find((i) => i.itemId === FOOD_ITEM_ID)?.count,
        'nothing is fed before the picker is answered',
      ).toBe(FOOD_SEED);

      await pressButton(page, 'A'); // the monster: train, no confirm
      await expect
        .poll(
          async () => (await snap(page)).ownInventory.find((i) => i.itemId === FOOD_ITEM_ID)?.count,
          {
            message: 'the server consumed one berry',
            timeout: 15_000,
          },
        )
        .toBe(FOOD_SEED - 1);
      const fed = page.locator('#bag-status');
      await expect(fed, 'the feedback line reports the feed').toHaveText(
        tf('box.feedback.fed', { name }),
      );
      await expect(fed).toHaveAttribute('data-feedback', 'ok');
      // The picker is the ContextSheet; it closes with the send, heading and all.
      await expect(page.locator('#bagsheet-sheet-title'), 'the picker closed').toBeHidden();
      await expect(page.locator('#bag-sheet'), 'and the sheet with it').toBeHidden();
      await expect(
        berryRow,
        'the list shows the new count, the cursor still on the berry',
      ).toHaveText(tf('raising.inventory.item', { name: FOOD_NAME, count: FOOD_SEED - 1 }));
      await expect(berryRow).toHaveAttribute('aria-selected', 'true');
      expect(await stackNames(page), 'feeding left the frames as they were').toEqual([
        'world',
        'menuView',
        'raisingView',
      ]);

      // ---- 6. B: back to the menu, the cursor on Bag, THE MENU STAYS OPEN ---------------------
      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'B pops exactly Bag' })
        .toEqual(['world', 'menuView']);
      expect(await shown(page, '[data-testid="raising-title"]'), 'Bag is closed').toBe(false);
      expect(await shown(page, '#menu-overlay'), 'the menu is still open').toBe(true);
      expect((await snap(page)).navActive, 'its cursor is on Bag').toBe('bag');
      await expect(page.locator('#menu-rows')).toHaveAttribute(
        'aria-activedescendant',
        navItemId('menu', null, 'bag'),
      );

      // ---- 7. Up, A: Monsters opens on Party --------------------------------------------------
      await pressButton(page, 'Up');
      await expect.poll(async () => (await snap(page)).navActive).toBe('monsters');
      await pressButton(page, 'A');
      await expect
        .poll(() => stackNames(page), { message: 'A on Monsters pushes Monsters above the menu' })
        .toEqual(['world', 'menuView', 'boxView']);
      await expect(page.locator('[data-testid="box-title"]'), 'the Monsters frame').toHaveText(
        t('box.title'),
      );
      await expect(page.locator('#monsters-tab-party'), 'it opens on Party').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#monsters-tab-storage')).toHaveAttribute('aria-selected', 'false');
      const card = (tabCursor: boolean): Locator =>
        boxRoot(page).locator(
          `[data-nav-key="${starter.monsterId}"]${tabCursor ? '[aria-current="true"]' : ''}`,
        );
      await expect(card(true), 'the cursor is on the monster').toHaveCount(1);
      expect(await shown(page, '#menu-overlay'), 'the menu is still beneath it').toBe(true);

      // ---- 8. A, Down x5, A: the sheet, Move: "Moved to storage" -------------------------------
      await openSheetAtMove(page, name);
      await pressButton(page, 'A'); // Move: party to Storage
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
      expect(await stackNames(page), 'moving leaves the frames as they were').toEqual([
        'world',
        'menuView',
        'boxView',
      ]);

      // ---- 9. RB, A, Down x5, A: the Storage tab, the sheet, Move: "Moved to party" ----------
      await pressButton(page, 'RB');
      await expect(page.locator('#monsters-tab-storage'), 'RB selects Storage').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('#monsters-tab-party')).toHaveAttribute('aria-selected', 'false');
      await expect(card(true), 'the cursor is on the stored monster').toHaveCount(1);
      await openSheetAtMove(page, name);
      await pressButton(page, 'A'); // Move: Storage to party
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

      // ---- 10. Start: everything closes, back to the world -----------------------------------
      const before = (await snap(page)).ownAuthTile;
      expect(before, 'the character still stands on the setup post').toEqual(POST);
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'Start closes every frame' })
        .toEqual(['world']);
      expect(await shown(page, '#menu-overlay'), 'the menu is closed').toBe(false);
      expect(await shown(page, '[data-testid="box-title"]'), 'and Monsters with it').toBe(false);
      expect((await snap(page)).navActive, 'a closed menu has no active entry').toBeNull();

      // ---- 11. the next D-pad press walks -----------------------------------------------------
      await pressButton(page, 'Up'); // D-pad Up (12): the final press of the flow
      await expect
        .poll(async () => (await snap(page)).ownAuthTile, {
          message: 'the first D-pad press after the menu closed walks the character one tile North',
          timeout: 8_000,
        })
        .toEqual(stepTile(POST, 'North'));
      expect(await stackNames(page), 'still the bare world').toEqual(['world']);
    });
  });
