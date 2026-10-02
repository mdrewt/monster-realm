/**
 * indexShell.smoke.test.ts: parses the REAL client/index.html and checks the shell contract
 * against the production overlay registry (OVERLAY_A11Y), then (ctl-7a, CTL7A.1 to CTL7A.4) the
 * `#game-screen` wrap, the framed shells, the frame colour tokens parsed out of the REAL
 * client/src/styles.css, and the Start / Select hint-bar chips.
 *
 * The ctl-7a cases read two real files and nothing else: no layout engine runs here, so the
 * viewport and contrast claims are proved structurally (a class rule that places the shell inside
 * the screen by construction; tokens whose WCAG ratio is computed from their declared values) and
 * in a real browser by e2e/a11y.spec.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './ui/overlayRegistry';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(SRC_DIR, '..', 'index.html');
const STYLES_CSS = path.join(SRC_DIR, 'styles.css');
// A detached window with resource loading off: parsing must never fetch styles.css or main.ts.
const win = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    disableJavaScriptEvaluation: true,
  },
});
const doc = new win.DOMParser().parseFromString(
  readFileSync(INDEX_HTML, 'utf8'),
  'text/html',
) as unknown as Document;

/** Overlays whose shells main.ts constructs at runtime: no static anchor in index.html. */
const CONSTRUCTED: ReadonlySet<OverlayId> = new Set<OverlayId>([
  'battleView',
  'boxView',
  'raisingView',
  'evolutionView',
  'claimView',
  'privacyView',
]);

const NATIVE_FOCUSABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']);

/** The anchor itself or its nearest ancestor that is a direct child of `#frame-layer` (ctl-7a:
 *  the shells no longer sit directly under <body>; they sit in the frame layer of #game-screen). */
function shellRoot(anchor: Element): Element | null {
  for (let el: Element | null = anchor; el !== null; el = el.parentElement) {
    if (el.parentElement?.id === 'frame-layer') return el;
  }
  return null;
}

describe('index.html shell contract', () => {
  it('mounts #app (inside #game-screen) and loads exactly one module script by src, with no inline script', () => {
    // ctl-7a (named intentional change): #app used to be a direct <body> child; it is now the
    // canvas mount inside #game-screen (the wrap itself is pinned by its own case below).
    const app = doc.getElementById('app');
    expect(app?.parentElement?.id).toBe('game-screen');
    expect(app?.closest('body')).not.toBeNull();
    const scripts = Array.from(doc.querySelectorAll('script'));
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('type')).toBe('module');
    expect(scripts[0].getAttribute('src')).toBeTruthy();
    expect((scripts[0].textContent ?? '').trim()).toBe('');
  });

  it('has exactly one live region: #a11y-live, polite + atomic, a direct empty <body> child outside #app', () => {
    const live = Array.from(doc.querySelectorAll('[aria-live]'));
    expect(live.map((el) => el.id)).toEqual(['a11y-live']);
    expect(doc.querySelectorAll('#a11y-live')).toHaveLength(1);
    const node = live[0];
    expect(node.getAttribute('aria-live')).toBe('polite');
    expect(node.getAttribute('aria-atomic')).toBe('true');
    expect(node.parentElement?.tagName).toBe('BODY');
    expect(doc.getElementById('app')?.contains(node)).toBe(false);
    expect(node.classList.contains('sr-only')).toBe(true);
    expect(node.hasAttribute('aria-hidden') || node.hasAttribute('hidden')).toBe(false);
    expect(node.getAttribute('style')).toBeNull();
    expect((node.textContent ?? '').trim()).toBe('');
  });

  it.each(OVERLAY_IDS.map((id) => [id]))(
    '%s: static shell ARIA and anchor focusability match OVERLAY_A11Y',
    (id) => {
      const meta = OVERLAY_A11Y[id];
      const anchor = doc.querySelector(meta.initialFocusSelector);
      if (CONSTRUCTED.has(id)) {
        expect(anchor, `${id} is constructed at runtime; its anchor must not be static`).toBeNull();
        return;
      }
      expect(
        anchor,
        `${id}: ${meta.initialFocusSelector} must resolve in index.html`,
      ).not.toBeNull();
      if (anchor === null) return;
      const root = shellRoot(anchor);
      expect(root, `${id}: anchor must sit inside a direct #frame-layer child`).not.toBeNull();
      expect(root?.getAttribute('role')).toBe(meta.role);
      expect(root?.getAttribute('aria-modal')).toBe('true');
      for (const banned of ['aria-hidden', 'aria-label', 'aria-labelledby']) {
        expect(root?.hasAttribute(banned), `${id}: shell root must not carry ${banned}`).toBe(
          false,
        );
      }
      const tabindex = anchor.getAttribute('tabindex');
      if (NATIVE_FOCUSABLE.has(anchor.tagName)) {
        expect(tabindex, `${id}: a native control must carry no tabindex`).toBeNull();
      } else {
        // menuView's listbox holds DOM focus (aria-activedescendant); passive anchors use -1.
        expect(tabindex).toBe(id === 'menuView' ? '0' : '-1');
      }
    },
  );

  it('every role-bearing element is a registry shell, and no tabindex exceeds 0', () => {
    const roots = new Set(
      OVERLAY_IDS.map((id) => doc.querySelector(OVERLAY_A11Y[id].initialFocusSelector))
        .filter((a): a is Element => a !== null)
        .map(shellRoot),
    );
    const strays = Array.from(doc.querySelectorAll('body [role], body [id$="-overlay"]'))
      .filter((el) => !roots.has(el))
      .map((el) => el.id || el.tagName);
    expect(strays).toEqual([]);
    const bad = Array.from(doc.querySelectorAll('[tabindex]'))
      .map((el) => el.getAttribute('tabindex') ?? '')
      .filter((raw) => !/^-?\d+$/.test(raw) || Number.parseInt(raw, 10) > 0);
    expect(bad).toEqual([]);
  });
});

// ============================================================================================
// ctl-7a: #game-screen, framed shells, frame tokens, hint-bar chips.
// ============================================================================================

// --- a minimal, honest CSS reader ----------------------------------------------------------
// Comments are stripped FIRST (the sheet's own comments quote selectors and declarations, which a
// text scan would mistake for rules), then top-level blocks are walked with a brace counter that
// skips strings; `@media` blocks are recursed into and remember their prelude.

interface CssRule {
  /** The at-rule preludes this rule sits inside, outermost first (empty at the top level). */
  readonly at: readonly string[];
  readonly selectors: readonly string[];
  /** Declarations in source order, property names lower-cased except custom properties. */
  readonly decls: ReadonlyArray<readonly [string, string]>;
}

function stripCssComments(css: string): string {
  let out = '';
  let quote = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (quote !== '') {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = '';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index of the first `target` at or after `from` outside strings and parentheses, or -1. */
function findOutside(text: string, target: string, from: number): number {
  let quote = '';
  let parens = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parens += 1;
    else if (ch === ')') parens -= 1;
    else if (ch === target && parens === 0) return i;
  }
  return -1;
}

/** Index of the `}` closing the `{` at `open`, string-aware. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error('styles.css: unbalanced braces');
}

function splitOutside(text: string, sep: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = findOutside(text, sep, from);
    if (at === -1) {
      parts.push(text.slice(from));
      return parts;
    }
    parts.push(text.slice(from, at));
    from = at + 1;
  }
}

function parseDecls(body: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const raw of splitOutside(body, ';')) {
    const colon = raw.indexOf(':');
    if (colon === -1) continue;
    const prop = raw.slice(0, colon).trim();
    const value = raw
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, ' ');
    if (prop === '') continue;
    out.push([prop.startsWith('--') ? prop : prop.toLowerCase(), value]);
  }
  return out;
}

function parseCss(css: string, at: readonly string[] = []): CssRule[] {
  const rules: CssRule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = findOutside(css, '{', i);
    if (open === -1) break;
    const close = matchBrace(css, open);
    let prelude = css.slice(i, open).trim();
    const semi = prelude.lastIndexOf(';');
    if (semi !== -1) prelude = prelude.slice(semi + 1).trim();
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
        rules.push(...parseCss(body, [...at, prelude.replace(/\s+/g, ' ')]));
      }
    } else if (prelude !== '') {
      rules.push({
        at,
        selectors: splitOutside(prelude, ',').map((s) => s.trim().replace(/\s+/g, ' ')),
        decls: parseDecls(body),
      });
    }
    i = close + 1;
  }
  return rules;
}

const STYLES = parseCss(stripCssComments(readFileSync(STYLES_CSS, 'utf8')));

/** The top-level (no at-rule) rules whose selector LIST contains exactly `selector`. */
function rulesFor(selector: string): CssRule[] {
  return STYLES.filter((r) => r.at.length === 0 && r.selectors.includes(selector));
}

/** The cascade of `rules` in source order: the last declaration of each property wins. */
function cascade(rules: readonly CssRule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) for (const [prop, value] of rule.decls) out.set(prop, value);
  return out;
}

// --- sides and colours ----------------------------------------------------------------------

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/** The four inset sides after applying `inset` and the longhands in source order. */
function insetSides(rules: readonly CssRule[]): Record<Side, string | undefined> {
  const sides: Record<Side, string | undefined> = {
    top: undefined,
    right: undefined,
    bottom: undefined,
    left: undefined,
  };
  for (const rule of rules) {
    for (const [prop, value] of rule.decls) {
      if (prop === 'inset') {
        const v = value.split(' ');
        const [t, r = t, b = t, l = r] = v;
        sides.top = t;
        sides.right = r;
        sides.bottom = b;
        sides.left = l;
      } else if ((SIDES as readonly string[]).includes(prop)) {
        sides[prop as Side] = value;
      }
    }
  }
  return sides;
}

/** True for `0`, a non-negative length / percentage, or a `calc()` / `var()` that is not
 *  written with a leading minus. */
function isNonNegativeLength(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value === '0') return true;
  if (/^\d+(\.\d+)?(px|rem|em|vh|vw|vmin|vmax|svh|dvh|%)$/.test(value)) return true;
  return /^(calc|var)\(/.test(value) && !value.includes('(-');
}

type Rgba = readonly [number, number, number, number];

function parseColour(raw: string): Rgba {
  const value = raw.trim().toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) throw new Error(`unsupported colour: ${raw}`);
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex;
    if (full.length !== 6 && full.length !== 8) throw new Error(`unsupported colour: ${raw}`);
    const channel = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16);
    return [channel(0), channel(2), channel(4), full.length === 8 ? channel(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (fn !== null) {
    const parts = fn[1]
      .split(/[ ,/]+/)
      .filter((s) => s !== '')
      .map(Number);
    if (parts.length >= 3 && parts.every((p) => Number.isFinite(p))) {
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    }
  }
  throw new Error(`unsupported colour (use #hex or rgb()): ${raw}`);
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// --- document facts ------------------------------------------------------------------------

function must(id: string): HTMLElement {
  const el = doc.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in client/index.html`);
  return el;
}

const NINE_SHELL_IDS = [
  'dialogue-overlay',
  'quest-log-overlay',
  'heal-overlay',
  'shop-overlay',
  'trade-overlay',
  'pvp-challenge-overlay',
  'leaderboard-overlay',
  'rename-overlay',
  'tradepropose-overlay',
] as const;
/** The ten roots that carry `.mr-frame`: the nine shells plus help. */
const FRAMED_IDS: readonly string[] = [...NINE_SHELL_IDS, 'help-overlay'];
/** Every root inside #frame-layer; the menu hosts its own ui/frame.ts `.mr-frame`. */
const FRAME_LAYER_IDS: readonly string[] = [...FRAMED_IDS, 'menu-overlay'];

/** Every id-bearing descendant each root shipped before ctl-7a (client/index.html at 8e4d49b7). */
const INNER_IDS: Readonly<Record<string, readonly string[]>> = {
  'dialogue-overlay': ['dialogue-npc-name', 'dialogue-node-text', 'dialogue-choices'],
  'quest-log-overlay': ['quest-log-list'],
  'heal-overlay': ['heal-list'],
  'shop-overlay': ['shop-title', 'shop-for-sale', 'shop-inventory', 'shop-feedback'],
  'trade-overlay': [
    'trade-status',
    'trade-my-side',
    'trade-their-side',
    'trade-actions',
    'trade-feedback',
  ],
  'pvp-challenge-overlay': [
    'pvp-challenge-status',
    'pvp-challenge-incoming',
    'pvp-challenge-outgoing',
    'pvp-player-list',
    'pvp-challenge-feedback',
  ],
  'leaderboard-overlay': ['leaderboard-title', 'leaderboard-list'],
  'rename-overlay': ['rename-current', 'rename-input', 'rename-submit', 'rename-feedback'],
  'tradepropose-overlay': [
    'tradepropose-target',
    'tradepropose-monsters',
    'tradepropose-offer-currency',
    'tradepropose-request-currency',
    'tradepropose-submit',
    'tradepropose-feedback',
  ],
  'help-overlay': ['help-title', 'help-controls', 'help-goals'],
  'menu-overlay': ['menu-heading', 'menu-rows', 'menu-back-hint'],
};

/** The data-testid values index.html shipped (each equals its element's id). */
const TEST_IDS: readonly string[] = [
  'rename-current',
  'rename-input',
  'rename-submit',
  'rename-feedback',
  'tradepropose-target',
  'tradepropose-monsters',
  'tradepropose-offer-currency',
  'tradepropose-request-currency',
  'tradepropose-submit',
  'tradepropose-feedback',
];

const bodyElementChildren = (): Element[] =>
  Array.from(doc.body.children).filter((el) => el.tagName !== 'SCRIPT');

describe('ctl-7a: the game screen, framed shells, frame tokens and hint-bar chips (index.html + styles.css)', () => {
  it('CTL7A-1-GAME-SCREEN-WRAP: #game-screen is a <body> child wrapping #app, #frame-layer and #hint-bar in that order, and #app is still a plain <div id="app">', () => {
    // WRONG IMPL KILLED: no wrap (the canvas, shells and hint bar stay loose body children and
    // the page can scroll); a wrap in the wrong order (the frame layer would paint under the
    // canvas); a stowaway body child or a missing #build-stamp / #a11y-live (both must stay direct
    // body children: the live region's custody rule and the build stamp's fixed corner depend on
    // it); an #app that is a different tag or already holds children (the renderer owns its
    // content).
    expect(doc.querySelectorAll('#game-screen')).toHaveLength(1);
    const screen = must('game-screen');
    expect(screen.parentElement?.tagName, '#game-screen is a direct <body> child').toBe('BODY');
    expect(
      screen.classList.contains('mr-game-screen'),
      '#game-screen carries .mr-game-screen',
    ).toBe(true);
    expect(
      Array.from(screen.children).map((el) => el.id),
      '#game-screen holds exactly the canvas mount, the frame layer and the hint bar, in order',
    ).toEqual(['app', 'frame-layer', 'hint-bar']);

    const app = must('app');
    expect(app.tagName).toBe('DIV');
    expect(app.children.length, '#app is empty in the markup (the renderer fills it)').toBe(0);
    expect(app.getAttribute('class'), '#app carries no class').toBeNull();
    expect(must('frame-layer').classList.contains('mr-frame-layer')).toBe(true);
    expect(must('hint-bar').classList.contains('mr-hint-bar')).toBe(true);

    expect(
      bodyElementChildren()
        .map((el) => el.id)
        .sort(),
      'the <body> holds the screen, the build stamp and the live region and nothing else',
    ).toEqual(['a11y-live', 'build-stamp', 'game-screen']);
    expect(bodyElementChildren()[0]?.id, '#game-screen is the first body child').toBe(
      'game-screen',
    );
  });

  it('CTL7A-1-NO-SCROLL-CSS: .mr-game-screen clips its overflow at a viewport height and is not position:fixed, and every other <body> child is out of the page flow', () => {
    // WRONG IMPL KILLED: a screen with `overflow: auto` / `visible` (the page scrolls); a screen
    // with only `min-height` (a tall canvas still grows it); position:fixed (it would make a
    // stacking context that sinks the menu and help under the body-level banners: plan §Design);
    // a rule keyed on #game-screen instead of the class (styles.css is class selectors only); an
    // in-flow body sibling after the screen (it adds height below the 100vh box and the page
    // scrolls).
    const rules = rulesFor('.mr-game-screen');
    expect(rules.length, 'styles.css must have a top-level .mr-game-screen rule').toBeGreaterThan(
      0,
    );
    const decl = cascade(rules);
    expect(decl.get('overflow'), 'the screen clips its overflow').toBe('hidden');
    expect(
      ['100vh', '100dvh', '100svh'],
      `the screen's height is a viewport height (got "${decl.get('height')}")`,
    ).toContain(decl.get('height'));
    expect(decl.get('position'), 'the screen is not position:fixed').not.toBe('fixed');
    expect(decl.get('position'), 'and not absolute either (it would leave the flow)').not.toBe(
      'absolute',
    );

    const outOfFlow = (el: Element): boolean => {
      const inline = (el.getAttribute('style') ?? '').toLowerCase().replace(/\s+/g, '');
      if (inline.includes('position:fixed') || inline.includes('position:absolute')) return true;
      if (inline.includes('display:none')) return true;
      return Array.from(el.classList).some((cls) => {
        const d = cascade(rulesFor(`.${cls}`));
        return d.get('position') === 'absolute' || d.get('position') === 'fixed';
      });
    };
    const others = bodyElementChildren().filter((el) => el.id !== 'game-screen');
    expect(others.length, 'anti-vacuity: the build stamp and live region are checked').toBe(2);
    for (const el of others) {
      expect(outOfFlow(el), `<body> child #${el.id} must be out of the page flow`).toBe(true);
    }
  });

  it('CTL7A-2-SHELLS-FRAMED: the nine index.html shells, help and the menu are children of #frame-layer, class-styled, hidden by display:none alone, with every id and data-testid unchanged', () => {
    // WRONG IMPL KILLED: a shell left as a body child (it renders below the fold again); a shell
    // without .mr-frame / .mr-shell (it keeps the dark-on-dark default); .mr-frame ON the menu
    // overlay (menuView's `rows.closest('.mr-frame')` would then return the overlay itself and
    // its visible frame is the ui/frame.ts one built inside); an inline position / colour left on
    // a root (the class rule cannot override it); a dropped or renamed inner id or data-testid
    // (views and e2e specs resolve them by id); a stowaway id inside the layer.
    const layer = must('frame-layer');
    expect(layer.parentElement?.id, '#frame-layer is a direct child of #game-screen').toBe(
      'game-screen',
    );
    for (const id of FRAME_LAYER_IDS) {
      expect(doc.querySelectorAll(`#${id}`), `#${id} is unique`).toHaveLength(1);
      const root = must(id);
      expect(root.parentElement?.id, `#${id} is a direct child of #frame-layer`).toBe(
        'frame-layer',
      );
      expect(root.classList.contains('mr-shell'), `#${id} carries .mr-shell`).toBe(true);
      expect(root.getAttribute('role'), `#${id} keeps role="dialog"`).toBe('dialog');
      expect(root.getAttribute('aria-modal'), `#${id} keeps aria-modal`).toBe('true');
      const style = (root.getAttribute('style') ?? '').replace(/\s+/g, '').replace(/;$/, '');
      expect(style, `#${id}: inline style is display:none and nothing else`).toBe('display:none');
    }
    for (const id of FRAMED_IDS) {
      expect(must(id).classList.contains('mr-frame'), `#${id} carries .mr-frame`).toBe(true);
    }
    expect(
      must('menu-overlay').classList.contains('mr-frame'),
      '#menu-overlay must NOT carry .mr-frame (its frame is the one ui/frame.ts builds inside)',
    ).toBe(false);
    for (const id of ['help-overlay', 'menu-overlay']) {
      expect(must(id).classList.contains('mr-shell--top'), `#${id} carries .mr-shell--top`).toBe(
        true,
      );
    }

    // Ids and test ids: nothing lost, nothing added, each under its own root.
    for (const id of FRAME_LAYER_IDS) {
      for (const inner of INNER_IDS[id]) {
        expect(must(id).querySelector(`#${inner}`), `#${inner} stays inside #${id}`).not.toBeNull();
      }
    }
    const expectedIds = [
      ...FRAME_LAYER_IDS,
      ...FRAME_LAYER_IDS.flatMap((id) => INNER_IDS[id]),
    ].sort();
    expect(
      Array.from(layer.querySelectorAll('[id]'))
        .map((el) => el.id)
        .sort(),
      'the ids inside #frame-layer are exactly the eleven roots and their original inner ids',
    ).toEqual(expectedIds);
    expect(
      Array.from(layer.querySelectorAll('[data-testid]'))
        .map((el) => el.getAttribute('data-testid'))
        .sort(),
      'the data-testid values are unchanged',
    ).toEqual([...TEST_IDS].sort());
    for (const testId of TEST_IDS) {
      expect(
        layer.querySelector(`[data-testid="${testId}"]`)?.id,
        `data-testid="${testId}" still sits on #${testId}`,
      ).toBe(testId);
    }
  });

  it('CTL7A-2-FRAME-IN-VIEWPORT-CSS: the base .mr-shell is absolutely placed with all four insets set to non-negative lengths and scrolls its own overflow, a .mr-shell--* modifier only ever re-positions to absolute (or, for --top alone, fixed) and never touches an inset or the overflow, and .mr-frame-layer fills the screen', () => {
    // WRONG IMPL KILLED: a base shell that stays position:static / relative (it flows below the
    // canvas and leaves the viewport); position:fixed on the BASE .mr-shell (leaves #game-screen's
    // clip); a missing inset (the box is not pinned inside the screen); a negative inset (it
    // hangs off an edge); `overflow: visible` (tall content spills out of the box); a modifier
    // that sets position to anything but absolute / fixed (static / relative / sticky flows the
    // shell out of the viewport box); position:fixed on any modifier other than --top; any
    // top / right / bottom / left / inset / overflow override inside a modifier (it can push the
    // box off-screen or make it spill, and the base-only cascade below would never see it); a
    // frame layer that is not pinned to the screen's four edges.
    //
    // Why --top may be fixed: the existing ctl-6c e2e client/e2e/encounter-battle.spec.ts (E0,
    // expectStackedAbove) asserts #menu-overlay and #help-overlay compute to position:fixed, as
    // peers of the fixed battle root (ui/battleView.ts, z-index 110). #game-screen fills the
    // viewport and has no transform / filter / contain ancestor, so a fixed .mr-shell--top that
    // inherits the base's four insets occupies the same box inside the viewport.
    expect(
      rulesFor('.mr-shell').length,
      'styles.css must have a top-level .mr-shell rule',
    ).toBeGreaterThan(0);
    const shellRules = rulesFor('.mr-shell');
    const shell = cascade(shellRules);
    expect(shell.get('position'), '.mr-shell is position:absolute').toBe('absolute');
    const sides = insetSides(shellRules);
    for (const side of SIDES) {
      expect(
        isNonNegativeLength(sides[side]),
        `.mr-shell ${side} must be a non-negative length (got "${sides[side]}")`,
      ).toBe(true);
    }
    expect(['auto', 'scroll'], '.mr-shell scrolls its own overflow').toContain(
      shell.get('overflow'),
    );

    // Modifiers, at any at-rule depth (an @media override can mis-place the box just as well).
    const INSET_PROPS = new Set(['inset', 'top', 'right', 'bottom', 'left']);
    for (const rule of STYLES) {
      for (const selector of rule.selectors) {
        if (!/^\.mr-shell--[a-z-]+$/.test(selector)) continue;
        const where = `${selector}${rule.at.length > 0 ? ` in ${rule.at.join(' ')}` : ''}`;
        for (const [prop, rawValue] of rule.decls) {
          const value = rawValue.replace(/\s*!important$/, '');
          if (prop === 'position') {
            const allowed = selector === '.mr-shell--top' ? ['absolute', 'fixed'] : ['absolute'];
            expect(
              allowed,
              `${where}: position "${value}" is not allowed (a modifier may set absolute; only .mr-shell--top may set fixed, for E0 in e2e/encounter-battle.spec.ts)`,
            ).toContain(value);
          }
          expect(
            INSET_PROPS.has(prop),
            `${where}: a modifier must not override "${prop}" (the base insets pin the box inside the viewport)`,
          ).toBe(false);
          expect(
            prop === 'overflow' || prop.startsWith('overflow-'),
            `${where}: a modifier must not override "${prop}" (the base shell scrolls its own overflow)`,
          ).toBe(false);
        }
      }
    }

    const layerRules = rulesFor('.mr-frame-layer');
    expect(
      layerRules.length,
      'styles.css must have a top-level .mr-frame-layer rule',
    ).toBeGreaterThan(0);
    expect(cascade(layerRules).get('position'), '.mr-frame-layer is position:absolute').toBe(
      'absolute',
    );
    const layerSides = insetSides(layerRules);
    for (const side of SIDES) {
      expect(layerSides[side], `.mr-frame-layer ${side} is 0 (it fills #game-screen)`).toMatch(
        /^0(px)?$/,
      );
    }
  });

  it('CTL7A-3-TOKEN-CONTRAST: the frame colour tokens are declared and their text/background pair is at least 4.5:1, and .mr-frame reads exactly those tokens (no other frame rule sets its own colour)', () => {
    // WRONG IMPL KILLED: tokens missing; a pair under 4.5:1 (a #888-on-#999 "token"); an @media
    // override that drops one half of the pair below 4.5:1; a .mr-frame rule that keeps literal
    // colours beside the tokens (the tokens would be decoys); a modifier (.mr-frame--banner) or
    // .mr-shell rule that paints its own colour over the token pair; a translucent background
    // (its contrast depends on the canvas).
    const rootRules = STYLES.filter((r) => r.selectors.includes(':root'));
    const declaredAt = (prop: string): CssRule[] =>
      rootRules.filter((r) => r.decls.some(([p]) => p === prop));
    const valueIn = (rule: CssRule, prop: string): string | undefined =>
      [...rule.decls].reverse().find(([p]) => p === prop)?.[1];

    const fgDefault = declaredAt('--mr-frame-fg').find((r) => r.at.length === 0);
    const bgDefault = declaredAt('--mr-frame-bg').find((r) => r.at.length === 0);
    expect(fgDefault, 'a top-level :root rule must declare --mr-frame-fg').toBeDefined();
    expect(bgDefault, 'a top-level :root rule must declare --mr-frame-bg').toBeDefined();
    expect(
      declaredAt('--mr-frame-border').length,
      'the frame border token --mr-frame-border must be declared',
    ).toBeGreaterThan(0);
    if (fgDefault === undefined || bgDefault === undefined) return;
    const fg0 = valueIn(fgDefault, '--mr-frame-fg') as string;
    const bg0 = valueIn(bgDefault, '--mr-frame-bg') as string;

    // Every pair the sheet can resolve: the default, and each @media override paired with the
    // default of the half it leaves alone.
    const pairs: Array<{ readonly label: string; readonly fg: string; readonly bg: string }> = [
      { label: 'default', fg: fg0, bg: bg0 },
    ];
    for (const rule of rootRules.filter((r) => r.at.length > 0)) {
      const fg = valueIn(rule, '--mr-frame-fg');
      const bg = valueIn(rule, '--mr-frame-bg');
      if (fg === undefined && bg === undefined) continue;
      pairs.push({ label: rule.at.join(' '), fg: fg ?? fg0, bg: bg ?? bg0 });
    }
    for (const pair of pairs) {
      const bgColour = parseColour(pair.bg);
      expect(bgColour[3], `${pair.label}: --mr-frame-bg must be opaque (got ${pair.bg})`).toBe(1);
      const ratio = contrast(parseColour(pair.fg), bgColour);
      expect(
        ratio,
        `${pair.label}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1, under the 4.5:1 minimum`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    // .mr-frame reads the tokens, byte for byte.
    const base = cascade(rulesFor('.mr-frame'));
    expect(base.get('color'), '.mr-frame color reads the foreground token').toBe(
      'var(--mr-frame-fg)',
    );
    expect(
      base.get('background') ?? base.get('background-color'),
      '.mr-frame background reads the background token',
    ).toBe('var(--mr-frame-bg)');

    // No frame or shell rule (modifiers included) paints a colour of its own over the pair.
    const frameLike = STYLES.filter((r) =>
      r.selectors.some((s) => /^\.mr-(frame|shell)(--[a-z-]+)?([.:[ ]|$)/.test(s)),
    );
    expect(frameLike.length, 'anti-vacuity: the frame / shell rules were found').toBeGreaterThan(1);
    for (const rule of frameLike) {
      for (const [prop, value] of rule.decls) {
        if (prop === 'color') {
          expect(value, `${rule.selectors.join(', ')}: color must be the foreground token`).toBe(
            'var(--mr-frame-fg)',
          );
        }
        if (prop === 'background' || prop === 'background-color') {
          expect(
            value === 'transparent' || value === 'none' || value.startsWith('var(--mr-frame-'),
            `${rule.selectors.join(', ')}: background "${value}" must be a frame token`,
          ).toBe(true);
        }
      }
    }
  });

  it('CTL7A-3-NO-INLINE-COLOUR: none of the eleven frame roots or their descendants carries an inline colour or background', () => {
    // WRONG IMPL KILLED: a root that keeps its old inline `color:#e0e0e0;background:rgba(...)`
    // (the inline declaration beats the class rule, so the token pair never applies); an inline
    // `bgcolor` / `color` attribute; a descendant with its own inline `color`.
    let checked = 0;
    for (const id of FRAME_LAYER_IDS) {
      const root = must(id);
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const style = (el.getAttribute('style') ?? '').toLowerCase();
        expect(style.includes('color'), `#${id} ${el.tagName} inline style "${style}"`).toBe(false);
        expect(style.includes('background'), `#${id} ${el.tagName} inline style "${style}"`).toBe(
          false,
        );
        expect(el.hasAttribute('bgcolor'), `#${id} ${el.tagName} bgcolor attribute`).toBe(false);
        expect(el.hasAttribute('color'), `#${id} ${el.tagName} color attribute`).toBe(false);
        checked += 1;
      }
    }
    // ANTI-VACUITY: the eleven roots hold 37 descendants between them (48 elements in all), so a
    // walk that saw only the roots (or nothing) cannot reach this count.
    expect(checked, 'the roots and their descendants were walked').toBeGreaterThanOrEqual(48);
  });

  it('CTL7A-4-CHIPS-SHELL: #hint-bar holds exactly the Start and Select chips as empty native buttons, and #help-hint is gone', () => {
    // WRONG IMPL KILLED: a leftover #help-hint badge; chips that are <div>s (not keyboard
    // reachable); a missing [data-menu-launcher] / [data-help-launcher] (the delegated click
    // listener finds nothing); the two chips wired to the same launcher; hard-coded English text,
    // aria-label or title in the markup (the labels come from the catalog at boot, so a French
    // boot would show English); a tabindex on a native button; a third control in the bar.
    expect(doc.getElementById('help-hint'), '#help-hint is retired').toBeNull();
    const bar = must('hint-bar');
    expect(
      Array.from(bar.children).map((el) => el.id),
      '#hint-bar holds exactly the two chips, Start first',
    ).toEqual(['chip-start', 'chip-select']);
    expect(bar.querySelectorAll('button')).toHaveLength(2);

    const specs = [
      { id: 'chip-start', verb: 'Start', own: 'data-menu-launcher', other: 'data-help-launcher' },
      { id: 'chip-select', verb: 'Select', own: 'data-help-launcher', other: 'data-menu-launcher' },
    ];
    for (const { id, verb, own, other } of specs) {
      const chip = must(id);
      expect(chip.tagName, `#${id} is a native <button>`).toBe('BUTTON');
      expect(chip.getAttribute('type'), `#${id} is type=button`).toBe('button');
      expect(chip.classList.contains('mr-chip'), `#${id} carries .mr-chip`).toBe(true);
      expect(chip.getAttribute('data-button'), `#${id} names its console button`).toBe(verb);
      expect(chip.hasAttribute(own), `#${id} carries [${own}]`).toBe(true);
      expect(chip.hasAttribute(other), `#${id} must not carry [${other}]`).toBe(false);
      expect((chip.textContent ?? '').trim(), `#${id} ships empty: main.ts writes its verb`).toBe(
        '',
      );
      expect(chip.children.length, `#${id} has no child elements`).toBe(0);
      for (const banned of ['aria-label', 'aria-labelledby', 'title', 'tabindex']) {
        expect(chip.hasAttribute(banned), `#${id} must not carry ${banned}`).toBe(false);
      }
    }
    expect(doc.querySelectorAll('[data-menu-launcher]'), 'one menu launcher').toHaveLength(1);
    expect(doc.querySelectorAll('[data-help-launcher]'), 'one help launcher').toHaveLength(1);
  });
});
