// render/resizeWiring.ts — wire the renderer's resize() and the UI scale to the window.
//
// Pure structural seam (no real DOM/PixiJS types): the renderer just needs a
// resize(cssW, cssH, dpr) and the window an addEventListener + innerWidth/
// innerHeight/devicePixelRatio + the root's style, so this is node-unit-testable
// against fakes. `window` satisfies the structural `win` type.
import { viewportScale } from './viewport';

interface Resizable {
  resize(cssW: number, cssH: number, dpr: number): void;
}

interface ResizeWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly document: {
    readonly documentElement: {
      readonly style: { setProperty(name: string, value: string): void };
    };
  };
  addEventListener(type: 'resize', cb: () => void): void;
}

/**
 * Size the renderer and `--mr-ui-scale` to the window now, and again on every `'resize'`
 * event. All three values are read once per event, from `win` at FIRE-TIME (not capture-time),
 * so a resize after a monitor drag re-scales correctly and the world and the chrome see one set
 * of numbers. A devicePixelRatio change with no size change fires no `resize` in Chromium
 * (measured): the world then waits for the next one, and `uiScale` does not depend on the dpr.
 *
 * `dpr` is a REQUIRED third argument on purpose: an optional `dpr = 1` default
 * would silently restore the blurry `resolution: 1` path.
 */
export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void {
  // NOT named `fit`: biome's noFocusedTests flags that identifier as Jest's
  // focused-test helper.
  const syncSize = () => {
    const cssW = win.innerWidth;
    const cssH = win.innerHeight;
    const dpr = win.devicePixelRatio;
    renderer.resize(cssW, cssH, dpr);
    const { uiScale } = viewportScale(cssW, cssH, dpr);
    win.document.documentElement.style.setProperty('--mr-ui-scale', String(uiScale));
  };
  syncSize(); // initial fit
  win.addEventListener('resize', syncSize);
}
