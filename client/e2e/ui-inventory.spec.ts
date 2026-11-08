import { execFileSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { t } from '../src/ui/i18n/resolver';
import { navItemId } from '../src/ui/navRender';
import { closeAll, pressAccel, pressButton } from './controls';
import { expectNear, expectSample, sampleStyle } from './uiKit';

// ui-inventory.spec.ts — uif-8 (M-ui-foundation): the Inventory frame on the UI kit, measured in
// Chromium (UIF8.1, UIF8.2, UIF8.4, UIF8.5; UIF8.3's toast half is deferred: `feed-ok` is a toast
// kind reachable only through main.ts `route()`, which is outside this slice).
//
// ORACLE RULE (uiKit.ts doctrine). UIF8.5 compares what Chromium computes for Inventory against what
// it computes for MONSTERS at the same 1280x720 window, property by property; the one literal is the
// wf-1 token `8px` panel padding, an anchor so two frames that are equally wrong cannot pass. The
// geometry claims compare measured rects with each other. Copy comes from the catalog through `t()`.
//
// SHARED-WORLD HYGIENE (workers: 1, one published db). Describe A: ONE browser context, ONE player (a
// fresh identity: one starter, an empty bag) plus one owner-SQL seed (a stack of Power Root, menu-flow
// .spec.ts's precedent), closed in afterAll. Describe B (the fixture page) is a SECOND browser whose
// main.ts is route-aborted (ui-monsters.spec.ts's UIF6.4 precedent), so it never connects. No fixed
// sleeps: every wait polls a bounded predicate.
//
// UIF8.1 EVIDENCE LABEL for the pseudo-scroll test: real modules + real CSS + a FAKE store. Owner SQL
// can seed `inventory` rows, but the shipped content defines only five item ids, so no pocket can
// overflow the list. The fixture page imports the real RaisingView, bagModel, bagScreen and
// PointerSource from the Vite dev server, builds the view model from fake rows (thirty foods), and
// wires PointerSource.press -> bagScreen.onButton -> paint exactly as main.ts does. The page-side code
// is a STRING (a function containing `import()` is rewritten by Playwright's transform).

const VIEWPORT = { width: 1280, height: 720 } as const;
const BIG = { width: 1920, height: 1080 } as const;

const FOOD_ITEM_ID = 2; // Power Root: `train_stat: Some(Attack)`, content/items/000-core.ron
const FOOD_NAME = 'Power Root';
const FOOD_SEED = 3;
const STARTER_SPECIES_NAME = 'Flameling'; // species 1

interface OwnItem {
  itemId: number;
  count: number;
}
interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string; speciesId: number; nickname: string }>;
  ownInventory: OwnItem[];
  stack: Array<{ kind: string; id?: string }>;
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game());

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

const stackNames = async (p: Page): Promise<string[]> =>
  (await snap(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );

/** Owner SQL: charset-validated, run without a shell (menu-flow.spec.ts's helper). */
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

/** Inventory opened by the accelerator a player presses (I): the menu stays beneath it. */
async function openInventory(p: Page): Promise<void> {
  await closeAll(p);
  await pressAccel(p, 'I');
  await expect
    .poll(() => stackNames(p), { message: 'I opens the Inventory' })
    .toEqual(['world', 'menuView', 'raisingView']);
  await expect(
    p.locator('[data-testid="raising-title"]'),
    'the Inventory title shows',
  ).toBeVisible();
  await expect(p.locator('#bag-tab-bait'), 'it opens on its first pocket').toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** Monsters opened by the accelerator V (Party). */
async function openMonsters(p: Page): Promise<void> {
  await closeAll(p);
  await pressAccel(p, 'V');
  await expect
    .poll(() => stackNames(p), { message: 'V opens Monsters' })
    .toEqual(['world', 'menuView', 'boxView']);
  await expect(p.locator('[data-testid="box-title"]'), 'the Monsters title shows').toBeVisible();
  await expect(p.locator('#monsters-tab-party'), 'Party is selected').toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** Everything the "A on Close == B" and "A on Back == B" claims compare, read in ONE evaluate. */
const bagObserve = (p: Page) =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    const sheet = document.getElementById('bag-sheet');
    const status = document.getElementById('bag-status');
    const ids = (sel: string): string[] =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.id);
    return {
      stack: g.stack.map(
        (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
      ),
      selectedTab: ids('#bag-tabs .is-selected'),
      activeListRow: ids('#bag-list .is-active'),
      sheetHidden: sheet === null ? null : sheet.hidden,
      sheetHeading: sheet?.querySelector('.mr-sheet-title')?.textContent ?? '',
      sheetRows: ids('#bag-sheet [role="option"]'),
      sheetActive: ids('#bag-sheet .is-active'),
      status:
        status === null
          ? null
          : { text: status.textContent, display: getComputedStyle(status).display },
    };
  });

test.describe
  .serial('UIF8 — Inventory on the UI kit, measured in Chromium (the real app)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let starterName = STARTER_SPECIES_NAME;

    test.beforeAll(async () => {
      test.setTimeout(90_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      const start = await snap(page);
      expect(start.ownMonsters, 'a fresh identity holds exactly its starter').toHaveLength(1);
      const starter = start.ownMonsters[0] as GameSnap['ownMonsters'][number];
      starterName = starter.nickname !== '' ? starter.nickname : STARTER_SPECIES_NAME;
      const hex = normId(start.identity);
      expect(/^[0-9a-f]{64}$/.test(hex), 'the identity is 64 hex digits').toBe(true);
      // One stack of Power Root: Food holds one item; Bait (the first pocket, opened first) and
      // Medicine hold none, so an empty pocket is one RB-free open away.
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
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF8.5 at 1280x720 the Inventory frame, title, tab bar, selected and unselected tab, tab-content panel and open context sheet compute the same spacing, borders and colours as Monsters', async () => {
      // WRONG IMPL KILLED: today's Bag (a bare `.mr-frame-tabstrip` with no TabBar row: the TabBar
      // selectors match nothing and the sample throws); a title still carrying `margin:0 0 16px`
      // (the header row owns the gap in Monsters); the measured `align-items:center` literal left on
      // the root (the frame root's computed align-items differs); a panel padded with a literal that
      // happens to differ (6px, 10px) or no panel padding at all (the 8px anchor); a sheet restyled
      // by an inline border or fill; a selected tab styled with the row cursor's inverted fill. Both
      // frames are sampled in ONE window and compared property by property.
      const FRAME = [
        'display',
        'flex-direction',
        'align-items',
        'justify-content',
        'padding',
        'margin',
        'gap',
        'border-width',
        'border-style',
        'border-color',
        'background-color',
        'color',
        'font-size',
      ] as const;
      const BOX = [
        'padding',
        'margin',
        'gap',
        'border-width',
        'border-style',
        'border-color',
        'background-color',
        'color',
        'font-size',
      ] as const;
      const PARTS: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
        [
          'the frame root',
          '.mr-frame:has([data-testid="box-title"])',
          '.mr-frame:has([data-testid="raising-title"])',
          FRAME,
        ],
        [
          'the header row',
          'div:has(> [data-testid="box-title"])',
          'div:has(> [data-testid="raising-title"])',
          FRAME,
        ],
        ['the title', '[data-testid="box-title"]', '[data-testid="raising-title"]', BOX],
        ['the TabBar row', '.mr-tabbar:has(#monsters-tabs)', '.mr-tabbar:has(#bag-tabs)', FRAME],
        ['the tab strip', '#monsters-tabs', '#bag-tabs', BOX],
        ['the selected tab', '#monsters-tabs .is-selected', '#bag-tabs .is-selected', BOX],
        [
          'an unselected tab',
          '#monsters-tabs [role="tab"]:not(.is-selected)',
          '#bag-tabs [role="tab"]:not(.is-selected)',
          BOX,
        ],
        ['the tab-content panel', '#monsters-panel', '#bag-panel', FRAME],
      ];
      const SHEET = '[data-context-sheet]:not([hidden])';
      const SHEET_PROPS = [...BOX, 'border-radius', 'display'] as const;

      // ---- Monsters, Party tab ------------------------------------------------------------------
      await openMonsters(page);
      const monsters: Record<string, Record<string, string>> = {};
      for (const [name, monsterSel, , props] of PARTS) {
        monsters[name] = await sampleStyle(page, monsterSel, props);
      }
      await pressButton(page, 'A'); // the starter's sheet
      await expect(page.locator(SHEET), 'the Monsters sheet is open').toBeVisible();
      const monstersSheet = await sampleStyle(page, SHEET, SHEET_PROPS);
      await pressButton(page, 'B');
      await expect(page.locator(SHEET), 'the Monsters sheet closed').toHaveCount(0);

      // ---- Inventory, Food pocket with its item --------------------------------------------------
      await openInventory(page);
      await pressButton(page, 'RB');
      await expect(page.locator('#bag-tab-food'), 'RB reaches Food').toHaveAttribute(
        'aria-selected',
        'true',
      );
      for (const [name, , bagSel, props] of PARTS) {
        const actual = await sampleStyle(page, bagSel, props);
        expectSample(
          actual,
          monsters[name] as Record<string, string>,
          `${name}: Inventory == Monsters`,
        );
      }
      // Anchors: the equality above cannot pass by both frames being equally wrong.
      expectSample(
        await sampleStyle(page, '#bag-panel', ['padding']),
        { padding: '8px 8px 8px 8px' },
        'the tab content area padding is --mr-space-2',
      );
      await pressButton(page, 'A'); // the berry's sheet
      await expect(page.locator(SHEET), 'the Inventory sheet is open').toBeVisible();
      expectSample(
        await sampleStyle(page, SHEET, SHEET_PROPS),
        monstersSheet,
        'the open context sheet: Inventory == Monsters',
      );
      expect(
        (monstersSheet['border-width'] ?? '').split(' ').some((w) => Number.parseFloat(w) > 0),
        'anchor: the sheet has a non-zero border',
      ).toBe(true);
      await pressButton(page, 'B');
    });

    test('UIF8.1 the Inventory tab bar is the first thing below the title with its LB and RB chips on the strip`s row, the list hides its overflow, and the tab-content panel grows to the frame`s free height at 1280x720 and again at 1920x1080', async () => {
      // WRONG IMPL KILLED: today's bare strip (no chips: the chip locators match nothing); a bar
      // placed below the panel or beside the title; chips stacked over the strip (the shared
      // vertical centre); a strip that absorbs free height (R-qf-11-GEOMETRY: strip height != tab
      // height); a list with scrollbars (`overflow-y: auto`); a content-sized panel that leaves a gap
      // of hundreds of px above the frame edge (the tail bound) or does not grow with the window (the
      // 1920 comparison); a growth that spends the panel's room on a status strip that is always
      // displayed (R-uif-4-BAGSTATUS-EMPTY: the trailing siblings are counted in the tail).
      await openInventory(page);
      const geometry = await page.evaluate(() => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom };
        };
        const strip = document.getElementById('bag-tabs');
        const row = strip?.parentElement;
        const title = document.querySelector('[data-testid="raising-title"]');
        const panel = document.getElementById('bag-panel');
        const list = document.getElementById('bag-list');
        if (!strip || !row || !title || !panel || !list) {
          throw new Error('the Inventory tab bar, title, panel or list is not in the document');
        }
        const kids = [...row.children];
        return {
          rowClass: row.className,
          chips: [kids[0], kids[2]].map((el) => (el as HTMLElement).dataset.button),
          title: box(title),
          row: box(row),
          lb: box(kids[0] as Element),
          strip: box(strip),
          rb: box(kids[2] as Element),
          tabs: [...strip.children].map(box),
          panel: box(panel),
          listOverflowY: getComputedStyle(list).overflowY,
        };
      });
      expect(geometry.rowClass, "the row is the TabBar's").toContain('mr-tabbar');
      expect(geometry.chips, 'LB chip first, RB chip last').toEqual(['LB', 'RB']);
      await expect(
        page.locator('.mr-tabbar:has(#bag-tabs) [data-button="LB"]'),
        'the LB chip is visible',
      ).toBeVisible();
      await expect(
        page.locator('.mr-tabbar:has(#bag-tabs) [data-button="RB"]'),
        'the RB chip is visible',
      ).toBeVisible();
      expect(geometry.row.y, 'the bar is below the title').toBeGreaterThanOrEqual(
        geometry.title.b - 0.5,
      );
      expect(geometry.row.y, 'the bar is above the panel').toBeLessThan(geometry.panel.y);
      expectNear(
        geometry.lb.y + geometry.lb.h / 2,
        geometry.strip.y + geometry.strip.h / 2,
        1,
        "LB chip is on the strip's row",
      );
      expectNear(
        geometry.rb.y + geometry.rb.h / 2,
        geometry.strip.y + geometry.strip.h / 2,
        1,
        "RB chip is on the strip's row",
      );
      expect(geometry.lb.x + geometry.lb.w, 'LB, then the strip').toBeLessThanOrEqual(
        geometry.strip.x + 1,
      );
      expect(geometry.strip.x + geometry.strip.w, 'the strip, then RB').toBeLessThanOrEqual(
        geometry.rb.x + 1,
      );
      expect(geometry.tabs.length, 'the four pockets').toBe(4);
      for (const [i, tab] of geometry.tabs.entries()) {
        expectNear(geometry.strip.h, tab.h, 0.5, `strip height == tab ${i} height`);
      }
      expect(geometry.listOverflowY, 'the list hides its overflow (pseudo-scroll)').toBe('hidden');

      const measure = (p: Page) =>
        p.evaluate(() => {
          const panel = document.getElementById('bag-panel');
          const frame = document
            .querySelector('[data-testid="raising-title"]')
            ?.closest('.mr-frame');
          if (panel === null || frame === null || frame === undefined) {
            throw new Error('the Inventory panel or frame is not in the document');
          }
          const pr = panel.getBoundingClientRect();
          const fr = frame.getBoundingClientRect();
          const fs = getComputedStyle(frame);
          const contentBottom =
            fr.bottom -
            Number.parseFloat(fs.borderBottomWidth) -
            Number.parseFloat(fs.paddingBottom);
          let trailing = Number.parseFloat(getComputedStyle(panel).marginBottom);
          for (let n = panel.nextElementSibling; n !== null; n = n.nextElementSibling) {
            const cs = getComputedStyle(n);
            if (cs.display === 'none') continue;
            trailing +=
              n.getBoundingClientRect().height +
              Number.parseFloat(cs.marginTop) +
              Number.parseFloat(cs.marginBottom);
          }
          return {
            panelW: pr.width,
            panelH: pr.height,
            tail: contentBottom - (pr.bottom + trailing),
          };
        });
      const small = await measure(page);
      expect(small.panelH, 'the panel has real height').toBeGreaterThan(100);
      expectNear(
        small.tail,
        0,
        1,
        '1280x720: the panel meets the frame edge (nothing displayed below it)',
      );
      try {
        await page.setViewportSize(BIG);
        await expect
          .poll(async () => (await measure(page)).panelH, {
            message: 'the panel grows taller at 1920x1080',
            timeout: 10_000,
          })
          .toBeGreaterThan(small.panelH + 1);
        const big = await measure(page);
        expectNear(big.tail, 0, 1, '1920x1080: the panel meets the frame edge');
      } finally {
        await page.setViewportSize(VIEWPORT);
        await expect
          .poll(async () => (await measure(page)).panelH, { timeout: 10_000 })
          .toBeCloseTo(small.panelH, 0);
      }
    });

    test('UIF8.2 the item sheet ends with a Close row and A on Close leaves exactly as B does, and the Feed picker ends with a Back row and A on Back returns to the sheet exactly as B does, feeding nothing', async () => {
      // WRONG IMPL KILLED: a sheet or picker with no last Close / Back row (the last `[role=option]`
      // is Info / the monster); a Close whose A does nothing or pops the whole Inventory (the stack
      // changes); one that leaves the list cursor off the item or the sheet open; a Back that sends
      // a train for a ghost monster (the inventory count drops), closes to the list instead of the
      // sheet, or lands on a different row than B does. Every A-path observation is compared, whole,
      // with the B-path one.
      await openInventory(page);
      await pressButton(page, 'RB');
      await expect(page.locator('#bag-tab-food')).toHaveAttribute('aria-selected', 'true');
      const berryRow = `#${navItemId('bag', 'food', String(FOOD_ITEM_ID))}`;
      await expect(page.locator(berryRow), 'the cursor is on the berry').toHaveAttribute(
        'aria-selected',
        'true',
      );
      const base = await bagObserve(page);
      expect(base.sheetHidden, 'precondition: no sheet in the list phase').toBe(true);
      expect(base.activeListRow, 'precondition: the berry row is the cursor').toEqual([
        berryRow.slice(1),
      ]);

      // ---- the item sheet -------------------------------------------------------------------------
      const rows = page.locator('#bag-sheet [role="option"]');
      await pressButton(page, 'A');
      await expect(page.locator('#bag-sheet'), 'A opens the sheet').toBeVisible();
      await expect(rows.last(), 'Close is the last row').toHaveAttribute(
        'id',
        navItemId('bagsheet', null, 'close'),
      );
      await expect(rows.last()).toHaveText(t('kit.sheet.close'));
      await expect(
        page.locator(`#${navItemId('bagsheet', null, 'feed')}`),
        'the sheet opens on Feed, never on Close',
      ).toHaveAttribute('aria-selected', 'true');
      await pressButton(page, 'Down');
      await pressButton(page, 'Down');
      await expect(rows.last(), 'two Downs reach Close').toHaveAttribute('aria-selected', 'true');
      await pressButton(page, 'A');
      await expect(page.locator('#bag-sheet'), 'A on Close closes the sheet').toBeHidden();
      const viaCloseA = await bagObserve(page);

      await pressButton(page, 'A'); // reopen on Feed
      await expect(page.locator('#bag-sheet')).toBeVisible();
      await pressButton(page, 'B');
      await expect(page.locator('#bag-sheet'), 'B closes the sheet').toBeHidden();
      const viaB = await bagObserve(page);
      expect(viaCloseA, 'A on Close == B (the whole observation)').toEqual(viaB);
      expect(viaCloseA, 'and both are the list as it was before the sheet opened').toEqual(base);
      expect(viaCloseA.stack, 'the Inventory is still open').toEqual([
        'world',
        'menuView',
        'raisingView',
      ]);

      // ---- the Feed picker ------------------------------------------------------------------------
      await pressButton(page, 'A'); // the sheet, on Feed
      await pressButton(page, 'A'); // Feed: the picker
      await expect(page.locator('#bagsheet-sheet-title'), 'A on Feed opens the picker').toHaveText(
        t('bag.picker.title'),
      );
      await expect(rows, 'the one monster, then Back').toHaveCount(2);
      await expect(rows.first()).toHaveText(starterName);
      await expect(rows.last(), 'Back is the last row').toHaveText(t('kit.sheet.back'));
      await pressButton(page, 'Down');
      await expect(rows.last(), 'Down reaches Back').toHaveAttribute('aria-selected', 'true');
      await pressButton(page, 'A');
      await expect(
        page.locator('#bagsheet-sheet-title'),
        'A on Back returns to the item sheet (headed by the item)',
      ).toHaveText(FOOD_NAME);
      const viaBackA = await bagObserve(page);
      expect(viaBackA.sheetActive, 'back on Feed').toEqual([navItemId('bagsheet', null, 'feed')]);

      await pressButton(page, 'A'); // the picker again
      await expect(page.locator('#bagsheet-sheet-title')).toHaveText(t('bag.picker.title'));
      await pressButton(page, 'B');
      await expect(page.locator('#bagsheet-sheet-title')).toHaveText(FOOD_NAME);
      const viaBackB = await bagObserve(page);
      expect(viaBackA, 'A on Back == B (the whole observation)').toEqual(viaBackB);
      expect(
        (await snap(page)).ownInventory.find((i) => i.itemId === FOOD_ITEM_ID)?.count,
        'nothing was fed',
      ).toBe(FOOD_SEED);
      await pressButton(page, 'B'); // the sheet closes to the list
      await expect(page.locator('#bag-sheet')).toBeHidden();
    });

    test('UIF8.4 an empty pocket shows the EmptyState with its reason, cue and next step, the title and the pocket tabs kept, and it is gone on a pocket with items', async () => {
      // WRONG IMPL KILLED: today's bare one-line "No items." (no cue, no next step); an EmptyState
      // built but left hidden or collapsed to zero size (toBeVisible); the cue / next-step lines
      // swapped or reusing the reason's text (each is compared with its own catalog line); the tab
      // bar or the title lost with the content; an EmptyState left over a pocket that has items.
      // The fr half is the unit suite's (raisingView.test.ts, catalog.test.ts): the page's locale
      // switch is not an e2e control.
      await openInventory(page); // Bait: nothing owned
      const empty = page.locator('#bag-panel .mr-empty');
      await expect(empty, 'the EmptyState is visible').toBeVisible();
      for (const [line, text] of [
        ['.mr-empty-reason', t('raising.inventory.empty')],
        ['.mr-empty-cue', t('bag.empty.cue')],
        ['.mr-empty-next', t('bag.empty.next')],
      ] as const) {
        const el = empty.locator(line);
        await expect(el, `${line} is visible`).toBeVisible();
        await expect(el, `${line} reads its catalog line`).toHaveText(text);
      }
      await expect(
        page.locator('[data-testid="raising-title"]'),
        'the title is kept',
      ).toBeVisible();
      for (const pocket of ['bait', 'food']) {
        await expect(page.locator(`#bag-tab-${pocket}`), `the ${pocket} tab is kept`).toBeVisible();
      }

      await pressButton(page, 'RB');
      await expect(page.locator('#bag-tab-food')).toHaveAttribute('aria-selected', 'true');
      await expect(
        page.locator('#bag-panel .mr-empty'),
        'Food has an item: no EmptyState',
      ).toHaveCount(0);
      await expect(
        page.locator(`#${navItemId('bag', 'food', String(FOOD_ITEM_ID))}`),
        'its row shows',
      ).toBeVisible();
    });
  });

// ===========================================================================================
// UIF8.1 (fixture page): the pseudo-scroll. See the file header for the evidence label.
//
// THE FIXTURE WORLD: one pocket (Food) of thirty foods "Berry 1".."Berry 30" (counts 2..31) and two
// monsters, so the list overflows its panel at 1280x720.
// ===========================================================================================

const UIF8_MOUNT = `(async () => {
  const [raisingMod, modelMod, screenMod, pointerMod] = await Promise.all([
    import('/src/ui/raisingView.ts'),
    import('/src/ui/bagModel.ts'),
    import('/src/ui/screens/bagScreen.ts'),
    import('/src/input/pointerSource.ts'),
  ]);
  const screenEl = document.querySelector('#game-screen');
  if (screenEl === null) throw new Error('#game-screen is missing');
  let app = document.getElementById('app');
  if (app === null) {
    app = document.createElement('div');
    app.id = 'app';
    screenEl.appendChild(app);
  }
  const view = new raisingMod.RaisingView(app);
  const defs = new Map();
  const inventory = [];
  for (let i = 1; i <= 30; i += 1) {
    defs.set(i, {
      id: i, name: 'Berry ' + i, description: 'About berry ' + i + '.', recruitBonus: 0,
      trainStat: 'attack', trainAmount: 1, sellPrice: 0n, cureStatus: null,
    });
    inventory.push({ invId: BigInt(i), ownerIdentity: 'fixture', itemId: i, count: i + 1 });
  }
  const vm = modelMod.buildBagVm(inventory, defs, [
    { key: '1', monsterId: 1n, name: 'Kip' },
    { key: '2', monsterId: 2n, name: 'Ember' },
  ]);
  let state = screenMod.bagScreen.init(vm);
  view.show();
  const paint = () => screenMod.bagScreen.paint(view, vm, state);
  paint();
  const press = (button) => {
    const step = screenMod.bagScreen.onButton(vm, state, { button, repeat: false });
    state = step.state;
    paint();
  };
  new pointerMod.PointerSource(screenEl, () => null, {
    top: () => 'frame',
    press,
    capturing: () => false,
    cancelCapture() {},
    choice() {},
    shop() {},
  });
  window.__uif8 = {
    press,
    item: () => state.nav.item,
    keys: vm.pockets[0].items.map((i) => i.key),
  };
  return true;
})()`;

interface Uif8Hook {
  press(button: string): void;
  item(): string | null;
  keys: string[];
}

test.describe
  .serial('UIF8 — the Inventory list pseudo-scroll (fixture page: real modules, real CSS, fake store)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await ctx.route('**/src/main.ts*', (route) => route.abort());
      page = await ctx.newPage();
      await page.goto('/');
      await page.waitForLoadState('load');
      expect(
        await page.evaluate(() => typeof (window as unknown as { __game?: unknown }).__game),
        'main.ts did not run',
      ).toBe('undefined');
      await page.evaluate(UIF8_MOUNT);
      await expect(page.locator('#bag-tab-food'), 'the fixture Inventory shows').toBeVisible();
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF8.1 an overflowing Inventory list hides its overflow with no scrollbar and draws the position cue, the D-pad keeps the cursor row (outline included) inside the list down to the last row, and a real mouse wheel over the list moves the cursor', async () => {
      // WRONG IMPL KILLED: today's list in a root that scrolls as a whole or `overflow-y: auto` (a
      // scrollbar: offsetWidth - clientWidth > 0, the cursor can leave the view); `overflow: hidden`
      // with no cursor scroll (the cursor row leaves the list's rect after the visible rows,
      // scrollTop stays 0); a list with no `mr-scroll` (the kit's layers are the cue: computed
      // background-attachment `local, local, scroll, scroll`, and no inline background that would
      // replace them); a list with no padding (the cursor outline clipped by overflow:hidden: the
      // outline box leaves the list rect); no wheel route (the cursor stays); a page that never
      // loaded the stylesheet (the root's `.mr-shell` rule is absolute).
      const listState = () =>
        page.evaluate(() => {
          const list = document.getElementById('bag-list');
          const root = list?.closest('.mr-shell');
          if (list === null || root === null || root === undefined) {
            throw new Error('the Inventory list or the shell root is missing');
          }
          const cs = getComputedStyle(list);
          const row = list.querySelector<HTMLElement>('[aria-current="true"], .is-active');
          const lr = list.getBoundingClientRect();
          let outline: { top: number; bottom: number } | null = null;
          if (row !== null) {
            const r = row.getBoundingClientRect();
            const rcs = getComputedStyle(row);
            const o = Number.parseFloat(rcs.outlineWidth) + Number.parseFloat(rcs.outlineOffset);
            outline = { top: r.top - o, bottom: r.bottom + o };
          }
          return {
            sheets: document.styleSheets.length,
            shellPosition: getComputedStyle(root).position,
            overflowY: cs.overflowY,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            scrollbar: list.offsetWidth - list.clientWidth,
            scrollTop: list.scrollTop,
            attachment: cs.backgroundAttachment,
            inlineStyle: list.getAttribute('style') ?? '',
            hasCue: list.classList.contains('mr-scroll'),
            cursorKey: row?.getAttribute('data-nav-key') ?? null,
            outline,
            top: lr.top,
            bottom: lr.bottom,
            left: lr.left,
            h: lr.height,
          };
        });
      const keys = await page.evaluate(
        () => (window as unknown as { __uif8: Uif8Hook }).__uif8.keys,
      );
      const itemNow = (): Promise<string | null> =>
        page.evaluate(() => (window as unknown as { __uif8: Uif8Hook }).__uif8.item());

      const first = await listState();
      expect(first.sheets, 'the stylesheet loaded').toBeGreaterThan(0);
      expect(first.shellPosition, 'the real .mr-shell rule applies to the view root').toBe(
        'absolute',
      );
      expect(first.overflowY, 'the list hides its overflow').toBe('hidden');
      expect(
        first.scrollHeight,
        'fixture: thirty rows overflow the list (non-vacuity)',
      ).toBeGreaterThan(first.clientHeight);
      expect(first.scrollbar, 'no scrollbar is drawn').toBe(0);
      expect(first.hasCue, 'the list wears mr-scroll').toBe(true);
      expect(first.attachment, 'the kit`s position cue layers are in force').toBe(
        'local, local, scroll, scroll',
      );
      expect(first.inlineStyle.includes('background'), 'no inline background').toBe(false);
      expect(first.cursorKey, 'the cursor opens on the first item').toBe(keys[0]);

      // The wheel: over a row in the middle of the list, one real notch down moves the cursor one row
      // from wherever the hover left it, one notch up moves it back.
      const middle = await page.evaluate((key) => {
        const row = document.querySelector<HTMLElement>(`#bag-list [data-nav-key="${key}"]`);
        if (row === null) throw new Error('fixture: the middle row is missing');
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, keys[3] as string);
      await page.mouse.move(middle.x, middle.y);
      const before = await itemNow();
      const at = keys.indexOf(before as string);
      expect(at, 'the cursor is a listed row').toBeGreaterThanOrEqual(0);
      expect(at + 1, 'fixture: there is a row below').toBeLessThan(keys.length);
      await page.mouse.wheel(0, 100);
      await expect
        .poll(itemNow, { message: 'a wheel notch down moves the cursor one row' })
        .toBe(keys[at + 1]);
      await page.mouse.wheel(0, -100);
      await expect.poll(itemNow, { message: 'a wheel notch up moves it back' }).toBe(before);

      // Back to the first row (fresh page state), then D-pad Down to the last row: the cursor row's
      // outline box stays inside the list's rect at every step.
      for (let i = 0; i < keys.length; i += 1) {
        if ((await itemNow()) === keys[0]) break;
        await page.evaluate(() => (window as unknown as { __uif8: Uif8Hook }).__uif8.press('Up'));
      }
      expect(await itemNow(), 'back on the first row').toBe(keys[0]);
      const inside = (s: Awaited<ReturnType<typeof listState>>, label: string): void => {
        expect(s.outline, `${label}: a cursor row is marked`).not.toBeNull();
        const o = s.outline as { top: number; bottom: number };
        expect(o.top, `${label}: outline top inside the list`).toBeGreaterThanOrEqual(s.top - 0.5);
        expect(o.bottom, `${label}: outline bottom inside the list`).toBeLessThanOrEqual(
          s.bottom + 0.5,
        );
      };
      inside(await listState(), 'row 0');
      for (let row = 1; row < keys.length; row += 1) {
        await page.evaluate(() => (window as unknown as { __uif8: Uif8Hook }).__uif8.press('Down'));
        await expect
          .poll(async () => (await listState()).cursorKey, {
            message: `Down ${row} reaches row ${row}`,
          })
          .toBe(keys[row]);
        inside(await listState(), `row ${row}`);
      }
      expect(
        (await listState()).scrollTop,
        'the list scrolled to keep the last row in view',
      ).toBeGreaterThan(0);
    });
  });
