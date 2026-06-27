// render/resizeWiring.ts — wire the renderer's resize() to the window (M8.5f).
//
// Pure structural seam (no real DOM/PixiJS types): the renderer just needs a
// resize(w, h) and the window an addEventListener + innerWidth/innerHeight, so this
// is node-unit-testable against fakes. `window` satisfies the structural `win` type.

interface Resizable {
  resize(w: number, h: number): void;
}

interface ResizeWindow {
  innerWidth: number;
  innerHeight: number;
  addEventListener(type: string, cb: () => void): void;
}

/**
 * Size the renderer to the window now, and re-size on every `'resize'` event. The
 * listener reads `win.innerWidth/innerHeight` at fire-time (not capture-time) so it
 * tracks the live window dimensions.
 */
export function installResizeHandler(renderer: Resizable, win: ResizeWindow): void {
  renderer.resize(win.innerWidth, win.innerHeight); // initial fit
  win.addEventListener('resize', () => {
    renderer.resize(win.innerWidth, win.innerHeight); // dims at fire-time
  });
}
