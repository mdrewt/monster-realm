// render/resizeWiring.ts — wire the renderer's resize() to the window (M8.5f, uxd1).
//
// Pure structural seam (no real DOM/PixiJS types): the renderer just needs a
// resize(cssW, cssH, dpr) and the window an addEventListener + innerWidth/
// innerHeight/devicePixelRatio, so this is node-unit-testable against fakes.
// `window` satisfies the structural `win` type.

interface Resizable {
  resize(cssW: number, cssH: number, dpr: number): void;
}

interface ResizeWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  addEventListener(type: 'resize', cb: () => void): void;
}

/**
 * Size the renderer to the window now, and re-size on every `'resize'` event. All
 * three values are read from `win` at FIRE-TIME (not capture-time), so dragging
 * the window between a retina and a non-retina monitor re-scales correctly — the
 * live `devicePixelRatio` getter is the whole mechanism, no provider needed.
 *
 * `dpr` is a REQUIRED third argument on purpose: an optional `dpr = 1` default
 * would silently restore the blurry `resolution: 1` path (uxd1, ADR-0160).
 */
export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void {
  // NOT named `fit`: biome's noFocusedTests flags that identifier as Jest's
  // focused-test helper.
  const syncSize = () => renderer.resize(win.innerWidth, win.innerHeight, win.devicePixelRatio);
  syncSize(); // initial fit
  win.addEventListener('resize', syncSize);
}
