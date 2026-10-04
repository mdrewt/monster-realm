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
 *      overlay a11y wiring, the canvas focus target — needs the REAL seventeen views
 *      constructed against the REAL static shells. The DOM is built by parsing the REAL
 *      `client/index.html` with `DOMParser` and moving its body children into the live
 *      document via `document.adoptNode` + `replaceChildren` — never `innerHTML`
 *     . `document.adoptNode` is the spec-correct way to move a node across
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
 * HISTORY (m23-s5, then ctl-11a and ctl-11b): the original slice added a `worldHasFocus()` gate
 * on the hotkeys, a frame-loop announcement/focus-return pump and a Space guard. ctl-11b DELETED
 * `worldHasFocus`: one rule replaces it, in main.ts's keydown handler (a key whose target is an
 * element outside `#game-screen`, and not <body>, is the browser's) and in the pure
 * `ownership(target, event, screen)`. The cases below that still say "gate" name what they now
 * pin; the CTL11B-1-* cases at the end pin the outside rule itself. The frame-loop focus return
 * (<body>, or focus stranded in a hidden subtree, goes back to the canvas) is unchanged.
 *
 * Several S5T cases are regression pins that were green from the day their code landed (marked at
 * each site). `S5T-GATE-ALLOWED-CANVAS` asserts `document.activeElement` genuinely IS the canvas
 * BEFORE dispatching, so it can never pass by the canvas silently being unfocusable.
 *
 * FIX CYCLE 1. RED at this fix's fork: 6× `S5T-GATE-SAMEKEY-CLOSE`
 * and `S5T-GATE-REOPEN-AFTER-SAMEKEY-CLOSE` — the pre-amendment conjunct also gated the
 * toggle-CLOSE half, which killed same-key close for every user (the deferred focus makes
 * "focus is inside the overlay" the universal post-open state). GREEN AT FORK BY DESIGN:
 * `S5T-GATE-PRECEDENCE-DENY-WINS`, a mutation pin for the dropped-parens precedence bug.
 *
 * WRONG IMPL KILLED: recorded per test, immediately above each `it`/`it.each`.
 *
 * NO `new RegExp(...)`, no `eval`, no `new Function` (Semgrep bans them — none used here).
 * NO `innerHTML` anywhere — DOM construction is `DOMParser` + `adoptNode` +
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
import { t as i18nT } from './ui/i18n/resolver';
import { OVERLAY_A11Y, type OverlayId } from './ui/overlayRegistry';

// --- hoisted state shared with the mock factories --------------------------------------
const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  buildBugBundle: vi.fn<(input: BugBundleInput) => BugBundle>(),
  /** Every element main.ts passed to the world renderer's `init(mount)`, oldest first (ctl-7a:
   *  CTL7A-1-MAIN-MOUNT-IN-GAME-SCREEN reads which node main.ts really mounts the canvas on). */
  mounts: [] as HTMLElement[],
  /** How many times main.ts asked the connection for its live handle (`conn.live()`): every
   *  reducer call, movement intent included, goes through it first, so a key that must reach no
   *  reducer leaves this unchanged (ctl-11b, CTL11B-1-BOOT-*). */
  liveReads: 0,
  /** What the stubbed connection's `sessionState()` answers: `hidden` is the ordinary case, any other
   *  value is the session terminal, which blocks every input path. Reset to `hidden` by every
   *  boot, raised only by CTL11B-1-PIN-SESSION-GATE. */
  session: 'hidden' as string,
}));

// The wasm pkg — identical shape to main.battle-reseed.test.ts's mock (every name main.ts
// imports, plus the four other exports of the real module).
vi.mock('../../client-wasm/pkg/client_wasm.js', () => {
  const SIDE = 3;
  const grid = (v: boolean): boolean[] => Array.from({ length: SIDE * SIDE }, () => v);
  return {
    apply_move: () => ({}),
    // `-> i64` crosses as a BigInt, so the stub is `1n`, not `1`.
    deletion_grace_ms_default: () => 1n,
    move_queue_cap: () => 4,
    party_size: () => 3,
    party_slot_none: () => 255,
    max_trade_monsters_per_side: () => 64,
    talk_range: () => 2,
    // ctl-10a: named fixture change — the new interact export
    interact_candidates_coded: () => [],
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
// sessionState() reads `H.session`, which MUST stay 'hidden' (the default) or every key in this file
// is swallowed by sessionGateBlocks(); only CTL11B-1-PIN-SESSION-GATE raises it, for one test.
vi.mock('./net/connection', () => {
  const stub: Connection = {
    conn: undefined,
    live: () => {
      H.liveReads += 1;
      return undefined;
    },
    identity: () => H.identity,
    linkFrozen: () => false,
    continueAnonymously: () => undefined,
    sessionState: () => H.session as 'hidden',
    startSignIn: () => undefined,
    reconnectNow: () => undefined,
    join: () => undefined,
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
// `.focus()` on it actually moves `document.activeElement` from this test.
vi.mock('./render/world', () => {
  class WorldRenderer {
    init(mount: HTMLElement): Promise<void> {
      H.mounts.push(mount);
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
 *  `document.adoptNode`, never `innerHTML`. */
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
  // ctl-7a (named intentional change): the shipped <body> is now three children (#game-screen,
  // #build-stamp, #a11y-live), so the old `body children > 5` floor is retired. The vacuity
  // guard counts the id-bearing elements the parse yielded instead (the real shell has ~60).
  // The #game-screen wrap itself is asserted by the tagged CTL7A tests below, NOT here, so a
  // missing wrap reds those tests and not every case in this file.
  const idCount = parsed.querySelectorAll('[id]').length;
  expect(
    idCount,
    'ANTI-VACUITY: parsed index.html yielded almost no id-bearing elements — the DOM this ' +
      'whole file depends on would be empty and every test below would fail for the wrong reason',
  ).toBeGreaterThan(5);
  expect(
    bodyChildren.length,
    'ANTI-VACUITY: the <body> must have a non-script child',
  ).toBeGreaterThan(0);
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
 *  eleven static shells.
 *  `openOverlayA11y`/`closeOverlayA11y` toggle those
 *  attributes only for the FIVE `#app`-mounted CONSTRUCTED views (box/raising/evolution/
 *  battle/claim), which ship no markup ARIA of their own. For a static shell,
 *  `closest('[role="dialog"]')` is therefore non-null WHETHER THE OVERLAY IS OPEN OR
 *  CLOSED — role presence alone silently degenerates to "always true" for eleven of the
 *  seventeen overlays (this is exactly what made an earlier version of this helper produce a
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
  readonly shiftKey?: boolean;
}

// ctl-6b CTL6B.4: help is Select by physical code (Slash); e.key '?' is retired.
const HELP_KEY: KeySpec = { code: 'Slash', key: '?', shiftKey: true };

/** Dispatch one `keydown` on `target` (default `window`, the listener main.ts registers
 *  on) and return the event so callers can read `.defaultPrevented`. */
function pressKey(spec: KeySpec, target: EventTarget = window): KeyboardEvent {
  const init: KeyboardEventInit = { bubbles: true, cancelable: true };
  if (spec.code !== undefined) init.code = spec.code;
  if (spec.key !== undefined) init.key = spec.key;
  if (spec.shiftKey !== undefined) init.shiftKey = spec.shiftKey;
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
    H.session = 'hidden';
    H.mounts.length = 0;
    H.buildBugBundle.mockClear();
    buildAppShellFromRealIndexHtml();
    stubControllableRaf();
    restoreWindowAdd = recordListeners(window, recorded);
    restoreDocumentAdd = recordListeners(document, recorded);

    vi.resetModules();
    await import('./main');
    // main() awaits 17 dynamic view imports, then constructs all 17 views (renderer.init
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
    // replaceChildren, never innerHTML — the one deliberate deviation from the
    // battle-reseed precedent's `document.body.innerHTML = ''` cleanup line.
    document.body.replaceChildren();
  });

  // ---------------------------------------------------------------------------------------
  // The world-focus gate on the twelve canOpen-derived hotkey branches.
  // ---------------------------------------------------------------------------------------

  /** Three accelerator-opened overlays, round-robined: each row names the accelerator that opens
   *  it and the accelerator of the NEXT row's overlay, which replaces it.
   *
   *  ctl-11a: the world-focus gate no longer gates accelerators, and Q and E are LB and RB. The old
   *  fixture was the box/raising/evolution HIDE_SWITCH trio, picked so that the focus conjunct was
   *  the sole reason the second press was refused; with no refusal left to isolate, and the
   *  Evolution overlay with no key at all (E), the rows are the three accelerators that open an
   *  overlay with its own focus anchor: B (Monsters), I (Bag) and J (Journal). Each press pops to
   *  the base and opens the menu path, so every overlay here sits above `menuView`. */
  const DRIVABLE_OVERLAYS: ReadonlyArray<{
    readonly id: OverlayId;
    readonly openKey: KeySpec;
    readonly replacedById: OverlayId;
    readonly replacedByKey: KeySpec;
  }> = [
    {
      id: 'boxView',
      openKey: { code: 'KeyB' },
      replacedById: 'raisingView',
      replacedByKey: { code: 'KeyI' },
    },
    {
      id: 'raisingView',
      openKey: { code: 'KeyI' },
      replacedById: 'questLogView',
      replacedByKey: { code: 'KeyJ' },
    },
    {
      id: 'questLogView',
      openKey: { code: 'KeyJ' },
      replacedById: 'boxView',
      replacedByKey: { code: 'KeyB' },
    },
  ];

  /** `openOverlayIds()` in a fixed order, so a whole-set check does not depend on the registry's
   *  declaration order (the main menu is open beneath every accelerator-opened overlay). */
  const openOverlayIdsSorted = (): OverlayId[] => [...openOverlayIds()].sort();
  const sortedIds = (...ids: OverlayId[]): OverlayId[] => [...ids].sort();

  it('overlayIsOpen() sanity: reads false for a never-opened STATIC shell (helpView) AND a never-opened CONSTRUCTED shell (boxView)', () => {
    // ANTI-VACUITY FOR EVERY GATE/ANNOUNCE/FOCUS TEST IN THIS FILE. A helper that has
    // degenerated back to "role presence alone" (see overlayIsOpen's own doc comment — this
    // is the EXACT shape of a bug this suite shipped once) would read TRUE here for
    // helpView even though nothing has ever opened it, which would make every
    // `expect(overlayIsOpen(id)).toBe(false)` in S5T-GATE-REPLACED (ctl-11a: was S5T-GATE-BLOCKED)
    // pass vacuously, whatever the replace did.
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
  )('S5T-GATE-REPLACED ($id open with focus inside it; the $replacedById accelerator ignores the world-focus gate and replaces it)', async ({
    id,
    openKey,
    replacedById,
    replacedByKey,
  }) => {
    // ctl-11a: this was S5T-GATE-BLOCKED ("the second hotkey opens nothing"). An accelerator is no
    // longer gated on the world focus and replaces whatever screen is open, so the same state
    // (focus genuinely inside the open overlay) now proves the opposite: the second accelerator
    // opens its overlay, the first one closes, and the main menu stays beneath the new one.
    // WRONG IMPL KILLED: the `&& worldHasFocus()` conjunct (or any focus test) left on an
    // accelerator, so with focus inside the open overlay the second press is refused; a refusal
    // for an open player screen (the old mutual-exclusivity guard), which leaves $id open; a
    // replace that opens $replacedById without closing $id (two screens at once); and a replace
    // that drops the menu beneath it.
    pressKey(openKey);
    expect(overlayIsOpen(id), `${id} must be open after its own hotkey`).toBe(true);
    const anchor = overlayFocusAnchor(id);
    expect(anchor, `${id}'s initialFocusSelector anchor must resolve`).not.toBeNull();
    // Let the REAL setTimeout(0) deferred-focus macrotask fire, so
    // focus is genuinely INSIDE the overlay — the A11Y-19 precondition, not merely open.
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );
    pressKey(replacedByKey);
    expect(overlayIsOpen(replacedById), `${replacedById} must have opened`).toBe(true);
    expect(overlayIsOpen(id), `${id} must be replaced (closed)`).toBe(false);
    expect(
      openOverlayIdsSorted(),
      `${replacedById} alone, over the menu it was opened through`,
    ).toEqual(sortedIds(replacedById, 'menuView'));
  });

  it('S5T-GATE-ACCEL-IGNORES-FOCUS: an accelerator pressed at a focused visible control opens its screen without stealing focus, while a letter at a focused text field is typed and opens nothing', () => {
    // ctl-11a: the focus gate is gone for accelerators; what protects a typist is key ownership
    // (the focused field keeps every letter but Escape and Enter), and what protects a button's
    // own activation is that it owns only Space and Enter.
    // WRONG IMPL KILLED: an accelerator that still reads `document.activeElement` (the press at the
    // focused Start chip is swallowed), one that runs the heal unconditionally (focus is yanked to
    // the canvas on every press), a text-field check that is missing (B typed into a field opens
    // Monsters), and one that prevents the default of a letter the field owns (the letter never
    // reaches the field).
    const chip = document.getElementById('chip-start') as HTMLElement | null;
    expect(chip, '#chip-start must exist (client/index.html)').not.toBeNull();
    chip!.focus();
    expect(document.activeElement, 'anti-vacuity: the chip really is focusable').toBe(chip);
    const atChip = pressKey({ code: 'KeyB' }, chip!);
    expect(atChip.defaultPrevented, 'B at a focused button is an accelerator, consumed').toBe(true);
    expect(overlayIsOpen('boxView'), 'B opens Monsters though a visible control has focus').toBe(
      true,
    );
    expect(openOverlayIdsSorted(), 'over the menu').toEqual(sortedIds('boxView', 'menuView'));
    expect(document.activeElement, 'and steals no focus from the chip (nothing healed)').toBe(chip);
    pressKey({ code: 'KeyB' }, chip!); // its own key: Start, back to the bare world for the field arm
    expect(openOverlayIdsSorted(), 'precondition: B again closed the screen and the menu').toEqual(
      [],
    );

    // ctl-11b (named intentional change): the field now lives INSIDE #game-screen. Appended to
    // <body> (outside the screen) every key would be the browser's by the new outside rule, and
    // this arm would no longer exercise the field-ownership rule it is about (CTL11B-1-BOOT-OUTSIDE
    // pins the outside rule). Inside the screen only `ownership` keeps the letters in the field.
    const gameScreen = document.getElementById('game-screen');
    expect(gameScreen, '#game-screen must exist (client/index.html)').not.toBeNull();
    const field = document.createElement('input');
    field.type = 'text';
    gameScreen!.appendChild(field);
    field.focus();
    expect(document.activeElement, 'precondition: the text field has focus').toBe(field);
    for (const code of ['KeyB', 'KeyI', 'KeyJ', 'KeyU', 'KeyN']) {
      const typed = pressKey({ code }, field);
      expect(typed.defaultPrevented, `${code} typed in a field is left to the field`).toBe(false);
      expect(openOverlayIds(), `${code} typed in a field opens nothing`).toEqual([]);
      expect(document.activeElement, `${code}: the field keeps focus`).toBe(field);
    }
  });

  it.each(
    DRIVABLE_OVERLAYS,
  )('S5T-GATE-ALLOWED-BODY ($id opens from <body> focus, the pre-milestone behaviour)', ({
    id,
    openKey,
  }) => {
    // ctl-11a: rows are now B, I and J (E has no key). A regression pin that the accelerators
    // open from a fresh page (focus on <body>; <body> is never "outside the game screen",
    // CTL11B-1-OWN-BODY / CTL11B-1-BOOT-INSIDE-ROUTES).
    // WRONG IMPL KILLED: an accelerator that stays dead from a fresh page load (a focus or
    // target test that treats <body> as foreign), and an inverted test that opens only while
    // focus is inside some other overlay, exactly backwards.
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);
    pressKey(openKey);
    expect(overlayIsOpen(id)).toBe(true);
  });

  it('S5T-GATE-ALLOWED-CANVAS: a hotkey still opens its overlay when the world CANVAS has focus', () => {
    // ctl-11b: with `worldHasFocus` deleted, nothing reads the world focus any more: the canvas is
    // inside #game-screen, so a key at it is the router's (CTL11B-1-BOOT-INSIDE-ROUTES pins the
    // same for B). What this keeps is the keyboard/AT user who Tabs onto the canvas: an accelerator
    // and Start must both still work there. The canvas-has-focus precondition is asserted BEFORE
    // dispatching, never inferred from the outcome, so the test can never pass by the canvas
    // silently being unfocusable.
    // WRONG IMPL KILLED: an outside rule or focus test that treats the canvas as foreign (every key
    // dies the first time a player Tabs to it).
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
    pressKey({ code: 'KeyJ' }); // questLogView — deliberately outside the DRIVABLE_OVERLAYS trio
    expect(overlayIsOpen('questLogView')).toBe(true);

    // The Start half: with focus on the canvas Start must open the menu too.
    pressKey({ code: 'KeyJ' }); // its own key: Start, back to the bare world
    expect(openOverlayIds(), 'precondition: J again closed the Journal and the menu').toEqual([]);
    canvas!.focus();
    expect(document.activeElement, 'the canvas must hold focus again').toBe(canvas);
    pressKey({ code: 'KeyM' }); // Start at the world: opens the main menu
    expect(overlayIsOpen('menuView'), 'Start opens the menu with the canvas focused').toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // A11Y-19 / ADR-0206 Amendment A1 (historical: the world-focus gate it amended is deleted, ctl-11b).
  // What survives is the behaviour: a same-key press on an already-open overlay closes it with
  // focus already inside it, and nothing is left stranded. This is the unit-tier encoding of the
  // three e2e regressions — e2e/movement-input.spec.ts:493 (KeyB closes the box under a held key),
  // e2e/trade.spec.ts:97 (KeyU toggle-close) and the e2e/pvp.spec.ts:145 cascade (a cleanup close
  // that fails leaves the box open for the next test). Those three run only in the remote e2e job;
  // these run in `just test`.
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
  // ctl-11a: the Evolution row is gone (E has no key) and the Journal's key is J. Every accelerator
  // row opens over the main menu (`beneath`), and a second press of its own key acts as Start, which
  // closes the screen AND the menu beneath it. Help is Select, not an accelerator: it opens alone
  // and toggles.
  const SAMEKEY_OVERLAYS: ReadonlyArray<{
    readonly id: OverlayId;
    readonly openKey: KeySpec;
    readonly beneath: readonly OverlayId[];
  }> = [
    { id: 'boxView', openKey: { code: 'KeyB' }, beneath: ['menuView'] },
    { id: 'raisingView', openKey: { code: 'KeyI' }, beneath: ['menuView'] },
    { id: 'questLogView', openKey: { code: 'KeyJ' }, beneath: ['menuView'] },
    { id: 'tradeView', openKey: { code: 'KeyU' }, beneath: ['menuView'] },
    { id: 'helpView', openKey: HELP_KEY, beneath: [] },
  ];

  it.each(
    SAMEKEY_OVERLAYS,
  )('S5T-GATE-SAMEKEY-CLOSE ($id closes on a second press of its OWN key (an accelerator acts as Start and closes the menu under it too; help toggles), with focus already inside it)', async ({
    id,
    openKey,
    beneath,
  }) => {
    // ctl-11a: was "toggle-CLOSES": an accelerator's own key is now Start (pop to the base), so the
    // whole-set checks name the menu that opened beneath the screen, and the close takes it too.
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
    expect(
      openOverlayIdsSorted(),
      `${id} must be the ONLY overlay open at this point (over the menu it was opened through)`,
    ).toEqual(sortedIds(id, ...beneath));

    // Let the REAL setTimeout(0) deferred-focus macrotask fire, so
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

  it.each([
    {
      name: 'help: Select toggles it, nothing beneath',
      openKey: HELP_KEY,
      id: 'helpView' as OverlayId,
    },
    {
      name: 'box: B acts as Start over the menu beneath it',
      openKey: { code: 'KeyB' },
      id: 'boxView' as OverlayId,
    },
  ])('S5T-GATE-REOPEN-AFTER-SAMEKEY-CLOSE ($name): after an own-key close, focus leaves the overlay and a DIFFERENT key (Start) opens again (the pvp.spec.ts:145 cascade)', async ({
    openKey,
    id,
  }) => {
    // ctl-11a: the "different hotkey" is Start (M), not the Journal. The box arm closes through
    // Start (B over its own screen), which takes the menu beneath it too; the help arm has no menu.
    // Both keep the exact <body> assertion of the original case.
    // The e2e/pvp.spec.ts:145 shape, at the unit tier: a serial spec's cleanup close fails, so
    // the screen is STILL OPEN when the next test presses its own hotkey.
    //
    // WRONG IMPL KILLED (1): a close that is blocked (the screen stays open across serial specs).
    // WRONG IMPL KILLED (2) ★ the one no other test in this file sees: a close that leaves focus
    //   TRAPPED inside a former overlay root (e.g. a menu hidden beneath it that is then
    //   re-focused), or never closes through closeOverlayA11y. Focus stranded in a hidden subtree
    //   is what the keydown heal and the frame-loop focus return exist for, and the focus
    //   assertion below pins the close itself: focus is back on <body>, so the final Start
    //   assertion proves the key works from the page, not that something healed it.
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);

    pressKey(openKey);
    expect(overlayIsOpen(id), `${id} must be open after its key`).toBe(true);
    const anchor = overlayFocusAnchor(id);
    expect(anchor, `${id}'s initialFocusSelector anchor must resolve`).not.toBeNull();
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );

    pressKey(openKey); // the cleanup close every serial e2e spec performs
    expect(
      overlayIsOpen(id),
      `${id} must be CLOSED by the second press — a blocked cleanup close is what left the ` +
        'screen open across e2e/pvp.spec.ts serial tests',
    ).toBe(false);
    expect(openOverlayIds(), 'nothing at all is left open').toEqual([]);
    expect(
      document.activeElement,
      'after the close, focus must be back on <body> — closeOverlayA11y restores the captured ' +
        'returnFocus. If focus is still inside the closed overlay (or the hidden menu that was ' +
        'beneath it), it is stranded in a hidden subtree until the next keydown heals it',
    ).toBe(document.body);

    pressKey({ code: 'KeyM' }); // Start at the world: the cascade's victim
    expect(
      overlayIsOpen('menuView'),
      'Start must open the menu after the screen was closed — this is the pvp.spec.ts:145 ' +
        'cascade: a close that leaves the screen open or strands focus is reported against ' +
        'the NEXT feature, not against the close',
    ).toBe(true);
    expect(openOverlayIds(), 'the menu must be the only overlay open').toEqual(['menuView']);
  });

  it('S5T-GATE-PRECEDENCE-DENY-WINS: a DENIED verdict still refuses the open even when focus is on the page', () => {
    // ctl-11b: `worldHasFocus` (and the `|| worldHasFocus()` precedence mutant this case was written
    // for) no longer exists. What it still pins is the verdict itself: `canOpen('helpView')` is DENY
    // over a visible GUARD_ONLY overlay, and no focus state may bypass a DENY. It is still this
    // file's only test that presses a denied open with focus on <body>, which is the state in which
    // any reintroduced focus-based bypass (`allow || <focus on the page>`) would fire.
    // WRONG IMPL KILLED: a verdict bypass keyed to focus on <body>, whose blast radius is the whole
    // mutual-exclusion contract: with the page focused, ANY hotkey would open its overlay over a live
    // battle (EXCLUSIVE_TOP) or a live NPC dialogue (GUARD_ONLY, where a client-side stack strands
    // the server player_conversation row, ptc5c/ADR-0139).
    // NO deferred-focus await here, and it is load-bearing: the second press must happen while
    // `document.activeElement` is STILL <body>, so the state is the one a bypass would fire in; that
    // is ASSERTED, never assumed. (The same "no intervening await" property S5T-ANNOUNCE-TOP relies
    // on; see this file's header, DETERMINISM NOTE ON FOCUS TIMING.)
    // ctl-11a: the Journal is opened by J (Q is LB now), over the main menu it is opened through, so
    // the whole-set checks below name `menuView` too (the menu never denies another open).
    pressKey({ code: 'KeyJ' }); // questLogView — GUARD_ONLY, opened from <body>
    expect(overlayIsOpen('questLogView'), 'questLogView must be open after KeyJ').toBe(true);
    expect(
      document.activeElement,
      'precondition: the deferred focus has NOT fired yet, so focus is still on the page for the ' +
        'press below — without this a focus-keyed bypass cannot fire and this test would prove ' +
        'nothing',
    ).toBe(document.body);

    pressKey(HELP_KEY); // helpView — its verdict is DENY over a visible GUARD_ONLY overlay
    expect(
      overlayIsOpen('helpView'),
      'helpView must NOT open over the quest log: `canOpen` denies over a GUARD_ONLY overlay, ' +
        'and the self-open disjunct must be a PARENTHESISED operand of the verdict conjunct — ' +
        'no focus state may bypass the verdict',
    ).toBe(false);
    expect(
      openOverlayIdsSorted(),
      'the quest log (over its menu) must remain the only screen open, unchanged',
    ).toEqual(sortedIds('questLogView', 'menuView'));
  });

  // ---------------------------------------------------------------------------------------
  // <body> focus — a force-hidden focused control blurs to <body>, and hotkeys must not die
  // forever afterward (ctl-11b: <body> is never "outside the game screen").
  // ---------------------------------------------------------------------------------------

  it('S5T-BODY-BLUR: an overlay hidden out from under a focused control blurs to <body>, and a DIFFERENT hotkey still opens afterward', async () => {
    // WRONG IMPL KILLED: a key rule that treats focus on <body> as foreign —
    // every hotkey stays dead from this point forward for the rest of the session, exactly
    // the "dead hotkeys forever after a dialogue ends" bug spec §2.3 names. The real trigger
    // is the M12d `store.onBatchApplied` dialogue listener,
    // which calls `dialogueView?.render(dialogueVm)` on EVERY batch — `dialogueVm` is
    // null once the conversation row is gone, and `render`'s `!vm` branch display:nones the
    // overlay, blurring a focused choice <button> the same way this test does on renameView.
    pressKey({ code: 'KeyN' }); // renameView — GUARD_ONLY, no identity requirement
    // Flush the REAL setTimeout(0) deferred-focus macrotask before
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
    // explicitly so this test proves the <body> case, never happy-dom's layout fidelity.
    document.body.focus();
    expect(document.activeElement, 'precondition: focus fell back to <body>').toBe(document.body);
    pressKey(HELP_KEY); // a DIFFERENT overlay's hotkey — proves the fix is general
    expect(overlayIsOpen('helpView')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------
  // The frame-loop announcer.
  // ---------------------------------------------------------------------------------------

  it('S5T-ANNOUNCE-WORLD: closing the last overlay announces the world-region name, resolved through the a11yCopy catalog', () => {
    // WRONG IMPL KILLED (1): the pump never wired at all (S1's named cliff — nothing in S1-S4
    // reds if it is never wired, and the live region is then permanently silent).
    // WRONG IMPL KILLED (2): `liveRegion.flush(0)` (or any other CONSTANT argument) — with a
    // constant, `now - windowOpenedAt` is identically 0 forever and the region never paints
    // again, which is behaviourally identical to (1) but survives a naive containment scan for
    // `liveRegion.flush(`.
    pressKey(HELP_KEY); // open helpView from <body>
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
  // Space is not stolen from the (now-native-button) #help-hint, and still jumps
  // from the world.
  // ---------------------------------------------------------------------------------------

  it('S5T-SPACE-BUTTON: Space on the focused #chip-start button is NOT preventDefault-ed', () => {
    // ctl-7a (named intentional change): this case focused #help-hint, which ctl-7a deletes from
    // index.html; the Start chip is the world's always-on native <button> that replaces it, so
    // the case is retargeted (the behaviour under test is unchanged).
    // WRONG IMPL KILLED: shipping the chip as a native <button> WITHOUT the
    // `targetOwnsKey(e)` guard on the terminal Space branch — A11Y-23's activation half
    // ships silently dead (Enter-only), invisible to every source scan (main.ts is
    // coverage-excluded, client/vite.config.ts:97).
    const chip = document.getElementById('chip-start') as HTMLElement | null;
    expect(chip, '#chip-start must exist (client/index.html)').not.toBeNull();
    chip!.focus();
    // dispatch ON THE BUTTON (not window) so it bubbles and e.target is the button.
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    chip!.dispatchEvent(event);
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
    // done" (plan anti-pattern 13) — `fallbackFocus` is UNREACHABLE on this
    // exact path: `record.returnFocus` (captured as document.body at open time) is always
    // connected, so closeOverlayA11y's restore-order picks it FIRST and fallbackFocus is
    // never consulted. Only a frame-loop-owned focus return (S5's own edge) can move focus
    // from body to the canvas; this test fails on any implementation that skips that edge.
    pressKey(HELP_KEY); // helpView opens from <body>
    runFrame(0);
    pressKey({ code: 'Escape' }); // closeOverlayA11y restores focus to <body> (returnFocus)
    expect(document.activeElement, 'closeOverlayA11y restores to <body> here').toBe(document.body);
    runFrame(600); // the topOverlay->null edge: focus is on <body> -> canvas.focus()
    const canvas = document.getElementById('app')?.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(document.activeElement).toBe(canvas);
  });

  it('S5T-FOCUS-RETURN-STALE: the close-edge focus return fires even when focus is STRANDED inside the just-hidden overlay (the Chromium async-blur window)', async () => {
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
    // WRONG IMPL KILLED (1) ★ THE DEFECT: the close edge testing only `a === null || a === <body>`
    //   (no hidden-subtree walk). Focus never returns to the world region on ANY close where focus was inside the
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
    //   spellings return true). S5T-FOCUS-NO-STEAL is the tooth that kills it — STRENGTHENED
    //   in this same fix cycle to actually arm the edge (a `runFrame(0)` between its click-open
    //   and its Escape-close): before that, its single frame ran AFTER the menu had already
    //   closed, `lastA11ySnapshot.topOverlay` was still `null`, the outer edge predicate was
    //   FALSE, and the guarded branch was never entered — it killed no mutant of this guard.
    //   Recorded here rather than glossed, because a WRONG IMPL KILLED list that names a tooth
    //   which does not actually kill is worse than one that says nothing.
    // WRONG IMPL KILLED (3): a discriminator that checks only the ACTIVE ELEMENT's own style
    //   (`document.activeElement.style.display === 'none'`) and not its ancestors. The anchor
    //   carries `tabindex="-1"` and NO inline display at all (client/index.html) — only the
    //   overlay ROOT is display:none — so it reads false and the stale window stands. This test
    //   reds on it exactly as it reds on (1); the ancestor walk is the whole mechanism.
    pressKey(HELP_KEY); // helpView opens from <body>, the pre-milestone path
    expect(overlayIsOpen('helpView'), 'helpView must be open after `?`').toBe(true);
    runFrame(0); // registers 'helpView' as lastA11ySnapshot.topOverlay — arms the close edge

    // Let the REAL setTimeout(0) deferred focus land INSIDE the overlay.
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

    pressKey(HELP_KEY); // the A1 same-key toggle-CLOSE — one of the three measured e2e paths
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
      'the close edge must return focus to the world canvas even though activeElement reads ' +
        'a STALE anchor inside the hidden overlay — otherwise focus stays stranded for ' +
        "the whole of Chromium's async-blur window (~200 ms), which is what killed " +
        'e2e/trade.spec.ts:115 and e2e/pvp.spec.ts:106. The frame heals it in ONE rAF tick, ' +
        'deterministically, instead of waiting on an engine fixup that may never come',
    ).toBe(canvas);
  });

  it('S5T-GATE-HEALS-STALE-FOCUS: a hotkey pressed INSIDE the stale-focus window heals first and opens — and a press while a VISIBLE control has focus heals nothing', async () => {
    // TWO PHASES, in this order on purpose. Phase 1 is the NEGATIVE (the heal must not fire
    // when a visible control holds focus). Phase 2 is the POSITIVE (the heal fires when focus is
    // stranded inside a hidden subtree).
    //
    // ctl-11b: with `worldHasFocus` deleted, a press inside the stale-focus window opens its screen
    // whether or not the heal ran, so the OPEN assertion in Phase 2 no longer discriminates. The
    // assertion that bites is the SYNCHRONOUS `document.activeElement === canvas` one: it is the
    // only thing that fails without the heal. The mutants below are killed by it, not by the open.
    //
    // WRONG IMPL KILLED (a) ★ THE DEFECT (Phase 2): no heal at the consumer. The frame-edge repair
    //   (S5T-FOCUS-RETURN-STALE) restores focus at the NEXT rAF; a press that arrives inside that
    //   <=1-frame window would leave focus stranded in the hidden overlay (e2e/pvp.spec.ts:117's
    //   flake), and no frame-side fix can close it: the press beat the frame.
    // WRONG IMPL KILLED (b): the heal placed BELOW a branch that returns. Every keydown branch ends
    //   in `return;`, so the heal would be dead code for the very press it exists to repair, and the
    //   canvas assertion reds exactly as it does for (a): the heal must sit above every returning
    //   branch.
    // WRONG IMPL KILLED (c): an UNCONDITIONAL `worldCanvasEl?.focus();` with no
    //   `focusInsideHiddenSubtree()` guard. It would yank focus to the canvas on EVERY keypress,
    //   including one pressed while the player is on the always-on Start chip — a focus theft.
    //   Phase 1 kills it directly: with the mutant the heal fires and focus is on the canvas, so the
    //   "focus stays on the chip" assertion fails. (S5T-FOCUS-NO-STEAL also kills it, indirectly.)
    // WRONG IMPL KILLED (d): a heal that focuses <body> instead of the world region. Phase 2's
    //   canvas assertion is what distinguishes them; only the canvas satisfies ADR-0206 D4's "focus
    //   returns to the world region", which is the thing an AT actually announces.

    // ---- PHASE 1 — NEGATIVE: a VISIBLE control holds focus, so nothing is healed ----------
    expect(document.activeElement, 'precondition: body is focused at boot').toBe(document.body);
    // ctl-7a (named intentional change): the visible focusable control outside every overlay was
    // #help-hint (deleted); it is now the Start chip, #chip-start — same role, same assertions.
    const helpHint = document.getElementById('chip-start') as HTMLElement | null;
    expect(helpHint, '#chip-start must exist (client/index.html)').not.toBeNull();
    helpHint!.focus();
    expect(document.activeElement, 'anti-vacuity: the chip really is focusable').toBe(helpHint);

    // ctl-11b (named intentional change): this arm used to assert that Select does NOT open help
    // while a visible control holds focus (the `worldHasFocus()` conjunct). That conjunct is deleted:
    // the chip is INSIDE #game-screen, where the router owns the key, so Select now opens help with
    // the chip focused. The retired refusal's survivors are `router.test.ts` CTL11B-1-OWN-OUTSIDE
    // (an element outside the game screen owns every key) and `main.a11yFocus.test.ts`
    // CTL11B-1-BOOT-OUTSIDE (focus outside the screen: nothing opens). What stays here is the half
    // that was never about the gate: the press must not HEAL focus (no steal) while a visible
    // control holds it.
    pressKey(HELP_KEY);
    expect(
      overlayIsOpen('helpView'),
      'Select opens help with a control INSIDE the game screen focused (no world-focus gate)',
    ).toBe(true);
    expect(
      document.activeElement,
      'the heal must NOT fire while a visible control has focus — the badge is displayed, so ' +
        'the ancestor walk finds no display:none and the guard is false. An UNCONDITIONAL ' +
        'focus() here steals the player`s place on every single keypress',
    ).toBe(helpHint);
    pressKey({ code: 'Escape' }); // Start pops help, so Phase 2 starts from a bare world
    expect(overlayIsOpen('helpView'), 'precondition: Start closed help again').toBe(false);

    // ---- PHASE 2 — POSITIVE: focus stranded inside a hidden subtree, and NO frame runs -----
    document.body.focus();
    expect(document.activeElement, 'reset: back to the world before the real scenario').toBe(
      document.body,
    );

    pressKey(HELP_KEY); // helpView opens from <body>
    expect(overlayIsOpen('helpView'), 'helpView must be open after `?`').toBe(true);

    // Let the REAL setTimeout(0) deferred focus land INSIDE the overlay — the A11Y-19 post-open
    // state, and the precondition for the close producing a stale window at all.
    const anchor = overlayFocusAnchor('helpView');
    expect(anchor, "helpView's initialFocusSelector anchor must resolve").not.toBeNull();
    await vi.waitFor(
      () => {
        expect(document.activeElement).toBe(anchor);
      },
      { timeout: 2_000, interval: 5 },
    );

    pressKey(HELP_KEY); // the A1 same-key toggle-CLOSE
    expect(overlayIsOpen('helpView'), 'helpView must be CLOSED by the second `?` (A1)').toBe(false);

    // RE-CREATE THE CHROMIUM STALE STATE (identical to S5T-FOCUS-RETURN-STALE's, and asserted
    // in both halves for the same reason): happy-dom's `closeOverlayA11y` restore to <body>
    // SUCCEEDS, where Chromium's is a no-op because <body> has no tabindex — so the state must
    // be re-created explicitly here. happy-dom permits focusing inside a display:none subtree
    // (it runs no layout), which is what makes it an exact simulator for the window.
    const overlayRoot = document.getElementById('help-overlay');
    expect(overlayRoot, '#help-overlay must exist (client/index.html)').not.toBeNull();
    expect(
      overlayRoot!.style.display,
      'precondition: the overlay root really is display:none — the ancestor the walk must find',
    ).toBe('none');
    anchor!.focus();
    expect(
      document.activeElement,
      'precondition: focus is STRANDED on the anchor inside the hidden subtree — the exact ' +
        'observable Chromium presents for up to ~200 ms after a close',
    ).toBe(anchor);

    const canvas = document.getElementById('app')?.querySelector('canvas') ?? null;
    expect(
      canvas,
      'the mocked WorldRenderer.init must have appended a <canvas> to #app',
    ).not.toBeNull();

    // ⚠ NO runFrame() ANYWHERE IN THIS TEST. The residual defect is a press that lands BEFORE
    // the first rAF after the close, so running a frame here would repair the state through the
    // OTHER mechanism (S5T-FOCUS-RETURN-STALE's) and this test would pass without the heal.
    pressKey({ code: 'KeyM' }); // Start: any key would do, it only has to reach the handler

    // The press is not swallowed (the e2e flake this case encodes). ctl-11b: this holds with or
    // without the heal, so it is a regression pin, not the criterion's discriminator.
    expect(
      overlayIsOpen('menuView'),
      'KeyM must OPEN the main menu even though it was pressed inside the stale-focus window, ' +
        'before any frame ran (measured as a 1-in-3 flake at e2e/pvp.spec.ts:117)',
    ).toBe(true);

    // THE ASSERTION THAT BITES: the heal moved focus to the WORLD REGION specifically, not merely
    // somewhere neutral. IT IS ONLY VALID BECAUSE NO `await` SEPARATES IT FROM THE PRESS: openMenu
    // -> openOverlayA11y schedules its initial focus on a setTimeout(0) macrotask, so
    // synchronously after the dispatch the canvas is still the active element. An intervening
    // await would let that timer fire and move focus to `#menu-rows`, and this assertion
    // would then be measuring the overlay's own deferred focus rather than the heal.
    expect(
      document.activeElement,
      'the heal must move focus to the world canvas (ADR-0206 D4), synchronously, before the ' +
        'key is handled. If this reads `#menu-rows`, an await crept in above and the ' +
        "overlay's own deferred focus fired; if it reads the stale anchor, the heal never ran; " +
        'if it reads <body>, the heal targeted the wrong node',
    ).toBe(canvas);
  });

  it('S5T-FOCUS-NO-STEAL: closing an overlay opened by CLICK does not steal focus from the badge', () => {
    // WRONG IMPL KILLED: an UNGUARDED `worldCanvasEl?.focus()` on the frame's close edge —
    // it would yank focus away from #help-hint the instant the menu closes, even though the
    // player never left the world via a hotkey at all (they clicked the badge). ADR-0206 D4's
    // whole point is that this branch must only act when focus is on <body> or stranded in a hidden
    // subtree (ctl-11b: the guard is now `a === null || a === <body> || focusInsideHiddenSubtree()`),
    // which is false here.
    // ctl-7a (named intentional change): the badge #help-hint is deleted; the Start chip,
    // #chip-start, is the click-opened front door ([data-menu-launcher]) that replaces it.
    const helpHint = document.getElementById('chip-start') as HTMLElement | null;
    expect(helpHint).not.toBeNull();
    helpHint!.focus();
    expect(document.activeElement, 'anti-vacuity: the chip really is focusable').toBe(helpHint);
    helpHint!.click(); // the delegated [data-menu-launcher] front door — opens menuView
    expect(overlayIsOpen('menuView'), 'menuView must have opened from the click').toBe(true);
    // without this frame the snapshot never registers 'menuView', lastA11ySnapshot.topOverlay
    // is still null at the final frame, the outer edge predicate is FALSE, and the guarded
    // branch was never entered at all — this test killed no mutant of the close-edge guard.
    // Arming the edge makes it the tooth that proves the stale-focus discriminator does not
    // treat the VISIBLE position:fixed badge as hidden (killing an `offsetParent === null`
    // spelling outright).
    runFrame(0); // registers 'menuView' as lastA11ySnapshot.topOverlay — ARMS the close edge
    pressKey({ code: 'Escape' }); // the menu-nav intercept routes Escape to a close at the top level
    expect(overlayIsOpen('menuView'), 'menuView must have closed via Escape').toBe(false);
    runFrame(600); // NOW this really is the topOverlay -> null edge
    expect(document.activeElement, 'focus must still be on the badge, not stolen').toBe(helpHint);
  });

  // ---------------------------------------------------------------------------------------
  // The post-evolve reveal banner's announce + focus-return sinks, driven
  // through the REAL AuthoritativeStore instance main.ts constructed: `opts.store` (captured
  // from the mocked `./net/connection`'s `ConnectionOptions.store` field, `connection.ts:82`)
  // IS the exact module-scope `store` main.ts reads inside its own `store.onBatchApplied(`
  // listener (`main.ts` — `const store = new AuthoritativeStore(STEP_MS);`, then `store,` is
  // handed to `connect({ … })` verbatim). Calling `opts.store.reconcileEvolutionNoticesFromView(`
  // + `opts.store.flushBatch()` therefore drives main.ts's REAL listener synchronously, with no
  // need for the mocked connection to ever deliver a row itself — the seam this whole file's
  // other tests have no reason to reach for.
  //
  //
  // ---------------------------------------------------------------------------------------

  /** One `StorePendingEvolutionNotice` row for `H.identity`, `entries` given verbatim (the
   *  `my_pending_evolution_notices` view is an Option projection — at most one row, the
   *  caller's own). Mirrors `reconcileEvolutionNoticesFromView`'s own "empty entries, row
   *  present" post-dismissal shape (net/store.ts) rather than clearing the slot outright. */
  function seedEvolutionNotices(
    entries: ReadonlyArray<{
      readonly monsterId: bigint;
      readonly fromSpecies: number;
      readonly toSpecies: number;
      readonly evolvedAtMs: bigint;
    }>,
  ): void {
    opts.store.reconcileEvolutionNoticesFromView([{ ownerIdentity: H.identity, entries }]);
  }

  function evolutionOkBtn(): HTMLButtonElement | null {
    return document.getElementById('evolution-notice-ok') as HTMLButtonElement | null;
  }

  function worldCanvas(): Element | null {
    return document.getElementById('app')?.querySelector('canvas') ?? null;
  }

  it('RB125-RT-ANNOUNCE BITES: the exact reveal sentence paints in #a11y-live only after its 500ms coalescing window, timed by performance.now() — never Date.now()', () => {
    // WRONG IMPL KILLED (a) ★ THE MISSING SINK: the banner never calls
    //   `liveRegion.announce(` at all, so `#a11y-live` never receives the sentence no matter how
    //   long this test waits.
    // WRONG IMPL KILLED (b) ★ A Date.now() CLOCK: this test stubs ONLY `performance.now()`
    //   (exactly what `runFrame` itself stubs, and what a correct sink must read) — a sink
    //   spelled `liveRegion.announce(m, Date.now())` opens its coalescing window at the REAL
    //   wall-clock millisecond, which is not `t`, so `runFrame(t + 600)` below (`t + 600` on the
    //   STUBBED clock) can never reach 500ms past that real window and the final assertion
    //   fails — this is the runtime half of `W-RB125-ANNOUNCE-SINK`'s source-side pin.
    // WRONG IMPL KILLED (c): a second, direct write to `#a11y-live` bypassing LiveRegion's
    //   coalescing (e.g. `document.getElementById('a11y-live').textContent = label` inside the
    //   listener) — the sentence would appear immediately after the batch, failing the FIRST
    //   assertion below (it must NOT appear before the window elapses).
    const t = 10_000;
    // fromSpecies 1 -> toSpecies 5, no monster/species rows seeded at all: the anonymous,
    // no-name-loaded fallback branch — 'Your Species #1 evolved into Species #5!' (the EXACT
    // en copy: catalog.en.ts's `evolutionNotice.reveal.anonymous` + `.species.fallback`).
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(t);
    seedEvolutionNotices([{ monsterId: 1n, fromSpecies: 1, toSpecies: 5, evolvedAtMs: 0n }]);
    opts.store.flushBatch();
    nowSpy.mockRestore();

    const region = document.getElementById('a11y-live');
    expect(region, '#a11y-live must exist (client/index.html)').not.toBeNull();

    runFrame(t);
    expect(
      region!.textContent,
      'the reveal sentence must NOT paint before its 500ms coalescing window has elapsed',
    ).not.toBe('Your Species #1 evolved into Species #5!');

    runFrame(t + 600);
    expect(
      region!.textContent,
      'RED AT AUTHORING TIME: no sink exists yet, so this can never be exactly the reveal ' +
        'sentence, timed on the stubbed performance.now() clock',
    ).toBe('Your Species #1 evolved into Species #5!');
  });

  it('RB125-RT-FOCUS BITES: hiding the reveal after its OK button held focus returns focus to the world canvas', () => {
    // WRONG IMPL KILLED (a) ★ THE MISSING SINK: `render(null)` never
    //   calls `returnFocus()`, so a keyboard player who acked the reveal from its OK button is
    //   stranded on a now-hidden, unreachable control — happy-dom does not auto-blur a focused
    //   node inside a `display:none` subtree (see this file's own S5T-FOCUS-RETURN-STALE
    //   header), so `document.activeElement` stays on the dead button forever without the fix.
    // WRONG IMPL KILLED (b): a `returnFocus` wired to `document.body.focus()` instead of the
    //   canvas — this assertion reads the canvas specifically (ADR-0206 D4's "the world
    //   region"), not merely "somewhere neutral".
    seedEvolutionNotices([{ monsterId: 2n, fromSpecies: 1, toSpecies: 5, evolvedAtMs: 0n }]);
    opts.store.flushBatch();

    const ok = evolutionOkBtn();
    expect(ok, '#evolution-notice-ok must exist once the reveal has rendered').not.toBeNull();
    ok!.focus();
    expect(document.activeElement, 'precondition: the OK button holds focus').toBe(ok);

    // The ack drains the entry; the row survives EMPTY (the player_wallet rule — the ack never
    // deletes the row, net/store.ts's own `ownEvolutionNotices` doc comment).
    seedEvolutionNotices([]);
    opts.store.flushBatch();

    const canvas = worldCanvas();
    expect(
      canvas,
      'the mocked WorldRenderer.init must have appended a <canvas> to #app',
    ).not.toBeNull();
    expect(
      document.activeElement,
      'render(null) must check whether focus was inside the banner BEFORE hiding it, then call ' +
        'the returnFocus sink main.ts wires to `worldCanvasEl?.focus()`',
    ).toBe(canvas);
  });

  it('RB125-RT-NO-STEAL (green at fork): the reveal never steals focus from a control outside it, on show OR hide', () => {
    // both the current banner and a correct ADR-0272 implementation never move focus on SHOW,
    // and a correct implementation's `returnFocus` guard is false here (focus was never inside
    // the banner) on HIDE. It goes RED only against an UNCONDITIONAL `returnFocus()` call on
    // every hide, or a show that steals focus onto its own OK button.
    // ctl-7a (named intentional change): #help-hint is deleted; the Start chip replaces it as the
    // always-on focusable control outside the reveal banner.
    const helpHint = document.getElementById('chip-start') as HTMLElement | null;
    expect(helpHint, '#chip-start must exist (client/index.html)').not.toBeNull();
    helpHint!.focus();
    expect(document.activeElement, 'anti-vacuity: the chip really is focusable').toBe(helpHint);

    seedEvolutionNotices([{ monsterId: 3n, fromSpecies: 1, toSpecies: 5, evolvedAtMs: 0n }]);
    opts.store.flushBatch();
    expect(document.activeElement, 'showing the reveal must never move focus').toBe(helpHint);
    expect(document.activeElement, 'the OK button must never receive focus on show').not.toBe(
      evolutionOkBtn(),
    );

    seedEvolutionNotices([]);
    opts.store.flushBatch();
    expect(
      document.activeElement,
      'hiding a reveal that never held focus must leave the world-focus control alone — an ' +
        'unconditional returnFocus() call would steal it here',
    ).toBe(helpHint);
  });

  // ---------------------------------------------------------------------------------------
  // ctl-7a: #game-screen, framed runtime banners, and the Start / Select hint-bar chips
  // (CTL7A.1 to CTL7A.4). The structure of index.html itself is gated in indexShell.smoke.test.ts;
  // the cases below prove what main.ts DOES with that structure once booted.
  // ---------------------------------------------------------------------------------------

  /** The inline `style` attribute text plus the three colour-bearing CSSOM reads, for one node. */
  function inlineColourOf(el: HTMLElement): {
    readonly attr: string;
    readonly color: string;
    readonly background: string;
    readonly backgroundColor: string;
  } {
    return {
      attr: (el.getAttribute('style') ?? '').toLowerCase(),
      color: el.style.color,
      background: el.style.background,
      backgroundColor: el.style.backgroundColor,
    };
  }

  it('CTL7A-1-MAIN-MOUNT-IN-GAME-SCREEN: main.ts hands the world renderer #app (the canvas mount), and #app sits directly inside #game-screen, itself a direct <body> child', () => {
    // WRONG IMPL KILLED: a #game-screen wrap that main.ts bypasses by creating its own mount (the
    // canvas would live outside the wrap and the page would still scroll); a wrap that is added to
    // index.html but never contains #app; a renderer handed #game-screen itself (the frame layer
    // and hint bar would be inside the canvas host).
    const app = document.getElementById('app');
    const screen = document.getElementById('game-screen');
    expect(screen, '#game-screen must exist (client/index.html)').not.toBeNull();
    expect(app, '#app must exist (client/index.html)').not.toBeNull();
    expect(H.mounts.length, 'main.ts must have initialised the renderer exactly once').toBe(1);
    expect(H.mounts[0], 'the renderer must be mounted on #app').toBe(app);
    expect(app?.parentElement, '#app is a direct child of #game-screen').toBe(screen);
    expect(screen?.parentElement, '#game-screen is a direct <body> child').toBe(document.body);
    expect(app?.querySelector('canvas'), 'the canvas lives inside #app').not.toBeNull();
  });

  it('CTL7A-2-PROMPT-COUNTDOWN-FRAMED: the runtime-built #interact-prompt and #privacy-countdown are class-styled .mr-frame banners inside #frame-layer, inside #game-screen', () => {
    // WRONG IMPL KILLED: banners still appended to <body> (outside #game-screen, so outside the
    // no-scroll wrap and free to overflow the viewport); banners with no .mr-frame class (they
    // would not read the frame colour tokens); banners that skip the #frame-layer and land
    // directly in #game-screen.
    const layer = document.getElementById('frame-layer');
    const screen = document.getElementById('game-screen');
    expect(layer, '#frame-layer must exist (client/index.html)').not.toBeNull();
    expect(layer?.parentElement, '#frame-layer is a direct child of #game-screen').toBe(screen);
    const cases = [
      { id: 'interact-prompt', modifier: 'mr-frame--prompt' },
      { id: 'privacy-countdown', modifier: 'mr-frame--banner' },
    ];
    for (const { id, modifier } of cases) {
      const el = document.getElementById(id);
      expect(el, `#${id} must be built at boot`).not.toBeNull();
      expect(el?.classList.contains('mr-frame'), `#${id} carries .mr-frame`).toBe(true);
      expect(el?.classList.contains(modifier), `#${id} carries .${modifier}`).toBe(true);
      expect(el?.parentElement, `#${id} is a direct child of #frame-layer`).toBe(layer);
      expect(screen?.contains(el), `#${id} is inside #game-screen`).toBe(true);
    }
  });

  it('CTL7A-3-RUNTIME-NO-INLINE-COLOUR: #interact-prompt and #privacy-countdown carry no inline colour or background (the .mr-frame class and its tokens own them)', () => {
    // WRONG IMPL KILLED: banners re-framed by class but still painting an inline `color` /
    // `background` (an inline declaration beats the class rule, so the 4.5:1 frame tokens would
    // not apply to the text and a prefers-contrast override could not reach it).
    for (const id of ['interact-prompt', 'privacy-countdown']) {
      const el = document.getElementById(id);
      expect(el, `#${id} must be built at boot`).not.toBeNull();
      const inline = inlineColourOf(el as HTMLElement);
      expect(inline.color, `#${id} inline style.color`).toBe('');
      expect(inline.background, `#${id} inline style.background`).toBe('');
      expect(inline.backgroundColor, `#${id} inline style.backgroundColor`).toBe('');
      expect(inline.attr.includes('color'), `#${id} style attr "${inline.attr}"`).toBe(false);
      expect(inline.attr.includes('background'), `#${id} style attr "${inline.attr}"`).toBe(false);
    }
  });

  it('CTL7A-4-CHIP-VERBS: the Start and Select chips carry their verbs from the catalog (Menu / Help), and #help-hint is gone', () => {
    // WRONG IMPL KILLED: chips left empty (main.ts never writes the labels); labels hard-coded in
    // the markup (an English literal under fr); the two labels swapped; a leftover #help-hint
    // badge (the retired one-corner affordance) kept beside the chips.
    const start = document.getElementById('chip-start');
    const select = document.getElementById('chip-select');
    expect(start, '#chip-start must exist (client/index.html)').not.toBeNull();
    expect(select, '#chip-select must exist (client/index.html)').not.toBeNull();
    // The EN literals are asserted too, so an empty-string catalog entry cannot satisfy the
    // catalog-equality below. ctl-13: a chip is keycap + verb parts; the verb is `.mr-chip-verb`.
    const startVerb = start?.querySelector('.mr-chip-verb')?.textContent;
    const selectVerb = select?.querySelector('.mr-chip-verb')?.textContent;
    expect(startVerb).toBe('Menu');
    expect(selectVerb).toBe('Help');
    expect(startVerb).toBe(i18nT('chrome.chip.menu' as never));
    expect(selectVerb).toBe(i18nT('chrome.chip.help' as never));
    expect(document.getElementById('help-hint'), '#help-hint is retired').toBeNull();
  });

  it('CTL7A-4-START-OPENS-MENU: clicking the Start chip opens the main menu (and not help)', () => {
    // WRONG IMPL KILLED: a chip with no [data-menu-launcher] binding (the click is inert); a chip
    // that opens help instead; a click that toggles a stale overlay state.
    const chip = document.getElementById('chip-start') as HTMLElement | null;
    expect(chip, '#chip-start must exist (client/index.html)').not.toBeNull();
    expect(overlayIsOpen('menuView'), 'precondition: the menu starts closed').toBe(false);
    // A real pointer press focuses the button first; so does this case (a chip gated on
    // worldHasFocus() would refuse its own click).
    chip!.focus();
    expect(document.activeElement, 'precondition: the chip holds focus').toBe(chip);
    chip!.click();
    expect(overlayIsOpen('menuView'), 'the Start chip opens the menu').toBe(true);
    expect(
      (document.getElementById('menu-overlay') as HTMLElement).style.display,
      '#menu-overlay is shown',
    ).not.toBe('none');
    expect(overlayIsOpen('helpView'), 'and does not open help').toBe(false);
  });

  it('CTL7A-4-SELECT-OPENS-HELP: clicking the Select chip opens help (and not the menu)', () => {
    // WRONG IMPL KILLED: a chip with no [data-help-launcher] branch (the click is inert); a chip
    // wired to the menu launcher (both chips would open the menu); a help open that bypasses the
    // overlay verdict.
    const chip = document.getElementById('chip-select') as HTMLElement | null;
    expect(chip, '#chip-select must exist (client/index.html)').not.toBeNull();
    expect(overlayIsOpen('helpView'), 'precondition: help starts closed').toBe(false);
    // A real pointer press focuses the button first; so does this case (a chip gated on
    // worldHasFocus() would refuse its own click).
    chip!.focus();
    expect(document.activeElement, 'precondition: the chip holds focus').toBe(chip);
    chip!.click();
    expect(overlayIsOpen('helpView'), 'the Select chip opens help').toBe(true);
    expect(
      (document.getElementById('help-overlay') as HTMLElement).style.display,
      '#help-overlay is shown',
    ).not.toBe('none');
    expect(overlayIsOpen('menuView'), 'and does not open the menu').toBe(false);
  });

  // ---------------------------------------------------------------------------------------
  // ctl-11b (CTL11B.1): the legacy `worldHasFocus` ladder is replaced by one rule. A key that is
  // not bound does nothing at the world and is left unprevented; a key event whose target is an
  // element OUTSIDE #game-screen (and not <body>) is the browser's, every key. main.ts looks
  // `#game-screen` up on each keydown (`document.getElementById`), so these cases add or move
  // elements at will. The world base is the stack `[{ kind: 'world' }]`.
  // ---------------------------------------------------------------------------------------

  const WORLD_BASE_ONLY: readonly unknown[] = [{ kind: 'world' }];
  interface GameHook {
    readonly stack: readonly unknown[];
    readonly moveSendCount: number;
  }
  const gameHook = (): GameHook => (window as unknown as { __game: () => GameHook }).__game();

  it('CTL11B-1-BOOT-UNBOUND: at the world base a key with no binding (K, 5, Z, and the retired O and T) is left unprevented and does nothing: the stack stays the bare world, no screen opens, no intent or reducer is reached; the control is a bound key (B), which does act', () => {
    // WRONG IMPL KILLED: a handler that consumes every key it sees (a preventDefault on an unbound
    // key would swallow the browser's own shortcuts: find-as-you-type, Ctrl-less letters), one that
    // opens a screen or walks for a stray letter (a revived legacy letter arm: O and T are the
    // retired trade offer and interact keys), one that reaches a reducer (`conn.live()` is the one
    // door every intent and reducer call goes through), and a test that could not tell: the control
    // proves the same dispatch path DOES act on a bound key.
    expect(gameHook().stack, 'precondition: the world base').toEqual(WORLD_BASE_ONLY);
    const liveBefore = H.liveReads;
    const sentBefore = gameHook().moveSendCount;
    for (const code of ['KeyK', 'Digit5', 'KeyZ', 'KeyO', 'KeyT', 'KeyG']) {
      const e = pressKey({ code }, document.body);
      expect(e.defaultPrevented, `${code} is not bound: left to the browser`).toBe(false);
      expect(gameHook().stack, `${code}: the stack is unchanged`).toEqual(WORLD_BASE_ONLY);
      expect(openOverlayIds(), `${code}: no screen opened`).toEqual([]);
    }
    expect(H.liveReads, 'no unbound key reached a reducer (the live handle was never read)').toBe(
      liveBefore,
    );
    expect(gameHook().moveSendCount, 'no unbound key sent a movement intent').toBe(sentBefore);

    // Control: a bound key on the very same path acts.
    const bound = pressKey({ code: 'KeyB' }, document.body);
    expect(bound.defaultPrevented, 'control: B is bound and consumed').toBe(true);
    expect(overlayIsOpen('boxView'), 'control: B opens Monsters').toBe(true);
  });

  it('CTL11B-1-BOOT-OUTSIDE: with focus on a <button> outside #game-screen every key is the browser`s (an accelerator, Start, A, the D-pad, B, F9 and Space): none is prevented, the stack stays the bare world, nothing opens, no bug bundle is built, no step or reducer is reached, and focus stays where it was', () => {
    // WRONG IMPL KILLED: the legacy world-focus ladder, which let the game take Enter and the
    // accelerators from a control that is not part of it (the page's own button, the browser's
    // overlay), or took Escape for Start and F9 for a download over it; an outside rule on only some
    // keys (the D-pad or F9 forgotten, F9 being handled before the router); one that runs AFTER the
    // stale-focus heal and so can move focus away from the outside control (focus is asserted
    // unmoved). NOT killed here, by design: an early return placed after the
    // `e.repeat` block or after the session gate (the pins CTL11B-1-PIN-REPEAT and
    // CTL11B-1-PIN-SESSION-GATE do that), and a rule that reads `document.activeElement` instead of
    // the event target (this press is dispatched AT the focused button, so the two agree; in a
    // browser a key event's target IS the focused element, so that variant is near-equivalent).
    const outside = document.createElement('button');
    outside.id = 'outside-control';
    document.body.appendChild(outside);
    const screen = document.getElementById('game-screen');
    expect(screen, '#game-screen must exist (client/index.html)').not.toBeNull();
    expect(screen!.contains(outside), 'precondition: the control is outside #game-screen').toBe(
      false,
    );
    outside.focus();
    expect(document.activeElement, 'precondition: the outside control has focus').toBe(outside);
    expect(gameHook().stack, 'precondition: the world base').toEqual(WORLD_BASE_ONLY);
    const liveBefore = H.liveReads;
    const sentBefore = gameHook().moveSendCount;

    const keys: ReadonlyArray<readonly [string, string]> = [
      ['accelerator B (Monsters)', 'KeyB'],
      ['accelerator I (Bag)', 'KeyI'],
      ['Start (Escape)', 'Escape'],
      ['Start (M)', 'KeyM'],
      ['Select (R)', 'KeyR'],
      ['A (Enter)', 'Enter'],
      ['D-pad W', 'KeyW'],
      ['D-pad ArrowDown', 'ArrowDown'],
      ['B (Backspace)', 'Backspace'],
      ['X (Space)', 'Space'],
      ['F9 (bug bundle)', 'F9'],
    ];
    for (const [label, code] of keys) {
      const down = pressKey({ code }, outside);
      expect(down.defaultPrevented, `${label}: left to the browser`).toBe(false);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
      expect(gameHook().stack, `${label}: the stack stays the bare world`).toEqual(WORLD_BASE_ONLY);
      expect(openOverlayIds(), `${label}: nothing opens`).toEqual([]);
      expect(document.activeElement, `${label}: focus stays on the outside control`).toBe(outside);
    }
    expect(H.buildBugBundle, 'F9 outside the screen builds no bug bundle').not.toHaveBeenCalled();
    expect(H.liveReads, 'no key reached a reducer (the live handle was never read)').toBe(
      liveBefore,
    );
    expect(gameHook().moveSendCount, 'no D-pad key sent or held a step').toBe(sentBefore);

    // Control: the same keys, the same path, once focus is back on the page act as before.
    outside.blur();
    document.body.focus();
    const back = pressKey({ code: 'KeyB' }, document.body);
    expect(back.defaultPrevented, 'control: B is consumed with focus on the page').toBe(true);
    expect(overlayIsOpen('boxView'), 'control: and opens Monsters').toBe(true);
  });

  it('CTL11B-1-BOOT-INSIDE-ROUTES: with focus on <body>, on the canvas, or on a control inside #game-screen, B still opens Monsters over the menu (the stack top is boxView) and is prevented', () => {
    // WRONG IMPL KILLED (the survivor of the outside rule): one that is true for <body> (the state
    // after every close and at every boot: every key would be dead at the world), one that mistakes
    // the canvas or a chip inside the screen for "outside" (the keyboard player Tabbed onto the
    // canvas could no longer open anything), one that stops routing because the target is not
    // `window`, and an opened screen that never reaches the stack.
    const screen = document.getElementById('game-screen');
    expect(screen, '#game-screen must exist (client/index.html)').not.toBeNull();
    const canvas = document.getElementById('app')?.querySelector('canvas') as HTMLElement | null;
    expect(canvas, 'the mocked renderer mounted a canvas in #app').not.toBeNull();
    const chip = document.getElementById('chip-start') as HTMLElement | null;
    expect(chip, '#chip-start must exist (client/index.html)').not.toBeNull();
    expect(screen!.contains(canvas), 'precondition: the canvas is inside #game-screen').toBe(true);
    expect(screen!.contains(chip), 'precondition: the Start chip is inside #game-screen').toBe(
      true,
    );

    const targets: ReadonlyArray<readonly [string, HTMLElement]> = [
      ['<body>', document.body],
      ['the canvas', canvas as HTMLElement],
      ['a control inside the screen', chip as HTMLElement],
    ];
    for (const [label, target] of targets) {
      target.focus();
      expect(gameHook().stack, `${label}: precondition: the world base`).toEqual(WORLD_BASE_ONLY);
      const e = pressKey({ code: 'KeyB' }, target);
      expect(e.defaultPrevented, `${label}: B is consumed`).toBe(true);
      const stack = gameHook().stack;
      expect(stack.at(-1), `${label}: the top frame is Monsters`).toEqual({
        kind: 'screen',
        id: 'boxView',
      });
      expect(stack, `${label}: over the menu, over the world`).toEqual([
        { kind: 'world' },
        { kind: 'screen', id: 'menuView' },
        { kind: 'screen', id: 'boxView' },
      ]);
      expect(overlayIsOpen('boxView'), `${label}: Monsters is shown`).toBe(true);
      pressKey({ code: 'Escape' }, target); // Start pops everything: the next target starts bare
      expect(gameHook().stack, `${label}: Start returned to the bare world`).toEqual(
        WORLD_BASE_ONLY,
      );
    }
  });

  // ---------------------------------------------------------------------------------------
  // Review-round pins for the outside rule (ctl-11b): the evolution notice's OK button, an OS
  // key-repeat, and the session gate.
  // ---------------------------------------------------------------------------------------

  it('CTL11B-1-PIN-EVO-NOTICE: the real evolution reveal`s OK button is inside #game-screen, and with focus on it W is prevented and B still opens Monsters (the stack top is boxView)', () => {
    // WRONG IMPL KILLED: a reveal banner that is built at <body> level (outside the game screen).
    // The outside rule would then hand every key to the browser the moment the player focuses OK,
    // which a keyboard player does to acknowledge the reveal: W, B and Start would all die until
    // focus left the button. (The banner adopts a `#evolution-notice` element main.ts creates inside
    // #game-screen before constructing it.)
    seedEvolutionNotices([{ monsterId: 2n, fromSpecies: 1, toSpecies: 5, evolvedAtMs: 0n }]);
    opts.store.flushBatch();
    const ok = evolutionOkBtn();
    expect(ok, '#evolution-notice-ok must exist once the reveal has rendered').not.toBeNull();
    const screen = document.getElementById('game-screen');
    expect(screen, '#game-screen must exist (client/index.html)').not.toBeNull();
    expect(screen!.contains(ok), 'the OK button is inside #game-screen').toBe(true);

    ok!.focus();
    expect(document.activeElement, 'precondition: the OK button has focus').toBe(ok);
    expect(gameHook().stack, 'precondition: the world base').toEqual(WORLD_BASE_ONLY);

    const w = pressKey({ code: 'KeyW' }, ok!);
    expect(w.defaultPrevented, 'W at the focused OK button is the router`s: consumed').toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));

    const b = pressKey({ code: 'KeyB' }, ok!);
    expect(b.defaultPrevented, 'B at the focused OK button is consumed').toBe(true);
    const stack = gameHook().stack;
    expect(stack.at(-1), 'B opened Monsters: the top frame is boxView').toEqual({
      kind: 'screen',
      id: 'boxView',
    });
    expect(overlayIsOpen('boxView'), 'and it is shown').toBe(true);
  });

  it('CTL11B-1-PIN-REPEAT: an OS key-repeat (repeat: true) of ArrowDown, W or Space at a control outside #game-screen is not prevented, while the same repeats with focus on <body> are', () => {
    // WRONG IMPL KILLED: the outside rule placed AFTER the `e.repeat` block of the keydown handler.
    // A held arrow key on a page control outside the game would then still be cancelled on every
    // repeat tick (`suppressNativeMovementDefault`), so the page's own scrolling or list would stop
    // responding while the key is held. The control rows prove the repeat path is live: at <body>
    // the same repeats ARE prevented.
    const button = document.createElement('button');
    const div = document.createElement('div');
    div.tabIndex = 0;
    document.body.append(button, div);
    const repeat = (code: string, target: HTMLElement): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', {
        code,
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(e);
      return e;
    };

    button.focus();
    expect(document.activeElement, 'precondition: the outside button has focus').toBe(button);
    for (const code of ['ArrowDown', 'KeyW', 'Space']) {
      expect(repeat(code, button).defaultPrevented, `repeat ${code} at an outside button`).toBe(
        false,
      );
    }
    div.focus();
    expect(document.activeElement, 'precondition: the outside div has focus').toBe(div);
    for (const code of ['ArrowDown', 'KeyW', 'Space']) {
      expect(repeat(code, div).defaultPrevented, `repeat ${code} at an outside div`).toBe(false);
    }

    // Control: the same repeats with focus on <body> are cancelled (a held arrow never scrolls).
    document.body.focus();
    for (const code of ['ArrowDown', 'KeyW', 'Space']) {
      expect(
        repeat(code, document.body).defaultPrevented,
        `control: repeat ${code} at <body>`,
      ).toBe(true);
    }
  });

  it('CTL11B-1-PIN-SESSION-GATE: with the session gate blocking, ArrowDown and Space at a control outside #game-screen are not prevented, while the same keys with focus on <body> are', () => {
    // WRONG IMPL KILLED: the outside rule placed AFTER the session gate. The gate swallows every key
    // (it prevents the movement defaults so a held arrow does not scroll the dead page), and that
    // cancel would then also hit a control outside the game: a session-expired page would stop
    // letting the player use its own buttons and fields with the arrow keys or Space. The control
    // rows prove the gate is up and swallowing: at <body> the same keys ARE prevented.
    const outside = document.createElement('div');
    outside.tabIndex = 0;
    document.body.appendChild(outside);
    H.session = 'expired';
    try {
      outside.focus();
      expect(document.activeElement, 'precondition: the outside control has focus').toBe(outside);
      for (const code of ['ArrowDown', 'Space']) {
        const e = pressKey({ code }, outside);
        expect(e.defaultPrevented, `${code} at an outside control, gate up`).toBe(false);
      }

      document.body.focus();
      for (const code of ['ArrowDown', 'Space']) {
        const e = pressKey({ code }, document.body);
        expect(e.defaultPrevented, `control: ${code} at <body>, gate up`).toBe(true);
      }
    } finally {
      H.session = 'hidden';
    }
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
    // shipping.
    const prev: A11ySnapshot = { topOverlay: 'boxView', message: '' };
    const next: A11ySnapshot = { topOverlay: null, message: '' };
    expect(announcementsFor(prev, next)).toEqual([]);
  });
});
