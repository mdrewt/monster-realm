// @vitest-environment happy-dom
/**
 * main.i18nBoot.test.ts — RUNTIME + SOURCE gate over main.ts's boot-time locale negotiation
 * (m24-s6; M24-internationalization.spec.md §2.7/§6 I18N-22; ADR-0262 pending).
 *
 * SOURCE OF TRUTH — EARS criterion I18N-22: WHEN the client boots THE app SHALL negotiate a
 * locale from (in priority order) a `?locale=` URL override, then `navigator.languages`, THEN
 * `setLocale` it into the i18n resolver, AND write it onto `<html lang>`/`<html dir>` exactly
 * once each, on every boot, before `async function main(` runs. An unregistered override tag
 * MUST fall through (never throw); an unregistered navigator tag MUST fall through to `en`.
 *
 * THE PLANNED HUNK (module scope, right after `fateLogger`, before `const ZONE_ID = 0;`):
 *   const LOCALE = negotiateLocale(
 *     [...new URLSearchParams(window.location.search).getAll('locale'), ...navigator.languages],
 *     Object.keys(CATALOGS),
 *   );
 *   setLocale(LOCALE);
 *   document.documentElement.lang = LOCALE;
 *   document.documentElement.dir = isRtl(LOCALE) ? 'rtl' : 'ltr';
 * with `import { isRtl, negotiateLocale } from './ui/i18n/locale';` and
 * `import { CATALOGS, setLocale, t as i18nT, tf } from './ui/i18n/resolver';`, plus six
 * `reportError(...)` literal-to-`i18nT`/`tf` migrations (BOOT-06).
 *
 * WHY A RUNTIME IMPORT FOR BOOT-01..04/07 — main.wiring.test.ts's own rule is "source-scan
 * (NOT import): main.ts has DOM/wasm side effects — importing it in vitest would crash on
 * missing DOM/wasm globals." This defect is about which VALUES the negotiation reads
 * (`navigator.languages`, `window.location.search`) and where they land (a DOM attribute write,
 * a resolver-cell mutation), which no text scan can observe — only a real module evaluation can.
 * Modelled on `main.reducedMotionWiring.test.ts` (17r-a): SAME wasm-pkg / ./net/connection /
 * ./observability/telemetry / ./render/world mocks, SAME recordListeners + afterEach cleanup,
 * SAME controllable rAF stub, SAME `vi.resetModules()` + `await import('./main')` +
 * `vi.waitFor` on the connect() capture. The `./render/renderResolver` mock is dropped — this
 * file never drives a frame.
 *
 * WHY WRAP `document.documentElement.setAttribute` RATHER THAN SHADOW THE `lang`/`dir`
 * ACCESSORS (red-team correction, plan-review-findings.md): happy-dom's `.lang =` / `.dir =`
 * property setters funnel through `setAttribute` internally (happy-dom HTMLElement.js:643-710),
 * so wrapping `setAttribute` catches BOTH `element.lang = x` and
 * `element.setAttribute('lang', x)` forms. Shadowing the `lang`/`dir` accessors directly would
 * MISS a `setAttribute('lang', …)` call outright, and — because the shadow would be installed as
 * an own-property override that this file's own precedent (`recordListeners`) proves must be
 * restored via the captured own-descriptor, not merely deleted — a naive shadow left in place
 * would LEAK across every later test in this file. The wrapper here follows the exact
 * `recordListeners` own-property-restore shape for the identical reason.
 *
 * NO try/catch around `await import('./main')` (red-team correction): a wrong impl that calls
 * `setLocale('xx')` directly (rather than treating an unregistered override as merely a
 * `negotiateLocale` CANDIDATE) throws at module-evaluation time under this file's mock resolver
 * (which throws on an unregistered locale exactly like the real one) — that MUST surface as a
 * rejected `await import('./main')` failing the test by name, never be swallowed.
 *
 * RED REASON (ALL SEVEN, at HEAD): main.ts has no `./ui/i18n/locale` or `./ui/i18n/resolver`
 * import, no `negotiateLocale(`/`setLocale(` call, and never writes `documentElement.lang`/
 * `.dir` at all — BOOT-01..04/07 all fail on an empty `H.setLocaleCalls`/`attrWrites` (the
 * mocked `setLocale` is never invoked; the wrapped `setAttribute` never records a 'lang'/'dir'
 * write). BOOT-05/06 are static source-scans that fail because the needles they search for
 * (`negotiateLocale(`, `setLocale(`, the DOM-write statements, the six `i18nT(`/`tf(` chrome.
 * status.* call sites, the two new import lines) are simply absent from main.ts today, and the
 * six raw English literals BOOT-06 asserts are gone are still present verbatim.
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`/assertion.
 *
 * NO `new RegExp(...)`, no regex literal, no `eval`, no `new Function` (ADR-0055 / Semgrep ban)
 * — every source-scan needle below is matched with `String.indexOf` loops only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule; precedent:
// client/src/ui/i18n-no-html-sink.test.ts). Path is relative to client/src/ (this file's dir).
import { stripComments } from '../../evals/dom-shell-coverage-exclusion.eval.mjs';
import type { Connection, ConnectionOptions } from './net/connection';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  /** Extra locale tags the './ui/i18n/resolver' mock should register (beyond 'en'), each
   *  mapped to the real English catalog object — set by setupMain() BEFORE vi.resetModules()
   *  so the mock factory (which re-runs per fresh module-registry generation) reads it fresh. */
  extraLocales: [] as string[],
  /** Every locale tag ever passed to the mocked setLocale, in call order. THE observation
   *  channel for "was setLocale called, with what, how many times". */
  setLocaleCalls: [] as string[],
  /** Our handle on the connect() call's options object. */
  connectOpts: null as ConnectionOptions | null,
}));

// The wasm pkg — identical shape to the sanctioned precedent (main.reducedMotionWiring.test.ts).
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    zone_map: (zoneId: number) => ({
      zone_id: zoneId,
      width: SIDE,
      height: SIDE,
      walkable: grid(true),
      grass: grid(false),
      warps: [],
    }),
  };
});

// The connection: capture the options object, hand back a Connection-shaped stub whose
// sessionState is 'hidden' so the frame loop's gate never drives real frame work — this file
// never needs frames, only the module-scope boot side effects.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => undefined,
    identity: () => 'ab'.repeat(32),
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
  };
  return {
    connect: (opts: ConnectionOptions): Connection => {
      H.connectOpts = opts;
      return stub;
    },
  };
});

// Telemetry: keep NOOP_TELEMETRY and the types, never bootstrap the OTel SDK (no network).
vi.mock('./observability/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./observability/telemetry')>();
  return {
    ...actual,
    loadOtelSdk: () => {
      throw new Error('loadOtelSdk must not be reached in this test');
    },
    startClientTelemetry: () => Promise.resolve(actual.NOOP_TELEMETRY),
  };
});

// The renderer: constructed unconditionally at module scope, before the #app guard.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
      return Promise.resolve();
    }
    setMap(): void {
      // no-op stub
    }
    render(): void {
      // no-op stub
    }
    resize(): void {
      // no-op stub
    }
    screenFor(): { x: number; y: number } {
      return { x: 0, y: 0 };
    }
    clear(): void {
      // no-op stub
    }
    destroy(): void {
      // no-op stub
    }
    get viewCount(): number {
      return 0;
    }
  }
  return { WorldRenderer };
});

// THE OBSERVATION CHANNEL FOR setLocale/CATALOGS/currentLocale: a fresh mock built from
// importOriginal() inside the factory (which re-runs per fresh module-registry generation), so
// it is never a stale-generation problem the way a statically-imported spy would be (see the
// reducedMotionWiring precedent's RenderResolver note for the general hazard). Keeps the REAL
// `t`/`tf` untouched (this file never exercises them at runtime) and the REAL CATALOG_EN object
// as the value behind every registered tag — 'en' always, plus whatever H.extraLocales names,
// so a test can register a second locale ('he') without a second real catalog existing yet.
vi.mock('./ui/i18n/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/i18n/resolver')>();
  const englishCatalog = actual.CATALOGS.en;
  const catalogs: Record<string, typeof englishCatalog> = { en: englishCatalog };
  for (const tag of H.extraLocales) catalogs[tag] = englishCatalog;
  const mockCatalogs: Readonly<Record<string, typeof englishCatalog>> = Object.freeze(catalogs);
  let current = actual.DEFAULT_LOCALE;
  // Throws on an unregistered locale EXACTLY like the real setLocale — see the "NO try/catch"
  // header note for why that must stay true.
  const setLocale = (locale: string): void => {
    if (!Object.hasOwn(mockCatalogs, locale)) {
      throw new Error(
        `i18n: locale '${locale}' is not registered — CATALOGS has [${Object.keys(mockCatalogs).join(', ')}]`,
      );
    }
    H.setLocaleCalls.push(locale);
    current = locale;
  };
  const currentLocale = (): string => current;
  return { ...actual, CATALOGS: mockCatalogs, setLocale, currentLocale };
});

// --- listener-cleanup harness (verbatim from main.reducedMotionWiring.test.ts) ---------
type AddListener = (
  type: string,
  handler: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
) => void;

interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}

/** Record every addEventListener on `target` (delegating to the real one) so afterEach can
 *  detach each pair — main.ts's MODULE-scope window/document listeners otherwise stack across
 *  vi.resetModules() re-imports within this file. */
function recordListeners(target: EventTarget, sink: Recorded[]): () => void {
  const hadOwn = Object.hasOwn(target, 'addEventListener');
  const ownDesc = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target) as unknown as AddListener;
  const patched: AddListener = (type, handler, options) => {
    sink.push({ target, type, handler, options });
    original(type, handler, options);
  };
  (target as unknown as { addEventListener: AddListener }).addEventListener = patched;
  return () => {
    if (hadOwn && ownDesc !== undefined) {
      Object.defineProperty(target, 'addEventListener', ownDesc);
    } else {
      delete (target as unknown as { addEventListener?: AddListener }).addEventListener;
    }
  };
}

interface AttrWrite {
  readonly name: string;
  readonly value: string;
}

/** Wrap `document.documentElement.setAttribute` (own-property override, restored via the same
 *  captured-descriptor shape as recordListeners) to record every 'lang'/'dir' write — see the
 *  header note for why this catches BOTH `.lang = x` and `.setAttribute('lang', x)` forms while
 *  shadowing the accessors directly would not. */
function wrapDocumentSetAttribute(sink: AttrWrite[]): () => void {
  const target = document.documentElement;
  const hadOwn = Object.hasOwn(target, 'setAttribute');
  const ownDesc = Object.getOwnPropertyDescriptor(target, 'setAttribute');
  const original = target.setAttribute.bind(target);
  const patched = (name: string, value: string): void => {
    if (name === 'lang' || name === 'dir') sink.push({ name, value });
    original(name, value);
  };
  (target as unknown as { setAttribute: typeof patched }).setAttribute = patched;
  return () => {
    if (hadOwn && ownDesc !== undefined) {
      Object.defineProperty(target, 'setAttribute', ownDesc);
    } else {
      delete (target as unknown as { setAttribute?: typeof patched }).setAttribute;
    }
  };
}

// --- the rAF stub: this file never drives a frame (boot-time writes only), so the callback is
// captured nowhere — main.ts's frame loop simply never runs under this harness. ---------
function stubInertRaf(): void {
  vi.stubGlobal('requestAnimationFrame', (): number => 0);
}

// --- the suite ---------------------------------------------------------------------------
// `describe(name, { sequential: true }, fn)` — NOT `describe.sequential(...)`: the literal
// `describe(` token is required by motionPreference.test.ts's S7T-SCAN tripwire, and happy-dom's
// document/window/navigator are per-FILE, so sibling tests in this file must not run concurrently.
describe('main.ts boot-time locale negotiation wiring (m24-s6, I18N-22)', {
  sequential: true,
}, () => {
  let recorded: Recorded[] = [];
  let attrWrites: AttrWrite[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;
  let restoreSetAttribute: (() => void) | undefined;

  /** Install every stub (URL, navigator.languages, DOM-write recorder, listener recorder,
   *  rAF), verify each is really what it claims to be (precondition probes), then import
   *  ./main and wait for connect() to be reached — proving the module evaluated to completion
   *  without a rejected/hung promise chain, not merely that the synchronous prefix ran. */
  async function setupMain(opts: {
    readonly languages: readonly string[];
    readonly extraLocales?: readonly string[];
    readonly url?: string;
  }): Promise<void> {
    const { languages, extraLocales = [], url = '/' } = opts;
    H.extraLocales = [...extraLocales];
    H.setLocaleCalls = [];
    H.connectOpts = null;
    attrWrites = [];

    window.history.replaceState(null, '', url);
    const expectedSearch = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    expect(
      window.location.search,
      `precondition: window.location.search must be '${expectedSearch}' right after ` +
        `replaceState(null, '', '${url}') — otherwise this test is not exercising the URL it ` +
        'claims to',
    ).toBe(expectedSearch);

    Object.defineProperty(navigator, 'languages', { value: languages, configurable: true });
    expect(
      navigator.languages,
      'precondition: navigator.languages must be the array just installed by this test — ' +
        'never read navigator.language (singular) anywhere in this rig',
    ).toEqual(languages);

    recorded = [];
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);
    restoreSetAttribute = wrapDocumentSetAttribute(attrWrites);
    stubInertRaf();

    vi.resetModules();
    // NO try/catch here — see the header note. A wrong impl that hands an unregistered tag
    // straight to setLocale() must reject this import and fail the calling test by name.
    await import('./main');
    await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
  }

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    restoreSetAttribute?.();
    restoreSetAttribute = undefined;
    attrWrites = [];
    H.connectOpts = null;
    H.setLocaleCalls = [];
    H.extraLocales = [];
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('m24s6 BOOT-01: only navigator.languages available, negotiates to the registered en fallback and writes lang=en/dir=ltr exactly once', async () => {
    await setupMain({ languages: ['he-IL', 'en-US'] });

    expect(
      H.setLocaleCalls,
      'WRONG IMPL KILLED: setLocale never called at all (the boot hunk missing entirely — the ' +
        "HEAD state), called with a hardcoded literal ('en' regardless of input), or called " +
        "more than once — CATALOGS registers only 'en' here, so negotiating " +
        "['he-IL','en-US'] against ['en'] must fall through to 'en'.",
    ).toEqual(['en']);

    const langWrites = attrWrites.filter((w) => w.name === 'lang').map((w) => w.value);
    const dirWrites = attrWrites.filter((w) => w.name === 'dir').map((w) => w.value);
    expect(
      langWrites,
      'WRONG IMPL KILLED: documentElement.lang never written (HEAD state), written via a ' +
        'shadowed lang accessor this setAttribute wrapper cannot observe, or written more ' +
        'than once (a boot hunk that runs twice, or one that writes lang inside a loop).',
    ).toEqual(['en']);
    expect(
      dirWrites,
      "WRONG IMPL KILLED: dir never written, or hardcoded to 'ltr' unconditionally — this " +
        'single assertion alone cannot distinguish a hardcoded ltr from a correctly-computed ' +
        'one (BOOT-02 does, via a non-Latin locale); this tooth proves the write happens at all.',
    ).toEqual(['ltr']);
    expect(
      document.documentElement.getAttribute('lang'),
      "WRONG IMPL KILLED: the wrapper recorded a 'lang' write that never reached the real " +
        'setAttribute (e.g. a delegate that swallows the call) — the DOM attribute itself ' +
        "must actually read 'en'.",
    ).toBe('en');
  });

  it('m24s6 BOOT-02: only the SECOND navigator language tag matches a registered non-English locale (kills a navigator.language singular reader)', async () => {
    await setupMain({ languages: ['xx-XX', 'he-IL'], extraLocales: ['he'] });

    expect(
      H.setLocaleCalls,
      'WRONG IMPL KILLED: a `navigator.language` (singular) reader — that global is never ' +
        'defined anywhere in this rig, so reading it yields undefined and negotiateLocale ' +
        "falls through to 'en', not 'he'. Also kills: feeding negotiateLocale only " +
        "requested[0] ('xx-XX', which matches nothing) instead of the whole array.",
    ).toEqual(['he']);

    const langWrites = attrWrites.filter((w) => w.name === 'lang').map((w) => w.value);
    const dirWrites = attrWrites.filter((w) => w.name === 'dir').map((w) => w.value);
    expect(
      langWrites,
      'WRONG IMPL KILLED: lang written with the WRONG negotiated value, or written more than ' +
        'once.',
    ).toEqual(['he']);
    expect(
      dirWrites,
      "WRONG IMPL KILLED: dir computed from a REQUESTED tag ('xx-XX'/'he-IL', neither of which " +
        "isRtl() recognises as-is) instead of the NEGOTIATED result 'he' — isRtl('he') is " +
        "true, so a correct impl must write 'rtl' here. This is the tooth BOOT-01's " +
        "hardcoded-'ltr' mutant cannot pass.",
    ).toEqual(['rtl']);
  });

  it('m24s6 BOOT-03: a ?locale= URL override beats navigator.languages', async () => {
    await setupMain({ languages: ['en-US'], extraLocales: ['he'], url: '/?locale=he' });

    expect(
      H.setLocaleCalls,
      'WRONG IMPL KILLED: the ?locale= query param is never read (or read via the wrong URL ' +
        "API), so only navigator.languages ['en-US'] drives negotiation and lands on 'en' " +
        "instead of the override 'he'.",
    ).toEqual(['he']);
    const dirWrites = attrWrites.filter((w) => w.name === 'dir').map((w) => w.value);
    expect(
      dirWrites,
      'WRONG IMPL KILLED: the override is set-located but not threaded into the dir ' +
        "computation (dir still derived from navigator.languages) — isRtl('he') must drive " +
        "dir to 'rtl' here.",
    ).toEqual(['rtl']);
  });

  it('m24s6 BOOT-04: an UNKNOWN ?locale= override falls through to navigator.languages without throwing', async () => {
    await setupMain({ languages: ['he-IL'], extraLocales: ['he'], url: '/?locale=xx' });

    expect(
      H.setLocaleCalls,
      "WRONG IMPL KILLED: an unregistered override tag ('xx') handed straight to setLocale " +
        'instead of merely being one negotiateLocale CANDIDATE among several — that would ' +
        'throw under this mock (it throws on an unregistered locale exactly like the real ' +
        "one), rejecting `await import('./main')` and failing this test outright rather than " +
        "falling through to the next candidate ('he-IL' truncating to the registered 'he').",
    ).toEqual(['he']);
  });

  it('m24s6 BOOT-05 (source): negotiateLocale(/setLocale(/lang/dir writes exist exactly once each, in order, before async function main(, and main.ts never names help-hint', () => {
    const raw = readMainTs();
    const squashed = squashWhitespace(stripComments(raw));

    expect(
      countOccurrences(squashed, 'negotiateLocale('),
      'WRONG IMPL KILLED: no negotiateLocale( call at all (HEAD state), or it appears more ' +
        'than once (e.g. duplicated at module scope AND again inside main()).',
    ).toBe(1);

    const negotiateIdx = squashed.indexOf('negotiateLocale(');
    const mainFnIdx = squashed.indexOf('async function main(');
    expect(mainFnIdx, 'async function main( must exist in main.ts').toBeGreaterThanOrEqual(0);
    expect(
      negotiateIdx,
      'WRONG IMPL KILLED: negotiateLocale( moved INSIDE async function main( (or under a ' +
        'try/catch there) — runtime-indistinguishable from module scope on a happy path, but ' +
        'loses the fail-fast-before-connect guarantee the F-3 module-scope pattern exists for.',
    ).toBeLessThan(mainFnIdx);
    expect(
      squashed.slice(mainFnIdx).indexOf('negotiateLocale('),
      'WRONG IMPL KILLED: a SECOND negotiateLocale( call duplicated inside main() (the total ' +
        'count above already forbids this; this checks the exact half where it would land).',
    ).toBe(-1);

    expect(
      countOccurrences(squashed, 'setLocale('),
      'WRONG IMPL KILLED: setLocale( missing entirely (HEAD state), or called more than once.',
    ).toBe(1);

    const langNeedle = 'document.documentElement.lang = LOCALE;';
    const dirNeedle = "document.documentElement.dir = isRtl(LOCALE) ? 'rtl' : 'ltr';";
    expect(
      countOccurrences(squashed, langNeedle),
      'WRONG IMPL KILLED: the lang DOM write is missing, written more than once, or written ' +
        'from a value other than the negotiated LOCALE (e.g. a hardcoded literal or ' +
        'currentLocale() instead of the local LOCALE binding).',
    ).toBe(1);
    expect(
      countOccurrences(squashed, dirNeedle),
      'WRONG IMPL KILLED: the dir DOM write is missing, written more than once, or computed ' +
        'from anything other than isRtl(LOCALE) with the exact rtl/ltr ternary shape.',
    ).toBe(1);

    const setLocaleIdx = squashed.indexOf('setLocale(');
    const langIdx = squashed.indexOf(langNeedle);
    const dirIdx = squashed.indexOf(dirNeedle);
    expect(
      setLocaleIdx,
      'WRONG IMPL KILLED: the DOM writes ordered BEFORE setLocale( — an unregistered-locale ' +
        'throw from setLocale would then have already left a stale/wrong lang+dir on the page.',
    ).toBeLessThan(langIdx);
    expect(
      langIdx,
      'WRONG IMPL KILLED: dir written before lang, or the two writes interleaved with other ' +
        'code in a way that swaps their relative order.',
    ).toBeLessThan(dirIdx);

    expect(
      raw.indexOf('help-hint'),
      'WRONG IMPL KILLED: main.ts names the help-hint DOM id anywhere (even in a comment) — ' +
        'ADR-0151 D2 / W-UX1-HINT-NO-JS-OWNER reserve #help-hint as a static index.html-only ' +
        'string; S6 must not become a second owner of it. Checked on RAW source (comments ' +
        'included), never the stripped text.',
    ).toBe(-1);

    expect(
      countOccurrences(squashed, "import { isRtl, negotiateLocale } from './ui/i18n/locale';"),
      'WRONG IMPL KILLED: the locale.ts import missing, duplicated, or its named specifiers ' +
        'out of the biome-sorted alphabetical order (isRtl before negotiateLocale).',
    ).toBe(1);
    expect(
      countOccurrences(
        squashed,
        "import { CATALOGS, setLocale, t as i18nT, tf } from './ui/i18n/resolver';",
      ),
      'WRONG IMPL KILLED: the resolver.ts import missing, duplicated, aliased differently ' +
        '(e.g. `t as tChrome`, which would make the S7 DEAD-KEY census key on the wrong bare ' +
        'token), or its specifiers out of the biome-sorted alphabetical order.',
    ).toBe(1);
  });

  it('m24s6 BOOT-06 (source): the six chrome.status.* reportError sites resolve through i18nT(/tf(, and their raw English literals are gone', () => {
    const raw = readMainTs();
    const squashed = squashWhitespace(stripComments(raw));
    const REPORT_ERROR_OPEN = 'reportError(';

    for (const pin of CHROME_STATUS_PINS) {
      const count = countOccurrences(squashed, pin.call);
      expect(
        count,
        `WRONG IMPL KILLED (${pin.key}): the call ${pin.call} is missing entirely (HEAD state ` +
          '— the raw English literal is still passed to reportError directly), or it appears ' +
          'more than once.',
      ).toBe(1);

      const callIdx = squashed.indexOf(pin.call);
      const precedingSlice = squashed.slice(callIdx - REPORT_ERROR_OPEN.length, callIdx);
      expect(
        precedingSlice,
        `WRONG IMPL KILLED (${pin.key}): ${pin.call} exists somewhere in main.ts but is NOT ` +
          `the direct argument of reportError( immediately before it (e.g. resolved into a ` +
          'local variable several statements away from its call site, which this exact-' +
          'adjacency check refuses to credit as "migrated").',
      ).toBe(REPORT_ERROR_OPEN);

      expect(
        countOccurrences(squashed, pin.rawLiteral),
        `WRONG IMPL KILLED (${pin.key}): the pre-migration raw English literal ${pin.rawLiteral} ` +
          'is still present in main.ts — a partial migration that adds the i18nT/tf call ' +
          'without removing the literal it replaces (e.g. left behind in a comment, or the ' +
          'literal passed to reportError alongside the new call as a second, unused argument).',
      ).toBe(0);
    }

    expect(
      countOccurrences(squashed, "import { t } from './ui/a11yCopy';"),
      'WRONG IMPL KILLED: the frozen ADR-0206/W-M23S5-LIVEREGION-PUMP a11yCopy import was ' +
        'touched, duplicated, or removed while migrating the six chrome.status.* sites.',
    ).toBe(1);
    expect(
      countOccurrences(squashed, "t('a11y.world.region')"),
      'WRONG IMPL KILLED: the frozen M23S5-A11YSNAPSHOT live-region announcement call site ' +
        "was renamed to i18nT('a11y.world.region') (or otherwise altered) while migrating the " +
        'six unrelated chrome.status.* sites — this region is byte-pinned elsewhere and must ' +
        'stay on the bare a11yCopy `t(`.',
    ).toBe(1);
  });

  it('m24s6 BOOT-07: multiple ?locale= query values cascade through ALL of them (getAll, not get)', async () => {
    await setupMain({
      languages: ['en-US'],
      extraLocales: ['he'],
      url: '/?locale=xx&locale=he',
    });

    expect(
      H.setLocaleCalls,
      "WRONG IMPL KILLED: reading the override via URLSearchParams.get('locale') instead of " +
        "getAll('locale') — get() yields only the FIRST value ('xx'), which negotiateLocale " +
        "cannot match, so a get()-based impl falls through to navigator.languages ['en-US'] " +
        "and lands on 'en'. getAll() cascades BOTH ['xx','he'] as ordered candidates, and " +
        "'he' is the one that matches a registered locale — this is the ONE assertion in this " +
        'file that a correct .get()-based impl cannot pass.',
    ).toEqual(['he']);
  });
});

// --- source-pin support (BOOT-05/06) ------------------------------------------------------

const MAIN_TS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.ts');

function readMainTs(): string {
  try {
    return readFileSync(MAIN_TS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`main.ts could not be read at expected path: ${MAIN_TS_PATH} — ${String(err)}`);
  }
}

const WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r']);

/** Collapse every run of whitespace (including newlines from a biome-wrapped long statement)
 *  to a single space, so a source-pin needle survives reformatting without ever using a RegExp
 *  (ADR-0055 hand-rolled-scan convention). Operates on already comment-stripped text; never used
 *  to compute byte offsets into the raw file. */
function squashWhitespace(src: string): string {
  let out = '';
  let inRun = false;
  for (const ch of src) {
    if (WHITESPACE_CHARS.has(ch)) {
      if (!inRun) {
        out += ' ';
        inRun = true;
      }
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

/** Non-overlapping occurrence count of `needle` in `haystack` via String.indexOf — no RegExp. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

interface ChromeStatusPin {
  /** The catalog key, for failure messages only. */
  readonly key: string;
  /** The exact post-migration call text expected in the comment-stripped + whitespace-squashed
   *  source, as the sole argument of reportError(. */
  readonly call: string;
  /** The exact pre-migration raw literal (quotes/backticks included), transcribed byte-for-byte
   *  from main.ts today, that must be ABSENT after migration. */
  readonly rawLiteral: string;
}

// Transcribed directly from main.ts:582, :651, :961, :1040, :2442, :2524 (verified by reading,
// 2026-09-20 — main.ts:961 is the bare `${where}: disconnected — try again` template, NOT
// `${p.where}`; the 8 other `showFeedback('disconnected — try again')` sites elsewhere in
// main.ts are OUT of this slice's scope and keep the bare phrase, which is why the raw needle
// here is the FULL template including the `${where}: ` prefix, never the bare phrase alone).
const CHROME_STATUS_PINS: readonly ChromeStatusPin[] = [
  {
    key: 'chrome.status.exportBlocked',
    call: "i18nT('chrome.status.exportBlocked')",
    rawLiteral: "'data export: download blocked by the browser'",
  },
  {
    key: 'chrome.status.privacyOverlayBusy',
    call: "i18nT('chrome.status.privacyOverlayBusy')",
    rawLiteral: "'privacy: close the other overlay first'",
  },
  {
    key: 'chrome.status.disconnected',
    call: "tf('chrome.status.disconnected', { where })",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the pin IS main.ts's template source
    rawLiteral: '`${where}: disconnected — try again`',
  },
  {
    key: 'chrome.status.contentStale',
    call: "i18nT('chrome.status.contentStale')",
    rawLiteral: "'content out of date — reload'",
  },
  {
    key: 'chrome.status.bugBundleBlocked',
    call: "i18nT('chrome.status.bugBundleBlocked')",
    rawLiteral: "'bug bundle: download blocked — copy from console'",
  },
  {
    key: 'chrome.status.healUnavailable',
    call: "i18nT('chrome.status.healUnavailable')",
    rawLiteral: "'heal: no heal location available'",
  },
];
