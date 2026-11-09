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
//     readonly devicePixelRatio: number;              // NEW
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
// ⚠ FALSE-GREEN GUARD.
// A 2-parameter fake STRUCTURALLY SATISFIES a 3-parameter interface, so a fake that records
// only {w, h} would compile, silently drop dpr, and report GREEN on an impl that never
// threads it. And vitest transpiles without typechecking, so a type error in this file never
// reds the test run. Therefore, by construction below:
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
import { viewportScale } from './viewport';

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

/** uif-2: the documentElement the seam writes `--mr-ui-scale` on; records every setProperty. */
interface StyleWrite {
  name: string;
  value: string;
}

function makeFakeDocument() {
  const all: StyleWrite[] = [];
  return {
    documentElement: {
      style: {
        setProperty(name: string, value: string): void {
          all.push({ name, value });
        },
      },
    },
    /** The `--mr-ui-scale` writes only (wap-3: the seam also writes `--mr-world-scale`; the UIF2.3
     *  tests below are about the UI scale and must not see the world-scale writes). */
    get writes(): StyleWrite[] {
      return all.filter((w) => w.name === '--mr-ui-scale');
    },
    /** Every write in call order, whatever the property. */
    get allWrites(): StyleWrite[] {
      return all;
    },
  };
}

interface FakeWindow {
  innerWidth: number;
  innerHeight: number;
  /** MUTABLE on purpose: a monitor drag changes it between fires (uxd1 A12). */
  devicePixelRatio: number;
  readonly document: ReturnType<typeof makeFakeDocument>;
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
    document: makeFakeDocument(),
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

// -----------------------------------------------------------------------------
// uif-2 (M-ui-foundation) UIF2.3: the same event that sizes the renderer writes
// `--mr-ui-scale` on the injected documentElement. Titles start with the gate id.
// -----------------------------------------------------------------------------

const SCALE_PROP = '--mr-ui-scale';

describe('UIF2.3 resize wiring writes --mr-ui-scale', () => {
  it('UIF2.3 writes the scale at install: literal 1920x1080@1 is "1.5"', () => {
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(1920, 1080, 1);
    installResizeHandler(renderer, win);
    expect(win.document.writes).toEqual([{ name: SCALE_PROP, value: '1.5' }]);
    expect(renderer.calls).toEqual([{ w: 1920, h: 1080, dpr: 1 }]);
  });

  it('UIF2.3 rewrites on each fire with the fire-time size (not the install-time one)', () => {
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(1920, 1080, 1);
    installResizeHandler(renderer, win);
    win.innerWidth = 1280;
    win.innerHeight = 720;
    win.fire();
    win.innerWidth = 3840;
    win.innerHeight = 2160;
    win.fire();
    win.innerWidth = 960;
    win.innerHeight = 540;
    win.fire();
    expect(win.document.writes.map((w) => w.value)).toEqual(['1.5', '1', '3', '0.875']);
    expect(renderer.calls).toEqual([
      { w: 1920, h: 1080, dpr: 1 },
      { w: 1280, h: 720, dpr: 1 },
      { w: 3840, h: 2160, dpr: 1 },
      { w: 960, h: 540, dpr: 1 },
    ]);
  });

  it('UIF2.3 the written value equals String(viewportScale(w,h,dpr).uiScale) at fractional sizes too', () => {
    for (const [w, h, dpr] of [
      [1000, 800, 1],
      [1536, 864, 1.25],
      [801, 777, 2],
      [2000, 1999, 1.5],
    ] as const) {
      const renderer = makeFakeRenderer();
      const win = makeFakeWindow(w, h, dpr);
      installResizeHandler(renderer, win);
      expect(win.document.writes).toEqual([
        { name: SCALE_PROP, value: String(viewportScale(w, h, dpr).uiScale) },
      ]);
    }
    // The literal for the 1.2 row (1536x864@1.25).
    const win = makeFakeWindow(1536, 864, 1.25);
    installResizeHandler(makeFakeRenderer(), win);
    expect(win.document.writes[0]?.value).toBe('1.2');
  });

  it('UIF2.3 exactly one setProperty per event, always the property --mr-ui-scale', () => {
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(1280, 720, 1);
    installResizeHandler(renderer, win);
    expect(win.document.writes).toHaveLength(1);
    win.fire();
    win.fire();
    expect(win.document.writes).toHaveLength(3);
    for (const w of win.document.writes) expect(w.name).toBe('--mr-ui-scale');
  });

  it('UIF2.3 a resize event where only the dpr differs re-calls the renderer and rewrites the same scale', () => {
    const renderer = makeFakeRenderer();
    const win = makeFakeWindow(1920, 1080, 1);
    installResizeHandler(renderer, win);
    win.devicePixelRatio = 2;
    win.fire();
    expect(renderer.calls[1]).toEqual({ w: 1920, h: 1080, dpr: 2 });
    expect(win.document.writes).toEqual([
      { name: SCALE_PROP, value: '1.5' },
      { name: SCALE_PROP, value: '1.5' },
    ]);
  });

  it('UIF2.3 each of innerWidth, innerHeight, devicePixelRatio is read exactly once per event, and the renderer and the scale share that read', () => {
    // Each read returns a DIFFERENT value, so a second read would desynchronize the pair.
    const widths = [1280, 1920, 2560, 3840];
    const heights = [720, 1080, 1440, 2160];
    const dprs = [1, 1.25, 1.5, 2];
    const reads = { w: 0, h: 0, d: 0 };
    const doc = makeFakeDocument();
    let cb: (() => void) | undefined;
    const win = {
      get innerWidth(): number {
        return widths[reads.w++] ?? -1;
      },
      get innerHeight(): number {
        return heights[reads.h++] ?? -1;
      },
      get devicePixelRatio(): number {
        return dprs[reads.d++] ?? -1;
      },
      document: doc,
      addEventListener(_type: string, listener: () => void): void {
        cb = listener;
      },
    };
    const renderer = makeFakeRenderer();
    installResizeHandler(renderer, win);
    expect(reads).toEqual({ w: 1, h: 1, d: 1 });
    expect(renderer.calls).toEqual([{ w: 1280, h: 720, dpr: 1 }]);
    expect(doc.writes.map((x) => x.value)).toEqual(['1']);

    cb?.();
    expect(reads).toEqual({ w: 2, h: 2, d: 2 });
    expect(renderer.calls[1]).toEqual({ w: 1920, h: 1080, dpr: 1.25 });
    expect(doc.writes.map((x) => x.value)).toEqual(['1', '1.5']);

    cb?.();
    expect(reads).toEqual({ w: 3, h: 3, d: 3 });
    expect(renderer.calls[2]).toEqual({ w: 2560, h: 1440, dpr: 1.5 });
    expect(doc.writes.map((x) => x.value)).toEqual(['1', '1.5', '2']);
    for (const [i, c] of renderer.calls.entries()) {
      expect(doc.writes[i]?.value, `event ${i}`).toBe(
        String(viewportScale(c.w, c.h, c.dpr).uiScale),
      );
    }
  });
});

// -----------------------------------------------------------------------------
// wap-3 WAP3.3: the same event also writes `--mr-world-scale` (the world's source-px -> CSS-px
// stage scale), so the board's CSS art sizes track the world at any dpr.
// -----------------------------------------------------------------------------

const WORLD_PROP = '--mr-world-scale';
const worldWrites = (doc: ReturnType<typeof makeFakeDocument>): string[] =>
  doc.allWrites.filter((w) => w.name === WORLD_PROP).map((w) => w.value);

describe('WAP3.3 resize wiring writes --mr-world-scale', () => {
  it('WAP3.3 writes the stage scale at install: 1280x720@1 is "2" and 1279x720@1.25 is "2.4", beside --mr-ui-scale', () => {
    // WRONG IMPL KILLED: no world-scale write at all; the ui scale written under the world-scale
    // name (1.25 / 1.2 instead of 2 / 2.4); the integer deviceScale written instead of the CSS-px
    // stageScale (1279x720@1.25 would print 3, not 2.4); the dpr dropped (stageScale 3); the
    // ui-scale write displaced.
    for (const [w, h, dpr, world, ui] of [
      [1280, 720, 1, '2', '1'],
      [1279, 720, 1.25, '2.4', String(viewportScale(1279, 720, 1.25).uiScale)],
    ] as const) {
      const win = makeFakeWindow(w, h, dpr);
      installResizeHandler(makeFakeRenderer(), win);
      expect(worldWrites(win.document), `${w}x${h}@${dpr} world scale`).toEqual([world]);
      expect(
        win.document.writes.map((x) => x.value),
        `${w}x${h}@${dpr} ui scale still written`,
      ).toEqual([ui]);
    }
  });

  it('WAP3.3 every event rewrites the world scale from the fire-time size and dpr, equal to String(viewportScale(w,h,dpr).stageScale)', () => {
    // WRONG IMPL KILLED: a value captured at install (every later write repeats "2"); a write only
    // at install and never on resize; the dpr read at install but the size at fire-time; a stage
    // scale rounded to an integer; a write that happens only when the size changed (the
    // dpr-only event below must still rewrite).
    const win = makeFakeWindow(1280, 720, 1);
    installResizeHandler(makeFakeRenderer(), win);
    const steps: ReadonlyArray<readonly [number, number, number]> = [
      [1279, 720, 1.25],
      [1920, 1080, 1],
      [1920, 1080, 2],
      [960, 540, 1.5],
      [1280, 720, 1],
    ];
    const want = ['2'];
    for (const [w, h, dpr] of steps) {
      win.innerWidth = w;
      win.innerHeight = h;
      win.devicePixelRatio = dpr;
      win.fire();
      want.push(String(viewportScale(w, h, dpr).stageScale));
    }
    expect(worldWrites(win.document)).toEqual(want);
    expect(want[1], 'fixture: the fractional-dpr case is the literal 2.4').toBe('2.4');
    expect(want[want.length - 1], 'back at 1280x720@1 the scale is 2 again').toBe('2');
  });

  it('WAP3.3 each event makes exactly one world-scale write and one ui-scale write', () => {
    // WRONG IMPL KILLED: a double write per event (a flicker between two values); the world scale
    // written on fire but not at install, or the reverse.
    const win = makeFakeWindow(1280, 720, 1);
    installResizeHandler(makeFakeRenderer(), win);
    win.fire();
    win.fire();
    expect(worldWrites(win.document)).toHaveLength(3);
    expect(win.document.writes).toHaveLength(3);
    expect(win.document.allWrites).toHaveLength(6);
  });
});
