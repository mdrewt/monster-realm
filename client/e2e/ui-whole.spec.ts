import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { navItemId } from '../src/ui/navRender';
import {
  awaitTacticalActive,
  closeAll,
  fleeByButtons,
  pressButton,
  readTactics,
  TACTICS,
  type TacticsSnap,
  type Tile,
  throughResults,
} from './controls';
import { ownerSql } from './stdb';
import { countMatching, expectNear, expectRect, measuredContrast, sampleStyle } from './uiKit';

// ui-whole.spec.ts — uif-17 (M-ui-foundation): the INTEGRATED WHOLE, measured in Chromium at
// 1280x720 (UIF17.1 to UIF17.4). Per-screen proofs stay in ui-menu / ui-monsters / ui-inventory /
// ui-help / ui-controls / ui-profile / ui-social / ui-chrome / ui-scale / ui-feedback; this walk proves
// the screens still hold TOGETHER: one player, one context, the D-pad only, every root leaf of the
// main menu and every tab of every tabbed screen, then the sheets and messages, the three window
// sizes and the hint bar.
//
// ORACLE RULE. Every expected value is a LITERAL transcribed from the wf-1 token table
// (M-ui-foundation-wireframes.md, "Token table (WF1.5)") or from the shipped chip catalog, written
// as the computed value Chromium reports (`20px`, `700`, `rgb(224, 224, 224)`). Nothing is read back
// from the stylesheet, from a token or from the hint-bar model. Where a shipped screen DELIBERATELY
// differs from the wf-1 number (How to Play's heading is a bare div at the shell's 14px, Social has
// no title at all), the AS-SHIPPED value is the literal, marked `AS SHIPPED` where it is written: it
// pins the screens against regression and the difference is recorded in the PR (a cosmetic gap that
// fails nothing), not asserted as a defect.
//
// HYGIENE. ONE browser, ONE context (1280x720, deviceScaleFactor 1), ONE player, closed in afterAll
// (golden.spec.ts asserts an exact presence count: no second context). Every test starts from
// `closeAll` and opens what it needs, so each runs alone under `-g`. The only state written is a stack
// of Power Root seeded by owner SQL (Inventory needs an item to show a sheet), a rename (the toast
// flow of ui-feedback), and the Controls text size, which is put back by the same D-pad path and then
// cleared from storage. No fixed sleeps: every wait polls a bounded predicate. Screenshots are taken
// only when UI_WHOLE_SHOTS names a directory (evidence for the PR body); nothing asserts on one.
//
// PASSES AT MASTER BY CONSTRUCTION; bite-proved by mutants (styles.css, ui/menuModel.ts,
// render/resizeWiring.ts, ui/hintBar*.ts), not by a red run.

const VIEWPORT = { width: 1280, height: 720 } as const;
const FG = 'rgb(224, 224, 224)'; // --mr-frame-fg / --mr-frame-border #e0e0e0
const PANEL_BG = 'rgb(24, 24, 38)'; // --mr-panel-bg #181826 (the selected tab's fill)
const NO_FILL = 'rgba(0, 0, 0, 0)';
const DISABLED = 'rgb(138, 138, 154)'; // --mr-text-disabled #8a8a9a
const ARROW = String.fromCodePoint(0x25b6); // the focused row's glyph
const FOUR_FG = [FG, FG, FG, FG].join(' ');
const FOOD_ITEM_ID = 2; // Power Root (ui-inventory.spec.ts)
const FOOD_SEED = 3;
/** The root leaves in MENU_ENTRIES order (menuModel.ts), then Close. */
const MENU_KEYS = [
  'monsters',
  'bag',
  'journal',
  'social',
  'profile',
  'help',
  'controls',
  'close',
] as const;

interface Frame {
  kind: string;
  id?: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  ownMonsters: Array<{ monsterId: string }>;
  ownInventory: Array<{ itemId: number; count: number }>;
  ongoingBattle: { battleId: string } | null;
  stack: Frame[];
  navActive: string | null;
  stageScale: number | null;
}
type Win = Window & { __game: () => GameSnap & { step: (d: string) => void } };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------------------------
// Page reads and the D-pad plumbing.
// ---------------------------------------------------------------------------------------------

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

const game = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as Win).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      ownMonsters: g.ownMonsters,
      ownInventory: g.ownInventory,
      ongoingBattle: g.ongoingBattle,
      stack: g.stack,
      navActive: g.navActive,
      stageScale: g.stageScale,
    };
  });

const stackNames = async (p: Page): Promise<string[]> =>
  (await game(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );
/** The stack without a typing frame (focusing a text field may push one). */
const frameNames = async (p: Page): Promise<string[]> =>
  (await stackNames(p)).filter((n) => n !== 'textEntry');
const navActive = async (p: Page): Promise<string | null> => (await game(p)).navActive;

/** Down presses (each followed by a poll that the cursor moved) until `read` names `key`. */
async function downTo(
  p: Page,
  read: (p: Page) => Promise<string | null>,
  key: string,
  maxPresses: number,
  what: string,
): Promise<void> {
  for (let i = 0; i < maxPresses && (await read(p)) !== key; i += 1) {
    const before = await read(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => read(p), { message: `${what}: Down moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await read(p), `${what}: the cursor is on ${key}`).toBe(key);
}

/** Start opens the menu, and Up (bounded) seats its remembered cursor on Monsters. */
async function openMenu(p: Page): Promise<void> {
  await closeAll(p);
  await pressButton(p, 'Start');
  await expect
    .poll(() => stackNames(p), { message: 'Start opens the menu' })
    .toEqual(['world', 'menuView']);
  await expect(p.locator('#menu-overlay'), 'the menu is shown').toBeVisible();
  for (let i = 0; i < MENU_KEYS.length && (await navActive(p)) !== 'monsters'; i += 1) {
    const before = await navActive(p);
    await pressButton(p, 'Up');
    await expect
      .poll(() => navActive(p), { message: `Up moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await navActive(p), 'the menu cursor is seated on Monsters').toBe('monsters');
}

/** The frame each menu leaf opens (menuModel.ts MENU_ENTRIES targets). */
const FRAME_OF: Readonly<Record<string, string>> = {
  monsters: 'boxView',
  bag: 'raisingView',
  journal: 'questLogView',
  social: 'social',
  profile: 'profileView',
  help: 'helpView',
  controls: 'controlsView',
};
/** The element whose focus marks an open as settled (a deferred initial focus would otherwise
 *  land after the next key and scroll the frame back). */
const SETTLED: Readonly<Record<string, string>> = {
  help: '#help-title',
  profile: '#rename-input',
};

/** Menu, Down to `key`, A: the leaf's frame above the menu, its open settled. */
async function openScreen(p: Page, key: string): Promise<void> {
  await openMenu(p);
  await downTo(p, navActive, key, 8, `the main menu to ${key}`);
  await pressButton(p, 'A');
  await expect
    .poll(() => frameNames(p), { message: `${key}: A opens ${FRAME_OF[key]} over the menu` })
    .toEqual(['world', 'menuView', FRAME_OF[key] as string]);
  const settled = SETTLED[key];
  if (settled !== undefined) {
    await expect(p.locator(settled), `${key}: the open settled`).toBeFocused();
  }
}

/** UI_WHOLE_SHOTS=<dir>: evidence for the PR body. Never asserted on. */
async function shot(p: Page, name: string): Promise<void> {
  const dir = process.env.UI_WHOLE_SHOTS;
  if (dir === undefined || dir === '') return;
  mkdirSync(dir, { recursive: true });
  await p.screenshot({ path: join(dir, `${name}.png`) });
}

const rectsOf = (p: Page, selectors: readonly string[]): Promise<Box[]> =>
  p.evaluate((sels: readonly string[]): Box[] => {
    return sels.map((s) => {
      const el = document.querySelector(s);
      if (el === null) throw new Error(`rectsOf: ${s} is not on the page`);
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  }, selectors);

function expectInside(inner: Box, outer: Box, label: string): void {
  const k = 0.5;
  expect(inner.x, `${label}: left edge`).toBeGreaterThanOrEqual(outer.x - k);
  expect(inner.y, `${label}: top edge`).toBeGreaterThanOrEqual(outer.y - k);
  expect(inner.x + inner.width, `${label}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width + k,
  );
  expect(inner.y + inner.height, `${label}: bottom edge`).toBeLessThanOrEqual(
    outer.y + outer.height + k,
  );
}

// ---------------------------------------------------------------------------------------------
// The screens of the walk, as data: where each one's parts are, and what wf-1 / the shipped chrome
// computes for them. A stop is one screen or one tab of a tabbed screen.
// ---------------------------------------------------------------------------------------------

interface TitleCfg {
  readonly sel: string;
  readonly px: string;
  readonly weight: string;
  readonly color: string;
  /** The kit title bar (`.mr-frame-titlebar`, 2.5rem = 40px), where the screen has one. */
  readonly bar: string | null;
}
interface FocusCfg {
  /** The focused row's selector, or null (no row on this tab, or DOM focus). */
  readonly sel: string | null;
  /** The cursor is DOM focus (Profile). */
  readonly dom: boolean;
  /** A focused row MUST exist here (the anti-vacuity census counts these). */
  readonly required: boolean;
}
interface WalkCtx {
  readonly visited: string[];
  readonly tabsSampled: Record<string, number>;
  readonly bars: Map<string, Box>;
  lbSteps: number;
  rowChecks: number;
  focusRequired: number;
  titleChecks: number;
}
interface Stop {
  readonly id: string;
  readonly shot: string;
  readonly root: string;
  readonly title: TitleCfg | null;
  /** The tab key, for a stop on a tabbed screen. */
  readonly tab: string | null;
  /** The element that sits BELOW the tab bar. */
  readonly content: string | null;
  readonly focus: FocusCfg;
  /** The box the focused row must stay inside (and the window). */
  readonly scroller: string;
  /** Where the `.mr-nav-item` rows of this stop live; null when it shows none. */
  readonly rowScope: string | null;
  readonly extra?: (p: Page) => Promise<void>;
}
interface Screen {
  readonly key: string;
  /** The tab strip (one per tabbed screen) and its tab keys in RB order. */
  readonly strip: string | null;
  readonly tabKeys: readonly string[];
  readonly stops: readonly Stop[];
}

const NO_FOCUS: FocusCfg = { sel: null, dom: false, required: false };
const focusOn = (sel: string): FocusCfg => ({ sel, dom: false, required: true });
const SHEET = '[data-context-sheet]:not([hidden])';

const MONSTERS_ROOT = '.mr-frame:has([data-testid="box-title"])';
const BAG_ROOT = '.mr-frame:has([data-testid="raising-title"])';
/** A frame title in the kit title bar: 20px, 700, the frame foreground, the bar measured. */
const kitTitle = (sel: string, bar: string): TitleCfg => ({
  sel,
  px: '20px',
  weight: '700',
  color: FG,
  bar,
});

const SOCIAL_ROOT: Readonly<Record<string, string>> = {
  players: '#leaderboard-overlay',
  trades: '#trade-overlay',
  challenges: '#pvp-challenge-overlay',
  rankings: '#leaderboard-overlay',
};
/** AS SHIPPED: the Social frame has no title (its chrome is the tab bar, then the panel). A lone
 *  fresh player has no other player, no trade, no challenge and no ranked profile, so no row stands
 *  on a Social tab either. */
const socialStop = (tab: string): Stop => ({
  id: `social/${tab}`,
  shot: `social-${tab}`,
  root: SOCIAL_ROOT[tab] as string,
  title: null,
  tab,
  content: null,
  focus: NO_FOCUS,
  scroller: SOCIAL_ROOT[tab] as string,
  rowScope: null,
});

const activeId = (p: Page): Promise<string> => p.evaluate(() => document.activeElement?.id ?? '');
const encyclopediaKey = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document.querySelector('#help-encyclopedia .is-active')?.getAttribute('data-nav-key') ?? null,
  );

/** UIF.6: a disabled row stays readable (3:1 or better) yet reads below an enabled row. The Monsters
 *  sheet's Feed row is disabled for a player with no food (ui-chrome UIF1.3). */
async function monstersDisabledRow(p: Page): Promise<void> {
  await pressButton(p, 'A');
  const feed = `#${navItemId('monstersSheet', null, 'feed')}`;
  await expect(p.locator(feed), 'the Monsters sheet shows its Feed row').toBeVisible();
  await expect(p.locator(feed), 'Feed is disabled (no food yet)').toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect((await sampleStyle(p, feed, ['color'])).color, 'Feed reads the disabled token').toBe(
    DISABLED,
  );
  const enabled = `${MONSTERS_ROOT} ${SHEET} .mr-nav-item:not(.is-active):not(.is-disabled)`;
  expect(
    await countMatching(p, enabled),
    'an enabled resting row exists to compare',
  ).toBeGreaterThan(0);
  const off = await measuredContrast(p, feed);
  const on = await measuredContrast(p, enabled);
  expect(off, `disabled row contrast ${off.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  expect(off, `disabled (${off.toFixed(2)}) reads below enabled (${on.toFixed(2)})`).toBeLessThan(
    on,
  );
  await shot(p, 'monsters-sheet');
  await pressButton(p, 'B');
  await expect(p.locator(`${MONSTERS_ROOT} ${SHEET}`), 'B closed the sheet').toHaveCount(0);
  expect(await stackNames(p), 'Monsters is still open').toEqual(['world', 'menuView', 'boxView']);
}

/** The Encyclopedia (16 terms) overflows: Down to the LAST term, the cursor row stays visible. */
async function encyclopediaToLast(p: Page): Promise<void> {
  let key = await encyclopediaKey(p);
  for (let i = 0; i < 20 && key !== 'ranked'; i += 1) {
    await pressButton(p, 'Down');
    const before = key;
    await expect
      .poll(() => encyclopediaKey(p), { message: `Down moves the cursor off ${before}` })
      .not.toBe(before);
    key = await encyclopediaKey(p);
  }
  expect(key, 'Down reached the last term').toBe('ranked');
  await expectFocusVisible(p, ENCYCLOPEDIA_STOP, 'the last Encyclopedia term');
  await shot(p, 'help-detail-last');
}

/** In the name field the arrows belong to the caret: Escape leaves it (ui-profile UIF16B.2). */
async function leaveNameField(p: Page): Promise<void> {
  if ((await activeId(p)) !== 'rename-input') return;
  await p.keyboard.press('Escape');
  await expect
    .poll(() => activeId(p), { message: 'Escape leaves the name field' })
    .not.toBe('rename-input');
}

/** Profile overflows at 1280x720: Down walks the column to Close (the last row); every landing
 *  stays inside the scrolling body and the window. */
async function profileToLast(p: Page): Promise<void> {
  await leaveNameField(p);
  let id = await activeId(p);
  const seen = [id];
  for (let i = 0; i < 15 && id !== 'profile-close-btn'; i += 1) {
    const before = id;
    await pressButton(p, 'Down');
    await expect
      .poll(() => activeId(p), { message: `Down moves focus off #${before}` })
      .not.toBe(before);
    id = await activeId(p);
    seen.push(id);
    await expectFocusVisible(p, PROFILE_STOP, `Profile row #${id}`);
  }
  expect(id, `Down reached Close, the last row (rows: ${seen.join(' > ')})`).toBe(
    'profile-close-btn',
  );
  expect(seen.length, 'the column holds more than one row').toBeGreaterThan(1);
}

const ENCYCLOPEDIA_STOP: Stop = {
  id: 'help/encyclopedia',
  shot: 'help-encyclopedia',
  root: '#help-overlay',
  title: { sel: '#help-title', px: '14px', weight: '400', color: FG, bar: null },
  tab: 'encyclopedia',
  content: '#help-encyclopedia',
  focus: focusOn('#help-encyclopedia .mr-nav-item.is-active'),
  scroller: '#help-overlay',
  rowScope: '#help-encyclopedia',
  extra: encyclopediaToLast,
};
const PROFILE_STOP: Stop = {
  id: 'profile',
  shot: 'profile',
  root: '#profile-overlay',
  title: kitTitle('#profile-title', '#profile-overlay .mr-frame-titlebar'),
  tab: null,
  content: null,
  focus: { sel: null, dom: true, required: true },
  scroller: '#profile-body',
  rowScope: null,
  extra: profileToLast,
};

const controlsStop = (tab: string): Stop => ({
  id: `controls/${tab}`,
  shot: `controls-${tab}`,
  root: '#controls-overlay',
  title: kitTitle('#controls-title', '#controls-overlay .mr-frame-titlebar'),
  tab,
  content: '#controls-rows',
  focus: focusOn('#controls-rows .mr-nav-item.is-active'),
  scroller: '#controls-overlay',
  rowScope: '#controls-rows',
});
const bagStop = (tab: string, food: boolean): Stop => ({
  id: `bag/${tab}`,
  shot: 'inventory',
  root: BAG_ROOT,
  title: kitTitle('[data-testid="raising-title"]', `${BAG_ROOT} .mr-frame-titlebar`),
  tab,
  content: '#bag-panel',
  // Only the Food pocket holds the seeded item; the other pockets show their EmptyState.
  focus: food ? focusOn('#bag-list .mr-nav-item.is-active') : NO_FOCUS,
  scroller: '#bag-panel',
  rowScope: food ? '#bag-list' : null,
});

const MENU_STOP: Stop = {
  id: 'menu',
  shot: 'main-menu',
  root: '#menu-overlay .mr-frame',
  title: kitTitle('#menu-overlay .mr-frame-title', '#menu-overlay .mr-frame-titlebar'),
  tab: null,
  content: '#menu-rows',
  focus: focusOn('#menu-rows .mr-nav-item.is-active'),
  scroller: '#menu-overlay',
  rowScope: '#menu-rows',
};

const SCREENS: readonly Screen[] = [
  {
    key: 'monsters',
    strip: '#monsters-tabs',
    tabKeys: ['party', 'storage'],
    stops: [
      {
        id: 'monsters/party',
        shot: 'monsters-party',
        root: MONSTERS_ROOT,
        title: kitTitle('[data-testid="box-title"]', `${MONSTERS_ROOT} .mr-frame-titlebar`),
        tab: 'party',
        content: '#monsters-panel',
        // Party cells are inline-styled cards, not `.mr-nav-item` rows; the cursor is aria-current.
        focus: focusOn('#monsters-panel [aria-current="true"]'),
        scroller: '#monsters-panel',
        rowScope: null,
        extra: monstersDisabledRow,
      },
      {
        id: 'monsters/storage',
        shot: 'monsters-storage',
        root: MONSTERS_ROOT,
        title: kitTitle('[data-testid="box-title"]', `${MONSTERS_ROOT} .mr-frame-titlebar`),
        tab: 'storage',
        content: '#monsters-panel',
        focus: NO_FOCUS, // an empty Storage shows the EmptyState
        scroller: '#monsters-panel',
        rowScope: null,
      },
    ],
  },
  {
    key: 'bag',
    strip: '#bag-tabs',
    tabKeys: ['bait', 'food', 'medicine', 'other'],
    stops: [
      bagStop('bait', false),
      bagStop('food', true),
      bagStop('medicine', false),
      bagStop('other', false),
    ],
  },
  {
    key: 'journal',
    strip: null,
    tabKeys: [],
    stops: [
      {
        id: 'journal',
        shot: 'journal',
        root: '#quest-log-overlay',
        title: kitTitle('#quest-log-title', '#quest-log-overlay .mr-frame-titlebar'),
        tab: null,
        content: null,
        focus: NO_FOCUS, // a fresh player has no quest: the EmptyState shows
        scroller: '#quest-log-overlay',
        rowScope: null,
      },
    ],
  },
  {
    key: 'social',
    strip: '#social-tabs',
    tabKeys: ['players', 'trades', 'challenges', 'rankings'],
    stops: ['players', 'trades', 'challenges', 'rankings'].map(socialStop),
  },
  { key: 'profile', strip: null, tabKeys: [], stops: [PROFILE_STOP] },
  {
    key: 'help',
    strip: '#help-tabs',
    tabKeys: ['intro', 'encyclopedia'],
    stops: [
      {
        id: 'help/intro',
        shot: 'help-introduction',
        root: '#help-overlay',
        // AS SHIPPED: How to Play's heading is a bare div at the shell's 14px, normal weight.
        title: { sel: '#help-title', px: '14px', weight: '400', color: FG, bar: null },
        tab: 'intro',
        content: '#help-intro',
        focus: focusOn('#help-intro-rows .mr-nav-item.is-active'),
        scroller: '#help-overlay',
        rowScope: '#help-intro-rows',
      },
      ENCYCLOPEDIA_STOP,
    ],
  },
  {
    key: 'controls',
    strip: '#controls-tabs',
    tabKeys: ['buttons', 'shortcuts', 'display'],
    stops: ['buttons', 'shortcuts', 'display'].map(controlsStop),
  },
];

/** The literal the walk must produce (anti-vacuity), in walk order. */
const VISITED = [
  'menu',
  'monsters/party',
  'monsters/storage',
  'bag/bait',
  'bag/food',
  'bag/medicine',
  'bag/other',
  'journal',
  'social/players',
  'social/trades',
  'social/challenges',
  'social/rankings',
  'profile',
  'help/intro',
  'help/encyclopedia',
  'controls/buttons',
  'controls/shortcuts',
  'controls/display',
];

// ---------------------------------------------------------------------------------------------
// One in-page measurement of a stop.
// ---------------------------------------------------------------------------------------------

interface Snap {
  win: [number, number];
  root: { box: Box; border: string; borderColor: string; contentTop: number };
  title: null | {
    box: Box;
    text: string;
    fontSize: string;
    fontWeight: string;
    color: string;
    barBox: Box | null;
  };
  bars: number;
  bar: null | {
    rowClass: string;
    row: Box;
    strip: Box;
    lb: Box;
    rb: Box;
    chips: Array<string | undefined>;
    tabs: Box[];
    keys: string[];
    selected: string[];
    selStyle: Record<string, string> | null;
    restStyle: Record<string, string> | null;
    selIsActive: boolean;
  };
  content: Box | null;
  scroller: Box;
  focus: null | { box: Box; text: string; hit: boolean };
  row: null | {
    count: number;
    fontSize: string;
    activeBg: string | null;
    activeArrow: string | null;
  };
}

interface SnapCfg {
  root: string;
  title: TitleCfg | null;
  strip: string | null;
  content: string | null;
  focus: FocusCfg;
  scroller: string;
  rowScope: string | null;
}

const snapshot = (p: Page, stop: Stop, strip: string | null): Promise<Snap> => {
  const cfg: SnapCfg = {
    root: stop.root,
    title: stop.title,
    strip,
    content: stop.content,
    focus: stop.focus,
    scroller: stop.scroller,
    rowScope: stop.rowScope,
  };
  return p.evaluate((c: SnapCfg): Snap => {
    const shown = (el: Element): boolean =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const firstShown = (sel: string): HTMLElement | null => {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) if (shown(el)) return el;
      return null;
    };
    const need = (sel: string): HTMLElement => {
      const el = firstShown(sel);
      if (el === null) throw new Error(`snapshot: nothing shown matches ${sel}`);
      return el;
    };
    const box = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const four = (cs: CSSStyleDeclaration, suffix: string): string =>
      ['top', 'right', 'bottom', 'left']
        .map((s) => cs.getPropertyValue(`border-${s}-${suffix}`))
        .join(' ');
    const props = (el: Element, names: readonly string[]): Record<string, string> => {
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const n of names) out[n] = cs.getPropertyValue(n);
      return out;
    };

    const root = need(c.root);
    const rcs = getComputedStyle(root);
    const rbox = box(root);

    let title: Snap['title'] = null;
    if (c.title !== null) {
      const el = need(c.title.sel);
      const cs = getComputedStyle(el);
      title = {
        box: box(el),
        text: (el.textContent ?? '').trim(),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        color: cs.color,
        barBox: c.title.bar === null ? null : box(need(c.title.bar)),
      };
    }

    let bar: Snap['bar'] = null;
    if (c.strip !== null) {
      const strip = need(c.strip);
      const row = strip.parentElement;
      if (row === null) throw new Error('snapshot: the tab strip has no row');
      const kids = [...row.children] as HTMLElement[];
      const tabs = [...strip.children] as HTMLElement[];
      const sel = tabs.filter((t) => t.classList.contains('is-selected'));
      const rest = tabs.find((t) => !t.classList.contains('is-selected')) ?? null;
      const STYLE = [
        'outline-width',
        'outline-style',
        'outline-color',
        'font-weight',
        'background-color',
      ];
      bar = {
        rowClass: row.className,
        row: box(row),
        strip: box(strip),
        lb: box(kids[0] as HTMLElement),
        rb: box(kids[2] as HTMLElement),
        chips: [kids[0]?.dataset.button, kids[2]?.dataset.button],
        tabs: tabs.map(box),
        keys: tabs.map((t) => t.dataset.navTab ?? ''),
        selected: sel.map((t) => t.dataset.navTab ?? ''),
        selStyle: sel[0] === undefined ? null : props(sel[0], STYLE),
        restStyle: rest === null ? null : props(rest, STYLE),
        selIsActive: sel.some((t) => t.classList.contains('is-active')),
      };
    }

    const contentEl = c.content === null ? null : firstShown(c.content);

    let focusEl: HTMLElement | null = null;
    if (c.focus.dom) {
      const a = document.activeElement;
      focusEl = a instanceof HTMLElement && a !== document.body && root.contains(a) ? a : null;
    } else if (c.focus.sel !== null) {
      focusEl = firstShown(c.focus.sel);
    }
    let focus: Snap['focus'] = null;
    if (focusEl !== null) {
      const r = focusEl.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      focus = {
        box: box(focusEl),
        text: (focusEl.textContent ?? '').trim(),
        hit: hit !== null && (hit === focusEl || focusEl.contains(hit)),
      };
    }

    let row: Snap['row'] = null;
    if (c.rowScope !== null) {
      const scope = need(c.rowScope);
      const rows = [...scope.querySelectorAll<HTMLElement>('.mr-nav-item')].filter(shown);
      const act = rows.find((r) => r.classList.contains('is-active')) ?? null;
      row = {
        count: rows.length,
        fontSize: rows[0] === undefined ? '' : getComputedStyle(rows[0]).fontSize,
        activeBg: act === null ? null : getComputedStyle(act).backgroundColor,
        activeArrow: act === null ? null : getComputedStyle(act, '::before').content,
      };
    }

    return {
      win: [window.innerWidth, window.innerHeight],
      root: {
        box: rbox,
        border: four(rcs, 'width'),
        borderColor: four(rcs, 'color'),
        contentTop:
          rbox.y + Number.parseFloat(rcs.borderTopWidth) + Number.parseFloat(rcs.paddingTop),
      },
      title,
      bars: [...document.querySelectorAll('.mr-tabbar')].filter(shown).length,
      bar,
      content: contentEl === null ? null : box(contentEl),
      scroller: box(need(c.scroller)),
      focus,
      row,
    };
  }, cfg);
};

const WINDOW: Box = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };

/** 'ok' when the focused row is inside its scroller's box and the window and nothing covers it. */
async function focusState(p: Page, stop: Stop, strip: string | null): Promise<string> {
  const s = await snapshot(p, stop, strip);
  if (s.focus === null) return 'none';
  const k = 0.5;
  const f = s.focus.box;
  const sc = s.scroller;
  const inside = (o: Box): boolean =>
    f.x >= o.x - k &&
    f.y >= o.y - k &&
    f.x + f.width <= o.x + o.width + k &&
    f.y + f.height <= o.y + o.height + k;
  return inside(sc) && inside(WINDOW) && s.focus.hit ? 'ok' : 'out';
}

async function expectFocusVisible(p: Page, stop: Stop, what: string): Promise<void> {
  await expect
    .poll(() => focusState(p, stop, null), {
      message: `${what}: the focused row is inside its scroller and the window`,
      timeout: 5_000,
    })
    .toBe('ok');
}

/** The frame anatomy, the TabBar, the tokens and the focused row of one stop (UIF.1, UIF.5, UIF.6). */
async function checkStop(p: Page, screen: Screen, stop: Stop, ctx: WalkCtx): Promise<void> {
  const label = stop.id;
  await expect(p.locator(stop.root).first(), `${label}: the screen is shown`).toBeVisible();
  if (stop.focus.required) {
    await expect
      .poll(() => focusState(p, stop, screen.strip), {
        message: `${label}: a focused row is inside its scroller and the window`,
        timeout: 5_000,
      })
      .toBe('ok');
    ctx.focusRequired += 1;
  }
  const s = await snapshot(p, stop, screen.strip);

  // ---- frame: 2px border in --mr-frame-border, inside the window -----------------------------
  expect(s.win, `${label}: the window is 1280x720`).toEqual([1280, 720]);
  expectInside(s.root.box, WINDOW, `${label}: the frame is inside the window`);
  expect(s.root.border, `${label}: frame border width`).toBe('2px 2px 2px 2px');
  expect(s.root.borderColor, `${label}: frame border colour`).toBe(FOUR_FG);

  // ---- title -----------------------------------------------------------------------------------
  if (stop.title !== null) {
    expect(s.title, `${label}: a title is shown`).not.toBeNull();
    const t = s.title as NonNullable<Snap['title']>;
    expect(t.text.length, `${label}: the title has text`).toBeGreaterThan(0);
    expect(
      [t.fontSize, t.fontWeight, t.color],
      `${label}: title size, weight and colour (${t.text})`,
    ).toEqual([stop.title.px, stop.title.weight, stop.title.color]);
    expectInside(t.box, s.root.box, `${label}: the title is inside the frame`);
    if (t.barBox !== null) {
      expectNear(t.barBox.height, 40, 1, `${label}: the title bar is 2.5rem tall`);
      expectInside(t.box, t.barBox, `${label}: the title is inside its bar`);
    }
    ctx.titleChecks += 1;
  } else {
    expect(s.title, `${label}: this stop has no title (as shipped)`).toBeNull();
  }

  // ---- TabBar ------------------------------------------------------------------------------------
  if (screen.strip === null) {
    expect(s.bar, `${label}: an untabbed screen`).toBeNull();
    expect(s.bars, `${label}: no tab bar shows`).toBe(0);
  } else {
    expect(s.bar, `${label}: the tab bar is shown`).not.toBeNull();
    const b = s.bar as NonNullable<Snap['bar']>;
    expect(s.bars, `${label}: exactly one tab bar shows`).toBe(1);
    expect(b.rowClass, `${label}: the row is the TabBar`).toContain('mr-tabbar');
    expect(b.keys, `${label}: the tabs, in RB order`).toEqual([...screen.tabKeys]);
    expect(b.selected, `${label}: exactly the ${stop.tab} tab is selected`).toEqual([stop.tab]);
    expectNear(b.row.height, 32, 0.5, `${label}: the bar is 2rem tall on every tab`);
    expectNear(b.strip.height, 32, 0.5, `${label}: the strip is 2rem tall`);
    b.tabs.forEach((tab, i) => {
      expectNear(tab.height, b.strip.height, 0.5, `${label}: tab ${i} is as tall as the strip`);
      expectNear(
        tab.y,
        (b.tabs[0] as Box).y,
        0.5,
        `${label}: tab ${i} shares the row (horizontal)`,
      );
      if (i > 0) {
        const prev = b.tabs[i - 1] as Box;
        expect(tab.x, `${label}: tab ${i} sits right of tab ${i - 1}`).toBeGreaterThanOrEqual(
          prev.x + prev.width - 0.5,
        );
      }
    });
    expect(b.chips, `${label}: LB chip first, RB chip last`).toEqual(['LB', 'RB']);
    expect(b.lb.width, `${label}: the LB chip has width`).toBeGreaterThan(0);
    expect(b.rb.width, `${label}: the RB chip has width`).toBeGreaterThan(0);
    const first = b.tabs[0] as Box;
    const last = b.tabs[b.tabs.length - 1] as Box;
    expect(b.lb.x + b.lb.width, `${label}: LB left of the first tab`).toBeLessThanOrEqual(
      first.x + 0.5,
    );
    expect(b.rb.x, `${label}: RB right of the last tab`).toBeGreaterThanOrEqual(
      last.x + last.width - 0.5,
    );
    // Top-anchored: directly under the title, or at the frame's content top where there is none;
    // and above the body.
    if (s.title === null) {
      expectNear(b.row.y, s.root.contentTop, 0.5, `${label}: the bar is at the content top`);
    } else {
      const gap = b.row.y - (s.title.box.y + s.title.box.height);
      expect(gap, `${label}: the bar is below the title`).toBeGreaterThanOrEqual(-0.5);
      expect(gap, `${label}: the bar hugs the title`).toBeLessThanOrEqual(24);
    }
    if (s.content !== null) {
      expect(s.content.y, `${label}: the body is below the bar`).toBeGreaterThanOrEqual(
        b.row.y + b.row.height - 0.5,
      );
    }
    // The same bar on every tab of the screen (uniform, independent of the panel).
    const first0 = ctx.bars.get(screen.key);
    if (first0 === undefined) ctx.bars.set(screen.key, b.row);
    else expectRect(b.row, first0, 0.5, `${label}: the bar rect equals the first tab's`);
    // Selected: three named cues, never the cursor's inverted fill; the rest are plain.
    expect(b.selStyle, `${label}: the selected tab is styled`).toEqual({
      'outline-width': '2px',
      'outline-style': 'solid',
      'outline-color': FG,
      'font-weight': '700',
      'background-color': PANEL_BG,
    });
    expect(b.selIsActive, `${label}: the selected tab is not the row cursor`).toBe(false);
    const rest = b.restStyle ?? {};
    expect(
      [rest['outline-style'], rest['font-weight'], rest['background-color']],
      `${label}: an unselected tab is plain (no outline, normal weight, no fill)`,
    ).toEqual(['none', '400', NO_FILL]);
    ctx.tabsSampled[screen.key] = (ctx.tabsSampled[screen.key] ?? 0) + 1;
  }
  if (stop.content !== null) {
    expect(s.content, `${label}: the body is shown`).not.toBeNull();
  }

  // ---- tokens: nav rows (14px), the focused row's inverted fill and arrow ----------------------
  if (stop.rowScope !== null) {
    const r = s.row as NonNullable<Snap['row']>;
    expect(r.count, `${label}: nav rows are on screen`).toBeGreaterThan(0);
    expect(r.fontSize, `${label}: nav row font size`).toBe('14px');
    expect(r.activeBg, `${label}: the focused row has the inverted fill`).toBe(FG);
    expect(r.activeArrow ?? '', `${label}: the focused row wears the arrow`).toContain(ARROW);
    if (s.bar?.selStyle) {
      expect(
        s.bar.selStyle['background-color'],
        `${label}: tab fill differs from row fill`,
      ).not.toBe(r.activeBg);
    }
    ctx.rowChecks += 1;
  } else {
    expect(s.row, `${label}: no nav rows on this stop`).toBeNull();
  }

  // ---- the focused row ---------------------------------------------------------------------------
  if (stop.focus.required) {
    expect(s.focus, `${label}: a focused row exists`).not.toBeNull();
    expect(
      (s.focus as NonNullable<Snap['focus']>).box.height,
      `${label}: the focused row has a box`,
    ).toBeGreaterThan(0);
  }
}

/** One screen: every tab by RB (each sampled), back to the first by LB. */
async function walkScreen(p: Page, screen: Screen, ctx: WalkCtx): Promise<void> {
  for (const [i, stop] of screen.stops.entries()) {
    if (screen.strip !== null) {
      if (i > 0) await pressButton(p, 'RB');
      await expect(
        p.locator(`${screen.strip} .is-selected`),
        `${stop.id}: RB reaches the ${stop.tab} tab`,
      ).toHaveAttribute('data-nav-tab', stop.tab as string);
    }
    await checkStop(p, screen, stop, ctx);
    if (stop.extra !== undefined) await stop.extra(p);
    await shot(p, stop.shot);
    ctx.visited.push(stop.id);
  }
  if (screen.strip !== null) {
    for (let i = screen.stops.length - 1; i > 0; i -= 1) {
      await pressButton(p, 'LB');
      await expect(
        p.locator(`${screen.strip} .is-selected`),
        `LB returns to the ${(screen.stops[i - 1] as Stop).tab} tab`,
      ).toHaveAttribute('data-nav-tab', (screen.stops[i - 1] as Stop).tab as string);
      ctx.lbSteps += 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Owner SQL seed (one stack of Power Root, so the Inventory sheet has an item).
// ---------------------------------------------------------------------------------------------

/** Seeds the Food stack once (the Inventory sheet needs an item), after which Feed is enabled. */
async function ensureFood(p: Page): Promise<void> {
  const g = await game(p);
  if (g.ownInventory.some((i) => i.itemId === FOOD_ITEM_ID && i.count > 0)) return;
  const hex = g.identity.toLowerCase().replace(/^0x/, '');
  expect(/^[0-9a-f]{64}$/.test(hex), 'the identity is 64 hex digits').toBe(true);
  ownerSql(
    `INSERT INTO inventory (inv_id, owner_identity, item_id, count) VALUES (0, 0x${hex}, ${FOOD_ITEM_ID}, ${FOOD_SEED})`,
    'seed the food stack',
  );
  await p.waitForFunction(
    (a: { id: number; n: number }) =>
      (window as unknown as Win)
        .__game()
        .ownInventory.some((i) => i.itemId === a.id && i.count === a.n),
    { id: FOOD_ITEM_ID, n: FOOD_SEED },
    { timeout: 15_000 },
  );
}

// ---------------------------------------------------------------------------------------------
// Sheets (UIF17.2).
// ---------------------------------------------------------------------------------------------

interface SheetSnap {
  border: string;
  borderColor: string;
  sheet: Box;
  frame: Box;
  centreHit: boolean;
  rows: string[];
  rowRoles: number;
}

const sheetSnap = (p: Page, frameSel: string, sheetSel: string): Promise<SheetSnap> =>
  p.evaluate(
    ({ frameSel: f, sheetSel: s }) => {
      const sheet = document.querySelector<HTMLElement>(s);
      const frame = document.querySelector<HTMLElement>(f);
      if (sheet === null || frame === null) throw new Error(`sheetSnap: no ${s} or ${f}`);
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const cs = getComputedStyle(sheet);
      const four = (suffix: string): string =>
        ['top', 'right', 'bottom', 'left']
          .map((d) => cs.getPropertyValue(`border-${d}-${suffix}`))
          .join(' ');
      const sb = sheet.getBoundingClientRect();
      const hit = document.elementFromPoint(sb.x + sb.width / 2, sb.y + sb.height / 2);
      const rows = [...sheet.querySelectorAll<HTMLElement>('.mr-nav-item')];
      return {
        border: four('width'),
        borderColor: four('color'),
        sheet: box(sheet),
        frame: box(frame),
        centreHit: hit !== null && sheet.contains(hit),
        rows: rows.map((r) => (r.textContent ?? '').trim()),
        rowRoles: sheet.querySelectorAll('[role="option"]').length,
      };
    },
    { frameSel, sheetSel },
  );

interface SheetSpec {
  readonly name: string;
  readonly open: (p: Page) => Promise<void>;
  readonly frame: string;
  readonly sheet: string;
  readonly stack: readonly string[];
  readonly last: string;
  /** The exact option list, where it is fixed (the detail sheet's lone Back). */
  readonly exact: readonly string[] | null;
  /** A target OUTSIDE the sheet whose state a click observably changes. */
  readonly target: string;
}

/** UIF.2 and UIF.3 on one sheet: bordered, inside and narrower than its frame, on top, sized by its
 *  rows with a literal last row, B closes it, and a click outside closes it AND reaches the target. */
async function exerciseSheet(p: Page, spec: SheetSpec): Promise<void> {
  const label = `${spec.name} sheet`;
  await spec.open(p);
  const s = await sheetSnap(p, spec.frame, spec.sheet);
  expect(s.border, `${label}: border width`).toBe('2px 2px 2px 2px');
  expect(s.borderColor, `${label}: border colour`).toBe(FOUR_FG);
  expectInside(s.sheet, s.frame, `${label}: the sheet is inside its frame`);
  expect(s.sheet.width, `${label}: narrower than its frame`).toBeLessThan(s.frame.width);
  expect(s.centreHit, `${label}: the top hit at its centre is the sheet`).toBe(true);
  expect(s.rows.length, `${label}: it lists its options`).toBeGreaterThan(0);
  expect(s.rowRoles, `${label}: every row is an option`).toBe(s.rows.length);
  expect(s.rows[s.rows.length - 1], `${label}: the last row`).toBe(spec.last);
  if (spec.exact !== null) expect(s.rows, `${label}: its options`).toEqual([...spec.exact]);
  else expect(s.rows.length, `${label}: more than the last row alone`).toBeGreaterThan(1);
  expect(
    s.sheet.height,
    `${label}: sized by its option count (26.4px a row)`,
  ).toBeGreaterThanOrEqual(s.rows.length * 26.4 - 1);
  await shot(p, spec.name);

  await pressButton(p, 'B');
  await expect(p.locator(spec.sheet).first(), `${label}: B closes it`).toBeHidden();
  expect(await frameNames(p), `${label}: B closes only the sheet`).toEqual([...spec.stack]);

  await pressButton(p, 'A');
  await expect(p.locator(spec.sheet).first(), `${label}: A reopens it`).toBeVisible();
  const target = await p.locator(spec.target).boundingBox();
  expect(target, `${label}: the click target is on screen`).not.toBeNull();
  const t = target as NonNullable<typeof target>;
  const cx = t.x + t.width / 2;
  const cy = t.y + t.height / 2;
  const open = await sheetSnap(p, spec.frame, spec.sheet);
  const inSheet =
    cx >= open.sheet.x &&
    cx <= open.sheet.x + open.sheet.width &&
    cy >= open.sheet.y &&
    cy <= open.sheet.y + open.sheet.height;
  expect(inSheet, `${label}: the click point is outside the sheet`).toBe(false);
  await expect(p.locator(spec.target), `${label}: the target is not yet selected`).toHaveAttribute(
    'aria-selected',
    'false',
  );
  await p.mouse.click(cx, cy);
  await expect(p.locator(spec.sheet).first(), `${label}: a click outside closes it`).toBeHidden();
  await expect(
    p.locator(spec.target),
    `${label}: and the click reached its target (UIF.3)`,
  ).toHaveAttribute('aria-selected', 'true');
  expect(await frameNames(p), `${label}: the click closed only the sheet`).toEqual([...spec.stack]);
  sheetChecks += 1;
}

// ---------------------------------------------------------------------------------------------
// Messages (UIF17.2): showing one moves no box.
// ---------------------------------------------------------------------------------------------

/** A message strip forced shown in ONE evaluate (no flow paints these on a fresh player; ui-chrome
 *  UIF4.3's probe): the strip must be visible with text, and every box keeps its rect. */
const forcedStrip = (
  p: Page,
  stripSel: string,
  boxes: readonly string[],
): Promise<{ before: Box[]; after: Box[]; visible: boolean; text: string }> =>
  p.evaluate(
    ({ stripSel: s, boxes: sels }) => {
      const strip = document.querySelector<HTMLElement>(s);
      if (strip === null) throw new Error(`forcedStrip: no ${s}`);
      const read = (): Box[] =>
        sels.map((q) => {
          const el = document.querySelector(q);
          if (el === null) throw new Error(`forcedStrip: no ${q}`);
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
      const prior = { hidden: strip.hidden, display: strip.style.display, text: strip.textContent };
      const before = read();
      try {
        strip.hidden = false;
        strip.style.display = '';
        strip.textContent = 'uif-17 message probe';
        const after = read();
        return {
          before,
          after,
          visible: strip.getClientRects().length > 0 && strip.getBoundingClientRect().height > 0,
          text: strip.textContent ?? '',
        };
      } finally {
        strip.hidden = prior.hidden;
        strip.style.display = prior.display;
        strip.textContent = prior.text;
      }
    },
    { stripSel, boxes },
  );

/** Counts of assertions actually executed (UIF17.2 pins them, so a skipped step cannot pass). */
let sheetChecks = 0;
let noShiftChecks = 0;

function expectNoShift(
  before: readonly Box[],
  after: readonly Box[],
  names: readonly string[],
  label: string,
): void {
  expect(before.length, `${label}: boxes were sampled`).toBe(names.length);
  names.forEach((n, i) => {
    expectRect(after[i] as Box, before[i] as Box, 0.5, `${label}: ${n}`);
  });
  noShiftChecks += 1;
}

// ---------------------------------------------------------------------------------------------
// Window sizes (UIF17.3), literals from ui-scale.spec.ts CASES.
// ---------------------------------------------------------------------------------------------

interface Case {
  readonly w: number;
  readonly h: number;
  readonly dpr: number;
  readonly scaleText: string;
  readonly scale: number;
  readonly rootPx: number;
  readonly deviceScale: number;
}
const BASE: Case = {
  w: 1280,
  h: 720,
  dpr: 1,
  scaleText: '1',
  scale: 1,
  rootPx: 16,
  deviceScale: 2,
};
const DPR125: Case = {
  w: 1536,
  h: 864,
  dpr: 1.25,
  scaleText: '1.2',
  scale: 1.2,
  rootPx: 19.2,
  deviceScale: 3,
};
const FULL_HD: Case = {
  w: 1920,
  h: 1080,
  dpr: 1,
  scaleText: '1.5',
  scale: 1.5,
  rootPx: 24,
  deviceScale: 3,
};

interface RootRead {
  dpr: number;
  inlineFont: string;
  rootPx: number;
  varText: string;
  stepText: string;
  stage: number | null;
}
const readRoot = (p: Page): Promise<RootRead> =>
  p.evaluate(() => {
    const root = document.documentElement;
    const g = (window as unknown as Win).__game();
    return {
      dpr: window.devicePixelRatio,
      inlineFont: root.style.fontSize,
      rootPx: Number.parseFloat(getComputedStyle(root).fontSize),
      varText: root.style.getPropertyValue('--mr-ui-scale'),
      stepText: root.style.getPropertyValue('--mr-text-step'),
      stage: g.stageScale,
    };
  });

const px = async (p: Page, selector: string, prop = 'font-size'): Promise<number> =>
  Number.parseFloat((await sampleStyle(p, selector, [prop]))[prop] as string);

/** The world holds an integer deviceScale and the chrome tracks `--mr-ui-scale` (UIF.5, UIF.7). */
async function expectScale(p: Page, c: Case, label: string): Promise<RootRead> {
  await expect
    .poll(async () => (await readRoot(p)).stage, {
      message: `${label}: stageScale reaches ${c.deviceScale / c.dpr}`,
      timeout: 10_000,
    })
    .toBeCloseTo(c.deviceScale / c.dpr, 6);
  const m = await readRoot(p);
  expect(m.inlineFont, `${label}: no inline root font size (no probe in play)`).toBe('');
  expect(m.varText, `${label}: --mr-ui-scale`).toBe(c.scaleText);
  expect(m.rootPx, `${label}: root font size`).toBeCloseTo(c.rootPx, 3);
  const device = (m.stage as number) * m.dpr;
  expect(device, `${label}: stageScale x dpr is the integer deviceScale`).toBeCloseTo(
    c.deviceScale,
    6,
  );
  expect(Number.isInteger(Math.round(device * 1e6) / 1e6), `${label}: it is an integer`).toBe(true);
  return m;
}

// ---------------------------------------------------------------------------------------------
// Hints (UIF17.4), literals from the chip catalog (chrome.chip.*) and hintBarModel.ts.
// ---------------------------------------------------------------------------------------------

type Chips = ReadonlyArray<readonly [string, string]>;
const SCREEN_CHIPS: Chips = [
  ['A', 'OK'],
  ['B', 'Back'],
  ['Start', 'Close'],
  ['Select', 'Help'],
];
// The Monsters frame in its list (both tabs) adds X, quick Move (box.sheet.move), before Close.
const MONSTERS_LIST_CHIPS: Chips = [
  ['A', 'OK'],
  ['B', 'Back'],
  ['X', 'Move'],
  ['Start', 'Close'],
  ['Select', 'Help'],
];
const WORLD_TAIL: Chips = [
  ['Start', 'Menu'],
  ['Select', 'Help'],
];

interface HintSnap {
  innerHeight: number;
  bar: Box;
  chips: Array<{ button: string; verb: string; hit: boolean }>;
  tabChips: string[];
}
const hintSnap = (p: Page): Promise<HintSnap> =>
  p.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.mr-hint-bar');
    if (bar === null) throw new Error('hintSnap: no .mr-hint-bar');
    const live = (el: Element): boolean => el.getClientRects().length > 0;
    const r = bar.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      bar: { x: r.x, y: r.y, width: r.width, height: r.height },
      chips: [...bar.querySelectorAll<HTMLElement>('.mr-chip')].filter(live).map((el) => {
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return {
          button: el.dataset.button ?? '',
          verb: el.querySelector('.mr-chip-verb')?.textContent ?? '',
          hit: hit !== null && (hit === el || el.contains(hit)),
        };
      }),
      tabChips: [...document.querySelectorAll<HTMLElement>('.mr-tabbar .mr-tabbar-chip')]
        .filter(live)
        .map((el) => el.dataset.button ?? ''),
    };
  });

/** The bar sits on the window's bottom edge, below the frame, on top at each chip, with this chip
 *  set (button order and verbs). `frame` null: no frame is open (the world). The frame loop paints
 *  the bar on the animation frame after an open, so a first read can still show the previous
 *  context's chips: wait for this exact set, let two more frames paint, then measure that settled
 *  bar (a set only seen in passing fails below). */
async function expectHint(
  p: Page,
  label: string,
  want: Chips,
  frame: string | null,
): Promise<HintSnap> {
  const wanted = want.map(([b, v]) => [b, v]);
  await expect
    .poll(async () => (await hintSnap(p)).chips.map((c) => [c.button, c.verb]), {
      message: `${label}: chip buttons and verbs`,
    })
    .toEqual(wanted);
  await p.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  const h = await hintSnap(p);
  expectNear(
    h.bar.y + h.bar.height,
    h.innerHeight,
    0.5,
    `${label}: the hint bar ends at the window bottom`,
  );
  expectNear(h.bar.x, 0, 0.5, `${label}: the hint bar starts at the left edge`);
  expectNear(h.bar.width, 1280, 0.5, `${label}: the hint bar spans the window`);
  if (frame !== null) {
    const [f] = await rectsOf(p, [frame]);
    expect(h.bar.y, `${label}: the hint bar is below the frame`).toBeGreaterThanOrEqual(
      (f as Box).y + (f as Box).height - 0.5,
    );
  }
  expect(
    h.chips.map((c) => [c.button, c.verb]),
    `${label}: chip buttons and verbs`,
  ).toEqual(wanted);
  for (const c of h.chips) expect(c.hit, `${label}: the ${c.button} chip is on top`).toBe(true);
  return h;
}

// ---------------------------------------------------------------------------------------------
// The tactical battle: a grass hunt (tactics-wild.spec.ts / encounter-battle.spec.ts shuttle).
// ---------------------------------------------------------------------------------------------

const MAX_WALK_STEPS = 120;
const STEP_WAIT_MS = 8_000;

function shuttleDir(tile: Tile): string {
  if (tile.x === 1 && tile.y === 1) return 'South';
  if (tile.x === 1 && tile.y === 2) return 'East';
  if (tile.x === 2 && tile.y === 2) return 'West';
  if (tile.y > 2) return 'North';
  if (tile.x > 2) return 'West';
  return 'South';
}

/** Walks the grass shuttle until a battle's anchor is ongoing; FAILS (never skips) otherwise. */
async function huntWild(p: Page, label: string): Promise<void> {
  await closeAll(p);
  for (let i = 0; i < MAX_WALK_STEPS; i += 1) {
    const g = await game(p);
    if (g.ongoingBattle !== null) return;
    if (g.ownAuthTile === null) throw new Error(`${label}: own tile vanished`);
    const from = g.ownAuthTile;
    await p.evaluate((d) => (window as unknown as Win).__game().step(d), shuttleDir(from));
    await p
      .waitForFunction(
        (f: Tile) => {
          const s = (window as unknown as Win).__game();
          if (s.ongoingBattle !== null) return true;
          return s.ownAuthTile !== null && (s.ownAuthTile.x !== f.x || s.ownAuthTile.y !== f.y);
        },
        from,
        { timeout: STEP_WAIT_MS },
      )
      .catch(() => undefined); // a wall bump: the next shuttle direction is re-derived
  }
  if ((await game(p)).ongoingBattle === null) {
    throw new Error(`${label}: no wild encounter within MAX_WALK_STEPS=${MAX_WALK_STEPS} steps`);
  }
}

// =============================================================================================

test.describe
  .serial('UIF17 — the integrated whole, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    let cdp: CDPSession;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page = await ctx.newPage();
      cdp = await ctx.newCDPSession(page);
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      try {
        await page.evaluate(() => window.localStorage.removeItem('mr.display'));
      } finally {
        await browser.close();
      }
    });

    /** Back to 1280x720@1 through the same CDP override (setViewportSize does not clear it). Never
     *  swallows its own failure ONLY when the body already failed (`bodyOk` false), so the body's
     *  error stays the reported one; after a passing body a failed restore throws. */
    async function restoreWindow(bodyOk: boolean): Promise<void> {
      const quiet = (): undefined => undefined;
      const restore = async (): Promise<void> => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: BASE.w,
          height: BASE.h,
          deviceScaleFactor: BASE.dpr,
          mobile: false,
        });
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), {
            message: 'the window is back at 1280x720@1',
            timeout: 10_000,
          })
          .toEqual([1280, 720, 1]);
      };
      if (bodyOk) await restore();
      else await restore().catch(quiet);
    }

    /** Change the window and wait until the page itself reports it and the var caught up (ui-scale:
     *  a dpr-only change fires no resize, and setViewportSize after an override resets dpr to 1). */
    async function setWindow(c: Case): Promise<void> {
      // MEASURED: page.setViewportSize followed by a CDP override on this separate session does not
      // take (FULL_HD -> DPR125 stayed 1920x1080@1 for 10s), so EVERY size, dpr 1 included, goes
      // through the CDP override on the one session.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: c.w,
        height: c.h,
        deviceScaleFactor: c.dpr,
        mobile: false,
      });
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), {
          message: `the window reports ${c.w}x${c.h}@${c.dpr}`,
          timeout: 10_000,
        })
        .toEqual([c.w, c.h, c.dpr]);
      await expect
        .poll(async () => Number.parseFloat((await readRoot(page)).varText), {
          message: `--mr-ui-scale reaches ${c.scale}`,
          timeout: 10_000,
        })
        .toBeCloseTo(c.scale, 6);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    }

    // -------------------------------------------------------------------------------------
    test('UIF17.1 the D-pad walk: Start, then every root leaf and every tab, each satisfies the frame anatomy, the TabBar, the tokens and a visible focused row, B returns to the menu, a last B reaches the world', async () => {
      // WRONG IMPL KILLED: a `.mr-tabbar` whose height follows its panel (32px literal, per tab and
      // identical across tabs); a tab bar that is not top-anchored, not horizontal or lacks an LB or
      // RB chip; a selected tab with fewer than three named cues, or one wearing the cursor's
      // inverted fill; a frame border that is not 2px in --mr-frame-border; a title bar that is not
      // 2.5rem; a title font that drifts from the shipped literal (m3: 21px for 20px); a nav row not
      // 14px; a focused row without the inverted fill or the arrow; a focused row left outside its
      // scroller or the window after Down to the last Encyclopedia term or Profile row; a disabled
      // row below 3:1 or not below an enabled row; a leaf that is lost from the menu (a dropped
      // MENU_ENTRIES row shortens the walk); a B that closes more than the leaf.
      test.setTimeout(420_000);
      await openMenu(page);
      const walk: WalkCtx = {
        visited: [],
        tabsSampled: {},
        bars: new Map(),
        lbSteps: 0,
        rowChecks: 0,
        focusRequired: 0,
        titleChecks: 0,
      };

      await checkStop(
        page,
        { key: 'menu', strip: null, tabKeys: [], stops: [MENU_STOP] },
        MENU_STOP,
        walk,
      );
      await shot(page, MENU_STOP.shot);
      walk.visited.push(MENU_STOP.id);

      for (const screen of SCREENS) {
        if (screen.key === 'bag') await ensureFood(page);
        const frame = FRAME_OF[screen.key] as string;
        await downTo(page, navActive, screen.key, 8, `the main menu to ${screen.key}`);
        await pressButton(page, 'A');
        await expect
          .poll(() => frameNames(page), { message: `${screen.key}: A opens ${frame}` })
          .toEqual(['world', 'menuView', frame]);
        const settled = SETTLED[screen.key];
        if (settled !== undefined) {
          await expect(page.locator(settled), `${screen.key}: the open settled`).toBeFocused();
        }
        await walkScreen(page, screen, walk);
        await pressButton(page, 'B');
        await expect
          .poll(() => frameNames(page), { message: `${screen.key}: B closes only the leaf` })
          .toEqual(['world', 'menuView']);
        await expect(
          page.locator('#menu-overlay'),
          `${screen.key}: the menu is back`,
        ).toBeVisible();
        await expect
          .poll(() => navActive(page), { message: `${screen.key}: the cursor is back on it` })
          .toBe(screen.key);
      }

      // The menu's LAST row: Down to Close keeps the cursor row inside the menu and the window.
      await downTo(page, navActive, 'close', 2, 'the main menu to Close');
      await expectFocusVisible(page, MENU_STOP, 'the menu Close row');
      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'the final B closes the menu' })
        .toEqual(['world']);

      // ANTI-VACUITY: the walk really visited these, sampled these tabs and checked these things.
      expect(walk.visited, 'the screens and tabs visited, in order').toEqual(VISITED);
      expect(walk.tabsSampled, 'tabs sampled per tabbed screen').toEqual({
        monsters: 2,
        bag: 4,
        social: 4,
        help: 2,
        controls: 3,
      });
      expect(walk.lbSteps, 'LB steps back (1 + 3 + 3 + 1 + 2)').toBe(10);
      expect(walk.focusRequired, 'stops with a required focused row').toBe(9);
      expect(walk.rowChecks, 'stops whose nav-row tokens were sampled').toBe(7);
      expect(walk.titleChecks, 'stops whose title was measured (all but Social x4)').toBe(14);
    });

    // -------------------------------------------------------------------------------------
    test('UIF17.2 mini-menus and messages: the Monsters, Inventory and Help detail sheets are bordered, on top, sized by their rows, close on B and on a click outside that reaches its target; a message on the menu, Monsters, Inventory, Controls and Profile moves no box', async () => {
      // WRONG IMPL KILLED: a sheet without the 2px border; a sheet wider than its frame or not on top;
      // a last row that is not Back or Close (m4); a sheet B does not close, or a click outside that
      // does not close it, or closes it and swallows the click (the target never selects); a message
      // strip that takes layout height (m6: a box moves); a message element that is hidden or empty;
      // a toast that is not announced through the live region.
      // EXCLUDED: Social's row sheets need another player (a lone fresh player has no row), so Social
      // is not counted here; its action sheet is proven in pvp.spec.ts and ui-social.spec.ts.
      test.setTimeout(300_000);
      await ensureFood(page);

      sheetChecks = 0;
      const specs: readonly SheetSpec[] = [
        {
          name: 'monsters',
          open: async (p) => {
            await openScreen(p, 'monsters');
            await pressButton(p, 'A');
            await expect(
              p.locator(`${MONSTERS_ROOT} ${SHEET}`).first(),
              'A on the starter opens its sheet',
            ).toBeVisible();
          },
          frame: MONSTERS_ROOT,
          sheet: `${MONSTERS_ROOT} ${SHEET}`,
          stack: ['world', 'menuView', 'boxView'],
          last: 'Close',
          exact: null,
          target: '#monsters-tab-storage',
        },
        {
          name: 'inventory',
          open: async (p) => {
            await openScreen(p, 'bag');
            await pressButton(p, 'RB');
            await expect(p.locator('#bag-tab-food'), 'RB reaches Food').toHaveAttribute(
              'aria-selected',
              'true',
            );
            await pressButton(p, 'A');
            await expect(
              p.locator(`${BAG_ROOT} ${SHEET}`).first(),
              'A on the item opens its sheet',
            ).toBeVisible();
          },
          frame: BAG_ROOT,
          sheet: `${BAG_ROOT} ${SHEET}`,
          stack: ['world', 'menuView', 'raisingView'],
          last: 'Close',
          exact: null,
          target: '#bag-tab-bait',
        },
        {
          name: 'help-detail',
          open: async (p) => {
            await openScreen(p, 'help');
            await pressButton(p, 'RB');
            await expect(p.locator('#help-tab-encyclopedia'), 'RB reaches it').toHaveAttribute(
              'aria-selected',
              'true',
            );
            await pressButton(p, 'A');
            await expect(
              p.locator('#help-overlay [data-context-sheet]').first(),
              'A on a term opens its detail',
            ).toBeVisible();
          },
          frame: '#help-overlay',
          sheet: '#help-overlay [data-context-sheet]:not([hidden])',
          stack: ['world', 'menuView', 'helpView'],
          last: 'Back',
          exact: ['Back'],
          target: '#help-tab-intro',
        },
      ];
      for (const spec of specs) {
        await exerciseSheet(page, spec);
      }
      expect(sheetChecks, 'sheets taken through every sheet assertion').toBe(3);

      // ---- messages: a visible, non-empty message moves no box of its frame ---------------------
      noShiftChecks = 0;

      await openMenu(page);
      const menuBoxes = ['#menu-overlay .mr-frame', '#menu-rows'] as const;
      const menuBefore = await rectsOf(page, menuBoxes);
      await pressButton(page, 'Y'); // the real flow: Y paints the row's description on the strip
      const menuStrip = page.locator('#menu-overlay .mr-frame-feedback');
      await expect(menuStrip, 'menu: Y shows the description strip').toBeVisible();
      await expect(menuStrip, 'menu: with text').toHaveText(/\S/);
      expectNoShift(menuBefore, await rectsOf(page, menuBoxes), menuBoxes, 'menu message');

      for (const m of [
        {
          name: 'monsters',
          key: 'monsters',
          boxes: [MONSTERS_ROOT, '#monsters-tabs', '#monsters-panel'],
          strip: `${MONSTERS_ROOT} .mr-frame-feedback`,
        },
        {
          name: 'inventory',
          key: 'bag',
          boxes: [BAG_ROOT, '#bag-tabs', '#bag-panel'],
          strip: '#bag-status',
        },
      ] as const) {
        await openScreen(page, m.key);
        const r = await forcedStrip(page, m.strip, m.boxes);
        expect(r.visible, `${m.name}: the strip is visible once it carries a message`).toBe(true);
        expect(r.text.length, `${m.name}: its text is not empty`).toBeGreaterThan(0);
        expectNoShift(r.before, r.after, m.boxes, `${m.name} message`);
      }

      // Controls: the refused-key hint on the frame's own strip (ui-feedback UIF4B.2). Nothing is
      // bound: the protected refusal changes no key, and Cancel ends the capture.
      await openScreen(page, 'controls');
      const controlsBoxes = ['#controls-overlay', '#controls-tabs', '#controls-rows'] as const;
      const controlsActive = (p: Page): Promise<string | null> =>
        p.evaluate(
          () =>
            document
              .querySelector('#controls-rows [aria-selected="true"]')
              ?.getAttribute('data-nav-key') ?? null,
        );
      await downTo(page, controlsActive, 'X_0', 13, 'the Controls grid');
      await pressButton(page, 'Right');
      await expect.poll(() => controlsActive(page), { message: 'Right onto X_1' }).toBe('X_1');
      await pressButton(page, 'A');
      await expect(page.locator('#controls-capture'), 'a capture waits').toBeVisible();
      await expect(page.locator('#controls-feedback'), 'the strip starts empty').toBeHidden();
      const controlsBefore = await rectsOf(page, controlsBoxes);
      await page.keyboard.press('Backspace'); // PROTECTED: Back must keep a key, so it is refused
      const hint = page.locator('#controls-feedback');
      await expect(hint, 'controls: the hint shows').toBeVisible();
      await expect(hint, 'controls: with text').toHaveText(/\S/);
      expectNoShift(
        controlsBefore,
        await rectsOf(page, controlsBoxes),
        controlsBoxes,
        'controls hint',
      );
      await page.locator('#controls-cancel-btn').click();
      await expect(page.locator('#controls-capture'), 'Cancel ends the capture').toBeHidden();
      await expect(page.locator('#toast'), 'Cancel toasts controls.cancelled').toHaveText(
        'Unchanged.',
      );

      // Profile: a valid rename's success toast (ui-feedback UIF4B.2), announced by the live region.
      await openScreen(page, 'profile');
      const profileBoxes = [
        '#profile-overlay',
        '#rename-current',
        '#rename-input',
        '#rename-submit',
      ] as const;
      await expect(page.locator('#rename-input')).toBeFocused();
      await page.fill('#rename-input', `UWhole${String(Date.now() % 100_000)}`);
      await expect(page.locator('#rename-submit'), 'a valid draft enables save').toBeEnabled();
      const profileBefore = await rectsOf(page, profileBoxes);
      await page.keyboard.press('Enter');
      const toast = page.locator('#toast');
      await expect(toast, 'profile: the success toast shows').toBeVisible({ timeout: 15_000 });
      // The Controls Cancel toast ('Unchanged.', controls.cancelled) may still stand: wait for the
      // rename success line (catalog chrome.rename.updated) before measuring and reading it.
      await expect(toast, 'profile: the rename success text').toHaveText('Name updated!', {
        timeout: 15_000,
      });
      const toastText = ((await toast.textContent()) ?? '').trim();
      expectNoShift(
        profileBefore,
        await rectsOf(page, profileBoxes),
        profileBoxes,
        'profile toast',
      );
      await expect
        .poll(() => page.evaluate(() => document.getElementById('a11y-live')?.textContent ?? ''), {
          message: 'profile: the toast text was written into the live region',
          timeout: 5_000,
        })
        .toContain(toastText);

      expect(
        noShiftChecks,
        'messages whose frame boxes were compared (menu, 2 strips, 2 more)',
      ).toBe(5);
      await closeAll(page);
    });

    // -------------------------------------------------------------------------------------
    test('UIF17.3 menu: across 1280x720@1, 1536x864@1.25 and 1920x1080@1 the open menu holds an integer deviceScale and its chrome tracks --mr-ui-scale; a text-size step multiplies the chrome only', async () => {
      // WRONG IMPL KILLED: a resize handler that does not write --mr-ui-scale (m5) or writes it late;
      // a stage scale that is not an integer deviceScale / dpr; a root font that is not 16px x scale;
      // a chip, a tab bar or a title that keeps a px literal (does not track the scale); a text
      // step that also scales the world (stageScale moves) or does not reach the chrome.
      test.setTimeout(240_000);
      const cases = [BASE, DPR125, FULL_HD] as const;
      let ok = false;
      try {
        await openMenu(page);
        for (const c of cases) {
          const label = `menu ${c.w}x${c.h}@${c.dpr}`;
          await setWindow(c);
          await expect(
            page.locator('#menu-overlay .mr-frame-title'),
            `${label}: title`,
          ).toBeVisible();
          await expectScale(page, c, label);
          expectNear(
            await px(page, '#menu-overlay .mr-frame-title'),
            20 * c.scale,
            0.05,
            `${label}: title`,
          );
          expectNear(await px(page, '#hint-bar .mr-chip'), 12 * c.scale, 0.05, `${label}: chip`);
        }
        // Social at the same three sizes (descending, so the walk ends at 1280x720).
        await setWindow(FULL_HD);
        await downTo(page, navActive, 'social', 8, 'the main menu to Social');
        await pressButton(page, 'A');
        await expect
          .poll(() => stackNames(page), { message: 'A opens Social' })
          .toEqual(['world', 'menuView', 'social']);
        for (const c of [FULL_HD, DPR125, BASE]) {
          const label = `social ${c.w}x${c.h}@${c.dpr}`;
          await setWindow(c);
          await expect(page.locator('.mr-tabbar:visible'), `${label}: one tab bar`).toHaveCount(1);
          await expectScale(page, c, label);
          expectNear(
            await px(page, '#social-tabs', 'height'),
            32 * c.scale,
            0.5,
            `${label}: tab strip`,
          );
          expectNear(
            await px(page, '#social-tab-players'),
            14 * c.scale,
            0.05,
            `${label}: tab font`,
          );
        }

        // The text step: Controls > Display > Large by the shipped D-pad path. It multiplies the chrome
        // (x1.5) and leaves the world's integer scale and `--mr-ui-scale` alone.
        const before = await readRoot(page);
        await pressButton(page, 'B');
        await expect
          .poll(() => stackNames(page), { message: 'B returns to the menu' })
          .toEqual(['world', 'menuView']);
        await downTo(page, navActive, 'controls', 8, 'the main menu to Controls');
        await pressButton(page, 'A');
        await expect(page.locator('#controls-overlay'), 'Controls is shown').toBeVisible();
        await pressButton(page, 'RB');
        await pressButton(page, 'RB');
        await expect(
          page.locator('#controls-tab-display'),
          'RB RB reaches Display',
        ).toHaveAttribute('aria-selected', 'true');
        const rowActive = (p: Page): Promise<string | null> =>
          p.evaluate(
            () =>
              document
                .querySelector('#controls-rows [aria-selected="true"]')
                ?.getAttribute('data-nav-key') ?? null,
          );
        await downTo(page, rowActive, 'large', 2, 'the Display rows');
        await pressButton(page, 'A');
        await expect
          .poll(async () => (await readRoot(page)).rootPx, {
            message: 'Large multiplies the root font size by 1.5',
            timeout: 10_000,
          })
          .toBeCloseTo(24, 3);
        const large = await readRoot(page);
        expect(Number.parseFloat(large.stepText), 'the step var is 1.5').toBeCloseTo(1.5, 6);
        expect(large.varText, '--mr-ui-scale is untouched by the step').toBe(before.varText);
        expect(large.stage, 'the world stage scale is untouched by the step').toBe(before.stage);
        expect(large.dpr * (large.stage as number), 'and is still the integer 2').toBeCloseTo(2, 6);
        expectNear(await px(page, '#hint-bar .mr-chip'), 12 * 1.5, 0.05, 'the chrome grew x1.5');
        await pressButton(page, 'Up'); // Large -> Normal (downTo only walks Down)
        await expect
          .poll(() => rowActive(page), { message: 'Up moves the cursor onto Normal' })
          .toBe('normal');
        await pressButton(page, 'A');
        await expect
          .poll(async () => (await readRoot(page)).rootPx, {
            message: 'Normal restores the 16px root',
            timeout: 10_000,
          })
          .toBeCloseTo(16, 3);
        ok = true;
      } finally {
        // The finally may only add errors when the body passed: on the failure path every cleanup
        // step is best-effort, so the body's own error is the one reported.
        const cleanup = async (): Promise<void> => {
          await page.evaluate(() => {
            window.localStorage.removeItem('mr.display');
            document.documentElement.style.removeProperty('--mr-text-step');
          });
          if (!ok) {
            // The app's in-memory text step may still be Large: only a reload makes it fresh.
            await page.reload();
            await ready(page);
          }
        };
        if (ok) await cleanup();
        else await cleanup().catch(() => undefined);
        await restoreWindow(ok);
        if (ok) await closeAll(page);
        else await closeAll(page).catch(() => undefined);
      }
    });

    // -------------------------------------------------------------------------------------
    test('UIF17.3 tactical battle: in a live tactical battle the same three sizes hold an integer deviceScale and the battle chrome tracks --mr-ui-scale, then Flee returns to the world', async () => {
      // WRONG IMPL KILLED: a battle root whose chrome keeps a px literal (does not follow the scale);
      // a tactical board that is lost or hidden by a resize; a resize that does not reach the world's
      // stage scale or --mr-ui-scale while a battle is up (m5); a hint bar that leaves the window
      // bottom or loses the tactical chip set (LB / RB / X) during the battle. The hunt FAILS, never
      // skips, when no battle starts within MAX_WALK_STEPS.
      test.setTimeout(420_000);
      await huntWild(page, 'UIF17.3 battle');
      const t = await awaitTacticalActive(page, 'UIF17.3 battle');
      expect(t.phase, 'the battle is Active').toBe('Active');
      await expect(
        page.locator(`${TACTICS.shell} .tactics-board`).first(),
        'the tactical board is shown',
      ).toBeVisible();
      let ok = false;
      try {
        for (const c of [BASE, DPR125, FULL_HD, BASE]) {
          const label = `battle ${c.w}x${c.h}@${c.dpr}`;
          await setWindow(c);
          await expect(
            page.locator(`${TACTICS.shell} .tactics-board`).first(),
            `${label}: the board stays`,
          ).toBeVisible();
          await expectScale(page, c, label);
          expectNear(
            await px(page, TACTICS.shell),
            14 * c.scale,
            0.05,
            `${label}: battle chrome font`,
          );
          const h = await hintSnap(page);
          expectNear(
            h.bar.y + h.bar.height,
            h.innerHeight,
            0.5,
            `${label}: hint bar on the bottom`,
          );
          expect(
            h.chips.map((chip) => chip.button),
            `${label}: the tactical chip set`,
          ).toEqual(['A', 'B', 'X', 'LB', 'RB', 'Start', 'Select']);
          const verb = (b: string): string => h.chips.find((chip) => chip.button === b)?.verb ?? '';
          expect(
            [verb('A'), verb('X'), verb('LB'), verb('RB'), verb('Select')],
            `${label}: the tactical verbs`,
          ).toEqual(['OK', 'Danger', 'Previous unit', 'Next unit', 'Help']);
          expect(['Back', 'Undo'], `${label}: B's verb`).toContain(verb('B'));
          expect(['End turn', 'Guard', 'Submit'], `${label}: Start's verb`).toContain(
            verb('Start'),
          );
        }
        ok = true;
      } finally {
        await restoreWindow(ok);
      }
      await shot(page, 'tactics-board');
      const live: TacticsSnap | null = await readTactics(page);
      expect(live?.phase, 'the battle is still Active before Flee').toBe('Active');
      await fleeByButtons(page);
      await throughResults(page, 'UIF17.3 battle');
      expect(await stackNames(page), 'Flee returns to the bare world').toEqual(['world']);
    });

    // -------------------------------------------------------------------------------------
    test('UIF17.4 the hint bar stays at the bottom of the window on the world, the menu root and every screen of the walk, on top, with data-button chips whose buttons and verbs are the shipped literals', async () => {
      // WRONG IMPL KILLED: a hint bar moved off the window bottom or under a frame (m2); a chip that is
      // covered by a frame; a chip without data-button; a chip set or verb that drifts from the
      // catalog literal (a dropped or reordered chip, hintBar generation broken); a tabbed screen
      // that loses its LB / RB tab chips. The tactical LB / RB / X hint chips are proven in the
      // UIF17.3 tactical battle test (hintBarModel puts them in the battle context only).
      test.setTimeout(300_000);
      await closeAll(page);
      const world = await hintSnap(page);
      expectNear(
        world.bar.y + world.bar.height,
        world.innerHeight,
        0.5,
        'world: the hint bar is on the window bottom',
      );
      // The world's head chips depend on what the character faces (A) or a waiting notice (Y, B), so
      // only the head's buttons are bounded; the tail is the fixed Menu / Help pair.
      const buttons = world.chips.map((c) => c.button);
      expect(buttons.slice(-2), 'world: the Start and Select chips close the bar').toEqual([
        'Start',
        'Select',
      ]);
      for (const b of buttons.slice(0, -2)) {
        expect(['A', 'Y', 'B'], `world: head chip ${b}`).toContain(b);
      }
      expect(
        world.chips.slice(-2).map((c) => [c.button, c.verb]),
        'world: Start is Menu, Select is Help',
      ).toEqual(WORLD_TAIL.map(([b, v]) => [b, v]));
      for (const c of world.chips)
        expect(c.hit, `world: the ${c.button} chip is on top`).toBe(true);

      await openMenu(page);
      await expectHint(page, 'menu root', SCREEN_CHIPS, '#menu-overlay');
      await shot(page, 'hint-menu');

      const tabbedChecked: string[] = [];
      let screens = 0;
      for (const screen of SCREENS) {
        await downTo(page, navActive, screen.key, 8, `the main menu to ${screen.key}`);
        await pressButton(page, 'A');
        const frame = FRAME_OF[screen.key] as string;
        await expect
          .poll(() => frameNames(page), { message: `${screen.key}: A opens ${frame}` })
          .toEqual(['world', 'menuView', frame]);
        const settled = SETTLED[screen.key];
        if (settled !== undefined) {
          await expect(page.locator(settled), `${screen.key}: the open settled`).toBeFocused();
        }
        if (screen.key === 'profile') {
          // Focus opens in the name field, which owns Backspace (B): leave it by the D-pad first.
          await leaveNameField(page);
        }
        for (const [i, stop] of screen.stops.entries()) {
          if (screen.strip !== null && i > 0) {
            await pressButton(page, 'RB');
            await expect(page.locator(`${screen.strip} .is-selected`)).toHaveAttribute(
              'data-nav-tab',
              stop.tab as string,
            );
          }
          // Every screen's chip set is the same literal (Profile left its name field above),
          // except the Monsters list, where X is quick Move.
          const want = screen.key === 'monsters' ? MONSTERS_LIST_CHIPS : SCREEN_CHIPS;
          const h = await expectHint(page, stop.id, want, stop.root);
          if (screen.strip !== null) {
            expect(
              h.tabChips,
              `${stop.id}: the tab bar's LB and RB chips carry data-button`,
            ).toEqual(['LB', 'RB']);
            tabbedChecked.push(stop.id);
          }
          screens += 1;
        }
        await pressButton(page, 'B');
        await expect
          .poll(() => frameNames(page), { message: `${screen.key}: B returns to the menu` })
          .toEqual(['world', 'menuView']);
      }
      expect(screens, 'screens and tabs whose hint bar was measured').toBe(17);
      expect(tabbedChecked, 'tabbed stops whose LB / RB chips were measured').toHaveLength(15);

      await expectHint(page, 'menu root again', SCREEN_CHIPS, '#menu-overlay');
      await closeAll(page);
      const back = await hintSnap(page);
      expect(
        back.chips.slice(-2).map((c) => c.button),
        'back at the world',
      ).toEqual(['Start', 'Select']);
    });
  });
