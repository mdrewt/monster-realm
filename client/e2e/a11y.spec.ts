import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { t } from '../src/ui/a11yCopy';

// the axe-core + real-browser a11y tier that M23-accessibility.spec.md §5.7 DECIDED
// should exist and that no M23 slice owned.
//
// WHERE THIS RUNS. playwright.config.ts has `testDir: './e2e'`, so `just e2e` collects
// this file and the PER-PR `e2e:` job in ci.yml runs it. That is deliberate, not an
// oversight: it costs ~3s in a job that already has a browser and a server, and
// excluding it would need a `--grep-invert` neuter-shaped construct in the `e2e`
// recipe. If your PR reds here, it red on a real WCAG A/AA violation in the
// rendered page — read the failure message, it names the rule and the nodes.
//
// AND WHERE IT DELIBERATELY DOES NOT RUN. The `reduced-motion`
// project added to `client/playwright.config.ts` carries a `testMatch` naming ONLY
// `reduced-motion.spec.ts`, so this file is NOT collected under forced reduced
// motion. That is a decision, not an omission: a second project collecting this file
// is a second context on it under another name, which the SORT ORDER note below
// forbids; no rule in this suite's `wcag2a/2aa/21a/21aa/22aa` tag set has a
// `prefers-reduced-motion`-dependent outcome (SC 2.3.3 is Level AAA, outside the
// §5.6 claim); and it would run every test here twice. Do not drop that
// `testMatch` without re-reading ADR-0219 D2.
//
// SORT ORDER, considered. Playwright orders spec FILES by path, so `a11y` runs
// first, ahead of `golden.spec.ts` — the opposite of the `trade-interlock.spec.ts`
// precedent, which was NAMED to sort after golden to avoid its `presenceCount === 2`
// assertion. It is safe here for a reason that does not apply to that file: this
// suite joins exactly ONE player and closes its browser in afterAll, the server
// deletes the `player` row on `client_disconnected`, and golden's presence check is
// a convergence WAIT rather than an instant assertion, so a lagging disconnect
// self-heals. Adding a second context here would break that and must not be done
// without renaming the file.
//
// WHY A BROWSER TIER AT ALL, given `just ci` already runs every
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
// #help-hint — and there is NO shipped contrast
// oracle covering them: `evals/contrast-ratio.eval.mjs` and its
// `baselines/contrast-unresolved.json` were specified but never landed, and remain
// the open residual rb-14 (which records that they did not ship).
// So these numbers have no upstream to agree with, which makes the ceiling MORE
// load-bearing rather than less: until rb-14 lands, this is the only thing in the
// repo that notices the undecidable set growing.
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
    // 30s, not more: playwright.config.ts sets `timeout: 45_000` and a beforeAll
    // hook is bounded by the TEST timeout, which also has to cover browser launch
    // and the initial goto. A larger number here is unreachable and would only
    // mislead. Matches golden.spec.ts's precedent for the identical wait.
    { timeout: 30_000 },
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
    `${state}: ${incompleteNodes} undecidable node(s), ceiling ${incompleteCeiling} — this ceiling shrinks (see the open residual rb-14), it never grows:\n${formatFindings(results.incomplete)}`,
  ).toBeLessThanOrEqual(incompleteCeiling);
}

/**
 * Assert #a11y-live is present in Chromium's FULL accessibility tree, not ignored, and still
 * polite. Matched by backend DOM node id, so a text child or another region cannot stand in.
 */
async function expectLiveRegionExposed(
  context: BrowserContext,
  page: Page,
  state: string,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#a11y-live',
    });
    expect(nodeId, `${state}: #a11y-live is not in the DOM`).not.toBe(0);
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree', {});
    const ax = nodes.find((n) => n.backendDOMNodeId === node.backendNodeId);
    expect(
      ax,
      `${state}: #a11y-live is missing from the accessibility tree (pruned — it would be silent)`,
    ).toBeDefined();
    expect(ax?.ignored, `${state}: #a11y-live is in the AX tree but ignored`).toBe(false);
    const live = ax?.properties?.find((p) => p.name === 'live')?.value.value;
    expect(live, `${state}: #a11y-live lost its polite live-region semantics`).toBe('polite');
  } finally {
    await cdp.detach();
  }
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

    // CT-src-render-world#canvas-aria: the live canvas carries the world-region ARIA that
    // render/world.ts writes in init(), and #app itself carries no role.
    test('the live world canvas is an application region with the catalog name, and #app has no role', async () => {
      const canvas = page.locator('#app canvas');
      await expect(canvas).toHaveCount(1);
      await expect(canvas).toHaveAttribute('role', 'application');
      await expect(canvas).toHaveAttribute('tabindex', '0');
      const label = t('a11y.world.region');
      expect(label.trim(), 'catalog copy for a11y.world.region is empty').not.toBe('');
      await expect(canvas).toHaveAttribute('aria-label', label);
      expect(await page.locator('#app').getAttribute('role'), '#app must carry no role').toBeNull();
    });

    // #a11y-live must be EXPOSED in Chromium's accessibility tree in every state, not merely
    // present in the DOM: a live region stranded under a display:none ancestor is pruned from the
    // AX tree entirely and goes silent. Exposure is re-asserted independently per state. This is
    // NOT an inertness oracle — Chromium does not model aria-modal inertness. While the menu is
    // open the region must also sit INSIDE the open overlay (EV-overlay-live-region-custody's
    // custody rule, asserted behaviourally), since aria-modal tells AT to ignore everything outside.
    test('the #a11y-live region stays exposed in the accessibility tree: world, menu open (inside the overlay), and after close', async () => {
      await expectLiveRegionExposed(context, page, 'world');

      await page.keyboard.press('KeyM');
      await expect(page.locator('#menu-overlay')).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const overlay = document.getElementById('menu-overlay');
              const live = document.getElementById('a11y-live');
              return overlay !== null && live !== null && overlay.contains(live);
            }),
          { message: 'menu open: #a11y-live must be re-parented INSIDE #menu-overlay' },
        )
        .toBe(true);
      await expectLiveRegionExposed(context, page, 'menu open');

      await page.keyboard.press('Escape');
      await expect(page.locator('#menu-overlay')).toBeHidden();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.getElementById('a11y-live')?.parentElement?.tagName ?? 'MISSING',
            ),
          { message: 'after close: #a11y-live must be back as a direct <body> child' },
        )
        .toBe('BODY');
      await expectLiveRegionExposed(context, page, 'after close');
    });

    // EV-keyboard-operable-rows new home: Tab reaches the menu launcher, Enter and Space both
    // activate it, and the menu listbox rows are operable from the keyboard alone.
    test('keyboard pass: Tab reaches the launcher, Enter/Space open the menu, arrows/Enter operate its rows', async () => {
      const hint = page.locator('#help-hint');
      const overlay = page.locator('#menu-overlay');
      const rows = page.locator('#menu-rows');

      let reached = false;
      for (let i = 0; i < 20 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.id === 'help-hint');
      }
      expect(reached, 'Tab never reached #help-hint within 20 presses').toBe(true);

      // Enter on the focused launcher opens the menu, and focus lands on the listbox.
      await page.keyboard.press('Enter');
      await expect(overlay).toBeVisible();
      await expect(rows).toBeFocused();
      const first = await rows.getAttribute('aria-activedescendant');
      // The earlier KeyM tests open and close without moving the cursor, so it is still on the
      // first root entry (the cursor is remembered across opens within a page session).
      expect(first, 'menu opened with no active option').toBe('menu-root-monsters');

      // ArrowDown x3 moves monsters -> bag -> journal -> social; A (Enter) enters the Social
      // sub-list; B (Backspace) backs out to the root with the cursor on Social.
      await page.keyboard.press('ArrowDown');
      await expect(rows).toHaveAttribute('aria-activedescendant', 'menu-root-bag');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await expect(rows).toHaveAttribute('aria-activedescendant', 'menu-root-social');
      await page.keyboard.press('Enter');
      await expect(rows).toHaveAttribute('aria-activedescendant', /^menuSocial-root-/);
      await page.keyboard.press('Backspace');
      await expect(rows).toHaveAttribute('aria-activedescendant', 'menu-root-social');
      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();

      // Space activates the native launcher too (it must not be swallowed as a world jump).
      await hint.focus();
      await expect(hint).toBeFocused();
      await page.keyboard.press('Space');
      await expect(overlay).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();
    });

    // CTL5.6, the real-browser proof of focus returning to the parent nav container: a child
    // opened from the menu closes with B, and focus lands on #menu-rows (not <body> or the closed
    // child), so the next key press still drives the menu. The unit tier cannot see this: happy-dom
    // does not refuse a focus() on a visibility:hidden element, Chromium does.
    test('keyboard pass: a child opened over the menu closes with Backspace and focus returns to #menu-rows; Escape then closes the menu', async () => {
      const overlay = page.locator('#menu-overlay');
      const rows = page.locator('#menu-rows');
      const box = page.getByTestId('box-title');

      await page.keyboard.press('KeyM');
      await expect(overlay).toBeVisible();
      await expect(rows).toBeFocused();

      // The cursor is remembered across opens, so walk it to Monsters (ArrowUp wraps, at most 7).
      for (let i = 0; i < 8; i += 1) {
        if ((await rows.getAttribute('aria-activedescendant')) === 'menu-root-monsters') break;
        await page.keyboard.press('ArrowUp');
      }
      await expect(rows).toHaveAttribute('aria-activedescendant', 'menu-root-monsters');

      // A on Monsters opens the box above the menu; the menu stays open beneath it.
      await page.keyboard.press('Enter');
      await expect(box).toBeVisible();
      await expect(overlay).toBeAttached();

      // B closes only the box, and focus is back on the menu's nav container.
      await page.keyboard.press('Backspace');
      await expect(box).toBeHidden();
      await expect(overlay).toBeVisible();
      await expect(rows).toBeFocused();
      await expect(rows).toHaveAttribute('aria-activedescendant', 'menu-root-monsters');

      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();
    });
  });
