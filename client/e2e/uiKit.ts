// uiKit.ts — computed-style and geometry assertions for the shared menu design language
// (M-ui-foundation, uif-1). Specs call these to sample what Chromium ACTUALLY computed, so a literal
// left behind, a var() that never resolves or a rule that never applies is seen as a wrong number,
// not as a source scan. Spine slices append here; `uif-9` and `uif-10` use it unchanged.
//
// DOCTRINE. Nothing in this file knows a token value or a screen: it samples, parses and compares.
// The expected values live in the specs as LITERALS transcribed from the wf-1 token table
// (`M-ui-foundation-wireframes.md`, "Token table (WF1.5)"), never read back from the stylesheet or
// from `resolveToken`: an oracle that reads the token it checks cannot disagree with it.
//
// CLEANUP. Every probe (a temporary element, a toggled attribute, a font-size override) is created,
// read and undone INSIDE ONE page.evaluate, in a `finally`, so a failing assertion in the spec can
// never leave a stray node or a changed root behind for the next test, and no frame, store batch
// or timer runs between the write and the restore.
//
// Imports only from `@playwright/test` (the `Page` type and the runtime `expect`, which the
// comparison helpers below call), and nothing from `src/`, so it loads under Playwright without Vite.
import { expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------------------------
// Colour parsing and WCAG contrast (pure).
// ---------------------------------------------------------------------------------------------

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parses what `getComputedStyle` returns for a colour: `rgb(r, g, b)`, `rgba(r, g, b, a)` or the
 *  space/slash form. Throws on anything else (a `color(...)` or a keyword), never guesses. */
export function parseRgb(css: string): Rgba {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    css.trim(),
  );
  if (m === null)
    throw new Error(`uiKit.parseRgb: not an rgb()/rgba() colour: ${JSON.stringify(css)}`);
  const alphaRaw = m[4];
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith('%')
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  return {
    r: Number.parseFloat(m[1] as string),
    g: Number.parseFloat(m[2] as string),
    b: Number.parseFloat(m[3] as string),
    a: alpha,
  };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio between two OPAQUE colours (order does not matter). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` composited over the opaque `base` (the result is opaque). */
export function compositeOver(top: Rgba, base: Rgba): Rgba {
  const mix = (t: number, b: number): number => top.a * t + (1 - top.a) * b;
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

/** The canvas colour under the whole page when no ancestor paints (Chromium's default). */
const CANVAS: Rgba = { r: 255, g: 255, b: 255, a: 1 };

// ---------------------------------------------------------------------------------------------
// Computed-style sampling.
// ---------------------------------------------------------------------------------------------

export type Pseudo = '::before' | '::after';
/** The sampled properties, by the (kebab-case) name asked for. */
export type Sample = Readonly<Record<string, string>>;

/** The shorthands `sampleStyle` expands to their four (or two) longhands, joined with a space in
 *  the CSS order (top right bottom left; row column), so a spec compares `'2px 8px 2px 20px'`
 *  whatever the engine's serialisation of the shorthand itself. */
const SHORTHAND_LONGHANDS: Readonly<Record<string, readonly string[]>> = {
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
  gap: ['row-gap', 'column-gap'],
};

/**
 * Computed style of the FIRST element matching `selector` (or of its `pseudo`), for `props`.
 * Throws naming the selector when nothing matches, so a sample can never be vacuous. A shorthand in
 * `props` (see SHORTHAND_LONGHANDS) is returned as its joined longhands under the shorthand's name.
 */
export async function sampleStyle(
  page: Page,
  selector: string,
  props: readonly string[],
  pseudo?: Pseudo,
): Promise<Sample> {
  return page.evaluate(
    ({ selector: sel, props: wanted, pseudo: ps, longhands }) => {
      const el = document.querySelector(sel);
      if (el === null) throw new Error(`uiKit.sampleStyle: no element matches ${sel}`);
      const cs = getComputedStyle(el, ps ?? null);
      const out: Record<string, string> = {};
      for (const prop of wanted) {
        const parts = longhands[prop];
        out[prop] =
          parts === undefined
            ? cs.getPropertyValue(prop)
            : parts.map((p) => cs.getPropertyValue(p)).join(' ');
      }
      return out;
    },
    { selector, props: [...props], pseudo: pseudo ?? null, longhands: SHORTHAND_LONGHANDS },
  );
}

/** How many elements match `selector` (the non-vacuity count a spec asserts before it samples). */
export const countMatching = (page: Page, selector: string): Promise<number> =>
  page.evaluate((sel) => document.querySelectorAll(sel).length, selector);

/** Whether `query` matches in the page (e.g. `(prefers-contrast: more)`). */
export const mediaMatches = (page: Page, query: string): Promise<boolean> =>
  page.evaluate((q) => window.matchMedia(q).matches, query);

/** Compares only the keys of `expected` against `actual`, reporting the whole picked sample so a
 *  failure shows every number, not the first. */
export function expectSample(actual: Sample, expected: Sample, label: string): void {
  const picked: Record<string, string> = {};
  for (const key of Object.keys(expected)) picked[key] = actual[key] ?? '(not sampled)';
  expect(picked, label).toEqual(expected);
}

// ---------------------------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------------------------

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The border box of the first element matching `selector`, in CSS px. Throws when none matches. */
export async function sampleRect(page: Page, selector: string): Promise<Rect> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`uiKit.sampleRect: no element matches ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

/** `actual` equals `expected` on every axis within `tolerance` CSS px (default 1). */
export function expectRect(actual: Rect, expected: Rect, tolerance = 1, label = 'rect'): void {
  for (const axis of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[axis] - expected[axis]),
      `${label}.${axis}: ${actual[axis]} vs ${expected[axis]} (tolerance ${tolerance})`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

/** Whether two rects overlap by MORE than `tolerance` CSS px on both axes (sharing an edge, or
 *  overlapping by a sub-pixel antialiasing sliver, is not an overlap). uif-7: the sheet must not
 *  cover the cursor slot, so the spec asks this of the sheet's rect and the cursor cell's. */
export function rectsOverlap(a: Rect, b: Rect, tolerance = 0.5): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > tolerance && overlapY > tolerance;
}

/** `actual` is within `tolerance` of `expected` (one length, e.g. a height). */
export function expectNear(
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
): void {
  expect(
    Math.abs(actual - expected),
    `${label}: ${actual} vs ${expected} (tolerance ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
}

// ---------------------------------------------------------------------------------------------
// Token resolution through a real probe.
// ---------------------------------------------------------------------------------------------

/** A value no token holds: the `var()` fallback, so an undeclared token returns THIS (and a spec's
 *  literal then mismatches), never an inherited colour that might coincide with the expectation. */
const SENTINEL = 'rgb(1, 2, 3)';

/**
 * Resolves a COLOUR token to the `rgb(...)` Chromium computes for it: a temporary element is given
 * `color: var(--token, rgb(1, 2, 3))`, its computed `color` is read, and the element is removed. The
 * emulated media features in force at the call apply, so the same call reads either tier.
 */
export async function resolveToken(page: Page, token: string): Promise<string> {
  if (!/^--[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`uiKit.resolveToken: not a custom property name: ${token}`);
  }
  return page.evaluate(
    ({ name, sentinel }) => {
      const probe = document.createElement('div');
      probe.setAttribute('data-ui-kit-probe', 'token');
      probe.style.setProperty('color', `var(${name}, ${sentinel})`);
      document.body.appendChild(probe);
      try {
        return getComputedStyle(probe).color;
      } finally {
        probe.remove();
      }
    },
    { name: token, sentinel: SENTINEL },
  );
}

/**
 * Resolves a LENGTH token to the computed `width` Chromium gives an element sized by it: a
 * temporary absolutely-positioned element is given `width: var(--token, 1px)`, its computed `width`
 * is read, and the element is removed. For a token nothing consumes yet (`--mr-content-max`): the
 * sentinel is `1px`, so an undeclared token reads `1px`, never an inherited size. Scales with the
 * root font size for a rem token, so a spec can read it at two roots.
 */
export async function resolveLength(page: Page, token: string): Promise<string> {
  if (!/^--[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`uiKit.resolveLength: not a custom property name: ${token}`);
  }
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.setAttribute('data-ui-kit-probe', 'length');
    probe.style.setProperty('position', 'absolute');
    probe.style.setProperty('visibility', 'hidden');
    probe.style.setProperty('max-width', 'none');
    probe.style.setProperty('width', `var(${name}, 1px)`);
    document.body.appendChild(probe);
    try {
      return getComputedStyle(probe).width;
    } finally {
      probe.remove();
    }
  }, token);
}

/** Resolves every token in `tokens` (see `resolveToken`), keyed by the token name. */
export async function resolveTokens(
  page: Page,
  tokens: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const token of tokens) out[token] = await resolveToken(page, token);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Probes and temporary state (created, read and undone in one evaluate).
// ---------------------------------------------------------------------------------------------

export interface ProbeSpec {
  /** The class attribute the probe wears (the rule under test). */
  readonly className: string;
  /** The element the probe is appended to; the first match, which must exist. */
  readonly parent: string;
  readonly tag?: string;
  readonly text?: string;
}

/**
 * Appends a probe element wearing `spec.className` under `spec.parent`, reads its computed `props`,
 * and removes it, all in ONE evaluate (so nothing paints, subscribes or interacts with it). Use it
 * where a class has no reachable production element; the spec says why.
 */
export async function sampleProbe(
  page: Page,
  spec: ProbeSpec,
  props: readonly string[],
  pseudo?: Pseudo,
): Promise<Sample> {
  return page.evaluate(
    ({ spec: s, props: wanted, pseudo: ps, longhands }) => {
      const parent = document.querySelector(s.parent);
      if (parent === null) throw new Error(`uiKit.sampleProbe: no parent matches ${s.parent}`);
      const probe = document.createElement(s.tag ?? 'div');
      probe.className = s.className;
      probe.setAttribute('data-ui-kit-probe', 'class');
      probe.textContent = s.text ?? 'probe';
      parent.appendChild(probe);
      try {
        const cs = getComputedStyle(probe, ps ?? null);
        const out: Record<string, string> = {};
        for (const prop of wanted) {
          const parts = longhands[prop];
          out[prop] =
            parts === undefined
              ? cs.getPropertyValue(prop)
              : parts.map((p) => cs.getPropertyValue(p)).join(' ');
        }
        return out;
      } finally {
        probe.remove();
      }
    },
    { spec, props: [...props], pseudo: pseudo ?? null, longhands: SHORTHAND_LONGHANDS },
  );
}

export interface TemporaryState {
  /** Attributes set for the sample (value `null` removes the attribute for the sample). */
  readonly attrs?: Readonly<Record<string, string | null>>;
  /** Text written for the sample; the previous child nodes (elements included) are restored. */
  readonly text?: string;
  /** Classes added for the sample; the previous `class` attribute is restored exactly. */
  readonly addClasses?: readonly string[];
  /** Un-hide the element for the sample (`hidden`, inline display); both are restored. */
  readonly forceShown?: boolean;
}

/**
 * Samples the first element matching `selector` while `state` is applied to it, then restores every
 * touched attribute, its text content and its `hidden` / inline `display`, in a `finally`, in the
 * same evaluate. For state no flow paints on demand (an empty status line, a feedback kind).
 */
export async function sampleWithState(
  page: Page,
  selector: string,
  state: TemporaryState,
  props: readonly string[],
  pseudo?: Pseudo,
): Promise<Sample> {
  return page.evaluate(
    ({ selector: sel, state: st, props: wanted, pseudo: ps, longhands }) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) {
        throw new Error(`uiKit.sampleWithState: no HTMLElement matches ${sel}`);
      }
      const attrs = Object.entries(st.attrs ?? {});
      const before = attrs.map(([name]) => [name, el.getAttribute(name)] as const);
      // The child NODES are saved (not the text), so a restore keeps any element child intact.
      const was = {
        nodes: Array.from(el.childNodes),
        cls: el.getAttribute('class'),
        hidden: el.hidden,
        display: el.style.display,
      };
      try {
        for (const [name, value] of attrs) {
          if (value === null) el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
        for (const cls of st.addClasses ?? []) el.classList.add(cls);
        if (st.text !== undefined) el.textContent = st.text;
        if (st.forceShown === true) {
          el.hidden = false;
          el.style.display = 'block';
        }
        const cs = getComputedStyle(el, ps ?? null);
        const out: Record<string, string> = {};
        for (const prop of wanted) {
          const parts = longhands[prop];
          out[prop] =
            parts === undefined
              ? cs.getPropertyValue(prop)
              : parts.map((p) => cs.getPropertyValue(p)).join(' ');
        }
        return out;
      } finally {
        for (const [name, value] of before) {
          if (value === null) el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
        if (st.text !== undefined) el.replaceChildren(...was.nodes);
        if (st.addClasses !== undefined) {
          if (was.cls === null) el.removeAttribute('class');
          else el.setAttribute('class', was.cls);
        }
        el.hidden = was.hidden;
        el.style.display = was.display;
      }
    },
    { selector, state, props: [...props], pseudo: pseudo ?? null, longhands: SHORTHAND_LONGHANDS },
  );
}

/**
 * Runs `fn` with the root element's font size forced to `px`, restoring the previous INLINE value
 * (or none) afterwards even when `fn` throws. Every rem-based length then scales with it while a
 * px literal does not: the kill for a literal left behind that a 16px-root sample cannot see.
 */
export async function withRootFontSize<T>(
  page: Page,
  px: number,
  fn: () => Promise<T>,
): Promise<T> {
  await page.evaluate((size) => {
    const root = document.documentElement;
    root.setAttribute('data-ui-kit-font-was', root.style.fontSize);
    root.style.fontSize = `${size}px`;
  }, px);
  try {
    return await fn();
  } finally {
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.fontSize = root.getAttribute('data-ui-kit-font-was') ?? '';
      root.removeAttribute('data-ui-kit-font-was');
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Effective background and measured contrast.
// ---------------------------------------------------------------------------------------------

/**
 * The colour actually behind `selector`'s text: its own and every ancestor's computed
 * `background-color`, composited from the root down over Chromium's white canvas. Background
 * images (gradients) are NOT modelled; a spec that needs one says so.
 */
export async function effectiveBackground(page: Page, selector: string): Promise<Rgba> {
  const layers = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`uiKit.effectiveBackground: no element matches ${sel}`);
    const out: string[] = [];
    for (let n: Element | null = el; n !== null; n = n.parentElement) {
      out.push(getComputedStyle(n).backgroundColor);
    }
    return out;
  }, selector);
  let base = CANVAS;
  for (const layer of layers.reverse()) base = compositeOver(parseRgb(layer), base);
  return base;
}

/** The measured contrast of `selector`'s computed text colour against its effective background.
 *  The text colour is composited over that background first when it carries alpha. */
export async function measuredContrast(page: Page, selector: string): Promise<number> {
  const [{ color }, bg] = await Promise.all([
    sampleStyle(page, selector, ['color']),
    effectiveBackground(page, selector),
  ]);
  const fg = compositeOver(parseRgb(color as string), bg);
  return contrastRatio(fg, bg);
}
