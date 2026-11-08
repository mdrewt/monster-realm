import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  closeAll,
  type Dir,
  expectPosted,
  faceTile,
  interactChip,
  pressButton,
  readWorld,
  type Tile,
  walkPath,
} from './controls';

// uif-12 — the world sheets (the entity x action picker / action sheet, the request sheet, the
// Challenge confirm) ride the ContextSheet kit and take the pointer.
//
// WHAT THIS PROVES (Chromium, real layout and real hit-testing; happy-dom has neither):
//   UIF12.1  Y at the shopkeeper opens the action sheet INSIDE `#interact-prompt
//            [data-context-sheet]`; the sheet takes the pointer (the hit-test at its first row's
//            centre lands on that row, where the old `pointer-events:none` prompt let it fall
//            through), it hangs at the anchor as shipped (the prompt's own left / top are
//            unchanged by the sheet; the sheet sits above that point and is centred on it), and a
//            REAL click on the row runs it (the greeting opens: the Shop NPC's `talk`).
//   UIF12.4  A real click on the world canvas well away from the open sheet closes it and does
//            NOTHING else: no dialogue, no shop, no frame, the stack stays the bare world, and
//            the next movement press walks exactly one tile.
//
// Setup: the shop-npc.spec.ts route and post — the stationary tideglass_shopkeeper at (8,1) in
// zone 1, faced from (7,1) facing East (WORLD FACTS: see that file's header). Nothing here needs a
// second player and no step needs a retry loop: the shopkeeper has wander_radius 0.

interface Snap {
  presenceCount: number;
  map: { zone_id: number };
}
type GameWindow = { __game: () => Snap & { identity: string; ownAuthTile: Tile | null } };

const ZONE0_PATH: readonly Dir[] = ['South', 'South', 'South', 'South']; // spawn (1,1) -> warp (1,5)
const SHOP_POST: Tile = { x: 7, y: 1 };
const SHOPKEEPER_NPC_ID = 'tideglass_shopkeeper';
const GREETING = 'Hello, customer!';
const SHOP_ROW = interactChip('Shop', SHOPKEEPER_NPC_ID).replace(/^\[[^\]]*\] /, '');

/** Pixel slack for the anchor geometry (sub-pixel layout and the kit's border). */
const TOL_PX = 8;

interface PromptGeometry {
  /** The prompt's own inline left / top (the anchor the renderer set), in px. */
  styleLeft: string;
  styleTop: string;
  /** That anchor in page coordinates (its offset parent's origin + left / top). */
  anchorX: number;
  anchorY: number;
  sheet: { left: number; right: number; top: number; bottom: number } | null;
}

const readPromptGeometry = (p: Page): Promise<PromptGeometry> =>
  p.evaluate(() => {
    const prompt = document.getElementById('interact-prompt') as HTMLElement;
    const parent = prompt.offsetParent as HTMLElement | null;
    const origin = parent === null ? { left: 0, top: 0 } : parent.getBoundingClientRect();
    const left = Number.parseFloat(prompt.style.left);
    const top = Number.parseFloat(prompt.style.top);
    const root = prompt.querySelector<HTMLElement>('[data-context-sheet]');
    const r = root === null ? null : root.getBoundingClientRect();
    return {
      styleLeft: prompt.style.left,
      styleTop: prompt.style.top,
      anchorX: origin.left + left,
      anchorY: origin.top + top,
      sheet: r === null ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
    };
  });

/** True when the topmost element at the centre of the sheet's first row is that row or inside it. */
const rowTakesThePointer = (p: Page): Promise<boolean> =>
  p.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      '#interact-prompt [data-context-sheet] [role="option"]',
    );
    if (row === null) return false;
    const r = row.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === row || row.contains(hit));
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: GameWindow['__game'] };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

test.describe
  .serial('uif-12 — world sheets on the ContextSheet kit', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      await page.waitForFunction(
        () => (window as unknown as GameWindow).__game().presenceCount === 1,
        null,
        { timeout: 30_000 },
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('setup: walk to the warp, cross into zone 1 and face the shopkeeper from (7,1)', async () => {
      test.setTimeout(180_000);
      expect(await walkPath(page, ZONE0_PATH, 'uif-12 zone 0'), 'a grass-free walk').toBe(
        'arrived',
      );
      await page.waitForFunction(
        () => (window as unknown as GameWindow).__game().map.zone_id === 1,
        null,
        { timeout: 20_000 },
      );
      expect(await faceTile(page, SHOP_POST, 'East', 'uif-12 post')).toBe('arrived');
      await expectPosted(page, SHOP_POST, 'East', 'uif-12 post');
      await expect(
        page.locator('#interact-prompt'),
        'the faced shopkeeper is the one candidate: the chip',
      ).toBeVisible({ timeout: 10_000 });
    });

    // KILLS: a world sheet painted into a plain div with no [data-context-sheet] root (the pointer
    // source never sees it); a prompt that stays pointer-events:none (the hit-test falls through to
    // the canvas and a real click is swallowed by the page, never reaching the row); a sheet that
    // re-anchors itself (placeContextSheet moves it off the point the prompt hangs it from); and a
    // click on the row that does not run it.
    test('UIF12.1 Y opens the action sheet inside the kit root at the anchor, the sheet takes the pointer, and a real click on its row runs it', async () => {
      test.setTimeout(120_000);
      const prompt = page.locator('#interact-prompt');
      expect((await readWorld(page)).stackLength, 'precondition: a bare world base').toBe(1);
      const before = await readPromptGeometry(page);
      expect(before.sheet, 'precondition: no sheet before Y').toBeNull();

      await pressButton(page, 'Y');

      const sheet = page.locator('#interact-prompt [data-context-sheet]');
      await expect(sheet, 'Y opens the world action sheet in the kit root').toBeVisible({
        timeout: 5_000,
      });
      const rows = page.locator('#interact-prompt [data-context-sheet] [role="option"]');
      await expect(rows, 'one action: the Shop row').toHaveCount(1);
      await expect(rows.first()).toHaveText(SHOP_ROW);
      await expect(sheet).toHaveClass(/mr-sheet/);

      // The sheet takes the pointer: the hit-test at the row's centre reaches the row.
      expect(
        await rowTakesThePointer(page),
        'elementFromPoint at the first row`s centre is that row (pointer-events are live)',
      ).toBe(true);

      // Anchored as shipped: the prompt's own left / top are untouched by the sheet, and the sheet
      // hangs on that point (centred on it, its bottom at or above it).
      const after = await readPromptGeometry(page);
      expect(after.styleLeft, 'the sheet does not move the prompt (left)').toBe(before.styleLeft);
      expect(after.styleTop, 'the sheet does not move the prompt (top)').toBe(before.styleTop);
      expect(after.sheet, 'the sheet has a box').not.toBeNull();
      const box = after.sheet as NonNullable<PromptGeometry['sheet']>;
      expect(
        box.left - TOL_PX <= after.anchorX && after.anchorX <= box.right + TOL_PX,
        `the sheet [${box.left}, ${box.right}] is horizontally around the anchor x ${after.anchorX}`,
      ).toBe(true);
      expect(
        box.bottom <= after.anchorY + TOL_PX,
        `the sheet bottom ${box.bottom} is at or above the anchor y ${after.anchorY}`,
      ).toBe(true);
      await expect(prompt).toBeVisible();

      // A real click on the row runs it: the Shop NPC's `talk` opens the greeting.
      await rows.first().click({ timeout: 5_000 });
      await expect(page.locator('#dialogue-overlay'), 'the click ran the row').toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('#dialogue-node-text')).toHaveText(GREETING);
    });

    // KILLS: a world sheet that is not the kit's (an outside click never closes it, or falls
    // through to the canvas and presses A: the greeting would open); a close that also fires the
    // cursor row; a close that leaves the held input armed (the next press must walk exactly once).
    test('UIF12.4 a real click on the world canvas away from the open sheet closes it and does nothing else; the next movement press walks one tile', async () => {
      test.setTimeout(180_000);
      // Close the greeting (and anything above the world), then reopen the sheet.
      await closeAll(page);
      expect((await readWorld(page)).stackLength, 'precondition: the bare world').toBe(1);
      await expectPosted(page, SHOP_POST, 'East', 'uif-12 reopen');
      await pressButton(page, 'Y');
      const sheet = page.locator('#interact-prompt [data-context-sheet]');
      await expect(sheet, 'precondition: the sheet is open again').toBeVisible({ timeout: 10_000 });

      const canvas = page.locator('#game-screen canvas').first();
      const rect = await canvas.boundingBox();
      if (rect === null) throw new Error('the world canvas has no box');
      // Well away from the sheet (which hangs at the shopkeeper): the canvas's top-left corner.
      await page.mouse.click(rect.x + 24, rect.y + 24);

      await expect(sheet, 'the outside click closes the sheet').toBeHidden({ timeout: 5_000 });
      expect(
        await page.locator('#interact-prompt [role="option"]').count(),
        'no sheet row is left',
      ).toBe(0);
      expect((await readWorld(page)).stackLength, 'the stack is the bare world').toBe(1);
      // Nothing else fired: a canvas press of A would greet the shopkeeper; the bounded waits are
      // for the WRONG outcome.
      const dialogueOpened = await page
        .locator('#dialogue-overlay')
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      expect(dialogueOpened, 'the outside click must not run the cursor row (no greeting)').toBe(
        false,
      );
      const shopOpened = await page
        .locator('#shop-overlay')
        .waitFor({ state: 'visible', timeout: 1_000 })
        .then(() => true)
        .catch(() => false);
      expect(shopOpened, 'and open no shop').toBe(false);
      expect((await readWorld(page)).stackLength, 'still a bare world after the waits').toBe(1);

      // The next movement press walks exactly one tile (west, off the post).
      await pressButton(page, 'Left');
      await expectPosted(page, { x: 6, y: 1 }, 'West', 'uif-12 after the close');
    });
  });
