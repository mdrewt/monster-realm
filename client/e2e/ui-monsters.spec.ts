import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeAll, pressAccel, pressButton } from './controls';
import { expectNear, expectSample, resolveLength, sampleStyle } from './uiKit';

// ui-monsters.spec.ts — uif-6 (M-ui-foundation): the Monsters frame's layout, growth, pseudo-scroll,
// bound tab and Party grid, measured in Chromium (UIF6.1 and UIF6.3 to UIF6.8; UIF6.2 is the booted
// unit suite main.accel.test.ts).
//
// ORACLE RULE. Expected spacing and colours are LITERALS transcribed from the wf-1 token table
// (M-ui-foundation-wireframes.md, "Token table (WF1.5)") as the computed value Chromium reports at a
// 16px root (1280x720, ui-scale 1): `8px`, `rgb(24, 24, 38)` for --mr-panel-bg #181826,
// `rgb(107, 107, 130)` for --mr-separator #6b6b82. Nothing is read back from the stylesheet. The
// geometry claims compare measured rects with each other (one row, one height, the hint under the
// panel), so they need no literal. The one token read is `--mr-content-max` through uiKit's
// `resolveLength`, because its px value depends on the scale in force.
//
// SHARED-WORLD HYGIENE (workers: 1, one published db). ONE browser context, ONE player (a fresh
// identity: one starter in the Party, an empty Storage), closed in afterAll. The UIF6.4 fixture page
// is a SECOND PAGE of the same context whose main.ts is route-aborted (the ui-scale.spec UIF2.6
// precedent), so it never connects and adds no presence row. No fixed sleeps: every wait polls a
// bounded predicate.
//
// UIF6.4 EVIDENCE LABEL: real modules + real CSS + a FAKE store. The e2e cannot seed boxed monsters
// (monster / monster_pub carry enum columns that owner SQL cannot write), so the fixture page imports
// the real BoxView, monstersModel, monstersScreen and PointerSource from the Vite dev server, builds
// the view model from fake store rows, and wires PointerSource.press -> monstersScreen.onButton ->
// paint exactly as main.ts does. The page-side code is passed as a STRING (a function containing
// `import()` is rewritten by Playwright's transform), as e2e/a11y.spec.ts does.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
}

const VIEWPORT = { width: 1280, height: 720 } as const;
const BIG = { width: 1920, height: 1080 } as const;

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

const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    return g.stack.map(
      (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
    );
  });

type Tab = 'party' | 'storage';

/** Monsters opened by the accelerator a player presses: V is Party, B is Storage. */
async function openMonsters(p: Page, tab: Tab): Promise<void> {
  await closeAll(p);
  await pressAccel(p, tab === 'party' ? 'V' : 'B');
  await expect
    .poll(() => stackNames(p), { message: `${tab === 'party' ? 'V' : 'B'} opens Monsters` })
    .toEqual(['world', 'menuView', 'boxView']);
  await expect(p.locator('[data-testid="box-title"]'), 'the Monsters title shows').toBeVisible();
  await expect(p.locator(`#monsters-tab-${tab}`), `the ${tab} tab is selected`).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  b: number;
}

const PANEL = '#monsters-panel';
const PARTY_GRID = `${PANEL} > :nth-child(1)`;
const STORAGE_GRID = `${PANEL} > :nth-child(2)`;
/** An occupied Party cell (an empty slot is keyed `slot-<i>`). */
const MONSTER_CELL = `${PARTY_GRID} [data-nav-key]:not([data-nav-key^="slot-"])`;

/** The geometry of the tab bar row, the title above it and the tabs inside it. */
const barGeometry = (
  p: Page,
): Promise<{
  rowClass: string;
  title: Box;
  row: Box;
  lb: Box;
  strip: Box;
  rb: Box;
  tabs: Box[];
  chips: Array<string | undefined>;
}> =>
  p.evaluate(() => {
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
    };
    const strip = document.getElementById('monsters-tabs');
    const row = strip?.parentElement;
    const title = document.querySelector('[data-testid="box-title"]');
    if (strip === null || row === null || row === undefined || title === null) {
      throw new Error('the Monsters tab bar is not in the document');
    }
    const kids = [...row.children];
    return {
      rowClass: row.className,
      title: box(title),
      row: box(row),
      lb: box(kids[0] as Element),
      strip: box(strip),
      rb: box(kids[2] as Element),
      tabs: [...strip.children].map(box),
      chips: [kids[0], kids[2]].map((el) => (el as HTMLElement).dataset.button),
    };
  });

const centreY = (b: Box): number => b.y + b.h / 2;

function expectOneRow(g: Awaited<ReturnType<typeof barGeometry>>, label: string): void {
  expect(g.rowClass, `${label}: the row is the TabBar's`).toContain('mr-tabbar');
  expect(g.chips, `${label}: LB chip first, RB chip last`).toEqual(['LB', 'RB']);
  expect(g.row.y, `${label}: the bar is below the title`).toBeGreaterThanOrEqual(g.title.b - 0.5);
  // One row: the three share a vertical centre (a chip may be shorter than the strip, so the centre,
  // not the top, is the stable line; a stacked layout differs by a whole element height).
  expectNear(centreY(g.lb), centreY(g.strip), 1, `${label}: LB chip is on the strip's row`);
  expectNear(centreY(g.rb), centreY(g.strip), 1, `${label}: RB chip is on the strip's row`);
  expect(g.lb.r, `${label}: LB, then the strip`).toBeLessThanOrEqual(g.strip.x + 1);
  expect(g.strip.r, `${label}: the strip, then RB`).toBeLessThanOrEqual(g.rb.x + 1);
  expect(g.tabs, `${label}: two tabs`).toHaveLength(2);
  for (const [i, tab] of g.tabs.entries()) {
    expectNear(g.strip.h, tab.h, 0.5, `${label}: strip height == tab ${i} height`);
  }
  expectNear((g.tabs[0] as Box).h, (g.tabs[1] as Box).h, 0.5, `${label}: both tabs equal`);
}

test.describe
  .serial('UIF6 — Monsters: layout, growth, pseudo-scroll and the Party grid, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF6.1 the tabs are one TabBar row under the title, LB chip, strip and RB chip left to right, the strip as tall as each tab, with the same numbers on Party and on Storage', async () => {
      // WRONG IMPL KILLED: the bare `.mr-frame-tabstrip` of today (no chips, so no row to measure:
      // the class assertion and the chip order fail); a bar placed above or beside the title (the
      // bar-below-title bound); chips stacked over the strip or wrapped onto their own line (the
      // shared vertical centre); a strip that absorbs free height (R-qf-11-GEOMETRY: strip height
      // != tab height); two tabs of different heights (selected bold or outlined tab grows); a
      // bar whose geometry changes between the Party content (a card) and the Storage content
      // (empty): the same numbers are compared across both.
      await openMonsters(page, 'party');
      expect(
        await page.locator(MONSTER_CELL).count(),
        'the Party shows the starter card (non-vacuity: a card is on screen)',
      ).toBeGreaterThanOrEqual(1);
      const onParty = await barGeometry(page);
      expectOneRow(onParty, 'Party');

      await pressButton(page, 'RB');
      await expect(page.locator('#monsters-tab-storage'), 'RB reaches Storage').toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator(`${STORAGE_GRID} .mr-empty`), 'Storage is empty').toBeVisible();
      const onStorage = await barGeometry(page);
      expectOneRow(onStorage, 'Storage');

      expectNear(onStorage.row.y, onParty.row.y, 0.5, 'the bar sits at the same top on both tabs');
      expectNear(onStorage.row.h, onParty.row.h, 0.5, 'the bar is as tall on both tabs');
      expectNear(onStorage.strip.h, onParty.strip.h, 0.5, 'the strip is as tall on both tabs');
      expectNear(
        (onStorage.tabs[0] as Box).h,
        (onParty.tabs[0] as Box).h,
        0.5,
        'a tab is as tall on both tabs',
      );
    });

    test('UIF6.3 at 1280x720 the tab content area fills down to the hint on Party and on an empty Storage, with no gap above the frame edge; at 1920x1080 it is taller and wider, never wider than --mr-content-max', async () => {
      // WRONG IMPL KILLED: today's content-sized grids (an empty Storage collapses to one line and
      // leaves a gap of hundreds of px above the hint); a panel with no flex growth (Party only);
      // a panel that grows past the hint (it would overlap it); a panel with a fixed size that does
      // not grow with the window (the 1920 comparison); a panel that ignores the content cap (the
      // --mr-content-max bound, read through a real probe at each size's own scale).
      const measure = (p: Page) =>
        p.evaluate(() => {
          const panel = document.getElementById('monsters-panel');
          const hint = document.querySelector('[data-testid="box-party-hint"]');
          const frame = document.querySelector('[data-testid="box-title"]')?.closest('.mr-frame');
          if (panel === null || hint === null || frame === null || frame === undefined) {
            throw new Error('the Monsters panel, hint or frame is not in the document');
          }
          const pr = panel.getBoundingClientRect();
          const hr = hint.getBoundingClientRect();
          const fr = frame.getBoundingClientRect();
          const fs = getComputedStyle(frame);
          const hs = getComputedStyle(hint);
          const contentBottom =
            fr.bottom -
            Number.parseFloat(fs.borderBottomWidth) -
            Number.parseFloat(fs.paddingBottom);
          return {
            panelW: pr.width,
            panelH: pr.height,
            // The hint's own top margin sits between the panel and the hint.
            gapToHint: hr.top - Number.parseFloat(hs.marginTop) - pr.bottom,
            // Free space between the hint (and its bottom margin) and the frame's content edge.
            tail: contentBottom - (hr.bottom + Number.parseFloat(hs.marginBottom)),
          };
        });

      await openMonsters(page, 'party');
      const party = await measure(page);
      expect(party.panelH, 'the Party panel has real height').toBeGreaterThan(100);
      expectNear(party.gapToHint, 0, 1, 'Party: the panel meets the hint (minus its margin)');
      expectNear(party.tail, 0, 1, 'Party: nothing between the hint and the frame edge');

      await pressButton(page, 'RB');
      await expect(page.locator(`${STORAGE_GRID} .mr-empty`), 'Storage is empty').toBeVisible();
      const empty = await measure(page);
      expectNear(empty.gapToHint, 0, 1, 'empty Storage: the panel meets the hint');
      expectNear(empty.tail, 0, 1, 'empty Storage: nothing between the hint and the frame edge');
      expectNear(empty.panelH, party.panelH, 1, 'the panel is as tall empty as with a card');
      const maxAt = async (): Promise<number> =>
        Number.parseFloat(await resolveLength(page, '--mr-content-max'));
      const smallMax = await maxAt();
      expect(empty.panelW, 'width <= --mr-content-max at 1280x720').toBeLessThanOrEqual(
        smallMax + 0.5,
      );

      try {
        await page.setViewportSize(BIG);
        await expect
          .poll(async () => (await measure(page)).panelW, {
            message: 'the panel grows wider at 1920x1080',
            timeout: 10_000,
          })
          .toBeGreaterThan(empty.panelW + 1);
        const big = await measure(page);
        expect(big.panelH, 'taller at 1920x1080').toBeGreaterThan(empty.panelH + 1);
        expect(big.panelW, 'wider at 1920x1080').toBeGreaterThan(empty.panelW + 1);
        expect(big.panelW, 'width <= --mr-content-max at 1920x1080').toBeLessThanOrEqual(
          (await maxAt()) + 0.5,
        );
        expectNear(big.gapToHint, 0, 1, '1920x1080 empty Storage: the panel meets the hint');
        expectNear(big.tail, 0, 1, '1920x1080 empty Storage: nothing below the hint');
      } finally {
        await page.setViewportSize(VIEWPORT);
        await expect
          .poll(async () => (await measure(page)).panelW, { timeout: 10_000 })
          .toBeCloseTo(empty.panelW, 0);
      }
    });

    test('UIF6.5 the Monsters root has no h3, and the panel, grid and card spacing and colours compute the token values', async () => {
      // WRONG IMPL KILLED: today's two in-panel `h3` headings (R-qf-10-QF10.2); a panel padded with a
      // literal that happens to differ (6px, 10px); a grid gap left at today's 8px by luck is
      // caught by the other literals below, a card still on the old `#1a1a2e` / `#444` / 4px
      // (rgb(26, 26, 46), 1px #444444, padding 8px: colour and border fail); a card whose border
      // is not the separator token; a card read while it is the cursor (the inverted fill hides the
      // panel colour), so the cursor is moved off the starter first.
      await openMonsters(page, 'party');
      expect(
        await page.evaluate(
          () =>
            document
              .querySelector('[data-testid="box-title"]')
              ?.closest('.mr-frame')
              ?.querySelectorAll('h3').length,
        ),
        'no h3 in the Party view of the frame',
      ).toBe(0);
      await pressButton(page, 'Right'); // the cursor leaves the starter card for the empty slot 1
      await expect(page.locator(`${PARTY_GRID} [data-nav-key="slot-1"]`)).toHaveAttribute(
        'aria-current',
        'true',
      );
      expectSample(
        await sampleStyle(page, PANEL, ['padding']),
        { padding: '8px 8px 8px 8px' },
        'the tab content area padding is --mr-space-2',
      );
      expectSample(
        await sampleStyle(page, PARTY_GRID, ['gap']),
        { gap: '8px 8px' },
        'the Party grid gap is --mr-space-2',
      );
      expectSample(
        await sampleStyle(page, STORAGE_GRID, ['gap']),
        { gap: '8px 8px' },
        'the Storage grid gap is --mr-space-2',
      );
      const CARD = 'rgb(107, 107, 130)';
      for (const [name, sel] of [
        ['the starter card', MONSTER_CELL],
        ['an empty slot', `${PARTY_GRID} [data-nav-key="slot-2"]`],
      ] as const) {
        expectSample(
          await sampleStyle(page, sel, [
            'padding',
            'background-color',
            'border-width',
            'border-style',
            'border-color',
          ]),
          {
            padding: '8px 8px 8px 8px',
            'background-color': 'rgb(24, 24, 38)',
            'border-width': '1px 1px 1px 1px',
            'border-style': 'solid solid solid solid',
            'border-color': [CARD, CARD, CARD, CARD].join(' '),
          },
          `${name}: the card spacing, fill and border are the tokens`,
        );
      }

      await pressButton(page, 'RB');
      await expect(page.locator(`${STORAGE_GRID} .mr-empty`), 'Storage is empty').toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document
              .querySelector('[data-testid="box-title"]')
              ?.closest('.mr-frame')
              ?.querySelectorAll('h3').length,
        ),
        'no h3 in the Storage view of the frame',
      ).toBe(0);
    });

    test('UIF6.6 an empty Storage shows the EmptyState with its reason, cue and next step, the title and both tabs kept', async () => {
      // WRONG IMPL KILLED: today's bare one-line "No monsters in storage." (no cue, no next step);
      // an EmptyState built but left display:none or collapsed to zero size; the frame or the tabs
      // lost with the content (the title and tabs are asserted visible beside it).
      await openMonsters(page, 'storage');
      const empty = page.locator(`${STORAGE_GRID} .mr-empty`);
      await expect(empty, 'the EmptyState is visible').toBeVisible();
      for (const line of ['.mr-empty-reason', '.mr-empty-cue', '.mr-empty-next']) {
        const el = empty.locator(line);
        await expect(el, `${line} is visible`).toBeVisible();
        expect((await el.textContent())?.trim().length ?? 0, `${line} has text`).toBeGreaterThan(0);
      }
      await expect(page.locator('[data-testid="box-title"]'), 'the title is kept').toBeVisible();
      await expect(page.locator('#monsters-tab-party'), 'the Party tab is kept').toBeVisible();
      await expect(page.locator('#monsters-tab-storage'), 'the Storage tab is kept').toBeVisible();
    });

    test('UIF6.7 the selected tab differs from an unselected one in at least two computed properties and, in fill, from the focused card', async () => {
      // WRONG IMPL KILLED: tabs styled like menu rows (selected and unselected computing the same
      // background, weight, outline and colour: zero differing properties); a selected tab that
      // differs in one property only; a selected tab filled with the focused card's inverted fill
      // (both read as 'the active row', the 060 / 169 feedback); a focused card with no inverted
      // fill (the card's background is the literal light grey the row cursor uses).
      await openMonsters(page, 'party');
      const props = [
        'background-color',
        'font-weight',
        'outline-style',
        'outline-width',
        'color',
      ] as const;
      const selected = await sampleStyle(page, '#monsters-tab-party', props);
      const other = await sampleStyle(page, '#monsters-tab-storage', props);
      const differs = {
        background: selected['background-color'] !== other['background-color'],
        weight: selected['font-weight'] !== other['font-weight'],
        outline:
          `${selected['outline-style']} ${selected['outline-width']}` !==
          `${other['outline-style']} ${other['outline-width']}`,
        colour: selected.color !== other.color,
      };
      const count = Object.values(differs).filter(Boolean).length;
      expect(
        count,
        `the selected tab differs from an unselected one in >= 2 of background, weight, outline, colour: ${JSON.stringify({ selected, other })}`,
      ).toBeGreaterThanOrEqual(2);

      const card = await sampleStyle(page, `${PARTY_GRID} [aria-current="true"]`, [
        'background-color',
      ]);
      expect(card['background-color'], 'the focused card has the inverted fill').toBe(
        'rgb(224, 224, 224)',
      );
      expect(
        selected['background-color'],
        'the selected tab is not filled like the focused card',
      ).not.toBe(card['background-color']);
    });

    test('UIF6.8 at 1280x720 the Party is six cells in two columns and three rows, none wider than half the panel, all inside the panel and the window, and the D-pad moves the cursor along that grid', async () => {
      // WRONG IMPL KILLED: today's one-column list of six full-width cards (one distinct left,
      // six tops); a grid with the wrong column count (3 lefts); cells wider than half the panel
      // (a column that spans); cells pushed out of the panel or the window (the rows do not fit
      // 720px: the third row is cut off); a D-pad that walks the list order (Down moving to the next
      // cell in the row instead of the next row; Right doing nothing). The cursor is read as the
      // cell wearing aria-current, its position compared with the other cells' rows and columns.
      await openMonsters(page, 'party');
      type Cell = { key: string; x: number; y: number; w: number; h: number; r: number; b: number };
      const cells = (): Promise<Cell[]> =>
        page.evaluate((sel) => {
          return [...document.querySelectorAll<HTMLElement>(`${sel} [data-nav-key]`)].map((el) => {
            const r = el.getBoundingClientRect();
            return {
              key: el.dataset.navKey ?? '',
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
              r: r.right,
              b: r.bottom,
            };
          });
        }, PARTY_GRID);
      const grid = await cells();
      expect(grid, 'six cells').toHaveLength(6);
      const panel = await page.evaluate((sel) => {
        const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom };
      }, PANEL);
      const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const distinct = (values: number[]): number[] =>
        [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
      const lefts = distinct(grid.map((c) => c.x));
      const tops = distinct(grid.map((c) => c.y));
      expect(lefts, 'two columns').toHaveLength(2);
      expect(tops, 'three rows').toHaveLength(3);
      for (const c of grid) {
        expect(c.w, `${c.key}: no wider than half the panel`).toBeLessThanOrEqual(
          panel.w / 2 + 0.5,
        );
        expect(c.x, `${c.key}: inside the panel (left)`).toBeGreaterThanOrEqual(panel.x - 0.5);
        expect(c.r, `${c.key}: inside the panel (right)`).toBeLessThanOrEqual(panel.r + 0.5);
        expect(c.y, `${c.key}: inside the panel (top)`).toBeGreaterThanOrEqual(panel.y - 0.5);
        expect(c.b, `${c.key}: inside the panel (bottom)`).toBeLessThanOrEqual(panel.b + 0.5);
        expect(c.r, `${c.key}: inside the window (right)`).toBeLessThanOrEqual(view.w);
        expect(c.b, `${c.key}: inside the window (bottom)`).toBeLessThanOrEqual(view.h);
        expect(c.h, `${c.key}: has height`).toBeGreaterThan(20);
      }

      const cursor = async (): Promise<Cell> => {
        const all = await cells();
        const key = await page.evaluate(
          (sel) =>
            document.querySelector(`${sel} [aria-current="true"]`)?.getAttribute('data-nav-key'),
          PARTY_GRID,
        );
        const found = all.find((c) => c.key === key);
        if (found === undefined) throw new Error(`no cursor cell (aria-current key ${key})`);
        return found;
      };
      const same = (a: number, b: number): boolean => Math.abs(a - b) < 1;
      const move = async (button: 'Right' | 'Down' | 'Left' | 'Up'): Promise<void> => {
        const from = await cursor();
        await pressButton(page, button);
        await expect
          .poll(async () => (await cursor()).key, { message: `${button} moves the cursor` })
          .not.toBe(from.key);
        const to = await cursor();
        if (button === 'Right') {
          expect(same(to.y, from.y), 'Right stays on the row').toBe(true);
          expect(to.x, 'Right goes to the next column').toBeGreaterThan(from.x + 1);
        } else if (button === 'Left') {
          expect(same(to.y, from.y), 'Left stays on the row').toBe(true);
          expect(to.x, 'Left goes to the previous column').toBeLessThan(from.x - 1);
        } else if (button === 'Down') {
          expect(same(to.x, from.x), 'Down stays on the column').toBe(true);
          expect(to.y, 'Down goes to the next row').toBeGreaterThan(from.y + 1);
        } else {
          expect(same(to.x, from.x), 'Up stays on the column').toBe(true);
          expect(to.y, 'Up goes to the previous row').toBeLessThan(from.y - 1);
        }
      };
      // The cursor opens on the starter in slot 0 (top-left): Right, Down, Down, Left, Up.
      const start = await cursor();
      expect(same(start.x, lefts[0] as number), 'the cursor opens in the first column').toBe(true);
      expect(same(start.y, tops[0] as number), 'and the first row').toBe(true);
      await move('Right');
      await move('Down');
      await move('Down');
      await move('Left');
      await move('Up');
    });

    test('UIF6.4 real modules + real CSS + fake store: an overflowing Storage grid hides its overflow with no scrollbar, the D-pad keeps the cursor card (outline included) in view, a real mouse wheel moves the cursor, and the position cue is drawn', async () => {
      // WRONG IMPL KILLED: today's Storage grid in a root that scrolls as a whole (overflow-y not
      // hidden on the grid: a scrollbar appears, offsetWidth - clientWidth > 0, and the cursor can
      // leave the view); `overflow-y: auto` (a scrollbar); `overflow:hidden` with no cursor scroll
      // (the cursor card leaves the grid's rect after the visible rows, scrollTop stays 0); a grid
      // with no padding (the 3px outline clipped by overflow:hidden: the outline box leaves the grid
      // rect); no wheel route (the cursor stays); a cue painted as an inline background (the kit's
      // `mr-scroll` layers are the cue: computed background-attachment `local, local, scroll,
      // scroll`, and no inline background that would replace them); a page that never loaded the
      // stylesheet (the root's `.mr-shell` rule is absolute).
      await ctx.route('**/src/main.ts*', (route) => route.abort());
      const bare = await ctx.newPage();
      try {
        await bare.setViewportSize(VIEWPORT);
        await bare.goto('/');
        await bare.waitForLoadState('load');
        expect(
          await bare.evaluate(() => typeof (window as unknown as { __game?: unknown }).__game),
          'main.ts did not run',
        ).toBe('undefined');

        const MOUNT = `(async () => {
          const [boxMod, modelMod, screenMod, pointerMod] = await Promise.all([
            import('/src/ui/boxView.ts'),
            import('/src/ui/monstersModel.ts'),
            import('/src/ui/screens/monstersScreen.ts'),
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
          const view = new boxMod.BoxView(app, {
            onSetNickname() {},
            onSetPartySlot() {},
            partySlotNone: 255,
          });
          const essence = { Fire: 0, Water: 0, Plant: 0, Electric: 0, Earth: 0, Wind: 0, Light: 0, Dark: 0 };
          const mon = (id, slot) => ({
            monsterId: BigInt(id), ownerIdentity: 'fixture', speciesId: 1, nickname: '', level: 5, xp: 0,
            currentHp: 30, statHp: 40, statAttack: 10, statDefense: 10, statSpeed: 10, statSpAttack: 10,
            statSpDefense: 10, partySlot: slot, tier: 0, essence, trustTier: 'Neutral',
            qualityTimeTier: 0, nutritionPct: 0, lastCareAtMs: 0n,
          });
          const species = new Map([[1, {
            id: 1, name: 'Sproutle', baseHp: 45, baseAttack: 49, baseDefense: 49, baseSpeed: 45,
            baseSpAttack: 65, baseSpDefense: 65, affinity: 'Fire', learnableSkillIds: [],
          }]]);
          const monsters = [mon(1, 0)];
          for (let i = 0; i < 24; i += 1) monsters.push(mon(100 + i, 255));
          const vm = modelMod.buildMonstersVm(monsters, species, 6, 255, [], [], new Map(), 'storage');
          let state = screenMod.monstersScreen.init(vm);
          view.show();
          view.refresh(vm.partySlots, vm.storage);
          const paint = () => screenMod.monstersScreen.paint(view, vm, state);
          paint();
          const press = (button) => {
            const step = screenMod.monstersScreen.onButton(vm, state, { button, repeat: false });
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
          window.__uif6 = {
            press,
            item: () => state.nav.item,
            tab: () => state.nav.tab,
            storageKeys: vm.storage.map((c) => String(c.monsterId)),
          };
          return true;
        })()`;
        await bare.evaluate(MOUNT);

        const gridState = () =>
          bare.evaluate(() => {
            const panel = document.getElementById('monsters-panel');
            const grid = panel?.children[1] as HTMLElement | undefined;
            const root = grid?.closest('.mr-shell');
            if (grid === undefined || root === null || root === undefined) {
              throw new Error('the Storage grid or the shell root is missing');
            }
            const cs = getComputedStyle(grid);
            const card = grid.querySelector<HTMLElement>('[aria-current="true"]');
            const gr = grid.getBoundingClientRect();
            let outline: { top: number; left: number; right: number; bottom: number } | null = null;
            if (card !== null) {
              const r = card.getBoundingClientRect();
              const ccs = getComputedStyle(card);
              const o = Number.parseFloat(ccs.outlineWidth) + Number.parseFloat(ccs.outlineOffset);
              outline = {
                top: r.top - o,
                left: r.left - o,
                right: r.right + o,
                bottom: r.bottom + o,
              };
            }
            return {
              sheets: document.styleSheets.length,
              shellPosition: getComputedStyle(root).position,
              overflowY: cs.overflowY,
              scrollHeight: grid.scrollHeight,
              clientHeight: grid.clientHeight,
              scrollbar: grid.offsetWidth - grid.clientWidth,
              scrollTop: grid.scrollTop,
              attachment: cs.backgroundAttachment,
              inlineStyle: grid.getAttribute('style') ?? '',
              cursorKey: card?.getAttribute('data-nav-key') ?? null,
              outline,
              gridRect: { top: gr.top, left: gr.left, right: gr.right, bottom: gr.bottom },
              left: gr.left,
              top: gr.top,
              h: gr.height,
            };
          });

        const first = await gridState();
        expect(first.sheets, 'the stylesheet loaded').toBeGreaterThan(0);
        expect(first.shellPosition, 'the real .mr-shell rule applies to the view root').toBe(
          'absolute',
        );
        expect(first.overflowY, 'the Storage grid hides its overflow').toBe('hidden');
        expect(
          first.scrollHeight,
          'fixture: the 8 rows of cards overflow the grid (non-vacuity)',
        ).toBeGreaterThan(first.clientHeight);
        expect(first.scrollbar, 'no scrollbar is drawn').toBe(0);
        expect(first.attachment, 'the kit`s position cue layers are in force').toBe(
          'local, local, scroll, scroll',
        );
        expect(first.inlineStyle.includes('background'), 'no inline background').toBe(false);
        expect(first.cursorKey, 'the cursor opens on the first boxed card').toBe('100');

        // The wheel: over the grid's padding (never over a card, so the hover seek stays out of it),
        // one real notch down moves the cursor one grid row (three cards), one notch up moves back.
        const keys = await bare.evaluate(
          () => (window as unknown as { __uif6: { storageKeys: string[] } }).__uif6.storageKeys,
        );
        const itemNow = (): Promise<string | null> =>
          bare.evaluate(() =>
            (window as unknown as { __uif6: { item(): string | null } }).__uif6.item(),
          );
        expect(await itemNow(), 'fixture: the state cursor is on the first card').toBe(keys[0]);
        await bare.mouse.move(first.left + 1, first.top + first.h / 2);
        expect(await itemNow(), 'a mouse move over the padding moves nothing').toBe(keys[0]);
        await bare.mouse.wheel(0, 100);
        await expect
          .poll(itemNow, { message: 'a wheel notch down moves the cursor one row' })
          .toBe(keys[3]);
        await bare.mouse.wheel(0, -100);
        await expect.poll(itemNow, { message: 'a wheel notch up moves it back' }).toBe(keys[0]);

        // D-pad Down down the grid: the cursor card's outline box stays inside the grid's rect.
        const inside = (s: Awaited<ReturnType<typeof gridState>>, label: string): void => {
          expect(s.outline, `${label}: a cursor card is marked`).not.toBeNull();
          const o = s.outline as { top: number; left: number; right: number; bottom: number };
          expect(o.top, `${label}: outline top inside the grid`).toBeGreaterThanOrEqual(
            s.gridRect.top - 0.5,
          );
          expect(o.bottom, `${label}: outline bottom inside the grid`).toBeLessThanOrEqual(
            s.gridRect.bottom + 0.5,
          );
          expect(o.left, `${label}: outline left inside the grid`).toBeGreaterThanOrEqual(
            s.gridRect.left - 0.5,
          );
          expect(o.right, `${label}: outline right inside the grid`).toBeLessThanOrEqual(
            s.gridRect.right + 0.5,
          );
        };
        inside(await gridState(), 'row 0');
        for (let row = 1; row <= 7; row += 1) {
          await bare.evaluate(() =>
            (window as unknown as { __uif6: { press(b: string): void } }).__uif6.press('Down'),
          );
          await expect
            .poll(async () => (await gridState()).cursorKey, {
              message: `Down ${row} reaches row ${row}`,
            })
            .toBe(keys[row * 3]);
          inside(await gridState(), `row ${row}`);
        }
        expect(
          (await gridState()).scrollTop,
          'the grid scrolled to keep the last row in view',
        ).toBeGreaterThan(0);
      } finally {
        await bare.close();
        await ctx.unroute('**/src/main.ts*');
      }
    });
  });
