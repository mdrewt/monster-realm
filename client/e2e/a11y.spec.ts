import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';

// rb-19 (residual R-m23-s11-X10) — the axe-core + real-browser a11y tier that
// M23-accessibility.spec.md §5.7 DECIDED should exist and that no M23 slice owned.
// Half 3 of `just a11y-e2e` runs this file; the nightly `a11y-e2e` job provisions
// the browser and the SpacetimeDB instance it needs. ADR-0218.
//
// WHY A BROWSER TIER AT ALL, given `just ci` already runs every a11y eval and every
// a11y unit spec. Those are SOURCE and JSDOM oracles: they prove an attribute is
// written, a listener is attached, a class is emitted. They structurally cannot
// answer "what does the accessibility tree actually look like once Chromium has
// applied CSS, computed visibility and resolved ARIA". Spec §5.6's own residual says
// so in as many words — "a scan cannot prove runtime identity; the nightly axe/E2E
// run is the compensating control". This file is that control.
//
// SCOPE OF THE CLAIM: WCAG 2.2 Level AA (spec §5.6). The tag list below is exactly
// that and no more. `best-practice` is deliberately NOT included — it is advisory,
// noisy, and outside the conformance claim; a gate that reds on advice trains people
// to ignore it. The `<canvas>` game surface is excluded because §5.6 places it
// outside the claim explicitly: it is covered by the live-region text mirror as an
// alternate version, not by the AX tree.
//
// NON-VACUITY IS THE WHOLE PROBLEM WITH THIS KIND OF TEST. `violations.length === 0`
// is also what a blank page, a page that threw during boot, and a page that never
// connected all report. Every state therefore asserts THREE things before it is
// allowed to conclude anything: the client is really connected (`ready`), the DOM
// the state promises is really on screen, and axe really evaluated a substantial
// rule set (`passes.length` floor). A scan of `about:blank` yields ~0 passes.
//
// FLAKE BUDGET: zero RNG. No encounters, no battles, no recruit rolls, no second
// player. Every wait polls a DOM or `__game()` predicate with a bounded timeout —
// no fixed sleeps. Measured wall clock, twice, on the reference tree: ~3 s.
//
// SHARED-WORLD HYGIENE (playwright.config.ts `workers: 1`, one published db):
// exactly one context, closed in afterAll. golden.spec.ts asserts an EXACT
// presenceCount === 2, so a leaked context here reds a DIFFERENT spec file and
// reads as an unrelated flake.

interface Tile {
  x: number;
  y: number;
}

interface Snap {
  identity: string;
  ownAuthTile: Tile | null;
}

type GameWindow = { __game?: () => Snap };

// WCAG 2.2 Level AA, the conformance claim in spec §5.6 — nothing wider.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// Non-vacuity floors, MEASURED on the reference tree (eca6752), twice, identical
// both runs: 16 / 21 / 23 rules passed. Pinned two below each measurement so an
// incidental markup change does not red the gate, while a page that failed to boot
// (~0 passes) cannot possibly clear it. RAISE these when a state gains content;
// LOWER only in a commit that deliberately removes some, and say which.
const PASSES_FLOOR_WORLD = 14;
const PASSES_FLOOR_HELP = 18;
const PASSES_FLOOR_MENU = 20;

// axe reports `incomplete` for checks it could not DECIDE — neither a pass nor a
// violation. On this client there is exactly one such rule, stable across runs:
// `color-contrast`, on text whose background is the game canvas and therefore not
// computable from the DOM. In the world state those are exactly #build-stamp and
// #help-hint — the SAME two elements residual rb-14 tracks
// (evals/contrast-ratio.eval.mjs + baselines/contrast-unresolved.json), so this
// ceiling is a live link to that work rather than a magic number.
//
// Two clauses, because they fail differently. The ID SET is closed: a NEW
// undecidable rule id appearing is a real signal, not noise, and must red. The NODE
// COUNT is a per-state CEILING that shrinks and never grows — it is what stops
// "axe cannot tell" from quietly becoming the answer for more and more of the UI.
// Measured twice, identical: world 2, help 23, menu 9. The overlays put far more
// text over the canvas than the persistent chrome does.
const INCOMPLETE_ALLOWED_IDS = ['color-contrast'];
const INCOMPLETE_CEILING_WORLD = 2;
const INCOMPLETE_CEILING_HELP = 23;
const INCOMPLETE_CEILING_MENU = 9;

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as GameWindow;
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    undefined,
    { timeout: 60_000 },
  );
}

interface AxeNode {
  target: unknown[];
}
interface AxeResult {
  id: string;
  impact?: string | null;
  nodes: AxeNode[];
}

/** Render a finding list into a message a reader can act on without re-running. */
function formatFindings(results: AxeResult[]): string {
  return results
    .map(
      (v) =>
        `${v.id} (impact=${v.impact ?? 'n/a'}, ${v.nodes.length} node(s)): ${v.nodes
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    )
    .join('\n');
}

/**
 * Scan one page state and assert it is clean AND that the scan was real.
 * `state` names the state in every failure message — with three states scanned by
 * one helper, an unlabelled failure cannot be attributed.
 */
async function scanState(
  page: Page,
  state: string,
  passesFloor: number,
  incompleteCeiling: number,
): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).exclude('canvas').analyze();

  // The scan really ran, in a real browser, against the real client. A stubbed or
  // mocked AxeBuilder would satisfy every assertion below this line but not these.
  expect(results.testEngine.name, `${state}: results did not come from axe-core`).toBe('axe-core');
  expect(results.url, `${state}: axe scanned the wrong origin`).toContain('localhost');

  expect(
    results.violations.map((v) => v.id),
    `${state}: axe reported WCAG 2.x A/AA violations —\n${formatFindings(results.violations)}`,
  ).toEqual([]);

  // NON-VACUITY. Zero violations is also what a blank page reports.
  expect(
    results.passes.length,
    `${state}: axe evaluated only ${results.passes.length} passing rule(s) (floor ${passesFloor}) — the page almost certainly did not render, and a scan of nothing reports zero violations`,
  ).toBeGreaterThanOrEqual(passesFloor);

  // The undecidable set is a shrink-only ceiling, not a waiver.
  const incompleteIds = results.incomplete.map((v) => v.id).sort();
  const unexpected = incompleteIds.filter((id) => !INCOMPLETE_ALLOWED_IDS.includes(id));
  expect(
    unexpected,
    `${state}: axe could not decide rule(s) outside the pinned set —\n${formatFindings(results.incomplete)}`,
  ).toEqual([]);
  const incompleteNodes = results.incomplete.reduce((n, v) => n + v.nodes.length, 0);
  expect(
    incompleteNodes,
    `${state}: ${incompleteNodes} undecidable node(s), ceiling ${incompleteCeiling} — this ceiling shrinks (residual rb-14), it never grows:\n${formatFindings(results.incomplete)}`,
  ).toBeLessThanOrEqual(incompleteCeiling);
}

test.describe
  .serial('rb-19 — axe-core over the real client', () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      // `newContext()`, not `newPage()`: @axe-core/playwright refuses a page created
      // directly on the browser ("Please use browser.newContext()").
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('the connected world chrome is free of WCAG 2.x A/AA violations', async () => {
      // The persistent chrome named in the §5.6 conformance scope. Assert one of its
      // members is really present first: `ready()` proves the socket, not the DOM.
      await expect(page.locator('#a11y-live')).toHaveCount(1);
      await scanState(page, 'world chrome', PASSES_FLOOR_WORLD, INCOMPLETE_CEILING_WORLD);
    });

    test('the help overlay is free of WCAG 2.x A/AA violations while open', async () => {
      // `?` is the documented opener (client/index.html #help-hint says so, and
      // main.ts gates it on `e.key === '?'`), which is Shift+Slash as a physical key.
      await page.keyboard.press('Shift+Slash');
      await expect(page.locator('#help-overlay')).toBeVisible();
      await scanState(page, 'help overlay', PASSES_FLOOR_HELP, INCOMPLETE_CEILING_HELP);
      await page.keyboard.press('Escape');
      await expect(page.locator('#help-overlay')).toBeHidden();
    });

    test('the menu overlay is free of WCAG 2.x A/AA violations while open', async () => {
      await page.keyboard.press('KeyM');
      await expect(page.locator('#menu-overlay')).toBeVisible();
      await scanState(page, 'menu overlay', PASSES_FLOOR_MENU, INCOMPLETE_CEILING_MENU);
      await page.keyboard.press('Escape');
      await expect(page.locator('#menu-overlay')).toBeHidden();
    });
  });
