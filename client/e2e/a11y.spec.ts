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

// Non-vacuity floors, pinned two below each measurement so an incidental markup
// change does not red the gate, while a page that failed to boot (~0 passes) cannot
// possibly clear it. RAISE these when a state gains content; LOWER only in a commit
// that deliberately removes some, and say which.
// ctl-7a re-measured on its build in Chromium, twice, identical both runs: world 16
// passes (floor 14), help 21 (floor 19; help is now an opaque .mr-frame), menu 25
// (floor 23; unchanged since ctl-5, which made the menu a nav frame with chrome).
const PASSES_FLOOR_WORLD = 14;
const PASSES_FLOOR_HELP = 19;
const PASSES_FLOOR_MENU = 23;

// axe reports `incomplete` for checks it could not DECIDE — neither a pass nor a
// violation. On this client there is exactly one such rule, stable across runs:
// `color-contrast`, on text whose background is the game canvas and therefore not
// computable from the DOM. In the world state that is #build-stamp alone (ctl-7a deleted
// #help-hint; the opaque Start/Select chips that replace it are decidable) — and there is
// NO shipped contrast oracle covering it: `evals/contrast-ratio.eval.mjs` and its
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
// ctl-7a re-measured on its build in Chromium, twice, identical both runs: world 1
// (#build-stamp), help 1 (#build-stamp; help is now an opaque .mr-frame, previously 23
// nodes of text over the canvas), menu 1 (#build-stamp). Each ceiling is that count.
const INCOMPLETE_ALLOWED_IDS = ['color-contrast'];
const INCOMPLETE_CEILING_WORLD = 1;
const INCOMPLETE_CEILING_HELP = 1;
const INCOMPLETE_CEILING_MENU = 1;

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

/** What `measureFrameInPage` reports for one open frame. */
interface FrameMeasure {
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly innerHeight: number;
  readonly innerWidth: number;
  /** The frame root's bounding box, or null when `frameSelector` matched nothing. */
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  } | null;
  /** How many visible elements with their own non-empty text node were measured. */
  readonly textElements: number;
  /** The measured text elements whose contrast is under 4.5:1 (worst case over the backdrop). */
  readonly lowContrast: ReadonlyArray<{
    readonly text: string;
    readonly ratio: number;
    readonly fg: string;
    readonly bg: string;
  }>;
}

/**
 * Measure one open frame INSIDE the page (Playwright serialises this function, so it must stay
 * self-contained: no closure over module scope).
 *
 * Contrast is the WCAG 2.x relative-luminance ratio. The effective background is found by walking
 * up from the text element, compositing every translucent `background-color` until the first
 * opaque one. A stack that reaches the root without an opaque layer sits over the game canvas,
 * whose pixels are unknown, so it is composited over BOTH white and black and the WORSE ratio is
 * kept: an honest bound, never an optimistic one.
 *
 * Excluded, each for a stated reason: `.sr-only` nodes (the 1px live region that is re-parented
 * into an open overlay is not visible text) and the text of a DISABLED form control (WCAG 1.4.3
 * exempts inactive user-interface components).
 */
function measureFrameInPage(frameSelector: string): FrameMeasure {
  type Rgba = [number, number, number, number];
  const parse = (css: string): Rgba => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (m === null) throw new Error(`unparseable computed colour: ${css}`);
    const parts = m[1]
      .split(/[ ,/]+/)
      .filter((s) => s !== '')
      .map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const over = (top: Rgba, base: Rgba): Rgba => {
    const a = top[3];
    return [
      top[0] * a + base[0] * (1 - a),
      top[1] * a + base[1] * (1 - a),
      top[2] * a + base[2] * (1 - a),
      1,
    ];
  };
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: Rgba): number =>
    0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const ratioOf = (a: Rgba, b: Rgba): number => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  /** Translucent-or-opaque background layers from `el` up, stopping at the first opaque one. */
  const layersOf = (el: Element): Rgba[] => {
    const out: Rgba[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) out.push(c);
      if (c[3] === 1) break;
    }
    return out;
  };
  const worstRatio = (fg: Rgba, layers: Rgba[]): { ratio: number; bg: Rgba } => {
    const opaque = layers.length > 0 && layers[layers.length - 1][3] === 1;
    const bases: Rgba[] = opaque
      ? [[0, 0, 0, 1]]
      : [
          [255, 255, 255, 1],
          [0, 0, 0, 1],
        ];
    let worst = { ratio: Number.POSITIVE_INFINITY, bg: [0, 0, 0, 1] as Rgba };
    for (const base of bases) {
      let bg: Rgba = base;
      for (let i = layers.length - 1; i >= 0; i -= 1) bg = over(layers[i], bg);
      const ratio = ratioOf(over(fg, bg), bg);
      if (ratio < worst.ratio) worst = { ratio, bg };
    }
    return worst;
  };
  const hasOwnText = (el: Element): boolean =>
    Array.from(el.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
    );
  const isVisible = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return (
      el.getClientRects().length > 0 &&
      cs.visibility !== 'hidden' &&
      cs.display !== 'none' &&
      box.width > 0 &&
      box.height > 0
    );
  };

  const root = document.querySelector(frameSelector);
  const scroller = document.scrollingElement ?? document.documentElement;
  const rootBox = root === null ? null : root.getBoundingClientRect();
  let textElements = 0;
  const lowContrast: Array<{ text: string; ratio: number; fg: string; bg: string }> = [];
  if (root !== null) {
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      if (!hasOwnText(el) || !isVisible(el)) continue;
      if (el.closest('.sr-only') !== null) continue;
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled')) {
        continue;
      }
      textElements += 1;
      const fgCss = getComputedStyle(el).color;
      const { ratio, bg } = worstRatio(parse(fgCss), layersOf(el));
      if (ratio < 4.5) {
        const text = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? '').trim())
          .join(' ')
          .slice(0, 60);
        lowContrast.push({
          text,
          ratio: Math.round(ratio * 100) / 100,
          fg: fgCss,
          bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
        });
      }
    }
  }
  return {
    scrollHeight: scroller.scrollHeight,
    scrollWidth: scroller.scrollWidth,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    rect:
      rootBox === null
        ? null
        : { left: rootBox.left, top: rootBox.top, right: rootBox.right, bottom: rootBox.bottom },
    textElements,
    lowContrast,
  };
}

/** The shared CTL7A.1 / .2 / .3 assertions over one measured frame. */
function expectFrameOk(m: FrameMeasure, label: string): void {
  expect(
    m.scrollHeight,
    `${label}: the page must never scroll (scrollHeight ${m.scrollHeight} > innerHeight ${m.innerHeight})`,
  ).toBeLessThanOrEqual(m.innerHeight);
  expect(
    m.scrollWidth,
    `${label}: the page must never scroll sideways (scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth})`,
  ).toBeLessThanOrEqual(m.innerWidth);
  expect(m.rect, `${label}: the frame root must exist and have a box`).not.toBeNull();
  const r = m.rect;
  if (r !== null) {
    const slack = 0.5;
    expect(
      [
        r.left >= -slack,
        r.top >= -slack,
        r.right <= m.innerWidth + slack,
        r.bottom <= m.innerHeight + slack,
      ],
      `${label}: the frame box ${JSON.stringify(r)} must lie within the ${m.innerWidth}x${m.innerHeight} viewport`,
    ).toEqual([true, true, true, true]);
  }
  // NON-VACUITY: a frame with no measurable text would report zero low-contrast nodes too.
  expect(m.textElements, `${label}: no visible text was measured inside the frame`).toBeGreaterThan(
    0,
  );
  expect(
    m.lowContrast,
    `${label}: text under 4.5:1 contrast — ${JSON.stringify(m.lowContrast)}`,
  ).toEqual([]);
}

/** What `measureActiveMarkInPage` reports for the active menu row against an inactive sibling. */
interface ActiveMark {
  readonly found: boolean;
  readonly activeBefore: string;
  readonly inactiveBefore: string;
  readonly activeOutline: string;
  readonly inactiveOutline: string;
  readonly activeBorder: string;
  readonly inactiveBorder: string;
  readonly nonColourDiffers: boolean;
}

/**
 * The active row's non-colour mark (CTL7A.3): measured INSIDE the page. The row passes when its
 * `::before` content differs from an inactive sibling's (a glyph), or it carries an outline /
 * border of at least 2px that the inactive sibling does not.
 */
function measureActiveMarkInPage(listSelector: string): ActiveMark {
  const list = document.querySelector(listSelector);
  const active = list?.querySelector('[role="option"].is-active') ?? null;
  const inactive = list?.querySelector('[role="option"]:not(.is-active)') ?? null;
  const empty: ActiveMark = {
    found: false,
    activeBefore: '',
    inactiveBefore: '',
    activeOutline: '',
    inactiveOutline: '',
    activeBorder: '',
    inactiveBorder: '',
    nonColourDiffers: false,
  };
  if (active === null || inactive === null) return empty;
  const before = (el: Element): string => getComputedStyle(el, '::before').content;
  const outline = (el: Element): string => {
    const cs = getComputedStyle(el);
    return `${cs.outlineStyle} ${cs.outlineWidth}`;
  };
  const border = (el: Element): string => {
    const cs = getComputedStyle(el);
    return `${cs.borderTopStyle} ${cs.borderTopWidth} ${cs.borderLeftStyle} ${cs.borderLeftWidth}`;
  };
  const thick = (el: Element, kind: 'outline' | 'border'): boolean => {
    const cs = getComputedStyle(el);
    return kind === 'outline'
      ? cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) >= 2
      : (cs.borderTopStyle !== 'none' && Number.parseFloat(cs.borderTopWidth) >= 2) ||
          (cs.borderLeftStyle !== 'none' && Number.parseFloat(cs.borderLeftWidth) >= 2);
  };
  const glyph = (value: string): boolean => value !== 'none' && value !== 'normal' && value !== '';
  const activeBefore = before(active);
  const inactiveBefore = before(inactive);
  const beforeDiffers = glyph(activeBefore) && activeBefore !== inactiveBefore;
  const outlineDiffers = thick(active, 'outline') && outline(active) !== outline(inactive);
  const borderDiffers = thick(active, 'border') && border(active) !== border(inactive);
  return {
    found: true,
    activeBefore,
    inactiveBefore,
    activeOutline: outline(active),
    inactiveOutline: outline(inactive),
    activeBorder: border(active),
    inactiveBorder: border(inactive),
    nonColourDiffers: beforeDiffers || outlineDiffers || borderDiffers,
  };
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
      // `?` is the documented opener (Select is bound to Slash / Shift+Slash, ctl-6b), which is
      // Shift+Slash as a physical key.
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
      // ctl-7a (named intentional change): this pass drove the #help-hint badge, which ctl-7a
      // deletes; the Start chip in the hint bar is the always-on native launcher that replaces it
      // (still [data-menu-launcher]), so the same Tab / Enter / Space contract now targets it.
      const hint = page.locator('#chip-start');
      const overlay = page.locator('#menu-overlay');
      const rows = page.locator('#menu-rows');

      let reached = false;
      for (let i = 0; i < 20 && !reached; i += 1) {
        await page.keyboard.press('Tab');
        reached = await page.evaluate(() => document.activeElement?.id === 'chip-start');
      }
      expect(reached, 'Tab never reached #chip-start within 20 presses').toBe(true);

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

      // KeyM only opens the menu while the world has focus; the previous test leaves focus on
      // the #chip-start launcher, so hand focus back to the world first.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');

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

    // ctl-7a (CTL7A.1 to CTL7A.3), the real-browser half. The unit tier parses styles.css and
    // index.html; only Chromium can say where a frame really lands and what colour its text really
    // paints, so each of the three frame kinds is measured here: the menu (an inner ui/frame.ts
    // .mr-frame inside a scrim shell), help (the shell IS the .mr-frame) and one index.html shell
    // (rename). Per frame: the page does not scroll, the frame's box lies inside the viewport, and
    // every visible text element reads at >= 4.5:1 against its computed background.
    test('CTL7A-E2E-MENU: with the Start chip pressing the menu open, the page does not scroll, the frame lies in the viewport, its text reads at >= 4.5:1, and the active row differs from a sibling by more than colour', async () => {
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      // The chip click is the real-browser proof of CTL7A.4's "clicking a chip presses its button".
      await page.locator('#chip-start').click();
      await expect(page.locator('#menu-overlay')).toBeVisible();
      await expect(page.locator('#menu-rows .is-active')).toHaveCount(1);

      const m = await page.evaluate(measureFrameInPage, '#menu-overlay .mr-frame');
      expectFrameOk(m, 'menu');

      const mark = await page.evaluate(measureActiveMarkInPage, '#menu-rows');
      expect(
        mark.found,
        `menu: need one .is-active row and one inactive sibling in #menu-rows (${JSON.stringify(mark)})`,
      ).toBe(true);
      expect(
        mark.nonColourDiffers,
        `menu: the active row must differ from an inactive sibling in a NON-colour computed property (::before content, or an outline / border of at least 2px) — ${JSON.stringify(mark)}`,
      ).toBe(true);

      await page.keyboard.press('Escape');
      await expect(page.locator('#menu-overlay')).toBeHidden();
    });

    test('CTL7A-E2E-HELP: with help open, the page does not scroll, the frame lies in the viewport and its text reads at >= 4.5:1', async () => {
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await page.locator('#chip-select').click();
      await expect(page.locator('#help-overlay')).toBeVisible();

      const m = await page.evaluate(measureFrameInPage, '#help-overlay');
      expectFrameOk(m, 'help');

      await page.keyboard.press('Escape');
      await expect(page.locator('#help-overlay')).toBeHidden();
    });

    test('CTL7A-E2E-SHELL: with an index.html shell open (rename), the page does not scroll, the frame lies in the viewport and its text reads at >= 4.5:1', async () => {
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      // N opens the rename shell from the world (a GUARD_ONLY overlay with no identity gate).
      await page.keyboard.press('KeyN');
      await expect(page.locator('#rename-overlay')).toBeVisible();
      // A draft enables the submit button, so its label is measured as live (not inactive) text.
      await page.locator('#rename-input').fill('abc');
      await expect(page.locator('#rename-submit')).toBeEnabled();

      const m = await page.evaluate(measureFrameInPage, '#rename-overlay');
      expectFrameOk(m, 'rename shell');

      // Close it for the next test. Escape does NOT work here: with focus on #rename-input
      // it leaves the overlay shown and moves focus to #rename-submit (a pre-existing
      // defect, also on master, tracked as a residual). Blur to <body> and press N instead:
      // main.ts's KeyN branch hides the rename overlay when it is visible.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await page.keyboard.press('KeyN');
      await expect(page.locator('#rename-overlay')).toBeHidden();
    });
  });
