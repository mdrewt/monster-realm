import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  contrastRatio,
  effectiveBackground,
  expectNear,
  expectRect,
  parseRgb,
  type Rect,
  rectsOverlap,
  resolveLength,
  sampleProbe,
  sampleStyle,
} from './uiKit';

// ui-social.spec.ts — uif-9 (M-ui-foundation): the Social screen on the UI kit, measured in Chromium
// (UIF9.1, UIF9.3, UIF9.4, UIF9.5; UIF9.2's Back row is deferred: client/e2e/pvp.spec.ts pins the
// challenge sheet's rows exactly, outside this slice).
//
// EVIDENCE LABEL: real modules + real CSS + a FAKE store. A real server cannot hand one player two
// other online players, one incoming and one outgoing challenge, two trade sessions and thirty
// ranked profiles cheaply, and the geometry claims below need all four panels populated at once. The page
// is the real index.html and the real stylesheet served by the Vite dev server (main.ts is
// route-aborted, so it never connects: the uif-8 UIF8.1 fixture-page precedent in ui-inventory.spec
// .ts). The page-side code imports the real TradeView, PvpView, LeaderboardView, socialModel and
// socialScreen and paints them with fake store rows exactly as main.ts's Social adapter does, so
// what is measured is what the shipped modules and the shipped CSS compute. The page-side code is a
// STRING (a function containing `import()` is rewritten by Playwright's transform).
//
// ORACLE RULE (uiKit.ts doctrine). UIF9.1 and UIF9.3 compare what Chromium computes for the four
// panels with each other, property by property; the one literal anchor is the root's start padding,
// resolved from the `--mr-space-4` token through a real probe, so four panels that are equally
// wrong cannot pass. UIF9.4 and UIF9.5 compare an element with a probe wearing the shared kit class
// alone, or with its own computed neighbours.
//
// No fixed sleeps: every wait polls a bounded predicate. The fixture page is rebuilt before each
// test (the cursor positions are state), and the browser is closed in afterAll.

const VIEWPORT = { width: 1280, height: 720 } as const;

// THE FIXTURE WORLD (a fake store): the viewer `Me`, two other online players (Alice, Bob), one
// incoming challenge (from Alice) and one outgoing challenge (to Bob), two trade sessions (Alice
// opened session 5 with the viewer, untouched: a waiting request; the viewer opened session 6 with
// Bob), and thirty ranked profiles. The screen opens on Challenges (the incoming request is the
// oldest waiting one; the cursor on it); `__uif9.press('RB')` walks Rankings, Players, Trades,
// Challenges. On Trades the cursor row is session 5's row of `#trade-sessions`.
const UIF9_MOUNT = `(async () => {
  const [tv, pv, lv, sm, ss, pm, lm] = await Promise.all([
    import('/src/ui/tradeView.ts'), import('/src/ui/pvpView.ts'), import('/src/ui/leaderboardView.ts'),
    import('/src/ui/socialModel.ts'), import('/src/ui/screens/socialScreen.ts'),
    import('/src/ui/pvpModel.ts'), import('/src/ui/leaderboardModel.ts'),
  ]);
  const me = 'aa'.repeat(16), p1 = 'bb'.repeat(16), p2 = 'cc'.repeat(16);
  const noop = async () => {};
  const trade = new tv.TradeView();
  const pvp = new pv.PvpView({ onAccept: noop, onDecline: noop, onCancel: noop });
  const board = new lv.LeaderboardView();
  const players = [
    { identity: me, entityId: 1n, name: 'Me', online: true, lastInputSeq: 0n },
    { identity: p1, entityId: 2n, name: 'Alice', online: true, lastInputSeq: 0n },
    { identity: p2, entityId: 3n, name: 'Bob', online: true, lastInputSeq: 0n },
  ];
  const challenges = [
    { challengeId: 1n, challenger: p1, target: me, challengerPartyIds: [], status: 'Pending', createdAtMs: 1n },
    { challengeId: 2n, challenger: me, target: p2, challengerPartyIds: [], status: 'Pending', createdAtMs: 2n },
  ];
  const side = () => ({ monsterIds: [], items: [], currency: 0n, cards: [] });
  const session = (sessionId, opener, partner, createdAtMs) => ({ sessionId, opener, partner,
    openerOffer: side(), partnerOffer: side(), openerConfirmed: false, partnerConfirmed: false,
    revision: 1n, createdAtMs });
  const sessions = [session(6n, me, p2, 4n), session(5n, p1, me, 3n)];
  const profiles = [];
  for (let i = 0; i < 30; i += 1) profiles.push({ identity: (i < 10 ? '0' : '') + i + 'd'.repeat(30), name: 'Ranked ' + i, rating: 1000 + i, wins: i, losses: 1 });
  const chrome = document.createElement('div');
  const views = { tradeView: trade, pvpView: pvp, leaderboardView: board };
  const view = {
    trades: trade, challenges: pvp, rankings: board, chrome,
    show(panel) {
      if (views[panel].visible) return;
      if (panel === 'tradeView') trade.show();
      if (panel === 'pvpView') pvp.refresh(pm.buildPvpChallengeViewModel(challenges, me, players), true);
      if (panel === 'leaderboardView') { board.render(lm.buildLeaderboardViewModel(profiles, me)); board.show(); }
      views[panel].hostChrome(chrome);
      for (const k of Object.keys(views)) if (k !== panel && views[k].visible) views[k].hide();
    },
  };
  const vm = sm.buildSocialVm(null, challenges, me, { players, characters: [], profiles }, sessions);
  let state = ss.socialScreen.init(vm, undefined);
  const paint = () => ss.socialScreen.paint(view, vm, state);
  paint();
  window.__uif9 = {
    press(button) { state = ss.socialScreen.onButton(vm, state, { button, repeat: false }).state; paint(); },
    tab: () => state.nav.tab,
  };
  return true;
})()`;

const TABS = ['players', 'trades', 'challenges', 'rankings'] as const;
type Tab = (typeof TABS)[number];

/** The Social roots, and which one each tab shows (Players and Rankings share the board's root). */
const ROOT_OF: Readonly<Record<Tab, string>> = {
  players: 'leaderboard-overlay',
  trades: 'trade-overlay',
  challenges: 'pvp-challenge-overlay',
  rankings: 'leaderboard-overlay',
};

interface Uif9Hook {
  press(button: string): void;
  tab(): string;
}

const press = (p: Page, button: string): Promise<void> =>
  p.evaluate((b) => (window as unknown as { __uif9: Uif9Hook }).__uif9.press(b), button);
const tabNow = (p: Page): Promise<string> =>
  p.evaluate(() => (window as unknown as { __uif9: Uif9Hook }).__uif9.tab());

/** RB until `tab` shows (at most one lap), asserting each step landed on a known tab. */
async function goTo(p: Page, tab: Tab): Promise<void> {
  for (let i = 0; i <= TABS.length; i += 1) {
    if ((await tabNow(p)) === tab) return;
    await press(p, 'RB');
  }
  throw new Error(`goTo: RB never reached ${tab}`);
}

/** The three Social roots; a page-side reader finds the shown one (exactly one must show). */
const ROOT_IDS = ['trade-overlay', 'pvp-challenge-overlay', 'leaderboard-overlay'];

// ---------------------------------------------------------------------------------------------
// Page-side readers (each runs in one evaluate; every value is computed, none read from source).
// ---------------------------------------------------------------------------------------------

interface BarSnap {
  readonly rootId: string;
  readonly contentTop: number;
  readonly barCount: number;
  readonly stripCount: number;
  readonly barInRoot: boolean;
  readonly barIsFirstOfChrome: boolean;
  readonly chromeIsFirstOfRoot: boolean;
  readonly bar: Rect;
  readonly strip: Rect;
  readonly lb: Rect;
  readonly rb: Rect;
}

const barSnap = (p: Page): Promise<BarSnap> =>
  p.evaluate((rootIds) => {
    const shown = rootIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null && el.style.display !== 'none');
    if (shown.length !== 1)
      throw new Error(`exactly one Social root must show, saw ${shown.length}`);
    const root = shown[0] as HTMLElement;
    const rect = (el: Element | null): { x: number; y: number; width: number; height: number } => {
      if (el === null) throw new Error('barSnap: a TabBar part is missing');
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const cs = getComputedStyle(root);
    const rr = root.getBoundingClientRect();
    const bar = document.querySelector('.mr-tabbar');
    const chrome = root.firstElementChild;
    return {
      rootId: root.id,
      contentTop: rr.top + Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.paddingTop),
      barCount: document.querySelectorAll('.mr-tabbar').length,
      stripCount: document.querySelectorAll('#social-tabs').length,
      barInRoot: bar !== null && root.contains(bar),
      barIsFirstOfChrome: bar !== null && chrome?.firstElementChild === bar,
      chromeIsFirstOfRoot: chrome !== null && chrome.querySelector('.mr-tabbar') === bar,
      bar: rect(bar),
      strip: rect(document.getElementById('social-tabs')),
      lb: rect(document.querySelector('.mr-tabbar [data-button="LB"]')),
      rb: rect(document.querySelector('.mr-tabbar [data-button="RB"]')),
    };
  }, ROOT_IDS);

/** Every element of the leaderboard root that sits ABOVE the body (the row containers): the chrome
 *  and its parts, and every root child before the board list. Keyed by a stable name. The
 *  individual tabs are left out on purpose (the selected tab may legitimately restyle). */
const aboveBody = (p: Page): Promise<Record<string, Rect>> =>
  p.evaluate(() => {
    const root = document.getElementById('leaderboard-overlay');
    const list = document.getElementById('leaderboard-list');
    if (root === null || list === null || root.style.display === 'none') {
      throw new Error('aboveBody: the leaderboard root must show');
    }
    const rect = (el: Element): { x: number; y: number; width: number; height: number } => {
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    out.root = rect(root);
    const kids = [...root.children];
    kids.slice(0, kids.indexOf(list)).forEach((el, i) => {
      out[`root child ${i} (${el.id || el.className})`] = rect(el);
    });
    const chrome = kids[0];
    if (chrome === undefined) throw new Error('aboveBody: the root has no chrome');
    [...chrome.children].forEach((el, i) => {
      out[`chrome part ${i} (${el.id || el.className})`] = rect(el);
    });
    const bar = chrome.firstElementChild;
    [...(bar?.children ?? [])].forEach((el, i) => {
      out[`bar part ${i} (${el.id || el.className})`] = rect(el);
    });
    return out;
  });

interface RowSnap {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
  readonly padding: string;
  readonly margin: string;
  readonly active: boolean;
}

interface PanelSnap {
  readonly rootId: string;
  readonly rootPadding: string;
  readonly rootBorder: string;
  readonly contentLeft: number;
  readonly rows: readonly RowSnap[];
  readonly container: { readonly margin: string; readonly padding: string } | null;
}

/** The row elements of each panel (a Challenges row is its container; Trades lists its session
 *  rows in `#trade-sessions`, never `#trade-status`). */
const ROW_SELECTORS: Readonly<Record<Tab, { rows: string; container: string | null }>> = {
  players: { rows: '#leaderboard-players > [data-nav-key]', container: '#leaderboard-players' },
  rankings: { rows: '#leaderboard-list > li', container: '#leaderboard-list' },
  challenges: { rows: '#pvp-challenge-incoming, #pvp-challenge-outgoing', container: null },
  trades: { rows: '#trade-sessions > [data-nav-key]', container: '#trade-sessions' },
};

const panelSnap = (p: Page, tab: Tab): Promise<PanelSnap> =>
  p.evaluate(
    ({ rootIds, sel }) => {
      const shown = rootIds
        .map((id) => document.getElementById(id))
        .filter((el): el is HTMLElement => el !== null && el.style.display !== 'none');
      if (shown.length !== 1) {
        throw new Error(`exactly one Social root must show, saw ${shown.length}`);
      }
      const root = shown[0] as HTMLElement;
      const four = (cs: CSSStyleDeclaration, prefix: string, suffix = ''): string =>
        ['top', 'right', 'bottom', 'left']
          .map((side) => cs.getPropertyValue(`${prefix}-${side}${suffix}`))
          .join(' ');
      const rcs = getComputedStyle(root);
      const rr = root.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>(sel.rows)]
        .filter(
          (el) => el.getBoundingClientRect().height > 0 && (el.textContent ?? '').trim() !== '',
        )
        .map((el) => {
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            left: b.left,
            top: b.top,
            bottom: b.bottom,
            height: b.height,
            padding: four(cs, 'padding'),
            margin: four(cs, 'margin'),
            active: el.classList.contains('is-active'),
          };
        })
        .sort((a, b) => a.top - b.top);
      const box = sel.container === null ? null : document.querySelector(sel.container);
      const bcs = box === null ? null : getComputedStyle(box);
      return {
        rootId: root.id,
        rootPadding: four(rcs, 'padding'),
        rootBorder: four(rcs, 'border', '-width'),
        contentLeft:
          rr.left + Number.parseFloat(rcs.borderLeftWidth) + Number.parseFloat(rcs.paddingLeft),
        rows,
        container:
          bcs === null ? null : { margin: four(bcs, 'margin'), padding: four(bcs, 'padding') },
      };
    },
    { rootIds: ROOT_IDS, sel: ROW_SELECTORS[tab] },
  );

const gapsOf = (rows: readonly RowSnap[]): number[] =>
  rows.slice(1).map((row, i) => row.top - (rows[i] as RowSnap).bottom);

// ---------------------------------------------------------------------------------------------

test.describe
  .serial('UIF9 — Social on the UI kit (fixture page: real modules, real CSS, fake store)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
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
      await page.evaluate(UIF9_MOUNT);
      expect(await tabNow(page), 'the fixture Social screen opens on Challenges').toBe(
        'challenges',
      );
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF9.1 the Social TabBar is top-anchored with the same bar and strip rect on all four tabs (three different roots), both chips visible, and Players to Rankings moves nothing above the body', async () => {
      // WRONG IMPL KILLED: today's bare `#social-tabs` strip (no `.mr-tabbar` row: the bar and chip
      // locators match nothing and the snapshot throws); a bar placed below the title or the status
      // line of a panel (its top is not the panel's content top); a bar whose geometry depends on
      // the panel (a different width or height on Challenges, whose root shows with another
      // display: the rects differ); a bar rebuilt per panel (two `.mr-tabbar`); chips with no width
      // (hidden chips); a Players to Rankings switch that moves the title, the chrome or any part
      // above the rows (a shifted panel on every LB / RB press).
      const seen = {} as Record<Tab, BarSnap>;
      for (const tab of TABS) {
        await goTo(page, tab);
        seen[tab] = await barSnap(page);
        await expect(
          page.locator('.mr-tabbar [data-button="LB"]'),
          `${tab}: the LB chip is visible`,
        ).toBeVisible();
        await expect(
          page.locator('.mr-tabbar [data-button="RB"]'),
          `${tab}: the RB chip is visible`,
        ).toBeVisible();
      }

      // Non-vacuity: the four tabs really show three different roots, Players and Rankings one.
      expect(
        TABS.map((tab) => seen[tab].rootId),
        'each tab shows its own root',
      ).toEqual(TABS.map((tab) => ROOT_OF[tab]));
      expect(new Set(TABS.map((tab) => seen[tab].rootId)).size, 'three different roots').toBe(3);
      expect(seen.players.rootId, 'Players and Rankings share the board root').toBe(
        seen.rankings.rootId,
      );

      const base = seen.players;
      for (const tab of TABS) {
        const s = seen[tab];
        expect(s.barCount, `${tab}: one TabBar in the document`).toBe(1);
        expect(s.stripCount, `${tab}: one #social-tabs`).toBe(1);
        expect(s.barInRoot, `${tab}: the bar is inside the shown root`).toBe(true);
        expect(s.barIsFirstOfChrome, `${tab}: the bar is the chrome's first child`).toBe(true);
        expect(s.chromeIsFirstOfRoot, `${tab}: the chrome holds the bar`).toBe(true);
        expectNear(s.bar.y, s.contentTop, 0.5, `${tab}: the bar's top is the panel's content top`);
        expect(s.lb.width, `${tab}: the LB chip has width`).toBeGreaterThan(0);
        expect(s.rb.width, `${tab}: the RB chip has width`).toBeGreaterThan(0);
        expect(s.lb.x + s.lb.width, `${tab}: LB, then the strip`).toBeLessThanOrEqual(
          s.strip.x + 1,
        );
        expect(s.strip.x + s.strip.width, `${tab}: the strip, then RB`).toBeLessThanOrEqual(
          s.rb.x + 1,
        );
        expectRect(s.bar, base.bar, 0.5, `${tab}: the .mr-tabbar rect == Players'`);
        expectRect(s.strip, base.strip, 0.5, `${tab}: the #social-tabs rect == Players'`);
        expectRect(s.lb, base.lb, 0.5, `${tab}: the LB chip rect == Players'`);
        expectRect(s.rb, base.rb, 0.5, `${tab}: the RB chip rect == Players'`);
      }

      // Players to Rankings (one root): every element above the body keeps its rect.
      await goTo(page, 'players');
      const onPlayers = await aboveBody(page);
      await goTo(page, 'rankings');
      const onRankings = await aboveBody(page);
      expect(
        Object.keys(onPlayers).length,
        'non-vacuity: the root, its pre-body children, the chrome parts and the bar parts',
      ).toBeGreaterThanOrEqual(8);
      expect(Object.keys(onRankings), 'the same elements on both tabs').toEqual(
        Object.keys(onPlayers),
      );
      for (const [name, rect] of Object.entries(onPlayers)) {
        expectRect(onRankings[name] as Rect, rect, 0.5, `Players -> Rankings: ${name}`);
      }
    });

    test('UIF9.3 the four Social panels compute the same root padding, row left edge, row padding (non-cursor everywhere, cursor on Players / Challenges / Trades), row container margin and padding, and vertical gap between rows', async () => {
      // WRONG IMPL KILLED: today's Rankings `<ul>` (UA margin 14px 0 and padding-left 40px: its rows
      // start at x=66 against 26 on the other panels and 14px lower); a non-cursor Challenges row
      // that is not a `.mr-nav-item` (padding 0 against 2px 8px 2px 20px on every other row); a
      // Challenges row whose padding changes with the cursor; a panel whose root padding or border
      // differs; rows separated by a margin on one panel only; four panels that agree on a wrong
      // root padding (the --mr-space-4 anchor). The Rankings CURSOR row is excluded from the
      // cursor-padding comparison on purpose: qf-16 gives it a read-only left bar (border-left
      // 0.25rem, padding-left 1rem), which UIF9.5 pins.
      const snaps = {} as Record<Tab, PanelSnap>;
      for (const tab of TABS) {
        await goTo(page, tab);
        snaps[tab] = await panelSnap(page, tab);
      }

      // Non-vacuity: rows exist on every panel, a cursor row on every panel, a non-cursor row on
      // every panel (Trades lists its two session rows).
      for (const tab of TABS) {
        expect(snaps[tab].rows.length, `${tab}: rows are listed`).toBeGreaterThan(0);
        expect(
          snaps[tab].rows.filter((r) => r.active).length,
          `${tab}: exactly one cursor row`,
        ).toBe(1);
      }
      expect(snaps.trades.rows.length, 'Trades lists the two session rows').toBe(2);
      for (const tab of TABS) {
        expect(
          snaps[tab].rows.filter((r) => !r.active).length,
          `${tab}: has a non-cursor row`,
        ).toBeGreaterThan(0);
      }
      expect(snaps.rankings.rows.length, 'Rankings lists the thirty profiles').toBe(30);

      // The shown root's computed padding (4 sides) and border (4 sides).
      const startPadding = await resolveLength(page, '--mr-space-4');
      for (const tab of TABS) {
        expect(snaps[tab].rootPadding, `${tab}: root padding == Players'`).toBe(
          snaps.players.rootPadding,
        );
        expect(snaps[tab].rootBorder, `${tab}: root border == Players'`).toBe(
          snaps.players.rootBorder,
        );
      }
      // ANCHOR: the root's start padding is the --mr-space-4 token (equally wrong panels fail).
      expect(
        snaps.players.rootPadding.split(' ')[3],
        'anchor: the root padding-left is --mr-space-4',
      ).toBe(startPadding);

      // Each row's left edge: the panel's content-left (nothing indents a row), equal on all four.
      const baseLeft = (snaps.players.rows[0] as RowSnap).left;
      for (const tab of TABS) {
        for (const [i, row] of snaps[tab].rows.entries()) {
          expectNear(
            row.left,
            snaps[tab].contentLeft,
            0.5,
            `${tab} row ${i}: left == content-left`,
          );
          expectNear(row.left, baseLeft, 0.5, `${tab} row ${i}: left == Players' first row`);
        }
      }

      // Non-cursor rows: the same computed padding on every panel.
      const nonCursor = (tab: Tab): string[] =>
        snaps[tab].rows.filter((r) => !r.active).map((r) => r.padding);
      const wantNonCursor = nonCursor('players')[0] as string;
      for (const tab of TABS) {
        expect(
          [...new Set(nonCursor(tab))],
          `${tab}: every non-cursor row has Players' non-cursor padding`,
        ).toEqual([wantNonCursor]);
      }

      // Cursor rows: the same computed padding on Players, Challenges and Trades.
      const cursorPad = (tab: Tab): string =>
        (snaps[tab].rows.find((r) => r.active) as RowSnap).padding;
      for (const tab of ['challenges', 'trades'] as const) {
        expect(cursorPad(tab), `${tab}: cursor row padding == Players'`).toBe(cursorPad('players'));
      }

      // Row margins: identical on every panel's rows.
      const margins = TABS.flatMap((tab) => snaps[tab].rows.map((r) => r.margin));
      expect([...new Set(margins)], 'every row, on every panel, has one margin').toHaveLength(1);

      // The row container's margin and padding (Players and Rankings have one): equal, and zero.
      const players = snaps.players.container;
      const rankings = snaps.rankings.container;
      expect(players, 'Players has a row container').not.toBeNull();
      expect(rankings, 'Rankings has a row container').not.toBeNull();
      expect(rankings, 'the Rankings container == the Players container').toEqual(players);
      expect(players, 'and both are margin 0 / padding 0').toEqual({
        margin: '0px 0px 0px 0px',
        padding: '0px 0px 0px 0px',
      });

      // The vertical gap between consecutive rows: one value on every panel that has two rows.
      const gaps = (['players', 'rankings', 'challenges'] as const).map((tab) =>
        gapsOf(snaps[tab].rows),
      );
      for (const [i, tab] of (['players', 'rankings', 'challenges'] as const).entries()) {
        expect((gaps[i] as number[]).length, `${tab}: consecutive rows exist`).toBeGreaterThan(0);
        for (const [j, gap] of (gaps[i] as number[]).entries()) {
          expectNear(
            gap,
            (gaps[0] as number[])[0] as number,
            0.5,
            `${tab}: gap ${j} == Players' gap`,
          );
        }
      }
    });

    test('UIF9.4 the Challenges tab lists each challenge as a RowCard with a visible border, the two cards do not overlap, the cursor card is treated differently from the other, the cursor row is one line of card tall; and the Trades panel lists its session rows in #trade-sessions, the cursor on one of them and never on #trade-status, with no RowCard', async () => {
      // WRONG IMPL KILLED: today's bare label divs (no `.mr-card`: the locators match nothing); a
      // card with no border or one drawn in the panel's own colour (no visible separation); two
      // cards that touch or overlap; a cursor card styled exactly like the other (the kit's
      // `.mr-nav-item.is-active > .mr-card` rule is not reached); a ▶ that pushes the card onto a
      // second line (the cursor row is taller than the other); a card wrapped around a session row
      // or the status line; a cursor painted on `#trade-status` (the offer-based trade row's mark)
      // beside or instead of the session row's.
      await goTo(page, 'challenges');
      const incoming = '#pvp-challenge-incoming > .mr-card';
      const outgoing = '#pvp-challenge-outgoing > .mr-card';
      await expect(page.locator(incoming), 'the incoming challenge is one card').toHaveCount(1);
      await expect(page.locator(outgoing), 'the outgoing challenge is one card').toHaveCount(1);
      await expect(page.locator(incoming)).toBeVisible();
      await expect(page.locator(outgoing)).toBeVisible();

      const measure = (sel: string) =>
        page.evaluate((s) => {
          const el = document.querySelector<HTMLElement>(s);
          if (el === null) throw new Error(`no element matches ${s}`);
          const cs = getComputedStyle(el);
          const b = el.getBoundingClientRect();
          return {
            width: ['top', 'right', 'bottom', 'left'].map((side) =>
              Number.parseFloat(cs.getPropertyValue(`border-${side}-width`)),
            ),
            style: cs.getPropertyValue('border-top-style'),
            colour: cs.getPropertyValue('border-top-color'),
            rect: { x: b.x, y: b.y, width: b.width, height: b.height },
          };
        }, sel);
      const cards = { incoming: await measure(incoming), outgoing: await measure(outgoing) };
      for (const [name, card] of Object.entries(cards)) {
        expect(
          card.width.every((w) => w > 0) && card.style !== 'none',
          `${name}: a border on every side`,
        ).toBe(true);
        // NAMED INTENTIONAL CHANGE (uif-9, UIF9.4): was "the border colour is not the PANEL's
        // background". Wrong for the cursor card by the kit's design: `.mr-nav-item.is-active` fills
        // its row with --mr-frame-fg and `.mr-nav-item.is-active > .mr-card` draws the border in
        // currentColor (the dark text colour), so the border is visible against the light row
        // fill behind it, not against the panel. Now: the border is measured against the effective
        // background directly BEHIND the card (its parent row), with a WCAG contrast ratio above
        // 1.5 (a visibly distinct line, far below text's 4.5, honest for both cards).
        const border = parseRgb(card.colour);
        expect(border.a, `${name}: the border is painted`).toBeGreaterThan(0);
        const backdrop = await effectiveBackground(page, `#pvp-challenge-${name}`);
        expect(
          contrastRatio({ ...border, a: 1 }, backdrop),
          `${name}: the border colour contrasts with the backdrop behind the card`,
        ).toBeGreaterThan(1.5);
      }
      expect(
        rectsOverlap(cards.incoming.rect, cards.outgoing.rect, 0),
        'the two cards do not overlap',
      ).toBe(false);
      expect(
        cards.outgoing.rect.y,
        'the outgoing card starts at or below the incoming one`s bottom',
      ).toBeGreaterThanOrEqual(cards.incoming.rect.y + cards.incoming.rect.height - 0.5);

      // The cursor card against the other: one of each, a different computed treatment.
      const treatment = await page.evaluate(() => {
        const pick = (el: Element): string => {
          const cs = getComputedStyle(el);
          return [
            'background-color',
            'color',
            'outline-style',
            'outline-color',
            'border-top-color',
            'border-top-width',
            'box-shadow',
          ]
            .map((prop) => cs.getPropertyValue(prop))
            .join(' | ');
        };
        // The two rows are the two containers; the cursor row is the one wearing is-active.
        const rows = ['pvp-challenge-incoming', 'pvp-challenge-outgoing'].map(
          (id) => document.getElementById(id) as HTMLElement,
        );
        const cursor = rows.filter((r) => r.classList.contains('is-active'));
        const other = rows.filter((r) => !r.classList.contains('is-active'));
        const card = (r: HTMLElement | undefined): Element | null =>
          r === undefined ? null : r.querySelector(':scope > .mr-card');
        const cursorCard = card(cursor[0]);
        const otherCard = card(other[0]);
        return {
          cursors: cursor.length,
          others: other.length,
          cursor: cursorCard === null ? '' : pick(cursorCard),
          other: otherCard === null ? '' : pick(otherCard),
          cursorRowHeight: cursor[0]?.getBoundingClientRect().height ?? -1,
          otherRowHeight: other[0]?.getBoundingClientRect().height ?? -1,
        };
      });
      expect(treatment.cursors, 'one cursor row (is-active)').toBe(1);
      expect(treatment.others, 'one other row').toBe(1);
      expect(treatment.cursor, 'the cursor row holds its card').not.toBe('');
      expect(treatment.other, 'the other row holds its card').not.toBe('');
      expect(treatment.cursor, 'the cursor card is treated differently from the other').not.toBe(
        treatment.other,
      );
      expectNear(
        treatment.cursorRowHeight,
        treatment.otherRowHeight,
        1,
        'the cursor row is one line of card tall (the ▶ does not wrap the card)',
      );

      // Trades: the two session rows, the cursor on the waiting one, the status line unmarked, and
      // no RowCard.
      await goTo(page, 'trades');
      await expect(
        page.locator('#trade-sessions'),
        'precondition: the Trades panel shows its session rows',
      ).toBeVisible();
      await expect(
        page.locator('#trade-sessions > [data-nav-key]'),
        'one row per session the viewer is in',
      ).toHaveCount(2);
      await expect(
        page.locator('#trade-sessions > .is-active'),
        'the cursor is on one session row',
      ).toHaveCount(1);
      await expect(
        page.locator('#trade-sessions > .is-active'),
        'the waiting session (5) holds the cursor',
      ).toHaveAttribute('data-nav-key', 'session-5');
      await expect(
        page.locator(
          '#trade-status.mr-nav-item, #trade-status.is-active, #trade-status[aria-current]',
        ),
        'the status line carries no cursor mark',
      ).toHaveCount(0);
      await expect(
        page.locator('#trade-overlay .mr-card'),
        'the Trades panel holds no RowCard',
      ).toHaveCount(0);
    });

    test('UIF9.5 an overflowing Rankings list scrolls on the shared mr-scroll rule (class, overflow and cue layers equal a probe wearing mr-scroll alone), the D-pad keeps the cursor row inside the list down to the last row, and the read-only cursor row computes no ▶ and keeps its left bar', async () => {
      // WRONG IMPL KILLED: a Rankings list with no `mr-scroll` class (it leans on the qf-16
      // `[aria-readonly]` selector alone: the shared rule is not what styles it); an inline
      // background or overflow that replaces the shared cue; a list that does not overflow its
      // box (it grows with its rows: scrollHeight == clientHeight); a cursor that leaves the list
      // rect while stepping down (no scroll-with-cursor); a read-only cursor row that regained the
      // actionable ▶ or lost its left bar (qf-16 QF16.1: it reads "you are here", not "press A").
      await goTo(page, 'rankings');
      const state = () =>
        page.evaluate(() => {
          const list = document.getElementById('leaderboard-list');
          if (list === null) throw new Error('#leaderboard-list is missing');
          const rows = [...list.children] as HTMLElement[];
          const cursor = rows.findIndex((li) => li.classList.contains('is-active'));
          const lr = list.getBoundingClientRect();
          const row = cursor >= 0 ? (rows[cursor] as HTMLElement).getBoundingClientRect() : null;
          const cs = getComputedStyle(list);
          return {
            count: rows.length,
            cursor,
            classes: list.className,
            readonly: list.getAttribute('aria-readonly'),
            inlineStyle: list.getAttribute('style') ?? '',
            overflowY: cs.overflowY,
            scrollHeight: list.scrollHeight,
            clientHeight: list.clientHeight,
            scrollTop: list.scrollTop,
            list: { top: lr.top, bottom: lr.bottom },
            row: row === null ? null : { top: row.top, bottom: row.bottom },
          };
        });

      const first = await state();
      expect(first.count, 'fixture: thirty ranked rows').toBe(30);
      expect(first.cursor, 'the cursor opens on the first row').toBe(0);
      expect(
        first.scrollHeight,
        'fixture: the rows overflow the list (non-vacuity)',
      ).toBeGreaterThan(first.clientHeight);
      expect(first.classes.split(/\s+/), 'the list wears the shared mr-scroll class').toContain(
        'mr-scroll',
      );
      expect(first.readonly, 'and stays aria-readonly (the qf-16 read-only treatment)').toBe(
        'true',
      );
      expect(first.overflowY, 'the list scrolls its own overflow').toBe('auto');
      expect(
        first.inlineStyle.includes('background'),
        'no inline background replaces the cue',
      ).toBe(false);
      expect(first.inlineStyle.includes('overflow'), 'no inline overflow').toBe(false);

      // The cue is the SHARED rule's: a probe wearing mr-scroll alone computes the same layers.
      const props = ['background-image', 'background-attachment', 'overflow-y'] as const;
      const shared = await sampleProbe(page, { className: 'mr-scroll', parent: 'body' }, props);
      const mine = await sampleStyle(page, '#leaderboard-list', props);
      expect(shared['background-image'], 'the probe carries the gradient cue').toContain(
        'radial-gradient',
      );
      expect(shared['background-image'], 'including the cover layers').toContain('linear-gradient');
      expect(mine['background-image'], 'the list`s cue layers == the shared rule`s').toBe(
        shared['background-image'],
      );
      expect(
        mine['background-attachment'],
        'the list`s layer attachments == the shared rule`s',
      ).toBe(shared['background-attachment']);
      expect(mine['overflow-y'], 'overflow-y == the shared rule`s').toBe(shared['overflow-y']);

      // D-pad Down to the last row: the cursor row stays inside the list's rect at every step.
      const inside = (s: Awaited<ReturnType<typeof state>>, label: string): void => {
        expect(s.row, `${label}: a cursor row is marked`).not.toBeNull();
        const r = s.row as { top: number; bottom: number };
        expect(r.top, `${label}: the cursor row's top is inside the list`).toBeGreaterThanOrEqual(
          s.list.top - 0.5,
        );
        expect(
          r.bottom,
          `${label}: the cursor row's bottom is inside the list`,
        ).toBeLessThanOrEqual(s.list.bottom + 0.5);
      };
      inside(first, 'row 0');
      for (let row = 1; row < first.count; row += 1) {
        await press(page, 'Down');
        await expect
          .poll(async () => (await state()).cursor, { message: `Down ${row} reaches row ${row}` })
          .toBe(row);
        await expect
          .poll(
            async () => {
              const s = await state();
              return (
                s.row !== null &&
                s.row.top >= s.list.top - 0.5 &&
                s.row.bottom <= s.list.bottom + 0.5
              );
            },
            { message: `row ${row}: the cursor row is scrolled inside the list` },
          )
          .toBe(true);
        inside(await state(), `row ${row}`);
      }
      expect(
        (await state()).scrollTop,
        'the list scrolled to keep the last row in view',
      ).toBeGreaterThan(0);

      // The read-only cursor row (the last row now): no ▶, a left bar.
      const cursorRow = '#leaderboard-list > li.is-active';
      const arrow = await sampleStyle(page, cursorRow, ['content'], '::before');
      expect(arrow.content, 'the read-only cursor row computes no ▶ (content none)').toBe('none');
      const bar = await sampleStyle(page, cursorRow, ['border-left-width', 'border-left-style']);
      expect(
        Number.parseFloat(bar['border-left-width'] as string),
        'the read-only cursor row keeps its left bar',
      ).toBeGreaterThan(0);
      expect(bar['border-left-style'], 'drawn, not none').not.toBe('none');
    });
  });
