// render/motionPreference.test.ts — m23-s7 acceptance suite (vitest, node-only).
//
// SOURCE OF TRUTH: M23-accessibility.spec.md §2.5 (EARS A11Y-27 "the renderer honours
// the OS reduced-motion preference").
//
// The module is driven through INJECTED fakes only: a plain-object `MatchMediaHost`
// and a recording `MotionQuery`. No happy-dom, no real `window`. That injected seam is
// what makes the module 100% unit-coverable — it is NOT in vite.config.ts's coverage
// exclude set and (plan §5 AP10) must never be added to it.
//
// THE ZERO-ARG DEFAULT IS TESTED TOO: `motionPreferenceFromWindow()` resolves its
// `host = window` default at CALL time, so `vi.stubGlobal('window', fake)` can put a
// plain fake host there for the duration of one test — still node-only, still no
// happy-dom. That bare call IS the S5 wiring contract, and a default wired to anything
// else leaves every other test in this file green, so it gets its own test.

import { describe, expect, it, vi } from 'vitest';
import {
  createMotionPreference,
  type MatchMediaHost,
  type MotionPreference,
  type MotionQuery,
  motionPreferenceFromWindow,
  REDUCED_MOTION_QUERY,
} from './motionPreference';

// ---------------------------------------------------------------------------
// Injected fakes
// ---------------------------------------------------------------------------

type ChangeListener = (e: { readonly matches: boolean }) => void;

interface Registration {
  readonly type: string;
  readonly listener: ChangeListener;
}

/**
 * A recording MediaQueryList stand-in.
 *
 * `matches` is deliberately MUTABLE even though `MotionQuery` declares it readonly:
 * the real MediaQueryList updates `matches` BEFORE it dispatches `change`, so `fire()`
 * below does the same. WHY that matters: a correct implementation may read either the
 * event payload (`e.matches`) or the live `mql.matches`; both are right in a browser,
 * so the fake keeps them in agreement and this suite pins the OBSERVABLE contract
 * instead of the implementer's choice of source.
 */
class FakeMotionQuery implements MotionQuery {
  matches: boolean;
  readonly added: Registration[] = [];
  readonly removed: Registration[] = [];

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: 'change', listener: ChangeListener): void {
    this.added.push({ type, listener });
  }

  removeEventListener(type: 'change', listener: ChangeListener): void {
    this.removed.push({ type, listener });
  }

  /** Drive a preference change exactly as a browser does: update `matches`, then
   *  dispatch to every registered listener. */
  fire(matches: boolean): void {
    this.matches = matches;
    for (const r of this.added) r.listener({ matches });
  }
}

describe('m23-s7 motionPreference (A11Y-27 / A11Y-28)', () => {
  it('S7T-MP-QUERY: asks for the exact reduced-motion media string, and fromWindow keeps the host as the receiver', () => {
    // CLAUSE 1 — the literal itself. A11Y-27 names the media query verbatim; a typo
    // ('(prefers-reduced-motion)') matches nothing in a real browser and the whole
    // feature silently no-ops, with every behavioural test below still green.
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');

    // CLAUSE 2 — the RECORDED argument, not the module's source text (plan §5 AP2/AP3:
    // a self-source needle and a declaration pin are both forgeable by a decoy string
    // literal; what the seam actually PASSES at runtime is not).
    // WRONG IMPL KILLED: `mm('(prefers-reduced-motion)')`, or a module that exports the
    // right constant but queries a different string.
    const queries: string[] = [];
    const query = new FakeMotionQuery(false);
    const pref: MotionPreference = createMotionPreference((q) => {
      queries.push(q);
      return query;
    });
    expect(queries).toEqual([REDUCED_MOTION_QUERY]); // exactly one query, the right one
    expect(pref.reduceMotion).toBe(false);

    // CLAUSE 3 — receiver preservation. WRONG IMPL KILLED:
    //   `const mm = host.matchMedia; return createMotionPreference(mm);`
    // an UNBOUND extraction. In a browser that throws "Illegal invocation" the first
    // time the app runs; here `this` arrives as undefined and this assertion reds.
    // An arrow delegation (`(q) => host.matchMedia(q)`) and `.bind(host)` both pass —
    // the pinned contract is the receiver, not the syntax.
    const receivers: unknown[] = [];
    const hostQueries: string[] = [];
    const host: MatchMediaHost = {
      matchMedia(q: string): MotionQuery {
        receivers.push(this);
        hostQueries.push(q);
        return new FakeMotionQuery(true);
      },
    };

    const fromHost = motionPreferenceFromWindow(host);
    expect(hostQueries).toEqual([REDUCED_MOTION_QUERY]);
    expect(receivers.length).toBe(1);
    expect(receivers[0]).toBe(host);
    // and the injected host's answer is the one that reaches the getter — proof that
    // fromWindow really delegates to createMotionPreference rather than re-deriving.
    expect(fromHost.reduceMotion).toBe(true);
  });

  it('S7T-MP-CHANGE: registers exactly one change listener, mirrors matches, and flips both ways', () => {
    // CLAUSE 1 — the initial read mirrors `matches` for BOTH polarities. A single
    // polarity cannot tell `mql.matches` from a hardcoded `false` (or `true`).
    const qFalse = new FakeMotionQuery(false);
    const prefFalse = createMotionPreference(() => qFalse);
    expect(prefFalse.reduceMotion).toBe(false);

    const qTrue = new FakeMotionQuery(true);
    const prefTrue = createMotionPreference(() => qTrue);
    expect(prefTrue.reduceMotion).toBe(true);

    // CLAUSE 2 — exactly ONE registration, of type 'change'.
    // WRONG IMPLS KILLED: no listener at all (a snapshot-at-construction preference
    // that never notices the user flipping the OS setting mid-session); a listener
    // registered twice (double dispatch, and a leak); the legacy `addListener` shape
    // (refused in plan §1 — it would leave `added` empty here).
    expect(qFalse.added.length).toBe(1);
    expect(qFalse.added[0]!.type).toBe('change');
    expect(qTrue.added.length).toBe(1);
    expect(qTrue.added[0]!.type).toBe('change');
    // Nothing is removed at construction: the listener is page-lifetime BY DESIGN
    // (plan §8 "CUT dispose()"), so there is no teardown seam to call here.
    expect(qFalse.removed.length).toBe(0);
    expect(qTrue.removed.length).toBe(0);

    // CLAUSE 3 — a change event flips the getter, and flips it BACK.
    // WRONG IMPLS KILLED: a listener that sets `current = true` unconditionally
    // (green on the first flip, red on the second); a frozen snapshot taken at
    // construction (red on the first flip).
    qFalse.fire(true);
    expect(prefFalse.reduceMotion).toBe(true);
    qFalse.fire(false);
    expect(prefFalse.reduceMotion).toBe(false);

    // CLAUSE 4 — the two preferences are INDEPENDENT. WRONG IMPL KILLED: a
    // module-level `let current` shared by every instance (the flips above would have
    // dragged this unrelated instance to false with them).
    expect(prefTrue.reduceMotion).toBe(true);
  });

  it('S7T-MP-DEFAULT: called with ZERO arguments it reads the ambient window — the S5 wiring contract', () => {
    // WRONG IMPL KILLED: a default parameter wired to anything but the real global —
    //   `host: MatchMediaHost = {} as MatchMediaHost`   (a silent no-op preference)
    //   `host: MatchMediaHost = fakeHostForTests`       (ships the test double)
    // S5 calls `motionPreferenceFromWindow()` BARE, so the default IS the production
    // seam; every other test in this file passes a host explicitly and would stay
    // green under either mutation. `window` is resolved at CALL time, so stubbing the
    // global is enough — no happy-dom, no DOM environment, still node-only.
    const runWithStubbedWindow = (
      matches: boolean,
    ): { readonly queries: string[]; readonly reduceMotion: boolean } => {
      const queries: string[] = [];
      const fakeWindow: MatchMediaHost = {
        matchMedia(q: string): MotionQuery {
          queries.push(q);
          return new FakeMotionQuery(matches);
        },
      };
      vi.stubGlobal('window', fakeWindow);
      const pref = motionPreferenceFromWindow(); // ZERO args -> the `host = window` default
      return { queries, reduceMotion: pref.reduceMotion };
    };

    try {
      // exactly ONE query, and it is the reduced-motion one — the same contract
      // S7T-MP-QUERY pins for the injected path, now for the ambient one.
      const on = runWithStubbedWindow(true);
      expect(on.queries).toEqual([REDUCED_MOTION_QUERY]);
      expect(on.reduceMotion).toBe(true);

      // BOTH polarities: a default that returned a hardcoded preference would match
      // one of these and fail the other.
      const off = runWithStubbedWindow(false);
      expect(off.queries).toEqual([REDUCED_MOTION_QUERY]);
      expect(off.reduceMotion).toBe(false);
    } finally {
      // in a finally so a failed expectation cannot leak a fake `window` into the
      // rest of the file (or, under a shared environment, the rest of the run).
      vi.unstubAllGlobals();
    }
  });
});
