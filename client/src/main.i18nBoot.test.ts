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
 * `import { CATALOGS, t as i18nT, setLocale, tf } from './ui/i18n/resolver';` (biome sorts
 * import specifiers by their LOCAL binding name — i18nT sorts before setLocale), plus six
 * `reportError(...)` literal-to-`i18nT`/`tf` migrations.
 *
 * WHY A RUNTIME IMPORT FOR BOOT-01..04/07 — main.wiring.test.ts's own rule is "source-scan
 * (NOT import): main.ts has DOM/wasm side effects — importing it in vitest would crash on
 * missing DOM/wasm globals." This defect is about which VALUES the negotiation reads
 * (`navigator.languages`, `window.location.search`) and where they land (a DOM attribute write,
 * a resolver-cell mutation), which no text scan can observe — only a real module evaluation can.
 * Modelled on `main.reducedMotionWiring.test.ts` (17r-a): SAME wasm-pkg / ./net/connection /
 * ./observability/telemetry / ./render/world mocks, SAME recordListeners + afterEach cleanup,
 * SAME `vi.resetModules()` + `await import('./main')` + `vi.waitFor` on the connect() capture.
 * The `./render/renderResolver` mock is dropped, and the rAF stub here is INERT (`stubInertRaf`
 * — no captured callback, unlike the precedent's controllable one) because this file never
 * drives a frame; it only observes module-scope boot-time side effects.
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
 * write). (The BOOT-05/06 source scans were deleted in the de-bloat; ledger
 * CT-src-main.i18nBoot#source-pins.)
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`/assertion.
 *
 * NO `new RegExp(...)`, no regex literal, no `eval`, no `new Function` (ADR-0055 / Semgrep ban)
 * — every source-scan needle below is matched with `String.indexOf` loops only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import { CATALOG_EN } from './ui/i18n/catalog.en';
import type { Catalog } from './ui/i18n/messageIds';

// --- hoisted state shared with the mock factories --------------------------------------
//
// MEASURED (red-team, 2026-09-20): a vi.mock(...) factory runs ONCE PER FILE, not once per
// vi.resetModules() generation. This file's first draft assumed the resolver mock factory
// re-ran fresh on every import('./main') the way main.reducedMotionWiring.test.ts's
// RecordingRenderResolver subclass does — it does not; only a module that is genuinely
// UNMOCKED (main.ts itself) gets a fresh instance from vi.resetModules(). A frozen CATALOGS
// object captured on the FIRST test's factory invocation stayed frozen at whatever that first
// test registered, for every later test in the file (BOOT-01 ran first with no extra locales
// => CATALOGS = {en} forever => BOOT-02/03/04/07 each measured setLocaleCalls ['en']). THE
// FIX: the mock's registry is a single MUTABLE object, created once, that setupMain() edits IN
// PLACE (deletes every key, re-adds 'en' plus whatever this test needs) before every
// import('./main') — never reassigned. The mock's setLocale/currentLocale close over H itself
// (never a local snapshot), so they always see the CURRENT contents no matter which
// "generation" of main.ts is asking.
const H = vi.hoisted(() => ({
  /** The MUTABLE locale registry the mocked './ui/i18n/resolver' module serves CATALOGS from
   *  — the SAME object reference for this file's whole lifetime; setupMain() deletes/re-adds
   *  its own keys per test, never reassigns this binding. */
  catalogs: {} as Record<string, Catalog>,
  /** The mocked resolver's locale cell — lives in H for the identical per-file-factory reason;
   *  reset to 'en' by setupMain() before every test. */
  current: 'en',
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
    max_trade_monsters_per_side: () => 64,
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

// THE OBSERVATION CHANNEL FOR setLocale/CATALOGS/currentLocale — see the H doc-comment above
// for the MEASURED "factory runs once per file" fact this shape is built around. `CATALOGS`
// below is bound to `H.catalogs` ITSELF (never a copy, never frozen): setupMain() mutates
// H.catalogs's keys in place before every import('./main'), so a FRESH main.ts generation
// reading `Object.keys(CATALOGS)` at its own module-eval time always sees the CURRENT per-test
// registry, even though this factory function body only ever runs once for the whole file.
// `setLocale`/`currentLocale` close over H directly (never a local `current`) for the same
// reason. Keeps the REAL `t`/`tf` untouched (this file never exercises them at runtime).
vi.mock('./ui/i18n/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/i18n/resolver')>();
  // Throws on an unregistered locale EXACTLY like the real setLocale — see the "NO try/catch"
  // header note for why that must stay true. Checked against H.catalogs AT CALL TIME, never a
  // snapshot, so a locale setupMain() registers is always honoured regardless of when this
  // factory body itself ran.
  const setLocale = (locale: string): void => {
    if (!Object.hasOwn(H.catalogs, locale)) {
      throw new Error(
        `i18n: locale '${locale}' is not registered — CATALOGS has [${Object.keys(H.catalogs).join(', ')}]`,
      );
    }
    H.setLocaleCalls.push(locale);
    H.current = locale;
  };
  const currentLocale = (): string => H.current;
  return { ...actual, CATALOGS: H.catalogs, setLocale, currentLocale };
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
// `describe(name, { sequential: true }, fn)`.
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

    // Reset the MUTABLE resolver registry IN PLACE — never reassign H.catalogs itself (see the
    // H doc-comment: the mock factory bound CATALOGS to this exact object once, for the file's
    // whole lifetime, so only in-place mutation is visible to a freshly re-imported main.ts).
    for (const key of Object.keys(H.catalogs)) delete H.catalogs[key];
    H.catalogs.en = CATALOG_EN;
    for (const tag of extraLocales) H.catalogs[tag] = CATALOG_EN;
    H.current = 'en';
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
    // Precondition: guards against the SAME per-file-factory staleness class B1 measured — if a
    // future edit reassigns `CATALOGS` inside the mock factory (instead of mutating
    // H.catalogs's keys), the in-place reset above would silently stop reaching the module
    // main.ts actually imports, and every BOOT-0[2-4]/07 assertion would fail exactly the way
    // B1 did (measured: 3/7 passing, each test green in isolation).
    const resolverModule = await import('./ui/i18n/resolver');
    expect(
      resolverModule.CATALOGS,
      "precondition: './ui/i18n/resolver''s mocked CATALOGS must be the EXACT SAME object as " +
        'H.catalogs — a copy or a re-frozen snapshot would not observe the in-place reset above',
    ).toBe(H.catalogs);

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
    for (const key of Object.keys(H.catalogs)) delete H.catalogs[key];
    H.current = 'en';
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
