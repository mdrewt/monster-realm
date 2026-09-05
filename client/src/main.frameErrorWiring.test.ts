// @vitest-environment happy-dom
/**
 * main.frameErrorWiring.test.ts — RUNTIME gate over main.ts's rAF frame-loop `catch`.
 *
 * ★ SOURCE OF TRUTH — the ONE seeded acceptance criterion of slice 17r-f, verbatim:
 *   B1: "WHEN the frame loop throws THE error SHALL appear in the error overlay/ring and the
 *        F9 bundle AND the loop SHALL re-arm on the next frame."
 *
 * RED REASON AT AUTHORING TIME (the defect this file is written from): main.ts's frame catch is
 *   `} catch (err) { console.error('[frame] uncaught error', err); }`
 * — a console-only record. Nothing reaches `errorRing`, so the F9 bug bundle a playtester sends
 * back after "the game froze" contains ZERO evidence of the throw that froze it, and the error
 * overlay stays blank while the loop spins. Every `it` below reds on the SAME observable: the
 * `'uncaught'` message list is `[]` where the criterion requires exactly one tagged message.
 *
 * WHY A RUNTIME IMPORT — `main.wiring.test.ts:20-22` prescribes source-scan, "NOT import", for
 * main.ts. This file is the SANCTIONED, SCOPED exception, modelled on the four precedents that
 * import `./main` for the same reason (`main.battle-reseed.test.ts`, `main.a11yFocus.test.ts`,
 * `main.reducedMotionWiring.test.ts`, `main.privacyCountdown.test.ts`): the subject is WHICH
 * VALUES flow out of a call on an animation frame. A text scan can prove `pushError(` appears in
 * the catch; it cannot prove the record reaches the ring, carries the right `source`, survives
 * into the F9 bundle, or that the loop is still ALIVE afterwards rather than merely re-armed.
 * The SHAPE half of B1 is the sibling tier, `main.wiring.test.ts`'s
 * `★ main.ts wiring (17r-f/B1)` block (an exact-equality pin on the catch tail).
 *
 * ★ THE DESIGN UNDER TEST, stated so a future reader does not "simplify" the dedupe away.
 * The catch records `frame: <normalizeError(...).message>` and collapses only CONSECUTIVE
 * IDENTICAL messages against a module-scope `lastFrameErrorMessage`. Both halves are load-bearing
 * and both are gated here:
 *   - the `frame: ` TAG, because `main.ts`'s window `error` listener also pushes `'uncaught'`, so
 *     without it an operator cannot tell "the render loop is dead and the game is frozen" from
 *     "a click handler threw once" (the `reduceErrorMessage` `${where}: ${message}` idiom);
 *   - the DEDUPE, because a frame that throws every tick is an unthrottled 60 Hz producer into
 *     the 64-slot ring whose remaining 48 slots ADR-0172 D1 explicitly reserves "for the crash
 *     records the bundle exists to carry". Measured by the 17r-f red-team on a sandbox build of
 *     the undeduped design: the ring is 100% one repeated message after 1.07 s, and a genuine
 *     pre-crash record is ABSENT from the bundle afterwards — i.e. the undeduped fix makes the
 *     F9 bundle STRICTLY WORSE than today's console-only behaviour whenever the frame throw is a
 *     SYMPTOM rather than the root cause.
 * The dedupe drops NO DISTINCT error. B1b below is the arm that gates BOTH directions of that
 * sentence at once, and it is the highest-value test in this file.
 *
 * ★ HARNESS DECISIONS THAT ARE NOT STYLE (each one is a measured false-green channel).
 *  1. `sessionState()` DEFAULTS to `'hidden'`. Any other value makes the frame take its early
 *     return at the statement `if (sessionGateBlocks()) {`, above every seam this file throws
 *     from, and every arm would pass for the wrong reason. Driven from `H.sessionState` (read
 *     LIVE on each call) rather than hard-coded, and restored by `afterEach`, so arm order can
 *     never matter.
 *  2. NO `#app` mount. `renderer = new WorldRenderer()` is executed one line ABOVE
 *     `const mount = document.getElementById('app')`, and `ErrorOverlayView` self-mounts to
 *     `document.body` OUTSIDE the `if (mount !== null)` block — so both the throw seam and the
 *     overlay are reachable with no DOM shell at all. The clean-frame baseline in B1a is what
 *     proves that claim at RUN time instead of trusting this comment.
 *  3. STALE MODULE-SCOPE LISTENERS ARE THE REAL FALSE-GREEN CHANNEL. A direct `cb()` throw
 *     dispatches ZERO window `error` events under happy-dom (measured), so the window-listener
 *     channel this file was first worried about does not exist. What DOES fire is main.ts's
 *     module-scope `keydown`/`error`/`unhandledrejection` handlers STACKING across
 *     `vi.resetModules()`: a stale boot's keydown listener answers F9 first and assembles a
 *     bundle from the PREVIOUS module generation's ring. `recordListeners` +
 *     `removeEventListener` in `afterEach` (plus `document.body.innerHTML = ''`) is therefore
 *     LOAD-BEARING, not hygiene, and `H.bundles.length` is pinned at EXACTLY 1 — never `>= 1` —
 *     because listeners fire in registration order, which makes `bundles[0]` the DANGEROUS index
 *     (it would belong to the OLDEST stale boot).
 *  4. NO `vi.useFakeTimers()` (repo anti-pattern): it can replace `requestAnimationFrame`, which
 *     this harness must own.
 *  5. Whole filtered arrays are compared with `toEqual`. NEVER `some()` / `includes()`: a
 *     membership check cannot see a duplicate, and B1b is entirely about duplicates.
 *  6. The overlay is asserted BEFORE F9 is pressed. `downloadBugBundle`'s catch calls
 *     `reportError` -> `pushError('reducer', …)`, which adds a SECOND overlay row; the captured
 *     `.errors` array is clean (it is snapshotted first) but the DOM is not.
 *
 * ★ THIS FILE IS NEVER TYPECHECKED. `client/tsconfig.json:15` excludes every test file, and
 * vitest strips types via esbuild. The `Connection` stub below was therefore HAND-DIFFED against
 * `client/src/net/connection.ts`'s `export interface Connection` (8 members: `conn`, `live`,
 * `identity`, `linkFrozen`, `continueAnonymously`, `sessionState`, `startSignIn`,
 * `reconnectNow`), and every element/record this file reads back is fetched through a NAMED
 * runtime assertion (`overlayRoot()`, `singleBundle()`) rather than an `as` cast that would
 * throw an unreadable TypeError at the point of use.
 *
 * ★ MUTANT REGISTER — the wrong implementations each arm kills, and WHICH assertion kills them.
 * DERIVED FROM THE SOURCE, NOT EXECUTED HERE: the tester role that authored this file may not
 * run the suite (that split is enforced mechanically), so these are stated as claims the
 * verifier can mechanically confirm, each naming its executing assertion. Report any survivor as
 * a finding.
 *   M1  no call at all (master today) ............... every arm: `[]` vs a 1-element list
 *   M2  once-latch `if (!framePushed) {…}` .......... B1b: `['frame: first-boom']`
 *   M3  `rateLimitTick`-throttled push .............. B1b: drops `second-boom` (or triples the
 *                                                     first) — the deep-equal sees both
 *   M4  `if (errorOverlayView?.visible === false)` ... B1b: only frame 1 records
 *   M5  `if (err instanceof Error) pushError(…)` .... B1c: a bare-string throw records nothing
 *   M6  `pushError('uncaught', err.message)` ........ B1a: no `frame: ` tag; B1c: `'undefined'`
 *   M7  UNDEDUPED `pushError('uncaught', msg)` ...... B1b ONLY: three entries, not two
 *   M8  wrong source `pushError('reducer', …)` ...... B1a: `dataset.source` + the bundle filter
 *   M9  the `finally` re-arm deleted / moved into
 *       the `try` .................................. `runFrame`'s re-arm assertion, on the
 *                                                     THROWING frame (B1a/B1b/B1c/B1d)
 *   M10 a string-literal decoy in the catch ......... sibling tier (exact-equality pin)
 *   M11 `console.error` REPLACED, not augmented ..... sibling tier (`expectUniqueAnchor`)
 *   M12 `lastFrameErrorMessage` declared INSIDE the
 *       `frame` closure (resets every frame, so the
 *       dedupe silently does nothing) .............. B1b ONLY — the sibling tier's region
 *                                                     STOPS at the catch and cannot see the
 *                                                     declaration's scope. Recorded here as the
 *                                                     one mutant this file exclusively owns.
 *
 * NO `new RegExp(...)`, no `eval`, no `new Function` (Semgrep bans them — none used here).
 * NO `innerHTML` for DOM CONSTRUCTION (ADR-0135): nothing is built here; the single
 * `document.body.innerHTML = ''` is the teardown form the sanctioned precedents use.
 */
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import type { AuthoritativeStore } from './net/store';
import type { BugBundle, BugBundleInput } from './ui/bugBundle';
import type { SessionState } from './ui/sessionModel';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  /** 64-char hex — the shape connection.ts hands main.ts's onReady. */
  identity: 'ab'.repeat(32),
  /** The ConnectionOptions main() passed to connect(): our handle on the REAL store. */
  connectOpts: null as ConnectionOptions | null,
  /** What the Connection stub's `sessionState()` answers, read LIVE on every call. 'hidden' is
   *  the ordinary case and the ONLY value under which the frame body runs past its gate. */
  sessionState: 'hidden' as SessionState,
  /** THE THROW SEAM. `null` = a clean frame; anything else is thrown by the mocked
   *  `WorldRenderer.render()`, which main.ts calls inside the frame's `try`. */
  throwOnRender: null as unknown,
  /** Incremented on EVERY `render()` call, BEFORE the optional throw — so it is both the
   *  anti-vacuity control ("the frame really reached the render path") and the live-loop probe
   *  ("a later frame really ran the body again", not merely "a callback is non-null"). */
  renderCalls: 0,
  /** Every `buildBugBundle` INPUT, in call order. Length is pinned at exactly 1 per press. */
  bundles: [] as BugBundleInput[],
  /** The observation channel; the factory installs a call-through implementation. */
  buildBugBundle: vi.fn<(input: BugBundleInput) => BugBundle>(),
}));

// The wasm pkg — every name main.ts imports, plus the other exports of the real module (the same
// object the sanctioned precedents mock). `-> i64` crosses as a BigInt (rb-8 / ADR-0212), so the
// grace accessor returns a bigint; 0n keeps the privacy block inert, which this slice wants.
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    deletion_grace_ms_default: () => 0n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    predict_move: () => ({}),
    predict_tick: () => ({}),
    set_active_zone: () => undefined,
    start: () => undefined,
    step_ms: () => 200,
    // A minimal but VALID RawTileMap (TileMap.fromRaw rejects a ragged grid).
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

// The connection: capture the options object (its `store` field is this file's second injection
// point, used by B1d), hand back a Connection-shaped stub. Members hand-diffed against
// `export interface Connection` in net/connection.ts — see the header's typecheck note.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => undefined,
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => H.sessionState,
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

// The bundle assembler: real exports, with buildBugBundle wrapped in a CALL-THROUGH spy that also
// records the input. Call-through (never a stub) so the bundle this file reads is the one a
// playtester would actually send.
vi.mock('./ui/bugBundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/bugBundle')>();
  H.buildBugBundle.mockImplementation((input: BugBundleInput): BugBundle => {
    H.bundles.push(input);
    return actual.buildBugBundle(input);
  });
  return { ...actual, buildBugBundle: H.buildBugBundle };
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

// THE THROW SEAM. `WorldRenderer` is constructed UNCONDITIONALLY, before the `#app` guard, and
// `renderer?.render(...)` is called from inside the frame's `try` — so this stub is a controllable
// fault injector at a position main.ts genuinely reaches. Pixi under happy-dom is out of scope.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(): Promise<void> {
      return Promise.resolve();
    }
    setMap(): void {
      // no-op stub
    }
    render(): void {
      // Counted BEFORE the throw on purpose: a throwing frame must still prove it REACHED the
      // render path, or "the error was recorded" could be a statement about a frame that
      // returned early somewhere above.
      H.renderCalls += 1;
      const boom = H.throwOnRender;
      if (boom !== null) throw boom;
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
 *  detach each pair from the SAME target. Without this, main.ts's module-scope
 *  window/document listeners — including the F9 `keydown` handler — STACK across
 *  `vi.resetModules()` re-imports, and a stale boot answers F9 first. */
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

// --- the controllable rAF queue ---------------------------------------------------------
let rafCallback: FrameRequestCallback | null = null;

function stubControllableRaf(): void {
  rafCallback = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallback = cb;
    return 0;
  });
}

/** Run ONE frame. The callback is deliberately NOT wrapped in a try/catch: main.ts's frame is
 *  contractually total (its own `try/catch/finally` swallows every fault), so a throw escaping
 *  here is a REAL regression and must surface with its own stack rather than be reinterpreted.
 *
 *  The trailing assertion is B1's re-arm clause at its strictest position — it runs on the
 *  THROWING frames too, which is exactly where a `finally` moved into the `try` stops re-arming.
 *  ANTI-VACUITY LIMIT, stated rather than implied: this proves only that the callback RAN and
 *  re-armed; `sessionGateBlocks()`'s early return re-arms too. The control that the frame reached
 *  the render path is `H.renderCalls`, and every arm below asserts on it. */
function runFrame(): void {
  const cb = rafCallback;
  if (cb === null) {
    throw new Error('runFrame: no requestAnimationFrame callback is armed — has main() booted?');
  }
  rafCallback = null;
  cb(performance.now());
  expect(
    rafCallback,
    'B1 (re-arm): the frame did not re-arm requestAnimationFrame(frame). The re-arm lives in the ' +
      'frame`s `finally` (12.5c-4 / ADR-0074) precisely so a throwing frame still schedules the ' +
      'next one — moving it into the `try`, or deleting it, freezes the game permanently on the ' +
      'first fault, which is the half of B1 that is about the LOOP rather than the record',
  ).not.toBeNull();
}

// --- named runtime readers (this file is never typechecked — see the header) ------------

/** The self-mounted `#mr-error-overlay` root. Fails by NAME if main.ts did not mount it, rather
 *  than throwing an unreadable TypeError on `null.style` at the point of use. */
function overlayRoot(): HTMLElement {
  const el = document.getElementById('mr-error-overlay');
  expect(
    el,
    'main.ts must mount the ErrorOverlayView (`#mr-error-overlay`) — it self-mounts to ' +
      'document.body OUTSIDE the `if (mount !== null)` block, so it exists on a boot with no ' +
      '#app. It is absent, so this harness is not observing the real overlay at all',
  ).not.toBeNull();
  return el as HTMLElement;
}

/** One rendered overlay row, reduced to the two facts B1 is about. */
interface OverlayRow {
  readonly source: string | undefined;
  readonly text: string;
}

/** Every rendered overlay row, in DOM order (the model renders NEWEST-FIRST). */
function overlayRows(): readonly OverlayRow[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mr-error-row')).map((el) => ({
    source: el.dataset.source,
    text: el.textContent ?? '',
  }));
}

/** Press F9 and return THE bundle main.ts assembled. `toBe(1)` — never `>= 1` — is the tripwire
 *  for a stale keydown listener from a previous module generation (see header note 3); with two
 *  live listeners, index 0 would be the OLDER boot's bundle and every assertion below would be
 *  measuring the wrong ring. */
function singleBundle(): BugBundleInput {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9' }));
  expect(
    H.bundles.length,
    'pressing F9 must assemble EXACTLY ONE bug bundle. Zero means main.ts`s keydown listener is ' +
      'not reachable from this harness (nothing below would be measuring the F9 path at all); ' +
      'two or more means a stale module generation`s listener is still attached and answered ' +
      'first, so the bundle read here would belong to a previous boot',
  ).toBe(1);
  const first = H.bundles[0];
  if (first === undefined) throw new Error('singleBundle: no bundle was captured');
  return first;
}

/** The `'uncaught'` messages in a bundle, oldest -> newest, as a WHOLE array. Deliberately not a
 *  membership helper: B1b is about duplicates, which `some()`/`includes()` cannot see. The
 *  `'reducer'` rows `downloadBugBundle`'s fallback can add are filtered out by source. */
function uncaughtMessages(bundle: BugBundleInput): readonly string[] {
  return bundle.errors.filter((r) => r.source === 'uncaught').map((r) => r.message);
}

// --- the suite ---------------------------------------------------------------------------
// `describe(name, { sequential: true }, fn)` — NOT `describe.sequential(...)`. Same isolation,
// but the literal `describe(` is REQUIRED: render/motionPreference.test.ts's S7T-SCAN scans every
// comment-stripped `.test.ts` under client/src for that exact token as a tripwire against
// production code disguised with a spec suffix, and the dotted form does not contain it.
// Sequential because happy-dom's document and this file's module-scope rAF slot are per-FILE.
describe('main.ts frame-loop error wiring (17r-f, B1)', { sequential: true }, () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;
  let ownAccountSpy: MockInstance | undefined;

  /** Boot main.ts and return the REAL store main() handed to connect(). */
  async function setupMain(): Promise<AuthoritativeStore> {
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;

    H.connectOpts = null;
    H.sessionState = 'hidden';
    H.throwOnRender = null;
    H.renderCalls = 0;
    H.bundles.length = 0;
    H.buildBugBundle.mockClear();
    // A fresh boot self-mounts its OWN #mr-error-overlay; clearing first is what keeps the
    // `getElementById` read unambiguous rather than cumulative.
    document.body.innerHTML = '';
    // `recorded` is NOT reset here: afterEach owns that, so a second boot inside one test still
    // detaches the FIRST boot's module-scope handlers.
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);
    stubControllableRaf();

    vi.resetModules();
    await import('./main');
    // main() awaits the dynamic view imports before connect() — poll, never a fixed delay.
    const opts = await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
    opts.onReady(H.identity);
    // The loop is armed behind main()'s `ready` promise — wait for the callback rather than
    // assuming the microtask queue has drained, so runFrame never throws for a timing reason.
    await vi.waitFor(
      () => {
        expect(rafCallback, 'main() must have armed requestAnimationFrame(frame)').not.toBeNull();
      },
      { timeout: 5_000, interval: 5 },
    );
    return opts.store;
  }

  /** The clean-frame ANTI-VACUITY baseline every arm starts from. Proves, at RUN time, three
   *  things every later assertion silently depends on: the frame really reaches the render seam
   *  with no `#app` mount, the overlay really exists and is hidden, and no error row is on screen
   *  before this file causes one. Without it, "a row appeared" could be a statement about a row
   *  that was always there, and "the error was recorded" could be about a seam never reached. */
  function expectCleanBaseline(): void {
    const before = H.renderCalls;
    runFrame();
    expect(
      H.renderCalls,
      'ANTI-VACUITY: a clean frame must reach `renderer?.render(...)` — the seam every arm in ' +
        'this file throws from. If it does not, the frame is returning early somewhere above ' +
        'and nothing below is testing the frame catch',
    ).toBe(before + 1);
    expect(
      overlayRoot().style.display,
      'ANTI-VACUITY: the error overlay must still be HIDDEN after a clean frame. It is shown ' +
        'only by `pushError`, so an overlay that is already visible here would make the ' +
        '"it became visible" assertion in every arm below true for free',
    ).toBe('none');
    expect(
      overlayRows(),
      'ANTI-VACUITY: no error row may exist before this test causes one, or a later row-count ' +
        'assertion would be measuring pre-existing state',
    ).toEqual([]);
  }

  afterEach(() => {
    ownAccountSpy?.mockRestore();
    ownAccountSpy = undefined;
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    H.connectOpts = null;
    H.sessionState = 'hidden';
    H.throwOnRender = null;
    H.renderCalls = 0;
    H.bundles.length = 0;
    H.buildBugBundle.mockClear();
    vi.unstubAllGlobals();
    rafCallback = null;
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------------------
  // B1a — the whole criterion end to end, on ONE throwing frame.
  // -------------------------------------------------------------------------------------

  it('★ B1a BITES: a throwing frame paints the error overlay, lands in the F9 bundle, and the loop keeps running', async () => {
    // WRONG IMPL KILLED (1) ★ THE DEFECT (master today): the catch is `console.error(...)` and
    //   nothing else. A playtester whose game froze presses F9 and sends back a bundle with an
    //   EMPTY error list — the one artifact that exists to explain the freeze is silent about
    //   it. Both the overlay clause and the bundle clause red on `[]`.
    // WRONG IMPL KILLED (2) ★ M8, the wrong taxonomy: `pushError('reducer', …)`. The record
    //   would exist, so a presence-only tooth would pass, while the overlay row is tagged as a
    //   server/UI failure and every consumer that filters `'uncaught'` — including this
    //   assertion — cannot see it. `dataset.source` and the bundle filter both pin it.
    // WRONG IMPL KILLED (3) ★ M6, the untagged message: `pushError('uncaught', err)` or
    //   `err.message`. main.ts's window `error` listener already pushes `'uncaught'`, so an
    //   untagged record leaves an operator unable to tell a DEAD RENDER LOOP from a click
    //   handler that threw once. The exact strings below require the `frame: ` prefix.
    // WRONG IMPL KILLED (4) ★ M9: the `finally` re-arm deleted or moved into the `try`. The
    //   record would be perfect and the game would be frozen forever — clause (iii) runs a
    //   SECOND, non-throwing frame and requires the render counter to move, so a merely
    //   non-null callback (a dead handle) is not enough.
    // WRONG IMPL KILLED (5): the record made but the overlay never shown (`pushError` bypassed
    //   in favour of a bare `errorRing.push`) — the overlay `display` clause reds while the
    //   bundle clause passes, and the two are asserted separately for exactly that reason.
    await setupMain();
    expectCleanBaseline();

    H.throwOnRender = new Error('frame-boom-sentinel');
    const beforeThrow = H.renderCalls;
    runFrame();
    expect(
      H.renderCalls,
      'the throwing frame must have REACHED the render seam (the counter increments before the ' +
        'throw) — otherwise the fault was injected somewhere this test cannot account for',
    ).toBe(beforeThrow + 1);

    // (i) THE OVERLAY — asserted BEFORE F9, because downloadBugBundle's fallback path adds a
    // second, `'reducer'`-tagged row to the DOM (its captured `.errors` array is clean, the DOM
    // is not).
    expect(
      overlayRoot().style.display,
      'B1 (overlay): the error overlay must be SHOWN after a frame throws — `pushError` calls ' +
        '`show()` on the first record, and `display: none` here means the throw never reached ' +
        'the ring at all',
    ).not.toBe('none');
    expect(
      overlayRows(),
      'B1 (overlay): the throwing frame must paint EXACTLY ONE `uncaught` row reading ' +
        '`[uncaught] frame: frame-boom-sentinel`. Today it paints none: main.ts`s frame catch ' +
        'only calls console.error, so nothing reaches errorRing/the overlay',
    ).toEqual([{ source: 'uncaught', text: '[uncaught] frame: frame-boom-sentinel' }]);

    // (ii) THE F9 BUNDLE — the artifact the criterion is actually about.
    expect(
      uncaughtMessages(singleBundle()),
      'B1 (F9 bundle): the bundle a playtester sends back must carry the frame error, tagged ' +
        '`frame: ` so it is distinguishable from the window `error` listener`s own `uncaught` ' +
        'records. RED today: the list is empty',
    ).toEqual(['frame: frame-boom-sentinel']);

    // (iii) THE LOOP IS ALIVE — not merely "a callback is non-null". A second, CLEAN frame must
    // run the body again and move the render counter.
    H.throwOnRender = null;
    const beforeRecovery = H.renderCalls;
    runFrame();
    expect(
      H.renderCalls,
      'B1 (re-arm): the frame after the throwing one must actually RUN the frame body — a ' +
        're-armed but dead handle satisfies a null-check and freezes the game just the same',
    ).toBe(beforeRecovery + 1);
  });

  // -------------------------------------------------------------------------------------
  // B1b — THE DEDUPE DISCRIMINATOR. The highest-value arm in this file.
  // -------------------------------------------------------------------------------------

  it('★★ B1b BITES: a frame that throws the SAME error twice records it ONCE, and a DIFFERENT error still records', async () => {
    // ★ THIS IS THE ONE ARM THAT GATES BOTH DIRECTIONS AT ONCE, and it is the reason the shipped
    // design is a consecutive-identical collapse rather than any policy with a knob.
    //
    // WRONG IMPL KILLED (1) ★ M7 — THE UNDEDUPED PUSH, which is the design this arm rejected:
    //   `pushError('uncaught', frameErrorMessage)` on every throwing frame. Observable here as
    //   `['frame: first-boom', 'frame: first-boom', 'frame: second-boom']`. In production it is
    //   an unthrottled 60 Hz producer into a 64-slot ring whose remaining 48 slots ADR-0172 D1
    //   RESERVES for crash records: measured, the ring is 100% one repeated message within
    //   1.07 s, and the genuine pre-crash record is gone from the bundle by the time any human
    //   presses F9. It also re-`show()`s the overlay every ~16 ms, which defeats F8 dismissal
    //   for exactly the failure mode F8 exists for.
    // WRONG IMPL KILLED (2) ★ M2 — the ONCE-LATCH (`if (!framePushed) { framePushed = true; … }`)
    //   and (3) ★ M3 — a `rateLimitTick`-style throttle, and (4) ★ M4 — a
    //   `if (errorOverlayView?.visible === false)` guard. All three are the obvious ways to stop
    //   the flood, all three read as "sensible back-pressure", and all three DROP THE SECOND,
    //   DIFFERENT, FATAL ERROR: they record `['frame: first-boom']` and the diagnosis the
    //   playtester actually needed never reaches the bundle. Frame 3 throws a DISTINCT message
    //   for precisely this reason.
    // WRONG IMPL KILLED (5) ★ M12 — `let lastFrameErrorMessage` declared INSIDE the `frame`
    //   closure instead of at module scope. It resets on every frame, so the comparison is
    //   always against `null` and the dedupe silently does nothing: identical to M7 above. The
    //   sibling source tier CANNOT see this — its region stops at the catch — so this assertion
    //   is the only thing in the repo standing there.
    //
    // Nothing but the thrown value changes across the three frames: same store, same session,
    // same seam. Any difference in the recorded list is attributable to the catch alone.
    await setupMain();
    expectCleanBaseline();

    H.throwOnRender = new Error('first-boom');
    runFrame();
    runFrame(); // the SAME message again — must cost nothing
    H.throwOnRender = new Error('second-boom');
    runFrame(); // a DIFFERENT message — must always record

    // The overlay is read FIRST, before F9: `downloadBugBundle`'s fallback path calls
    // `reportError` -> `pushError('reducer', …)`, which would add a THIRD row to the DOM (the
    // captured `.errors` array is snapshotted before that and stays clean).
    // It is the same ring rendered newest-first — a second, independent view of the same claim,
    // so a dedupe implemented on only one of the two paths cannot pass this arm.
    expect(
      overlayRows(),
      'the overlay renders the SAME ring newest-first, so it must show exactly the two distinct ' +
        'rows — this is the second, independent reading of the dedupe',
    ).toEqual([
      { source: 'uncaught', text: '[uncaught] frame: second-boom' },
      { source: 'uncaught', text: '[uncaught] frame: first-boom' },
    ]);

    expect(
      uncaughtMessages(singleBundle()),
      'B1 + ADR-0172 D1: two consecutive frames throwing the SAME error must record ONE entry ' +
        '(a repeat is the same diagnosis, and 60 Hz of it evicts the crash records the bundle ' +
        'exists to carry), and a DIFFERENT error must ALWAYS record. Three entries means no ' +
        'dedupe; one entry means a latch/throttle/visibility guard that throws away distinct ' +
        'errors; an empty list is today`s console-only catch',
    ).toEqual(['frame: first-boom', 'frame: second-boom']);
  });

  // -------------------------------------------------------------------------------------
  // B1c — a NON-Error throw. JavaScript lets you throw anything, and frames do.
  // -------------------------------------------------------------------------------------

  it('★ B1c BITES: a frame that throws a bare STRING is recorded with the same `frame: ` tag', async () => {
    // WRONG IMPL KILLED (1) ★ M5: `if (err instanceof Error) pushError(…)`. A string throw — the
    //   shape a wasm boundary, a rejected `throw 'stale seq'`, or any third-party library can
    //   produce — records NOTHING, and the bundle is silent for exactly the class of fault that
    //   is hardest to reproduce. This arm is the only one in this file that sees it.
    // WRONG IMPL KILLED (2) ★ M6: `pushError('uncaught', err.message)`. On a primitive there is
    //   no `.message`, so the record reads `frame: undefined` — a bundle entry that proves a
    //   frame threw and tells you nothing else. (The shipped design routes through the exported,
    //   documented-TOTAL `normalizeError`, which is also why a hostile `toString` cannot make
    //   the catch itself throw and recreate this very bug one level up.)
    // WRONG IMPL KILLED (3): a `String(err)`-style hand-roll that wraps the value — the exact
    //   string below admits only the message itself, never `Error: bare-string-boom` or
    //   `frame: [object Object]`.
    await setupMain();
    expectCleanBaseline();

    H.throwOnRender = 'bare-string-boom';
    runFrame();

    expect(
      uncaughtMessages(singleBundle()),
      'B1: a NON-Error throw must reach the bundle with the same `frame: ` tag and its own text. ' +
        '`normalizeError` is contractually total (Error -> .message; string -> itself; anything ' +
        'else -> a guarded String(raw)), so there is no input shape for which the catch may go ' +
        'quiet',
    ).toEqual(['frame: bare-string-boom']);
  });

  // -------------------------------------------------------------------------------------
  // B1d — a SECOND seam, at a genuinely different position in the try body.
  // -------------------------------------------------------------------------------------

  it('★ B1d BITES: a throw from the account-row read (above the render path) is recorded too, and the loop recovers', async () => {
    // WHY A SECOND SEAM, stated honestly: NOT because it kills a mutant B1a misses on its own,
    // but because every other arm injects its fault at ONE position. This one throws from
    // `store.ownAccount(identity)` — the privacy block, which sits ABOVE the predictor drain and
    // the render path — so the arms together prove the catch covers the WHOLE try body rather
    // than a suffix of it.
    // WRONG IMPL KILLED (1): a narrower fix that wraps only the render call in its own inner
    //   try/catch and records from there. Every B1a/B1b/B1c assertion would pass; a throw from
    //   anywhere else in the frame would still vanish into the console. This arm reds it.
    // WRONG IMPL KILLED (2): a fix that records but leaves the loop dead when the fault happens
    //   before the render seam — the recovery clause requires a later frame to reach `render()`.
    // ANTI-VACUITY: `H.renderCalls` must NOT move on the throwing frame (the fault is above the
    //   render path) and MUST move after the spy is restored. Both halves are asserted, so this
    //   arm cannot pass by accidentally throwing from the same place B1a does.
    const store = await setupMain();
    expectCleanBaseline();

    // `ownAccount` is a prototype method on AuthoritativeStore, so vi.spyOn installs an own
    // property and mockRestore() removes it cleanly (afterEach restores it again as a belt).
    const spy = vi.spyOn(store, 'ownAccount').mockImplementation(() => {
      throw new Error('own-account-boom');
    });
    ownAccountSpy = spy;

    const beforeThrow = H.renderCalls;
    runFrame();
    expect(
      H.renderCalls,
      'ANTI-VACUITY: this fault is injected ABOVE the render path, so the render seam must NOT ' +
        'have been reached — if it was, this arm is testing the same position as B1a',
    ).toBe(beforeThrow);

    expect(
      overlayRows(),
      'B1 (overlay): a throw from the account-row read must paint the same single tagged row — ' +
        'the frame catch has to cover the WHOLE try body, not just the render call',
    ).toEqual([{ source: 'uncaught', text: '[uncaught] frame: own-account-boom' }]);
    expect(
      uncaughtMessages(singleBundle()),
      'B1 (F9 bundle): and it must reach the bundle with the same tag',
    ).toEqual(['frame: own-account-boom']);

    spy.mockRestore();
    ownAccountSpy = undefined;
    const beforeRecovery = H.renderCalls;
    runFrame();
    expect(
      H.renderCalls,
      'B1 (re-arm): once the fault clears, the very next frame must run the whole body again — ' +
        'a fault above the render path must not leave the loop permanently short-circuited',
    ).toBe(beforeRecovery + 1);
  });
});
