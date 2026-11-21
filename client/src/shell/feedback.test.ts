// @vitest-environment happy-dom
// shell/feedback — the message sinks main.ts drives: the toast, the world hint, the announcer, the
// error ring and its overlay. A real boot of main.ts on the real index.html shell sends real
// messages, events and frames through this module; the suite reads the module back through
// `./feedback` in the same module registry and checks it is the instance the shell drives. A
// second block imports the module on its own (no boot) and checks its owner functions directly.
// Harness: inputState.test.ts's pattern (vi.resetModules + a fresh import per boot, one
// controllable clock and rAF, a stubbed wasm pkg, SDK connection, telemetry and renderer).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clock,
  connectionRecordingMock,
  frame,
  mountIndexHtmlShell,
  raf,
  stubRaf,
  telemetryMock,
  wasmPkgWalkingMock,
  worldRendererMock,
} from '../../test-util/mainBootHarness';
import type { WasmMoveInput } from '../convert/convert';
import type { ConnectionOptions } from '../net/connection';
import type { A11ySnapshot } from '../ui/announcements';
import type { OverlayId } from '../ui/overlayRegistry';

const H = vi.hoisted(() => ({
  identity: 'ab'.repeat(32),
  connectOpts: null as ConnectionOptions | null,
  sends: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
}));

// The 17 `tactics_*` exports the rules port binds (`bindTacticsRules` refuses a pkg missing any).
vi.mock('../../../client-wasm/pkg/client_wasm.js', () => ({
  ...wasmPkgWalkingMock(),
  tactics_map: () => ({
    width: 7,
    height: 5,
    tiles: [],
    spawn_a: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ],
    spawn_b: [],
  }),
  tactics_fresh_budget: () => ({ ap: 6, strides_used: 0, attacks: 0, last: null }),
  tactics_unit: (row: unknown) => row,
  tactics_targets: () => ({ Ok: [] }),
  tactics_path: () => ({ Err: 'Unreachable' }),
  tactics_disengage: () => ({ Ok: false }),
  tactics_flank: () => false,
  tactics_forecast: () => ({}),
  tactics_recruit_odds: () => ({ Err: { UnknownUnit: { id: 0 } } }),
  tactics_ai_plan: () => [],
  tactics_recruit_targets: () => [],
  tactics_is_exhausted: () => false,
  tactics_plan: () => ({ Err: 'ZeroStrides' }),
  tactics_overlays: () => ({
    reach1: [],
    reach2: [],
    range: [],
    aoe: [],
    danger: [],
    shield: [],
    intents: [],
  }),
  tactics_tuning: () => ({ surge_start_round: 9, wild_round_cap: 30, autopass_forfeit: 4 }),
  tactics_next_initiative: () => [],
  tactics_deploy_slots: () => 3,
}));

vi.mock('../net/connection', () => connectionRecordingMock(H));

vi.mock('../observability/telemetry', async (importOriginal) =>
  telemetryMock(await importOriginal<typeof import('../observability/telemetry')>()),
);

vi.mock('../render/world', () => worldRendererMock());

type Feedback = typeof import('./feedback');

// --- harness ------------------------------------------------------------------------------
interface Recorded {
  readonly target: EventTarget;
  readonly type: string;
  readonly handler: EventListenerOrEventListenerObject | null;
  readonly options?: boolean | AddEventListenerOptions;
}
let recorded: Recorded[] = [];
const restorers: Array<() => void> = [];

function recordListeners(target: EventTarget): void {
  const own = Object.getOwnPropertyDescriptor(target, 'addEventListener');
  const original = target.addEventListener.bind(target);
  (target as unknown as { addEventListener: typeof original }).addEventListener = (
    type: string,
    handler: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    recorded.push({ target, type, handler, options });
    original(type, handler, options);
  };
  restorers.push(() => {
    if (own !== undefined) Object.defineProperty(target, 'addEventListener', own);
    else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
  });
}

let opts: ConnectionOptions;
/** The frame clock: every frame this file runs is at `T`, which only moves forward. */
let T = 1000;

/** Run one shell frame at `t` (and make it the current clock). */
function at(t: number): void {
  expect(t, 'the frame clock only moves forward').toBeGreaterThanOrEqual(T);
  T = t;
  frame(t);
}

/** Run one shell frame `ms` after the last one. */
function advance(ms: number): void {
  at(T + ms);
}

function teardown(): void {
  for (const r of recorded) r.target.removeEventListener(r.type, r.handler, r.options);
  recorded = [];
  while (restorers.length > 0) restorers.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  raf.cb = null;
  localStorage.clear();
  document.documentElement.style.removeProperty('--mr-text-step');
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
  vi.resetModules();
}

/** Boot a fresh main.ts on the real shell, report ready, deliver the own character, let the frame
 *  loop run until the boot is quiet, and answer the `./feedback` module main.ts drives. */
async function boot(): Promise<Feedback> {
  H.connectOpts = null;
  H.sends = [];
  H.calls = [];
  T = 1000;
  clock.t = T;
  localStorage.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  recorded = [];
  mountIndexHtmlShell();
  recordListeners(window);
  recordListeners(document);
  stubRaf();
  vi.resetModules();
  await import('../main');
  opts = await vi.waitFor(
    () => {
      if (H.connectOpts === null) throw new Error('connect() not reached yet');
      return H.connectOpts;
    },
    { timeout: 5_000, interval: 5 },
  );
  opts.onReady(H.identity);
  server(T);
  // The frame loop is armed behind main()'s ready promise.
  await vi.waitFor(
    () => {
      if (raf.cb === null) throw new Error('the frame loop is not armed yet');
    },
    { timeout: 5_000, interval: 5 },
  );
  for (let i = 0; i < 9; i += 1) advance(600);
  // Same registry, no reset: this is the module instance main.ts imported.
  return import('./feedback');
}

const EID = 7n;

/** One authoritative batch: the own player and character at (2, 6), every send acked. */
function server(t: number): void {
  clock.t = t;
  opts.store.upsertPlayer({
    identity: H.identity,
    entityId: EID,
    name: 'P',
    online: true,
    discriminator: 0,
    leadLevel: 0,
  });
  opts.store.upsertCharacter(
    {
      entityId: EID,
      zoneId: 0,
      tileX: 2,
      tileY: 6,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [] as WasmMoveInput[],
      ackedSeq: BigInt(H.sends.length),
    },
    t,
  );
  opts.store.flushBatch();
}

/** A tap on the current clock: keydown, then its keyup. */
function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true, cancelable: true }));
}

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is not in the document`);
  return el;
};

const statusText = (): string => byId('status').textContent ?? '';
const liveText = (): string => byId('a11y-live').textContent ?? '';
/** The toast's visible text, '' while it is hidden. */
const toastText = (): string => {
  const el = byId('toast');
  return el.hidden ? '' : (el.textContent ?? '');
};
/** The main menu's hint strip (its frame's feedback line). */
const menuStrip = (): string => {
  const el = document.querySelector('#menu-overlay .mr-frame-feedback');
  if (el === null) throw new Error('the main menu frame has no feedback strip');
  return el.textContent ?? '';
};

interface FrameJson {
  readonly kind: string;
  readonly id?: string;
}
interface GameHook {
  readonly stack: FrameJson[];
}
const stackNames = (): string[] =>
  (window as unknown as { __game: () => GameHook })
    .__game()
    .stack.map((f) => (f.kind === 'screen' || f.kind === 'prompt' ? (f.id ?? '') : f.kind));

/** The error overlay's rows, in DOM order (the model renders newest first). */
function overlayRows(): Array<{ readonly source: string | undefined; readonly text: string }> {
  return Array.from(document.querySelectorAll<HTMLElement>('.mr-error-row')).map((el) => ({
    source: el.dataset.source,
    text: el.textContent ?? '',
  }));
}
const overlayShown = (): boolean => byId('mr-error-overlay').style.display !== 'none';

// --- the booted shell --------------------------------------------------------------------------
describe('the booted shell drives the message sinks of shell/feedback', {
  sequential: true,
}, () => {
  afterEach(teardown);

  it('main() mounts #status and the #toast it built into the module, a hint or a toast sent through the module paints them, and the shell`s frames expire the toast on the frame clock', async () => {
    const fb = await boot();
    const { NO_TOAST, TOAST_MS } = await import('../ui/toast');
    expect(fb.statusEl, 'the mounted world line is #status').toBe(byId('status'));
    expect(byId('game-screen').contains(byId('status')), '#status is in the game screen').toBe(
      true,
    );
    expect(fb.toastChrome?.root, 'the mounted toast is #toast').toBe(byId('toast'));
    expect(byId('game-screen').contains(byId('toast')), '#toast is in the game screen').toBe(true);
    expect(fb.worldHints, 'precondition: no hint stands after the boot').toEqual([]);

    fb.route('world-disconnect', 'route-hint-sentinel');
    expect(statusText(), 'a hint kind routed through the module paints #status').toBe(
      'route-hint-sentinel',
    );
    fb.setWorldHint('content-stale', 'set-hint-sentinel');
    expect(statusText(), 'a higher-ranked hint set through the module repaints #status').toBe(
      'set-hint-sentinel',
    );

    fb.route('shop-rejected', 'route-toast-sentinel');
    expect(toastText(), 'a toast kind routed through the module paints #toast').toBe(
      'route-toast-sentinel',
    );
    expect(statusText(), 'and leaves #status alone').toBe('set-hint-sentinel');

    const shownAt = T;
    clock.t = shownAt;
    fb.showToast('show-toast-sentinel');
    expect(toastText(), 'showToast paints #toast').toBe('show-toast-sentinel');
    expect(fb.toastState, 'timed from the clock it was shown at').toEqual({
      kind: 'shown',
      text: 'show-toast-sentinel',
      untilMs: shownAt + TOAST_MS,
    });
    at(shownAt + TOAST_MS - 1);
    expect(toastText(), 'a frame before the dwell ends keeps the toast').toBe(
      'show-toast-sentinel',
    );
    at(shownAt + TOAST_MS);
    expect(byId('toast').hidden, 'the shell`s frame at the dwell`s end hid the toast').toBe(true);
    expect(fb.toastState, 'the module`s toast state is cleared').toBe(NO_TOAST);
  }, 60_000);

  it('the world hint is on #status while the main menu is closed, on the menu`s strip while the menu is on top, and back on #status once the menu closes', async () => {
    const fb = await boot();
    expect(stackNames(), 'precondition: the bare world').toEqual(['world']);
    expect(fb.worldHints, 'precondition: no hint stands after the boot').toEqual([]);

    fb.setWorldHint('content-stale', 'hint-a-sentinel');
    expect(statusText(), 'menu closed: the hint is on #status').toBe('hint-a-sentinel');
    expect(menuStrip(), 'menu closed: the strip does not carry it').not.toBe('hint-a-sentinel');
    expect(fb.menuHint, 'menu closed: the menu hosts no hint').toBeNull();
    expect(fb.hintOnMenu(), 'menu closed: hintOnMenu answers null').toBeNull();

    press('Escape');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    expect(statusText(), 'menu on top: #status is empty').toBe('');
    expect(menuStrip(), 'menu on top: the strip carries the hint').toBe('hint-a-sentinel');
    expect(fb.hintOnMenu(), 'menu on top: hintOnMenu answers the hint').toBe('hint-a-sentinel');

    // A hint that changes while the menu is open reaches the strip only through the repaint.
    fb.setWorldHint('content-stale', 'hint-b-sentinel');
    expect(menuStrip(), 'a new hint with the menu on top repaints the strip').toBe(
      'hint-b-sentinel',
    );
    expect(statusText(), 'and #status stays empty').toBe('');
    expect(fb.menuHint, 'the strip`s hint is the new one').toBe('hint-b-sentinel');

    press('Escape');
    expect(stackNames(), 'precondition: the menu closed').toEqual(['world']);
    expect(statusText(), 'menu closed again: the hint is back on #status').toBe('hint-b-sentinel');
    expect(menuStrip(), 'and the strip was repainted without it').not.toBe('hint-b-sentinel');
    expect(fb.menuHint, 'the menu hosts no hint').toBeNull();
  }, 60_000);

  it('an uncaught error on window lands in the module`s error ring exactly once and on the error overlay, and the connect edge is in the module`s event ring', async () => {
    const fb = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      fb.eventRing
        .snapshot()
        .filter((e) => e.kind === 'connect')
        .map((e) => ({ ...e, tMs: 0, tSeq: 0 })),
      'onReady recorded one connect edge, for this identity',
    ).toEqual([{ kind: 'connect', identity: H.identity, tMs: 0, tSeq: 0 }]);

    const sentinel = 'window-error-sentinel';
    expect(
      fb.errorRing.snapshot().filter((r) => r.message === sentinel),
      'precondition: not in the ring',
    ).toEqual([]);
    window.dispatchEvent(
      new ErrorEvent('error', { message: sentinel, error: new Error(sentinel) }),
    );
    expect(
      fb.errorRing
        .snapshot()
        .filter((r) => r.message === sentinel)
        .map((r) => r.source),
      'one uncaught row, not two',
    ).toEqual(['uncaught']);
    expect(overlayShown(), 'the error overlay is shown').toBe(true);
    expect(overlayRows(), 'and lists the error').toContainEqual({
      source: 'uncaught',
      text: `[uncaught] ${sentinel}`,
    });

    fb.reportPaintError(new Error('paint-sentinel'));
    fb.reportPaintError(new Error('paint-sentinel'));
    expect(
      fb.errorRing.snapshot().filter((r) => r.message === 'screen paint: paint-sentinel').length,
      'a repeated paint error is recorded once',
    ).toBe(1);
    expect(fb.lastPaintErrorMessage).toBe('screen paint: paint-sentinel');
  }, 60_000);

  it('reportError shows the failure on its toast and the shell`s overlay, F8 dismisses it through the module, and the overlay lists only what came after a dismissal, never a movement breadcrumb', async () => {
    const fb = await boot();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fb.reportError('shop-rejected', 'report-sentinel');
    expect(toastText(), 'the failure is on the toast').toBe('report-sentinel');
    const reported = fb.errorRing.snapshot().filter((r) => r.message === 'report-sentinel');
    expect(
      reported.map((r) => r.source),
      'and in the module`s ring, once, as a reducer row',
    ).toEqual(['reducer']);
    expect(overlayShown(), 'the overlay is shown').toBe(true);
    expect(overlayRows(), 'and lists it').toContainEqual({
      source: 'reducer',
      text: '[reducer] report-sentinel',
    });

    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'F8', bubbles: true, cancelable: true }),
    );
    expect(overlayShown(), 'F8 hid the overlay').toBe(false);
    const newest = fb.errorRing.snapshot().reduce((max, r) => Math.max(max, r.tSeq), -1);
    expect(fb.toastDismissedSeq, 'the shell`s F8 dismissed through the module').toBe(newest);

    fb.pushError('uncaught', 'after-dismiss-sentinel');
    expect(overlayShown(), 'a later error shows the overlay again').toBe(true);
    expect(overlayRows(), 'listing only what came after the dismissal').toEqual([
      { source: 'uncaught', text: '[uncaught] after-dismiss-sentinel' },
    ]);

    fb.pushError('uncaught', `${fb.MOVE_REJECT_PREFIX}seq=9 dropped=0`);
    expect(fb.errorRing.snapshot().at(-1)?.message, 'the movement breadcrumb is in the ring').toBe(
      'movement-reject seq=9 dropped=0',
    );
    expect(overlayRows(), 'but never on the overlay').toEqual([
      { source: 'uncaught', text: '[uncaught] after-dismiss-sentinel' },
    ]);

    fb.dismissErrorToast();
    expect(overlayShown(), 'dismissErrorToast hid the overlay').toBe(false);
    fb.pushError('reducer', 'third-sentinel');
    expect(overlayRows(), 'what it showed is not listed again').toEqual([
      { source: 'reducer', text: '[reducer] third-sentinel' },
    ]);
    expect(fb.handlingError, 'the re-entrancy guard is released').toBe(false);
  }, 60_000);

  it('the shell`s frames flush the module`s live region once per frame on the frame clock, speak announceNow into #a11y-live, clear announcedSinceFrame, and hold a toast`s notice clear of an announcement made beside it', async () => {
    const fb = await boot();
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    const flush = vi.spyOn(fb.liveRegion, 'flush');

    const B = T;
    advance(16);
    expect(flush.mock.calls, 'one frame flushed the module`s live region once').toEqual([[B + 16]]);

    clock.t = B + 20;
    fb.announceNow('said-now-sentinel');
    expect(fb.announcedSinceFrame, 'announceNow marks the frame').toBe(true);
    at(B + 30);
    expect(fb.announcedSinceFrame, 'the next frame cleared the mark').toBe(false);
    at(B + 520);
    expect(liveText(), 'a frame past the window spoke it into #a11y-live').toBe(
      'said-now-sentinel',
    );
    expect(flush.mock.calls.length, 'three frames, three flushes').toBe(3);

    // A notice queued with a toast, then an announcement after it and before the next frame.
    const Q = B + 1000;
    at(Q);
    clock.t = Q;
    fb.showToast('notice-sentinel');
    expect(fb.statusNotice.queued?.text, 'the toast queued its notice').toBe('notice-sentinel');
    at(Q + 400);
    clock.t = Q + 450;
    fb.announceNow('aside-sentinel');
    at(Q + 460);
    at(Q + 600);
    expect(
      fb.statusNotice.queued?.text,
      'a window after it was queued, the notice is still held: the announcement was too recent',
    ).toBe('notice-sentinel');
    at(Q + 960);
    expect(liveText(), 'the announcement was spoken, not clobbered by the notice').toBe(
      'aside-sentinel',
    );
    expect(fb.statusNotice.queued, 'the notice was handed to the live region').toBeNull();
    at(Q + 1460);
    expect(liveText(), 'and then the notice was spoken').toBe('notice-sentinel');
    expect(
      announce.mock.calls.filter(([m]) => m === 'aside-sentinel' || m === 'notice-sentinel'),
      'each once, the notice a full window after the announcement',
    ).toEqual([
      ['aside-sentinel', Q + 450],
      ['notice-sentinel', Q + 960],
    ]);
  }, 60_000);

  it('opening then closing the main menu makes the shell`s frames announce the world region once and move the module`s lastA11ySnapshot to the menu and back', async () => {
    const fb = await boot();
    const { t } = await import('../ui/a11yCopy');
    const world = t('a11y.world.region');
    expect(fb.lastA11ySnapshot, 'precondition: the world is on top').toEqual({
      topOverlay: null,
      message: '',
    });
    const announce = vi.spyOn(fb.liveRegion, 'announce');

    press('Escape');
    expect(stackNames(), 'precondition: Start opened the menu').toEqual(['world', 'menuView']);
    advance(16);
    expect(fb.lastA11ySnapshot, 'the frame saw the menu on top').toEqual({
      topOverlay: 'menuView',
      message: '',
    });
    expect(
      announce.mock.calls.filter(([m]) => m === world),
      'no world edge yet',
    ).toEqual([]);

    press('Escape');
    expect(stackNames(), 'precondition: the menu closed').toEqual(['world']);
    const edgeAt = T + 600;
    at(edgeAt);
    expect(fb.lastA11ySnapshot, 'the frame saw the world on top').toEqual({
      topOverlay: null,
      message: '',
    });
    advance(600);
    expect(liveText(), 'the world region was spoken into #a11y-live').toBe(world);
    advance(600);
    advance(600);
    expect(
      announce.mock.calls.filter(([m]) => m === world),
      'the world region was announced once, on the edge frame',
    ).toEqual([[world, edgeAt]]);
  }, 60_000);

  it('a reconnect drops a notice queued before it, resets statusNotice, and clears the toast and the link hints while content-stale stands', async () => {
    const fb = await boot();
    const { STATUS_NOTICE_INITIAL } = await import('../ui/statusModel');
    const { NO_TOAST } = await import('../ui/toast');
    const announce = vi.spyOn(fb.liveRegion, 'announce');

    fb.setWorldHint('world-disconnect', 'link-hint-sentinel');
    fb.setWorldHint('content-stale', 'stale-hint-sentinel');
    clock.t = T;
    fb.showToast('stale-notice-sentinel');
    expect(fb.statusNotice.queued?.text, 'precondition: a notice is queued').toBe(
      'stale-notice-sentinel',
    );
    expect(toastText(), 'precondition: the toast is up').toBe('stale-notice-sentinel');

    opts.store.reset();
    opts.onReconnect(H.identity);
    expect(fb.statusNotice, 'statusNotice is back to its initial value').toBe(
      STATUS_NOTICE_INITIAL,
    );
    expect(fb.toastState, 'the toast state is cleared').toBe(NO_TOAST);
    expect(byId('toast').hidden, 'the toast is hidden').toBe(true);
    expect(fb.worldHints, 'the link hint went, content-stale stands').toEqual([
      { kind: 'content-stale', text: 'stale-hint-sentinel' },
    ]);
    expect(statusText(), '#status shows the standing hint').toBe('stale-hint-sentinel');
    expect(
      fb.eventRing.snapshot().filter((e) => e.kind === 'connect').length,
      'the reconnect recorded a second connect edge in the module`s ring',
    ).toBe(2);

    for (let i = 0; i < 4; i += 1) advance(600);
    expect(
      announce.mock.calls.filter(([m]) => m === 'stale-notice-sentinel'),
      'the stale notice is never spoken',
    ).toEqual([]);
    expect(liveText(), 'nor painted').not.toBe('stale-notice-sentinel');
  }, 60_000);
});

// --- the module on its own (no boot) --------------------------------------------------------
describe('shell/feedback owner functions', { sequential: true }, () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const live = document.createElement('div');
    live.id = 'a11y-live';
    document.body.appendChild(live);
  });

  afterEach(() => {
    while (restorers.length > 0) restorers.pop()?.();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
    vi.resetModules();
  });

  async function fresh(): Promise<Feedback> {
    vi.resetModules();
    return import('./feedback');
  }

  it('importing the module registers no window or document listener, writes nothing to the document or storage, and resolves no catalog string', async () => {
    vi.resetModules();
    // The catalog modules load first: a11yCopy reads its catalog when it is imported, which is not
    // the module under test.
    const resolver = await import('../ui/i18n/resolver');
    const copy = await import('../ui/a11yCopy');
    const { LiveRegion } = await import('../ui/liveRegion');
    const catalogs: readonly object[] = Object.values(resolver.CATALOGS);
    expect(catalogs.length, 'precondition: both catalogs are registered').toBe(2);

    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('mr.probe', 'kept');
    sessionStorage.setItem('mr.probe', 'kept');

    // Every catalog lookup either resolver makes goes through Object.hasOwn on a catalog.
    const lookups: PropertyKey[] = [];
    const hasOwn = Object.hasOwn;
    const lookup = vi
      .spyOn(Object, 'hasOwn')
      .mockImplementation((o: object, key: PropertyKey): boolean => {
        if (catalogs.includes(o)) lookups.push(key);
        return hasOwn(o, key);
      });

    // Document writes are watched as writes, not as state: records the observer delivers during
    // the awaited import land in `mutations` through its callback.
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      mutations.push(...records);
    });
    observer.observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });

    // An observer of this test's own, undone by ASSIGNING the previous function back: on the
    // global `window`, addEventListener is an own accessor, so redefining the old descriptor would
    // leave a wrapper in place.
    const seen: Recorded[] = [];
    type Adder = { addEventListener: EventTarget['addEventListener'] };
    const undo: Array<() => void> = [];
    const targets: readonly EventTarget[] = [window, document];
    for (const target of targets) {
      const hadOwn = Object.getOwnPropertyDescriptor(target, 'addEventListener') !== undefined;
      const previous = target.addEventListener;
      (target as Adder).addEventListener = (
        type: string,
        handler: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ): void => {
        seen.push({ target, type, handler, options });
        previous.call(target, type, handler, options);
      };
      undo.push(() => {
        if (hadOwn) (target as Adder).addEventListener = previous;
        else delete (target as unknown as { addEventListener?: unknown }).addEventListener;
      });
    }
    try {
      // The observers work: a probe listener on each target, a probe write and a probe lookup
      // through each resolver are each seen.
      const probe = (): void => undefined;
      window.addEventListener('mr-probe', probe);
      document.addEventListener('mr-probe', probe);
      expect(
        seen.map((r) => [r.target === window, r.target === document, r.type]),
        'precondition: the listener observer sees each target`s probe exactly once',
      ).toEqual([
        [true, false, 'mr-probe'],
        [false, true, 'mr-probe'],
      ]);
      window.removeEventListener('mr-probe', probe);
      document.removeEventListener('mr-probe', probe);
      seen.length = 0;

      document.documentElement.setAttribute('data-mr-probe', '1');
      document.documentElement.removeAttribute('data-mr-probe');
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'precondition: the mutation observer reports the probe`s set and remove',
      ).toEqual(['attributes:data-mr-probe', 'attributes:data-mr-probe']);
      mutations.length = 0;

      expect(copy.t('a11y.world.region'), 'precondition: the a11y probe resolves').not.toBe('');
      expect(lookups, 'precondition: an a11yCopy lookup is seen').toContain('a11y.world.region');
      lookups.length = 0;
      expect(resolver.t('a11y.world.region'), 'precondition: the i18n probe resolves').not.toBe('');
      expect(lookups, 'precondition: a resolver lookup is seen').toContain('a11y.world.region');
      lookups.length = 0;

      const fb = await import('./feedback');
      expect(fb.liveRegion, 'precondition: the module loaded').toBeInstanceOf(LiveRegion);
      expect(fb.statusEl, 'precondition: and mounted nothing').toBeUndefined();

      expect(
        seen.map((r) => [r.target === window, r.type]),
        'the import registered no listener on window or document',
      ).toEqual([]);
      mutations.push(...observer.takeRecords());
      expect(
        mutations.map((m) => `${m.type}:${m.attributeName ?? ''}`),
        'the import wrote nothing to the document',
      ).toEqual([]);
      expect(lookups, 'the import resolved no catalog string').toEqual([]);
      expect(localStorage.length, 'the import added no localStorage key').toBe(1);
      expect(localStorage.getItem('mr.probe'), 'and changed none').toBe('kept');
      expect(sessionStorage.length, 'the import added no sessionStorage key').toBe(1);
      expect(sessionStorage.getItem('mr.probe'), 'and changed none').toBe('kept');
    } finally {
      lookup.mockRestore();
      observer.disconnect();
      for (const r of seen) r.target.removeEventListener(r.type, r.handler, r.options);
      while (undo.length > 0) undo.pop()?.();
    }
  });

  it('a fresh import holds every binding at its initial value', async () => {
    const fb = await fresh();
    const { NO_TOAST } = await import('../ui/toast');
    const { STATUS_NOTICE_INITIAL } = await import('../ui/statusModel');
    const { EventRing } = await import('../ui/eventRing');
    const { ErrorRing } = await import('../ui/errorRing');
    const { LiveRegion } = await import('../ui/liveRegion');
    expect(fb.statusEl).toBeUndefined();
    expect(fb.toastChrome).toBeUndefined();
    expect(fb.toastState).toBe(NO_TOAST);
    expect(fb.worldHints).toEqual([]);
    expect(fb.saidHint).toBeNull();
    expect(fb.menuHint).toBeNull();
    expect(fb.statusNotice).toBe(STATUS_NOTICE_INITIAL);
    expect(fb.announcedSinceFrame).toBe(false);
    expect(fb.lastA11ySnapshot).toEqual({ topOverlay: null, message: '' });
    expect(fb.toastDismissedSeq).toBe(-1);
    expect(fb.handlingError).toBe(false);
    expect(fb.lastPaintErrorMessage).toBeNull();
    expect(fb.MOVE_REJECT_PREFIX).toBe('movement-reject ');
    expect(fb.eventRing).toBeInstanceOf(EventRing);
    expect(fb.eventRing.snapshot()).toEqual([]);
    expect(fb.errorRing).toBeInstanceOf(ErrorRing);
    expect(fb.errorRing.snapshot()).toEqual([]);
    expect(fb.liveRegion).toBeInstanceOf(LiveRegion);
  });

  it('before installHintHost, hintOnMenu and paintWorldHint throw; once installed, menuOnTop picks the host and repaintMenu runs only when the menu-hosted hint changes', async () => {
    const fb = await fresh();
    expect(() => fb.hintOnMenu(), 'hintOnMenu before the install').toThrow();
    expect(() => fb.paintWorldHint(), 'paintWorldHint before the install').toThrow();

    const status = document.createElement('div');
    document.body.appendChild(status);
    fb.mountFeedback({ statusEl: status });
    let onTop = false;
    let asked = 0;
    let repaints = 0;
    fb.installHintHost({
      menuOnTop: () => {
        asked += 1;
        return onTop;
      },
      repaintMenu: () => {
        repaints += 1;
      },
    });

    fb.setWorldHint('content-stale', 'hint-a');
    expect(asked, 'the host was asked where the menu is').toBeGreaterThan(0);
    expect(status.textContent, 'menu not on top: the hint is on the world line').toBe('hint-a');
    expect(fb.hintOnMenu(), 'and not on the menu').toBeNull();
    expect(repaints, 'the menu-hosted hint did not change: no repaint').toBe(0);

    onTop = true;
    expect(fb.hintOnMenu(), 'menu on top: the hint is the menu`s').toBe('hint-a');
    fb.paintWorldHint();
    expect(status.textContent, 'the world line is emptied').toBe('');
    expect(fb.menuHint).toBe('hint-a');
    expect(repaints, 'the menu-hosted hint changed: one repaint').toBe(1);
    fb.paintWorldHint();
    expect(repaints, 'nothing changed: no repaint').toBe(1);

    fb.setWorldHint('content-stale', 'hint-b');
    expect(fb.menuHint).toBe('hint-b');
    expect(repaints, 'a new hint on the menu: one more repaint').toBe(2);
    expect(status.textContent).toBe('');

    onTop = false;
    fb.paintWorldHint();
    expect(status.textContent, 'menu gone: the hint is back on the world line').toBe('hint-b');
    expect(fb.menuHint).toBeNull();
    expect(repaints, 'the menu lost its hint: one more repaint').toBe(3);
    fb.paintWorldHint();
    expect(repaints, 'nothing changed: no repaint').toBe(3);
  });

  it('mountFeedback mounts each member it is given and keeps the one it omits', async () => {
    const fb = await fresh();
    const status = document.createElement('div');
    const root = document.createElement('div');
    const chrome = { root };

    fb.mountFeedback({ statusEl: status });
    expect(fb.statusEl).toBe(status);
    expect(fb.toastChrome, 'the omitted toast stays unmounted').toBeUndefined();

    fb.mountFeedback({ toastChrome: chrome });
    expect(fb.toastChrome).toBe(chrome);
    expect(fb.statusEl, 'the omitted world line keeps its mount').toBe(status);

    fb.mountFeedback({});
    expect(fb.statusEl).toBe(status);
    expect(fb.toastChrome).toBe(chrome);

    vi.spyOn(performance, 'now').mockReturnValue(1000);
    fb.paintToast('mounted-toast');
    expect(root.textContent, 'the toast paints the mounted chrome').toBe('mounted-toast');
    expect(root.hidden).toBe(false);
  });

  it('resetStatusNotice puts statusNotice back to its initial value', async () => {
    const fb = await fresh();
    const { STATUS_NOTICE_INITIAL } = await import('../ui/statusModel');
    fb.queueNotice('queued', 1000);
    expect(fb.statusNotice.queued, 'precondition: a notice is queued').toEqual({
      text: 'queued',
      queuedAtMs: 1000,
    });
    fb.resetStatusNotice();
    expect(fb.statusNotice).toBe(STATUS_NOTICE_INITIAL);
  });

  it('pumpAnnouncements reads the top overlay once per call, announces one coming to the top, and on the world edge announces the world region, then returns focus once, then advances the snapshot, all on the frame`s clock', async () => {
    const fb = await fresh();
    const copy = await import('../ui/a11yCopy');
    const { OVERLAY_A11Y } = await import('../ui/overlayRegistry');
    // A wall clock far from the frame's: the pump must use `now`.
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    const help = copy.t(OVERLAY_A11Y.helpView.labelKey);
    const world = copy.t('a11y.world.region');
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    const flush = vi.spyOn(fb.liveRegion, 'flush');

    let reads = 0;
    let top: OverlayId | null = 'helpView';
    const topOverlay = (): OverlayId | null => {
      reads += 1;
      return top;
    };
    const atFocus: Array<{ snapshot: A11ySnapshot; lastAnnounced: unknown }> = [];
    const returnFocus = vi.fn((): void => {
      atFocus.push({ snapshot: fb.lastA11ySnapshot, lastAnnounced: announce.mock.calls.at(-1) });
    });
    const pump = (now: number): void => {
      fb.pumpAnnouncements({ now, topOverlay, countdownSaid: null, returnFocus });
    };

    pump(1000);
    expect(reads, 'one read').toBe(1);
    expect(announce.mock.calls, 'the overlay on top is announced').toEqual([[help, 1000]]);
    expect(returnFocus, 'no world edge, no focus return').not.toHaveBeenCalled();
    expect(fb.lastA11ySnapshot).toEqual({ topOverlay: 'helpView', message: '' });
    expect(flush.mock.calls, 'flushed on the frame clock').toEqual([[1000]]);

    pump(1100);
    expect(reads, 'one read per pump').toBe(2);
    expect(announce.mock.calls.length, 'an unchanged top is not announced again').toBe(1);
    expect(returnFocus, 'no world edge, no focus return').not.toHaveBeenCalled();
    expect(flush.mock.calls).toEqual([[1000], [1100]]);

    top = null;
    pump(1600);
    expect(reads).toBe(3);
    expect(announce.mock.calls, 'the world edge announces the world region').toEqual([
      [help, 1000],
      [world, 1600],
    ]);
    expect(returnFocus, 'the world edge returns focus once').toHaveBeenCalledTimes(1);
    expect(atFocus, 'after the announcement, before the snapshot moves').toEqual([
      { snapshot: { topOverlay: 'helpView', message: '' }, lastAnnounced: [world, 1600] },
    ]);
    expect(fb.lastA11ySnapshot, 'then the snapshot moved').toEqual({
      topOverlay: null,
      message: '',
    });
    expect(liveText(), 'the overlay name was spoken').toBe(help);

    pump(2200);
    expect(reads).toBe(4);
    expect(returnFocus, 'a frame past the edge returns no focus').toHaveBeenCalledTimes(1);
    expect(announce.mock.calls.length, 'and announces nothing').toBe(2);
    expect(flush.mock.calls.at(-1)).toEqual([2200]);
    expect(liveText(), 'the flush spoke the world region').toBe(world);
  });

  it('when returnFocus throws, the pump leaves lastA11ySnapshot where it was, so the next pump sees the same world edge', async () => {
    const fb = await fresh();
    const copy = await import('../ui/a11yCopy');
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    const world = copy.t('a11y.world.region');
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    let top: OverlayId | null = 'helpView';
    const returnFocus = vi.fn<() => void>().mockImplementationOnce(() => {
      throw new Error('focus-boom');
    });
    const pump = (now: number): void => {
      fb.pumpAnnouncements({ now, topOverlay: () => top, countdownSaid: null, returnFocus });
    };

    pump(1000);
    top = null;
    expect(() => pump(1600), 'the focus return`s throw reaches the frame').toThrow('focus-boom');
    expect(fb.lastA11ySnapshot, 'the snapshot did not move').toEqual({
      topOverlay: 'helpView',
      message: '',
    });
    pump(2200);
    expect(returnFocus, 'the next pump saw the edge again').toHaveBeenCalledTimes(2);
    expect(
      announce.mock.calls.filter(([m]) => m === world),
      'and announced it again',
    ).toEqual([
      [world, 1600],
      [world, 2200],
    ]);
    expect(fb.lastA11ySnapshot).toEqual({ topOverlay: null, message: '' });
    pump(2800);
    expect(returnFocus, 'the edge is spent').toHaveBeenCalledTimes(2);
  });

  it('a queued notice is spoken by the first pump whose now is a full window past its queueing, never by the wall clock', async () => {
    const fb = await fresh();
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    const pump = (now: number): void => {
      fb.pumpAnnouncements({
        now,
        topOverlay: () => null,
        countdownSaid: null,
        returnFocus: () => undefined,
      });
    };

    fb.queueNotice('notice-q', 5000);
    pump(5100);
    pump(5499);
    expect(announce.mock.calls, 'inside the window: nothing').toEqual([]);
    expect(fb.statusNotice.queued).toEqual({ text: 'notice-q', queuedAtMs: 5000 });
    pump(5500);
    expect(announce.mock.calls, 'a window past it: spoken on that frame`s clock').toEqual([
      ['notice-q', 5500],
    ]);
    expect(fb.statusNotice.queued).toBeNull();
    pump(6000);
    expect(liveText()).toBe('notice-q');
  });

  it('a countdown line is announced by the pump and holds a queued notice like any transition', async () => {
    const fb = await fresh();
    vi.spyOn(performance, 'now').mockReturnValue(1e9);
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    const pump = (now: number, countdownSaid: string | null): void => {
      fb.pumpAnnouncements({
        now,
        topOverlay: () => null,
        countdownSaid,
        returnFocus: () => undefined,
      });
    };

    fb.queueNotice('notice-c', 1000);
    pump(1500, 'countdown-line');
    expect(announce.mock.calls, 'the countdown line is announced, the notice held').toEqual([
      ['countdown-line', 1500],
    ]);
    expect(fb.statusNotice.queued?.text).toBe('notice-c');
    pump(1999, null);
    expect(announce.mock.calls.length, 'still held inside the window after the line').toBe(1);
    pump(2000, null);
    expect(announce.mock.calls.at(-1), 'a window after the line: spoken').toEqual([
      'notice-c',
      2000,
    ]);
    pump(2500, null);
    expect(liveText()).toBe('notice-c');
  });

  it('announceNow marks the frame and the next pump clears the mark, holding a queued notice clear of the announcement', async () => {
    const fb = await fresh();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    const announce = vi.spyOn(fb.liveRegion, 'announce');
    const pump = (now: number): void => {
      fb.pumpAnnouncements({
        now,
        topOverlay: () => null,
        countdownSaid: null,
        returnFocus: () => undefined,
      });
    };

    fb.queueNotice('notice-a', 1000);
    fb.announceNow('aside');
    expect(fb.announcedSinceFrame).toBe(true);
    expect(announce.mock.calls, 'announced on the wall clock').toEqual([['aside', 1000]]);
    pump(1500);
    expect(fb.announcedSinceFrame, 'the pump cleared the mark').toBe(false);
    expect(liveText(), 'the flush spoke the announcement').toBe('aside');
    pump(1999);
    expect(announce.mock.calls.length, 'the notice is held a window past the frame').toBe(1);
    pump(2000);
    expect(announce.mock.calls.at(-1)).toEqual(['notice-a', 2000]);
    pump(2500);
    expect(liveText()).toBe('notice-a');
  });
});
