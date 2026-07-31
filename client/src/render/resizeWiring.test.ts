// resizeWiring.test.ts — unit tests for the resize wiring helper (M8.5f criterion E + uxd1 A12).
//
// SOURCE OF TRUTH: docs/m8.5f-plan.md §E AND
// specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd1 criterion A12:
//   "WHEN the resize handler is installed, THE handler SHALL read `devicePixelRatio` from
//    the injected window at FIRE-TIME (not capture-time) and thread it to the renderer
//    alongside innerWidth/innerHeight."
// (and A2: "WHEN a window resize fires AND the live devicePixelRatio differs from the value
//  used at the last layout, THE resize path SHALL re-read it…")
//
// The widened seam in client/src/render/resizeWiring.ts:
//
//   interface Resizable { resize(cssW: number, cssH: number, dpr: number): void }
//   interface ResizeWindow {
//     readonly innerWidth: number;
//     readonly innerHeight: number;
//     readonly devicePixelRatio: number;              // NEW (uxd1)
//     addEventListener(type: 'resize', cb: () => void): void;
//   }
//   export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void
//
// It must:
//   1. Call renderer.resize(win.innerWidth, win.innerHeight, win.devicePixelRatio) ONCE
//      immediately.
//   2. Call win.addEventListener('resize', <callback>) to register a listener.
//   3. Re-call renderer.resize with ALL THREE values read from `win` at the time the
//      listener FIRES — including devicePixelRatio, which changes when the user drags the
//      window between a retina and a non-retina monitor.
//
// RED REASON (uxd1): `resizeWiring.ts` today calls `renderer.resize(win.innerWidth,
// win.innerHeight)` with TWO arguments and its `ResizeWindow` has no `devicePixelRatio`
// member at all. So every `dpr` field recorded below is `undefined` — RED by wrong-value.
//
// ⚠ FALSE-GREEN GUARD (uxd1 review finding R3 — the highest false-green risk in this slice).
// A 2-parameter fake STRUCTURALLY SATISFIES a 3-parameter interface, so a fake that records
// only {w, h} would compile, silently drop dpr, and report GREEN on an impl that never
// threads it. And `client/tsconfig.json:15` excludes `**/*.test.ts` while vitest transpiles
// without typechecking, so NO type error in this file is ever caught by `just ci`. Therefore,
// by construction below:
//   - every fake renderer declares resize(w, h, dpr) and records ALL THREE values;
//   - the fake window's devicePixelRatio is a MUTABLE field (like innerWidth/innerHeight);
//   - every assertion is on the full {w, h, dpr} triple, never just {w, h}.
//
// Wrong impls killed (one per assertion):
//   - No initial call → resizeCalls.length === 0 after install (kills missing initial call)
//   - Wrong dims on initial call → resizeCalls[0] !== {w, h, dpr} (kills wrong threading)
//   - Dropped 3rd argument → resizeCalls[0].dpr === undefined (kills the 2-arg call)
//   - Hard-coded dpr 1 (or an optional `dpr = 1` default, which silently restores the
//     blurry path) → dpr 1 where 2 / 1.5 is expected
//   - No 'resize' listener registered → registeredType !== 'resize' (kills missing addEventListener)
//   - Listener does not call resize → resizeCalls.length still 1 after fire (kills inert listener)
//   - Listener uses stale (captured) dims/dpr → resizeCalls[1] === {800,600,2} not {1024,768,2}
//     / dpr 2 not 1 (kills a closure that captures values at INSTALL time)
//   - dpr rounded/floored to an integer → 1.5 reported as 1 or 2

import { describe, expect, it } from 'vitest';
import { installResizeHandler } from './resizeWiring';

// --- Minimal deterministic fakes (no real DOM / PixiJS) ----------------------

interface ResizeCall {
  w: number;
  h: number;
  dpr: number;
}

function makeFakeRenderer() {
  const calls: ResizeCall[] = [];
  return {
    // THREE parameters, all recorded — see the R3 false-green guard in the header.
    resize(w: number, h: number, dpr: number): void {
      calls.push({ w, h, dpr });
    },
    get calls(): ResizeCall[] {
      return calls;
    },
  };
}

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  /** MUTABLE on purpose: a monitor drag changes it between fires (uxd1 A12). */
  devicePixelRatio: number;
  addEventListener(type: string, cb: () => void): void;
  registeredType: string | undefined;
  registeredCb: (() => void) | undefined;
  /** Fire the registered 'resize' listener (if any). */
  fire(): void;
}

function makeFakeWindow(
  initialWidth: number,
  initialHeight: number,
  initialDpr: number,
): FakeWindow {
  let registeredType: string | undefined;
  let registeredCb: (() => void) | undefined;
  const win = {
    innerWidth: initialWidth,
    innerHeight: initialHeight,
    devicePixelRatio: initialDpr,
    addEventListener(type: string, cb: () => void): void {
      registeredType = type;
      registeredCb = cb;
    },
    get registeredType(): string | undefined {
      return registeredType;
    },
    get registeredCb(): (() => void) | undefined {
      return registeredCb;
    },
    fire(): void {
      if (registeredCb) registeredCb();
    },
  };
  return win;
}

// -----------------------------------------------------------------------------

describe('installResizeHandler: resize wiring helper (M8.5f criterion E + uxd1 A12)', () => {
  it('BITES: calls renderer.resize once immediately with the current window dims AND dpr', () => {
    // Kills: an impl that never calls the initial resize, or defers it; an impl that drops
    // the 3rd argument (dpr would be `undefined`); an impl that hard-codes dpr = 1 (or takes
    // it as `dpr = 1` optional-with-default, which silently restores the blurry path).
    // dpr 2 is deliberately NOT 1, so a hard-coded 1 cannot pass by coincidence.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600, 2);

    installResizeHandler(renderer, win);

    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]).toEqual({ w: 800, h: 600, dpr: 2 });
  });

  it('BITES: registers a "resize" listener on the window', () => {
    // Kills: an impl that calls addEventListener with the wrong event type,
    // or that never calls addEventListener at all.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600, 2);

    installResizeHandler(renderer, win);

    expect(win.registeredType).toBe('resize');
    expect(win.registeredCb).toBeDefined();
  });

  it('BITES: the registered listener re-calls renderer.resize when fired', () => {
    // Kills: an impl that registers a no-op listener (never re-calls resize).
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600, 2);

    installResizeHandler(renderer, win);
    // Initial call already happened (length=1). Fire the listener.
    win.fire();

    expect(renderer.calls).toHaveLength(2);
  });

  it('BITES: the listener re-calls resize with the dims at fire-time, not the initial dims', () => {
    // Kills: an impl that captures the initial innerWidth/innerHeight in a closure
    // instead of reading win.innerWidth / win.innerHeight at listener call-time.
    // With a stale-capture impl, the second call would be {w:800, h:600, dpr:2}
    // not {w:1024, h:768, dpr:2}.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600, 2);

    installResizeHandler(renderer, win);

    // Simulate the user resizing the window before the listener fires.
    win.innerWidth = 1024;
    win.innerHeight = 768;
    win.fire();

    expect(renderer.calls[1]).toEqual({ w: 1024, h: 768, dpr: 2 });
  });

  it('BITES (uxd1 A12): mutating win.devicePixelRatio between fires yields the NEW dpr, never a captured one', () => {
    // The real scenario: the user drags the window from a retina laptop display (dpr 2) to
    // an external non-retina monitor (dpr 1), then to a 150%-scaled Windows monitor (dpr 1.5).
    // A12 requires the handler to READ win.devicePixelRatio at FIRE-TIME.
    // Kills:
    //   - a closure that captures dpr at INSTALL time → 2nd call would report dpr 2, not 1;
    //   - a hard-coded / defaulted dpr 1 → the 3rd call would report 1, not 1.5, and the
    //     initial call would report 1, not 2;
    //   - an impl that rounds or floors dpr to an integer → 1.5 would arrive as 1 or 2;
    //   - an impl that reads a module-global `window.devicePixelRatio` instead of the
    //     injected `win` → dpr would be undefined/1 under node.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(1440, 900, 2); // retina laptop

    installResizeHandler(renderer, win);
    expect(renderer.calls[0]).toEqual({ w: 1440, h: 900, dpr: 2 });

    // Dragged to a 1920×1080 non-retina external monitor.
    win.innerWidth = 1920;
    win.innerHeight = 1080;
    win.devicePixelRatio = 1;
    win.fire();
    expect(renderer.calls[1]).toEqual({ w: 1920, h: 1080, dpr: 1 });

    // Same size, OS display scaling changed to 150% — dpr alone moves, fractionally.
    win.devicePixelRatio = 1.5;
    win.fire();
    expect(renderer.calls[2]).toEqual({ w: 1920, h: 1080, dpr: 1.5 });
  });

  it('BITES: multiple sequential resize events each re-call renderer.resize', () => {
    // Kills: an impl that de-registers the listener after the first fire.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600, 2);

    installResizeHandler(renderer, win);
    win.fire(); // 2nd call
    win.innerWidth = 1280;
    win.innerHeight = 720;
    win.fire(); // 3rd call

    expect(renderer.calls).toHaveLength(3);
    expect(renderer.calls[2]).toEqual({ w: 1280, h: 720, dpr: 2 });
  });
});
