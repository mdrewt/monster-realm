// render/motionPreference.ts — the OS reduced-motion preference read (m23-s7,
// M23-accessibility spec §2.5, A11Y-27/A11Y-28). SHELL-ONLY: this module mirrors one
// OS bit and decides nothing — what reduced motion *means* is RenderResolver's
// business, reached only through the injected `ResolveInput.reduceMotion` field.
//
// THE SOLE matchMedia CALLER. A11Y-28 pins mechanically that `matchMedia` appears in
// non-test client/src ONLY here (in-slice: the S7T-SCAN source scan in
// motionPreference.test.ts; repo-wide: evals/reduced-motion-purity.eval.mjs, an S10
// deliverable). Do not read matchMedia — or any global — anywhere else; inject this
// module's output instead.
//
// S7 → S5 CROSS-SLICE CONTRACT: S7 ships this module UNCONSUMED. S5 (the sole
// main.ts slice) wires it at the existing render-loop call site:
//   const motion = motionPreferenceFromWindow();          // beside main.ts:236
//   … resolver.resolve({ …, reduceMotion: motion.reduceMotion });  // main.ts:2719
// Two functions on purpose: a purely-injected module would satisfy A11Y-28
// VACUOUSLY (zero occurrences) and force S5 to write the matchMedia read inline in
// main.ts — violating A11Y-28 the moment it lands. `motionPreferenceFromWindow` IS
// the one permitted read; `createMotionPreference` is the injected seam the tests
// (and any future host) drive.
//
// LIFECYCLE: the change listener is page-lifetime BY DESIGN. There is no dispose()
// — main.ts has no teardown path, and speculative teardown surface is YAGNI; add one
// only when a real teardown seam exists. (A MediaQueryList listener held for the
// page's life is not a leak.)

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The structural subset of MediaQueryList this module touches. No
 *  removeEventListener: with no dispose() there is no teardown seam, and declaring
 *  a capability nothing calls would re-add the surface the design review cut. A
 *  real MediaQueryList satisfies this narrower shape structurally. */
export interface MotionQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: (e: { readonly matches: boolean }) => void): void;
}

/** The structural subset of `window` this module touches. */
export interface MatchMediaHost {
  matchMedia(query: string): MotionQuery;
}

/** What consumers see: a pull-based live bit. Read it per frame; never cache it. */
export interface MotionPreference {
  readonly reduceMotion: boolean;
}

/**
 * Fully-injected factory — no global reads, which is what makes this module 100%
 * unit-coverable (it is deliberately NOT in vite.config.ts's coverage excludes).
 * Queries `mm` exactly once, mirrors the initial `matches`, then tracks `change`.
 */
export function createMotionPreference(mm: (query: string) => MotionQuery): MotionPreference {
  const mql = mm(REDUCED_MOTION_QUERY);
  let current = mql.matches;
  mql.addEventListener('change', (e) => {
    current = e.matches;
  });
  return {
    get reduceMotion(): boolean {
      return current;
    },
  };
}

/**
 * The ONE line in client/src that names `matchMedia` (see the header). An arrow —
 * never a bare `host.matchMedia` extraction or `.bind` — so the receiver is
 * preserved (a real `window.matchMedia` throws on an unbound call).
 */
export function motionPreferenceFromWindow(host: MatchMediaHost = window): MotionPreference {
  return createMotionPreference((query) => host.matchMedia(query));
}
