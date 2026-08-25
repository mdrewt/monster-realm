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
 * on the terminal Space branch exist in main.ts yet.
 *
 * RED at the fork (want them red now, green after impl): 3× `S5T-GATE-BLOCKED`,
 * `S5T-ANNOUNCE-WORLD`, `S5T-ANNOUNCE-TOP`, `S5T-SPACE-BUTTON`, `S5T-FOCUS-RETURN`.
 *
 * GREEN at the fork BY DESIGN (regression pins — labelled individually at each site, not
 * just here): 3× `S5T-GATE-ALLOWED-BODY`, `S5T-GATE-ALLOWED-CANVAS`, `S5T-SPACE-WORLD`,
 * `S5T-BODY-BLUR`, `S5T-FOCUS-NO-STEAL`, `S5T-DISJOINT`. Every one of these asserts
 * behaviour that is ALREADY true today for the trivial reason that no gate/pump/guard
 * exists yet to defeat — e.g. `S5T-BODY-BLUR`'s closing hotkey opens today because NOTHING
 * blocks any hotkey today, not because the `document.body` disjunct is already correct.
 * `S5T-GATE-ALLOWED-CANVAS` is the one worth stating explicitly, since it is also this
 * suite's ONLY behavioural killer of the red-team's #1 attack (`worldCanvasEl` never
 * assigned, or shadowed): it is green at the fork (opening from canvas focus is
 * unconditional today), and only becomes a REAL kill once the twelve conjuncts exist for it
 * to have something to blow through — which is exactly why it asserts
 * `document.activeElement` genuinely IS the canvas element BEFORE dispatching (so it can
 * never pass by the canvas silently being unfocusable instead of by the gate genuinely
 * recognising it).
 *
 * FIX CYCLE 1 (ADR-0206 Amendment A1). RED at this fix's fork: 6× `S5T-GATE-SAMEKEY-CLOSE`
 * and `S5T-GATE-REOPEN-AFTER-SAMEKEY-CLOSE` — the pre-amendment conjunct also gated the
 * toggle-CLOSE half, which killed same-key close for every user (the deferred focus makes
 * "focus is inside the overlay" the universal post-open state). GREEN AT FORK BY DESIGN:
 * `S5T-GATE-PRECEDENCE-DENY-WINS`, a mutation pin for the dropped-parens precedence bug.
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
import { type A11ySnapshot, announcementsFor } from './ui/announcements';
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
/** True iff `id`'s `initialFocusSelector` anchor resolves, its nearest `[role="dialog"]`
 *  ancestor exists, AND that root is actually on-screen (`style.display !== 'none'`).
 *
 *  THE ROLE CHECK ALONE IS NOT ENOUGH — measured, not theoretical. m23-s2 ships
 *  `role="dialog" aria-modal="true"` as STATIC LITERALS in `client/index.html` for the
 *  eleven static shells (verified at `client/index.html:89-92` for `#help-overlay`,
 *  `:104-107` for `#menu-overlay`, and identically for the other nine).
 *  `openOverlayA11y`/`closeOverlayA11y` (`ui/overlayA11y.ts:106`/`:143`) toggle those
 *  attributes only for the FIVE `#app`-mounted CONSTRUCTED views (box/raising/evolution/
 *  battle/claim), which ship no markup ARIA of their own. For a static shell,
 *  `closest('[role="dialog"]')` is therefore non-null WHETHER THE OVERLAY IS OPEN OR
 *  CLOSED — role presence alone silently degenerates to "always true" for eleven of the
 *  sixteen overlays (this is exactly what made an earlier version of this helper produce a
 *  false positive on every static shell). `style.display` is the one signal EVERY view's
 *  `show()`/`hide()` writes in BOTH families — even `MenuView.show()`/`hide()`
 *  (`ui/menuView.ts:78-84`), which does not call `openOverlayA11y` at all today — so it is
 *  the only reliable open/closed signal common to both families. */
function overlayIsOpen(id: OverlayId): boolean {
  const anchor = document.querySelector(OVERLAY_A11Y[id].initialFocusSelector);
  const root = anchor === null ? null : anchor.closest('[role="dialog"]');
  return root !== null && (root as HTMLElement).style.display !== 'none';
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
    {
      id: 'boxView',
      openKey: { code: 'KeyB' },
      blockedById: 'raisingView',
      blockedByKey: { code: 'KeyI' },
    },
    {
      id: 'raisingView',
      openKey: { code: 'KeyI' },
      blockedById: 'evolutionView',
      blockedByKey: { code: 'KeyE' },
    },
    {
      id: 'evolutionView',
      openKey: { code: 'KeyE' },
      blockedById: 'boxView',
      blockedByKey: { code: 'KeyB' },
    },
  ];

  it('overlayIsOpen() sanity: reads false for a never-opened STATIC shell (helpView) AND a never-opened CONSTRUCTED shell (boxView)', () => {
    // ANTI-VACUITY FOR EVERY GATE/ANNOUNCE/FOCUS TEST IN THIS FILE. A helper that has
    // degenerated back to "role presence alone" (see overlayIsOpen's own doc comment — this
    // is the EXACT shape of a bug this suite shipped once) would read TRUE here for
    // helpView even though nothing has ever opened it, which would make every
    // `expect(overlayIsOpen(blockedById)).toBe(false)` in S5T-GATE-BLOCKED pass vacuously
    // regardless of whether worldHasFocus() blocks anything at all.
    expect(
      overlayIsOpen('helpView'),
      'a static shell must read false before it is ever shown',
    ).toBe(false);
    expect(
      overlayIsOpen('boxView'),
      'a constructed shell must read false before it is ever shown',
    ).toBe(false);
  });

  it.each(
    DRIVABLE_OVERLAYS,
  )('S5T-GATE-BLOCKED ($id open with focus inside it; $blockedById hotkey opens nothing and $id stays unchanged)', async ({
    id,
    openKey,
    blockedById,
    blockedByKey,
  }) => {
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
  });

  it.each(
    DRIVABLE_OVERLAYS,
  )('S5T-GATE-ALLOWED-BODY ($id opens from <body> focus, the pre-milestone behaviour)', ({
    id,
    openKey,
  }) => {
    // GREEN AT FORK BY DESIGN — a regression pin, not a red test. Opening from <body>
    // focus is the UNCONDITIONAL, pre-milestone behaviour: it is already true today with
    // no gate in place at all, and stays true once worldHasFocus() lands correctly. It
    // only goes RED against a WRONG implementation.
    // WRONG IMPL KILLED: `worldHasFocus` written as `a === worldCanvasEl` only (dropping
    // BOTH the `null` and `document.body` disjuncts) — every hotkey would be dead from a
    // fresh page load, before the player has ever Tabbed anywhere. ALSO KILLED: an
    // inverted conjunct (`!worldHasFocus()`) — every hotkey would open ONLY while focus is
    // inside some other overlay, exactly backwards.
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);
    pressKey(openKey);
    expect(overlayIsOpen(id)).toBe(true);
  });

  it('S5T-GATE-ALLOWED-CANVAS: a hotkey still opens its overlay when the world CANVAS has focus', () => {
    // GREEN AT FORK BY DESIGN, for a reason worth stating precisely (not just "it's a
    // regression pin"): today NOTHING gates any hotkey on focus at all, so opening from
    // canvas focus is unconditionally true before this slice lands — this test is green for
    // the TRIVIAL reason, not because worldCanvasEl already works. It becomes this suite's
    // ONLY REAL BEHAVIOURAL KILLER of the red-team's #1 attack (`worldCanvasEl` never
    // assigned, or shadowed by a second `let worldCanvasEl` inside main()) ONLY once the
    // twelve conjuncts exist for that attack to have something to defeat: with
    // worldCanvasEl permanently null, worldHasFocus() degrades to "body-or-nothing" and
    // every hotkey would silently die the FIRST time a keyboard/AT user Tabs to the
    // canvas — the exact user A11Y-20/M23 exists to serve, on the path this same slice
    // adds. That is why the canvas-has-focus precondition is asserted BEFORE dispatching,
    // never inferred from the outcome — so this test can never pass by the canvas silently
    // being unfocusable instead of by the gate genuinely recognising it.
    const mount = document.getElementById('app');
    expect(mount, '#app must exist').not.toBeNull();
    const canvas = mount!.querySelector('canvas') as HTMLElement | null;
    expect(
      canvas,
      'the mocked WorldRenderer.init must have appended a <canvas> to #app',
    ).not.toBeNull();
    canvas!.focus();
    // AIRTIGHT precondition: document.activeElement REALLY IS the canvas before we press
    // anything — a stray failure to focus (e.g. no tabindex) must not silently pass this test.
    expect(document.activeElement, 'the canvas must actually hold focus').toBe(canvas);
    pressKey({ code: 'KeyQ' }); // questLogView — deliberately outside the DRIVABLE_OVERLAYS trio
    expect(overlayIsOpen('questLogView')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-19, as amended by ADR-0206 Amendment A1: the SELF-OPEN DISJUNCT. The gate applies to
  // the twelve overlay-OPEN transitions only; a same-key press on an already-open overlay is a
  // toggle-CLOSE and must never be gated. This is the unit-tier encoding of the three e2e
  // regressions PR #368 shipped — e2e/movement-input.spec.ts:493 (14r-e C GREEN GUARD, KeyB
  // closes the box under a held key), e2e/trade.spec.ts:97 (M15c, KeyU toggle-close) and the
  // e2e/pvp.spec.ts:145 cascade (the previous serial test's KeyB cleanup close was blocked, so
  // the box was still open and the next `p` was denied by the REGISTRY verdict, not by this
  // gate). Those three run only in the remote e2e job; these run in `just test`.
  // ---------------------------------------------------------------------------------------

  /** Every registry overlay currently on screen, in OVERLAY_A11Y declaration order.
   *
   *  Built from the SAME `overlayIsOpen` predicate the sanity test at the top of this file
   *  pins (and whose own doc comment records why `style.display`, not `role`, is the only
   *  open/closed signal common to the static-shell and constructed-shell families), so a
   *  regression in that helper reds the sanity test FIRST rather than silently emptying this
   *  list. Used only for WHOLE-SET assertions — "exactly these are open" — never as a
   *  single-overlay "is closed" check, so a helper that degenerated to always-false would be
   *  caught by the `toEqual([id])` half rather than passing the `toEqual([])` half for free. */
  const openOverlayIds = (): OverlayId[] =>
    (Object.keys(OVERLAY_A11Y) as OverlayId[]).filter((oid) => overlayIsOpen(oid));

  /** The same-key CLOSE fixture, DELIBERATELY WIDER than DRIVABLE_OVERLAYS.
   *
   *  DRIVABLE_OVERLAYS is narrow for a reason that does NOT apply here: S5T-GATE-BLOCKED needs
   *  a same-tier HIDE_SWITCH sibling whose `canOpen` verdict is `allow` regardless of focus, so
   *  that the new conjunct is the SOLE reason the second press is refused. The self-close case
   *  has no such constraint — `canOpen` exempts SELF, so every one of the twelve is `allow` for
   *  its own key while it is the only thing open. Restricting this fixture to the trio would
   *  leave the minimum edit that turns the three named e2e specs green — adding the disjunct to
   *  the three HIDE_SWITCH sites ONLY — passing every behavioural test in this file.
   *
   *  The six rows span all three shapes the twelve sites take:
   *   • the HIDE_SWITCH trio  — CONSTRUCTED `#app`-mounted shells, closed via `toggle()`;
   *   • questLogView / tradeView — STATIC index.html shells, closed via the explicit
   *     `if (X?.visible) X.hide(); else openX();` arm, and tradeView is literally
   *     e2e/trade.spec.ts:97's subject;
   *   • helpView — the SOLE `e.key` branch (every other hotkey is `e.code`).
   *  All six views route `show()`/`render(vm)` through `openOverlayA11y` and `hide()` through
   *  `closeOverlayA11y` (verified in ui/boxView.ts:131-142, ui/questLogView.ts:34-62,
   *  ui/tradeView.ts:64-83, ui/helpView.ts:42-58), which is what makes the deferred-focus wait
   *  below deterministic rather than hopeful. menuView is deliberately NOT here: it does not
   *  call openOverlayA11y at all today (see overlayIsOpen's doc comment), so no focus would
   *  ever land inside it and the test would prove nothing. */
  const SAMEKEY_OVERLAYS: ReadonlyArray<{
    readonly id: OverlayId;
    readonly openKey: KeySpec;
  }> = [
    { id: 'boxView', openKey: { code: 'KeyB' } },
    { id: 'raisingView', openKey: { code: 'KeyI' } },
    { id: 'evolutionView', openKey: { code: 'KeyE' } },
    { id: 'questLogView', openKey: { code: 'KeyQ' } },
    { id: 'tradeView', openKey: { code: 'KeyU' } },
    { id: 'helpView', openKey: { key: '?' } },
  ];

  it.each(
    SAMEKEY_OVERLAYS,
  )('S5T-GATE-SAMEKEY-CLOSE ($id toggle-CLOSES on a second press of its OWN hotkey, with focus already inside it)', async ({
    id,
    openKey,
  }) => {
    // RED AT AUTHORING TIME, for the right reason: the pre-amendment guard
    // `<verdict>.kind === 'allow' && worldHasFocus()` is FALSE on the second press, because
    // S3/S4's `openOverlayA11y` deferred focus (ui/overlayA11y.ts:111-113) has moved focus
    // INSIDE the overlay by then — so the branch body never runs, the overlay stays open, and
    // the `toBe(false)` below fails. That is exactly what the three named e2e specs observed.
    //
    // WRONG IMPL KILLED (1) ★ THE DEFECT: the un-amended conjunct at any of the six sites.
    //   Same-key close is dead for every user and every overlay — spec §2.3's compatibility
    //   claim ("a sighted player who never Tabs has activeElement === <body>") is false once
    //   EVERY hotkey open moves focus into the overlay it just opened.
    // WRONG IMPL KILLED (2): a reshape applied to the HIDE_SWITCH trio ONLY — the minimum edit
    //   that turns the three e2e specs green. The three non-trio rows above are what see it;
    //   the twelve `expectedRaw` pins in main.wiring.test.ts see it from the source side.
    // WRONG IMPL KILLED (3): a reshape that closes the overlay but ALSO opens something else
    //   (e.g. a self-open disjunct copy-pasted with a sibling's identifier, so KeyB closes the
    //   box and the sibling's branch then fires) — the whole-set `toEqual([])` catches it,
    //   where a bare `expect(overlayIsOpen(id)).toBe(false)` would not.
    // NOT KILLED HERE, stated rather than implied: deleting the `forceHide` loop from the trio
    //   handlers. `canOpen` exempts SELF, so `forceHide` is empty on this path by construction.
    //   S5T-ANNOUNCE-TOP below ("boxView must have been force-hidden by the switch") is the
    //   behavioural killer for that, and the wiring `expectedRaw` pins are the source-side one.
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);

    pressKey(openKey);
    expect(
      overlayIsOpen(id),
      `${id} must be open after its own hotkey. If THIS is the assertion that failed, the ` +
        'defect is in the OPEN half (or the open path has a store dependency this harness does ' +
        'not satisfy) — not in the toggle-close this test is about',
    ).toBe(true);
    expect(openOverlayIds(), `${id} must be the ONLY overlay open at this point`).toEqual([id]);

    // Let the REAL setTimeout(0) deferred-focus macrotask (ui/overlayA11y.ts:111) fire, so
    // focus is genuinely INSIDE the overlay — the A11Y-19 post-open state, and the precise
    // state in which the pre-amendment gate refuses the close. Without this wait the test
    // would pass against the UNFIXED implementation (activeElement would still be <body>, so
    // worldHasFocus() would still be true) — i.e. this await is what makes the test bite.
    const anchor = overlayFocusAnchor(id);
    expect(anchor, `${id}'s initialFocusSelector anchor must resolve`).not.toBeNull();
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );

    pressKey(openKey); // the SAME key again — a toggle-CLOSE, never an open
    expect(
      overlayIsOpen(id),
      `${id} must be CLOSED by the second press of its own hotkey (ADR-0206 A1: the gate ` +
        'applies to the OPEN transitions only — canOpen exempts self, so the verdict is still ' +
        '`allow`, and the self-open disjunct is what lets the close through while focus sits ' +
        'inside the overlay being closed)',
    ).toBe(false);
    expect(
      openOverlayIds(),
      'no overlay at all may be open after the toggle-close — the second press must CLOSE, ' +
        'never switch to something else',
    ).toEqual([]);
  });

  it('S5T-GATE-REOPEN-AFTER-SAMEKEY-CLOSE: after a same-key close, focus leaves the overlay and a DIFFERENT hotkey opens again (the pvp.spec.ts:145 cascade)', async () => {
    // The e2e/pvp.spec.ts:145 shape, at the unit tier: a serial spec's cleanup close (KeyB) is
    // silently blocked, so the box is STILL OPEN when the next test presses its own hotkey —
    // and that next open is then denied by the REGISTRY verdict (boxView is HIDE_SWITCH, but
    // questLogView is GUARD_ONLY, so `canOpen('questLogView', ['boxView'])` denies over it).
    // The failure surfaces one test later, against a completely unrelated feature, which is why
    // it must be pinned as a CASCADE and not just as "the close works".
    //
    // RED AT AUTHORING TIME: the second KeyB is blocked, so the first assertion below fails.
    // The assertion ORDER is deliberate — the close is asserted BEFORE the focus precondition,
    // so today's RED names the blocked close rather than a focus-timing symptom of it.
    //
    // WRONG IMPL KILLED (1): the un-amended conjunct (as above), now shown to break a LATER,
    //   unrelated overlay rather than just the one whose key was pressed.
    // WRONG IMPL KILLED (2) ★ the one no other test in this file sees: an amendment that closes
    //   the overlay but leaves focus TRAPPED inside the (now display:none) former overlay root
    //   — e.g. a hide path that skips closeOverlayA11y, or a "close by writing style.display"
    //   shortcut. worldHasFocus() would then be permanently false, and the very next hotkey
    //   would be dead: same user-visible bug, one press later. The <body> assertion below is
    //   the precondition that makes the final KeyQ assertion mean "the gate allowed it",
    //   never "it happened to work".
    // WHY THE <body> ASSERTION IS AN ASSERTION AND NOT A COMMENT: it is a real, verified
    //   property of the production close path, not an assumption — `boxView.hide()` calls
    //   `closeOverlayA11y('boxView', null)` (ui/boxView.ts:138-142), whose restore order
    //   (ui/overlayA11y.ts:146-149) prefers `record.returnFocus` whenever it is still
    //   connected. That was captured at open time as `document.activeElement` === <body> (the
    //   overlay was opened by hotkey from the world), an HTMLElement that is always connected,
    //   so `fallbackFocus` is unreachable here and focus lands back on <body>. The same fact is
    //   already relied on by S5T-FOCUS-RETURN's "closeOverlayA11y restores to <body> here".
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);

    pressKey({ code: 'KeyB' });
    expect(overlayIsOpen('boxView'), 'boxView must be open after KeyB').toBe(true);
    const anchor = overlayFocusAnchor('boxView');
    expect(anchor, "boxView's initialFocusSelector anchor must resolve").not.toBeNull();
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );

    pressKey({ code: 'KeyB' }); // the cleanup close every serial e2e spec performs
    expect(
      overlayIsOpen('boxView'),
      'boxView must be CLOSED by the second KeyB — a blocked cleanup close is what left the ' +
        'box open across e2e/pvp.spec.ts serial tests',
    ).toBe(false);
    expect(
      document.activeElement,
      'after the close, focus must be back on <body> — closeOverlayA11y restores the captured ' +
        'returnFocus (see this test`s own comment). If focus is still inside the closed ' +
        'overlay, worldHasFocus() is false forever and the next hotkey is dead',
    ).toBe(document.body);

    pressKey({ code: 'KeyQ' }); // a DIFFERENT overlay, GUARD_ONLY — the cascade's victim
    expect(
      overlayIsOpen('questLogView'),
      'KeyQ must open the quest log after the box was closed — this is the pvp.spec.ts:145 ' +
        'cascade: with the box still open, `canOpen` denies over a GUARD_ONLY-blocked world ' +
        'and the failure is reported against the NEXT feature, not against the gate',
    ).toBe(true);
    expect(openOverlayIds(), 'the quest log must be the only overlay open').toEqual([
      'questLogView',
    ]);
  });

  it('S5T-GATE-PRECEDENCE-DENY-WINS: a DENIED verdict still refuses the open even when the world has focus', () => {
    // GREEN AT FORK BY DESIGN — a mutation pin, not a red gate, and worth stating exactly why
    // it exists: it is the ONLY behavioural killer in this suite of the dropped-parens reshape
    //     <verdict>.kind === 'allow' && <selfView>?.visible || worldHasFocus()
    // which `&&`-binds tighter than `||` and therefore parses as
    //     ((<verdict> === 'allow') && <selfView>?.visible) || worldHasFocus()
    // — i.e. the WHOLE VERDICT is bypassed whenever the world has focus. Every other test in
    // this file passes that mutant: S5T-GATE-BLOCKED presses its key with focus INSIDE an
    // overlay (worldHasFocus() false, and the pressed sibling is closed, so both operands are
    // false either way), S5T-GATE-ALLOWED-* press with an `allow` verdict, and
    // S5T-GATE-SAMEKEY-CLOSE presses with `allow && visible` already true. Only a press whose
    // verdict is DENY *while the world has focus* separates the two spellings — and that is
    // A11Y-19's whole substance for the eleven GUARD_ONLY overlays.
    //
    // WRONG IMPL KILLED (1) ★ NAMED: the dropped-parens precedence bug above. Its blast radius
    //   is the entire mutual-exclusion contract, not just this pair: with the world focused,
    //   ANY hotkey opens its overlay over a live battle (EXCLUSIVE_TOP) or a live NPC dialogue
    //   (GUARD_ONLY, where a client-side stack strands the server player_conversation row —
    //   ptc5c/ADR-0139).
    // WRONG IMPL KILLED (2): a disjunct written with the wrong view identifier at some site
    //   (`(boxView?.visible || worldHasFocus())` pasted into the `?` handler): with the box
    //   closed the reshape is a no-op, but this test's mutant coverage and the twelve
    //   `expectedRaw` pins together pin identifier-per-site.
    // NO deferred-focus await here, and it is load-bearing: the second press must happen while
    // `document.activeElement` is STILL <body>, so `worldHasFocus()` is TRUE at that moment —
    // that is the precondition that lets the mutant fire, and it is ASSERTED, never assumed.
    // (The same "no intervening await" property S5T-ANNOUNCE-TOP relies on; see this file's
    // header, DETERMINISM NOTE ON FOCUS TIMING.)
    pressKey({ code: 'KeyQ' }); // questLogView — GUARD_ONLY, opened from <body>
    expect(overlayIsOpen('questLogView'), 'questLogView must be open after KeyQ').toBe(true);
    expect(
      document.activeElement,
      'precondition: the deferred focus has NOT fired yet, so the world still has focus and ' +
        'worldHasFocus() is TRUE for the press below — without this the mutant cannot fire and ' +
        'this test would prove nothing',
    ).toBe(document.body);

    pressKey({ key: '?' }); // helpView — its verdict is DENY over a visible GUARD_ONLY overlay
    expect(
      overlayIsOpen('helpView'),
      'helpView must NOT open over the quest log: `canOpen` denies over a GUARD_ONLY overlay, ' +
        'and the self-open disjunct must be a PARENTHESISED operand of the verdict conjunct — ' +
        '`allow && visible || worldHasFocus()` bypasses the verdict entirely whenever the ' +
        'world has focus',
    ).toBe(false);
    expect(openOverlayIds(), 'the quest log must remain the only overlay open, unchanged').toEqual([
      'questLogView',
    ]);
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-35: the document.body disjunct — a force-hidden focused control blurs to <body>,
  // and hotkeys must not die forever afterward.
  // ---------------------------------------------------------------------------------------

  it('S5T-BODY-BLUR: an overlay hidden out from under a focused control blurs to <body>, and a DIFFERENT hotkey still opens afterward', async () => {
    // GREEN AT FORK BY DESIGN — a regression pin, not a red test. Today NOTHING gates any
    // hotkey on focus at all, so the closing `?` press below opens helpView unconditionally
    // whether or not the document.body disjunct is ever implemented correctly; it only goes
    // RED against a WRONG implementation once the twelve conjuncts exist.
    // WRONG IMPL KILLED: dropping the `=== document.body` disjunct from worldHasFocus() —
    // every hotkey stays dead from this point forward for the rest of the session, exactly
    // the "dead hotkeys forever after a dialogue ends" bug spec §2.3 names (the real trigger
    // is client/src/main.ts:1574's `dialogueView?.render(null)`, which display:nones a
    // focused choice <button> the same way this test simulates on renameView).
    pressKey({ code: 'KeyN' }); // renameView — GUARD_ONLY, no identity requirement
    // Flush the REAL setTimeout(0) deferred-focus macrotask (ui/overlayA11y.ts:111) before
    // touching focus ourselves. renameView is a STATIC shell: opening it schedules a focus
    // move to `#rename-input` the instant KeyN's handler returns. Letting that settle first
    // — rather than racing a synchronous `.focus()` call against a pending macrotask — is
    // what makes the SUBMIT-button focus below deterministic instead of timing-dependent.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overlayIsOpen('renameView')).toBe(true);
    // `#rename-input`, NOT `#rename-submit`: the submit button ships `disabled` until a name is
    // typed (client/index.html), and `.focus()` on a disabled control is a silent no-op — the
    // precondition below would then fail for a fixture reason rather than a behavioural one.
    // The input is also exactly where openOverlayA11y's deferred focus already landed, so this
    // is the real "a focusable inside the overlay holds focus" state, not a synthetic one.
    const focused = document.getElementById('rename-input') as HTMLInputElement | null;
    expect(focused, '#rename-input must exist (client/index.html)').not.toBeNull();
    focused!.focus();
    expect(document.activeElement).toBe(focused);
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
    expect(overlayIsOpen('boxView'), 'boxView must have been force-hidden by the switch').toBe(
      false,
    );
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
    // GREEN AT FORK BY DESIGN — a regression pin. `jump(); e.preventDefault();` already
    // fires unconditionally on Space today; this only goes RED if a future targetOwnsKey
    // exemption becomes over-broad enough to swallow it.
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

  it('S5T-FOCUS-RETURN-STALE: the close-edge focus return fires even when focus is STRANDED inside the just-hidden overlay (the Chromium async-blur window)', async () => {
    // RED AT AUTHORING TIME. The frame's close edge guards the return with `worldHasFocus()`
    // alone; with focus stranded on `#help-title` — a node inside a `display:none` subtree —
    // that predicate is false (the anchor is neither null, nor <body>, nor the canvas), so
    // `worldCanvasEl?.focus()` never runs and the final assertion below fails with
    // activeElement still on the hidden anchor. GREEN once the close edge reads
    // `if (worldHasFocus() || focusInsideHiddenSubtree())`.
    //
    // WHY THIS IS A REAL BUG AND NOT A HARNESS ARTEFACT — the engine divergence, stated once:
    // in real Chromium the automatic blur-to-<body> fixup after an ancestor becomes
    // `display:none` is ASYNC (measured with a live-browser focus probe: the stale
    // `document.activeElement` persists for up to ~200 ms), AND `closeOverlayA11y`'s explicit
    // restore is `document.body.focus()`, which is a NO-OP in Chromium because <body> carries
    // no tabindex. happy-dom diverges on BOTH halves — its `body.focus()` succeeds (which is
    // why the assertion two lines below passes here) and it never auto-blurs at all. That is
    // exactly why the unit tier could not see this defect while e2e/trade.spec.ts:115 and
    // e2e/pvp.spec.ts:106 could: each is an OPEN pressed immediately after the previous test's
    // close, landing inside the stale window where every gated hotkey is dead.
    //
    // happy-dom's refusal to auto-blur is what makes it the PERFECT simulator for that window:
    // the stale state can be re-created exactly, deterministically, with no timers — see the
    // explicit `anchor.focus()` below and the two assertions that pin the state it produces.
    //
    // WRONG IMPL KILLED (1) ★ THE DEFECT: the close edge left as a bare `if (worldHasFocus())`.
    //   Focus never returns to the world region on ANY close where focus was inside the
    //   overlay (same-key toggle, Escape, or a store-driven `render(null)`), so the very next
    //   hotkey is dead until the engine's own fixup lands. Nothing else in this suite sees it —
    //   S5T-FOCUS-RETURN closes from a state where focus was ALREADY back on <body> (happy-dom
    //   restored it), which is precisely the state Chromium does not reach.
    // WRONG IMPL KILLED (2) — ⚠ NOT BY THIS TEST, AND NOT BY THE SUITE AS IT STANDS: an
    //   `offsetParent === null` discriminator instead of the inline-`display` ancestor walk.
    //   `offsetParent` is null for EVERY `position:fixed` element (CSSOM), and null for
    //   essentially everything under a layout-less DOM — so it reports "hidden" for the VISIBLE
    //   always-on corner affordance, whose inline style is `position:fixed` (client/index.html),
    //   and the close edge would yank focus to the canvas the moment a click-opened overlay
    //   closes. THIS test cannot see it (focus here really IS inside a hidden subtree, so both
    //   spellings return true). S5T-FOCUS-NO-STEAL is the right tooth for it, but TODAY it does
    //   not bite either: it runs its single `runFrame(0)` AFTER the menu has both opened and
    //   closed, so `lastA11ySnapshot.topOverlay` is still `null` and the outer edge predicate
    //   (`lastA11ySnapshot.topOverlay !== null && top === null`) is FALSE — the guarded branch
    //   is never entered. One added `runFrame(0)` between that test's click-open and its
    //   Escape-close fixes it and makes its code match its own comment; see notes.md §(a) for
    //   the exact edit. Recorded here rather than glossed, because a WRONG IMPL KILLED list
    //   that names a tooth which does not actually kill is worse than one that says nothing.
    // WRONG IMPL KILLED (3): a discriminator that checks only the ACTIVE ELEMENT's own style
    //   (`document.activeElement.style.display === 'none'`) and not its ancestors. The anchor
    //   carries `tabindex="-1"` and NO inline display at all (client/index.html) — only the
    //   overlay ROOT is display:none — so it reads false and the stale window stands. This test
    //   reds on it exactly as it reds on (1); the ancestor walk is the whole mechanism.
    pressKey({ key: '?' }); // helpView opens from <body>, the pre-milestone path
    expect(overlayIsOpen('helpView'), 'helpView must be open after `?`').toBe(true);
    runFrame(0); // registers 'helpView' as lastA11ySnapshot.topOverlay — arms the close edge

    // Let the REAL setTimeout(0) deferred focus (ui/overlayA11y.ts:111) land INSIDE the overlay.
    // This is the A11Y-19 post-open state, and it is what makes the close below produce the
    // stale window rather than a close from <body>.
    const anchor = overlayFocusAnchor('helpView');
    expect(anchor, "helpView's initialFocusSelector anchor must resolve").not.toBeNull();
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );

    pressKey({ key: '?' }); // the A1 same-key toggle-CLOSE — one of the three measured e2e paths
    expect(
      overlayIsOpen('helpView'),
      'helpView must be CLOSED by the second `?` (ADR-0206 Amendment A1). If THIS is the ' +
        'assertion that failed, A1 has not landed and the rest of this test is not yet meaningful',
    ).toBe(false);
    expect(
      document.activeElement,
      "happy-dom's closeOverlayA11y restore to <body> SUCCEEDS here — pinned so the divergence " +
        'is explicit rather than assumed: in Chromium this same `document.body.focus()` is a ' +
        'NO-OP (no tabindex on <body>), which is the first half of why the stale window exists ' +
        'at all',
    ).toBe(document.body);

    // --- RE-CREATE THE CHROMIUM STALE STATE, EXPLICITLY -----------------------------------
    // Simulating Chromium's ASYNC blur fixup: for up to ~200 ms after the close, the browser
    // leaves activeElement on the anchor INSIDE the now-hidden overlay. happy-dom permits
    // focusing a node inside a display:none subtree (it runs no layout), so the state is
    // reproducible exactly — and both halves of it are ASSERTED, so this test can never pass
    // (or fail) for a state other than the one it claims to model.
    const overlayRoot = document.getElementById('help-overlay');
    expect(overlayRoot, '#help-overlay must exist (client/index.html)').not.toBeNull();
    expect(
      overlayRoot!.style.display,
      'precondition: the overlay root really is display:none — the ancestor the walk must find',
    ).toBe('none');
    anchor!.focus();
    expect(
      document.activeElement,
      'precondition: focus is STRANDED on the anchor inside the hidden subtree. This is the ' +
        'exact observable Chromium presents on the close frame; if happy-dom ever refuses this ' +
        'focus, the simulation is broken and the assertion below would pass for the wrong reason',
    ).toBe(anchor);

    runFrame(600); // the topOverlay -> null edge, evaluated against the stale activeElement

    const canvas = document.getElementById('app')?.querySelector('canvas');
    expect(
      canvas,
      'the mocked WorldRenderer.init must have appended a <canvas> to #app',
    ).not.toBeNull();
    expect(
      document.activeElement,
      'the close edge must return focus to the world canvas even though worldHasFocus() reads ' +
        'a STALE anchor inside the hidden overlay — otherwise every gated hotkey is dead for ' +
        "the whole of Chromium's async-blur window (~200 ms), which is what killed " +
        'e2e/trade.spec.ts:115 and e2e/pvp.spec.ts:106. The frame heals it in ONE rAF tick, ' +
        'deterministically, instead of waiting on an engine fixup that may never come',
    ).toBe(canvas);
  });

  it('S5T-FOCUS-NO-STEAL: closing an overlay opened by CLICK does not steal focus from the badge', () => {
    // GREEN AT FORK BY DESIGN — a regression pin, and worth stating exactly why: today
    // NOTHING in the frame loop touches focus at all (no snapshot pump exists yet), so focus
    // simply never moves off the badge in the first place — this passes trivially, not
    // because a guard already exists. It becomes a real kill once S5T-FOCUS-RETURN's
    // mechanism (an UNGUARDED `worldCanvasEl?.focus()` on the frame's close edge) exists for
    // it to catch — see the M23S5-A11YSNAPSHOT region's own `worldHasFocus()` guard census
    // (W-M23S5-TWELVE-CONJUNCTS clause 3, main.wiring.test.ts) for the source-scan half.
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
    // shipping. GREEN AT FORK BY DESIGN and stays green through this slice's own
    // implementation (announcements.ts already ships the documented gap) — it exists for
    // what comes after, not for this slice's own RED state.
    const prev: A11ySnapshot = { topOverlay: 'boxView', message: '' };
    const next: A11ySnapshot = { topOverlay: null, message: '' };
    expect(announcementsFor(prev, next)).toEqual([]);
  });
});
