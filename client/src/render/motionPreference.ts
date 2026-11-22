// render/motionPreference.ts — the OS reduced-motion preference read (
// M23-accessibility spec §2.5). SHELL-ONLY: this module mirrors one
// OS bit and decides nothing — what reduced motion *means* is RenderResolver's
// business, reached only through the injected `ResolveInput.reduceMotion` field.
//
// THE SOLE matchMedia CALLER: the client asks the browser once. `shell/screenContext.ts`
// constructs the one preference at import, and the boot tests count one query and one
// change listener for the whole page. Do not read matchMedia — or any global — anywhere
// else; read that module's `motionPreference`, or inject this module's output.
//
// Two functions on purpose: with the injected factory alone, the caller would have to
// write the matchMedia read inline, a second place that reads the global.
// `motionPreferenceFromWindow` IS the one permitted read; `createMotionPreference` is the
// injected seam the tests (and any other host) drive.
//
// LIFECYCLE: the change listener is page-lifetime BY DESIGN. There is no dispose()
// — the shell has no teardown path, and speculative teardown surface is YAGNI; add one
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
