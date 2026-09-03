// @vitest-environment happy-dom
/**
 * main.reducedMotionWiring.test.ts — RUNTIME gate over main.ts's render-loop wiring of the
 * OS reduced-motion preference into `RenderResolver.resolve` (slice 17r-a; A11Y-27/A11Y-28;
 * gate B1).
 *
 * SOURCE OF TRUTH — EARS criterion (gate B1): WHEN the OS reports reduced motion THE render
 * loop SHALL pass `reduceMotion: true` into `RenderResolver.resolve` on every frame; WHEN
 * `reduceMotion` is true THE own entity SHALL render at the predicted tile without slide
 * animation AND remote entities without interpolation.
 *
 * SCOPE: the RESOLVER half of B1 (the own-entity snap / remote no-interp behaviour once
 * `reduceMotion` is true) is already unit-covered by `render/renderResolver.test.ts` — this
 * file does NOT re-test it. This file pins ONLY the WIRING: that main.ts's render loop (a)
 * reads the live OS preference via `render/motionPreference.ts`'s injected seam, (b) passes
 * it into EVERY `resolver.resolve(...)` call, on EVERY frame, and (c) does so via exactly ONE
 * long-lived subscription rather than a per-frame reconstruction (which would leak a
 * MediaQueryList `change` listener roughly every 16ms while still reading correctly).
 *
 * THE DEFECT: `motionPreferenceFromWindow()` (render/motionPreference.ts:71) has ZERO
 * production callers today. The one call to `resolver.resolve({...})` in non-test
 * client/src (main.ts, inside the frame loop) never includes a `reduceMotion` key, so
 * `ResolveInput.reduceMotion` (renderResolver.ts:63, defaulted `= false` at :83 ONLY inside
 * `RenderResolver.resolve`'s own destructuring) is never even read from a live OS signal —
 * both reduced-motion render paths are dead code in production regardless of the OS setting.
 *
 * WHY A RUNTIME IMPORT HERE — main.wiring.test.ts:20-22 says "source-scan (NOT import): main.ts
 * has DOM/wasm side effects — importing it in vitest would crash on missing DOM/wasm globals."
 * This slice's defect is which VALUES flow into a call argument on every animation frame, which
 * no text scan can observe (a source-scan can prove `reduceMotion:` appears in the object
 * literal, but not that the value tracks a live listener rather than a per-frame reconstruction,
 * or that the initial read happens before the first frame). This file is the SANCTIONED, SCOPED
 * exception — modelled on `main.battle-reseed.test.ts` (16r-f) and `main.a11yFocus.test.ts`
 * (m23-s5), both of which import `./main` for the same reason. LIGHTEST-HARNESS CHOICE: unlike
 * `main.a11yFocus.test.ts`, this file omits `#app` (the `main.battle-reseed.test.ts` shape).
 * Verified by reading main.ts directly (not assumed): `status`, `interact-prompt`, and the
 * F9 error overlay are all created via `document.createElement` + `document.body.appendChild`
 * INSIDE `main()`, unconditionally, OUTSIDE the `if (mount !== null)` block that guards the
 * sixteen constructed views (main.ts:2246-2596 is the `#app`-gated block; the frame loop and
 * `conn = connect(...)` sit after it, at main.ts:2648-2898, gated on nothing). `ui/liveRegion.ts`'s
 * `announce`/`flush` are documented (and read) to no-op silently when `#a11y-live` is absent —
 * "S1 must be inert-but-correct without it" (liveRegion.ts:46-49). So the frame loop's
 * `resolver.resolve(...)` call is reachable, and every statement around it is safe, with NO DOM
 * shell at all — driving real frames without ever parsing index.html.
 *
 * WHY SEQUENTIAL (see the note above the suite for the spelling): MEASURED (see 17r-a task brief) — `npx vitest run
 * --sequence.concurrent src/main.a11yFocus.test.ts` fails 4/26 because happy-dom's
 * `document`/`window` is per-FILE and this harness keeps module-scope rAF + hoisted state that
 * a concurrent sibling test in the SAME file would stomp on.
 *
 * WHY the resolver is observed via a `vi.mock('./render/renderResolver', ...)` subclass, never
 * `vi.spyOn(RenderResolver.prototype, 'resolve')` on a statically-imported class: after
 * `vi.resetModules()` the statically-imported `RenderResolver` is a STALE module-registry
 * generation — main.ts's `new RenderResolver(...)` resolves the FRESH generation, so a spy on
 * the stale class's prototype records nothing. That is a silent false green, not a crash, which
 * is exactly why the mandated shape here is a real subclass built from `importOriginal()`,
 * assembled fresh inside the mock factory (which itself re-runs per fresh module generation).
 *
 * RED REASON: RM17A-ON, RM17A-OFF, RM17A-LIVE, and RM17A-SINGLEQ are ALL red at the fork.
 * RM17A-ON and RM17A-OFF are red for the IDENTICAL underlying reason — main.ts's call site
 * carries no `reduceMotion` key at all today, so every recorded `input.reduceMotion` is
 * `undefined`, and `undefined !== false` under this file's mandated STRICT equality (never
 * `toBeFalsy()` — see RM17A-OFF's own comment). Neither is a regression pin: both are genuine
 * red gates on the missing wiring. RM17A-LIVE is red for the same missing-key reason on its
 * frame-2 assertion. RM17A-SINGLEQ is red because `motionPreferenceFromWindow` is never called
 * at all yet — `mm.queries` stays empty, so its `toBe(1)` assertion fails against zero, not one.
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`.
 *
 * NO `new RegExp(...)`, no `eval`, no `new Function` (Semgrep bans them — none used here).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import { type MotionQuery, REDUCED_MOTION_QUERY } from './render/motionPreference';
import type { ResolveInput } from './render/renderResolver';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  /** 64-char hex — the shape connection.ts hands main.ts's onReady. */
  identity: 'ab'.repeat(32),
  /** The ConnectionOptions main() passed to connect(): our handle on the real store. */
  connectOpts: null as ConnectionOptions | null,
  /** THE observation channel for this file: every `input` object main.ts's frame loop
   *  actually handed to `resolver.resolve(...)`, in call order, across the whole test. */
  resolveInputs: [] as ResolveInput[],
}));

// The wasm pkg — identical shape to the sanctioned precedents (every name main.ts imports,
// plus the four other exports of the real module). zone_map() is called at MODULE scope
// (main.ts:214, `let rawMap = zone_map(ZONE_ID)`) — it must return a valid RawTileMap even
// though this file never mounts #app.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    // rb-8 / ADR-0212: `-> i64` crosses as a BigInt, so the stub is `1n`, not `1`.
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

// The connection: capture the options object, hand back a Connection-shaped stub.
// sessionState() MUST be 'hidden' or the frame loop's `sessionGateBlocks()` early-returns
// before ever reaching `resolver.resolve(...)`.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => undefined,
    identity: () => H.identity,
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

// The renderer: constructed UNCONDITIONALLY at main.ts:2246, before the #app guard. Pixi
// under happy-dom is out of scope for this gate, so it is stubbed rather than trusted. No
// canvas is appended (unlike main.a11yFocus.test.ts's WorldRenderer mock) — this file never
// drives focus, and #app itself never exists here.
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

// THE OBSERVATION CHANNEL FOR THIS FILE (mandatory design decision #2). A subclass of the
// REAL RenderResolver, built from importOriginal() so RecordingRenderResolver is assembled
// FRESH inside each fresh module-registry generation vi.resetModules() creates — a
// vi.spyOn(RenderResolver.prototype, 'resolve') on a statically-imported class would instead
// spy on a STALE generation's prototype and silently record nothing once main.ts resolves the
// fresh one. resolve() records the RAW input object (before RenderResolver's own internal
// `reduceMotion = false` destructuring default applies) and then genuinely delegates to
// super.resolve(input), so the real resolver logic still runs (this file never has to fake it).
vi.mock('./render/renderResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./render/renderResolver')>();
  class RecordingRenderResolver extends actual.RenderResolver {
    override resolve(input: ResolveInput) {
      H.resolveInputs.push(input);
      return super.resolve(input);
    }
  }
  return { ...actual, RenderResolver: RecordingRenderResolver };
});

// --- listener-cleanup harness (verbatim from the sanctioned precedents) ----------------
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
 *  detach each pair from the SAME target. Restores the original own-descriptor, if any.
 *  Without this, main.ts's MODULE-scope window/document listeners (keydown, click, error,
 *  unhandledrejection) STACK across vi.resetModules() re-imports: a later test's assertions
 *  would silently observe a mix of a stale module instance's handlers and the fresh one's. */
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

// --- the controllable rAF queue (verbatim from main.a11yFocus.test.ts) -----------------
let rafCallback: FrameRequestCallback | null = null;

function stubControllableRaf(): void {
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
}

/** Run ONE frame at a stubbed `performance.now() === atMs`. Throws loud (never a silent
 *  no-op) if no callback is armed, or if the frame did not re-arm itself — main.ts's frame
 *  re-arms unconditionally in a `finally`, so a missing re-arm means the frame body threw in
 *  a way this harness cannot account for, and a silent no-op here would make every
 *  RM17A-* assertion below pass vacuously on a frame that never actually ran. */
function runFrame(atMs: number): void {
  const cb = rafCallback;
  if (cb === null) {
    throw new Error('runFrame: no requestAnimationFrame callback is armed — has main() booted?');
  }
  rafCallback = null;
  const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(atMs);
  try {
    cb(atMs);
  } finally {
    nowSpy.mockRestore();
  }
  expect(
    rafCallback,
    'the frame did not re-arm requestAnimationFrame(frame) in its `finally` — runFrame cannot ' +
      'be called again and every subsequent RM17A-* assertion would silently measure nothing',
  ).not.toBeNull();
}

// --- the OS reduced-motion preference stub ----------------------------------------------
interface MatchMediaStub {
  /** Installed as `window.matchMedia`. */
  readonly fn: (query: string) => MotionQuery;
  /** Every query string ever passed to `fn`, in call order — NEVER filtered here; callers
   *  filter by the imported REDUCED_MOTION_QUERY constant, never a literal string. */
  readonly queries: string[];
  /** Every 'change' listener ever registered on `mql`, in registration order. A per-frame
   *  reconstruction of motionPreferenceFromWindow() would register a NEW one on every frame
   *  — this array is RM17A-SINGLEQ's whole reason to exist. */
  readonly listeners: Array<(e: { readonly matches: boolean }) => void>;
  /** The single fake MediaQueryList `fn` always returns. Mutate `.matches` and then invoke
   *  every entry in `listeners` to simulate a live OS preference change. */
  readonly mql: { matches: boolean } & MotionQuery;
}

function makeMatchMediaStub(initialMatches: boolean): MatchMediaStub {
  const queries: string[] = [];
  const listeners: Array<(e: { readonly matches: boolean }) => void> = [];
  const mql: { matches: boolean } & MotionQuery = {
    matches: initialMatches,
    addEventListener: (type, listener): void => {
      if (type === 'change') listeners.push(listener);
    },
  };
  const fn = (query: string): MotionQuery => {
    queries.push(query);
    return mql;
  };
  return { fn, queries, listeners, mql };
}

// --- the suite ---------------------------------------------------------------------------
// `describe(name, { sequential: true }, fn)` — NOT `describe.sequential(...)`. Same isolation,
// but the literal `describe(` is REQUIRED here: motionPreference.test.ts's S7T-SCAN scans every
// comment-stripped `.test.ts` under client/src for that exact token, as a tripwire against
// production code disguised with a spec suffix, and the dotted form does not contain it. The
// precedent file that uses the dotted form only passes because it happens to carry a nested
// plain `describe(` for unrelated reasons. Do not 'tidy' this back to the dotted form.
describe('main.ts render-loop reduced-motion wiring (17r-a, gate B1)', { sequential: true }, () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;

  /** Install the matchMedia stub, verify it is really what window.matchMedia resolves to
   *  (mandatory design decision #3 — happy-dom ships a REAL matchMedia that unconditionally
   *  reports matches:false, which would make a naive OFF-state assertion pass for the wrong
   *  reason if the stub were silently bypassed), reset its recorders, then import ./main and
   *  wait for connect() to be reached. Called ONCE per test, at the top of the test body —
   *  never inside a shared beforeEach, because each tooth below needs a DIFFERENT initial
   *  matches value. */
  async function setupMain(
    initialMatches: boolean,
  ): Promise<{ readonly opts: ConnectionOptions; readonly mm: MatchMediaStub }> {
    H.connectOpts = null;
    H.resolveInputs = [];

    const mm = makeMatchMediaStub(initialMatches);
    vi.stubGlobal('matchMedia', mm.fn);
    expect(
      window.matchMedia,
      'precondition: window.matchMedia must be the installed test stub, never the real ' +
        'happy-dom implementation (which unconditionally reports matches:false)',
    ).toBe(mm.fn);
    const probe = window.matchMedia(REDUCED_MOTION_QUERY);
    expect(
      probe.matches,
      `precondition: the stub must report matches:${initialMatches} for the reduced-motion query`,
    ).toBe(initialMatches);
    // The precondition probe above is a TEST call, not a production one — reset the
    // recorders so RM17A-SINGLEQ counts ONLY main.ts's own matchMedia usage.
    mm.queries.length = 0;
    mm.listeners.length = 0;

    recorded = [];
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);
    stubControllableRaf();

    vi.resetModules();
    await import('./main');
    // main() awaits 17 dynamic view imports before connect() — poll, never a fixed delay.
    const opts = await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
    opts.onReady(H.identity);
    return { opts, mm };
  }

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    H.connectOpts = null;
    H.resolveInputs = [];
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.innerHTML = '';
  });

  // WRONG IMPL KILLED:
  //  (1) ★ THE DEFECT (master today): `reduceMotion` key absent from the resolve() call
  //      entirely — every recorded `input.reduceMotion` is `undefined`, failing the
  //      `toBe(true)` assertions below.
  //  (2) computed-but-not-passed: `const motionPreference = motionPreferenceFromWindow();`
  //      exists at module scope but the value is never threaded into the resolve() call —
  //      same failure mode as (1).
  //  (3) hardcoded `reduceMotion: false` regardless of the OS signal — fails every frame here.
  //  (4) over-conjoined, e.g. `reduceMotion: motionPreference.reduceMotion && snapped` — with
  //      a fresh Predictor and no in-flight moves, `snapped` reads false on these idle frames,
  //      so an `&&`-mutant reports `false` here even though the OS preference is `true`.
  it('RM17A-ON: OS reports reduced motion — every resolver.resolve call carries reduceMotion: true, on every frame', async () => {
    await setupMain(true);
    runFrame(0);
    runFrame(100);
    runFrame(200);

    const inputs = H.resolveInputs;
    // Anti-vacuity: proves each runFrame() call genuinely reached the resolve() call site —
    // not merely that main() booted, and not that one frame's resolve() call got recorded
    // three times by a harness bug.
    expect(
      inputs.length,
      'exactly one new resolver.resolve() call per runFrame() — if this is not 3, either the ' +
        'frame loop never reaches resolver.resolve() (0), or it is being recorded more than ' +
        'once per frame (a mock/harness fault, not a wiring one)',
    ).toBe(3);
    for (const [i, input] of inputs.entries()) {
      expect(
        input.reduceMotion,
        `frame ${i}: reduceMotion must be true while the OS reports reduced motion`,
      ).toBe(true);
      // Shape anti-vacuity: proves this is a REAL ResolveInput built by main.ts's frame loop,
      // not an empty/stub object a hollowed-out mock could satisfy.
      expect(typeof input.now, `frame ${i}: input.now must be a number`).toBe('number');
      expect(
        Object.hasOwn(input, 'snapped'),
        `frame ${i}: 'snapped' must be a key of the recorded input`,
      ).toBe(true);
    }
  });

  // WRONG IMPL KILLED: unconditional `reduceMotion: true` — every frame here would read true
  // even though the OS reports NO reduced-motion preference.
  //
  // STRICT toBe(false), never toBeFalsy(): at the fork the `reduceMotion` key is absent from
  // the call entirely, so `input.reduceMotion` is `undefined` — `undefined` is falsy, so a
  // toBeFalsy() assertion would pass at the fork for the WRONG reason (the wiring not existing
  // at all looks identical to "correctly wired and reporting false"). This is genuinely RED at
  // the fork today (not a regression pin): `undefined !== false` under strict equality.
  it('RM17A-OFF: OS does NOT report reduced motion — every resolve call carries reduceMotion strictly === false', async () => {
    await setupMain(false);
    runFrame(0);
    runFrame(100);
    runFrame(200);

    const inputs = H.resolveInputs;
    expect(inputs.length, 'exactly one new resolver.resolve() call per runFrame()').toBe(3);
    for (const [i, input] of inputs.entries()) {
      expect(
        input.reduceMotion === false,
        `frame ${i}: reduceMotion must be STRICTLY false — got ${String(input.reduceMotion)}. ` +
          'undefined (the key never passed at all) must NOT satisfy this tooth: a missing key ' +
          'is not the same claim as "wired, and correctly reporting false".',
      ).toBe(true);
    }
  });

  // WRONG IMPL KILLED: ★ read-once-at-boot into a plain boolean, e.g.
  //   const reduceMotion = motionPreferenceFromWindow().reduceMotion; // captured ONCE
  //   … resolver.resolve({ …, reduceMotion });
  // This compiles, passes RM17A-ON and RM17A-OFF (each of which only ever changes the OS
  // signal BEFORE import), and even passes RM17A-SINGLEQ (matchMedia is still called exactly
  // once). It fails ONLY here: frame 2's value would stay `false`, frozen at the value read at
  // import time, because a plain boolean is never updated by the 'change' listener the way the
  // `MotionPreference` object's live getter is.
  it('RM17A-LIVE: a live OS preference change is read on the very next frame, with no re-import in between', async () => {
    const { mm } = await setupMain(false);
    runFrame(0);
    runFrame(100);

    // Simulate a live OS change: flip the fake MediaQueryList's matches AND fire every
    // registered 'change' listener — createMotionPreference's `current` closure variable is
    // updated EXCLUSIVELY by that listener (its getter never re-reads mql.matches directly),
    // so both steps are required to move the live value.
    expect(
      mm.listeners.length,
      'precondition: at least one change listener must already be registered by this point, ' +
        'or this test cannot drive a live update at all (see RM17A-SINGLEQ for the exact count)',
    ).toBeGreaterThan(0);
    mm.mql.matches = true;
    for (const listener of mm.listeners) listener({ matches: true });

    runFrame(200);

    const inputs = H.resolveInputs;
    expect(inputs.length, 'exactly one new resolver.resolve() call per runFrame() — 3 total').toBe(
      3,
    );
    expect(
      inputs[0]?.reduceMotion,
      'frame 0 (before the change event): reduceMotion must reflect the boot-time matches:false',
    ).toBe(false);
    expect(
      inputs[1]?.reduceMotion,
      'frame 1 (still before the change event): reduceMotion must still be false',
    ).toBe(false);
    expect(
      inputs[2]?.reduceMotion,
      'frame 2 (after the change event fired): reduceMotion must now be true — this is the ONE ' +
        'assertion in this file a read-once-at-boot implementation cannot pass',
    ).toBe(true);
  });

  // WRONG IMPL KILLED: ★ constructing `motionPreferenceFromWindow()` PER FRAME instead of once
  // at module scope, e.g. calling it from inside the `frame` closure body. This green-passes
  // RM17A-ON, RM17A-OFF, AND RM17A-LIVE (each frame's freshly-constructed MotionPreference
  // still mirrors the CURRENT mql.matches correctly), and is invisible to every one of those
  // three teeth — they only ever inspect the CURRENT reduceMotion value, never how many times
  // the query/subscription machinery itself was invoked. It leaks a MediaQueryList 'change'
  // listener on every animation frame (roughly every 16ms) in production. This is this tooth's
  // entire reason to exist.
  it('RM17A-SINGLEQ: motionPreferenceFromWindow is constructed exactly once — one query, one change listener, across 3 frames', async () => {
    const { mm } = await setupMain(true);
    runFrame(0);
    runFrame(100);
    runFrame(200);

    const matchingQueries = mm.queries.filter((q) => q === REDUCED_MOTION_QUERY);
    const total = mm.queries.length;
    const matched = matchingQueries.length;
    expect(
      matchingQueries.length,
      `exactly one matchMedia(REDUCED_MOTION_QUERY) call across import + 3 frames — observed ` +
        `${total} total matchMedia call(s), ${matched} matching. Zero means ` +
        'motionPreferenceFromWindow is never called at all; more than one means it is being ' +
        'reconstructed (e.g. once per frame).',
    ).toBe(1);
    expect(
      mm.listeners.length,
      'exactly one MediaQueryList change listener must be registered — more than one means a ' +
        'fresh MotionPreference (and its listener) is being leaked repeatedly rather than ' +
        'built once and read live thereafter',
    ).toBe(1);
  });
});
