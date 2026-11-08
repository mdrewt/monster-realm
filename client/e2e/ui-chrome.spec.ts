import { execFileSync } from 'node:child_process';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { navItemId } from '../src/ui/navRender';
import { closeAll, pressAccel, pressButton } from './controls';
import {
  countMatching,
  expectNear,
  expectRect,
  expectSample,
  measuredContrast,
  mediaMatches,
  resolveLength,
  resolveToken,
  sampleProbe,
  sampleRect,
  sampleStyle,
  sampleWithState,
  withRootFontSize,
} from './uiKit';

// ui-chrome.spec.ts — uif-1 (M-ui-foundation): the token set and the token-driven chrome, measured
// in Chromium at 1280x720 (UIF1.1 to UIF1.5; UIF1.6 is the unit suites staying green).
//
// ORACLE RULE. Every expected value below is a LITERAL transcribed from wf-1's token table
// (specs/monster-realm-v2/M-ui-foundation-wireframes.md, "Token table (WF1.5)": colours and the
// `prefers-contrast: more` tier, spacing, type, geometry at 1280x720), written as the computed value
// Chromium reports (`14px`, `rgb(224, 224, 224)`, `700` for bold). Nothing is read back from the
// stylesheet or from a token: an oracle that reads the token it checks cannot disagree with it.
// Test titles start with the gate id so `-g "UIF1.3"` selects them.
//
// NON-VACUITY. Every test proves its subject is on screen before it samples (the element is visible,
// a `matchMedia` precondition holds, a count is above zero), and each probe or override is undone in
// a `finally`, inside one evaluate (uiKit.ts), so a red assertion never leaks into the next test.
//
// WHAT IS A CHARACTERIZATION AT MASTER. The shipped px values already equal the tokens' px at a 16px
// root (the nav row padding, the hint bar, the chip, the status line, the titlebar padding and gap,
// the disabled row's `#8a8a9a`, the geometry of UIF1.5), so those samples read green before the
// tokens land and exist to keep the migration honest. What reds today is what the slice changes: the
// title's size and the title bar's height (type scale), every rem-reach value (a literal px does not
// double), the focus ring, the whole `more` tier, the read-only row's muted colour and the section
// header.
//
// SORT ORDER AND SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db). This
// file sorts after `trade-*` and before `ui-scale` / `wallet-*`. It joins exactly ONE player in ONE
// browser context, closed in afterAll, so the server's on_disconnect deletes the `player` row and no
// later spec sees an extra presence (golden.spec.ts sorts before this file and asserts an exact
// presenceCount === 2; adding a second context here would break the one-player rule and must not be
// done without renaming). The two `profile` rows the Rankings cases need are seeded by owner SQL in
// beforeAll and DELETED in afterAll. No encounter, no battle, no RNG, no fixed sleep: every wait polls
// a DOM or `__game()` predicate with a bound.

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Array<{ kind: string; id?: string }>;
}

const VIEWPORT = { width: 1280, height: 720 } as const;

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
const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (
      window as unknown as { __game: () => { stack: { kind: string; id?: string }[] } }
    ).__game();
    return g.stack.map(
      (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
    );
  });

const identityOf = (p: Page): Promise<string> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().identity);

const normId = (id: string): string => id.toLowerCase().replace(/^0x/, '');

// ---------------------------------------------------------------------------------------------
// Seeding: the public `profile` table (identity, name, rating, wins, losses; the generated
// module_bindings/profile_table.ts column order). A fresh world has no profile rows, and the
// Rankings list (a REAL read-only list) paints only with rows. Owner SQL, the menu-flow.spec.ts
// `ownerSql` precedent, with its own charset because a name needs quotes: letters, digits, space,
// `_ * = ( ) , '` and nothing else, and every value is validated BEFORE it is interpolated. Run
// WITHOUT a shell (execFileSync), so no metacharacter can reach one.
// ---------------------------------------------------------------------------------------------

function ownerSql(query: string, label: string): string {
  const server = process.env.STDB_SERVER ?? 'local';
  const db = process.env.VITE_STDB_DB ?? 'monster-realm';
  if (!/^[A-Za-z0-9:/._-]+$/.test(server) || !/^[A-Za-z0-9_-]+$/.test(db)) {
    throw new Error(`${label}: STDB_SERVER/VITE_STDB_DB failed charset validation`);
  }
  if (!/^[A-Za-z0-9_ *=(),']+$/.test(query)) {
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

interface ProfileSeed {
  readonly hex: string;
  readonly name: string;
  readonly rating: number;
  readonly wins: number;
  readonly losses: number;
}

function seedProfile(row: ProfileSeed): void {
  const { hex, name, rating, wins, losses } = row;
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`seedProfile: not a 64-digit hex identity: ${hex}`);
  if (!/^[A-Za-z0-9]{1,16}$/.test(name)) throw new Error(`seedProfile: unsafe name: ${name}`);
  for (const n of [rating, wins, losses]) {
    if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647) {
      throw new Error(`seedProfile: not a small non-negative integer: ${n}`);
    }
  }
  ownerSql(
    `INSERT INTO profile (identity, name, rating, wins, losses) VALUES (0x${hex}, '${name}', ${rating}, ${wins}, ${losses})`,
    `seed the ${name} profile`,
  );
}

function deleteProfile(hex: string): void {
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`deleteProfile: not a 64-digit hex identity: ${hex}`);
  ownerSql(
    `DELETE FROM profile WHERE identity = 0x${hex}`,
    `delete the profile ${hex.slice(0, 8)}`,
  );
}

/** A made-up identity (64 hex digits) for the one OTHER ranked player; nobody connects as it. */
const RIVAL_HEX = 'ab'.repeat(32);
const RIVAL_NAME = 'UifRival';
const SELF_NAME = 'UifSelf';
// i32 ratings far above anything a real ranked match produces, so these two are always the top two
// rows of the board: row 0 (the cursor) is the rival, row 1 (a non-cursor row) is the own player.
const RIVAL_RATING = 2_000_000_000;
const SELF_RATING = 1_999_999_999;

// ---------------------------------------------------------------------------------------------
// Opening the screens, by the buttons a player presses.
// ---------------------------------------------------------------------------------------------

async function openMenu(p: Page): Promise<void> {
  await closeAll(p);
  await pressButton(p, 'Start');
  await expect
    .poll(() => stackNames(p), { message: 'Start opens the menu' })
    .toEqual(['world', 'menuView']);
  await expect(p.locator('#menu-overlay'), 'the menu is shown').toBeVisible();
  await expect(p.locator('#menu-overlay .mr-frame-title'), 'with its title').toBeVisible();
  await seatMenuCursorOnMonsters(p);
}

/** The root list in display order (menuModel.ts MENU_ENTRIES). */
const MENU_ROOT_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'];

/** The `data-nav-key` of the menu's active row and the id of that row, or null when none. */
const menuActiveRow = (p: Page): Promise<{ key: string; id: string } | null> =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#menu-rows .mr-nav-item.is-active');
    return el === null ? null : { key: el.dataset.navKey ?? '', id: el.id };
  });

/**
 * The menu remembers each level's cursor for the whole session (mainMenuScreen.ts NavMemory), so a
 * reopened menu lands on the LAST entry used, and an earlier test that opened Social leaves it on
 * the Social row (A there enters the sub-list instead of pushing a screen). Seat the cursor on
 * Monsters before any caller presses A: leave a sub-list with B, then Up one row at a time, each
 * landing asserted, bounded by the root list's length.
 */
async function seatMenuCursorOnMonsters(p: Page): Promise<void> {
  let active = await menuActiveRow(p);
  expect(active, 'the menu has an active row').not.toBeNull();
  // A sub-list's rows carry its own frame id (`menuSocial-root-trades`), not `menu-root-`.
  if (active !== null && !active.id.startsWith('menu-root-')) {
    await pressButton(p, 'B');
    await expect
      .poll(async () => (await menuActiveRow(p))?.id.startsWith('menu-root-') ?? false, {
        message: 'B leaves the sub-list for the root list',
      })
      .toBe(true);
    active = await menuActiveRow(p);
  }
  for (let presses = 0; presses < MENU_ROOT_KEYS.length; presses += 1) {
    const index = MENU_ROOT_KEYS.indexOf(active?.key ?? '');
    expect(index, `the active row ${active?.key} is a root entry`).toBeGreaterThanOrEqual(0);
    if (index === 0) break;
    const want = MENU_ROOT_KEYS[index - 1] as string;
    await pressButton(p, 'Up');
    await expect
      .poll(async () => (await menuActiveRow(p))?.key, {
        message: `Up moves the cursor from ${active?.key} to ${want}`,
      })
      .toBe(want);
    active = await menuActiveRow(p);
  }
  expect(active?.key, 'the menu cursor is seated on Monsters').toBe('monsters');
  await expect(p.locator(`#${navItemId('menu', null, 'monsters')}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** Social, by its accelerator (P: Challenges), as client/e2e/pvp.spec.ts opens it. */
async function openSocial(p: Page): Promise<void> {
  await closeAll(p);
  await pressAccel(p, 'P');
  await expect
    .poll(() => stackNames(p), { message: 'P opens Social above the menu' })
    .toEqual(['world', 'menuView', 'social']);
  await expect(p.locator('#pvp-challenge-overlay'), 'Social is shown').toBeVisible();
  await expect(p.locator('#social-tab-challenges')).toHaveAttribute('aria-selected', 'true');
}

/** Social on Rankings: RB from Challenges, bounded by the four tabs, never a blind count. */
async function openRankings(p: Page): Promise<void> {
  await openSocial(p);
  const rankings = p.locator('#social-tab-rankings');
  for (let presses = 0; presses < 4; presses += 1) {
    if ((await rankings.getAttribute('aria-selected')) === 'true') break;
    await pressButton(p, 'RB');
  }
  await expect(rankings, 'RB reached the Rankings tab').toHaveAttribute('aria-selected', 'true');
  await expect(
    p.locator('#leaderboard-list[aria-readonly="true"]'),
    'the Rankings list is the read-only list',
  ).toBeVisible();
  await expect
    .poll(() => countMatching(p, '#leaderboard-list > .mr-nav-item'), {
      message: 'the two seeded profile rows reach the board',
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(2);
}

/** Start, A (Monsters), A (the monster's sheet, the cursor on Summary), as menu-flow.spec.ts. */
async function openMonsterSheet(p: Page): Promise<void> {
  await openMenu(p);
  await pressButton(p, 'A');
  await expect
    .poll(() => stackNames(p), { message: 'A on Monsters pushes Monsters' })
    .toEqual(['world', 'menuView', 'boxView']);
  await pressButton(p, 'A');
  await expect(p.locator('#monsters-sheet-name'), 'the monster sheet is open').toBeVisible();
  await expect(p.locator(`#${navItemId('monstersSheet', null, 'summary')}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** A selector for the menu's non-cursor, non-disabled rows: the actionable row at rest. */
const MENU_ROW = '#menu-overlay .mr-nav-item:not(.is-active):not(.is-disabled)';

// ---------------------------------------------------------------------------------------------
// The wf-1 values, as literals (computed-style strings at a 16px root, 1280x720).
// ---------------------------------------------------------------------------------------------

const FG = 'rgb(224, 224, 224)'; // --mr-frame-fg #e0e0e0
const MUTED = 'rgb(180, 180, 194)'; // --mr-text-muted #b4b4c2
const DISABLED = 'rgb(138, 138, 154)'; // --mr-text-disabled #8a8a9a
const FOCUS = 'rgb(255, 216, 102)'; // --mr-focus #ffd866
const FOCUS_MORE = 'rgb(255, 224, 138)'; // --mr-focus, more: #ffe08a

/** Every colour token, default tier then the `prefers-contrast: more` tier. */
const TOKEN_DEFAULT: Readonly<Record<string, string>> = {
  '--mr-frame-bg': 'rgb(30, 30, 46)', // #1e1e2e
  '--mr-panel-bg': 'rgb(24, 24, 38)', // #181826
  '--mr-frame-fg': 'rgb(224, 224, 224)', // #e0e0e0
  '--mr-frame-border': 'rgb(224, 224, 224)', // #e0e0e0
  '--mr-separator': 'rgb(107, 107, 130)', // #6b6b82
  '--mr-text-muted': 'rgb(180, 180, 194)', // #b4b4c2
  '--mr-text-disabled': 'rgb(138, 138, 154)', // #8a8a9a
  '--mr-state-ok': 'rgb(52, 211, 153)', // #34d399
  '--mr-state-warn': 'rgb(245, 158, 11)', // #f59e0b
  '--mr-state-error': 'rgb(248, 113, 113)', // #f87171
  '--mr-focus': 'rgb(255, 216, 102)', // #ffd866
};
const TOKEN_MORE: Readonly<Record<string, string>> = {
  '--mr-frame-bg': 'rgb(16, 16, 24)', // #101018
  '--mr-panel-bg': 'rgb(0, 0, 0)', // #000000
  '--mr-frame-fg': 'rgb(255, 255, 255)', // #ffffff
  '--mr-frame-border': 'rgb(255, 255, 255)', // #ffffff
  '--mr-separator': 'rgb(187, 187, 187)', // #bbbbbb
  '--mr-text-muted': 'rgb(221, 221, 221)', // #dddddd
  '--mr-text-disabled': 'rgb(170, 170, 170)', // #aaaaaa
  '--mr-state-ok': 'rgb(110, 231, 183)', // #6ee7b7
  '--mr-state-warn': 'rgb(252, 211, 77)', // #fcd34d
  '--mr-state-error': 'rgb(252, 165, 165)', // #fca5a5
  '--mr-focus': 'rgb(255, 224, 138)', // #ffe08a
};
const TOKEN_NAMES = Object.keys(TOKEN_DEFAULT);

/** The row, chip and status values every menu screen shares (UIF1.1), at a 16px root. */
const CHIP_AT_16 = {
  padding: '2px 8px 2px 8px',
  'border-width': '1px 1px 1px 1px',
  'font-size': '12px',
  color: FG,
};
const STATUS_AT_16 = {
  padding: '1px 6px 1px 6px',
  'font-size': '12px',
  color: FG,
  left: '8px',
  bottom: '36px',
};
const HINT_BAR_AT_16 = { padding: '4px 8px 4px 8px', gap: '8px 8px' };

const STATUS_PROBE_TEXT = 'uif-1 status probe';

/** One colour on all four sides, as `sampleStyle('border-color')` joins them (top right bottom left). */
const fourSides = (c: string): string => [c, c, c, c].join(' ');

test.describe
  .serial('UIF1 — the token set and the token-driven chrome, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    /** Hex identities whose `profile` row this file seeded, deleted in afterAll. */
    const seeded: string[] = [];

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
      const own = normId(await identityOf(page));
      expect(/^[0-9a-f]{64}$/.test(own), 'the identity is 64 hex digits').toBe(true);
      seedProfile({ hex: RIVAL_HEX, name: RIVAL_NAME, rating: RIVAL_RATING, wins: 9, losses: 1 });
      seeded.push(RIVAL_HEX);
      seedProfile({ hex: own, name: SELF_NAME, rating: SELF_RATING, wins: 3, losses: 2 });
      seeded.push(own);
    });

    test.afterAll(async () => {
      try {
        await browser.close();
      } finally {
        for (const hex of seeded) deleteProfile(hex);
      }
    });

    test('UIF1.1 main menu: the title bar, a nav row, the hint bar, a chip and the status line compute the wf-1 token values', async () => {
      await openMenu(page);

      // ---- title bar: padding 4px 8px, gap 8px, border-bottom 2px, height 40px (2.5rem) -------
      const bar = '#menu-overlay .mr-frame-titlebar';
      expect(await countMatching(page, bar), 'the menu frame has its title bar').toBeGreaterThan(0);
      expectSample(
        await sampleStyle(page, bar, [
          'padding',
          'gap',
          'border-bottom-width',
          'border-bottom-style',
        ]),
        {
          padding: '4px 8px 4px 8px',
          gap: '8px 8px',
          'border-bottom-width': '2px',
          'border-bottom-style': 'solid',
        },
        'title bar',
      );
      expectNear((await sampleRect(page, bar)).height, 40, 1, 'title bar height');

      // ---- title: 20px bold, line-height 28px (1.4) ------------------------------------------
      expectSample(
        await sampleStyle(page, '#menu-overlay .mr-frame-title', [
          'font-size',
          'font-weight',
          'line-height',
        ]),
        { 'font-size': '20px', 'font-weight': '700', 'line-height': '28px' },
        'title',
      );

      // ---- a NON-active nav row: padding 2px 8px 2px 20px, 14px, frame-fg, 26.4px tall ---------
      expect(
        await countMatching(page, MENU_ROW),
        'the menu has resting actionable rows to sample',
      ).toBeGreaterThan(0);
      await expect(page.locator(MENU_ROW).first(), 'the sampled row is on screen').toBeVisible();
      expectSample(
        await sampleStyle(page, MENU_ROW, ['padding', 'font-size', 'color']),
        { padding: '2px 8px 2px 20px', 'font-size': '14px', color: FG },
        'nav row',
      );
      expectNear((await sampleRect(page, MENU_ROW)).height, 26.4, 1, 'nav row height');

      // ---- hint bar, chip ------------------------------------------------------------------
      await expect(
        page.locator('#hint-bar .mr-chip').first(),
        'a hint chip is on screen',
      ).toBeVisible();
      expectSample(
        await sampleStyle(page, '.mr-hint-bar', ['padding', 'gap']),
        HINT_BAR_AT_16,
        'hint bar',
      );
      expectSample(
        await sampleStyle(page, '#hint-bar .mr-chip', [
          'padding',
          'border-width',
          'font-size',
          'color',
        ]),
        CHIP_AT_16,
        'chip',
      );

      // ---- #status: text written through evaluate so it is not :empty; cleared afterwards ----
      const status = await sampleWithState(page, '#status', { text: STATUS_PROBE_TEXT }, [
        'padding',
        'font-size',
        'color',
        'left',
        'bottom',
        'display',
      ]);
      expect(status.display, 'the status line shows once it has text').not.toBe('none');
      expectSample(status, STATUS_AT_16, 'status line');
    });

    test('UIF1.1 tabbed screen: Social`s tab strip and tabs, and the same row, chip and status values', async () => {
      // Tabbed screens carry no `.mr-frame-title` until they adopt the TitleBar (uif-6, uif-9, ...),
      // so no title is sampled here; the title is measured on the main menu above.
      await openRankings(page);

      // ---- the strip: gap 4px; a tab: padding 0 8px --------------------------------------------
      const strip = '.mr-frame-tabstrip:has(#social-tab-rankings)';
      expect(await countMatching(page, strip), 'Social paints a tab strip').toBeGreaterThan(0);
      expect(
        await countMatching(page, `${strip} .mr-nav-tab`),
        'with its four tabs',
      ).toBeGreaterThanOrEqual(4);
      await expect(page.locator('#social-tab-players'), 'a resting tab is on screen').toBeVisible();
      expectSample(await sampleStyle(page, strip, ['gap']), { gap: '4px 4px' }, 'tab strip');
      expectSample(
        await sampleStyle(page, '#social-tab-players', ['padding']),
        { padding: '0px 8px 0px 8px' },
        'a resting tab',
      );

      // ---- a resting row (Rankings row 1, the own player): padding, size and height; its text is
      // the read-only row's muted token (UIF1.3), not frame-fg ---------------------------------
      const row = '#leaderboard-list > .mr-nav-item:not(.is-active)';
      expect(
        await countMatching(page, row),
        'the Rankings board has a resting row',
      ).toBeGreaterThan(0);
      await expect(
        page.locator(row).first(),
        'the sampled Rankings row is on screen',
      ).toBeVisible();
      expectSample(
        await sampleStyle(page, row, ['padding', 'font-size', 'color']),
        { padding: '2px 8px 2px 20px', 'font-size': '14px', color: MUTED },
        'Rankings row (resting)',
      );
      expectNear((await sampleRect(page, row)).height, 26.4, 1, 'Rankings row height');

      // ---- the same hint bar, chip and status line --------------------------------------------
      await expect(page.locator('#hint-bar .mr-chip').first()).toBeVisible();
      expectSample(
        await sampleStyle(page, '.mr-hint-bar', ['padding', 'gap']),
        HINT_BAR_AT_16,
        'hint bar',
      );
      expectSample(
        await sampleStyle(page, '#hint-bar .mr-chip', [
          'padding',
          'border-width',
          'font-size',
          'color',
        ]),
        CHIP_AT_16,
        'chip',
      );
      const status = await sampleWithState(page, '#status', { text: STATUS_PROBE_TEXT }, [
        'padding',
        'font-size',
        'color',
        'left',
        'bottom',
        'display',
      ]);
      expect(status.display, 'the status line shows once it has text').not.toBe('none');
      expectSample(status, STATUS_AT_16, 'status line');
    });

    test('UIF1.1 rem reach: doubling the root font size doubles every spacing and type token, and leaves the two border tokens at 1px and 2px', async () => {
      // The kill for a literal px left behind, which a 16px-root sample cannot see: at a 32px root a
      // rem value doubles and a px literal does not (WF1-A4: border widths are px tokens, the one
      // exception, because a rem border lands on fractional device pixels and shimmers).
      await openMenu(page);

      type Spec = Record<string, Record<string, string>>;
      // `.mr-frame--bottom`, `--prompt`, `--banner`, `.mr-frame-tabs`, `.mr-frame-tabstrip`,
      // `.mr-nav-tab` and `.mr-section-header` have no element on screen on the menu (the dialogue's
      // bottom box, the walk-up chip, the deletion countdown, the Social tab strip and the section
      // header each appear only mid-flow or on another screen), so each is sampled on a PROBE
      // wearing the production class appended to the frame layer (or the menu's body) and removed
      // in the same evaluate (uiKit.sampleProbe): no screen order is assumed. The class rule is what
      // is measured; the flow that mounts it is covered elsewhere. The notice banner is NOT probed:
      // the real `#notice-banner` (hintBar.ts, prepended to `#hint-bar`) is sampled with its state
      // forced shown, because a rule scoped to `.mr-hint-bar .mr-notice-banner` reaches only that.
      const read = async (): Promise<Spec> => ({
        shell: await sampleStyle(page, '#menu-overlay', [
          'top',
          'right',
          'bottom',
          'left',
          'padding',
          'font-size',
        ]),
        navItem: await sampleStyle(page, MENU_ROW, ['padding', 'font-size']),
        titlebar: await sampleStyle(page, '#menu-overlay .mr-frame-titlebar', [
          'padding',
          'gap',
          'min-height',
          'border-bottom-width',
        ]),
        tabs: await sampleProbe(page, { className: 'mr-frame-tabs', parent: '#frame-layer' }, [
          'gap',
        ]),
        tabstrip: await sampleProbe(
          page,
          { className: 'mr-frame-tabstrip', parent: '#frame-layer' },
          ['gap'],
        ),
        tab: await sampleProbe(page, { className: 'mr-nav-tab', parent: '#frame-layer' }, [
          'padding',
        ]),
        header: await sampleProbe(
          page,
          { className: 'mr-section-header', parent: '#menu-overlay .mr-frame-body' },
          ['font-size'],
        ),
        contentMax: { width: await resolveLength(page, '--mr-content-max') },
        frame: await sampleStyle(page, '#menu-overlay .mr-frame', ['border-width']),
        title: await sampleStyle(page, '#menu-overlay .mr-frame-title', ['font-size']),
        hint: await sampleStyle(page, '.mr-hint-bar', ['padding', 'gap']),
        chip: await sampleStyle(page, '#hint-bar .mr-chip', [
          'padding',
          'border-width',
          'font-size',
        ]),
        status: await sampleWithState(page, '#status', { text: STATUS_PROBE_TEXT }, [
          'left',
          'bottom',
          'padding',
          'font-size',
        ]),
        bottom: await sampleProbe(
          page,
          { className: 'mr-frame mr-frame--bottom', parent: '#frame-layer' },
          ['padding'],
        ),
        prompt: await sampleProbe(
          page,
          { className: 'mr-frame mr-frame--prompt', parent: '#frame-layer' },
          ['padding', 'font-size', 'border-width'],
        ),
        banner: await sampleProbe(
          page,
          { className: 'mr-frame mr-frame--banner', parent: '#frame-layer' },
          ['padding', 'top', 'font-size', 'border-width'],
        ),
        // The real banner is `hidden` until a request line shows; text and `hidden` are forced for
        // the sample only and restored in the same evaluate (uiKit.sampleWithState).
        notice: await sampleWithState(
          page,
          '#notice-banner',
          { text: 'uif-1 notice probe', forceShown: true },
          ['padding', 'font-size', 'border-width'],
        ),
      });
      // Line heights are unitless multiples (1.4, 1.6), so the used px value is a float: compared
      // within 0.1px, in px at the root being measured.
      const readLines = async (): Promise<Record<string, number>> => {
        const px = (s: Record<string, string>): number => Number.parseFloat(s['line-height'] ?? '');
        return {
          shell: px(await sampleStyle(page, '#menu-overlay', ['line-height'])),
          title: px(await sampleStyle(page, '#menu-overlay .mr-frame-title', ['line-height'])),
          header: px(
            await sampleProbe(
              page,
              { className: 'mr-section-header', parent: '#menu-overlay .mr-frame-body' },
              ['line-height'],
            ),
          ),
        };
      };
      const LINES_AT_16 = { shell: 22.4, title: 28, header: 22.4 }; // 1.6 x 14, 1.4 x 20, 1.4 x 16
      const LINES_AT_32 = { shell: 44.8, title: 56, header: 44.8 };

      const AT_16: Spec = {
        shell: {
          top: '8px',
          right: '8px',
          bottom: '40px',
          left: '8px',
          padding: '12px 16px 12px 16px',
          'font-size': '14px',
        },
        navItem: { padding: '2px 8px 2px 20px', 'font-size': '14px' },
        titlebar: {
          padding: '4px 8px 4px 8px',
          gap: '8px 8px',
          'min-height': '40px',
          'border-bottom-width': '2px',
        },
        tabs: { gap: '4px 4px' },
        tabstrip: { gap: '4px 4px' },
        tab: { padding: '0px 8px 0px 8px' },
        header: { 'font-size': '16px' },
        contentMax: { width: '1280px' }, // --mr-content-max 80rem
        frame: { 'border-width': '2px 2px 2px 2px' },
        title: { 'font-size': '20px' },
        hint: { padding: '4px 8px 4px 8px', gap: '8px 8px' },
        chip: {
          padding: '2px 8px 2px 8px',
          'border-width': '1px 1px 1px 1px',
          'font-size': '12px',
        },
        status: { left: '8px', bottom: '36px', padding: '1px 6px 1px 6px', 'font-size': '12px' },
        bottom: { padding: '12px 16px 12px 16px' },
        prompt: {
          padding: '1px 6px 1px 6px',
          'font-size': '12px',
          'border-width': '1px 1px 1px 1px',
        },
        banner: {
          padding: '2px 8px 2px 8px',
          top: '4px',
          'font-size': '12px',
          'border-width': '1px 1px 1px 1px',
        },
        notice: {
          padding: '2px 8px 2px 8px',
          'font-size': '12px',
          'border-width': '1px 1px 1px 1px',
        },
      };
      const AT_32: Spec = {
        shell: {
          top: '16px',
          right: '16px',
          bottom: '80px',
          left: '16px',
          padding: '24px 32px 24px 32px',
          'font-size': '28px',
        },
        navItem: { padding: '4px 16px 4px 40px', 'font-size': '28px' },
        titlebar: {
          padding: '8px 16px 8px 16px',
          gap: '16px 16px',
          'min-height': '80px',
          'border-bottom-width': '2px', // WF1-A4: a border does NOT double
        },
        tabs: { gap: '8px 8px' },
        tabstrip: { gap: '8px 8px' },
        tab: { padding: '0px 16px 0px 16px' },
        header: { 'font-size': '32px' },
        contentMax: { width: '2560px' }, // 80rem at a 32px root
        frame: { 'border-width': '2px 2px 2px 2px' }, // WF1-A4: a border does NOT double
        title: { 'font-size': '40px' },
        hint: { padding: '8px 16px 8px 16px', gap: '16px 16px' },
        chip: {
          padding: '4px 16px 4px 16px',
          'border-width': '1px 1px 1px 1px', // WF1-A4: the thin border does NOT double
          'font-size': '24px',
        },
        status: { left: '16px', bottom: '72px', padding: '2px 12px 2px 12px', 'font-size': '24px' },
        bottom: { padding: '24px 32px 24px 32px' },
        prompt: {
          padding: '2px 12px 2px 12px',
          'font-size': '24px',
          'border-width': '1px 1px 1px 1px',
        },
        banner: {
          padding: '4px 16px 4px 16px',
          top: '8px',
          'font-size': '24px',
          'border-width': '1px 1px 1px 1px',
        },
        notice: {
          padding: '4px 16px 4px 16px',
          'font-size': '24px',
          'border-width': '1px 1px 1px 1px',
        },
      };

      const rootSize = (): Promise<string> =>
        page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
      expect(await rootSize(), 'precondition: the root font size is 16px at 1280x720').toBe('16px');
      const base = await read();
      for (const [name, expected] of Object.entries(AT_16)) {
        expectSample(base[name] ?? {}, expected, `${name} at a 16px root`);
      }
      const lines16 = await readLines();
      for (const [name, expected] of Object.entries(LINES_AT_16)) {
        expectNear(
          lines16[name] ?? Number.NaN,
          expected,
          0.1,
          `${name} line-height at a 16px root`,
        );
      }

      await withRootFontSize(page, 32, async () => {
        expect(await rootSize(), 'precondition: the root is now 32px').toBe('32px');
        const doubled = await read();
        for (const [name, expected] of Object.entries(AT_32)) {
          expectSample(doubled[name] ?? {}, expected, `${name} at a 32px root`);
        }
        const lines32 = await readLines();
        for (const [name, expected] of Object.entries(LINES_AT_32)) {
          expectNear(
            lines32[name] ?? Number.NaN,
            expected,
            0.1,
            `${name} line-height at a 32px root`,
          );
        }
      });
      expect(await rootSize(), 'the root font size is restored').toBe('16px');
    });

    test('UIF1.1 chip focus: a keyboard-focused chip rings in --mr-focus, and in the higher tier under prefers-contrast more', async () => {
      await closeAll(page);
      for (const id of ['chip-start', 'chip-select']) {
        await expect(page.locator(`#${id}`), `the ${id} chip is on screen`).toBeVisible();
      }

      // Tab to a chip by keyboard: focus-visible only matches for keyboard modality. (A
      // mouse-focused chip is not asserted: clicking a chip opens a frame, so it cannot be held.)
      const focusByKeyboard = async (id: string): Promise<void> => {
        const chip = page.locator(`#${id}`);
        await chip.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.id ?? ''), {
            message: `Tab lands on the ${id} chip`,
          })
          .toBe(id);
        expect(
          await chip.evaluate((el) => el.matches(':focus-visible')),
          `the ${id} chip is focus-visible, not merely focused`,
        ).toBe(true);
      };
      const ring = (id: string): Promise<Record<string, string>> =>
        sampleStyle(page, `#${id}`, ['outline-color', 'outline-style', 'outline-width']);

      try {
        for (const id of ['chip-start', 'chip-select']) {
          await focusByKeyboard(id);
          expectSample(
            await ring(id),
            { 'outline-color': FOCUS, 'outline-style': 'solid', 'outline-width': '2px' },
            `${id} ring`,
          );
        }

        // The ring is the CHIP's: keyboard-focused native controls with no kit class (and a bare
        // nav row) must not take --mr-focus. The previous chip focus is keyboard-modal, so the
        // programmatic focus below is :focus-visible. Each probe is removed in the same evaluate.
        const leaks = await page.evaluate(() => {
          const layer = document.querySelector('#frame-layer');
          if (layer === null) throw new Error('no #frame-layer');
          const made: HTMLElement[] = [];
          try {
            const out: Array<Record<string, string | boolean>> = [];
            for (const [tag, cls] of [
              ['button', ''],
              ['input', ''],
              ['div', 'mr-nav-item'],
            ] as const) {
              const el = document.createElement(tag);
              el.setAttribute('data-ui-kit-probe', 'focus');
              if (cls !== '') el.className = cls;
              if (tag === 'div') el.tabIndex = 0;
              el.textContent = tag === 'input' ? '' : 'probe';
              layer.appendChild(el);
              made.push(el);
              el.focus();
              const cs = getComputedStyle(el);
              out.push({
                tag: cls === '' ? tag : `${tag}.${cls}`,
                focused: document.activeElement === el,
                color: cs.outlineColor,
                style: cs.outlineStyle,
              });
            }
            return out;
          } finally {
            for (const el of made) el.remove();
          }
        });
        expect(leaks.length, 'three probes were measured').toBe(3);
        for (const leak of leaks) {
          expect(leak.focused, `${leak.tag} probe holds focus`).toBe(true);
          expect(leak.color, `${leak.tag} (no chip class) does not ring in --mr-focus`).not.toBe(
            FOCUS,
          );
        }

        await page.emulateMedia({ contrast: 'more' });
        expect(await mediaMatches(page, '(prefers-contrast: more)'), 'precondition: more').toBe(
          true,
        );
        await focusByKeyboard('chip-start');
        expect((await ring('chip-start'))['outline-color'], 'and the higher tier under more').toBe(
          FOCUS_MORE,
        );
      } finally {
        await page.emulateMedia({ contrast: null });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }

      // The focused listbox keeps its own dashed #cc5500 ring (not --mr-focus): the nav kit's
      // tab stop, which can cross the light active row. Focus is set by script (the rule is
      // `:focus`, not `:focus-visible`) and blurred afterwards.
      try {
        await openMenu(page);
        await page.locator('#menu-rows').focus();
        expect(
          await page.evaluate(() => document.activeElement?.id ?? ''),
          'the menu list holds focus',
        ).toBe('menu-rows');
        expectSample(
          await sampleStyle(page, '#menu-rows', [
            'outline-color',
            'outline-style',
            'outline-width',
          ]),
          { 'outline-color': 'rgb(204, 85, 0)', 'outline-style': 'dashed', 'outline-width': '2px' },
          'the focused listbox ring',
        );
      } finally {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
    });

    test('UIF1.2 prefers-contrast more: text, border, disabled and state colours resolve to the higher tier, every token does, and the default tier returns when the emulation ends', async () => {
      await openMonsterSheet(page);
      const feedRow = `#${navItemId('monstersSheet', null, 'feed')}`;
      await expect(page.locator(feedRow), 'the Feed row is on screen').toBeVisible();
      expect(await mediaMatches(page, '(prefers-contrast: more)'), 'precondition: not yet').toBe(
        false,
      );

      // Real elements, sampled in one tier. The feedback mark has no flow that paints it on demand,
      // so `data-feedback` is set for the sample, the strip is forced shown only for it, and both
      // are restored in the same evaluate (uiKit.sampleWithState).
      const sampleReal = async (): Promise<Record<string, string>> => ({
        frameBg: (await sampleStyle(page, '#menu-overlay .mr-frame', ['background-color']))[
          'background-color'
        ] as string,
        frameBorder: (await sampleStyle(page, '#menu-overlay .mr-frame', ['border-top-color']))[
          'border-top-color'
        ] as string,
        rowText: (await sampleStyle(page, MENU_ROW, ['color'])).color as string,
        disabledRow: (await sampleStyle(page, feedRow, ['color'])).color as string,
        // A disabled row that sits in a `.mr-nav-list` (the menu's own list): no menu row is
        // disabled in production, so `is-disabled` is FORCED on a non-active row for the sample
        // only, and the class attribute is restored in the same evaluate. It reaches a
        // `.mr-nav-list .mr-nav-item.is-disabled` rule that the Feed row (outside any
        // `.mr-nav-list`) cannot.
        disabledListRow: (
          await sampleWithState(
            page,
            '#menu-rows .mr-nav-item:not(.is-active):not(.is-disabled)',
            { addClasses: ['is-disabled'] },
            ['color'],
          )
        ).color as string,
        chipColor: (await sampleStyle(page, '#hint-bar .mr-chip', ['color'])).color as string,
        chipBorder: (await sampleStyle(page, '#hint-bar .mr-chip', ['border-color']))[
          'border-color'
        ] as string,
        chipBg: (await sampleStyle(page, '#hint-bar .mr-chip', ['background-color']))[
          'background-color'
        ] as string,
        statusColor: (
          await sampleWithState(page, '#status', { text: STATUS_PROBE_TEXT }, ['color'])
        ).color as string,
        statusBg: (
          await sampleWithState(page, '#status', { text: STATUS_PROBE_TEXT }, ['background-color'])
        )['background-color'] as string,
        markOk: (
          await sampleWithState(
            page,
            '#menu-overlay .mr-frame-feedback',
            { attrs: { 'data-feedback': 'ok' }, text: 'ok', forceShown: true },
            ['color'],
            '::before',
          )
        ).color as string,
        markError: (
          await sampleWithState(
            page,
            '#menu-overlay .mr-frame-feedback',
            { attrs: { 'data-feedback': 'error' }, text: 'error', forceShown: true },
            ['color'],
            '::before',
          )
        ).color as string,
      });
      const tokens = async (): Promise<Record<string, string>> => {
        const out: Record<string, string> = {};
        for (const name of TOKEN_NAMES) out[name] = await resolveToken(page, name);
        return out;
      };

      try {
        await page.emulateMedia({ contrast: 'more' });
        expect(await mediaMatches(page, '(prefers-contrast: more)'), 'more is emulated').toBe(true);
        expect(await sampleReal(), 'real elements under more').toEqual({
          frameBg: 'rgb(16, 16, 24)', // #101018
          frameBorder: 'rgb(255, 255, 255)', // #ffffff
          rowText: 'rgb(255, 255, 255)', // #ffffff
          disabledRow: 'rgb(170, 170, 170)', // #aaaaaa
          disabledListRow: 'rgb(170, 170, 170)', // #aaaaaa
          chipColor: 'rgb(255, 255, 255)', // #ffffff
          chipBorder: fourSides('rgb(255, 255, 255)'), // #ffffff
          chipBg: 'rgb(16, 16, 24)', // #101018
          statusColor: 'rgb(255, 255, 255)', // #ffffff
          statusBg: 'rgb(16, 16, 24)', // #101018
          markOk: 'rgb(110, 231, 183)', // #6ee7b7
          markError: 'rgb(252, 165, 165)', // #fca5a5
        });
        expect(await tokens(), 'every colour token under more').toEqual(TOKEN_MORE);
      } finally {
        await page.emulateMedia({ contrast: null });
      }

      // The block must also UN-apply: a more block that never ends, or a default-tier value inside
      // it, reds one of the two halves.
      expect(await mediaMatches(page, '(prefers-contrast: more)'), 'more is off again').toBe(false);
      expect(await sampleReal(), 'real elements back in the default tier').toEqual({
        frameBg: 'rgb(30, 30, 46)', // #1e1e2e
        frameBorder: 'rgb(224, 224, 224)', // #e0e0e0
        rowText: 'rgb(224, 224, 224)', // #e0e0e0
        disabledRow: 'rgb(138, 138, 154)', // #8a8a9a
        disabledListRow: 'rgb(138, 138, 154)', // #8a8a9a
        chipColor: 'rgb(224, 224, 224)', // #e0e0e0
        chipBorder: fourSides('rgb(224, 224, 224)'), // #e0e0e0
        chipBg: 'rgb(30, 30, 46)', // #1e1e2e
        statusColor: 'rgb(224, 224, 224)', // #e0e0e0
        statusBg: 'rgb(30, 30, 46)', // #1e1e2e
        markOk: 'rgb(52, 211, 153)', // #34d399
        markError: 'rgb(248, 113, 113)', // #f87171
      });
      expect(await tokens(), 'every colour token back in the default tier').toEqual(TOKEN_DEFAULT);
    });

    test('UIF1.3 disabled row: the Monsters sheet`s Feed row (no food) renders in the muted-disabled token at 3:1 or better, away from the cursor', async () => {
      await openMonsterSheet(page);
      const feedRow = `#${navItemId('monstersSheet', null, 'feed')}`;

      // A fresh player has no food (monstersModel.ts sheetLayout: Feed... is `enabled: canFeed`), so
      // the row is genuinely disabled, and the cursor opened on Summary, so it is not the active row.
      await expect(page.locator(feedRow), 'the Feed row is on screen').toBeVisible();
      await expect(page.locator(feedRow), 'Feed... is disabled (aria)').toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(page.locator(feedRow), 'and carries the disabled class').toHaveClass(
        /is-disabled/,
      );
      await expect(page.locator(feedRow), 'the cursor is not on it').toHaveAttribute(
        'aria-selected',
        'false',
      );

      expect(
        (await sampleStyle(page, feedRow, ['color'])).color,
        'Feed... (disabled, off the cursor)',
      ).toBe(DISABLED);
      const ratio = await measuredContrast(page, feedRow);
      expect(
        ratio,
        `Feed... measured contrast ${ratio.toFixed(2)}:1 against its background`,
      ).toBeGreaterThanOrEqual(3);

      // The cursor ON the disabled row (`.is-active.is-disabled`): the table's reused-values note
      // gives it #55556a (rgb(85, 85, 106)) on the inverted fill, at 4.5:1 or better. Walk Down from
      // Summary one press at a time, bounded, each landing observed; the cursor is walked back Up in
      // the `finally`, because the menu remembers the sheet's cursor for the session.
      let presses = 0;
      const activeIdInFeedList = (): Promise<string> =>
        page.evaluate((id) => {
          const row = document.getElementById(id);
          const list = row?.closest('[role="listbox"]') ?? row?.parentElement ?? null;
          return list?.querySelector('.mr-nav-item.is-active')?.id ?? '';
        }, feedRow.slice(1));
      try {
        for (; presses < 12; presses += 1) {
          const from = await activeIdInFeedList();
          if (from === feedRow.slice(1)) break;
          await pressButton(page, 'Down');
          await expect
            .poll(activeIdInFeedList, { message: `Down moves the cursor off ${from}` })
            .not.toBe(from);
        }
        await expect(page.locator(feedRow), 'the cursor is now ON the Feed row').toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(page.locator(feedRow), 'the cursor row wears is-active').toHaveClass(
          /is-active/,
        );
        await expect(page.locator(feedRow), 'and is still disabled').toHaveClass(/is-disabled/);
        expect(
          (await sampleStyle(page, feedRow, ['color'])).color,
          'Feed... (disabled, ON the cursor)',
        ).toBe('rgb(85, 85, 106)'); // #55556a
        const onCursor = await measuredContrast(page, feedRow);
        expect(
          onCursor,
          `Feed... on the cursor measured contrast ${onCursor.toFixed(2)}:1 against its fill`,
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        for (let back = 0; back < presses; back += 1) await pressButton(page, 'Up');
      }
    });

    test('UIF1.3 read-only list: the Rankings rows read muted, the cursor row has no inverted fill, and an actionable row differs on both counts', async () => {
      await openRankings(page);

      const rows = '#leaderboard-list > .mr-nav-item';
      const cursor = `${rows}.is-active`;
      const resting = `${rows}:not(.is-active)`;
      // Name the rows: the seeded rival tops the board (the cursor opens on the first row), the own
      // player is second.
      await expect(page.locator(rows).nth(0), 'row 0 is the seeded rival').toContainText(
        RIVAL_NAME,
      );
      await expect(page.locator(rows).nth(1), 'row 1 is the own player').toContainText(SELF_NAME);
      await expect(page.locator(cursor), 'exactly one cursor row').toHaveCount(1);
      await expect(page.locator(cursor), 'the cursor row is row 0 (the rival)').toContainText(
        RIVAL_NAME,
      );
      await expect(page.locator(rows).nth(1), 'row 1 is not the cursor').toHaveAttribute(
        'aria-selected',
        'false',
      );

      // The non-cursor read-only row (row 1, UifSelf): muted text, no fill.
      const restingRow = await sampleStyle(page, resting, ['color', 'background-color']);
      expect(restingRow.color, 'row 1 (UifSelf, read-only, off the cursor)').toBe(MUTED);
      expect(restingRow.color, 'a read-only row differs from an actionable row').not.toBe(FG);
      expect(restingRow['background-color'], 'row 1 paints no fill').toBe('rgba(0, 0, 0, 0)');

      // The read-only CURSOR row (row 0, UifRival): no inverted fill (it keeps the fg text on the
      // list's own background, with the left bar of qf-16).
      const cursorRow = await sampleStyle(page, cursor, ['color', 'background-color']);
      expect(cursorRow['background-color'], 'row 0 (cursor) has no inverted fill').toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(cursorRow.color, 'row 0 (cursor) text is not the inverted bg colour').not.toBe(
        'rgb(30, 30, 46)',
      );
      expect(cursorRow.color, 'row 0 (cursor) text reads the frame-fg token').toBe(FG);

      // An ACTIONABLE row, on the main menu: a resting row reads frame-fg, and the active row is
      // the inverted fill the read-only cursor row must not have.
      await openMenu(page);
      const activeMenuRow = `#${navItemId('menu', null, 'monsters')}`;
      await expect(page.locator(activeMenuRow), 'the menu cursor is on Monsters').toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(
        (await sampleStyle(page, MENU_ROW, ['color'])).color,
        'a resting actionable menu row',
      ).toBe(FG);
      const activeRow = await sampleStyle(page, activeMenuRow, ['color', 'background-color']);
      expect(
        activeRow['background-color'],
        'the actionable active row (Monsters) has the inverted fill',
      ).toBe(FG);
      expect(activeRow['background-color']).not.toBe(cursorRow['background-color']);
    });

    test('UIF1.4 type hierarchy: title 20 bold, section header 16 bold, body 14 normal, small 12 normal, each level differing from the next', async () => {
      await openMenu(page);

      // No production element wears `.mr-section-header` yet: the views' `h3`s are unclassed (and
      // their views are outside this slice; uif-6 and uif-16b adopt the class). The level is
      // therefore measured on a probe wearing the real class inside the REAL frame body, removed in
      // the same evaluate (uiKit.sampleProbe).
      expect(
        await countMatching(page, '#menu-overlay .mr-frame-body'),
        'the menu frame has a body to host the section header',
      ).toBeGreaterThan(0);
      const props = ['font-size', 'font-weight'];
      const title = await sampleStyle(page, '#menu-overlay .mr-frame-title', props);
      const header = await sampleProbe(
        page,
        { className: 'mr-section-header', parent: '#menu-overlay .mr-frame-body' },
        props,
      );
      await expect(page.locator(MENU_ROW).first(), 'a body row is on screen').toBeVisible();
      const body = await sampleStyle(page, MENU_ROW, props);
      await expect(
        page.locator('#hint-bar .mr-chip').first(),
        'a small chip is on screen',
      ).toBeVisible();
      const small = await sampleStyle(page, '#hint-bar .mr-chip', props);

      expect(title, 'title').toEqual({ 'font-size': '20px', 'font-weight': '700' });
      expect(header, 'section header').toEqual({ 'font-size': '16px', 'font-weight': '700' });
      expect(body, 'body').toEqual({ 'font-size': '14px', 'font-weight': '400' });
      expect(small, 'small').toEqual({ 'font-size': '12px', 'font-weight': '400' });

      const levels = [
        ['title', title],
        ['section header', header],
        ['body', body],
        ['small', small],
      ] as const;
      for (let i = 0; i + 1 < levels.length; i += 1) {
        const [aName, a] = levels[i] as (typeof levels)[number];
        const [bName, b] = levels[i + 1] as (typeof levels)[number];
        const differs = a['font-size'] !== b['font-size'] || a['font-weight'] !== b['font-weight'];
        expect(differs, `${aName} differs from ${bName} in size or weight`).toBe(true);
      }
    });

    test('UIF1.5 geometry at 1280x720: the menu frame, its side frame and the hint bar sit where wf-1 puts them', async () => {
      await openMenu(page);
      await expect(
        page.locator('#menu-overlay .mr-frame--side'),
        'the side frame is shown',
      ).toBeVisible();
      await expect(page.locator('#hint-bar'), 'the hint bar is shown').toBeVisible();
      expect(
        await page.evaluate(() => [window.innerWidth, window.innerHeight]),
        'precondition: the window is 1280x720',
      ).toEqual([1280, 720]);

      expectRect(
        await sampleRect(page, '#menu-overlay'),
        { x: 8, y: 8, width: 1264, height: 672 },
        1,
        '#menu-overlay (the .mr-shell)',
      );
      expectRect(
        await sampleRect(page, '#menu-overlay .mr-frame--side'),
        { x: 849.5, y: 20, width: 406.5, height: 648 },
        1,
        'the side frame',
      );
      expectRect(
        await sampleRect(page, '#hint-bar'),
        { x: 0, y: 689.2, width: 1280, height: 30.8 },
        1,
        '#hint-bar',
      );

      // The insets at two other windows, so a viewport-dependent cheat (an inset that equals 8px
      // only at 1280 wide) reds. REM-RELATIVE, with no literal px: the oracle is the measured root
      // font size in px. The window's `resize` handler rewrites `--mr-ui-scale` one event after
      // the window reports its new size, so the root is read only once it equals wf-1's "1rem"
      // literal for that window (the settle condition, transcribed, never computed): the shell
      // sits 0.5 root from the left, top and right edges and 2.5 root above the bottom (the hint
      // bar's row), and the hint bar spans the full width with its bottom on the viewport's bottom.
      const readRoot = async (): Promise<number> =>
        Number.parseFloat((await sampleStyle(page, 'html', ['font-size']))['font-size'] as string);
      try {
        for (const size of [
          { width: 1920, height: 1080, rem: 24 },
          { width: 640, height: 240, rem: 14 },
        ]) {
          const at = `${size.width}x${size.height}`;
          await page.setViewportSize({ width: size.width, height: size.height });
          await expect
            .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]), {
              message: `the window is ${at}`,
            })
            .toEqual([size.width, size.height]);
          let root = 0;
          await expect
            .poll(
              async () => {
                root = await readRoot();
                return root;
              },
              { message: `${at}: the root font size settles at wf-1's 1rem`, timeout: 10_000 },
            )
            .toBe(size.rem);

          const shell = await sampleRect(page, '#menu-overlay');
          expectNear(shell.x, 0.5 * root, 1, `${at}: shell left gap`);
          expectNear(shell.y, 0.5 * root, 1, `${at}: shell top gap`);
          expectNear(size.width - (shell.x + shell.width), 0.5 * root, 1, `${at}: shell right gap`);
          expectNear(
            size.height - (shell.y + shell.height),
            2.5 * root,
            1,
            `${at}: shell bottom gap`,
          );
          const bar = await sampleRect(page, '#hint-bar');
          expectNear(bar.x, 0, 1, `${at}: hint bar left edge`);
          expectNear(bar.width, size.width, 1, `${at}: hint bar spans the full width`);
          expectNear(
            bar.y + bar.height,
            size.height,
            1,
            `${at}: hint bar bottom is the viewport's`,
          );
        }
      } finally {
        await page.setViewportSize(VIEWPORT);
        await expect
          .poll(readRoot, {
            message: "the root font size settles back at wf-1's 1280x720 1rem",
            timeout: 10_000,
          })
          .toBe(16);
      }
    });

    // =========================================================================================
    // uif-4 (UIF4.2, UIF4.3): the feedback strip is an overlay (zero layout height), and the toast
    // paints above the top shell. The geometry runs on ALL THREE strip hosts (the main menu's kit
    // frame, Monsters, Inventory) at 1280x720 AND 640x240, against the REAL stylesheet.
    //
    // Menu: the strip is made to show through a REAL flow (Y on a menu row paints its description).
    // Monsters and Inventory: no real flow paints their strip without fixtures that need a monster
    // in a state or an item pocket, so the strip is FORCED shown inside the probe's own page.evaluate
    // (`hidden = false` plus text, undone in a finally, no frame between). The geometry measured is
    // still the real CSS: nothing but the strip's own hidden/text is touched.
    // =========================================================================================

    type R = { x: number; y: number; width: number; height: number };
    interface StripProbe {
      readonly snap: {
        readonly host: R;
        readonly body: R | null;
        readonly scrollHeight: number;
        readonly hostScrollHeight: number;
        readonly stripHidden: boolean;
        readonly stripRect: R;
        readonly others: readonly R[];
      };
      readonly containerRect: R;
      readonly stripAtTop: R;
      readonly stripAtMax: R;
      readonly contentBottomAtMax: number;
    }
    interface ProbeCfg {
      readonly which: 'menu' | 'box' | 'bag';
      readonly force: boolean;
      readonly text: string;
    }

    /** One synchronous in-page measurement of a strip host (no frame, no batch inside it). */
    const probeStrip = (cfg: ProbeCfg): Promise<StripProbe> =>
      page.evaluate((c: ProbeCfg): StripProbe => {
        const q = (s: string): HTMLElement | null => document.querySelector<HTMLElement>(s);
        let host: HTMLElement | null = null;
        let strip: HTMLElement | null = null;
        if (c.which === 'menu') {
          host = q('#menu-overlay');
          strip = host?.querySelector<HTMLElement>('.mr-frame-feedback') ?? null;
        } else if (c.which === 'box') {
          host = q('[data-testid="box-title"]')?.closest<HTMLElement>('.mr-shell') ?? null;
          strip = host?.querySelector<HTMLElement>('.mr-frame-feedback') ?? null;
        } else {
          strip = q('#bag-status');
          host = strip?.closest<HTMLElement>('.mr-shell') ?? null;
        }
        if (host === null || strip === null) {
          throw new Error(`probeStrip(${c.which}): no host or no strip on screen`);
        }
        const h = host;
        const s = strip;
        const rectOf = (el: Element): R => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const body = h.querySelector<HTMLElement>('.mr-frame-body');
        let container: HTMLElement = h;
        for (let n = s.parentElement; n !== null && n !== document.body; n = n.parentElement) {
          if (getComputedStyle(n).overflowY !== 'visible') {
            container = n;
            break;
          }
        }
        const scrollables = [
          h,
          container,
          ...Array.from(h.querySelectorAll<HTMLElement>('*')),
        ].filter((el, i, all) => {
          return (
            all.indexOf(el) === i && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY)
          );
        });
        const setScroll = (where: 'top' | 'max'): void => {
          for (const el of scrollables) el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
        };
        const underAbsolute = (el: Element): boolean => {
          for (let n: Element | null = el; n !== null && n !== h; n = n.parentElement) {
            const p = getComputedStyle(n).position;
            if (p === 'absolute' || p === 'fixed') return true;
          }
          return false;
        };
        const contentBottom = (): number => {
          let m = Number.NEGATIVE_INFINITY;
          for (const el of Array.from(h.querySelectorAll<HTMLElement>('*'))) {
            // uif-4 (named change): skip the strip, its descendants AND its ancestors (the frame root
            // contains the strip, so its border box ends below it by construction); only content rows count.
            if (el === s || s.contains(el) || el.contains(s) || el.closest('[hidden]') !== null)
              continue;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || underAbsolute(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            m = Math.max(m, r.bottom);
          }
          return m;
        };
        const prior = {
          hidden: s.hidden,
          display: s.style.display,
          text: s.textContent,
          scroll: scrollables.map((e) => e.scrollTop),
        };
        try {
          if (c.force) {
            s.hidden = false;
            s.style.display = '';
            s.textContent = c.text;
          }
          setScroll('top');
          const parent = s.parentElement ?? h;
          const snap = {
            host: rectOf(h),
            body: body === null ? null : rectOf(body),
            scrollHeight: container.scrollHeight,
            hostScrollHeight: h.scrollHeight,
            // collapsed = the hidden attribute OR display:none (boxView collapses with style.display).
            stripHidden: s.hidden !== false || getComputedStyle(s).display === 'none',
            stripRect: rectOf(s),
            others: Array.from(parent.children)
              .filter((k) => k !== s)
              .map(rectOf),
          };
          const containerRect = rectOf(container);
          const stripAtTop = rectOf(s);
          setScroll('max');
          const stripAtMax = rectOf(s);
          const contentBottomAtMax = contentBottom();
          return { snap, containerRect, stripAtTop, stripAtMax, contentBottomAtMax };
        } finally {
          if (c.force) {
            s.hidden = prior.hidden;
            s.style.display = prior.display;
            s.textContent = prior.text;
          }
          scrollables.forEach((e, i) => {
            e.scrollTop = prior.scroll[i] ?? 0;
          });
        }
      }, cfg);

    const inside = (inner: R, outer: R): boolean =>
      inner.x >= outer.x - 0.5 &&
      inner.y >= outer.y - 0.5 &&
      inner.x + inner.width <= outer.x + outer.width + 0.5 &&
      inner.y + inner.height <= outer.y + outer.height + 0.5;

    /** The UIF4.3 clauses, empty -> shown, for one host at one window. */
    const expectOverlay = (
      before: StripProbe,
      after: StripProbe,
      label: string,
      emptyCollapses = true,
    ): void => {
      // Residual R-uif-4-BAGSTATUS-EMPTY (for uif-8, which owns Inventory): raisingView never collapses
      // an empty #bag-status (style.display = '' and textContent = '', as before uif-4; raisingView.ts is
      // outside this slice's touches), so the Inventory host passes emptyCollapses = false and skips ONLY
      // the empty-collapse clause. Every other clause below holds for it unchanged.
      if (emptyCollapses) {
        expect(before.snap.stripHidden, `${label}: the empty strip is collapsed`).toBe(true);
        expect(
          [before.snap.stripRect.width, before.snap.stripRect.height],
          `${label}: the empty strip has a zero rect`,
        ).toEqual([0, 0]);
      }
      expect(after.snap.stripHidden, `${label}: the shown strip is not hidden`).toBe(false);
      expect(after.stripAtTop.height, `${label}: the shown strip has a height`).toBeGreaterThan(0);
      expect(after.snap.host, `${label}: the host rect is exactly unchanged`).toEqual(
        before.snap.host,
      );
      expect(after.snap.body, `${label}: the frame body rect is exactly unchanged`).toEqual(
        before.snap.body,
      );
      expect(after.snap.scrollHeight, `${label}: the scroll height is exactly unchanged`).toBe(
        before.snap.scrollHeight,
      );
      expect(after.snap.hostScrollHeight, `${label}: the host scroll height is unchanged`).toBe(
        before.snap.hostScrollHeight,
      );
      expect(after.snap.others, `${label}: every other child's rect is unchanged`).toEqual(
        before.snap.others,
      );
      expect(
        inside(after.stripAtTop, after.containerRect),
        `${label}: the strip is inside the scroll container's visible rect at scrollTop 0 ` +
          `(${JSON.stringify(after.stripAtTop)} in ${JSON.stringify(after.containerRect)})`,
      ).toBe(true);
      expect(
        inside(after.stripAtMax, after.containerRect),
        `${label}: the strip is inside the scroll container's visible rect at the end ` +
          `(${JSON.stringify(after.stripAtMax)} in ${JSON.stringify(after.containerRect)})`,
      ).toBe(true);
      expect(
        after.contentBottomAtMax,
        `${label}: after scrolling to the end the last content bottom is at or above the strip top`,
      ).toBeLessThanOrEqual(after.stripAtMax.y + 0.5);
    };

    const WINDOWS = [
      { width: 1280, height: 720, rem: 16 },
      { width: 640, height: 240, rem: 14 },
    ] as const;

    const setWindow = async (w: { width: number; height: number; rem: number }): Promise<void> => {
      await page.setViewportSize({ width: w.width, height: w.height });
      await expect
        .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
        .toEqual([w.width, w.height]);
      await expect
        .poll(
          async () =>
            Number.parseFloat(
              (await sampleStyle(page, 'html', ['font-size']))['font-size'] as string,
            ),
          { message: `${w.width}x${w.height}: the root font size settles`, timeout: 10_000 },
        )
        .toBe(w.rem);
    };

    const restoreWindow = async (): Promise<void> => {
      await closeAll(page);
      await setWindow({ width: 1280, height: 720, rem: 16 });
    };

    test('UIF4.3 the main menu: its Y-description strip takes no layout height and keeps the last row clear, at both windows', async () => {
      test.setTimeout(90_000);
      try {
        for (const w of WINDOWS) {
          const label = `menu ${w.width}x${w.height}`;
          await setWindow(w);
          await openMenu(page);
          const before = await probeStrip({ which: 'menu', force: false, text: '' });
          await pressButton(page, 'Y'); // the real flow: Y on the cursor row paints its description
          await expect(
            page.locator('#menu-overlay .mr-frame-feedback'),
            `${label}: Y shows the Y-description strip`,
          ).toBeVisible();
          const after = await probeStrip({ which: 'menu', force: false, text: '' });
          expectOverlay(before, after, label);
        }
      } finally {
        await restoreWindow();
      }
    });

    test('UIF4.3 Monsters: a shown strip takes no layout height and stays inside the scrolling shell, at both windows', async () => {
      test.setTimeout(90_000);
      try {
        for (const w of WINDOWS) {
          const label = `monsters ${w.width}x${w.height}`;
          await setWindow(w);
          await openMenu(page);
          await pressButton(page, 'A');
          await expect
            .poll(() => stackNames(page), { message: `${label}: A on Monsters pushes Monsters` })
            .toEqual(['world', 'menuView', 'boxView']);
          const before = await probeStrip({ which: 'box', force: false, text: '' });
          const after = await probeStrip({ which: 'box', force: true, text: 'uif-4 strip probe' });
          expectOverlay(before, after, label);
        }
      } finally {
        await restoreWindow();
      }
    });

    test('UIF4.3 Inventory: a shown #bag-status strip takes no layout height and stays inside the scrolling shell, at both windows', async () => {
      test.setTimeout(90_000);
      try {
        for (const w of WINDOWS) {
          const label = `inventory ${w.width}x${w.height}`;
          await setWindow(w);
          await closeAll(page);
          await pressAccel(page, 'I');
          await expect
            .poll(() => stackNames(page), { message: `${label}: I opens Inventory over the menu` })
            .toEqual(['world', 'menuView', 'raisingView']);
          const before = await probeStrip({ which: 'bag', force: false, text: '' });
          const after = await probeStrip({ which: 'bag', force: true, text: 'uif-4 strip probe' });
          expectOverlay(before, after, label, false); // R-uif-4-BAGSTATUS-EMPTY, see expectOverlay
        }
      } finally {
        await restoreWindow();
      }
    });

    test('UIF4.2 the toast is the top hit over the open main menu (the .mr-shell--top layer)', async () => {
      // No real flow paints a toast over the menu without fixtures, so the toast is FORCED shown
      // inside one page.evaluate (hidden = false plus text, undone in a finally). Everything the
      // check measures is real CSS: paint order is hit-tested with pointer-events toggled to `auto`
      // INSIDE the same evaluate (pointer-events does not change paint order, only hit-testing).
      await openMenu(page);
      const result = await page.evaluate(() => {
        const toast = document.getElementById('toast');
        const shell = document.getElementById('menu-overlay');
        if (toast === null || shell === null)
          throw new Error('#toast and #menu-overlay must exist');
        const prior = {
          hidden: toast.hidden,
          text: toast.textContent,
          pe: toast.style.pointerEvents,
        };
        try {
          toast.hidden = false;
          toast.textContent = 'uif-4 toast probe';
          toast.style.pointerEvents = 'auto';
          const r = toast.getBoundingClientRect();
          const s = shell.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          return {
            hitInToast: hit !== null && toast.contains(hit),
            hit: hit === null ? 'null' : `${hit.tagName}#${hit.id}.${hit.className}`,
            overShell: cx >= s.x && cx <= s.x + s.width && cy >= s.y && cy <= s.y + s.height,
            shellIsTop: shell.classList.contains('mr-shell--top'),
          };
        } finally {
          toast.hidden = prior.hidden;
          toast.textContent = prior.text;
          toast.style.pointerEvents = prior.pe;
        }
      });
      expect(result.shellIsTop, 'precondition: the menu is the .mr-shell--top layer').toBe(true);
      expect(result.overShell, 'the toast centre lies over the open menu shell').toBe(true);
      expect(result.hitInToast, `the toast is the top hit (hit: ${result.hit})`).toBe(true);
      await closeAll(page);
    });

    test('S5T-FOCUS-SETTLED-BY-CLOSE-E2E: a menu close that restored focus to the Start chip never steals a later blur to the world canvas at the next frame edge', async () => {
      // WRONG IMPL KILLED: the frame-time `a === document.body` clause of main.ts's world-edge focus
      // return. The close restores focus to the visible #chip-start (settled); a blur in the SAME
      // task, before any frame runs, leaves <body>; the next frame then misreads that <body> as "the
      // close left focus adrift" and focuses the world CANVAS (measured: CANVAS on master and on the
      // branch alike; the a11y.spec.ts real-keyboard spelling of this is a race, this one is not).
      // Deterministic by construction: the Escape, the restore check and the blur all run inside ONE
      // page.evaluate, so no animation frame can land between the close and the blur.
      await closeAll(page);
      try {
        await page.locator('#chip-start').focus();
        await expect(
          page.locator('#chip-start'),
          'precondition: the Start chip holds focus',
        ).toBeFocused();
        await page.keyboard.press('Space');
        await expect
          .poll(() => stackNames(page), { message: 'Space on the Start chip opens the menu' })
          .toEqual(['world', 'menuView']);
        await expect(
          page.locator('#menu-rows'),
          'the open menu took focus on its list',
        ).toBeFocused();

        const probe = await page.evaluate(() => {
          const target = document.activeElement ?? document.body;
          for (const type of ['keydown', 'keyup'] as const) {
            target.dispatchEvent(
              new KeyboardEvent(type, {
                code: 'Escape',
                key: 'Escape',
                bubbles: true,
                cancelable: true,
              }),
            );
          }
          const menu = document.getElementById('menu-overlay');
          const hidden = menu !== null && getComputedStyle(menu).display === 'none';
          const active = document.activeElement;
          const restoredTo = active === null ? 'null' : active.id || active.tagName;
          if (active instanceof HTMLElement) active.blur();
          const after = document.activeElement;
          const afterBlur = after === null ? 'null' : after.tagName;
          return { hidden, restoredTo, afterBlur };
        });
        expect(
          probe.hidden,
          'the synthetic Escape closed the menu (#menu-overlay display:none)',
        ).toBe(true);
        expect(probe.restoredTo, 'precondition: the close restored focus to the Start chip').toBe(
          'chip-start',
        );
        expect(probe.afterBlur, 'precondition: the blur left focus on <body>').toBe('BODY');

        // Two animation frames: the first is the world edge (menuView -> null). A HARD read after
        // them, never a poll: a poll would pass on a pre-edge read and hide the theft.
        await page.evaluate(
          () =>
            new Promise<undefined>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
            ),
        );
        const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? 'null');
        expect(
          focusedTag,
          'the frame edge must leave the player`s blur on <body>; CANVAS means the world-edge ' +
            'focus return stole it after a close that had already settled focus on #chip-start',
        ).toBe('BODY');
      } finally {
        await closeAll(page);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
    });
  });
