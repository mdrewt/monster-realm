// input/longPress.test.ts — ctl-15 RED gating tests: the pure long-press tracker and the touch /
// ring stylesheet contract (CTL15.3).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-15 (CTL15.3:
//   "at least 500 ms, at most 10 px of movement, with a fill ring"; "touch-action: none on the
//   canvas and pan-y on scroll bodies"); memory/projects/monster-realm-ctl-15-plan.md.
//
// RED REASON: client/src/input/longPress.ts does not exist yet (module-not-found), and
//   client/src/styles.css has no touch-action or ring rules yet.
//
// CONTRACT (pure, no DOM, no clock):
//   LONG_PRESS_MS = 500, LONG_PRESS_SLOP_PX = 10
//   startPress(id, x, y, t) -> { id, x, y, t0, fired: false }
//   movePress(track | null, id, x, y) -> other id: unchanged; Euclidean distance FROM THE START
//     > 10: null; exactly 10 keeps it
//   firePress(track | null, t) -> { track, fire }: fire true exactly once, when t - t0 >= 500
//   endPress(track | null, id) -> same id: { track: null, swallowClick: track.fired }; other id:
//     unchanged, false
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  endPress,
  firePress,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  movePress,
  type PressTrack,
  startPress,
} from './longPress';

describe('longPress (pure)', () => {
  it('CTL15-3-LP-FIRE-ONCE: a press fires exactly once, at 500 ms and not before, and its end reports whether the trailing click must be swallowed', () => {
    // WRONG IMPL KILLED: a strict `>` 500 (the spec says at least 500 ms); a fire that repeats on
    // every later tick (B pressed again and again while the finger stays down); a fire on a null
    // track; an end that forgets to report the swallow (the long-press's trailing click would
    // press A); an end from another finger that ends this press.
    expect(LONG_PRESS_MS).toBe(500);
    const t0 = 1_000;
    const track = startPress(1, 10, 20, t0);
    expect(track).toEqual({ id: 1, x: 10, y: 20, t0, fired: false });

    const early = firePress(track, t0 + 499);
    expect(early.fire, '499 ms: not yet').toBe(false);
    expect(early.track).toEqual(track);

    const due = firePress(early.track, t0 + 500);
    expect(due.fire, '500 ms: fires').toBe(true);
    expect(due.track).toEqual({ id: 1, x: 10, y: 20, t0, fired: true });

    const later = firePress(due.track, t0 + 2_000);
    expect(later.fire, 'never twice').toBe(false);
    expect(later.track?.fired).toBe(true);

    expect(firePress(null, t0 + 5_000)).toEqual({ track: null, fire: false });

    expect(endPress(due.track, 1), 'a fired press swallows its click').toEqual({
      track: null,
      swallowClick: true,
    });
    expect(endPress(track, 1), 'a tap does not').toEqual({ track: null, swallowClick: false });
    expect(endPress(due.track, 2), 'another finger changes nothing').toEqual({
      track: due.track,
      swallowClick: false,
    });
    expect(endPress(null, 1)).toEqual({ track: null, swallowClick: false });

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 5_000 }), (t, dt) => {
        const r = firePress(startPress(7, 0, 0, t), t + dt);
        expect(r.fire).toBe(dt >= LONG_PRESS_MS);
        expect(r.track?.fired).toBe(dt >= LONG_PRESS_MS);
      }),
    );
  });

  it('CTL15-3-LP-SLOP: a move cancels the press only beyond 10 px from where it STARTED; another finger`s move changes nothing', () => {
    // WRONG IMPL KILLED: a strict bound at 10 (the spec says at most 10 px); a Manhattan or
    // per-axis distance; a slop measured from the last move (a slow drag would never cancel); a
    // move from another pointer that cancels or re-anchors this press.
    expect(LONG_PRESS_SLOP_PX).toBe(10);
    const start: PressTrack = startPress(3, 100, 200, 0);

    expect(movePress(start, 3, 110, 200), '10 px along x: kept').toEqual(start);
    expect(movePress(start, 3, 106, 208), '(6, 8) is exactly 10 px: kept').toEqual(start);
    expect(movePress(start, 3, 107, 208), '(7, 8) is 10.6 px: cancelled').toBeNull();
    expect(movePress(start, 3, 100, 189), '11 px along y: cancelled').toBeNull();
    expect(movePress(start, 3, 107, 207), 'a per-axis 7 px but 9.9 px: kept').toEqual(start);

    const step = movePress(start, 3, 108, 200);
    expect(step, '8 px: kept').toEqual(start);
    expect(movePress(step, 3, 116, 200), '16 px from the start, 8 from the last: cancelled').toBe(
      null,
    );

    expect(movePress(start, 4, 900, 900), 'another finger: unchanged').toEqual(start);
    expect(movePress(null, 3, 100, 200)).toBeNull();

    const fired = firePress(start, 500).track;
    expect(movePress(fired, 3, 105, 200), 'a fired press keeps its fired flag').toEqual({
      ...start,
      fired: true,
    });

    fc.assert(
      fc.property(
        fc.integer({ min: -30, max: 30 }),
        fc.integer({ min: -30, max: 30 }),
        (dx, dy) => {
          const moved = movePress(start, 3, 100 + dx, 200 + dy);
          if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) {
            expect(moved).toBeNull();
          } else {
            expect(moved).toEqual(start);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// the stylesheet: touch-action and the fill ring
// ---------------------------------------------------------------------------------------------

interface CssRule {
  readonly index: number;
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly decls: ReadonlyMap<string, string>;
}

function skipString(src: string, at: number): number {
  const quote = src[at];
  let i = at + 1;
  while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Top-level `prelude { body }` pairs of `src` (strings skipped, braces matched). */
function blocks(src: string): Array<{ prelude: string; body: string }> {
  const out: Array<{ prelude: string; body: string }> = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      i = skipString(src, i);
      continue;
    }
    if (ch === ';') start = i + 1;
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '"' || c === "'") {
          j = skipString(src, j);
          continue;
        }
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
        j += 1;
      }
      out.push({ prelude: src.slice(start, i).trim(), body: src.slice(i + 1, j - 1) });
      i = j;
      start = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Every style rule (with its @media condition, in source order) and every @keyframes name. */
function parseCss(css: string): { rules: CssRule[]; keyframes: Set<string> } {
  const rules: CssRule[] = [];
  const keyframes = new Set<string>();
  const walk = (src: string, media: string | null): void => {
    for (const { prelude, body } of blocks(src)) {
      if (/^@media\b/i.test(prelude)) {
        walk(body, prelude);
        continue;
      }
      const kf = /^@(?:-webkit-)?keyframes\s+(.+)$/i.exec(prelude);
      if (kf !== null) {
        keyframes.add((kf[1] as string).trim().replace(/^["']|["']$/g, ''));
        continue;
      }
      if (prelude.startsWith('@')) continue;
      const decls = new Map<string, string>();
      for (const part of body.split(';')) {
        const colon = part.indexOf(':');
        if (colon < 0) continue;
        const prop = part.slice(0, colon).trim().toLowerCase();
        const value = part
          .slice(colon + 1)
          .replace(/!important/i, '')
          .trim()
          .replace(/\s+/g, ' ');
        decls.set(prop, value);
      }
      rules.push({
        index: rules.length,
        media,
        selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
        decls,
      });
    }
  };
  walk(css, null);
  return { rules, keyframes };
}

/** The last compound selector of a complex selector (`.a > .b c` -> `c`). */
const lastCompound = (selector: string): string =>
  selector
    .split(/\s*[>+~]\s*|\s+/)
    .filter((s) => s !== '')
    .pop() ?? '';

/** A CSS time token in milliseconds, or null. */
function timeMs(token: string): number | null {
  const m = /^(\d*\.?\d+)(ms|s)$/i.exec(token);
  if (m === null) return null;
  const n = Number(m[1]);
  return (m[2] as string).toLowerCase() === 's' ? n * 1000 : n;
}

describe('styles.css — touch and the long-press ring', () => {
  it('CTL15-3-LP-CSS: the game canvas has touch-action none, frame bodies pan-y, the ring has a 500 ms animation whose keyframes exist, and a later reduced-motion block removes it', () => {
    // WRONG IMPL KILLED: no touch-action anywhere (the browser pans or zooms the page under a
    // long-press, and pointercancel kills the gesture); touch-action none on the scroll bodies
    // too (frames could no longer be scrolled by touch); a ring with no animation, an animation
    // naming keyframes that do not exist, a fill that does not last the 500 ms the press takes; no
    // reduced-motion guard, or a guard written BEFORE the base rule (equal specificity: the later
    // base rule wins and the guard is inert). Comments are stripped first, so a commented-out rule
    // is no rule.
    const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css');
    const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const { rules, keyframes } = parseCss(css);
    expect(rules.length, 'anti-vacuity: the sheet parses into rules').toBeGreaterThan(10);
    const base = rules.filter((r) => r.media === null);

    // The canvas inside the game screen. styles.css bans #id selectors (A11Y-12), so the rule may
    // name the canvas by a class (e.g. a canvas class main.ts sets) or as `canvas` under the game
    // screen's class: any selector whose last compound names the canvas.
    const canvasRule = base.find(
      (r) =>
        r.decls.get('touch-action') === 'none' &&
        r.selectors.some((s) => /canvas/i.test(lastCompound(s))),
    );
    expect(canvasRule, 'a canvas rule with touch-action: none').toBeDefined();

    const bodyRule = base.find(
      (r) =>
        r.decls.get('touch-action') === 'pan-y' &&
        r.selectors.some((s) => lastCompound(s) === '.mr-frame-body'),
    );
    expect(bodyRule, '.mr-frame-body has touch-action: pan-y').toBeDefined();
    for (const r of base) {
      if (r.selectors.some((s) => lastCompound(s) === '.mr-frame-body')) {
        expect(r.decls.get('touch-action'), 'no frame-body rule disables touch scrolling').not.toBe(
          'none',
        );
      }
    }

    const isRing = (s: string): boolean => /^\.mr-longpress-ring(?![\w-])/.test(lastCompound(s));
    const ringRules = base.filter(
      (r) =>
        r.selectors.some(isRing) && (r.decls.has('animation') || r.decls.has('animation-name')),
    );
    expect(ringRules.length, 'a .mr-longpress-ring rule with an animation').toBeGreaterThan(0);
    const ring = ringRules[0] as CssRule;
    const tokens = [ring.decls.get('animation') ?? '', ring.decls.get('animation-name') ?? '']
      .join(' ')
      .split(/[\s,]+/)
      .filter((tk) => tk !== '');
    const named = tokens.filter((tk) => keyframes.has(tk));
    expect(named.length, 'the ring animation names keyframes the sheet defines').toBeGreaterThan(0);
    const durations = [
      ...(ring.decls.get('animation') ?? '').split(/\s+/),
      ...(ring.decls.get('animation-duration') ?? '').split(/\s+/),
    ]
      .map(timeMs)
      .filter((ms): ms is number => ms !== null);
    expect(durations[0], 'the ring fills over the long-press duration').toBe(LONG_PRESS_MS);

    const guard = rules.find(
      (r) =>
        r.media !== null &&
        /prefers-reduced-motion\s*:\s*reduce/i.test(r.media) &&
        r.selectors.some(isRing) &&
        (r.decls.get('animation') === 'none' || r.decls.get('animation-name') === 'none'),
    );
    expect(
      guard,
      'a prefers-reduced-motion: reduce block removes the ring animation',
    ).toBeDefined();
    expect(
      (guard as CssRule).index,
      'the guard follows the base rule (source order decides)',
    ).toBeGreaterThan(ring.index);
  });
});
