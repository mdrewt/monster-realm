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

// ui-screens.spec.ts — uif-10 (M-ui-foundation): Shop, Heal, Journal and Trade propose on the UI kit,
// measured in Chromium (UIF10.1 - UIF10.4).
//
// EVIDENCE LABEL: real modules + real CSS + FAKE data. The page is the real index.html and the real
// stylesheet served by the Vite dev server (main.ts is route-aborted, so it never connects: the uif-8
// and uif-9 fixture-page precedent in ui-inventory.spec.ts and ui-social.spec.ts). The page-side code
// imports the real ShopView, HealView, QuestLogView and TradeProposeView, and drives Shop and the
// Journal through the real shopScreen and journalScreen adapters with a fake store, exactly as
// main.ts does, so what is measured is what the shipped modules and the shipped CSS compute. The
// page-side code is a STRING (a function containing `import()` is rewritten by Playwright).
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
// Trade propose with two targets and n offerable monsters. Shop and the Journal are driven by their
// real adapters (`press`); the fake store carries only what the adapters read.
const UIF10_MOUNT = `(async () => {
  const [sv, ss, hv, qv, js, tv, tm] = await Promise.all([
    import('/src/ui/shopView.ts'), import('/src/ui/screens/shopScreen.ts'),
    import('/src/ui/healView.ts'), import('/src/ui/questLogView.ts'),
    import('/src/ui/screens/journalScreen.ts'),
    import('/src/ui/tradeProposeView.ts'), import('/src/ui/tradeProposeModel.ts'),
  ]);
  const me = 'ab'.repeat(32);
  const noop = async () => {};
  const shopView = new sv.ShopView({ onBuy: noop, onSell: noop });
  const healView = new hv.HealView();
  const questView = new qv.QuestLogView();
  const tradeView = new tv.TradeProposeView({ onSubmit: noop, maxMonstersPerSide: 6 });

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
  function tradeLists(n) {
    const offerableMonsters = [];
    for (let i = 0; i < n; i += 1) offerableMonsters.push({ monsterId: BigInt(i + 1), label: 'Monster ' + i + ' Lv.3' });
    return { targets: [{ identity: '0xaaa1', label: 'Alice' }, { identity: '0xbbb2', label: 'Bob' }], offerableMonsters };
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
        const lists = tradeLists(n);
        tradeView.render(lists); tradeView.show();
        tradeView.paint({ steps: tm.proposeSteps(false), step: 'target', lists,
          offerCursor: n > 0 ? '1' : null, yes: true, toggle: null, commit: null });
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

/** The first body row (or, for Trade propose, the step header) whose left edge starts the root's
 *  content box. */
const FIRST_LINE: Readonly<Record<Screen, string>> = {
  shop: '#shop-for-sale li',
  heal: '#heal-list li',
  journal: '#quest-log-list li',
  trade: '[data-testid="tradepropose-steps"]',
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
  .serial('UIF10 — Shop, Heal, Journal and Trade propose on the UI kit (fixture page: real modules, real CSS, fake data)', () => {
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

    test('UIF10.3 on all four roots the first body row starts at the root content-left (no UA list indent), Shop and the Journal scroll many rows with the D-pad cursor kept in view, and Trade propose gets a 2rem step header above the select and a scrolling monsters list that keeps submit inside the root', async () => {
      // WRONG IMPL KILLED: a bare `ul` / `ol` indent (Heal's header measured at x 66 against the
      // root's content edge at x 26: the row starts 40px right of the frame); a list that grows
      // past the root instead of scrolling inside it; a D-pad cursor that walks out of the list's
      // rect (scrolled under the clip); a step header at its text height instead of the TabBar's
      // 2rem, or below the select; a monsters list that pushes the submit button out of the root.
      const token = await resolveLength(page, '--mr-space-4');
      const rootFontPx = await page.evaluate(() =>
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      );

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

      // Trade propose: 30 monsters scroll above the fields; the step header is 2rem and above the select.
      await show(page, 'trade', 30);
      const steps = '[data-testid="tradepropose-steps"]';
      const header = await rectOf(page, steps);
      expectNear(header.height, 2 * rootFontPx, 1, 'trade: the step header is 2rem tall');
      const select = await rectOf(page, '#tradepropose-target');
      expect(header.y + header.height, 'trade: the header is above the select').toBeLessThanOrEqual(
        select.y + 0.5,
      );
      const monsters = await scrollBox(page, '#tradepropose-monsters');
      expect(monsters.scrollHeight, 'trade: 30 monsters overflow their list').toBeGreaterThan(
        monsters.clientHeight,
      );
      const root = await rectOf(page, ROOT.trade);
      const submit = await rectOf(page, '#tradepropose-submit');
      expect(submit.height, 'trade: the submit button is laid out').toBeGreaterThan(0);
      expect(
        insideV(submit, root),
        `trade: the submit button (${submit.y}..${submit.y + submit.height}) is inside the root (${root.y}..${root.y + root.height})`,
      ).toBe(true);
    });

    test('UIF10.4 axe is clean on Shop (confirm phase), Heal, an empty Journal and Trade propose (first step), and the Shop quantity row keeps its Left/Right clamping in Chromium', async () => {
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

      await show(page, 'trade', 3);
      await expect(page.locator('#tradepropose-overlay')).toBeVisible();
      await expectAxeClean(page, 'trade propose (first step)', ROOT.trade);

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
