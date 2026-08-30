// render/motionPreference.test.ts — m23-s7 acceptance suite (vitest, node-only).
//
// SOURCE OF TRUTH: M23-accessibility.spec.md §2.5 (EARS A11Y-27 "the renderer honours
// the OS reduced-motion preference") + A11Y-28 ("`matchMedia` is read in exactly ONE
// module"). A11Y-28 is covered here PARTIALLY, in-slice: the repo-wide eval is a
// declared S10 deliverable (plan §3 "A11Y-28 ruling"), and the source-scan test at the
// foot of this file guards the S5 window in the meantime.
//
// TDD RED PHASE: `./motionPreference` does not exist yet, so this whole FILE fails to
// collect until the implementer creates it — that is the intended red for every test
// in it, including the source scan.
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
//
// S10 HANDOFF (plan §8 R-MIN-4): when `evals/reduced-motion-purity.eval.mjs` lands in
// S10, that eval and the source scan below deliberately enforce the SAME invariant. S10 may
// keep or thin this test; a DIVERGENCE between the two is a defect in one of them, not
// a conflict.
//
// rb-17 (R-m23-s10-RMEXT) CLOSED THAT DIVERGENCE, and not the way the residual predicted.
// The residual recorded this census as the NARROWER tier (`.ts` only, against the eval's five
// bundled extensions). MEASURED on the live tree, it is the WIDER one: `client/src` holds zero
// `.tsx`/`.js`/`.mjs`/`.cjs`, so the extra extensions bought nothing, while the eval's walker
// SKIPS `client/src/module_bindings` (65 generated-but-shipped, vite-bundled, main.ts-imported
// modules) and this `readdirSync` does not. Reconciling this file DOWN onto the eval's walker
// would therefore have LOOSENED the stronger tier by 65 files.
//
// So the scope predicate now has exactly ONE definition and it lives in the eval, which this
// test IMPORTS. The direction matters: a `.ts` test can import a `.mjs` eval, never the reverse
// (`indexShell.test.ts:89` is the shipped precedent, ADR-0215). The eval carries the matching
// `[A11Y-RM2g]` two-way ratchet so a drift in the OTHER, un-owned walker is a loud red there.

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
// rb-17: the SINGLE OWNER of "which client/src files does the motion census cover". Imported,
// never re-derived — two independent spellings of one scope rule is what R-m23-s10-RMEXT was.
import { isCensusSource, isCensusSpec } from '../../../evals/reduced-motion-purity.eval.mjs';
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

// ---------------------------------------------------------------------------
// Source-scan helpers (precedent: prediction/predictor.test.ts §"nh3 SIGNATURE
// SOURCE-SCAN" — readFileSync off import.meta.url, so the scan is cwd-independent).
// ---------------------------------------------------------------------------

// Comment delimiters, COMPOSED rather than written out, so that this file contains no
// raw block-comment opener outside a real comment. WHY: naive comment-stripping
// scanners elsewhere in CI treat such a literal as a comment opener and blank out
// everything after it — a measured false-RED class in this repo.
const SLASH = '/';
const STAR = '*';
const BACKTICK = String.fromCharCode(96);
const LINE_OPEN = SLASH + SLASH;
const BLOCK_OPEN = SLASH + STAR;
const BLOCK_CLOSE = STAR + SLASH;

/** The directory this test file lives in (client/src/render/) and its parent. */
const RENDER_DIR_URL = new URL('./', import.meta.url);
const CLIENT_SRC_DIR = fileURLToPath(new URL('../', import.meta.url));

/**
 * Strip `//` line comments and block comments. Deliberately string-literal-BLIND: a
 * local, minimal copy on purpose (plan §8 RT-8 — importing the evals' stripper across
 * the tree from a client unit test is a module-resolution risk). Its blind spot is
 * made inert by the explicit preconditions asserted on every file it is pointed at.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === LINE_OPEN) {
      // consume to (but not including) the newline, so line structure survives
      while (i < src.length && src.charAt(i) !== '\n') i++;
    } else if (two === BLOCK_OPEN) {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== BLOCK_CLOSE) i++;
      i += 2;
    } else {
      out += src.charAt(i);
      i++;
    }
  }
  return out;
}

/** Every module specifier appearing in a `from '...'` clause, deduped and sorted. */
function importSpecifiers(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/from '([^']*)'/g)) {
    const spec = m[1];
    if (spec !== undefined) found.add(spec);
  }
  return [...found].sort();
}

/** Read a sibling module of this test file. Fails LOUD when missing — a scan that
 *  silently read '' would pass every "must not contain" clause vacuously. */
function readRenderSource(fileName: string): string {
  const abs = fileURLToPath(new URL(fileName, RENDER_DIR_URL));
  try {
    return readFileSync(abs, 'utf8');
  } catch (err) {
    throw new Error('source unreadable at expected path: ' + abs + ' — ' + String(err));
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

  it('S7T-SCAN: matchMedia lives in motionPreference.ts alone and the render modules import only what they must (A11Y-28-partial)', () => {
    // ---- clause 0: the stripper works (anti-vacuity for clauses 2 and 3) ----------
    // A "must NOT contain" assertion over a stripper that silently strips everything
    // is vacuous; these fixtures prove it strips both comment kinds and nothing more,
    // and they are the only self-test the local stripper gets (plan §8 RT-8).
    const lineFixture = 'const a = 1; ' + LINE_OPEN + ' window\nconst b = 2;\n';
    const blockFixture =
      'const a = 1; ' + BLOCK_OPEN + ' matchMedia ' + BLOCK_CLOSE + ' const b = 2;\n';
    expect(stripComments(lineFixture).includes('window')).toBe(false);
    expect(stripComments(blockFixture).includes('matchMedia')).toBe(false);
    expect(stripComments(lineFixture).includes('const a = 1')).toBe(true); // no over-strip
    expect(stripComments(lineFixture).includes('const b = 2')).toBe(true);
    expect(stripComments(blockFixture).includes('const b = 2')).toBe(true);

    // ---- clause 1: exactly ONE non-test client/src module mentions matchMedia -----
    // RAW text on purpose: a mention in a COMMENT is still a second site an S5/S10
    // implementer could grow into a second call (plan §5 AP6 — scan the bare token,
    // not a spelling of the call).
    const allEntries = readdirSync(CLIENT_SRC_DIR, { recursive: true }).map((entry) =>
      String(entry).split(sep).join('/'),
    );
    // The `.test.ts` exemption is `endsWith`, NEVER substring (plan §8 RT-10) — and since rb-17
    // that rule is enforced in ONE place, `isCensusSource`/`isCensusSpec`, whose own teeth pin
    // both halves of it (`foo.test.ts.bak` is not source; `ui/foo.test.ts.bak.ts` IS).
    // Directories come back from a recursive readdir too; the extension gate drops them.
    const exemptedFiles = allEntries.filter(isCensusSpec);
    const tsFiles = allEntries.filter(isCensusSource);

    // rb-17: the imported predicate must be the WIDE one. These four assertions are what stop a
    // future edit from silently swapping in a `.ts`-only or bindings-skipping predicate and
    // leaving every assertion below green over a 65-file-smaller tree.
    expect(isCensusSource('ui/x.js')).toBe(true);
    expect(isCensusSpec('ui/x.test.tsx')).toBe(true);
    expect(isCensusSource('module_bindings/x.ts')).toBe(true);
    // The disguised-production-code boundary, asserted HERE and not only in the eval's own g3b:
    // red-team measured that an `.includes('.test.ts')` suffix exemption leaves this whole suite
    // 4/4 green, so the single-owner claim in this file's header needs its own check of it.
    expect(isCensusSource('ui/foo.test.ts.bak.ts')).toBe(true);
    expect(isCensusSource('foo.test.ts.bak')).toBe(false);
    expect(tsFiles.filter((rel) => rel.startsWith('module_bindings/')).length).toBeGreaterThan(20);

    // anti-vacuity: prove the walk really enumerated the client source tree before
    // judging it. A mistyped root would otherwise report "zero offenders" forever.
    // Raised 20 -> 120 with the rb-17 widening (157 live), so the floor still bites.
    expect(tsFiles.length).toBeGreaterThan(120);
    expect(tsFiles).toContain('render/renderResolver.ts');
    expect(tsFiles).toContain('render/interpolation.ts');
    expect(tsFiles).toContain('render/slideClock.ts');
    expect(tsFiles).toContain('net/store.ts');
    expect(tsFiles).not.toContain('render/renderResolver.test.ts'); // the exemption bites
    expect(exemptedFiles.length).toBeGreaterThan(5);
    expect(exemptedFiles).toContain('render/motionPreference.test.ts'); // this very file

    // ---- clause 1b: the exemption is NAME-ONLY, so police what it lets through ----
    // THE SURVIVOR THIS CLOSES: a production module DISGUISED as a test —
    // `render/evilCaller.test.ts` holding a real exported matchMedia call and zero
    // suites, imported by main.ts as ordinary code. Clause 1 skips it by name, and
    // vitest silently "passes" a matched file that declares no suites, so the whole
    // gate stays green while a second call site ships.
    // TRIPWIRE: every exempted file must actually look like a vitest suite. Judged on
    // the COMMENT-STRIPPED text, so a planted `// describe(` does not satisfy it.
    // HONEST LIMIT (declared, not papered over): this is a tripwire, not a defense —
    // a determined cheater plants a dummy `describe('x', () => {})` and walks through
    // it. The deeper residual (that, plus a live-PoC'd Function-constructor global
    // grab inside an ALLOWED file, plus token-splitting) is declared in the ledger and
    // compensated by the mandatory desync-guard review and S10's repo-wide eval.
    const disguisedAsTests = exemptedFiles.filter((rel) => {
      const code = stripComments(readFileSync(join(CLIENT_SRC_DIR, rel), 'utf8'));
      return !code.includes('describe(');
    });
    expect(disguisedAsTests).toEqual([]);

    const mentionsMatchMedia = tsFiles
      .filter((rel) => readFileSync(join(CLIENT_SRC_DIR, rel), 'utf8').includes('matchMedia'))
      .sort();
    // WRONG IMPL KILLED: a second `window.matchMedia(...)` inlined anywhere in the
    // client (main.ts is the likeliest second site once S5 wires this up) — the exact
    // duplication A11Y-28 exists to forbid.
    expect(mentionsMatchMedia).toEqual(['render/motionPreference.ts']);

    // ---- clause 2: the sole caller REALLY calls it (not a comment about it) -------
    // Without this, clause 1 is satisfiable by a motionPreference.ts that merely
    // MENTIONS matchMedia in its header while the real call hides somewhere else.
    const motionPrefSrc = readRenderSource('motionPreference.ts');
    expect(stripComments(motionPrefSrc).includes('matchMedia')).toBe(true);

    // ---- clause 3: renderResolver.ts touches no ambient global -------------------
    const resolverSrc = readRenderSource('renderResolver.ts');
    const resolverCode = stripComments(resolverSrc);
    // preconditions: the stripper consumed every comment, and the file contains no
    // template literal — those are the two shapes whose string-literal blindness
    // could hide a banned token from the scan below. Fail LOUD, never quietly.
    expect(resolverCode.includes(LINE_OPEN)).toBe(false);
    expect(resolverCode.includes(BLOCK_OPEN)).toBe(false);
    expect(resolverCode.includes(BACKTICK)).toBe(false);
    expect(resolverCode.includes('export class RenderResolver')).toBe(true); // the real module

    // Word-boundary LITERAL regexes only — `new RegExp` is Semgrep-banned repo-wide.
    // WRONG IMPL KILLED (plan §6 R4): a renderer that reads the preference itself
    // (`window.matchMedia(...)`, `globalThis.matchMedia(...)`, `document`, or any of
    // the window aliases `self`/`top`/`parent`/`frames`) instead of taking it as the
    // injected ResolveInput field — that is an IO read inside a coordinator the
    // module header calls pure-of-IO, and it makes the resolver need a DOM to test.
    const banned: readonly (readonly [string, RegExp])[] = [
      ['window', /\bwindow\b/],
      ['matchMedia', /\bmatchMedia\b/],
      ['globalThis', /\bglobalThis\b/],
      ['document', /\bdocument\b/],
      ['self', /\bself\b/],
      ['top', /\btop\b/],
      ['parent', /\bparent\b/],
      ['frames', /\bframes\b/],
      // and it must not reach for the preference module either (plan §5 AP8: pin
      // "not imported by render/*", never "imported by nobody" — S5 MUST import it).
      ['motionPreference', /\bmotionPreference\b/],
    ];
    const offenders = banned.filter(([, re]) => re.test(resolverCode)).map(([name]) => name);
    expect(offenders).toEqual([]);

    // ---- clauses 4-6: exact import allow-lists (the class a blacklist can't close) -
    // RAW text on purpose (plan §8 RT-2): a decoy `from './x'` planted in a comment
    // makes the SET mismatch and this test fails LOUD — the safe polarity for an
    // allow-list, where a comment-stripping variant would let the decoy hide instead.
    // WRONG IMPL KILLED: renderResolver.ts growing an import of ./motionPreference,
    // ../net/settings, or any other new dependency to fetch the preference itself.
    expect(importSpecifiers(resolverSrc)).toEqual([
      '../convert/convert',
      '../net/store',
      './interpolation',
      './slideClock',
      './world',
    ]);
    // motionPreference.ts is a LEAF: zero imports. WRONG IMPL KILLED: importing the
    // store/predictor to stash the preference there (plan §6 R4), or importing
    // ./config for a "constant" that belongs in this module.
    expect(importSpecifiers(motionPrefSrc)).toEqual([]);
    // interpolation.ts stays PURE: ./config and nothing else. WRONG IMPL KILLED:
    // importing ../net/store to type the new function's parameter (plan §2 forbids
    // it — the parameter is a structural local interface).
    expect(importSpecifiers(readRenderSource('interpolation.ts'))).toEqual(['./config']);
  });
});
