// resizeWiring.test.ts — unit tests for the resize wiring helper (M8.5f criterion E).
//
// SOURCE OF TRUTH: docs/m8.5f-plan.md §E
//
// The fix: add a pure wiring helper in client/src/render/resizeWiring.ts:
//
//   export function installResizeHandler(
//     renderer: { resize(w: number, h: number): void },
//     win: {
//       innerWidth: number;
//       innerHeight: number;
//       addEventListener(type: string, cb: () => void): void;
//     },
//   ): void
//
// It must:
//   1. Call renderer.resize(win.innerWidth, win.innerHeight) ONCE immediately.
//   2. Call win.addEventListener('resize', <callback>) to register a listener.
//   3. The registered listener re-calls renderer.resize(win.innerWidth, win.innerHeight)
//      (using the window dims at the time the listener fires, not the initial dims).
//
// RED reason: the module `./resizeWiring` does not exist yet → import fails
// (RED-by-absence). Once the implementer adds the file+export, tests go GREEN.
//
// Wrong impls killed (one per assertion):
//   - No initial call → resizeCalls.length === 0 after install (kills missing initial call)
//   - Wrong dims on initial call → resizeCalls[0] !== {w, h} (kills wrong dim threading)
//   - No 'resize' listener registered → registeredType !== 'resize' (kills missing addEventListener)
//   - Listener does not call resize → resizeCalls.length still 1 after fire (kills inert listener)
//   - Listener uses stale (captured) dims → resizeCalls[1] === {800,600} not {1024,768}
//     (kills a closure that captures initial values instead of reading win at call time)

import { describe, expect, it } from 'vitest';
import { installResizeHandler } from './resizeWiring';

// --- Minimal deterministic fakes (no real DOM / PixiJS) ----------------------

interface ResizeCall {
  w: number;
  h: number;
}

function makeFakeRenderer() {
  const calls: ResizeCall[] = [];
  return {
    resize(w: number, h: number): void {
      calls.push({ w, h });
    },
    get calls(): ResizeCall[] {
      return calls;
    },
  };
}

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, cb: () => void): void;
  registeredType: string | undefined;
  registeredCb: (() => void) | undefined;
  /** Fire the registered 'resize' listener (if any). */
  fire(): void;
}

function makeFakeWindow(initialWidth: number, initialHeight: number): FakeWindow {
  let registeredType: string | undefined;
  let registeredCb: (() => void) | undefined;
  const win = {
    innerWidth: initialWidth,
    innerHeight: initialHeight,
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

describe('installResizeHandler: resize wiring helper (M8.5f criterion E)', () => {
  it('BITES: calls renderer.resize once immediately with the current window dims', () => {
    // Kills: an impl that never calls the initial resize, or defers it.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600);

    installResizeHandler(renderer, win);

    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]).toEqual({ w: 800, h: 600 });
  });

  it('BITES: registers a "resize" listener on the window', () => {
    // Kills: an impl that calls addEventListener with the wrong event type,
    // or that never calls addEventListener at all.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600);

    installResizeHandler(renderer, win);

    expect(win.registeredType).toBe('resize');
    expect(win.registeredCb).toBeDefined();
  });

  it('BITES: the registered listener re-calls renderer.resize when fired', () => {
    // Kills: an impl that registers a no-op listener (never re-calls resize).
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600);

    installResizeHandler(renderer, win);
    // Initial call already happened (length=1). Fire the listener.
    win.fire();

    expect(renderer.calls).toHaveLength(2);
  });

  it('BITES: the listener re-calls resize with the dims at fire-time, not the initial dims', () => {
    // Kills: an impl that captures the initial innerWidth/innerHeight in a closure
    // instead of reading win.innerWidth / win.innerHeight at listener call-time.
    // With a stale-capture impl, the second call would be {w:800, h:600} not {w:1024, h:768}.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600);

    installResizeHandler(renderer, win);

    // Simulate the user resizing the window before the listener fires.
    win.innerWidth = 1024;
    win.innerHeight = 768;
    win.fire();

    expect(renderer.calls[1]).toEqual({ w: 1024, h: 768 });
  });

  it('BITES: multiple sequential resize events each re-call renderer.resize', () => {
    // Kills: an impl that de-registers the listener after the first fire.
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(800, 600);

    installResizeHandler(renderer, win);
    win.fire(); // 2nd call
    win.innerWidth = 1280;
    win.innerHeight = 720;
    win.fire(); // 3rd call

    expect(renderer.calls).toHaveLength(3);
    expect(renderer.calls[2]).toEqual({ w: 1280, h: 720 });
  });
});
