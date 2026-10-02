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
  /**
   * Ancestors-or-self of a measured text element that paint through something the contrast oracle
   * cannot see: a `background-image`, a `filter` or a `mix-blend-mode` (ctl-7b). Each is reported
   * once, however many text elements sit under it.
   */
  readonly hostile: ReadonlyArray<{
    readonly node: string;
    readonly prop: string;
    readonly value: string;
  }>;
  /** Measured text elements whose box is not inside the root's box (0.5px slack). */
  readonly outsideRoot: ReadonlyArray<{ readonly text: string; readonly rect: string }>;
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
 * ctl-7b hardens the oracle against four ways of passing it falsely, each measured on the page:
 *  - OPACITY: the product of `opacity` over the element and every ancestor up to <html> is folded
 *    into the foreground alpha, so text dimmed by `opacity` (the old `opacity: 0.4` empties)
 *    cannot read as its undimmed colour;
 *  - `-webkit-text-fill-color`: when it differs from `color` it is what paints, so it is measured;
 *  - HOSTILE ANCESTORS: any ancestor-or-self with a `background-image`, a `filter` or a
 *    `mix-blend-mode` paints through something this colour arithmetic cannot see, and is reported;
 *  - the canvas mount: a layer walk that reaches `#app` stops there, because under it is the game
 *    canvas (unknown pixels), not the opaque <body> background the walk would otherwise land on.
 * It also reports every text element whose box is not inside the root's box.
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
  /**
   * Translucent-or-opaque background layers from `el` up, stopping at the first opaque one or at
   * the canvas mount `#app` (whatever sits under it is the game canvas, whose pixels are unknown).
   */
  const layersOf = (el: Element): Rgba[] => {
    const out: Rgba[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      if (n.id === 'app') break;
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

  /** The product of `opacity` over `el` and every ancestor up to <html>. */
  const opacityProduct = (el: Element): number => {
    let product = 1;
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      product *= Number.parseFloat(getComputedStyle(n).opacity);
    }
    return product;
  };
  const ownText = (el: Element): string =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent ?? '').trim())
      .join(' ')
      .slice(0, 60);
  const hostile: Array<{ node: string; prop: string; value: string }> = [];
  const walked = new Set<Element>();
  /** Report every ancestor-or-self of `el` (once) that paints through an image, filter or blend. */
  const checkHostile = (el: Element): void => {
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      if (walked.has(n)) break; // an ancestor chain already walked from here upward
      walked.add(n);
      const cs = getComputedStyle(n);
      const probes: Array<[string, string, string]> = [
        ['background-image', cs.backgroundImage, 'none'],
        ['filter', cs.filter, 'none'],
        ['mix-blend-mode', cs.mixBlendMode, 'normal'],
      ];
      for (const [prop, value, fine] of probes) {
        if (value !== fine) {
          hostile.push({
            node: `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}`,
            prop,
            value,
          });
        }
      }
    }
  };

  const root = document.querySelector(frameSelector);
  const scroller = document.scrollingElement ?? document.documentElement;
  const rootBox = root === null ? null : root.getBoundingClientRect();
  let textElements = 0;
  const lowContrast: Array<{ text: string; ratio: number; fg: string; bg: string }> = [];
  const outsideRoot: Array<{ text: string; rect: string }> = [];
  if (root !== null && rootBox !== null) {
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      if (!hasOwnText(el) || !isVisible(el)) continue;
      if (el.closest('.sr-only') !== null) continue;
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled')) {
        continue;
      }
      textElements += 1;
      checkHostile(el);
      const cs = getComputedStyle(el);
      // What paints is -webkit-text-fill-color (it defaults to the colour, so it only differs when
      // something set it), dimmed by the opacity of the element and of every ancestor.
      const fgCss =
        cs.webkitTextFillColor !== '' && cs.webkitTextFillColor !== cs.color
          ? cs.webkitTextFillColor
          : cs.color;
      const parsed = parse(fgCss);
      const dim = opacityProduct(el);
      const fg: Rgba = [parsed[0], parsed[1], parsed[2], parsed[3] * dim];
      const { ratio, bg } = worstRatio(fg, layersOf(el));
      if (ratio < 4.5) {
        lowContrast.push({
          text: ownText(el),
          ratio: Math.round(ratio * 100) / 100,
          fg: dim < 1 ? `${fgCss} at opacity ${Math.round(dim * 100) / 100}` : fgCss,
          bg: `rgb(${bg.slice(0, 3).map(Math.round).join(', ')})`,
        });
      }
      const box = el.getBoundingClientRect();
      const slack = 0.5;
      if (
        box.left < rootBox.left - slack ||
        box.top < rootBox.top - slack ||
        box.right > rootBox.right + slack ||
        box.bottom > rootBox.bottom + slack
      ) {
        outsideRoot.push({
          text: ownText(el),
          rect: `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}`,
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
    hostile,
    outsideRoot,
  };
}

/**
 * The shared CTL7A.1 / .2 / .3 assertions over one measured frame, plus (ctl-7b) the oracle's own
 * integrity: nothing it measured paints through an image, filter or blend mode, and every measured
 * text element lies inside the root's box. `scrolledText` opts out of the second clause for a root
 * that is DELIBERATELY shorter than its content (a scroll container in a short viewport), where
 * text below the fold is not a defect; the caller then proves reachability another way.
 */
function expectFrameOk(
  m: FrameMeasure,
  label: string,
  options: { readonly scrolledText?: boolean } = {},
): void {
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
  expect(
    m.hostile,
    `${label}: an ancestor of measured text paints through a background-image, a filter or a blend mode, which the contrast arithmetic cannot see — ${JSON.stringify(m.hostile)}`,
  ).toEqual([]);
  if (options.scrolledText !== true) {
    expect(
      m.outsideRoot,
      `${label}: text must lie inside the frame's box — ${JSON.stringify(m.outsideRoot)}`,
    ).toEqual([]);
  }
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

    // ctl-7a, WCAG 2.5.3 label-in-name: the chips show a button glyph ("Start", "Select") by CSS
    // `::before { content: attr(data-button) " " }` ahead of the verb, so the accessible name that
    // Chromium computes (it includes ::before content) must contain the visible label. Only a real
    // browser computes that name; happy-dom has no pseudo-element content.
    test('CTL7A-E2E-CHIP-NAMES: the hint-bar chips are named by their visible button label plus verb', async () => {
      await expect(page.getByRole('button', { name: 'Start Menu', exact: true })).toHaveAttribute(
        'id',
        'chip-start',
      );
      await expect(page.getByRole('button', { name: 'Select Help', exact: true })).toHaveAttribute(
        'id',
        'chip-select',
      );
    });

    // ctl-7a (CTL7A.1 to CTL7A.3), the real-browser half. The unit tier parses styles.css and
    // index.html; only Chromium can say where a frame really lands and what colour its text really
    // paints, so each of the three frame kinds is measured here: the menu (a .mr-shell holding the
    // ui/frame.ts .mr-frame; the shell has no scrim), help (the shell IS the .mr-frame) and one index.html shell
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

      // Close it for the next test. The first Escape in the text field only leaves typing mode
      // (focus moves to #rename-submit, ctl-6b), so blur to <body> and press N instead:
      // main.ts's KeyN branch hides the visible rename overlay.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await page.keyboard.press('KeyN');
      await expect(page.locator('#rename-overlay')).toBeHidden();
    });

    // -----------------------------------------------------------------------------------------
    // ctl-7b (CTL7B.1), the real-browser half: battle, box, raising and evolution are class-styled
    // `.mr-frame` roots under `#game-screen` (the unit tier reads their inline styles and
    // styles.css; only Chromium says where they land and what their text really paints).
    //
    // The four REAL roots are constructed hidden at boot by main.ts and appended to `#app`, so
    // each is found structurally: its title's ancestor whose parent is `#app`.
    // -----------------------------------------------------------------------------------------

    const blurToBody = async (): Promise<void> => {
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    };

    /** Tag the `#app` child that holds `testId`'s title, so `measureFrameInPage` can address it. */
    const tagAppRoot = (testId: string, tag: string): Promise<boolean> =>
      page.evaluate(
        ({ id, tagName }) => {
          let node: Element | null = document.querySelector(`[data-testid="${id}"]`);
          while (node !== null && node.parentElement?.id !== 'app') node = node.parentElement;
          if (node !== null) node.setAttribute('data-ctl7b-root', tagName);
          return node !== null;
        },
        { id: testId, tagName: tag },
      );

    const untagAppRoot = (): Promise<void> =>
      page.evaluate(() => {
        document.querySelector('[data-ctl7b-root]')?.removeAttribute('data-ctl7b-root');
      });

    const computedDisplayOfTagged = (tag: string): Promise<string> =>
      page.evaluate((tagName) => {
        const el = document.querySelector(`[data-ctl7b-root="${tagName}"]`);
        return el === null ? 'missing' : getComputedStyle(el).display;
      }, tag);

    test('CTL7B-E2E-ROOTS: the four real roots (battle, box, raising, evolution) are .mr-frame children of #app inside #game-screen, and only the battle carries the fixed layer classes', async () => {
      const roots = await page.evaluate(() =>
        ['battle', 'box', 'raising', 'evolution'].map((name) => {
          const titles = document.querySelectorAll(`[data-testid="${name}-title"]`);
          let node: Element | null = titles[0] ?? null;
          while (node !== null && node.parentElement?.id !== 'app') node = node.parentElement;
          const screen = node === null ? null : node.closest('#game-screen');
          return {
            name,
            titles: titles.length,
            appChild: node !== null,
            inGameScreen: screen !== null,
            classes: node === null ? [] : Array.from(node.classList).sort(),
          };
        }),
      );
      const frame = ['mr-frame', 'mr-shell'];
      expect(
        roots,
        'each real root is a direct child of #app (inside #game-screen) carrying exactly the frame ' +
          'classes; the battle adds .mr-shell--top (fixed, for E0) and .mr-shell--battle (its layer)',
      ).toEqual([
        {
          name: 'battle',
          titles: 1,
          appChild: true,
          inGameScreen: true,
          classes: [...frame, 'mr-shell--battle', 'mr-shell--top'],
        },
        { name: 'box', titles: 1, appChild: true, inGameScreen: true, classes: frame },
        { name: 'raising', titles: 1, appChild: true, inGameScreen: true, classes: frame },
        { name: 'evolution', titles: 1, appChild: true, inGameScreen: true, classes: frame },
      ]);
    });

    test('CTL7B-E2E-BOX: with the box open (KeyB), the page does not scroll, the frame lies in the viewport and its text reads at >= 4.5:1; the same key closes it', async () => {
      await blurToBody();
      await page.keyboard.press('KeyB');
      await expect(page.getByTestId('box-title')).toBeVisible();
      try {
        expect(await tagAppRoot('box-title', 'box'), 'the box title sits under a #app child').toBe(
          true,
        );
        const m = await page.evaluate(measureFrameInPage, '[data-ctl7b-root="box"]');
        expectFrameOk(m, 'box');
        await page.keyboard.press('KeyB');
        await expect.poll(() => computedDisplayOfTagged('box')).toBe('none');
      } finally {
        await untagAppRoot();
      }
    });

    test('CTL7B-E2E-RAISING: with the raising screen open (KeyI), the page does not scroll, the frame lies in the viewport and its text reads at >= 4.5:1; the same key closes it', async () => {
      await blurToBody();
      await page.keyboard.press('KeyI');
      await expect(page.getByTestId('raising-title')).toBeVisible();
      try {
        expect(
          await tagAppRoot('raising-title', 'raising'),
          'the raising title sits under a #app child',
        ).toBe(true);
        const m = await page.evaluate(measureFrameInPage, '[data-ctl7b-root="raising"]');
        expectFrameOk(m, 'raising');
        await page.keyboard.press('KeyI');
        await expect.poll(() => computedDisplayOfTagged('raising')).toBe('none');
      } finally {
        await untagAppRoot();
      }
    });

    test('CTL7B-E2E-EVOLUTION: with the evolution screen open (KeyE), the page does not scroll, the frame lies in the viewport and its text reads at >= 4.5:1; the same key closes it', async () => {
      await blurToBody();
      await page.keyboard.press('KeyE');
      await expect(page.getByTestId('evolution-title')).toBeVisible();
      try {
        expect(
          await tagAppRoot('evolution-title', 'evolution'),
          'the evolution title sits under a #app child',
        ).toBe(true);
        // The backdrop is translucent over the game canvas, so the root-level text is measured
        // over both a white and a black page (measureFrameInPage stops its layer walk at #app).
        const m = await page.evaluate(measureFrameInPage, '[data-ctl7b-root="evolution"]');
        expectFrameOk(m, 'evolution');
        await page.keyboard.press('KeyE');
        await expect.poll(() => computedDisplayOfTagged('evolution')).toBe('none');
      } finally {
        await untagAppRoot();
      }
    });

    // The battle is not reachable without an encounter (a real walk is out of this suite's budget:
    // e2e/encounter-battle.spec.ts E0 already proves the real layering). So the test imports the
    // view through the Vite dev server INSIDE the page and mounts a second BattleView into the
    // real #app with a fixture view-model, tagged `data-ctl7b-fixture`.
    //
    // The page-side code is passed to Playwright as a STRING. A function containing `import()` is
    // serialised after Playwright's own TypeScript transform, which is free to rewrite a dynamic
    // import into a `require()` that does not exist in the page; a string reaches the page as
    // written.
    const BATTLE_SPEC = '/src/ui/battleView.ts';
    const BATTLE_CARD =
      "{ speciesName: 'Sproutle', level: 6, currentHp: 16, maxHp: 22, hpPercent: 72, affinity: 'Plant', status: 'PSN' }";
    const BATTLE_FOE =
      "{ speciesName: 'Emberfang', level: 5, currentHp: 14, maxHp: 19, hpPercent: 73, affinity: 'Fire', status: 'BRN' }";
    /** An ongoing PvE battle: both cards with a status badge, a weather banner, two skills, Flee and a Swap. */
    const BATTLE_ONGOING = `{
      battleId: 9001n, turnNumber: 3, outcome: 'Ongoing',
      playerCard: ${BATTLE_CARD}, opponentCard: ${BATTLE_FOE},
      skills: [
        { id: 1, name: 'Vine Whip', affinity: 'Plant', power: 40, accuracy: 100 },
        { id: 2, name: 'Tackle', affinity: 'Normal', power: 35, accuracy: 95 },
      ],
      canFlee: true, canSwap: true,
      bench: [{ teamIndex: 1, speciesName: 'Mossling', currentHp: 12, maxHp: 18 }],
      canRecruit: false, baitOptions: [], cureItems: [],
      weather: { label: 'Rain', turnsRemaining: 3 },
      isPvp: false, pvpPendingSubmit: false, pvpOpponentName: null,
    }`;
    /** The same battle won: the outcome banner and the Esc hint show, the controls are gone. */
    const BATTLE_WON = `{
      battleId: 9001n, turnNumber: 4, outcome: 'SideAWins',
      playerCard: ${BATTLE_CARD}, opponentCard: ${BATTLE_FOE},
      skills: [], canFlee: false, canSwap: false, bench: [],
      canRecruit: false, baitOptions: [], cureItems: [],
      weather: null,
      isPvp: false, pvpPendingSubmit: false, pvpOpponentName: null,
    }`;
    const MOUNT_BATTLE = `(async () => {
      const mod = await import(${JSON.stringify(BATTLE_SPEC)});
      const noop = () => {};
      const app = document.getElementById('app');
      if (app === null) throw new Error('#app is missing');
      const view = new mod.BattleView(app, {
        onAttack: noop, onFlee: noop, onSwap: noop, onRecruit: noop,
        onUseItem: noop, onPvpAttack: noop, onPvpSwap: noop,
      });
      app.lastElementChild.setAttribute('data-ctl7b-fixture', '1');
      window.__ctl7bBattle = view;
      return true;
    })()`;
    const showBattle = async (vm: string): Promise<void> => {
      await page.evaluate(
        `(() => { const v = window.__ctl7bBattle; v.refresh(${vm}); v.show(); })()`,
      );
    };
    const REMOVE_BATTLE = `(() => {
      const v = window.__ctl7bBattle;
      if (v) v.hide();
      for (const n of document.querySelectorAll('[data-ctl7b-fixture]')) n.remove();
      delete window.__ctl7bBattle;
    })()`;

    test('CTL7B-E2E-BATTLE: a mounted battle, ongoing and won, is a frame inside the viewport at >= 4.5:1, layered between the shells and the menu, and at 640x360 its title stays reachable', async () => {
      await blurToBody();
      const original = page.viewportSize();
      try {
        await page.evaluate(MOUNT_BATTLE);
        await showBattle(BATTLE_ONGOING);
        const fixture = page.locator('[data-ctl7b-fixture]');
        await expect(fixture).toBeVisible();

        const ongoing = await page.evaluate(measureFrameInPage, '[data-ctl7b-fixture]');
        expectFrameOk(ongoing, 'battle (ongoing)');

        // The layer, as Chromium cascades it: the fixed position E0 needs, above every shell and
        // under the menu and help that open over a battle.
        const layers = await page.evaluate(() => {
          const z = (selector: string): string => {
            const el = document.querySelector(selector);
            return el === null ? 'missing' : getComputedStyle(el).zIndex;
          };
          const root = document.querySelector('[data-ctl7b-fixture]');
          return {
            position: root === null ? 'missing' : getComputedStyle(root).position,
            battle: z('[data-ctl7b-fixture]'),
            shell: z('#rename-overlay'),
            menu: z('#menu-overlay'),
            help: z('#help-overlay'),
          };
        });
        expect(
          layers,
          'battle z-index sits between the shells (100) and the menu / help (120)',
        ).toEqual({
          position: 'fixed',
          battle: '110',
          shell: '100',
          menu: '120',
          help: '120',
        });

        await showBattle(BATTLE_WON);
        await expect(
          page.locator('[data-ctl7b-fixture] [data-testid="outcome-text"]'),
        ).toBeVisible();
        const won = await page.evaluate(measureFrameInPage, '[data-ctl7b-fixture]');
        expectFrameOk(won, 'battle (won)');

        // A short viewport: the ongoing battle is taller than the box, so it scrolls inside its
        // frame, and `justify-content: safe center` keeps its top (the title) reachable at
        // scrollTop 0 — a plain `center` would push the title above the frame's top edge.
        await page.setViewportSize({ width: 640, height: 360 });
        await showBattle(BATTLE_ONGOING);
        const small = await page.evaluate(measureFrameInPage, '[data-ctl7b-fixture]');
        expectFrameOk(small, 'battle (ongoing, 640x360)', { scrolledText: true });
        const reach = await page.evaluate(() => {
          const root = document.querySelector('[data-ctl7b-fixture]') as HTMLElement | null;
          const title = root?.querySelector('[data-testid="battle-title"]') ?? null;
          if (root === null || title === null) return null;
          root.scrollTop = 0;
          const frame = root.getBoundingClientRect();
          const head = title.getBoundingClientRect();
          return {
            scrollable: root.scrollHeight > root.clientHeight + 1,
            titleInside:
              head.top >= frame.top - 0.5 &&
              head.bottom <= frame.bottom + 0.5 &&
              head.left >= frame.left - 0.5 &&
              head.right <= frame.right + 0.5,
          };
        });
        expect(
          reach,
          'at 640x360 the ongoing battle must scroll inside its frame (non-vacuity) AND show its ' +
            'title inside the frame at scrollTop 0',
        ).toEqual({ scrollable: true, titleInside: true });

        await page.evaluate('window.__ctl7bBattle.hide()');
        await expect(fixture).toBeHidden();
        const closed = await page.evaluate(() => {
          const root = document.querySelector('[data-ctl7b-fixture]');
          return root === null ? 'missing' : getComputedStyle(root).display;
        });
        expect(closed, 'a hidden battle computes display:none').toBe('none');
      } finally {
        await page.evaluate(REMOVE_BATTLE);
        if (original !== null) await page.setViewportSize(original);
      }
    });
  });
