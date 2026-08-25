// @vitest-environment happy-dom
/**
 * main.a11yFocus.test.ts — RUNTIME gate over main.ts's world-focus hotkey guard, the
 * frame-loop announcer, focus return, and the Space/targetOwnsKey fix (slice m23-s5;
 * ADR-0206; spec §2.3/§2.4/§6, A11Y-19/20/21/35/22/23).
 *
 * SOURCE OF TRUTH: the m23-s5 plan of record (§1, as amended by §8) and ADR-0206.
 *
 * MODELLED ON `main.battle-reseed.test.ts` (16r-f) — the sanctioned RUNTIME-import
 * exception documented at `main.wiring.test.ts:20-21` ("main.ts has DOM/wasm side
 * effects... source-scan (NOT import)"). Two deltas from that precedent, both required
 * by this slice's behaviour under test:
 *
 *   1. `#app` MUST exist. The precedent deliberately omits it so main() builds no view
 *      shells at all. This slice's whole subject — the twelve hotkey open-guards, the
 *      overlay a11y wiring, the canvas focus target — needs the REAL sixteen views
 *      constructed against the REAL static shells. The DOM is built by parsing the REAL
 *      `client/index.html` with `DOMParser` and moving its body children into the live
 *      document via `document.adoptNode` + `replaceChildren` — never `innerHTML`
 *      (ADR-0135). `document.adoptNode` is the spec-correct way to move a node across
 *      Documents (DOMParser.parseFromString returns nodes owned by a NEW Document); a
 *      bare cross-document `appendChild` is technically a WRONG_DOCUMENT error and this
 *      sidesteps needing to know whether happy-dom is lenient about it.
 *   2. The `./render/world` mock's `init(mount)` appends a
 *      `<canvas tabindex="0" role="application">` to `mount`, so
 *      `mount.querySelector('canvas')` (the M23S5-CANVASREF assignment) resolves and
 *      `.focus()` on it actually moves `document.activeElement` under happy-dom.
 *
 * THE FRAME LOOP IS ACTUALLY DRIVEN HERE, UNLIKE THE PRECEDENT. battle-reseed stubs
 * `requestAnimationFrame` as `() => 0` and never invokes the callback (it has no `#app`,
 * so nothing frame-shaped is under test there). This file captures the callback and
 * exposes `runFrame(atMs)`, which stubs `performance.now()` to `atMs` for the duration of
 * one synchronous call — `ui/liveRegion.ts`'s `flush()` only paints once
 * `now - windowOpenedAt >= 500`, so a test that reads the live region's text runs at least
 * two frames spaced >= 500 ms apart.
 *
 * DETERMINISM NOTE ON FOCUS TIMING: `openOverlayA11y` (`ui/overlayA11y.ts:111`) defers the
 * initial-focus move by a REAL `setTimeout(..., 0)` macrotask — deliberately, per that
 * module's own header, and it is NOT injected. Tests that need focus to have actually
 * landed INSIDE an overlay (A11Y-19's "focusable inside it focused" precondition) `await
 * vi.waitFor(...)`, which yields real event-loop turns and lets that timer fire. Tests
 * that press a SECOND hotkey immediately after the first, with no intervening `await`,
 * rely on the opposite fact — the deferred focus has NOT fired yet, so
 * `document.activeElement` is still `<body>` — to legitimately open a second overlay in
 * the same synchronous burst (S5T-ANNOUNCE-TOP). Both are real properties of the
 * production code, not test artefacts.
 *
 * RED REASON: none of `worldHasFocus`, `worldCanvasEl`, the twelve `&& worldHasFocus()`
 * conjuncts, the frame-loop announcement/focus-return pump, or the `targetOwnsKey` guard
 * on the terminal Space branch exist in main.ts yet. Every DOM-driven test below either
 * throws (missing `document.activeElement` narrowing round nothing changing) or asserts
 * against behaviour the current source does not produce. S5T-DISJOINT is the one
 * exception — see its own comment.
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`/`it.each`.
 *
 * NO `new RegExp(...)`, no `eval`, no `new Function` (Semgrep bans them — none used here).
 * NO `innerHTML` anywhere (ADR-0135) — DOM construction is `DOMParser` + `adoptNode` +
 * `replaceChildren` only; DOM reads use `textContent`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ConnectionOptions } from './net/connection';
import { t } from './ui/a11yCopy';
import { announcementsFor, type A11ySnapshot } from './ui/announcements';
import type { BugBundle, BugBundleInput } from './ui/bugBundle';
import { OVERLAY_A11Y, type OverlayId } from './ui/overlayRegistry';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  buildBugBundle: vi.fn<(input: BugBundleInput) => BugBundle>(),
}));

// The wasm pkg — identical shape to main.battle-reseed.test.ts's mock (every name main.ts
// imports, plus the three other exports of the real module).
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
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
// sessionState() MUST be 'hidden' or every hotkey in this file is swallowed by
// sessionGateBlocks() before it ever reaches the world-focus conjunct under test.
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

// The bundle assembler: real exports, buildBugBundle wrapped in a call-through spy — kept
// for parity with the sanctioned precedent even though this file's tests do not press F9.
vi.mock('./ui/bugBundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/bugBundle')>();
  H.buildBugBundle.mockImplementation(actual.buildBugBundle);
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

// The renderer: constructed unconditionally at main.ts's `renderer = new WorldRenderer()`,
// before the `#app` guard. DELTA 2 (see file header): `init(mount)` appends a real,
// focusable canvas so `mount.querySelector('canvas')` (M23S5-CANVASREF) resolves and
// `worldHasFocus()`'s `a === worldCanvasEl` arm is reachable from this test.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      const canvas = document.createElement('canvas');
      canvas.setAttribute('tabindex', '0');
      canvas.setAttribute('role', 'application');
      mount.appendChild(canvas);
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

// --- listener-cleanup harness (verbatim from main.battle-reseed.test.ts) ---------------
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

// --- DOM construction: the REAL client/index.html, never a fixture, never innerHTML ----
/** DELTA 1 (see file header). Parses the shipped `client/index.html` and moves its
 *  `<body>` element children — excluding the module `<script>`, which this harness
 *  replaces with a controlled `import('./main')` — into the LIVE document via
 *  `document.adoptNode`, never `innerHTML` (ADR-0135). */
function buildAppShellFromRealIndexHtml(): void {
  const htmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  let html: string;
  try {
    html = readFileSync(htmlPath, 'utf8');
  } catch (err) {
    throw new Error(`index.html could not be read at expected path: ${htmlPath} — ${err}`);
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const bodyChildren = Array.from(parsed.body.children).filter((el) => el.tagName !== 'SCRIPT');
  expect(
    bodyChildren.length,
    'ANTI-VACUITY: parsed index.html yielded no usable <body> children — the DOM this whole ' +
      'file depends on would be empty and every test below would fail for the wrong reason',
  ).toBeGreaterThan(5);
  const adopted = bodyChildren.map((el) => document.adoptNode(el));
  document.body.replaceChildren(...adopted);
  // Anti-vacuity: #app really is present (main.ts's mount guard reads it).
  expect(document.getElementById('app'), 'index.html must ship <div id="app">').not.toBeNull();
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

/** Run ONE frame at a stubbed `performance.now() === atMs`. Throws loud (never a silent
 *  no-op) if no callback is armed, or if the frame did not re-arm itself — main.ts's frame
 *  re-arms unconditionally in a `finally`, so a missing re-arm means the frame body threw
 *  in a way this harness cannot account for, and a silent no-op here would make every
 *  ANNOUNCE/FOCUS-RETURN test pass vacuously on a frame that never actually ran twice. */
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
      'be called again and every test relying on a second frame would silently measure nothing',
  ).not.toBeNull();
}

// --- overlay-state helpers ---------------------------------------------------------------
/** True iff `id`'s `initialFocusSelector` anchor resolves AND sits inside a node currently
 *  carrying `role="dialog"` — `openOverlayA11y`/`closeOverlayA11y` add/remove that attribute
 *  on the overlay's root on every open/close (`ui/overlayA11y.ts:106`/`:143`), so this is a
 *  single, uniform "is this overlay visible AND a11y-wired" check that works identically for
 *  the ten static index.html shells and the six `#app`-mounted constructed views — main.ts
 *  hands no other handle to this test file. */
function overlayIsOpen(id: OverlayId): boolean {
  const anchor = document.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
  return anchor !== null && anchor.closest('[role="dialog"]') !== null;
}

function overlayFocusAnchor(id: OverlayId): HTMLElement | null {
  return document.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
}

interface KeySpec {
  readonly code?: string;
  readonly key?: string;
}

/** Dispatch one `keydown` on `target` (default `window`, the listener main.ts registers
 *  on) and return the event so callers can read `.defaultPrevented`. */
function pressKey(spec: KeySpec, target: EventTarget = window): KeyboardEvent {
  const init: KeyboardEventInit = { bubbles: true, cancelable: true };
  if (spec.code !== undefined) init.code = spec.code;
  if (spec.key !== undefined) init.key = spec.key;
  const event = new KeyboardEvent('keydown', init);
  target.dispatchEvent(event);
  return event;
}

// --- the suite ---------------------------------------------------------------------------
describe('main.ts world-focus hotkey gate, frame-loop announcer, focus return, Space fix (m23-s5)', () => {
  let recorded: Recorded[] = [];
  let restoreWindowAdd: (() => void) | undefined;
  let restoreDocumentAdd: (() => void) | undefined;
  let opts!: ConnectionOptions;

  beforeEach(async () => {
    recorded = [];
    H.connectOpts = null;
    H.buildBugBundle.mockClear();
    buildAppShellFromRealIndexHtml();
    stubControllableRaf();
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);

    vi.resetModules();
    await import('./main');
    // main() awaits 17 dynamic view imports, then constructs all 16 views (renderer.init
    // is awaited BEFORE connect() is called), then calls connect() — so by the time
    // H.connectOpts resolves, #app's canvas and every overlay view already exist.
    opts = await vi.waitFor(
      () => {
        const captured = H.connectOpts;
        if (captured === null) throw new Error('connect() has not been called by main() yet');
        return captured;
      },
      { timeout: 5_000, interval: 5 },
    );
    opts.onReady(H.identity);
  });

  afterEach(() => {
    for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
    recorded = [];
    restoreDocumentAdd?.();
    restoreWindowAdd?.();
    restoreDocumentAdd = undefined;
    restoreWindowAdd = undefined;
    H.connectOpts = null;
    H.buildBugBundle.mockClear();
    vi.unstubAllGlobals();
    rafCallback = null;
    // replaceChildren, never innerHTML (ADR-0135) — the one deliberate deviation from the
    // battle-reseed precedent's `document.body.innerHTML = ''` cleanup line.
    document.body.replaceChildren();
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-19 / A11Y-20: the world-focus gate on the twelve canOpen-derived hotkey branches.
  // ---------------------------------------------------------------------------------------

  /** The box/raising/evolution HIDE_SWITCH trio, round-robined. This tier is DELIBERATE, not
   *  an arbitrary choice: box->raising (etc.) is the ONE combination where
   *  `overlayVerdict(target).kind === 'allow'` is true PURELY FROM canOpen()'s pre-existing
   *  tier rules, REGARDLESS of focus (two GUARD_ONLY overlays always deny each other — see
   *  `ui/overlayRegistry.ts`'s `decide()` — so a GUARD_ONLY pair would "block" the second
   *  hotkey even with NO `worldHasFocus()` conjunct at all, and S5T-GATE-BLOCKED below would
   *  pass against an unpatched main.ts for the WRONG reason). Only a same-tier HIDE_SWITCH
   *  pair isolates the new conjunct as the sole reason the second press is refused. */
  const DRIVABLE_OVERLAYS: ReadonlyArray<{
    readonly id: OverlayId;
    readonly openKey: KeySpec;
    readonly blockedById: OverlayId;
    readonly blockedByKey: KeySpec;
  }> = [
    { id: 'boxView', openKey: { code: 'KeyB' }, blockedById: 'raisingView', blockedByKey: { code: 'KeyI' } },
    { id: 'raisingView', openKey: { code: 'KeyI' }, blockedById: 'evolutionView', blockedByKey: { code: 'KeyE' } },
    { id: 'evolutionView', openKey: { code: 'KeyE' }, blockedById: 'boxView', blockedByKey: { code: 'KeyB' } },
  ];

  it.each(DRIVABLE_OVERLAYS)(
    'S5T-GATE-BLOCKED ($id open with focus inside it; $blockedById hotkey opens nothing and $id stays unchanged)',
    async ({ id, openKey, blockedById, blockedByKey }) => {
      // WRONG IMPL KILLED: the `&& worldHasFocus()` conjunct missing at the $blockedById
      // open-handler site. Without it, $blockedById's canOpen() verdict is ALREADY 'allow'
      // here (same-tier HIDE_SWITCH sibling — see the fixture comment above), so this second
      // hotkey WOULD open $blockedById out from under the player mid-read of $id: exactly the
      // quick-nav collision spec §2.3 exists to close (pressing a letter to jump to the next
      // control also toggles an overlay). The conjunct is the ONLY thing standing in the way.
      pressKey(openKey);
      expect(overlayIsOpen(id), `${id} must be open after its own hotkey`).toBe(true);
      const anchor = overlayFocusAnchor(id);
      expect(anchor, `${id}'s initialFocusSelector anchor must resolve`).not.toBeNull();
      // Let the REAL setTimeout(0) deferred-focus macrotask (ui/overlayA11y.ts:111) fire, so
      // focus is genuinely INSIDE the overlay — the A11Y-19 precondition, not merely open.
      await vi.waitFor(
        () => {
          expect(document.activeElement).toBe(anchor);
        },
        { timeout: 2_000, interval: 5 },
      );
      pressKey(blockedByKey);
      expect(overlayIsOpen(blockedById), `${blockedById} must NOT have opened`).toBe(false);
      expect(overlayIsOpen(id), `${id} must remain open, unchanged`).toBe(true);
      expect(document.activeElement, 'focus must not have moved').toBe(anchor);
    },
  );

  it.each(DRIVABLE_OVERLAYS)(
    'S5T-GATE-ALLOWED-BODY ($id opens from <body> focus, the pre-milestone behaviour)',
    ({ id, openKey }) => {
      // WRONG IMPL KILLED: `worldHasFocus` written as `a === worldCanvasEl` only (dropping
      // BOTH the `null` and `document.body` disjuncts) — every hotkey would be dead from a
      // fresh page load, before the player has ever Tabbed anywhere. ALSO KILLED: an
      // inverted conjunct (`!worldHasFocus()`) — every hotkey would open ONLY while focus is
      // inside some other overlay, exactly backwards.
      expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);
      pressKey(openKey);
      expect(overlayIsOpen(id)).toBe(true);
    },
  );

  it('S5T-GATE-ALLOWED-CANVAS: a hotkey still opens its overlay when the world CANVAS has focus', () => {
    // WRONG IMPL KILLED: `worldCanvasEl` never assigned (deleted, or shadowed by a second
    // `let worldCanvasEl` inside main()) — the red-team's #1 attack against this slice. With
    // worldCanvasEl permanently null, worldHasFocus() degrades to "body-or-nothing" and every
    // hotkey silently dies the FIRST time a keyboard/AT user Tabs to the canvas — the exact
    // user A11Y-20/M23 exists to serve, on the path this same slice adds. This test is the
    // ONLY behavioural killer of that bug in this suite, so the precondition is asserted
    // before dispatching, not inferred from the outcome.
    const mount = document.getElementById('app');
    expect(mount, '#app must exist').not.toBeNull();
    const canvas = mount!.querySelector('canvas') as HTMLElement | null;
    expect(canvas, 'the mocked WorldRenderer.init must have appended a <canvas> to #app').not.toBeNull();
    canvas!.focus();
    // AIRTIGHT precondition: document.activeElement REALLY IS the canvas before we press
    // anything — a stray failure to focus (e.g. no tabindex) must not silently pass this test.
    expect(document.activeElement, 'the canvas must actually hold focus').toBe(canvas);
    pressKey({ code: 'KeyQ' }); // questLogView — deliberately outside the DRIVABLE_OVERLAYS trio
    expect(overlayIsOpen('questLogView')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-35: the document.body disjunct — a force-hidden focused control blurs to <body>,
  // and hotkeys must not die forever afterward.
  // ---------------------------------------------------------------------------------------

  it('S5T-BODY-BLUR: an overlay hidden out from under a focused control blurs to <body>, and a DIFFERENT hotkey still opens afterward', () => {
    // WRONG IMPL KILLED: dropping the `=== document.body` disjunct from worldHasFocus() —
    // every hotkey stays dead from this point forward for the rest of the session, exactly
    // the "dead hotkeys forever after a dialogue ends" bug spec §2.3 names (the real trigger
    // is client/src/main.ts:1574's `dialogueView?.render(null)`, which display:nones a
    // focused choice <button> the same way this test simulates on renameView).
    pressKey({ code: 'KeyN' }); // renameView — GUARD_ONLY, no identity requirement
    expect(overlayIsOpen('renameView')).toBe(true);
    const submit = document.getElementById('rename-submit') as HTMLButtonElement | null;
    expect(submit, '#rename-submit must exist (client/index.html)').not.toBeNull();
    submit!.focus();
    expect(document.activeElement).toBe(submit);
    // The raw force-hide write (NOT renameView.hide()/closeOverlayA11y() — this simulates a
    // store-driven `render(null)`-style close, which does not route through the view's own
    // close path and therefore never restores focus itself).
    const overlayRoot = document.getElementById('rename-overlay');
    expect(overlayRoot).not.toBeNull();
    overlayRoot!.style.display = 'none';
    // happy-dom does not reliably implement the browser's automatic blur-to-<body> when a
    // focused element's ancestor becomes display:none (real DOM behaviour: a focused element
    // that stops being focusable is blurred, and focus falls back to <body>). Force it
    // explicitly so this test proves worldHasFocus()'s document.body disjunct, never
    // happy-dom's layout fidelity.
    document.body.focus();
    expect(document.activeElement, 'precondition: focus fell back to <body>').toBe(document.body);
    pressKey({ key: '?' }); // a DIFFERENT overlay's hotkey — proves the fix is general
    expect(overlayIsOpen('helpView')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-22: the frame-loop announcer.
  // ---------------------------------------------------------------------------------------

  it('S5T-ANNOUNCE-WORLD: closing the last overlay announces the world-region name, resolved through the a11yCopy catalog', () => {
    // WRONG IMPL KILLED (1): the pump never wired at all (S1's named cliff — nothing in S1-S4
    // reds if it is never wired, and the live region is then permanently silent).
    // WRONG IMPL KILLED (2): `liveRegion.flush(0)` (or any other CONSTANT argument) — with a
    // constant, `now - windowOpenedAt` is identically 0 forever and the region never paints
    // again, which is behaviourally identical to (1) but survives a naive containment scan for
    // `liveRegion.flush(`.
    pressKey({ key: '?' }); // open helpView from <body>
    runFrame(0); // registers 'helpView' as lastA11ySnapshot.topOverlay, queues its own name
    pressKey({ code: 'Escape' }); // close it
    runFrame(600); // >=500ms after window 0: flushes the queued overlay name; queues world-region
    runFrame(1100); // >=500ms after window 600: flushes the world-region message
    const region = document.getElementById('a11y-live');
    expect(region, '#a11y-live must exist (client/index.html)').not.toBeNull();
    // Resolved via t(), NEVER hardcoded — a future copy edit to a11yCopy.ts reds the
    // IMPLEMENTATION (a literal drifting from the catalog), never this assertion.
    expect(region!.textContent).toBe(t('a11y.world.region'));
  });

  it('S5T-ANNOUNCE-TOP: switching the frontmost overlay announces the SECOND overlay label, never the first and never nothing', () => {
    // WRONG IMPL KILLED (1): announcing the CLOSING overlay's name instead of the one that
    // is now on top (an off-by-one in which snapshot the reducer is called with).
    // WRONG IMPL KILLED (2): announcing nothing on an overlay-to-overlay transition — e.g. an
    // implementation that only wires the null-transition branch and forgets `announcementsFor`
    // is what has to fire for THIS edge (A11Y-8's own contract: topOverlay changing to a
    // non-null value is Rule 1 of `announcementsFor`, main.ts must actually call it).
    pressKey({ code: 'KeyB' }); // boxView opens; body is still focused (no await has run yet)
    runFrame(0); // lastA11ySnapshot.topOverlay becomes 'boxView'; its name is queued
    // KeyI (raisingView) is a HIDE_SWITCH sibling: canOpen() force-hides boxView. Pressed
    // with NO intervening await, so worldHasFocus() is still true (the deferred focus for
    // boxView has not fired) — this is the one legitimate way to drive a same-tier switch
    // without violating the very gate this slice adds.
    pressKey({ code: 'KeyI' });
    expect(overlayIsOpen('boxView'), 'boxView must have been force-hidden by the switch').toBe(false);
    expect(overlayIsOpen('raisingView')).toBe(true);
    runFrame(600); // flushes the queued 'boxView' name; queues 'raisingView's
    runFrame(1100); // flushes 'raisingView's name
    const region = document.getElementById('a11y-live');
    expect(region!.textContent).toBe(t(OVERLAY_A11Y.raisingView.labelKey));
    expect(region!.textContent).not.toBe(t(OVERLAY_A11Y.boxView.labelKey));
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-23: Space is not stolen from the (now-native-button) #help-hint, and still jumps
  // from the world.
  // ---------------------------------------------------------------------------------------

  it('S5T-SPACE-BUTTON: Space on the focused #help-hint button is NOT preventDefault-ed', () => {
    // WRONG IMPL KILLED: shipping #help-hint as a native <button> WITHOUT the
    // `targetOwnsKey(e)` guard on the terminal Space branch — A11Y-23's activation half
    // ships silently dead (Enter-only), invisible to every source scan (main.ts is
    // coverage-excluded, client/vite.config.ts:97).
    const helpHint = document.getElementById('help-hint') as HTMLElement | null;
    expect(helpHint, '#help-hint must exist (client/index.html)').not.toBeNull();
    helpHint!.focus();
    // dispatch ON THE BUTTON (not window) so it bubbles and e.target is the button.
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    helpHint!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('S5T-SPACE-WORLD: Space still jumps (preventDefault) when the world has focus', () => {
    // WRONG IMPL KILLED: an over-broad targetOwnsKey exemption (e.g. exempting Space
    // unconditionally, or keying off document.activeElement rather than e.target) that kills
    // jump() entirely — the movement feature this branch exists for.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    const event = pressKey({ code: 'Space' });
    expect(event.defaultPrevented).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // Focus return (§1.4 / D4) — not an EARS-numbered criterion on its own, but the load-
  // bearing mechanism A11Y-22's frame-loop edge shares with A11Y-20's Tab-to-canvas case.
  // ---------------------------------------------------------------------------------------

  it('S5T-FOCUS-RETURN: closing the last overlay returns focus to the canvas world region', () => {
    // WRONG IMPL KILLED (1): no focus return at all — the Escape-then-reopen loop never
    // closes for a keyboard user once focus has left <body> (closeOverlayA11y's own restore
    // already sends it to <body> here since the overlay was opened FROM <body> — see (2)).
    // WRONG IMPL KILLED (2): "pass the canvas as closeOverlayA11y's fallbackFocus and call it
    // done" (ADR-0206 D4, plan anti-pattern 13) — `fallbackFocus` is UNREACHABLE on this
    // exact path: `record.returnFocus` (captured as document.body at open time) is always
    // connected, so closeOverlayA11y's restore-order picks it FIRST and fallbackFocus is
    // never consulted. Only a frame-loop-owned focus return (S5's own edge) can move focus
    // from body to the canvas; this test fails on any implementation that skips that edge.
    pressKey({ key: '?' }); // helpView opens from <body>
    runFrame(0);
    pressKey({ code: 'Escape' }); // closeOverlayA11y restores focus to <body> (returnFocus)
    expect(document.activeElement, 'closeOverlayA11y restores to <body> here').toBe(document.body);
    runFrame(600); // the topOverlay->null edge: worldHasFocus() is true (body) -> canvas.focus()
    const canvas = document.getElementById('app')?.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('S5T-FOCUS-NO-STEAL: closing an overlay opened by CLICK does not steal focus from the badge', () => {
    // WRONG IMPL KILLED: an UNGUARDED `worldCanvasEl?.focus()` on the frame's close edge —
    // it would yank focus away from #help-hint the instant the menu closes, even though the
    // player never left the world via a hotkey at all (they clicked the badge). ADR-0206 D4's
    // whole point is that this branch must be guarded by worldHasFocus(), which is false here.
    const helpHint = document.getElementById('help-hint') as HTMLElement | null;
    expect(helpHint).not.toBeNull();
    helpHint!.focus();
    expect(document.activeElement, 'anti-vacuity: the badge really is focusable').toBe(helpHint);
    helpHint!.click(); // the delegated [data-menu-launcher] front door — opens menuView
    expect(overlayIsOpen('menuView'), 'menuView must have opened from the click').toBe(true);
    pressKey({ code: 'Escape' }); // the menu-nav intercept routes Escape to a close at the top level
    expect(overlayIsOpen('menuView'), 'menuView must have closed via Escape').toBe(false);
    runFrame(0); // the topOverlay->null edge
    expect(document.activeElement, 'focus must still be on the badge, not stolen').toBe(helpHint);
  });
});

// -------------------------------------------------------------------------------------------
// Cross-file tripwire — pure, no DOM, no main.ts import. Runs unconditionally (not inside the
// describe block above, so a beforeEach failure there can never mask it).
// -------------------------------------------------------------------------------------------

describe('S5T-DISJOINT tripwire: the two announcement paths stay disjoint', () => {
  it('S5T-DISJOINT: announcementsFor emits NOTHING on a topOverlay -> null transition', () => {
    // THIS IS A CROSS-FILE TRIPWIRE, NOT A DUPLICATE OF S1's OWN announcements.test.ts
    // COVERAGE. `ui/announcements.ts`'s own header documents a DELIBERATE copy gap (Rule 2:
    // "top -> null deliberately emits nothing") that main.ts's world-region branch exists to
    // fill on its own, disjoint predicate (`top === null`). ADR-0206 D3 states double-
    // announcing is "impossible by construction" BECAUSE the two predicates never overlap —
    // this test pins the announcements.ts half of that claim so that if a LATER slice closes
    // S1's copy gap inside announcements.ts (making Rule 2 emit the world-region text too)
    // while main.ts's disjoint branch from THIS slice still exists, the resulting DOUBLE
    // utterance of "World map" is caught by this slice's own test suite rather than silently
    // shipping. It is GREEN today (announcements.ts already ships the documented gap) and
    // stays green through this slice's own implementation — it exists for what comes after.
    const prev: A11ySnapshot = { topOverlay: 'boxView', message: '' };
    const next: A11ySnapshot = { topOverlay: null, message: '' };
    expect(announcementsFor(prev, next)).toEqual([]);
  });
});
