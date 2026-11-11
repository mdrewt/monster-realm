import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  expectNear,
  expectRect,
  type Rect,
  rectsOverlap,
  resolveLength,
  sampleRect,
  sampleStyle,
} from './uiKit';

// ui-screens.spec.ts — uif-10 (M-ui-foundation): Shop, Heal, Journal and the trade session editor on
// the UI kit, measured in Chromium (UIF10.1 - UIF10.4).
//
// EVIDENCE LABEL: real modules + real CSS + FAKE data. The page is the real index.html and the real
// stylesheet served by the Vite dev server (main.ts is route-aborted, so it never connects: the uif-8
// and uif-9 fixture-page precedent in ui-inventory.spec.ts and ui-social.spec.ts). The page-side code
// imports the real ShopView, HealView, QuestLogView and TradeSessionView, and drives Shop, the
// Journal and the trade editor through the real shopScreen, journalScreen and tradeSessionScreen
// adapters (the editor's view model built by the real `buildTradeSessionVm` over fake rows), exactly
// as main.ts does, so what is measured is what the shipped modules and the shipped CSS compute. The
// page-side code is a STRING (a function containing `import()` is rewritten by Playwright).
//
// ts-3 (named intentional change): the propose wizard is deleted, so its fixture is re-pointed onto
// the session editor, which mounts on the same `#tradepropose-overlay` shell. Kept where the subject
// still exists: the root's start padding and the first body line at the content-left (UIF10.3, the
// first line is now the editor's title), many rows kept inside the root with the cursor row in view
// (UIF10.3, was the monsters list keeping submit inside the root: the editor has no submit, its last
// row is Cancel trade), and the axe scan (UIF10.4, now on the list and on the confirm prompt).
// DROPPED with their subject: "the step header is 2rem tall" and "the step header is above the
// target select" (the editor has no step header and no target select).
//
// ORACLE RULE (uiKit.ts doctrine). Geometry is compared with what Chromium computes for the same page
// (a root's content-left against a row's left edge, a list's rect against its root's content box);
// the one literal anchor is the root's start padding, resolved from `--mr-space-4` through a real
// probe, so four roots that are equally wrong cannot pass.
//
// No fixed sleeps: every wait polls a bounded predicate. The fixture page is rebuilt before each
// test (the cursor positions are state), and the browser is closed in afterAll.

const VIEWPORT = { width: 1280, height: 720 } as const;

// THE FIXTURE WORLD. `show(screen, n)` hides the other three roots, then shows one screen: Shop with
// n items to buy and n stacks to sell, the Journal with n quests, Heal with its one bound location,
// the trade editor on one session with a full party of six and n item stacks to offer (each one an
// editor row). Shop, the Journal and the trade editor are driven by their real adapters (`press`);
// the fake store and the fake session rows carry only what the adapters and the model read.
const UIF10_MOUNT = `(async () => {
  const [sv, ss, hv, qv, js, tsv, tsm, tss] = await Promise.all([
    import('/src/ui/shopView.ts'), import('/src/ui/screens/shopScreen.ts'),
    import('/src/ui/healView.ts'), import('/src/ui/questLogView.ts'),
    import('/src/ui/screens/journalScreen.ts'),
    import('/src/ui/tradeSessionView.ts'), import('/src/ui/tradeSessionModel.ts'),
    import('/src/ui/screens/tradeSessionScreen.ts'),
  ]);
  const me = 'ab'.repeat(32);
  const them = 'cd'.repeat(32);
  const noop = async () => {};
  const shopView = new sv.ShopView({ onBuy: noop, onSell: noop });
  const healView = new hv.HealView();
  const questView = new qv.QuestLogView();
  const tradeView = new tsv.TradeSessionView({ announce: () => {} });

  function shopCtx(n) {
    const defs = new Map(), stock = [], inv = [];
    for (let i = 0; i < n; i += 1) {
      const id = 100 + i;
      defs.set(id, { id, name: 'Item ' + i, description: 'Description ' + i, recruitBonus: 0,
        trainStat: null, trainAmount: 0, sellPrice: 5n, cureStatus: null });
      stock.push({ shopItemId: BigInt(i + 1), shopId: 3, itemId: id, buyPrice: 10n });
      inv.push({ invId: BigInt(i + 1), ownerIdentity: me, itemId: id, count: 5 });
    }
    return { identity: me, now: () => 0, shopId: 3, healLocationId: null, reduceMotion: false,
      store: { allShops: () => [{ shopId: 3, name: 'Tideglass' }], allShopItems: () => stock,
        itemDefs: () => defs, ownInventory: () => inv,
        ownWallet: () => ({ ownerIdentity: me, balance: 250n }) } };
  }
  function questCtx(n) {
    const quests = [];
    for (let i = 0; i < n; i += 1) quests.push({ pqId: BigInt(i + 1), ownerIdentity: me, questId: 'quest_' + i, stepIndex: 0 });
    return { identity: me, now: () => 0, store: { ownQuests: () => quests } };
  }
  // One session (id 7, revision 3) the viewer opened with Bob: the viewer offers its first monster,
  // Bob offers one monster, one item and 10 coins and has confirmed. The viewer holds a full party
  // of six, n item stacks and 250 coins, so the editor lists 6 monster rows, n item rows, then
  // Coins, Update offer, Confirm trade and Cancel trade.
  function tradeVm(n) {
    const card = (id, name) => ({ monsterId: id, speciesId: 1, nickname: name, level: 3, currentHp: 20, statHp: 20 });
    const ownMonsters = [], itemDefs = new Map(), inventory = [];
    for (let i = 0; i < 6; i += 1) {
      ownMonsters.push({ monsterId: BigInt(i + 1), ownerIdentity: me, speciesId: 1, nickname: 'Monster ' + i,
        level: 3, xp: 0, currentHp: 20, statHp: 20, statAttack: 5, statDefense: 5, statSpeed: 5,
        statSpAttack: 5, statSpDefense: 5, partySlot: i, tier: 0, qualityTimeTier: 0, nutritionPct: 0,
        lastCareAtMs: 0n });
    }
    for (let i = 0; i < n; i += 1) {
      const id = 100 + i;
      itemDefs.set(id, { id, name: 'Item ' + i, description: 'Description ' + i, recruitBonus: 0,
        trainStat: null, trainAmount: 0, sellPrice: 5n, cureStatus: null });
      inventory.push({ invId: BigInt(i + 1), ownerIdentity: me, itemId: id, count: 5 });
    }
    if (!itemDefs.has(100)) itemDefs.set(100, { id: 100, name: 'Item 0', description: '', recruitBonus: 0,
      trainStat: null, trainAmount: 0, sellPrice: 5n, cureStatus: null });
    const session = { sessionId: 7n, opener: me, partner: them,
      openerOffer: { monsterIds: [1n], items: [], currency: 0n, cards: [card(1n, 'Monster 0')] },
      partnerOffer: { monsterIds: [50n], items: [{ itemId: 100, qty: 1 }], currency: 10n,
        cards: [card(50n, 'Visitor')] },
      openerConfirmed: false, partnerConfirmed: true, revision: 3n, createdAtMs: 0n };
    return tsm.buildTradeSessionVm({
      sessions: [session], identity: me, sessionId: 7n,
      players: [{ identity: me, entityId: 1n, name: 'Me', online: true, lastInputSeq: 0n },
        { identity: them, entityId: 2n, name: 'Bob', online: true, lastInputSeq: 0n }],
      ownMonsters, speciesMap: new Map([[1, { name: 'Flameling' }]]), itemDefs, inventory,
      balance: 250n, legacyOfferMonsterIds: new Set(), battleMonsterIds: new Set(),
      partySize: 6, maxMonstersPerSide: 6 });
  }

  let adapter = null, view = null, vm = null, state = null;
  window.__uif10 = {
    show(screen, n) {
      shopView.hide(); healView.hide(); questView.hide(); tradeView.hide();
      adapter = null; view = null;
      if (screen === 'shop') {
        vm = ss.shopScreen.viewModel(shopCtx(n));
        shopView.render(vm.shop); shopView.show();
        adapter = ss.shopScreen; view = shopView; state = adapter.init(vm); adapter.paint(view, vm, state);
      } else if (screen === 'journal') {
        vm = js.journalScreen.viewModel(questCtx(n));
        questView.render(vm);
        adapter = js.journalScreen; view = questView; state = adapter.init(vm); adapter.paint(view, vm, state);
      } else if (screen === 'heal') {
        healView.render({ locations: [{ locationId: 1, zoneId: 0, tileX: 4, tileY: 9, costItemName: null,
          costQty: 0, costCurrency: 0n, cooldownMs: 0, isFree: true }] });
      } else if (screen === 'trade') {
        vm = tradeVm(n);
        if (vm.kind !== 'session') throw new Error('the fixture session built no editor view model');
        adapter = tss.tradeSessionScreen; view = tradeView; state = adapter.init(vm, undefined);
        adapter.paint(view, vm, state); tradeView.show(); adapter.paint(view, vm, state);
      } else throw new Error('unknown screen ' + screen);
    },
    press(button, times) {
      for (let i = 0; i < times; i += 1) {
        state = adapter.onButton(vm, state, { button, repeat: false }).state;
        adapter.paint(view, vm, state);
      }
    },
  };
  return true;
})()`;

type Screen = 'shop' | 'heal' | 'journal' | 'trade';

interface Uif10Hook {
  show(screen: Screen, n: number): void;
  press(button: string, times: number): void;
}

const show = (p: Page, screen: Screen, n = 3): Promise<void> =>
  p.evaluate(
    ({ screen: s, n: k }) => (window as unknown as { __uif10: Uif10Hook }).__uif10.show(s, k),
    { screen, n },
  );
const press = (p: Page, button: string, times = 1): Promise<void> =>
  p.evaluate(
    ({ button: b, times: k }) => (window as unknown as { __uif10: Uif10Hook }).__uif10.press(b, k),
    { button, times },
  );

const ROOT: Readonly<Record<Screen, string>> = {
  shop: '#shop-overlay',
  heal: '#heal-overlay',
  journal: '#quest-log-overlay',
  trade: '#tradepropose-overlay',
};

/** The first body row (or, for the trade editor, its title) whose left edge starts the root's
 *  content box. */
const FIRST_LINE: Readonly<Record<Screen, string>> = {
  shop: '#shop-for-sale li',
  heal: '#heal-list li',
  journal: '#quest-log-list li',
  trade: '#tradesession-title',
};

const rectOf = (p: Page, selector: string): Promise<Rect> => sampleRect(p, selector);

interface RootBox {
  readonly rootLeft: number;
  readonly paddingLeft: string;
  readonly contentLeft: number;
  readonly contentTop: number;
  readonly contentBottom: number;
  readonly firstLeft: number;
}

/** A root's content box (border and padding taken off its border box) and a row's left edge. */
const rootBox = (p: Page, root: string, first: string): Promise<RootBox> =>
  p.evaluate(
    ({ root: r, first: f }) => {
      const rootEl = document.querySelector(r);
      const firstEl = document.querySelector(f);
      if (rootEl === null) throw new Error(`no root ${r}`);
      if (firstEl === null) throw new Error(`no first line ${f}`);
      const rr = rootEl.getBoundingClientRect();
      const cs = getComputedStyle(rootEl);
      const px = (v: string): number => Number.parseFloat(v);
      return {
        rootLeft: rr.left,
        paddingLeft: cs.paddingLeft,
        contentLeft: rr.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
        contentTop: rr.top + px(cs.borderTopWidth) + px(cs.paddingTop),
        contentBottom: rr.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
        firstLeft: firstEl.getBoundingClientRect().left,
      };
    },
    { root, first },
  );

interface ScrollBox {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly bottom: number;
}
const scrollBox = (p: Page, selector: string): Promise<ScrollBox> =>
  p.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element ${sel}`);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      bottom: el.getBoundingClientRect().bottom,
    };
  }, selector);

/** Whether `inner` lies inside `outer` on the vertical axis, within a pixel. */
const insideV = (inner: Rect, outer: Rect): boolean =>
  inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1;

// WCAG 2.2 Level AA, the conformance claim the a11y.spec.ts tier makes: nothing wider.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PASSES_FLOOR = 5;

// Each scan is scoped to the screen's root: the static hint chips (#chip-start, #chip-select) are
// labelled by main.ts at boot, which this fixture route-aborts, so a page-wide scan would report
// them as unlabelled buttons (a fixture artifact, not the screen under test).
async function expectAxeClean(page: Page, label: string, root: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include(root)
    .withTags(AXE_TAGS)
    .exclude('canvas')
    .analyze();
  const found = results.violations
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
    .join('\n');
  expect(results.testEngine.name, `${label}: results did not come from axe-core`).toBe('axe-core');
  expect(results.violations, `${label}: axe reported violations\n${found}`).toEqual([]);
  expect(
    results.passes.length,
    `${label}: axe evaluated only ${results.passes.length} passing rule(s) (floor ${PASSES_FLOOR})`,
  ).toBeGreaterThanOrEqual(PASSES_FLOOR);
}

// ---------------------------------------------------------------------------------------------

test.describe
  .serial('UIF10 — Shop, Heal, Journal and the trade session editor on the UI kit (fixture page: real modules, real CSS, fake data)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      // axe needs a context made by newContext (the a11y.spec.ts precedent), not the default page.
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await ctx.route('**/src/main.ts*', (route) => route.abort());
      page = await ctx.newPage();
    });

    test.beforeEach(async () => {
      test.setTimeout(60_000);
      await page.goto('/');
      await page.waitForLoadState('load');
      expect(
        await page.evaluate(() => typeof (window as unknown as { __game?: unknown }).__game),
        'main.ts did not run',
      ).toBe('undefined');
      await page.evaluate(UIF10_MOUNT);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF10.1 the Shop TabBar is visible with both chips and keeps its rect when RB and LB switch Buy and Sell, and A, A on a Buy row opens the confirm sheet inside the body, bordered, off the cursor row, on Yes', async () => {
      // WRONG IMPL KILLED: today's bare `.mr-frame-tabstrip` (no `.mr-tabbar` row, no chips: the
      // locators match nothing); a bar that moves or resizes between Buy and Sell; chips with no
      // width; the confirm still the old Yes/No under the prompt (no `[data-context-sheet]`,
      // nothing bordered); a sheet outside the body, or over the cursor row it confirms; a sheet
      // whose cursor ignores the shipped Buy default (Yes).
      await show(page, 'shop', 3);
      await expect(page.locator('#shop-overlay')).toBeVisible();

      const bar = '#shop-overlay .mr-tabbar';
      await expect(page.locator(bar), 'the TabBar root is visible').toBeVisible();
      await expect(page.locator(`${bar} [data-button="LB"]`), 'the LB chip').toBeVisible();
      await expect(page.locator(`${bar} [data-button="RB"]`), 'the RB chip').toBeVisible();
      for (const button of ['LB', 'RB']) {
        const chip = await rectOf(page, `${bar} [data-button="${button}"]`);
        expect(chip.width, `the ${button} chip has width`).toBeGreaterThan(0);
      }

      await expect(page.locator('#shop-tab-buy'), 'opens on Buy').toHaveClass(/is-selected/);
      const onBuy = await rectOf(page, bar);
      await press(page, 'RB');
      await expect(page.locator('#shop-tab-sell'), 'RB selects Sell').toHaveClass(/is-selected/);
      await expect(page.locator('#shop-tab-buy')).not.toHaveClass(/is-selected/);
      expect(
        await page.locator('#shop-tabs .is-active').count(),
        'no tab ever carries the row cursor mark',
      ).toBe(0);
      expectRect(await rectOf(page, bar), onBuy, 0.5, 'the TabBar rect on Sell == on Buy');
      await press(page, 'LB');
      await expect(page.locator('#shop-tab-buy'), 'LB selects Buy').toHaveClass(/is-selected/);
      expectRect(await rectOf(page, bar), onBuy, 0.5, 'the TabBar rect back on Buy == the first');

      // A on a row opens the quantity row, A again the confirm (Buy defaults to Yes).
      await press(page, 'A', 2);
      const sheet = '#shop-confirm';
      await expect(page.locator(sheet), 'the confirm sheet is visible').toBeVisible();
      await expect(page.locator(`${sheet}[data-context-sheet]`)).toHaveCount(1);
      await expect(
        page.locator(`${sheet} [data-nav-key].is-active`),
        'the shipped Buy default is Yes',
      ).toHaveAttribute('data-nav-key', 'yes');

      const body = await rectOf(page, '#shop-body');
      await expect
        .poll(async () => insideRect(await rectOf(page, sheet), body), {
          message: 'the sheet is inside #shop-body',
        })
        .toBe(true);
      await expect
        .poll(
          async () =>
            rectsOverlap(
              await rectOf(page, sheet),
              await rectOf(page, '#shop-for-sale li.is-active'),
            ),
          { message: 'the sheet does not cover the cursor row' },
        )
        .toBe(false);
      const border = await sampleStyle(page, sheet, ['border-width', 'border-style']);
      const widths = (border['border-width'] as string).split(' ').map(Number.parseFloat);
      expect(
        widths.every((w) => w > 0),
        `the sheet has a visible border on every side (got ${border['border-width']})`,
      ).toBe(true);
      expect(border['border-style'], 'a drawn border style').not.toMatch(/none/);
    });

    test('UIF10.2 an empty Journal shows the kit empty state below its title bar with the exact reason sentence and the title kept', async () => {
      // WRONG IMPL KILLED: today's bare text div (no `.mr-empty` box); an empty state above or
      // over the title; a rewritten sentence or an added cue or next step (the reason line is the
      // whole text); the title lost.
      await show(page, 'journal', 0);
      await expect(page.locator('#quest-log-overlay')).toBeVisible();
      await expect(page.locator('#quest-log-title'), 'the title is kept').toBeVisible();

      const empty = '#quest-log-overlay .mr-empty';
      await expect(page.locator(empty), 'the empty-state box is visible').toBeVisible();
      await expect(page.locator(`${empty} .mr-empty-reason`)).toHaveText(
        'No active quests yet. Talk to villagers to find out who needs help.',
      );
      await expect(page.locator(`${empty} .mr-empty-cue, ${empty} .mr-empty-next`)).toHaveCount(0);

      const title = await rectOf(page, '#quest-log-title');
      const box = await rectOf(page, empty);
      expect(box.width, 'the box has a size').toBeGreaterThan(0);
      expect(box.height, 'the box has a size').toBeGreaterThan(0);
      expect(
        box.y,
        `the empty box (top ${box.y}) is below the title (bottom ${title.y + title.height})`,
      ).toBeGreaterThanOrEqual(title.y + title.height - 0.5);
    });

    test('UIF10.3 on all four roots the first body row starts at the root content-left (no UA list indent), Shop and the Journal scroll many rows with the D-pad cursor kept in view, and the trade editor keeps 40 rows inside the root with its last row (Cancel trade) in view under the cursor', async () => {
      // WRONG IMPL KILLED: a bare `ul` / `ol` indent (Heal's header measured at x 66 against the
      // root's content edge at x 26: the row starts 40px right of the frame); a list that grows
      // past the root instead of scrolling inside it; a D-pad cursor that walks out of the list's
      // rect (scrolled under the clip); a trade editor whose rows push the root past the screen or
      // leave the cursor's last row (Cancel trade) clipped out of the root.
      // ts-3 (named intentional change): the step-header checks (2rem tall, above the target
      // select) are dropped with the wizard; see the header.
      const token = await resolveLength(page, '--mr-space-4');

      const bigN: Readonly<Record<Screen, number>> = { shop: 40, heal: 1, journal: 40, trade: 30 };
      for (const screen of ['shop', 'heal', 'journal', 'trade'] as const) {
        await show(page, screen, bigN[screen]);
        await expect(page.locator(ROOT[screen]), `${screen}: the root shows`).toBeVisible();
        const box = await rootBox(page, ROOT[screen], FIRST_LINE[screen]);

        expectNear(
          Number.parseFloat(box.paddingLeft),
          Number.parseFloat(token),
          0.5,
          `${screen}: the root's start padding is --mr-space-4 (${token})`,
        );
        expectNear(
          box.firstLeft,
          box.contentLeft,
          1,
          `${screen}: the first body row starts at the root's content-left (${box.contentLeft})`,
        );
      }

      // Shop: 40 items scroll inside the list, which stays inside the root; the cursor stays in view.
      await show(page, 'shop', 40);
      let scroll = await scrollBox(page, '#shop-for-sale');
      let box = await rootBox(page, ROOT.shop, FIRST_LINE.shop);
      expect(scroll.scrollHeight, 'shop: 40 rows overflow the list').toBeGreaterThan(
        scroll.clientHeight,
      );
      expect(scroll.bottom, 'shop: the list ends inside the root content box').toBeLessThanOrEqual(
        box.contentBottom + 1,
      );
      await press(page, 'Down', 39);
      await expect(page.locator('#shop-for-sale li.is-active')).toContainText('Item 39');
      await expect
        .poll(
          async () =>
            insideV(
              await rectOf(page, '#shop-for-sale li.is-active'),
              await rectOf(page, '#shop-for-sale'),
            ),
          { message: 'shop: the last cursor row is inside the list rect' },
        )
        .toBe(true);

      // Journal: the same with 40 quests.
      await show(page, 'journal', 40);
      scroll = await scrollBox(page, '#quest-log-list');
      box = await rootBox(page, ROOT.journal, FIRST_LINE.journal);
      expect(scroll.scrollHeight, 'journal: 40 rows overflow the list').toBeGreaterThan(
        scroll.clientHeight,
      );
      expect(
        scroll.bottom,
        'journal: the list ends inside the root content box',
      ).toBeLessThanOrEqual(box.contentBottom + 1);
      await press(page, 'Down', 39);
      await expect(page.locator('#quest-log-list li.is-active')).toHaveAttribute(
        'data-quest-id',
        'quest_39',
      );
      await expect
        .poll(
          async () =>
            insideV(
              await rectOf(page, '#quest-log-list li.is-active'),
              await rectOf(page, '#quest-log-list'),
            ),
          { message: 'journal: the last cursor row is inside the list rect' },
        )
        .toBe(true);

      // The trade editor: 6 monster rows + 30 item rows + Coins, Update offer, Confirm trade and
      // Cancel trade. The rows alone are taller than the root (so the case is not vacuous), the
      // root stays on screen, and a fresh Up from the first row (a wrap) puts the cursor on Cancel
      // trade, which must then lie inside the root.
      await show(page, 'trade', 30);
      const rows = '#tradesession-rows [data-nav-key]';
      await expect(page.locator(rows), 'trade: the editor lists 40 rows').toHaveCount(40);
      await expect(page.locator('#tradesession-rows [data-nav-key="item-129"]')).toHaveCount(1);
      const root = await rectOf(page, ROOT.trade);
      const rowsHeight = await page.evaluate(
        (sel) =>
          [...document.querySelectorAll(sel)].reduce(
            (sum, el) => sum + el.getBoundingClientRect().height,
            0,
          ),
        rows,
      );
      expect(
        rowsHeight,
        `trade: the 40 rows (${rowsHeight}px) are taller than the root (${root.height}px)`,
      ).toBeGreaterThan(root.height);
      expect(root.height, 'trade: the root is laid out').toBeGreaterThan(0);
      expect(
        root.y + root.height,
        `trade: the root (${root.y}..${root.y + root.height}) stays inside the viewport`,
      ).toBeLessThanOrEqual(VIEWPORT.height + 0.5);
      await expect(page.locator('#tradesession-rows [aria-selected="true"]')).toHaveAttribute(
        'data-nav-key',
        'monster-1',
      );
      await press(page, 'Up');
      const last = '#tradesession-rows [data-nav-key="cancel"]';
      await expect(page.locator(last), 'trade: Up wraps to Cancel trade').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect
        .poll(async () => insideV(await rectOf(page, last), await rectOf(page, ROOT.trade)), {
          message: 'trade: the cursor row Cancel trade lies inside the root',
        })
        .toBe(true);
    });

    test('UIF10.4 axe is clean on Shop (confirm phase), Heal, an empty Journal and the trade editor (its list and its confirm prompt), and the Shop quantity row keeps its Left/Right clamping in Chromium', async () => {
      // WRONG IMPL KILLED: a kit adoption that adds an a11y violation on any of the four screens
      // (a chip announced as text, a tablist with a non-tab child, a sheet with no accessible
      // name, an unlabelled live region, a contrast loss); a vacuous scan (the passes floor); a
      // quantity row whose Left wraps or whose Right overruns after the rewrite.
      await show(page, 'shop', 3);
      await press(page, 'A', 2);
      await expect(page.locator('#shop-confirm'), 'shop: in its confirm phase').toBeVisible();
      await expectAxeClean(page, 'shop (confirm)', ROOT.shop);

      await show(page, 'heal', 1);
      await expect(page.locator('#heal-overlay')).toBeVisible();
      await expectAxeClean(page, 'heal', ROOT.heal);

      await show(page, 'journal', 0);
      await expect(page.locator('#quest-log-overlay')).toBeVisible();
      await expectAxeClean(page, 'journal (empty)', ROOT.journal);

      // ts-3 (named intentional change): was the propose wizard's first step. The editor's list,
      // then its confirm prompt (Up twice from the first row wraps to Cancel trade, then Confirm
      // trade; A opens the prompt).
      await show(page, 'trade', 3);
      await expect(page.locator('#tradepropose-overlay')).toBeVisible();
      await expect(page.locator('#tradesession-rows [data-nav-key]')).toHaveCount(13);
      await expectAxeClean(page, 'trade editor (list)', ROOT.trade);
      await press(page, 'Up', 2);
      await expect(page.locator('#tradesession-rows [data-nav-key="confirm"]')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await press(page, 'A');
      await expect(page.locator('#tradesession-prompt'), 'trade: the confirm prompt').toBeVisible();
      await expectAxeClean(page, 'trade editor (confirm prompt)', ROOT.trade);

      // The quantity row (a non-regression guard: the clamp is the adapter's and does not change).
      await show(page, 'shop', 3);
      await press(page, 'A');
      const text = page.locator('#shop-prompt-text');
      await expect(text, 'the quantity row is up').toContainText('Item 0');
      const atOne = (await text.textContent()) ?? '';
      expect(atOne, 'opens at quantity 1').toMatch(/\b1\b/);
      await press(page, 'Left');
      await expect(text, 'Left at 1 stays 1').toHaveText(atOne);
      await press(page, 'Right', 3);
      await expect(text, 'Right x3 reads 4').toContainText('4');
      expect((await text.textContent()) ?? '').toMatch(/\b4\b/);
    });
  });

/** `inner` lies inside `outer` on both axes, within a pixel. */
function insideRect(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}
